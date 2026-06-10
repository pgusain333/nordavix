/**
 * InitialRecordingSuggestionsPanel — recon drawer Suggestions tab,
 * top section. Surfaces the INITIAL RECORDING journal entries the
 * user needs to post in QBO for any schedule item whose inception
 * date falls in the period being reconciled.
 *
 * Why this exists:
 *   When a fresh schedule item starts in this period (prepaid begins
 *   amortizing, accrual gets booked, fixed asset is placed in service,
 *   lease commences under ASC 842, loan is originated), the GL won't
 *   yet show the corresponding BS recognition unless the user posts
 *   the initial JE in QuickBooks. Without it, GL = $0 but Nordavix's
 *   subledger build-up = $X, creating a variance the user can't
 *   reconcile away.
 *
 *   This panel makes that explicit: "post these Dr/Cr in QuickBooks,
 *   re-sync, then the variance clears."
 *
 * Pulls all 5 per-account suggestion endpoints (React Query caches so
 * the existing per-type panels below don't double-fetch). Filters
 * each to items whose inception line_date falls in the same YYYY-MM
 * as the period_end being reconciled — and only the inception-flavored
 * line_kind for each schedule type:
 *
 *   prepaid     → start_date in period month
 *   accrual     → line_kind="accrual" + line_date in period month
 *                  (the accrual-side of the pair; reversals are
 *                   recurring not initial)
 *   fixed_asset → line_kind="addition" + line_date in period month
 *   lease       → line_kind="initial"  + line_date in period month
 *   loan        → line_kind="origination" + line_date in period month
 *
 * Renders nothing if no first-month items exist for this account —
 * which is the common case for any given period.
 */
import { useQueries } from "@tanstack/react-query"
import { Sparkles } from "lucide-react"

import { schedulesApi } from "@/modules/schedules/api"

interface Props {
  qboAccountId: string
  periodEnd:    string
}

interface JeRow {
  account: string
  debit:   number | null
  credit:  number | null
}

interface InitialJe {
  kind:     "prepaid" | "accrual" | "fixed_asset" | "lease" | "loan"
  itemId:   string
  itemName: string
  vendor:   string | null
  date:     string
  rows:     JeRow[]
  memo:     string
}

