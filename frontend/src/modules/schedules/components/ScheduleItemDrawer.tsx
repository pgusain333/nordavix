/**
 * ScheduleItemDrawer — generic right-to-left slide-in for Fixed Assets,
 * Leases, and Loans. Mirrors PrepaidAmortizationDrawer + AccrualReversal
 * Drawer chrome. Per-type body renders the relevant JE preview, lifecycle,
 * and (where applicable) the full amortization table.
 *
 * Kept generic to avoid 3 near-identical drawer files. Type-specific
 * math lives inline since each is short.
 */
import { useMemo } from "react"
import { motion } from "framer-motion"
import { X, FileText } from "lucide-react"
import type {
  FixedAssetItem,
  LeaseItem,
  LoanItem,
} from "@/modules/schedules/types"

type Variant =
  | { kind: "fixed_asset"; item: FixedAssetItem }
  | { kind: "lease";       item: LeaseItem }
  | { kind: "loan";        item: LoanItem }

interface Props {
  variant: Variant
  onClose: () => void
}

function fmt(n: number | string): string {
  const v = typeof n === "string" ? parseFloat(n) : n
  if (!Number.isFinite(v)) return "$0.00"
  return `$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function monthsBetween(start: string, monthsToAdd: number): string {
  const d = new Date(start + "T00:00:00")
  d.setMonth(d.getMonth() + monthsToAdd)
  return d.toISOString().slice(0, 10)
}

function buildFaSchedule(item: FixedAssetItem) {
  const cost = parseFloat(item.cost) || 0
  const salvage = parseFloat(item.salvage_value) || 0
  const months = item.useful_life_months || 0
  if (months <= 0 || cost <= 0) return { rows: [] as Array<{ period_end: string; expense: number; accum: number; nbv: number }>, monthly: 0 }
  const monthly = Math.round(((cost - salvage) / months) * 100) / 100
  const rows: Array<{ period_end: string; expense: number; accum: number; nbv: number }> = []
  let accum = 0
  for (let i = 1; i <= months; i++) {
    const periodEnd = monthsBetween(item.in_service_date, i - 1)
    // period_end = end of that month
    const d = new Date(periodEnd + "T00:00:00")
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0)
    accum = Math.round((accum + monthly) * 100) / 100
    const nbv = Math.max(0, Math.round((cost - accum) * 100) / 100)
    rows.push({
      period_end: last.toISOString().slice(0, 10),
      expense:    monthly,
      accum,
      nbv,
    })
  }
  return { rows, monthly }
}

function buildLoanSchedule(item: LoanItem) {
  const principal = parseFloat(item.original_principal) || 0
  const ratePct = parseFloat(item.interest_rate_pct) || 0
  const term = item.term_months || 0
  if (term <= 0 || principal <= 0) return { rows: [] as Array<{ period_end: string; interest: number; principal: number; balance: number; payment: number }>, payment: 0 }
  const r = ratePct / 100 / 12
  const pmt = item.monthly_payment ? parseFloat(item.monthly_payment) : (
    r === 0 ? principal / term : (principal * r) / (1 - Math.pow(1 + r, -term))
  )
  const rows: Array<{ period_end: string; interest: number; principal: number; balance: number; payment: number }> = []
  let bal = principal
  for (let i = 1; i <= term; i++) {
    const interest = Math.round(bal * r * 100) / 100
    let principalPmt = Math.round((pmt - interest) * 100) / 100
    if (item.payment_type === "interest_only" && i < term) principalPmt = 0
    if (item.payment_type === "interest_only" && i === term) principalPmt = bal
    bal = Math.max(0, Math.round((bal - principalPmt) * 100) / 100)
    const periodEndApprox = monthsBetween(item.loan_date, i - 1)
    const d = new Date(periodEndApprox + "T00:00:00")
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0)
    rows.push({
      period_end: last.toISOString().slice(0, 10),
      interest,
      principal:  principalPmt,
      balance:    bal,
      payment:    Math.round((interest + principalPmt) * 100) / 100,
    })
  }
  return { rows, payment: pmt }
}

function buildLeaseSchedule(item: LeaseItem) {
  if (!item.initial_liability || !item.discount_rate_pct) {
    return { rows: [] as Array<{ period_end: string; interest: number; principal: number; balance: number; payment: number }>, isAsc842: false }
  }
  const liab = parseFloat(item.initial_liability) || 0
  const ratePct = parseFloat(item.discount_rate_pct) || 0
  const r = ratePct / 100 / 12
  const pmt = parseFloat(item.monthly_payment) || 0
  // Term derived from lease dates
  const start = new Date(item.lease_start + "T00:00:00")
  const end = new Date(item.lease_end + "T00:00:00")
  const term = Math.max(1, (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()) + 1)
  const rows: Array<{ period_end: string; interest: number; principal: number; balance: number; payment: number }> = []
  let bal = liab
  for (let i = 1; i <= term; i++) {
    const interest = Math.round(bal * r * 100) / 100
    const principal = Math.round((pmt - interest) * 100) / 100
    bal = Math.max(0, Math.round((bal - principal) * 100) / 100)
    const periodEndApprox = monthsBetween(item.lease_start, i - 1)
    const d = new Date(periodEndApprox + "T00:00:00")
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0)
    rows.push({
      period_end: last.toISOString().slice(0, 10),
      interest,
      principal,
      balance: bal,
      payment: pmt,
    })
  }
  return { rows, isAsc842: true }
}

export function ScheduleItemDrawer({ variant, onClose }: Props) {
  // Compute schedule client-side based on variant.
  const body = useMemo(() => {
    if (variant.kind === "fixed_asset") return { type: "fa" as const, ...buildFaSchedule(variant.item) }
    if (variant.kind === "lease")       return { type: "lease" as const, ...buildLeaseSchedule(variant.item) }
    return { type: "loan" as const, ...buildLoanSchedule(variant.item) }
  }, [variant])

  const headerColor = variant.kind === "fixed_asset" ? "#15803d"
                    : variant.kind === "lease"       ? "#7c3aed"
                    : "#be123c"
  const kicker = variant.kind === "fixed_asset" ? "Depreciation schedule"
              : variant.kind === "lease"       ? "Lease amortization schedule"
              : "Loan amortization schedule"

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
        className="fixed inset-0 z-40"
        style={{ background: "rgba(0,0,0,0.45)" }}
        onClick={onClose}
      />
      <motion.aside
        initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }}
        transition={{ type: "tween", duration: 0.25, ease: "easeOut" }}
        className="fixed inset-y-0 right-0 z-50 w-full sm:w-[700px] flex flex-col"
        style={{
          background: "var(--bg)",
          borderLeft: "1px solid var(--border)",
          boxShadow: "-12px 0 32px rgba(0,0,0,0.18)",
        }}>
        {/* Header */}
        <div className="px-5 py-4 flex items-start justify-between gap-3"
          style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1">
              <FileText size={15} strokeWidth={1.8} style={{ color: headerColor }} />
              <p className="text-[10px] font-semibold uppercase tracking-wider"
                style={{ color: headerColor }}>{kicker}</p>
            </div>
            <h2 className="text-base font-bold text-theme truncate">{variant.item.description}</h2>
            <DrawerSubtitle variant={variant} />
          </div>
          <button onClick={onClose}
            className="h-7 w-7 rounded-md flex items-center justify-center hover:bg-[var(--surface-2)]"
            style={{ color: "var(--text-muted)" }} title="Close">
            <X size={15} strokeWidth={1.8} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {variant.kind === "fixed_asset" && body.type === "fa" && (
            <FaBody item={variant.item} monthly={body.monthly} rows={body.rows} />
          )}
          {variant.kind === "loan" && body.type === "loan" && (
            <LoanBody item={variant.item} payment={body.payment} rows={body.rows} />
          )}
          {variant.kind === "lease" && body.type === "lease" && (
            <LeaseBody item={variant.item} rows={body.rows} isAsc842={body.isAsc842} />
          )}
        </div>
      </motion.aside>
    </>
  )
}

// ── Subtitle ─────────────────────────────────────────────────────────────

function DrawerSubtitle({ variant }: { variant: Variant }) {
  if (variant.kind === "fixed_asset") {
    return (
      <p className="text-[11px] mt-0.5" style={{ color: "var(--text-muted)" }}>
        {variant.item.vendor ?? "—"}
        {variant.item.category && <span> · {variant.item.category}</span>}
        {" · "}In service {variant.item.in_service_date}
        {" · "}{variant.item.useful_life_months} months SL
      </p>
    )
  }
  if (variant.kind === "lease") {
    return (
      <p className="text-[11px] mt-0.5" style={{ color: "var(--text-muted)" }}>
        {variant.item.lessor ?? "—"}
        {" · "}{variant.item.lease_start} → {variant.item.lease_end}
        {" · "}${parseFloat(variant.item.monthly_payment).toLocaleString()}/mo
      </p>
    )
  }
  return (
    <p className="text-[11px] mt-0.5" style={{ color: "var(--text-muted)" }}>
      {variant.item.lender ?? "—"}
      {" · "}{variant.item.term_months} months at {variant.item.interest_rate_pct}%
      {" · "}{variant.item.payment_type}
    </p>
  )
}

// ── Fixed asset body ─────────────────────────────────────────────────────

function FaBody({ item, monthly, rows }: { item: FixedAssetItem; monthly: number; rows: Array<{ period_end: string; expense: number; accum: number; nbv: number }> }) {
  const cost = parseFloat(item.cost) || 0
  return (
    <>
      <KpiRow cells={[
        { label: "Cost",          value: fmt(cost) },
        { label: "Salvage",       value: fmt(item.salvage_value) },
        { label: "Monthly dep.",  value: fmt(monthly) },
        { label: "Useful life",   value: `${item.useful_life_months} mo` },
      ]} />

      {/* Initial recording — asset acquisition. Posted ONCE at the
          in-service date. Capitalizes the asset on the BS against
          cash / AP (or reclassifies from an expense account if the
          item was originally mis-expensed — the AI-detect banner
          handles that flow). Single render at the top of the drawer,
          never duplicates inside the per-period schedule rows. */}
      {cost > 0 && (
        <Section title={`Initial recording entry (${item.in_service_date})`}>
          <JeTable rows={[
            { account: `Fixed Asset${item.category ? ` — ${item.category}` : ""} (BS)`, debit: cost, credit: null },
            { account: "Cash / Accounts Payable (BS)", debit: null, credit: cost, indent: true },
          ]} memo={`Capitalize ${item.description}${item.vendor ? ` from ${item.vendor}` : ""} — in service ${item.in_service_date}.`} />
        </Section>
      )}

      <Section title="Monthly journal entry">
        <JeTable rows={[
          { account: item.offset_account_name || "Depreciation Expense (P&L)", debit: monthly,  credit: null },
          { account: "Accumulated Depreciation (BS)", debit: null,    credit: monthly, indent: true },
        ]} memo={`Record ${fmt(monthly)} SL depreciation for ${item.description}.`} />
      </Section>

      <Section title="Full depreciation schedule">
        <ScheduleTable
          cols={["Period end", "Expense", "Accumulated dep.", "Net book value"]}
          rows={rows.map((r) => [r.period_end, fmt(r.expense), fmt(r.accum), fmt(r.nbv)])}
        />
        {item.disposed_on && (
          <p className="text-[10px] mt-2" style={{ color: "#b91c1c" }}>
            Asset disposed on {item.disposed_on} — any remaining NBV is written off at disposal.
          </p>
        )}
      </Section>
    </>
  )
}

// ── Loan body ────────────────────────────────────────────────────────────

function LoanBody({ item, payment, rows }: { item: LoanItem; payment: number; rows: Array<{ period_end: string; interest: number; principal: number; balance: number; payment: number }> }) {
  const first = rows[0]
  const principal = parseFloat(item.original_principal) || 0
  return (
    <>
      <KpiRow cells={[
        { label: "Principal", value: fmt(item.original_principal) },
        { label: "Monthly P+I", value: fmt(payment) },
        { label: "Rate", value: `${item.interest_rate_pct}%` },
        { label: "Term", value: `${item.term_months} mo` },
      ]} />

      {/* Initial recording — loan origination. Posted ONCE at the
          loan_date, before any monthly P+I starts. Recognizes the cash
          received and the corresponding liability. The drawer always
          renders the schedule from row 0 = the loan's first month, so
          this Section appears at the top of the schedule view and never
          duplicates on later months. */}
      {first && principal > 0 && (
        <Section title={`Initial recording entry (${item.loan_date})`}>
          <JeTable rows={[
            { account: "Cash (BS)", debit: principal, credit: null },
            { account: "Loan Payable (BS)", debit: null, credit: principal, indent: true },
          ]} memo={`Originate ${fmt(principal)} loan${item.lender ? ` from ${item.lender}` : ""} — ${item.description}.`} />
        </Section>
      )}

      {first && (
        <Section title={`Month 1 journal entry (${first.period_end})`}>
          <JeTable rows={[
            { account: "Loan Liability (BS)", debit: first.principal, credit: null },
            { account: item.offset_account_name || "Interest Expense (P&L)", debit: first.interest, credit: null, indent: true },
            { account: "Cash (BS)", debit: null, credit: first.payment, indent: true },
          ]} memo={`Pay ${fmt(first.payment)} on ${item.description} — ${fmt(first.principal)} principal + ${fmt(first.interest)} interest.`} />
        </Section>
      )}

      <Section title="Amortization schedule">
        <ScheduleTable
          cols={["Period end", "Payment", "Interest", "Principal", "Balance"]}
          rows={rows.map((r) => [r.period_end, fmt(r.payment), fmt(r.interest), fmt(r.principal), fmt(r.balance)])}
        />
      </Section>
    </>
  )
}

// ── Lease body ───────────────────────────────────────────────────────────

function LeaseBody({ item, rows, isAsc842 }: { item: LeaseItem; rows: Array<{ period_end: string; interest: number; principal: number; balance: number; payment: number }>; isAsc842: boolean }) {
  return (
    <>
      <KpiRow cells={[
        { label: "Monthly payment", value: fmt(item.monthly_payment) },
        { label: "Initial liability", value: item.initial_liability ? fmt(item.initial_liability) : "—" },
        { label: "Discount rate", value: item.discount_rate_pct ? `${item.discount_rate_pct}%` : "—" },
        { label: "Mode", value: isAsc842 ? "ASC 842" : "Cash-basis" },
      ]} />

      {!isAsc842 && (
        <div className="rounded-lg p-4 text-xs"
          style={{ background: "var(--surface)", border: "1px dashed var(--border-strong)", color: "var(--text-muted)" }}>
          This lease is tracked cash-basis — no ROU asset or lease liability on the BS.
          Each monthly payment hits operating expense directly. To enable ASC 842 roll-
          forward (with the full amortization table below), fill in the discount rate
          and initial ROU / liability fields on the item and re-commit the snapshot.
        </div>
      )}

      {/* Initial recording — ASC 842 initial measurement. Posted ONCE
          at lease commencement, before any monthly P+I. Recognizes the
          ROU asset and the corresponding lease liability at the present
          value of the payment stream. The drawer always renders the
          schedule from row 0 = the lease's first month, so this Section
          appears at the top of the schedule view and never duplicates
          on later months. */}
      {isAsc842 && rows[0] && item.initial_rou_asset && item.initial_liability && (
        <Section title={`Initial recording entry (${item.lease_start})`}>
          <JeTable rows={[
            { account: "Right-of-use Asset (BS)", debit: parseFloat(item.initial_rou_asset) || 0, credit: null },
            { account: "Lease Liability (BS)", debit: null, credit: parseFloat(item.initial_liability) || 0, indent: true },
          ]} memo={`Recognize ROU asset + lease liability at PV of payments — ${item.description} (ASC 842).`} />
        </Section>
      )}

      {isAsc842 && rows[0] && (
        <Section title={`Month 1 journal entry (${rows[0].period_end})`}>
          <JeTable rows={[
            { account: "Lease Liability (BS)", debit: rows[0].principal, credit: null },
            { account: item.offset_account_name || "Interest Expense (P&L)", debit: rows[0].interest, credit: null, indent: true },
            { account: "Cash (BS)", debit: null, credit: rows[0].payment, indent: true },
          ]} memo={`Pay ${fmt(rows[0].payment)} lease for ${item.description} — interest + principal split.`} />
        </Section>
      )}

      {isAsc842 && (
        <Section title="Liability amortization">
          <ScheduleTable
            cols={["Period end", "Payment", "Interest", "Principal", "Liability"]}
            rows={rows.map((r) => [r.period_end, fmt(r.payment), fmt(r.interest), fmt(r.principal), fmt(r.balance)])}
          />
        </Section>
      )}
    </>
  )
}

// ── Building blocks ──────────────────────────────────────────────────────

function KpiRow({ cells }: { cells: Array<{ label: string; value: string }> }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {cells.map((c) => (
        <div key={c.label}>
          <p className="text-[10px] font-semibold uppercase tracking-wider"
            style={{ color: "var(--text-muted)" }}>{c.label}</p>
          <p className="text-sm font-bold tabular-nums mt-0.5 text-theme">{c.value}</p>
        </div>
      ))}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <p className="text-[10px] font-semibold uppercase tracking-wider mb-2"
        style={{ color: "var(--text-muted)" }}>{title}</p>
      {children}
    </section>
  )
}

function JeTable({ rows, memo }: { rows: Array<{ account: string; debit: number | null; credit: number | null; indent?: boolean }>; memo: string }) {
  return (
    <div className="rounded-lg overflow-hidden"
      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <table className="w-full text-xs">
        <thead>
          <tr style={{ background: "var(--surface-2)" }}>
            <th className="text-left px-3 py-1.5 font-semibold text-[10px] uppercase tracking-wide"
              style={{ color: "var(--text-muted)" }}>Account</th>
            <th className="text-right px-3 py-1.5 font-semibold text-[10px] uppercase tracking-wide"
              style={{ color: "var(--text-muted)" }}>Debit</th>
            <th className="text-right px-3 py-1.5 font-semibold text-[10px] uppercase tracking-wide"
              style={{ color: "var(--text-muted)" }}>Credit</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ borderTop: "1px solid var(--border)" }}>
              <td className={`px-3 py-2 text-theme ${r.indent ? "pl-6" : ""}`}>{r.account}</td>
              <td className="px-3 py-2 text-right tabular-nums"
                style={{ color: r.debit  !== null ? "var(--text)" : "var(--text-muted)" }}>
                {r.debit  !== null ? fmt(r.debit)  : "—"}
              </td>
              <td className="px-3 py-2 text-right tabular-nums"
                style={{ color: r.credit !== null ? "var(--text)" : "var(--text-muted)" }}>
                {r.credit !== null ? fmt(r.credit) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="px-3 py-2 text-[10px]"
        style={{ background: "var(--surface-2)", color: "var(--text-muted)", borderTop: "1px solid var(--border)" }}>
        Memo: {memo}
      </div>
    </div>
  )
}

function ScheduleTable({ cols, rows }: { cols: string[]; rows: string[][] }) {
  return (
    <div className="rounded-lg overflow-hidden"
      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <div className="overflow-x-auto" style={{ maxHeight: "40vh" }}>
        <table className="w-full text-xs">
          <thead>
            <tr style={{ background: "var(--surface-2)", position: "sticky", top: 0 }}>
              {cols.map((c, i) => (
                <th key={c} className={`px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide ${i === 0 ? "text-left" : "text-right"}`}
                  style={{ color: "var(--text-muted)" }}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri} style={{ borderTop: "1px solid var(--border)" }}>
                {row.map((cell, ci) => (
                  <td key={ci} className={`px-3 py-1.5 ${ci === 0 ? "text-left text-theme" : "text-right tabular-nums"}`}
                    style={{ color: ci === 0 ? undefined : "var(--text-2)" }}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
