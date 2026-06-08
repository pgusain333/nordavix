/**
 * BankReconWorksheet — the CPA-standard bank rec worksheet.
 *
 * Rendered as the "Bank Match" tab in the recon drawer for Bank-type
 * accounts. The flow:
 *
 *   1) User uploads a CSV bank statement
 *   2) Backend parses + persists rows, runs the auto-matcher against
 *      the period's QBO GL, returns three buckets:
 *        - cleared   (matched bank ↔ GL → no action)
 *        - bank_only (on bank, no GL match → user posts JE in QBO)
 *        - gl_only   (in GL, no bank match → outstanding/in-transit)
 *   3) Worksheet displays book-to-bank math:
 *        GL Balance (from period)
 *        + Deposits in Transit  (GL-only debits)
 *        − Outstanding Checks    (GL-only credits)
 *        = Adjusted Book Balance
 *        Should equal bank statement ending balance the user enters
 *   4) Bank-only items render with the suggested JE — user posts in
 *      QBO + clicks Re-sync, the item moves to Cleared next refresh.
 *
 * Re-uploading wipes prior data and starts fresh. No file is stored
 * server-side — only the parsed rows.
 */
import { useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Upload, RefreshCw, CheckCircle2, AlertTriangle, Trash2,
  Banknote, FileText, ArrowUpRight, ArrowDownLeft,
} from "lucide-react"

import { Button, Spinner } from "@/core/ui/components"
import { formatDate } from "@/core/lib/dates"
import { reconsApi } from "@/modules/recons/api"
import type {
  BankReconWorksheet as Worksheet,
  BankStatementRow,
  BankGlRow,
} from "@/modules/recons/api"

interface Props {
  qboAccountId: string
  periodEnd:    string
  glBalance:    string  // from OverviewAccount.gl_balance — display only
  readOnly?:    boolean
}

function fmt(n: string | number, opts: { sign?: boolean } = {}): string {
  const v = typeof n === "string" ? parseFloat(n) || 0 : n
  const abs = Math.abs(v).toLocaleString(undefined, {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })
  if (opts.sign) return v < 0 ? `$(${abs})` : `$${abs}`
  return v < 0 ? `$(${abs})` : `$${abs}`
}

