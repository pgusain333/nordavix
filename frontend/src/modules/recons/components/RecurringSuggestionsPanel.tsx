/**
 * "Recurring (from memory)" — confirmed recurring reconciling items Nordavix has
 * learned for this account, offered as toggleable suggestions in the reconcile
 * view (Client Memory · Slice C). Mirrors the schedule-suggestion panels: each
 * toggle add/removes a reconciling item from the shared selectedItemMap.
 *
 * Suggest-only by design — toggling adds an editable item the preparer still
 * confirms; memory never auto-adds a reconciling item (an item reduces the
 * GL↔subledger difference, so auto-adding could make a recon falsely tie).
 * Renders nothing until a reviewer has confirmed at least one recurring item.
 */
import { useQuery } from "@tanstack/react-query"
import { useOrganization } from "@clerk/clerk-react"
import { Repeat, Check, Plus } from "lucide-react"
import { reconsApi, type RecurringSuggestion } from "@/modules/recons/api"

function fmtUsd(s: string | null): string {
  if (s == null || s === "") return "—"
  const n = Number(s)
  if (Number.isNaN(n)) return "—"
  const abs = `$${Math.abs(Math.round(n)).toLocaleString()}`
  return n < 0 ? `(${abs})` : abs
}

export function RecurringSuggestionsPanel({
  qboAccountId, periodEnd, selectedIds, readOnly, onToggle,
}: {
  qboAccountId: string
  periodEnd:    string
  selectedIds:  Set<string>
  readOnly:     boolean
  onToggle:     (s: RecurringSuggestion, nextChecked: boolean) => void
}) {
  const { organization } = useOrganization()
  const { data } = useQuery({
    queryKey: ["recons", "recurring-suggestions", qboAccountId, periodEnd],
    queryFn:  () => reconsApi.getRecurringSuggestions(qboAccountId, periodEnd),
    enabled:  !!organization && !!qboAccountId && !!periodEnd,
    staleTime: 60_000,
  })

  const items = data ?? []
  if (items.length === 0) return null

  return (
    <div className="rounded-lg mb-3" style={{ border: "1px solid var(--border)", background: "var(--surface)" }}>
      <div className="flex items-center gap-1.5 px-3 py-2" style={{ borderBottom: "1px solid var(--border)" }}>
        <Repeat size={13} strokeWidth={2} style={{ color: "var(--green)" }} />
        <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--green)" }}>
          Recurring (from memory)
        </p>
      </div>
      <ul>
        {items.map((s) => {
          const id = `manual-recurring-${s.fact_id}`
          const added = selectedIds.has(id)
          return (
            <li key={s.fact_id}
              className="flex items-center gap-2 px-3 py-2 text-[12px]"
              style={{ borderTop: "1px solid var(--border)" }}>
              <div className="min-w-0 flex-1">
                <p className="font-medium text-theme truncate">{s.label}</p>
                <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                  {s.txn_type}
                  {s.expected_amount ? ` · ≈ ${fmtUsd(s.expected_amount)} typical` : ""}
                  {s.entity ? ` · ${s.entity}` : ""}
                </p>
              </div>
              {added ? (
                <button type="button" disabled={readOnly}
                  onClick={() => onToggle(s, false)}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold disabled:opacity-50"
                  style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
                  <Check size={12} strokeWidth={2.4} /> Added
                </button>
              ) : (
                <button type="button" disabled={readOnly}
                  onClick={() => onToggle(s, true)}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold disabled:opacity-50 hover:bg-[var(--surface-2)]"
                  style={{ border: "1px solid var(--border-strong)", color: "var(--text-2)" }}>
                  <Plus size={12} strokeWidth={2.4} /> Add
                </button>
              )}
            </li>
          )
        })}
      </ul>
      <p className="px-3 py-2 text-[10px]" style={{ color: "var(--text-muted)", borderTop: "1px dashed var(--border)" }}>
        Added as an editable manual item — confirm the amount for this period before you mark prepared.
      </p>
    </div>
  )
}
