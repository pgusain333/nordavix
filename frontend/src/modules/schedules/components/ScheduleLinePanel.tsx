/**
 * ScheduleLinePanel — generic suggestion panel reused by Fixed Assets,
 * Leases, and Loans. Same shape as the per-type panels for Prepaids
 * and Accruals (delta line items, tri-state bulk select, gated on
 * committed snapshot) — just parameterised so we don't ship three
 * near-identical files.
 *
 * The parent (InlineSubledgerForm) owns selectedItemMap and emits
 * toggle/bulk-set callbacks. Each fetched line becomes a synthetic
 * ReconcilingItem with a stable txn_id derived from item_id + line_kind.
 */
import { useQuery } from "@tanstack/react-query"
import {
  AlertCircle,
  Building2,
  Home,
  Banknote,
  ExternalLink,
  Minus,
  Plus,
} from "lucide-react"
import { Link } from "react-router-dom"

import { Spinner } from "@/core/ui/components"
import { schedulesApi, type ScheduleLineSuggestion, type ScheduleSuggestionsResponse } from "@/modules/schedules/api"
import { BulkSelectCheckbox } from "@/modules/schedules/components/BulkSelectCheckbox"

type ScheduleKind = "fixed_asset" | "lease" | "loan"

interface Props {
  scheduleKind: ScheduleKind
  qboAccountId: string
  periodEnd:    string
  selectedIds:  Set<string>
  onToggle:     (suggestion: ScheduleLineSuggestion, scheduleKind: ScheduleKind, nextChecked: boolean) => void
  onBulkSet:    (suggestions: ScheduleLineSuggestion[], scheduleKind: ScheduleKind, nextChecked: boolean) => void
  readOnly?:    boolean
  /** When true, schedule lines are auto-included as reconciling items
   *  by the parent — checkboxes render disabled + checked, the bulk
   *  selector hides, and the header copy switches to "auto-included". */
  autoIncluded?: boolean
}

const CHROME: Record<ScheduleKind, {
  human:       string
  icon:        React.ReactNode
  accent:      string
  fetcher:     (q: string, p: string) => Promise<ScheduleSuggestionsResponse>
  detailRoute: string
  uncommitted_blurb: string
}> = {
  fixed_asset: {
    human:       "Suggested from Fixed Assets schedule",
    icon:        <Building2 size={13} strokeWidth={1.8} style={{ color: "#15803d" }} />,
    accent:      "rgba(21, 128, 61, 0.12)",
    fetcher:     schedulesApi.getFixedAssetSuggestions,
    detailRoute: "/app/schedules/fixed-assets",
    uncommitted_blurb: "fixed asset",
  },
  lease: {
    human:       "Suggested from Leases schedule",
    icon:        <Home size={13} strokeWidth={1.8} style={{ color: "#7c3aed" }} />,
    accent:      "rgba(124, 58, 237, 0.10)",
    fetcher:     schedulesApi.getLeaseSuggestions,
    detailRoute: "/app/schedules/leases",
    uncommitted_blurb: "lease",
  },
  loan: {
    human:       "Suggested from Loans schedule",
    icon:        <Banknote size={13} strokeWidth={1.8} style={{ color: "#be123c" }} />,
    accent:      "rgba(190, 18, 60, 0.10)",
    fetcher:     schedulesApi.getLoanSuggestions,
    detailRoute: "/app/schedules/loans",
    uncommitted_blurb: "loan",
  },
}

/** Stable txn_id matching the parent's selectedItemMap key. */
export function lineTxnId(kind: ScheduleKind, suggestion: ScheduleLineSuggestion): string {
  return `schedule-${kind}-${suggestion.item_id}-${suggestion.line_kind}`
}

