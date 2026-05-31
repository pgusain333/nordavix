/**
 * PrepaidSuggestionsPanel — slotted into the recon's inline accordion.
 *
 * For the open account+period, fetches every active prepaid item that's
 * still amortizing. Renders each as a checkbox row. When the user
 * toggles a row, the parent (InlineSubledgerForm) adds/removes it from
 * its existing `selectedItemMap` as a ReconcilingItem — so the recon's
 * own SL build-up math picks up the change with zero plumbing.
 *
 * Days-based amortization is computed server-side; this component just
 * renders the numbers and surfaces the totals.
 *
 * Renders nothing if there are no prepaids for this account.
 */
import { useQuery } from "@tanstack/react-query"
import { Calendar, CheckCircle2, ExternalLink, AlertCircle } from "lucide-react"
import { Link } from "react-router-dom"

import { Spinner } from "@/core/ui/components"
import { schedulesApi, type PrepaidSuggestion } from "@/modules/schedules/api"
import { BulkSelectCheckbox } from "@/modules/schedules/components/BulkSelectCheckbox"

interface Props {
  qboAccountId: string
  periodEnd:    string
  /** Synthetic txn_ids currently selected (parent's selectedItemMap keys). */
  selectedIds:  Set<string>
  /** Fired on every checkbox toggle. Parent decides what to add to its map. */
  onToggle:     (suggestion: PrepaidSuggestion, nextChecked: boolean) => void
  /** Bulk select / clear every selectable row in this panel at once. */
  onBulkSet:    (suggestions: PrepaidSuggestion[], nextChecked: boolean) => void
  readOnly?:    boolean
  /** When true, schedule items are AUTHORITATIVE — the parent's
   *  auto-flow effect has already pre-selected every line as a
   *  reconciling item and the user can't deselect them. Checkboxes
   *  render disabled + checked; the bulk toggle is hidden; the footer
   *  copy switches to "auto-included" wording. */
  autoIncluded?: boolean
}

/** Stable synthetic ID matching what the parent stores in selectedItemMap. */
export function prepaidTxnId(suggestion: PrepaidSuggestion): string {
  return `schedule-prepaid-${suggestion.item_id}`
}

