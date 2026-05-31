"""
BankStatementTxn — one line from an uploaded bank statement, parsed
and stored against a (qbo_account_id, period_end) bank reconciliation.

Lifecycle:
  1) User uploads a CSV statement on a Bank-type recon account.
  2) Parser splits the CSV into BankStatementTxn rows.
  3) Auto-matcher walks each row, finds the best-fit GL transaction
     (date ±5 days, abs-amount equal, same sign), and stamps
     match_status + matched_gl_txn_id + match_confidence.
  4) UI worksheet groups them into cleared / bank_only / gl_only buckets.
  5) On re-upload: prior rows for (account, period_end) are wiped before
     the new batch is inserted — uploads are idempotent.

Why store the parsed rows instead of re-parsing on every render:
  The matcher has to compare every bank line against every GL line in
  the period (O(N×M) loop) — caching the parsed bank side prevents
  re-running the parser + match on every page render. Match results
  also get persisted so the UI surfaces them instantly when the user
  reopens the worksheet.

No file content is stored — only the parsed structured rows. The CSV
itself can be re-uploaded any time.

Migration: 029_bank_statement_txns.py.
"""
import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Date, DateTime, Numeric, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from core.db.base import TenantBase


class BankStatementTxn(TenantBase):
    __tablename__ = "bank_statement_txns"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    qbo_account_id: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    period_end: Mapped[date] = mapped_column(Date, nullable=False, index=True)

    # ── Parsed statement line ──────────────────────────────────────────
    txn_date:    Mapped[date] = mapped_column(Date, nullable=False)
    # Signed: positive = deposit (debit to cash), negative = withdrawal
    # (credit to cash). Matches the qbo_gl pull's sign convention so the
    # matcher can compare directly.
    amount:      Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    description: Mapped[str | None] = mapped_column(String(500))
    # Free-text reference from the bank — check number, ACH trace,
    # confirmation number, etc. Used for soft-match tie-breaking.
    bank_ref:    Mapped[str | None] = mapped_column(String(100))

    # ── Match results ──────────────────────────────────────────────────
    # cleared      — matched against a GL txn (matched_gl_txn_id set)
    # bank_only    — appeared on bank but no GL match → needs a JE in QBO
    # unmatched    — left over after matcher ran but not yet classified
    #                (transient state — should be cleared OR bank_only
    #                after the matcher completes)
    match_status:       Mapped[str] = mapped_column(String(20), nullable=False, default="unmatched")
    matched_gl_txn_id:  Mapped[str | None] = mapped_column(String(50))
    # 0.00-1.00 — exact date + amount = 1.0; date drift docks score.
    match_confidence:   Mapped[Decimal | None] = mapped_column(Numeric(3, 2))

    # ── Upload metadata ────────────────────────────────────────────────
    statement_filename: Mapped[str | None] = mapped_column(String(255))
    uploaded_by:        Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    uploaded_at:        Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