export function BankReconWorksheet({ qboAccountId, periodEnd, glBalance, readOnly }: Props) {
  const qc = useQueryClient()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [bankEnding, setBankEnding] = useState<string>("")

  const queryKey = ["recon-bank-worksheet", qboAccountId, periodEnd]

  const { data, isLoading } = useQuery({
    queryKey,
    queryFn:  () => reconsApi.getBankWorksheet(qboAccountId, periodEnd),
    staleTime: 30_000,
  })

  const uploadMut = useMutation({
    mutationFn: (file: File) => reconsApi.uploadBankStatement(qboAccountId, periodEnd, file),
    onSuccess: (res) => {
      setError(null)
      qc.setQueryData(queryKey, res)
    },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { detail?: string } } }).response?.data?.detail
      setError(msg ?? "Upload failed — check the CSV format and try again.")
    },
  })

  const clearMut = useMutation({
    mutationFn: () => reconsApi.clearBankStatement(qboAccountId, periodEnd),
    onSuccess: () => { qc.invalidateQueries({ queryKey }); setError(null) },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { detail?: string } } }).response?.data?.detail
      setError(msg ?? "Could not clear — try again.")
    },
  })

  // Refresh = re-pull the period's GL from QuickBooks. The worksheet normally
  // serves a cached GL snapshot (so opening it is a fast DB read), so this is
  // the explicit "get the latest from QBO" action.
  const refreshMut = useMutation({
    mutationFn: () => reconsApi.getBankWorksheet(qboAccountId, periodEnd, true),
    onSuccess: (res) => { qc.setQueryData(queryKey, res); setError(null) },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { detail?: string } } }).response?.data?.detail
      setError(msg ?? "Refresh failed — try again.")
    },
  })

  function onFilePick(ev: React.ChangeEvent<HTMLInputElement>) {
    const f = ev.target.files?.[0]
    if (f) uploadMut.mutate(f)
    if (fileInputRef.current) fileInputRef.current.value = ""
  }

  if (isLoading) {
    return (
      <div className="p-6 flex items-center justify-center">
        <Spinner className="h-5 w-5" />
      </div>
    )
  }

  const w: Worksheet = data ?? {
    uploaded: false, filename: null, uploaded_at: null,
    cleared: [], bank_only: [], gl_only: [],
    summary: { cleared_count: 0, bank_only_count: 0, gl_only_count: 0,
      cleared_total: "0", bank_only_total: "0", gl_only_total: "0" },
    statement_totals: { opening_balance: null, ending_balance: null,
      line_sum: null, tie_out_ok: null, tie_out_diff: null },
  }

  // Worksheet math (book-to-bank form):
  //   GL Balance
  //   + Deposits in transit (gl_only with positive amount)
  //   − Outstanding checks  (gl_only with negative amount → subtract abs)
  //   ± Bank-only adjustments needed (sum of bank_only)
  //   = Adjusted Book Balance
  //   ← compares to bank ending balance
  const gl = parseFloat(glBalance) || 0
  const dit = w.gl_only
    .filter((g) => (parseFloat(g.amount) || 0) > 0)
    .reduce((s, g) => s + (parseFloat(g.amount) || 0), 0)
  const outstanding = w.gl_only
    .filter((g) => (parseFloat(g.amount) || 0) < 0)
    .reduce((s, g) => s + (parseFloat(g.amount) || 0), 0)  // negative
  const bankOnlyAdj = w.bank_only.reduce((s, b) => s + (parseFloat(b.amount) || 0), 0)
  const adjustedBook = gl + dit + outstanding + bankOnlyAdj
  const bankEnd = parseFloat(bankEnding) || 0
  const variance = bankEnding ? adjustedBook - bankEnd : null
  const reconciled = bankEnding ? Math.abs(adjustedBook - bankEnd) <= 0.01 : false

  return (
    <div className="space-y-4 p-4">
      {/* Upload bar */}
      <div className="rounded-xl p-3 flex items-center gap-3 flex-wrap"
        style={{
          background: w.uploaded ? "var(--green-subtle)" : "var(--surface-2)",
          border: `1px solid ${w.uploaded ? "var(--green)" : "var(--border)"}`,
        }}>
        <span className="h-7 w-7 rounded-md inline-flex items-center justify-center"
          style={{ background: "white", border: "1px solid var(--border)" }}>
          <Banknote size={13} strokeWidth={1.8} style={{ color: "#1d4ed8" }} />
        </span>
        <div className="flex-1 min-w-0">
          {w.uploaded ? (
            <>
              <p className="text-sm font-semibold text-theme">
                <CheckCircle2 size={12} strokeWidth={2} className="inline-block mr-1" style={{ color: "var(--green)" }} />
                {w.filename}
              </p>
              <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                Uploaded {w.uploaded_at ? formatDate(w.uploaded_at) : ""} · matched {w.summary.cleared_count} of {w.summary.cleared_count + w.summary.bank_only_count} bank lines
              </p>
            </>
          ) : (
            <>
              <p className="text-sm font-semibold text-theme">No bank statement uploaded yet</p>
              <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                Upload your bank's CSV or PDF statement for {formatDate(periodEnd)} — we auto-match it
                against the GL and surface what needs JEs vs. what's outstanding.
              </p>
            </>
          )}
        </div>
        <input ref={fileInputRef} type="file" accept=".csv,.txt,.pdf"
          onChange={onFilePick}
          style={{ display: "none" }} />
        <Button size="sm" variant={w.uploaded ? "outline" : undefined}
          loading={uploadMut.isPending}
          disabled={readOnly || uploadMut.isPending}
          onClick={() => fileInputRef.current?.click()}>
          <Upload size={11} strokeWidth={2} /> {w.uploaded ? "Re-upload" : "Upload statement"}
        </Button>
        {w.uploaded && (
          <>
            <Button size="sm" variant="ghost" loading={refreshMut.isPending}
              onClick={() => refreshMut.mutate()}>
              <RefreshCw size={11} strokeWidth={2} /> Refresh from QBO
            </Button>
            {!readOnly && (
              <button type="button"
                title="Clear uploaded statement"
                onClick={() => {
                  if (window.confirm("Clear the uploaded statement and start over?")) clearMut.mutate()
                }}
                className="p-1 rounded hover:bg-[var(--surface-2)]"
                style={{ color: "#b91c1c" }}>
                <Trash2 size={13} strokeWidth={1.8} />
              </button>
            )}
          </>
        )}
      </div>

      {w.uploaded && <TieOutBanner totals={w.statement_totals} />}

      {error && (
        <div className="rounded-md px-3 py-2 text-[11px] flex items-start gap-2"
          style={{ background: "#fef2f2", color: "#991b1b", border: "1px solid #fecaca" }}>
          <AlertTriangle size={12} strokeWidth={2} className="shrink-0 mt-px" />
          {error}
        </div>
      )}

      {w.uploaded && (
        <>
          {/* Worksheet — book-to-bank math */}
          <div className="rounded-xl overflow-hidden"
            style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
            <div className="px-4 py-2 text-[10px] font-semibold uppercase tracking-wider"
              style={{ background: "var(--surface-2)", color: "var(--text-muted)", borderBottom: "1px solid var(--border)" }}>
              Book-to-Bank reconciliation
            </div>
            <table className="w-full text-sm">
              <tbody>
                <Row label="GL Balance (book)" value={fmt(gl)} bold />
                <Row label="+ Deposits in transit" sub={`(${w.gl_only.filter((g) => parseFloat(g.amount) > 0).length} item${dit ? "" : "s"})`} value={fmt(dit)} positive={dit !== 0} />
                <Row label="− Outstanding checks / payments" sub={`(${w.gl_only.filter((g) => parseFloat(g.amount) < 0).length} item${outstanding ? "" : "s"})`} value={fmt(outstanding)} negative={outstanding !== 0} />
                <Row label="± Bank-only adjustments needed" sub={`(${w.bank_only.length} item${w.bank_only.length === 1 ? "" : "s"} — post in QBO)`} value={fmt(bankOnlyAdj)} negative={bankOnlyAdj < 0} positive={bankOnlyAdj > 0} />
                <Row label="= Adjusted book balance" value={fmt(adjustedBook)} bold border />
                <tr style={{ borderTop: "1px solid var(--border)" }}>
                  <td className="px-4 py-2 text-sm text-theme">
                    Bank statement ending balance
                    <p className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                      Enter the ending balance from your bank statement to verify the tie-out.
                    </p>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <input
                      type="number"
                      step="0.01"
                      value={bankEnding}
                      onChange={(e) => setBankEnding(e.target.value)}
                      placeholder="0.00"
                      disabled={readOnly}
                      className="rounded-md px-2 py-1 text-right tabular-nums text-sm font-semibold"
                      style={{
                        background: "var(--surface-2)",
                        border: "1px solid var(--border-strong)",
                        color: "var(--text)",
                        width: 140,
                      }}
                    />
                  </td>
                </tr>
                {bankEnding && (
                  <Row label="= Variance"
                    value={fmt(variance ?? 0)}
                    bold border
                    extra={reconciled
                      ? <span className="inline-flex items-center gap-1 text-[10px] font-semibold"
                          style={{ color: "var(--green)" }}>
                          <CheckCircle2 size={11} strokeWidth={2.2} /> Reconciled
                        </span>
                      : <span className="inline-flex items-center gap-1 text-[10px] font-semibold"
                          style={{ color: "#b91c1c" }}>
                          <AlertTriangle size={11} strokeWidth={2.2} /> Out of balance
                        </span>}
                  />
                )}
              </tbody>
            </table>
          </div>

          {/* Bank-only items (need JEs) */}
          {w.bank_only.length > 0 && (
            <BucketCard
              title="Bank-only — post these in QuickBooks"
              hint="Items on your bank statement that aren't on the GL — typically fees, interest earned, NSF, ACH the bookkeeper missed. Post each as a JE in QBO, then click Re-match to reconcile."
              tone="warn"
              count={w.bank_only.length}
              total={w.summary.bank_only_total}
            >
              <table className="w-full text-xs">
                <thead>
                  <tr style={{ background: "var(--surface-2)" }}>
                    <Th>Date</Th>
                    <Th>Description</Th>
                    <Th>Bank ref</Th>
                    <Th right>Amount</Th>
                    <Th>Suggested JE</Th>
                  </tr>
                </thead>
                <tbody>
                  {w.bank_only.map((b) => <BankOnlyRow key={b.id} row={b} />)}
                </tbody>
              </table>
            </BucketCard>
          )}

          {/* GL-only items (outstanding) */}
          {w.gl_only.length > 0 && (
            <BucketCard
              title="GL-only — outstanding / in-transit"
              hint="Items on the GL but not yet on the bank statement. Outstanding checks (haven't cleared), deposits in transit (made but not yet credited). These auto-flow into your worksheet — no action needed unless any are stale (>90 days)."
              tone="info"
              count={w.gl_only.length}
              total={w.summary.gl_only_total}
            >
              <table className="w-full text-xs">
                <thead>
                  <tr style={{ background: "var(--surface-2)" }}>
                    <Th>Date</Th>
                    <Th>Type</Th>
                    <Th>Memo / Payee</Th>
                    <Th>Ref #</Th>
                    <Th right>Amount</Th>
                  </tr>
                </thead>
                <tbody>
                  {w.gl_only.map((g, i) => <GlOnlyRow key={`${g.qbo_txn_id ?? i}`} row={g} />)}
                </tbody>
              </table>
            </BucketCard>
          )}

          {/* Cleared items — collapsed by default */}
          {w.cleared.length > 0 && (
            <details className="rounded-xl overflow-hidden"
              style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
              <summary className="px-4 py-2 cursor-pointer text-[11px] font-semibold uppercase tracking-wider flex items-center gap-2"
                style={{ background: "var(--surface-2)", color: "var(--green)" }}>
                <CheckCircle2 size={12} strokeWidth={2} />
                Cleared — {w.cleared.length} matched · totals {fmt(w.summary.cleared_total)}
                <span className="ml-auto text-[10px] font-normal" style={{ color: "var(--text-muted)" }}>
                  Click to expand
                </span>
              </summary>
              <table className="w-full text-xs">
                <thead>
                  <tr style={{ background: "var(--surface-2)", borderTop: "1px solid var(--border)" }}>
                    <Th>Bank date</Th>
                    <Th>Bank description</Th>
                    <Th>GL date</Th>
                    <Th>GL memo</Th>
                    <Th right>Amount</Th>
                    <Th right>Match</Th>
                  </tr>
                </thead>
                <tbody>
                  {w.cleared.map((c, i) => (
                    <tr key={`${c.bank.id}-${i}`} style={{ borderTop: "1px solid var(--border)" }}>
                      <td className="px-3 py-1.5 text-[11px]" style={{ color: "var(--text-2)" }}>{c.bank.txn_date}</td>
                      <td className="px-3 py-1.5 text-theme">{c.bank.description ?? "—"}</td>
                      <td className="px-3 py-1.5 text-[11px]" style={{ color: "var(--text-2)" }}>{c.gl.txn_date ?? "—"}</td>
                      <td className="px-3 py-1.5" style={{ color: "var(--text-2)" }}>{c.gl.memo ?? c.gl.entity_name ?? "—"}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums font-semibold text-theme">{fmt(c.bank.amount)}</td>
                      <td className="px-3 py-1.5 text-right">
                        <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
                          style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
                          {(parseFloat(String(c.score)) * 100).toFixed(0)}%
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
        </>
      )}
    </div>
  )
}


// ── Statement tie-out (cross-foot control) ─────────────────────────────

function TieOutBanner({ totals }: { totals: Worksheet["statement_totals"] }) {
  const { opening_balance, ending_balance, tie_out_ok, tie_out_diff } = totals

  // Couldn't read the statement's own opening/ending → completeness can't be
  // proven. Surface as a caution, not a hard failure.
  if (tie_out_ok === null) {
    return (
      <div className="rounded-md px-3 py-2 text-[11px] flex items-start gap-2"
        style={{ background: "var(--surface-2)", color: "var(--text-muted)", border: "1px solid var(--border)" }}>
        <AlertTriangle size={12} strokeWidth={2} className="shrink-0 mt-px" />
        <span>
          Couldn't read the statement's opening / ending balance, so completeness
          isn't verified. Double-check the totals against your statement.
        </span>
      </div>
    )
  }

  if (tie_out_ok) {
    return (
      <div className="rounded-md px-3 py-2 text-[11px] flex items-center gap-2 flex-wrap"
        style={{ background: "var(--green-subtle)", color: "var(--green)", border: "1px solid var(--green)" }}>
        <CheckCircle2 size={12} strokeWidth={2.2} className="shrink-0" />
        <span className="font-semibold">Statement ties out.</span>
        <span style={{ color: "var(--text-muted)" }}>
          Opening {fmt(opening_balance ?? 0)} + activity = ending {fmt(ending_balance ?? 0)} — every line captured.
        </span>
      </div>
    )
  }

  return (
    <div className="rounded-md px-3 py-2 text-[11px] flex items-start gap-2"
      style={{ background: "#fef2f2", color: "#991b1b", border: "1px solid #fecaca" }}>
      <AlertTriangle size={12} strokeWidth={2} className="shrink-0 mt-px" />
      <span>
        <span className="font-semibold">Statement doesn't tie out — off by {fmt(tie_out_diff ?? 0)}.</span>{" "}
        Opening {fmt(opening_balance ?? 0)} + parsed activity ≠ ending {fmt(ending_balance ?? 0)}.
        A line may have been missed in parsing — re-check the statement or upload the bank's CSV export.
      </span>
    </div>
  )
}


// ── Building blocks ───────────────────────────────────────────────────

function Row({
  label, sub, value, bold, border, positive, negative, extra,
}: {
  label:     string
  sub?:      string
  value:     string
  bold?:     boolean
  border?:   boolean
  positive?: boolean
  negative?: boolean
  extra?:    React.ReactNode
}) {
  return (
    <tr style={border ? { borderTop: "1px solid var(--border-strong)" } : undefined}>
      <td className="px-4 py-2 text-theme" style={{ fontWeight: bold ? 700 : 400 }}>
        <span style={{ color: positive ? "var(--green)" : negative ? "#b91c1c" : undefined }}>
          {label}
        </span>
        {sub && <span className="ml-2 text-[10px]" style={{ color: "var(--text-muted)" }}>{sub}</span>}
        {extra && <span className="ml-3">{extra}</span>}
      </td>
      <td className="px-4 py-2 text-right tabular-nums"
        style={{
          fontWeight: bold ? 700 : 400,
          color: positive ? "var(--green)" : negative ? "#b91c1c" : "var(--text)",
        }}>
        {value}
      </td>
    </tr>
  )
}

function BucketCard({
  title, hint, tone, count, total, children,
}: {
  title:    string
  hint:     string
  tone:     "warn" | "info"
  count:    number
  total:    string
  children: React.ReactNode
}) {
  const palette = tone === "warn"
    ? { hdr: "rgba(245, 158, 11, 0.08)", border: "rgba(245, 158, 11, 0.40)", text: "#92400e" }
    : { hdr: "rgba(29, 78, 216, 0.06)",  border: "rgba(29, 78, 216, 0.30)",  text: "#1d4ed8" }
  return (
    <div className="rounded-xl overflow-hidden"
      style={{ background: "var(--surface)", border: `1px solid ${palette.border}` }}>
      <div className="px-4 py-2 flex items-center gap-2 flex-wrap"
        style={{ background: palette.hdr, borderBottom: "1px solid var(--border)" }}>
        <p className="text-[11px] font-semibold" style={{ color: palette.text }}>{title}</p>
        <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
          style={{ background: "white", color: palette.text, border: `1px solid ${palette.border}` }}>
          {count} · {total}
        </span>
      </div>
      <p className="px-4 py-2 text-[11px]" style={{ color: "var(--text-muted)" }}>{hint}</p>
      {children}
    </div>
  )
}

function Th({ children, right }: { children?: React.ReactNode; right?: boolean }) {
  return (
    <th className={`px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide ${right ? "text-right" : "text-left"}`}
      style={{ color: "var(--text-muted)" }}>
      {children}
    </th>
  )
}

function BankOnlyRow({ row }: { row: BankStatementRow }) {
  const amt = parseFloat(row.amount) || 0
  // Suggested JE: Dr/Cr depends on sign.
  //   Deposit (positive amount): Dr Cash, Cr [Interest Earned / Refund / ...]
  //   Withdrawal (negative): Dr [Bank Fees / NSF / ...], Cr Cash
  const isDeposit = amt > 0
  const suggestion = isDeposit
    ? <>Dr Cash · Cr Interest / Other Income</>
    : <>Dr Bank Fees / NSF · Cr Cash</>
  return (
    <tr style={{ borderTop: "1px solid var(--border)" }}>
      <td className="px-3 py-1.5 text-[11px]" style={{ color: "var(--text-2)" }}>{row.txn_date}</td>
      <td className="px-3 py-1.5 text-theme">{row.description ?? "—"}</td>
      <td className="px-3 py-1.5 text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>{row.bank_ref ?? "—"}</td>
      <td className="px-3 py-1.5 text-right tabular-nums font-semibold"
        style={{ color: isDeposit ? "var(--green)" : "#b91c1c" }}>
        {isDeposit ? <ArrowDownLeft size={10} strokeWidth={2} className="inline-block mr-0.5" /> : <ArrowUpRight size={10} strokeWidth={2} className="inline-block mr-0.5" />}
        {fmt(row.amount)}
      </td>
      <td className="px-3 py-1.5 text-[11px]" style={{ color: "var(--text-2)" }}>
        <FileText size={10} strokeWidth={2} className="inline-block mr-1" style={{ color: "#7c3aed" }} />
        {suggestion}
      </td>
    </tr>
  )
}

function GlOnlyRow({ row }: { row: BankGlRow }) {
  const amt = parseFloat(row.amount) || 0
  // Days-aging would go here in Phase 2 — for v1, just show the row.
  return (
    <tr style={{ borderTop: "1px solid var(--border)" }}>
      <td className="px-3 py-1.5 text-[11px]" style={{ color: "var(--text-2)" }}>{row.txn_date ?? "—"}</td>
      <td className="px-3 py-1.5 text-[11px]" style={{ color: "var(--text-2)" }}>{row.txn_type ?? "—"}</td>
      <td className="px-3 py-1.5 text-theme">{row.memo ?? row.entity_name ?? "—"}</td>
      <td className="px-3 py-1.5 text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>{row.txn_number ?? "—"}</td>
      <td className="px-3 py-1.5 text-right tabular-nums font-semibold"
        style={{ color: amt >= 0 ? "var(--green)" : "#b91c1c" }}>
        {fmt(row.amount)}
      </td>
    </tr>
  )
}
