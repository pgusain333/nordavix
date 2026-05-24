# Nordavix Reconciliations — User & Demo Guide

## What this module does

Nordavix Reconciliations pulls live data from QuickBooks Online and tells
you, for any balance sheet account, three things you actually need at
close:

1. **What's in the GL** for that account as of a chosen period end.
2. **What the supporting detail says** (customer aging, vendor aging,
   bank/card balance, or list of accounts in a category).
3. **Where the differences are**, plus the evidence to explain them
   (open invoices, unapplied payments, duplicate documents, manual
   journal entries).

Sign-off, notes, assignments, and an Excel "support package" export are
built into the workflow so the deliverable can drop straight into your
close binder.

---

## The 10 reconciliation types we support today

We split reconciliations into two families:

### A. Subledger reconciliations (specialized — entity-level detail)

These have a true subledger inside QBO (customers, vendors, bank
account, card account). The detail page shows aging buckets.

| Type    | What it reconciles                | Source of GL                | Source of Subledger                |
|---------|-----------------------------------|-----------------------------|------------------------------------|
| **AR**  | Customer receivables              | AccountType = Accounts Receivable (CurrentBalance) | AgedReceivables report |
| **AP**  | Vendor payables                   | AccountType = Accounts Payable (CurrentBalance)    | AgedPayables report    |
| **Bank**| Cash/checking accounts            | AccountType = Bank          | Account balances + 90-day txns     |
| **CC**  | Credit card liabilities           | AccountType = Credit Card   | Account balances + 90-day txns     |

### B. GL account reconciliations (rollforward — account-level detail)

These cover the rest of the balance sheet. QBO has no separate
subledger, so the per-account balance IS the subledger. The detail
page shows recent journal entry activity instead of aging buckets.

| Type                          | Covers                                                  |
|-------------------------------|---------------------------------------------------------|
| **Fixed assets**              | Fixed Asset + Other Asset accounts                      |
| **Prepaids & other CA**       | Other Current Asset accounts                            |
| **Other assets**              | Other Asset accounts                                    |
| **Accruals & other CL**       | Other Current Liability accounts                        |
| **Loans & LTD**               | Long Term Liability accounts                            |
| **Equity**                    | Equity accounts                                         |

---

## How subledger balance is computed (the accounting)

This is the question your CFO will ask first. Here is the exact logic.

### AR

```
Subledger total  = SUM of "Total" column from the AgedReceivables QBO report
                   (asked at end_date = period_end)
GL total         = SUM of CurrentBalance across all AccountType = Accounts Receivable
Per customer     = the "Total" column for that customer row
```

Per-customer GL and subledger are equal — in QBO every invoice/payment
posts atomically with a CustomerRef, so the customer's subledger row
IS their portion of the GL. A workspace-level gap appears only when
journal entries hit AR without a customer ref. We surface that as a
synthetic row labeled **"Unposted GL adjustments (no customer ref)"**
flagged high-risk, and we attach the underlying JEs (last 90 days) as
evidence so you can fix them.

### AP

Mirror of AR. AgedPayables report drives the subledger. AccountType =
Accounts Payable drives the GL. The same "unposted GL adjustments"
synthetic row appears when there's a gap.

### Bank / CC

Per-account balance from the QBO TrialBalance report at period_end.
Each account becomes its own reconciliation item. Evidence rows: the
last 90 days of journal entry activity touching that account.

> A true bank reconciliation against a downloaded statement (matching
> cleared vs uncleared) is on the roadmap. Today we show the GL side
> with transaction evidence so the controller can manually reconcile.

### Fixed assets / Prepaids / Accruals / Loans / Equity / Other

For each QBO `AccountType` in the bucket:

```
items[]          = list of active accounts of that AccountType
Per item:
  gl_balance      = balance from QBO TrialBalance report at period_end
  subledger_total = gl_balance  (no separate sub-system here — see note)
  difference      = 0
GL total          = sum of per-item gl_balance
Subledger total   = same
```