function fmt(s: string): string {
  const n = parseFloat(s) || 0
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function PrepaidSuggestionsPanel({
  qboAccountId, periodEnd, selectedIds, onToggle, onBulkSet, readOnly, autoIncluded,
}: Props) {
  // Auto-include lock: schedule items are the authoritative subledger,
  // so the parent has already pre-ticked them. We render checkboxes
  // disabled-checked and hide the bulk toggle so the user can't
  // accidentally remove a schedule line from the SL.
  const lockTicks = !!autoIncluded
  const { data, isLoading } = useQuery({
    queryKey: ["schedules", "prepaid", "suggestions", qboAccountId, periodEnd],
    queryFn:  () => schedulesApi.getPrepaidSuggestions(qboAccountId, periodEnd),
    staleTime: 60_000,
  })

  if (isLoading) {
    return (
      <div className="rounded-md px-3 py-2 mb-3 text-[11px] flex items-center gap-2"
        style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}>
        <Spinner className="h-3 w-3" />
        Checking Prepaids schedule…
      </div>
    )
  }

  const items = data?.items ?? []

  // No items, no uncommitted hint → render nothing (the most common
  // case — most accounts have no prepaids attached).
  if (items.length === 0 && !data?.has_uncommitted) return null

  // Items exist on the schedule but the snapshot for this period hasn't
  // been committed yet. Show a hint so the user knows what's needed
  // for them to appear here as selectable line items.
  if (items.length === 0 && data?.has_uncommitted) {
    return (
      <div className="rounded-lg mb-3 px-3 py-2 flex items-center gap-2 text-[11px]"
        style={{
          background: "rgba(245, 158, 11, 0.10)",
          border: "1px solid rgba(245, 158, 11, 0.40)",
          color: "#92400e",
        }}>
        <AlertCircle size={12} strokeWidth={2} />
        <span>
          You have prepaid items mapped to this account but the snapshot for{" "}
          <span className="font-semibold">{periodEnd}</span> isn't committed yet.{" "}
          <Link to="/app/schedules/prepaids"
            className="font-semibold underline"
            target="_blank" rel="noopener noreferrer">
            Open the Prepaids schedule
          </Link>{" "}
          and click <span className="font-semibold">Commit snapshot</span> to surface
          the items here as selectable subledger components.
        </span>
      </div>
    )
  }

  const selectedSum = items
    .filter((it) => selectedIds.has(prepaidTxnId(it)))
    .reduce((s, it) => s + (parseFloat(it.unamortized_at_period_end) || 0), 0)
  const allSum = items.reduce((s, it) => s + (parseFloat(it.unamortized_at_period_end) || 0), 0)
  const selectedCount = items.filter((it) => selectedIds.has(prepaidTxnId(it))).length

  return (
    <div className="rounded-lg mb-3 overflow-hidden"
      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <div className="px-3 py-2 flex items-center justify-between gap-2 flex-wrap"
        style={{
          background: "var(--surface-2)",
          borderBottom: "1px solid var(--border)",
        }}>
        <div className="flex items-center gap-2 min-w-0">
          {!lockTicks && (
            <BulkSelectCheckbox
              total={items.filter((it) => !it.fully_amortized).length}
              selected={items.filter((it) => !it.fully_amortized && selectedIds.has(prepaidTxnId(it))).length}
              disabled={readOnly}
              onChange={(nextChecked) => onBulkSet(items.filter((it) => !it.fully_amortized), nextChecked)}
              title="Select / clear every active prepaid item in this period"
            />
          )}
          <Calendar size={13} strokeWidth={1.8} style={{ color: "#1d4ed8" }} />
          <p className="text-[11px] font-semibold text-theme">
            {lockTicks ? "From Prepaids schedule (auto-included)" : "Suggested from Prepaids schedule"}
          </p>
          <span className="text-[10px] px-1.5 py-0.5 rounded"
            style={{ background: "rgba(29, 78, 216, 0.12)", color: "#1d4ed8" }}>
            {items.length} item{items.length === 1 ? "" : "s"} · days-based
          </span>
          {lockTicks && (
            <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
              style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
              Subledger source
            </span>
          )}
        </div>
        <Link to="/app/schedules/prepaids" target="_blank" rel="noopener noreferrer"
          className="text-[10px] inline-flex items-center gap-1 hover:underline"
          style={{ color: "var(--text-muted)" }}>
          Open schedule
          <ExternalLink size={9} strokeWidth={1.8} />
        </Link>
      </div>

      <div className="px-3 py-1">
        <table className="w-full text-xs">
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <th className="text-left py-1.5 font-semibold text-[10px] uppercase tracking-wider"
                style={{ color: "var(--text-muted)", width: 28 }}></th>
              <th className="text-left py-1.5 font-semibold text-[10px] uppercase tracking-wider"
                style={{ color: "var(--text-muted)" }}>Item</th>
              <th className="text-left py-1.5 font-semibold text-[10px] uppercase tracking-wider"
                style={{ color: "var(--text-muted)" }}>Coverage</th>
              <th className="text-right py-1.5 font-semibold text-[10px] uppercase tracking-wider"
                style={{ color: "var(--text-muted)" }}>This-period amort.</th>
              <th className="text-right py-1.5 font-semibold text-[10px] uppercase tracking-wider"
                style={{ color: "var(--text-muted)" }}>Unamortized
                <div className="text-[9px] font-normal normal-case" style={{ color: "var(--text-muted)" }}>
                  (adds to SL)
                </div>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => {
              const checked = selectedIds.has(prepaidTxnId(it))
              const dim = it.fully_amortized
              return (
                <tr key={it.item_id}
                  style={{
                    borderBottom: "1px solid var(--border)",
                    opacity: dim ? 0.55 : 1,
                  }}>
                  <td className="py-2 pr-1">
                    <input
                      type="checkbox"
                      checked={checked || (lockTicks && !dim)}
                      disabled={readOnly || dim || lockTicks}
                      onChange={(e) => onToggle(it, e.target.checked)}
                      className="h-3.5 w-3.5 rounded"
                      style={{
                        accentColor: "var(--green)",
                        cursor: lockTicks ? "default" : "pointer",
                      }}
                      title={lockTicks
                        ? "Auto-included from the Prepaids schedule — this is the authoritative subledger source for this account"
                        : dim ? "Fully amortized — nothing to add" : "Include in subledger"}
                    />
                  </td>
                  <td className="py-2 pr-3">
                    <div className="text-theme font-medium">{it.description}</div>
                    <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                      {it.vendor || "—"}
                      {it.reference && <span> · {it.reference}</span>}
                      {dim && <span className="ml-1 font-semibold" style={{ color: "var(--green)" }}>· Fully amortized</span>}
                    </div>
                  </td>
                  <td className="py-2 pr-3">
                    <div className="text-[11px]" style={{ color: "var(--text-2)" }}>
                      {it.start_date} → {it.end_date}
                    </div>
                    <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                      {it.total_days} days · {fmt(it.daily_rate)}/day · total {fmt(it.total_amount)}
                    </div>
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums"
                    style={{ color: "var(--text-2)" }}>
                    {fmt(it.period_amortization)}
                  </td>
                  <td className="py-2 text-right tabular-nums font-semibold text-theme">
                    {fmt(it.unamortized_at_period_end)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="px-3 py-2 flex items-center justify-between gap-2 flex-wrap"
        style={{ borderTop: "1px solid var(--border)", background: "var(--surface-2)" }}>
        <p className="text-[10px]" style={{ color: "var(--text-muted)" }}>
          {lockTicks ? (
            <>
              All {items.length} schedule {items.length === 1 ? "item" : "items"} auto-included ·
              contributes{" "}
              <span className="font-semibold tabular-nums text-theme">{fmt(allSum.toString())}</span>
              {" "}to subledger
            </>
          ) : (
            <>
              {selectedCount} of {items.length} selected · contributes{" "}
              <span className="font-semibold tabular-nums text-theme">{fmt(selectedSum.toString())}</span>
              {" "}to subledger
            </>
          )}
        </p>
        {!lockTicks && selectedSum === allSum && items.length > 0 && (
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold"
            style={{ color: "var(--green)" }}>
            <CheckCircle2 size={10} strokeWidth={2.4} />
            All items selected
          </span>
        )}
      </div>
    </div>
  )
}