function fmt(n: number | string | null): string {
  if (n === null) return "—"
  const v = typeof n === "string" ? parseFloat(n) || 0 : n
  if (v === 0) return "$0.00"
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function isSameMonth(a: string, b: string): boolean {
  if (!a || !b) return false
  return a.slice(0, 7) === b.slice(0, 7)
}

const KIND_LABEL: Record<InitialJe["kind"], string> = {
  prepaid:     "Prepaid",
  accrual:     "Accrual",
  fixed_asset: "Fixed asset",
  lease:       "Lease (ASC 842)",
  loan:        "Loan",
}

export function InitialRecordingSuggestionsPanel({ qboAccountId, periodEnd }: Props) {
  const queries = useQueries({
    queries: [
      {
        queryKey: ["schedules", "prepaid", "suggestions", qboAccountId, periodEnd],
        queryFn:  () => schedulesApi.getPrepaidSuggestions(qboAccountId, periodEnd),
        staleTime: 60_000,
      },
      {
        queryKey: ["schedules", "accrual", "suggestions", qboAccountId, periodEnd],
        queryFn:  () => schedulesApi.getAccrualSuggestions(qboAccountId, periodEnd),
        staleTime: 60_000,
      },
      {
        queryKey: ["schedules", "fixed_asset", "suggestions", qboAccountId, periodEnd],
        queryFn:  () => schedulesApi.getFixedAssetSuggestions(qboAccountId, periodEnd),
        staleTime: 60_000,
      },
      {
        queryKey: ["schedules", "lease", "suggestions", qboAccountId, periodEnd],
        queryFn:  () => schedulesApi.getLeaseSuggestions(qboAccountId, periodEnd),
        staleTime: 60_000,
      },
      {
        queryKey: ["schedules", "loan", "suggestions", qboAccountId, periodEnd],
        queryFn:  () => schedulesApi.getLoanSuggestions(qboAccountId, periodEnd),
        staleTime: 60_000,
      },
    ],
  })
  const [prepaid, accrual, fa, lease, loan] = queries

  const jes: InitialJe[] = []

  // Prepaid — start_date inside the period month.
  for (const it of prepaid.data?.items ?? []) {
    if (!isSameMonth(it.start_date, periodEnd)) continue
    const total = parseFloat(it.total_amount) || 0
    if (total <= 0) continue
    jes.push({
      kind:     "prepaid",
      itemId:   it.item_id,
      itemName: it.description,
      vendor:   it.vendor,
      date:     it.start_date,
      rows: [
        { account: "Prepaid Asset (BS)",            debit: total, credit: null  },
        { account: "Cash / Accounts Payable (BS)",  debit: null,  credit: total },
      ],
      memo: `Record prepaid ${it.description}${it.vendor ? ` from ${it.vendor}` : ""} — coverage ${it.start_date} → ${it.end_date}.`,
    })
  }

  // Accrual — line_kind="accrual" inside the period month.
  for (const it of accrual.data?.items ?? []) {
    if (it.line_kind !== "accrual") continue
    if (!isSameMonth(it.line_date, periodEnd)) continue
    const amt = Math.abs(parseFloat(it.amount) || 0)
    if (amt <= 0) continue
    jes.push({
      kind:     "accrual",
      itemId:   it.item_id,
      itemName: it.description,
      vendor:   it.vendor,
      date:     it.line_date,
      rows: [
        { account: "Expense (P&L)",              debit: amt,  credit: null },
        { account: "Accrued Liability (BS)",     debit: null, credit: amt  },
      ],
      memo: `Accrue ${it.description}${it.vendor ? ` for ${it.vendor}` : ""} — services performed by ${it.line_date}.`,
    })
  }

  // Fixed asset — line_kind="addition" inside the period month.
  for (const it of fa.data?.items ?? []) {
    if (it.line_kind !== "addition") continue
    if (!isSameMonth(it.line_date, periodEnd)) continue
    const amt = Math.abs(parseFloat(it.amount) || 0)
    if (amt <= 0) continue
    jes.push({
      kind:     "fixed_asset",
      itemId:   it.item_id,
      itemName: it.description,
      vendor:   it.vendor,
      date:     it.line_date,
      rows: [
        { account: "Fixed Asset (BS)",              debit: amt,  credit: null },
        { account: "Cash / Accounts Payable (BS)",  debit: null, credit: amt  },
      ],
      memo: `Capitalize ${it.description}${it.vendor ? ` from ${it.vendor}` : ""} — in service ${it.line_date}.`,
    })
  }

  // Lease — line_kind="initial" inside the period month (ASC 842 inception).
  for (const it of lease.data?.items ?? []) {
    if (it.line_kind !== "initial") continue
    if (!isSameMonth(it.line_date, periodEnd)) continue
    const amt = Math.abs(parseFloat(it.amount) || 0)
    if (amt <= 0) continue
    jes.push({
      kind:     "lease",
      itemId:   it.item_id,
      itemName: it.description,
      vendor:   it.vendor,
      date:     it.line_date,
      rows: [
        { account: "Right-of-use Asset (BS)",    debit: amt,  credit: null },
        { account: "Lease Liability (BS)",       debit: null, credit: amt  },
      ],
      memo: `Recognize ROU asset + lease liability at PV of payments — ${it.description} (ASC 842).`,
    })
  }

  // Loan — line_kind="origination" inside the period month.
  for (const it of loan.data?.items ?? []) {
    if (it.line_kind !== "origination") continue
    if (!isSameMonth(it.line_date, periodEnd)) continue
    const amt = Math.abs(parseFloat(it.amount) || 0)
    if (amt <= 0) continue
    jes.push({
      kind:     "loan",
      itemId:   it.item_id,
      itemName: it.description,
      vendor:   it.vendor,
      date:     it.line_date,
      rows: [
        { account: "Cash (BS)",            debit: amt,  credit: null },
        { account: "Loan Payable (BS)",    debit: null, credit: amt  },
      ],
      memo: `Originate ${it.description}${it.vendor ? ` from ${it.vendor}` : ""} — receive cash, recognize liability.`,
    })
  }

  if (jes.length === 0) return null

  return (
    <div className="rounded-lg mb-3 overflow-hidden"
      style={{ background: "var(--surface)", border: "1px solid rgba(84, 88, 138, 0.40)" }}>
      <div className="px-3 py-2 flex items-center gap-2 flex-wrap"
        style={{ background: "rgba(84, 88, 138, 0.08)", borderBottom: "1px solid var(--border)" }}>
        <Sparkles size={13} strokeWidth={1.8} style={{ color: "#54588a" }} />
        <p className="text-[11px] font-semibold text-theme">
          Initial recording entries · post in QuickBooks for this period
        </p>
        <span className="text-[10px] px-1.5 py-0.5 rounded"
          style={{ background: "rgba(84, 88, 138, 0.12)", color: "#54588a" }}>
          {jes.length} item{jes.length === 1 ? "" : "s"} starting in {periodEnd.slice(0, 7)}
        </span>
      </div>

      <div className="px-3 py-2 text-[10.5px]"
        style={{ background: "rgba(84, 88, 138, 0.04)", color: "#5b21b6" }}>
        These schedule items start in this period — their inception JEs aren't on the GL
        yet. Post each Dr/Cr below in QuickBooks, then click Re-sync above to refresh the
        GL balance. Once the GL recognizes them, the variance against the subledger
        build-up (from the suggestion rows below) clears to zero.
      </div>

      <div className="px-3 py-2 space-y-2.5">
        {jes.map((je, i) => (
          <InitialJeBlock key={`${je.kind}-${je.itemId}`} je={je} index={i + 1} />
        ))}
      </div>
    </div>
  )
}

function InitialJeBlock({ je, index }: { je: InitialJe; index: number }) {
  return (
    <div className="rounded-md overflow-hidden"
      style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
      <div className="px-2.5 py-1.5 flex items-center justify-between gap-2 flex-wrap"
        style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
        <p className="text-[11px] font-semibold text-theme">
          <span className="inline-block w-4 text-[10px] font-mono"
            style={{ color: "var(--text-muted)" }}>{index}.</span>
          {je.itemName}
          {je.vendor && (
            <span className="font-normal" style={{ color: "var(--text-muted)" }}>
              {" · "}{je.vendor}
            </span>
          )}
        </p>
        <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
          style={{ background: "rgba(84, 88, 138, 0.12)", color: "#54588a" }}>
          {KIND_LABEL[je.kind]} · {je.date}
        </span>
      </div>
      <table className="w-full text-[11px]">
        <thead>
          <tr style={{ background: "var(--surface)" }}>
            <th className="text-left px-2 py-1 font-semibold"
              style={{ color: "var(--text-muted)" }}>Account</th>
            <th className="text-right px-2 py-1 font-semibold"
              style={{ color: "var(--text-muted)", width: 100 }}>Debit</th>
            <th className="text-right px-2 py-1 font-semibold"
              style={{ color: "var(--text-muted)", width: 100 }}>Credit</th>
          </tr>
        </thead>
        <tbody>
          {je.rows.map((r, i) => (
            <tr key={i} style={{ borderTop: "1px solid var(--border)" }}>
              <td className="px-2 py-1 text-theme"
                style={{ paddingLeft: r.credit !== null && r.debit === null ? 16 : 8 }}>
                {r.account}
              </td>
              <td className="px-2 py-1 text-right tabular-nums font-semibold"
                style={{ color: r.debit !== null ? "var(--text)" : "var(--text-muted)" }}>
                {fmt(r.debit)}
              </td>
              <td className="px-2 py-1 text-right tabular-nums font-semibold"
                style={{ color: r.credit !== null ? "var(--text)" : "var(--text-muted)" }}>
                {fmt(r.credit)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="px-2.5 py-1.5 text-[10px] italic"
        style={{ background: "var(--surface)", color: "var(--text-muted)", borderTop: "1px solid var(--border)" }}>
        Memo: {je.memo}
      </div>
    </div>
  )
}