In QBO these accounts are reconciled by *rollforward analysis* (beginning
balance + additions − reductions = ending balance), not against an
external sub-ledger. We pull the **last 90 days of journal entry lines**
that touched each account into the evidence section so the AI commentary
and the human reviewer can see what actually moved.

> If you maintain an external fixed-asset register, prepaid schedule,
> or amortization spreadsheet, that's where the "real" subledger lives.
> Today we don't import those — that's a roadmap item.

---

## Risk scoring

Each item gets a `risk_level` of **low / medium / high**, computed at
sync time:

For **AR / AP**:
- **high** — any balance > $1,000 over 90 days, OR difference > $5,000
- **medium** — any balance 61–90 days, OR difference > $500
- **low** — otherwise

For **GL account types**:
- **high** — absolute balance > $500,000
- **medium** — absolute balance > $50,000
- **low** — otherwise

These thresholds are intentionally simple for the MVP. Production
companies will want firm-specific or materiality-based thresholds —
that's the next refinement.

---

## AI commentary — when it runs, what it says

AI commentary is **on-demand only**. We never spend tokens during
sync. You click `Generate AI commentary` per row, or
`Generate summary` for the executive overview at the top of the
reconciliation.

**Prompt rules** (these are enforced):
- 2 to 3 sentences. Plain prose. No markdown, no bullets, no asterisks.
- Interprets the numbers — does not restate them.
- Controller-grade, action-oriented.

**Per-item prompt** sees:
- Entity name, type, period
- GL balance, subledger balance, difference
- Full aging breakdown (current, 1-30, 31-60, 61-90, >90)
- Risk level

**Summary prompt** sees:
- Reconciliation type, period
- GL total, subledger total, net difference
- Count of items, count of high-risk items
- Biggest variances by name (only if material)

