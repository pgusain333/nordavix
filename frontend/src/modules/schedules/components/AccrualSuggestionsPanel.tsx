/**
 * AccrualSuggestionsPanel — slotted into the recon's inline accordion
 * for accrued liability accounts.
 *
 * Each row is a DELTA — positive for an accrual entry (added this
 * period), negative for a reversal (cleared this period). Selecting a
 * row adds the signed amount to the recon's existing build-up sum via
 * the shared selectedItemMap, so the recon math handles the lifecycle
 * naturally:
 *
 *   Month X  : accrual booked    → +amount selected → SL goes up
 *   Month X+1: reversal lands    → −amount selected → SL goes back down
 *
 * Carrier rows (accrued earlier, still outstanding, not changing this
 * period) are not emitted — they're already in the rolled-forward
 * opening balance.
 *
 * Renders nothing if there are no lines for this (account, period).
 */
import { useQuery } from "@tanstack/react-query"
import {
  AlertCircle,
  ClipboardList,
  ExternalLink,
  Minus,
  Plus,
} from "lucide-react"
import { Link } from "react-router-dom"

import { Spinner } from "@/core/ui/components"
import { schedulesApi, type AccrualSuggestion } from "@/modules/schedules/api"
import { BulkSelectCheckbox } from "@/modules/schedules/components/BulkSelectCheckbox"

interface Props {
  qboAccountId: string
  periodEnd:    string
  /** txn_ids currently in the parent's selectedItemMap. */
  selectedIds:  Set<string>
  /** Fired per row toggle; parent owns the state. */
  onToggle:     (suggestion: AccrualSuggestion, nextChecked: boolean) => void
  /** Bulk select / clear all rows in this panel. */
  onBulkSet:    (suggestions: AccrualSuggestion[], nextChecked: boolean) => void
  readOnly?:    boolean
}

/** Stable synthetic txn_id mirroring the parent's storage key. */
export function accrualTxnId(suggestion: AccrualSuggestion): string {
  return `schedule-accrual-${suggestion.item_id}-${suggestion.line_kind}`
}

function fmt(s: string): string {
  const n = parseFloat(s) || 0
  const abs = `$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  return n < 0 ? `(${abs})` : abs
}

export function AccrualSuggestionsPanel({
  qboAccountId, periodEnd, selectedIds, onToggle, onBulkSet, readOnly,
}: Props) {
  const { data, isLoading } = useQuery({
    queryKey: ["schedules", "accrual", "suggestions", qboAccountId, periodEnd],
    queryFn:  () => schedulesApi.getAccrualSuggestions(qboAccountId, periodEnd),
    staleTime: 60_000,
  })

  if (isLoading) {
    return (
      <div className="rounded-md px-3 py-2 mb-3 text-[11px] flex items-center gap-2"
        style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}>
        <Spinner className="h-3 w-3" />
        Checking Accruals schedule…
      </div>
    )
  }

  const items = data?.items ?? []

  // No deltas and no uncommitted hint → render nothing.
  if (items.length === 0 && !data?.has_uncommitted) return null

  if (items.length === 0 && data?.has_uncommitted) {
    return (
      <div className="rounded-lg mb-3 px-3 py-2 flex items-center gap-2 text-[11px]"
        style={{
          background: "rgba(199, 154, 82, 0.10)",
          border: "1px solid rgba(199, 154, 82, 0.40)",
          color: "#7a5622",
        }}>
        <AlertCircle size={12} strokeWidth={2} />
        <span>
          You have accruals mapped to this account but the snapshot for{" "}
          <span className="font-semibold">{periodEnd}</span> isn't committed yet.{" "}
          <Link to="/app/schedules/accruals"
            className="font-semibold underline"
            target="_blank" rel="noopener noreferrer">
            Open the Accruals schedule
          </Link>{" "}
          and click <span className="font-semibold">Commit snapshot</span> to surface
          this period's accrual / reversal entries here.
        </span>
      </div>
    )
  }

  const selectedSum = items
    .filter((it) => selectedIds.has(accrualTxnId(it)))
    .reduce((s, it) => s + (parseFloat(it.amount) || 0), 0)
  const selectedCount = items.filter((it) => selectedIds.has(accrualTxnId(it))).length

  return (
    <div className="rounded-lg mb-3 overflow-hidden"
      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <div className="px-3 py-2 flex items-center justify-between gap-2 flex-wrap"
        style={{
          background: "var(--surface-2)",
          borderBottom: "1px solid var(--border)",
        }}>
        <div className="flex items-center gap-2 min-w-0">
          <BulkSelectCheckbox
            total={items.length}
            selected={selectedCount}
            disabled={readOnly}
            onChange={(nextChecked) => onBulkSet(items, nextChecked)}
            title="Select / clear all accrual + reversal lines in this period"
          />
          <ClipboardList size={13} strokeWidth={1.8} style={{ color: "#8a6326" }} />
          <p className="text-[11px] font-semibold text-theme">
            Suggested from Accruals schedule
          </p>
          <span className="text-[10px] px-1.5 py-0.5 rounded"
            style={{ background: "rgba(199, 154, 82, 0.15)", color: "#8a6326" }}>
            {items.length} line{items.length === 1 ? "" : "s"} · delta-based
          </span>
        </div>
        <Link to="/app/schedules/accruals" target="_blank" rel="noopener noreferrer"
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
                style={{ color: "var(--text-muted)" }}>Kind</th>
              <th className="text-left py-1.5 font-semibold text-[10px] uppercase tracking-wider"
                style={{ color: "var(--text-muted)" }}>Date</th>
              <th className="text-right py-1.5 font-semibold text-[10px] uppercase tracking-wider"
                style={{ color: "var(--text-muted)" }}>Delta
                <div className="text-[9px] font-normal normal-case" style={{ color: "var(--text-muted)" }}>
                  (signed)
                </div>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => {
              const id = accrualTxnId(it)
              const checked = selectedIds.has(id)
              const isAccrual = it.line_kind === "accrual"
              return (
                <tr key={id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td className="py-2 pr-1">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={readOnly}
                      onChange={(e) => onToggle(it, e.target.checked)}
                      className="h-3.5 w-3.5 rounded"
                      style={{ accentColor: "var(--green)", cursor: "pointer" }}
                      title={isAccrual
                        ? "Include the accrual booking in SL"
                        : "Include the reversal in SL (clears the liability)"}
                    />
                  </td>
                  <td className="py-2 pr-3">
                    <div className="text-theme font-medium">{it.description}</div>
                    <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                      {it.vendor || "—"}
                      {it.reference && <span> · {it.reference}</span>}
                    </div>
                  </td>
                  <td className="py-2 pr-3">
                    {isAccrual ? (
                      <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded"
                        style={{ background: "rgba(199, 154, 82, 0.15)", color: "#8a6326" }}>
                        <Plus size={10} strokeWidth={2.4} />
                        Accrual
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded"
                        style={{ background: "rgba(60, 90, 118, 0.15)", color: "#3c5a76" }}>
                        <Minus size={10} strokeWidth={2.4} />
                        Reversal
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-[11px]" style={{ color: "var(--text-2)" }}>
                    {it.line_date}
                  </td>
                  <td className="py-2 text-right tabular-nums font-semibold"
                    style={{ color: isAccrual ? "#8a6326" : "#3c5a76" }}>
                    {fmt(it.amount)}
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
          {selectedCount} of {items.length} selected · net delta{" "}
          <span className="font-semibold tabular-nums text-theme">{fmt(selectedSum.toString())}</span>
        </p>
      </div>
    </div>
  )
}