function fmt(s: string): string {
  const n = parseFloat(s) || 0
  const abs = `$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  return n < 0 ? `(${abs})` : abs
}

function kindBadge(kind: string): { label: string; bg: string; fg: string; icon: React.ReactNode } {
  switch (kind) {
    case "addition":          return { label: "Addition",          bg: "rgba(21,128,61,0.12)",  fg: "#15803d", icon: <Plus  size={10} strokeWidth={2.4} /> }
    case "disposal":          return { label: "Disposal",          bg: "rgba(190,18,60,0.12)",  fg: "#be123c", icon: <Minus size={10} strokeWidth={2.4} /> }
    case "depreciation":      return { label: "Depreciation",      bg: "rgba(245,158,11,0.12)", fg: "#b45309", icon: <Minus size={10} strokeWidth={2.4} /> }
    case "initial":           return { label: "Initial recognition", bg: "rgba(124,58,237,0.12)", fg: "#7c3aed", icon: <Plus  size={10} strokeWidth={2.4} /> }
    case "origination":       return { label: "Origination",       bg: "rgba(190,18,60,0.12)",  fg: "#be123c", icon: <Plus  size={10} strokeWidth={2.4} /> }
    case "principal_payment": return { label: "Principal payment", bg: "rgba(29,78,216,0.12)",  fg: "#1d4ed8", icon: <Minus size={10} strokeWidth={2.4} /> }
    default: return { label: kind, bg: "var(--surface-2)", fg: "var(--text-muted)", icon: null }
  }
}

export function ScheduleLinePanel({
  scheduleKind, qboAccountId, periodEnd, selectedIds, onToggle, onBulkSet, readOnly, autoIncluded,
}: Props) {
  const chrome = CHROME[scheduleKind]
  const lockTicks = !!autoIncluded

  const { data, isLoading } = useQuery({
    queryKey: ["schedules", scheduleKind, "suggestions", qboAccountId, periodEnd],
    queryFn:  () => chrome.fetcher(qboAccountId, periodEnd),
    staleTime: 60_000,
  })

  if (isLoading) {
    return (
      <div className="rounded-md px-3 py-2 mb-3 text-[11px] flex items-center gap-2"
        style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}>
        <Spinner className="h-3 w-3" />
        Checking {chrome.uncommitted_blurb}s schedule…
      </div>
    )
  }

  const items = data?.items ?? []
  if (items.length === 0 && !data?.has_uncommitted) return null

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
          You have {chrome.uncommitted_blurb}s mapped to this account but the snapshot
          for <span className="font-semibold">{periodEnd}</span> isn't committed yet.{" "}
          <Link to={chrome.detailRoute}
            className="font-semibold underline"
            target="_blank" rel="noopener noreferrer">
            Open the schedule
          </Link>{" "}
          and click <span className="font-semibold">Commit snapshot</span> to surface
          this period's lines here.
        </span>
      </div>
    )
  }

  const selectedSum = items
    .filter((it) => selectedIds.has(lineTxnId(scheduleKind, it)))
    .reduce((s, it) => s + (parseFloat(it.amount) || 0), 0)
  const selectedCount = items.filter((it) => selectedIds.has(lineTxnId(scheduleKind, it))).length

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
              total={items.length}
              selected={selectedCount}
              disabled={readOnly}
              onChange={(nextChecked) => onBulkSet(items, scheduleKind, nextChecked)}
              title={`Select / clear all ${chrome.uncommitted_blurb} lines in this period`}
            />
          )}
          {chrome.icon}
          <p className="text-[11px] font-semibold text-theme">
            {lockTicks ? `From ${chrome.uncommitted_blurb}s schedule (auto-included)` : chrome.human}
          </p>
          <span className="text-[10px] px-1.5 py-0.5 rounded"
            style={{ background: chrome.accent, color: "var(--text-2)" }}>
            {items.length} line{items.length === 1 ? "" : "s"} · delta-based
          </span>
          {lockTicks && (
            <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
              style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
              Subledger source
            </span>
          )}
        </div>
        <Link to={chrome.detailRoute} target="_blank" rel="noopener noreferrer"
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
              const id = lineTxnId(scheduleKind, it)
              const checked = selectedIds.has(id)
              const badge = kindBadge(it.line_kind)
              const v = parseFloat(it.amount) || 0
              return (
                <tr key={id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td className="py-2 pr-1">
                    <input
                      type="checkbox"
                      checked={checked || lockTicks}
                      disabled={readOnly || lockTicks}
                      onChange={(e) => onToggle(it, scheduleKind, e.target.checked)}
                      className="h-3.5 w-3.5 rounded"
                      style={{
                        accentColor: "var(--green)",
                        cursor: lockTicks ? "default" : "pointer",
                      }}
                      title={lockTicks
                        ? `Auto-included from the ${chrome.uncommitted_blurb}s schedule — this is the authoritative subledger source for this account`
                        : undefined}
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
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded"
                      style={{ background: badge.bg, color: badge.fg }}>
                      {badge.icon}
                      {badge.label}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-[11px]" style={{ color: "var(--text-2)" }}>
                    {it.line_date}
                  </td>
                  <td className="py-2 text-right tabular-nums font-semibold"
                    style={{ color: v >= 0 ? "var(--green)" : "#b91c1c" }}>
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