Output is stripped of any markdown the model leaks (** __ ## --- backticks)
and em-dashes are normalized to a regular hyphen-minus per the user's
formatting preference.

---

## The four evidence categories on the detail page

For AR/AP, the detail page groups recent transactions into four buckets:

| Category               | What populates it                                                            |
|------------------------|------------------------------------------------------------------------------|
| **Unmatched**          | Open invoices > 60 days overdue at period_end                                |
| **Unapplied cash**     | Customer payments with `UnappliedAmt > 0`; vendor credits with `Balance > 0` |
| **Duplicates**         | Same DocNumber + same TotalAmt within the same customer/vendor               |
| **Manual JEs**         | Journal entries (last 90 days) that touched the AR account WITHOUT a ref     |

For GL account types, only `Manual JEs` populates — we pull the last
90 days of JE lines that touched each account.

---

## The workflow (what a user does)

1. **Connect QuickBooks** from `Connections`. OAuth flow takes ~30 seconds.
2. **Open Reconciliations.** Click `New AR`, `New AP`, or use the
   `New reconciliation` modal to pick any other type.
3. **Pick a period end** and a name. Click `Create + sync`.
4. **Wait ~20-60 seconds** while Nordavix pulls QBO reports + transactions.
   The status badge moves from `syncing` → `in_review`.
5. **Open the reconciliation detail.** Top-level KPIs show GL total,
   subledger total, net difference.
6. **Click any entity** (customer / vendor / account). Right panel shows:
   - Summary tiles (GL, subledger, variance)
   - Aging analysis (5 buckets)
   - Evidence sections (only ones with rows show up)
   - Notes thread
7. **Click `Generate AI commentary`** when you want AI explanation
   for that entity. Click `Generate summary` at the top for the whole
   reconciliation.
8. **Approve individual items** (`Approve` button) and/or **approve
   the whole reconciliation** (`Approve reconciliation` in the header).
9. **Export** as Excel — the support package has Summary, Items,
   Evidence, and Notes sheets.

---

## The performance story

- **QBO pulls run with bounded concurrency (4 in flight)** — about
  4x faster than serial for tenants with many customers/vendors/accounts.
- **AI commentary calls fan out at concurrency 5** when triggered.
- **Polling is conditional** — the UI only re-fetches while a sync is
  actively in `syncing` or `computing` state. Idle pages are
  cache-driven (30s stale time).

---

## Limitations / what's NOT in this MVP

Be transparent about this with users:

- **No external subledger imports** for fixed assets, prepaids, loans.
  Rollforward analysis is done off QBO transactions only. If your
  client maintains an external schedule (very common for FA registers
  or prepaid amortization), you'd reconcile that separately.
- **No bank statement matching.** Bank/CC reconciliation shows the
  GL side + 90 days of transactions. Matching cleared vs uncleared
  against a bank statement download is roadmap.
- **Risk thresholds are global**, not firm-specific yet.
- **Multi-currency** is not handled — amounts are in whatever currency
  QBO returns them in.
- **Reconciling-item drill-down** (showing the exact journal entries
  causing the gap) works for AR/AP today. For BANK/CC/other types,
  we pull last-90-day transactions but don't yet partition them into
  "reconciling items".

---

## Endpoints (for engineering reference)

```
GET    /api/reconciliations                  list + ?type filter
POST   /api/reconciliations                  create + trigger sync
GET    /api/reconciliations/dashboard        KPIs + activity + insights
GET    /api/reconciliations/{id}             detail (recon + items + txns + notes)
POST   /api/reconciliations/{id}/sync        re-pull from QBO + recompute
POST   /api/reconciliations/{id}/approve     sign off entire reconciliation
POST   /api/reconciliations/{id}/assign      assign to user (or null to clear)
POST   /api/reconciliations/{id}/notes       add a note (per-recon or per-item)
PUT    /api/reconciliations/{id}/items/{i}/status      set item status
POST   /api/reconciliations/{id}/items/{i}/explain     AI commentary (synchronous)
POST   /api/reconciliations/{id}/explain               AI summary (synchronous)
DELETE /api/reconciliations/{id}             hard delete
GET    /api/reconciliations/{id}/export      Excel support package
```

All endpoints require auth (Clerk JWT) and are tenant-scoped via the
TenantMiddleware.

---

## Demo script (5 minutes)

1. **(15s)** Open Reconciliations dashboard — point at the KPI cards
   and AI insights panel. Mention "live data, on-demand AI."
2. **(30s)** Click `New AR`. Pick last month-end. Show the modal closes
   and a new card appears with status `syncing`.
3. **(20s)** While that's running, click `New` from the dropdown and
   show the full type list (Fixed Assets, Prepaids, Accruals, etc.).
   This is the "covers every balance sheet account" beat.
4. **(45s)** Open the just-created AR reconciliation. Walk the user
   through: header totals, AI summary placeholder, entity list on
   the left, detail pane on the right.
5. **(60s)** Click a customer with a meaningful balance. Show aging
   tiles, then click `Generate AI commentary`. Read the output.
6. **(45s)** Show the evidence sections (open invoices, unapplied
   payments, duplicates if any).
7. **(30s)** Click `Generate summary` at the top of the page. Read
   the executive overview.
8. **(15s)** Click `Approve reconciliation`. Show the green badge.
9. **(15s)** Click `Export` — show the Excel support package.

That's the full loop. The "wow" beats are: (a) "every balance sheet
account", (b) "AI on demand, not auto-spending tokens", (c) "real
evidence, not just numbers."

---

## Test checklist

Before a demo, run through this in a sandbox QBO:

- [ ] QBO connected, fresh OAuth tokens
- [ ] At least 5 customers with open balances (for AR)
- [ ] At least 5 vendors with open balances (for AP)
- [ ] One fixed asset account with non-zero balance
- [ ] One prepaid or other-current-asset account with non-zero balance
- [ ] Create AR reconciliation for last month-end — verify items show
- [ ] Click a customer, generate AI commentary — verify it's plain prose
- [ ] Generate summary at the top — verify no markdown
- [ ] Create a Fixed Assets reconciliation — verify it lists the FA accounts
- [ ] Approve a reconciliation, verify the badge persists after refresh
- [ ] Export to Excel, open the file, verify all sheets present and readable
