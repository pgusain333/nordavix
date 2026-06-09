/**
 * AdjustmentsPage — the consolidated review queue for AI-proposed journal
 * entries. The same proposals shown inline (bank worksheet, recon drawer,
 * flux variance) gathered in one place so a reviewer can do a final
 * pre-close sweep and batch-approve. Reads the shared ["adjustments"] cache;
 * acting here updates the inline surfaces too.
 *
 * Inline is the primary flow (act in context, no navigation); this is the
 * optional roll-up — a controller's worklist of everything the AI drafted.
 */
import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Sparkles, CheckCheck, FileText } from "lucide-react"

import { Spinner } from "@/core/ui/components"
import { formatDate } from "@/core/lib/dates"
import { workspaceApi } from "@/modules/workspace/api"
import { adjustmentsApi, type AdjustmentStatus, type ProposedEntry } from "../api"
import { ProposedEntryCard } from "../components/ProposedEntryCard"

const SOURCE_META: Record<string, { label: string; hint: string }> = {
  bank:  { label: "Bank reconciliation", hint: "Fees, interest, and other bank-only items" },
  recon: { label: "Reconciliations",     hint: "Corrections from account reconciliation review" },
  flux:  { label: "Flux analysis",       hint: "Adjustments surfaced by variance analysis" },
}
const SOURCE_ORDER = ["bank", "recon", "flux"] as const

const STATUS_TABS: { key: AdjustmentStatus | "all"; label: string }[] = [
  { key: "open",      label: "Open" },
  { key: "accepted",  label: "Approved" },
  { key: "posted",    label: "Posted" },
  { key: "dismissed", label: "Dismissed" },
  { key: "all",       label: "All" },
]

export function AdjustmentsPage() {
  const qc = useQueryClient()
  const [status, setStatus] = useState<AdjustmentStatus | "all">("open")

  const { data: me } = useQuery({
    queryKey: ["workspace-me"],
    queryFn:  workspaceApi.getMe,
    staleTime: 60_000,
  })
  const canReview = me?.role === "admin" || me?.role === "reviewer"

  // Fetch the full set once (all statuses, all periods) — drives both the
  // tab counts and the filtered view, so switching tabs is instant.
  const { data, isLoading } = useQuery({
    queryKey: ["adjustments", "queue"],
    queryFn:  () => adjustmentsApi.list({}),
    staleTime: 15_000,
  })
  const all: ProposedEntry[] = data?.items ?? []

  const counts = useMemo(() => {
    const c: Record<string, number> = { open: 0, accepted: 0, posted: 0, dismissed: 0, all: all.length }
    for (const e of all) c[e.status] = (c[e.status] ?? 0) + 1
    return c
  }, [all])

  const visible = useMemo(
    () => (status === "all" ? all : all.filter((e) => e.status === status)),
    [all, status],
  )

  const grouped = useMemo(() => {
    const g: Record<string, ProposedEntry[]> = { bank: [], recon: [], flux: [] }
    for (const e of visible) (g[e.source] ??= []).push(e)
    return g
  }, [visible])

  const openVisible = visible.filter((e) => e.status === "open")

  const batchApprove = useMutation({
    mutationFn: async () => {
      // Sequential to keep audit ordering deterministic; the set is small.
      for (const e of openVisible) {
        try { await adjustmentsApi.accept(e.id) } catch { /* skip closed/locked */ }
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["adjustments"] }),
  })

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Header */}
      <div className="px-4 sm:px-8 py-5 shrink-0"
        style={{ borderBottom: "1px solid var(--border)", background: "var(--surface)" }}>
        <div className="max-w-5xl mx-auto w-full">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex items-center justify-center h-8 w-8 rounded-lg"
              style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
              <Sparkles size={16} strokeWidth={2} />
            </span>
            <div>
              <h1 className="text-lg font-semibold text-theme leading-tight">Adjustments</h1>
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                AI-drafted journal entries to review, then copy into QuickBooks. Nordavix never posts for you.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 px-4 sm:px-8 py-5 max-w-5xl w-full mx-auto space-y-5">
        {/* Status tabs + batch approve */}
        <div className="flex items-center gap-2 flex-wrap">
          {STATUS_TABS.map((t) => {
            const active = status === t.key
            return (
              <button
                key={t.key}
                onClick={() => setStatus(t.key)}
                className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-all"
                style={{
                  background: active ? "var(--green-subtle)" : "var(--surface)",
                  color:      active ? "var(--green)" : "var(--text-muted)",
                  border:     `1px solid ${active ? "transparent" : "var(--border)"}`,
                }}
              >
                {t.label}
                <span className="text-[10px] opacity-70 tabular-nums">{counts[t.key] ?? 0}</span>
              </button>
            )
          })}

          {canReview && openVisible.length > 0 && (
            <button
              onClick={() => batchApprove.mutate()}
              disabled={batchApprove.isPending}
              className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-colors disabled:opacity-50"
              style={{ background: "var(--green)", color: "white" }}
            >
              <CheckCheck size={13} strokeWidth={2.4} />
              {batchApprove.isPending ? "Approving…" : `Approve all (${openVisible.length})`}
            </button>
          )}
        </div>

        {/* Body */}
        {isLoading ? (
          <div className="py-16 flex items-center justify-center"><Spinner className="h-6 w-6" /></div>
        ) : visible.length === 0 ? (
          <div className="rounded-xl p-12 text-center"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
            <FileText size={26} strokeWidth={1.5} style={{ color: "var(--text-muted)" }} className="mx-auto mb-3" />
            <p className="text-base font-semibold text-theme mb-1">
              {status === "open" ? "No proposed entries to review" : "Nothing here"}
            </p>
            <p className="text-sm max-w-md mx-auto" style={{ color: "var(--text-muted)" }}>
              Proposed entries appear as you reconcile bank accounts and run AI on reconciliations
              and flux variances. They'll show up here and inline on each surface.
            </p>
          </div>
        ) : (
          SOURCE_ORDER.map((src) => {
            const group = grouped[src] ?? []
            if (group.length === 0) return null
            const meta = SOURCE_META[src]
            return (
              <div key={src} className="space-y-2.5">
                <div className="flex items-baseline gap-2">
                  <h2 className="text-sm font-semibold text-theme">{meta.label}</h2>
                  <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                    {group.length} {group.length === 1 ? "entry" : "entries"} · {meta.hint}
                  </span>
                </div>
                <div className="space-y-3">
                  {group.map((e) => (
                    <div key={e.id}>
                      <div className="flex items-center gap-1.5 mb-1 text-[10px] uppercase tracking-wide"
                        style={{ color: "var(--text-muted)" }}>
                        <span>Period {formatDate(e.period_end)}</span>
                      </div>
                      <ProposedEntryCard entry={e} canReview={canReview} />
                    </div>
                  ))}
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
