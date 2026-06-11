/**
 * SchedulePeriodJesPanel — read-only REFERENCE card rendered ABOVE the
 * QBO GL-drill-in "Items" table for schedule-backed reconciliations
 * (Prepaid, Accrual, Fixed Assets, Lease, Loan accounts).
 *
 * The schedule provides the subledger balance (and its lines come into the
 * build-up pre-selected). This card shows the per-period JE for each
 * schedule line — the entry the user should expect to see in QBO's GL for
 * the period. They post these in QuickBooks; after a Re-sync the real GL
 * entries appear in the tick table below and can be ticked there like any
 * other account.
 *
 * Pulls all 5 per-account suggestion endpoints (cached, shared with the
 * existing Suggestions tab). Renders each non-zero line as a small JE card
 * showing Dr / Cr + memo.
 *
 * Per-kind JE mapping:
 *
 *   PREPAID (period_amortization > 0)
 *     Dr  Amortization Expense (P&L)        $period_amortization
 *     Cr  Prepaid Asset (BS)                          $period_amortization
 *
 *   ACCRUAL (line_kind="accrual")
 *     Dr  Expense (P&L)                     $amount
 *     Cr  Accrued Liability (BS)                      $amount
 *   ACCRUAL (line_kind="reversal")
 *     Dr  Accrued Liability (BS)            $amount
 *     Cr  Expense (P&L)                               $amount
 *
 *   FIXED ASSET (line_kind="depreciation")
 *     Dr  Depreciation Expense (P&L)        $amount
 *     Cr  Accumulated Depreciation (BS)               $amount
 *   FIXED ASSET (line_kind="disposal")
 *     Dr  Cash / Loss on Disposal (BS)      $amount
 *     Cr  Fixed Asset (BS)                            $amount
 *   FIXED ASSET (line_kind="addition") → covered by InitialRecordingSuggestionsPanel; skip here
 *
 *   LEASE (line_kind="principal_payment")
 *     Dr  Lease Liability (BS)              $|amount|
 *     Cr  Cash (BS)                                   $|amount|
 *     (Interest accretion shown as separate line per period if present)
 *   LEASE (line_kind="initial") → covered by InitialRecordingSuggestionsPanel; skip
 *
 *   LOAN (line_kind="principal_payment")
 *     Dr  Loan Payable (BS)                 $|amount|
 *     Cr  Cash (BS)                                   $|amount|
 *   LOAN (line_kind="origination") → covered by InitialRecordingSuggestionsPanel; skip
 */
import { useQueries } from "@tanstack/react-query"
import { Layers, ExternalLink } from "lucide-react"
import { Link } from "react-router-dom"

import { schedulesApi } from "@/modules/schedules/api"
import { formatDate } from "@/core/lib/dates"

interface Props {
  qboAccountId: string
  periodEnd:    string
}

interface JeRow {
  account: string
  debit:   number | null
  credit:  number | null
}

interface PeriodJe {
  kind:        "prepaid" | "accrual" | "fixed_asset" | "lease" | "loan"
  itemId:      string
  itemName:    string
  vendor:      string | null
  date:        string  // period_end for prepaids; line_date for delta-based kinds
  kindLabel:   string  // human-readable kind for the chip
  rows:        JeRow[]
  memo:        string
  /** Stable key for the row — matches the Suggestions-tab panels'
   *  synthetic txn_ids so the two surfaces stay correlatable. */
  syntheticId: string
}

function fmt(n: number | null): string {
  if (n === null) return "—"
  if (n === 0) return "$0.00"
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function SchedulePeriodJesPanel({ qboAccountId, periodEnd }: Props) {
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

  const jes: PeriodJe[] = []

  // PREPAID — period amortization for each non-fully-amortized item.
  for (const s of prepaid.data?.items ?? []) {
    const amt = parseFloat(s.period_amortization) || 0
    if (amt <= 0) continue
    jes.push({
      kind:        "prepaid",
      itemId:      s.item_id,
      itemName:    s.description,
      vendor:      s.vendor,
      date:        periodEnd,
      kindLabel:   "Amortization",
      rows: [
        { account: "Amortization Expense (P&L)", debit: amt, credit: null },
        { account: "Prepaid Asset (BS)",          debit: null, credit: amt },
      ],
      memo: `Amortize ${s.description}${s.vendor ? ` (${s.vendor})` : ""} for period ending ${periodEnd}.`,
      syntheticId: `schedule-prepaid-${s.item_id}-period`,
    })
  }

  // ACCRUAL — both directions of the accrual lifecycle in this period.
  for (const s of accrual.data?.items ?? []) {
    const amt = Math.abs(parseFloat(s.amount) || 0)
    if (amt <= 0) continue
    const isAccrual = s.line_kind === "accrual"
    jes.push({
      kind:        "accrual",
      itemId:      s.item_id,
      itemName:    s.description,
      vendor:      s.vendor,
      date:        s.line_date,
      kindLabel:   isAccrual ? "Accrual" : "Reversal",
      rows: isAccrual ? [
        { account: "Expense (P&L)",              debit: amt, credit: null },
        { account: "Accrued Liability (BS)",     debit: null, credit: amt },
      ] : [
        { account: "Accrued Liability (BS)",     debit: amt, credit: null },
        { account: "Expense (P&L)",              debit: null, credit: amt },
      ],
      memo: isAccrual
        ? `Accrue ${s.description}${s.vendor ? ` for ${s.vendor}` : ""} as of ${s.line_date}.`
        : `Reverse ${s.description} accrual${s.vendor ? ` for ${s.vendor}` : ""} on ${s.line_date}.`,
      syntheticId: `schedule-accrual-${s.item_id}-${s.line_kind}`,
    })
  }

  // FIXED ASSET — depreciation + disposal (additions → initial panel).
  for (const s of fa.data?.items ?? []) {
    const amt = Math.abs(parseFloat(s.amount) || 0)
    if (amt <= 0) continue
    if (s.line_kind === "addition") continue  // shown in initial-recording panel
    if (s.line_kind === "depreciation") {
      jes.push({
        kind:        "fixed_asset",
        itemId:      s.item_id,
        itemName:    s.description,
        vendor:      s.vendor,
        date:        s.line_date,
        kindLabel:   "Depreciation",
        rows: [
          { account: "Depreciation Expense (P&L)",        debit: amt, credit: null },
          { account: "Accumulated Depreciation (BS)",     debit: null, credit: amt },
        ],
        memo: `Depreciate ${s.description} for period ending ${s.line_date}.`,
        syntheticId: `schedule-fixed_asset-${s.item_id}-${s.line_kind}`,
      })
    } else if (s.line_kind === "disposal") {
      jes.push({
        kind:        "fixed_asset",
        itemId:      s.item_id,
        itemName:    s.description,
        vendor:      s.vendor,
        date:        s.line_date,
        kindLabel:   "Disposal",
        rows: [
          { account: "Cash / Disposal Clearing (BS)",  debit: amt, credit: null },
          { account: "Fixed Asset (BS)",                debit: null, credit: amt },
        ],
        memo: `Dispose of ${s.description} on ${s.line_date} — reverse cost (and any related accumulated depreciation in a separate JE).`,
        syntheticId: `schedule-fixed_asset-${s.item_id}-${s.line_kind}`,
      })
    }
  }

  // LEASE — principal payments. Initial recognition → initial panel.
  for (const s of lease.data?.items ?? []) {
    const amt = Math.abs(parseFloat(s.amount) || 0)
    if (amt <= 0) continue
    if (s.line_kind === "initial") continue
    if (s.line_kind === "principal_payment") {
      jes.push({
        kind:        "lease",
        itemId:      s.item_id,
        itemName:    s.description,
        vendor:      s.vendor,
        date:        s.line_date,
        kindLabel:   "Lease P+I",
        rows: [
          { account: "Lease Liability (BS)",       debit: amt, credit: null },
          { account: "Interest Expense (P&L)",     debit: 0,   credit: null },  // computed elsewhere — shown for shape
          { account: "Cash (BS)",                   debit: null, credit: amt },
        ],
        memo: `Pay lease for ${s.description} — period ${s.line_date}. Interest accretion booked separately based on remaining balance × periodic rate.`,
        syntheticId: `schedule-lease-${s.item_id}-${s.line_kind}`,
      })
    }
  }

  // LOAN — principal payments. Origination → initial panel.
  for (const s of loan.data?.items ?? []) {
    const amt = Math.abs(parseFloat(s.amount) || 0)
    if (amt <= 0) continue
    if (s.line_kind === "origination") continue
    if (s.line_kind === "principal_payment") {
      jes.push({
        kind:        "loan",
        itemId:      s.item_id,
        itemName:    s.description,
        vendor:      s.vendor,
        date:        s.line_date,
        kindLabel:   "Loan P+I",
        rows: [
          { account: "Loan Payable (BS)",          debit: amt, credit: null },
          { account: "Interest Expense (P&L)",     debit: 0,   credit: null },
          { account: "Cash (BS)",                   debit: null, credit: amt },
        ],
        memo: `Pay loan for ${s.description} — period ${s.line_date}. Interest portion booked separately based on remaining balance × periodic rate.`,
        syntheticId: `schedule-loan-${s.item_id}-${s.line_kind}`,
      })
    }
  }

  const isLoading = queries.some((q) => q.isLoading)
  if (isLoading) {
    return (
      <div className="mb-3 px-3 py-2 text-[11px]"
        style={{ background: "var(--surface)", border: "1px dashed var(--border)", color: "var(--text-muted)", borderRadius: 8 }}>
        Loading schedule entries…
      </div>
    )
  }

  if (jes.length === 0) {
    return (
      <div className="mb-3 rounded-lg px-4 py-6 text-center"
        style={{ background: "var(--surface)", border: "1px dashed var(--border)" }}>
        <p className="text-sm font-semibold text-theme mb-1">No schedule entries this period</p>
        <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
          No prepaid / accrual / depreciation / lease / loan activity from the
          Schedules module hits this account for {formatDate(periodEnd)}.
          Once schedule items have activity here, their expected JEs will
          appear in this list for reference.
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-lg mb-3 overflow-hidden"
      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <div className="px-3 py-2 flex items-center justify-between gap-2 flex-wrap"
        style={{ background: "var(--surface-2)", borderBottom: "1px solid var(--border)" }}>
        <div className="flex items-center gap-2 min-w-0">
          <Layers size={13} strokeWidth={1.8} style={{ color: "var(--green)" }} />
          <p className="text-[11px] font-semibold text-theme">
            Period journal entries — from Nordavix Schedules
          </p>
          <span className="text-[10px] px-1.5 py-0.5 rounded"
            style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
            {jes.length} JE{jes.length === 1 ? "" : "s"}
          </span>
        </div>
        <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
          Verify each against QuickBooks for {formatDate(periodEnd)}
        </span>
      </div>

      <div className="px-3 py-2 text-[10.5px]"
        style={{ background: "rgba(79, 160, 122, 0.04)", color: "var(--text-2)" }}>
        These are the entries the Nordavix Schedules expect in QuickBooks for{" "}
        {formatDate(periodEnd)} — shown for reference. Post each in QBO, then
        Re-sync: the real GL entries appear in the table below, where you can
        tick them to reconcile against the actual posted ledger.
      </div>

      <div className="px-3 py-2 space-y-2.5">
        {jes.map((je, i) => (
          <JeBlock key={je.syntheticId} index={i + 1} je={je} />
        ))}
      </div>

      <div className="px-3 py-2 text-[10px] flex items-center gap-2"
        style={{ borderTop: "1px solid var(--border)", background: "var(--surface-2)", color: "var(--text-muted)" }}>
        <span>Need to edit a schedule item? </span>
        <Link to="/app/schedules" className="inline-flex items-center gap-1 hover:underline"
          style={{ color: "var(--text-2)" }}>
          Open Schedules <ExternalLink size={9} strokeWidth={1.8} />
        </Link>
      </div>
    </div>
  )
}


function JeBlock({ je, index }: { je: PeriodJe; index: number }) {
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
          style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
          {je.kindLabel} · {formatDate(je.date)}
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
                style={{ color: r.debit !== null && r.debit > 0 ? "var(--text)" : "var(--text-muted)" }}>
                {r.debit !== null && r.debit > 0 ? fmt(r.debit) : "—"}
              </td>
              <td className="px-2 py-1 text-right tabular-nums font-semibold"
                style={{ color: r.credit !== null && r.credit > 0 ? "var(--text)" : "var(--text-muted)" }}>
                {r.credit !== null && r.credit > 0 ? fmt(r.credit) : "—"}
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
