/**
 * Reconciliation Detail Page.
 *
 * Per customer/vendor breakdown with:
 *   - Summary card (GL, subledger, difference)
 *   - Aging analysis
 *   - Unmatched / unapplied / duplicates / manual JEs (recon_transactions grouped)
 *   - AI commentary panel
 *   - Approve / request-review / add-notes / assign / export actions
 */
import { useEffect, useMemo, useState } from "react"
import { useParams, useNavigate, useSearchParams } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { motion, AnimatePresence } from "framer-motion"
import { formatDate } from "@/core/lib/dates"
import {
  ArrowLeft,
  CheckCircle2,
  AlertTriangle,
  Sparkles,
  Download,
  RefreshCw,
  MessageSquare,
  UserPlus,
  Send,
  ChevronRight,
  Trash2,
  Flag,
} from "lucide-react"
import { Button, Spinner } from "@/core/ui/components"
import { humanize } from "@/core/ui/utils"
import {
  reconsApi,
  type ReconciliationItem,
  type ReconTransaction,
  type ItemStatus,
} from "@/modules/recons/api"
import { useUser } from "@clerk/clerk-react"

const fmtMoney = (s: string | number) => {
  const n = typeof s === "string" ? parseFloat(s) : s
  const abs = `$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
  return n < 0 ? `(${abs})` : abs
}

const TXN_SECTIONS = [
  { key: "unmatched",      label: "Unmatched transactions" },
  { key: "unapplied_cash", label: "Unapplied cash" },
  { key: "duplicate",      label: "Duplicate invoice detection" },
  { key: "manual_je",      label: "Manual journal entries" },
] as const

export function ReconciliationDetail() {
  const { reconId } = useParams<{ reconId: string }>()
  const navigate    = useNavigate()
  const qc          = useQueryClient()
  const [params, setParams] = useSearchParams()
  const { user }    = useUser()

  const initialItemId = params.get("item")
  const [selectedItemId, setSelectedItemId] = useState<string | null>(initialItemId)
  const [noteDraft,   setNoteDraft]   = useState("")
  const [confirmDelete, setConfirmDelete] = useState(false)

  const { data: detail, isLoading } = useQuery({
    queryKey: ["recon-detail", reconId],
    queryFn:  () => reconsApi.getReconciliation(reconId!),
    enabled:  !!reconId,
    refetchInterval: (q) => {
      const d = q.state.data
      if (!d) return false
      return d.recon.status === "syncing" || d.recon.status === "computing" ? 5_000 : false
    },
  })

  // Default-select the first item when data arrives
  useEffect(() => {
    if (!detail) return
    if (!selectedItemId && detail.items[0]) {
      setSelectedItemId(detail.items[0].id)
    }
  }, [detail, selectedItemId])

  const selectedItem: ReconciliationItem | undefined = useMemo(() => {
    if (!detail || !selectedItemId) return undefined
    return detail.items.find(i => i.id === selectedItemId)
  }, [detail, selectedItemId])

  const txnsForItem = useMemo(() => {
    if (!detail || !selectedItem) return [] as ReconTransaction[]
    return detail.transactions.filter(t => t.reconciliation_item_id === selectedItem.id)
  }, [detail, selectedItem])

  const itemNotes = useMemo(() => {
    if (!detail || !selectedItem) return detail?.notes.filter(n => !n.reconciliation_item_id) ?? []
    return detail.notes.filter(n => n.reconciliation_item_id === selectedItem.id)
  }, [detail, selectedItem])

  // ── Mutations ──
  const resync = useMutation({
    mutationFn: () => reconsApi.resyncReconciliation(reconId!),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ["recon-detail", reconId] }),
  })
  const approveRecon = useMutation({
    mutationFn: () => reconsApi.approveReconciliation(reconId!),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ["recon-detail", reconId] }),
  })
  const setStatus = useMutation({
    mutationFn: ({ itemId, status }: { itemId: string; status: ItemStatus }) =>
      reconsApi.setItemStatus(reconId!, itemId, status),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ["recon-detail", reconId] }),
  })
  const regen = useMutation({
    mutationFn: (itemId: string) => reconsApi.explainItem(reconId!, itemId),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ["recon-detail", reconId] }),
  })
  // Recon-level AI summary, on-demand only.
  const explainSummary = useMutation({
    mutationFn: () => reconsApi.explainRecon(reconId!),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ["recon-detail", reconId] }),
  })
  const addNote = useMutation({
    mutationFn: () => reconsApi.addNote(reconId!, noteDraft, selectedItem?.id),
    onSuccess:  () => {
      setNoteDraft("")
      qc.invalidateQueries({ queryKey: ["recon-detail", reconId] })
    },
  })
  const assign = useMutation({
    mutationFn: (uid: string | null) => reconsApi.assignReconciliation(reconId!, uid),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ["recon-detail", reconId] }),
  })
  // Delete — invalidate the list so the deleted row vanishes when
  // the user arrives at the list, then navigate without `replace`
  // (so back-nav works naturally if they cancel via browser back).
  const del = useMutation({
    mutationFn: () => reconsApi.deleteReconciliation(reconId!),
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: ["reconciliations"] })
      qc.invalidateQueries({ queryKey: ["recons-overview"] })
      navigate("/app/reconciliations")
    },
  })

  if (isLoading || !detail) {
    return (
      <div className="flex items-center justify-center h-full" style={{ background: "var(--bg)" }}>
        <Spinner className="h-6 w-6" />
      </div>
    )
  }

  const { recon } = detail
  const entityLabel =
    recon.recon_type === "AP"   ? "Vendor"   :
    recon.recon_type === "AR"   ? "Customer" :
    recon.recon_type === "BANK" ? "Bank account" :
    recon.recon_type === "CC"   ? "Card"     :
    "Account"
  const periodLabel = formatDate(recon.period_end)

  return (
    <div className="flex flex-col h-full overflow-y-auto" style={{ background: "var(--bg)" }}>
      {/* Header */}
      <div className="px-4 sm:px-8 pt-5 pb-3 sticky top-0 z-10"
        style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => navigate(recon.recon_type === "AR" ? "/app/reconciliations/ar" :
                                    recon.recon_type === "AP" ? "/app/reconciliations/ap" :
                                    "/app/reconciliations")}
            className="text-xs flex items-center gap-1 transition-opacity hover:opacity-80"
            style={{ color: "var(--text-muted)" }}
          >
            <ArrowLeft size={12} strokeWidth={1.8} />
            Back to {recon.recon_type} list
          </button>
          <span style={{ color: "var(--border-strong)" }}>·</span>
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>{periodLabel}</span>
          <span style={{ color: "var(--border-strong)" }}>·</span>
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>{humanize(recon.status, { in_review: "In review" })}</span>

          <div className="ml-auto flex items-center gap-2 flex-wrap">
            <Button size="sm" variant="outline" icon={<RefreshCw size={12} strokeWidth={1.8} />}
              loading={resync.isPending} onClick={() => resync.mutate()}>Re-sync</Button>
            <Button size="sm" variant="outline" icon={<Download size={12} strokeWidth={1.8} />}
              onClick={() => reconsApi.exportReconciliation(recon.id, `${recon.name}.xlsx`)}>Export</Button>
            <Button size="sm" variant="outline" icon={<UserPlus size={12} strokeWidth={1.8} />}
              onClick={() => assign.mutate(user?.id ? user.id.replace(/^user_/, "") : null)}
              title="Assign to me (clears with another click)"
              loading={assign.isPending}
            >
              {recon.assigned_to ? "Unassign" : "Assign to me"}
            </Button>
            {!recon.approved_by && (
              <Button size="sm" icon={<CheckCircle2 size={12} strokeWidth={1.8} />}
                loading={approveRecon.isPending} onClick={() => approveRecon.mutate()}>
                Approve reconciliation
              </Button>
            )}
            <Button size="sm" variant="outline" icon={<Trash2 size={12} strokeWidth={1.8} />}
              onClick={() => confirmDelete ? del.mutate() : setConfirmDelete(true)}
              style={confirmDelete ? { borderColor: "#dc2626", color: "#dc2626" } : undefined}
            >
              {confirmDelete ? "Confirm delete?" : "Delete"}
            </Button>
          </div>
        </div>

        <h1 className="text-lg sm:text-2xl font-bold text-theme leading-tight mt-2">{recon.name}</h1>

        {/* Top-level totals */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-4">
          <SummaryTile label="GL Total" value={fmtMoney(recon.gl_total)} />
          <SummaryTile label="Subledger Total" value={fmtMoney(recon.subledger_total)} />
          <SummaryTile label="Net Difference" value={fmtMoney(recon.difference)}
            tone={Math.abs(parseFloat(recon.difference)) > 100 ? "#dc2626" : "var(--green)"} />
          <SummaryTile label="Entities" value={String(detail.items.length)} />
        </div>

        {recon.approved_by && recon.approved_at && (
          <p className="text-xs mt-3 flex items-center gap-1.5" style={{ color: "var(--green)" }}>
            <CheckCircle2 size={12} strokeWidth={2} />
            Approved on {new Date(recon.approved_at).toLocaleString()}
          </p>
        )}
        {recon.error_detail && (
          <p className="text-xs mt-2 flex items-start gap-1.5" style={{ color: "#dc2626" }}>
            <AlertTriangle size={12} strokeWidth={2} className="mt-0.5 shrink-0" />
            {recon.error_detail}
          </p>
        )}
      </div>

      <div className="flex-1 px-4 sm:px-8 py-6 max-w-7xl w-full mx-auto">
        {/* AI executive summary — on-demand, never auto-runs. */}
        <motion.div
          initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
          className="rounded-xl p-4 mb-5 flex items-start gap-3"
          style={{
            background: recon.ai_summary ? "var(--green-subtle)" : "var(--surface)",
            border: `1px solid ${recon.ai_summary ? "var(--green)" : "var(--border)"}`,
          }}
        >
          <Sparkles size={16} strokeWidth={1.8} style={{ color: "var(--green)" }} className="shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            {recon.ai_summary ? (
              <p className="text-sm leading-snug text-theme whitespace-pre-wrap">{recon.ai_summary}</p>
            ) : (
              <p className="text-sm" style={{ color: "var(--text-muted)" }}>
                No AI summary yet. Generate one whenever you want a controller-grade overview of this reconciliation.
              </p>
            )}
          </div>
          <Button
            size="sm"
            variant="outline"
            icon={<Sparkles size={12} strokeWidth={1.8} />}
            loading={explainSummary.isPending}
            onClick={() => explainSummary.mutate()}
          >
            {recon.ai_summary ? "Regenerate" : "Generate summary"}
          </Button>
        </motion.div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

          {/* ── Left: entity list ── */}
          <div className="lg:col-span-1">
            <div className="rounded-xl overflow-hidden"
              style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}
            >
              <div className="px-4 py-2.5" style={{ borderBottom: "1px solid var(--border)" }}>
                <h2 className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                  {entityLabel}s ({detail.items.length})
                </h2>
              </div>
              <ul className="max-h-[480px] overflow-y-auto">
                {detail.items.map((it) => (
                  <li key={it.id}>
                    <button
                      onClick={() => { setSelectedItemId(it.id); setParams({ item: it.id }) }}
                      className="w-full px-4 py-2.5 flex items-center gap-2 text-left transition-colors"
                      style={selectedItemId === it.id
                        ? { background: "var(--surface-2)", borderLeft: "3px solid var(--green)" }
                        : { borderLeft: "3px solid transparent" }}
                      onMouseEnter={(e) => { if (selectedItemId !== it.id) (e.currentTarget as HTMLElement).style.background = "var(--surface-2)" }}
                      onMouseLeave={(e) => { if (selectedItemId !== it.id) (e.currentTarget as HTMLElement).style.background = "" }}
                    >
                      <span className="h-1.5 w-1.5 rounded-full shrink-0"
                        style={{ background: it.risk_level === "high" ? "#dc2626" : it.risk_level === "medium" ? "#f59e0b" : "var(--green)" }}
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-theme truncate">{it.entity_name}</p>
                        <p className="text-[11px] tabular-nums" style={{ color: "var(--text-muted)" }}>
                          Diff {fmtMoney(it.difference)} · {it.risk_level}
                        </p>
                      </div>
                      {it.status === "approved" && <CheckCircle2 size={12} style={{ color: "var(--green)" }} />}
                      <ChevronRight size={12} strokeWidth={1.8} style={{ color: "var(--text-muted)" }} />
                    </button>
                  </li>
                ))}
                {detail.items.length === 0 && (
                  <li className="px-4 py-8 text-center text-sm" style={{ color: "var(--text-muted)" }}>
                    No items yet. {recon.status === "syncing" ? "Sync in progress…" : "Re-sync to pull data."}
                  </li>
                )}
              </ul>
            </div>
          </div>

          {/* ── Right: selected entity detail ── */}
          <div className="lg:col-span-2 space-y-5">
            <AnimatePresence mode="wait">
              {selectedItem && (
                <motion.div
                  key={selectedItem.id}
                  initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }}
                  transition={{ duration: 0.18 }}
                  className="space-y-5"
                >
                  {/* Customer/vendor summary */}
                  <div className="rounded-xl p-5"
                    style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}
                  >
                    <div className="flex items-start justify-between gap-2 flex-wrap">
                      <div className="min-w-0">
                        <h2 className="text-base font-semibold text-theme truncate">{selectedItem.entity_name}</h2>
                        <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
                          {entityLabel} · {selectedItem.risk_level} risk · {selectedItem.status}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <Button size="sm" variant="outline" icon={<Sparkles size={12} strokeWidth={1.8} />}
                          loading={regen.isPending && regen.variables === selectedItem.id}
                          onClick={() => regen.mutate(selectedItem.id)}
                        >
                          {selectedItem.ai_commentary ? "Regenerate AI" : "Generate AI commentary"}
                        </Button>
                        {selectedItem.status !== "approved" && (
                          <Button size="sm" icon={<CheckCircle2 size={12} strokeWidth={1.8} />}
                            loading={setStatus.isPending}
                            onClick={() => setStatus.mutate({ itemId: selectedItem.id, status: "approved" })}
                          >
                            Approve
                          </Button>
                        )}
                        {selectedItem.status !== "flagged" && (
                          <Button size="sm" variant="outline" icon={<Flag size={12} strokeWidth={1.8} />}
                            loading={setStatus.isPending}
                            onClick={() => setStatus.mutate({ itemId: selectedItem.id, status: "flagged" })}
                          >
                            Request review
                          </Button>
                        )}
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-4 mt-4">
                      <SummaryTile label="GL Balance"        value={fmtMoney(selectedItem.gl_balance)} />
                      <SummaryTile label="Subledger Balance" value={fmtMoney(selectedItem.subledger_balance)} />
                      <SummaryTile label="Variance"          value={fmtMoney(selectedItem.difference)}
                        tone={Math.abs(parseFloat(selectedItem.difference)) > 100 ? "#dc2626" : "var(--green)"} />
                    </div>

                    {selectedItem.approved_by && selectedItem.approved_at && (
                      <p className="text-[11px] mt-3 flex items-center gap-1.5" style={{ color: "var(--green)" }}>
                        <CheckCircle2 size={11} strokeWidth={2} />
                        Approved on {new Date(selectedItem.approved_at).toLocaleString()}
                      </p>
                    )}
                  </div>

                  {/* AI commentary panel */}
                  <div className="rounded-xl p-5"
                    style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}
                  >
                    <div className="flex items-center gap-2 mb-3">
                      <Sparkles size={14} strokeWidth={1.8} style={{ color: "var(--green)" }} />
                      <h3 className="text-sm font-semibold text-theme">AI Commentary</h3>
                    </div>
                    {selectedItem.ai_commentary ? (
                      <p className="text-sm leading-relaxed text-theme whitespace-pre-wrap">{selectedItem.ai_commentary}</p>
                    ) : (
                      <p className="text-sm italic" style={{ color: "var(--text-muted)" }}>
                        {recon.status === "syncing" || recon.status === "computing"
                          ? "AI commentary is being generated…"
                          : "No commentary yet — click 'Find reason' to have the AI analyze this entity."}
                      </p>
                    )}
                  </div>

                  {/* Aging breakdown */}
                  <div className="rounded-xl p-5"
                    style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}
                  >
                    <h3 className="text-sm font-semibold text-theme mb-3">Aging analysis</h3>
                    <div className="grid grid-cols-5 gap-2">
                      <AgingTile label="Current" v={selectedItem.aging_current} />
                      <AgingTile label="1-30"    v={selectedItem.aging_1_30} />
                      <AgingTile label="31-60"   v={selectedItem.aging_31_60} />
                      <AgingTile label="61-90"   v={selectedItem.aging_61_90} tone="#92400e" />
                      <AgingTile label="> 90"    v={selectedItem.aging_over_90} tone="#dc2626" />
                    </div>
                  </div>

                  {/* Evidence sections (unmatched / unapplied / duplicates / JEs) */}
                  {TXN_SECTIONS.map((section) => {
                    const rows = txnsForItem.filter(t => t.category === section.key)
                    if (rows.length === 0) return null
                    return (
                      <div key={section.key} className="rounded-xl overflow-hidden"
                        style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}
                      >
                        <div className="px-5 py-2.5 flex items-center gap-2"
                          style={{ borderBottom: "1px solid var(--border)" }}>
                          <h3 className="text-sm font-semibold text-theme">{section.label}</h3>
                          <span className="text-xs" style={{ color: "var(--text-muted)" }}>({rows.length})</span>
                        </div>
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                              <th className="text-left px-5 py-2">Type</th>
                              <th className="text-left px-3 py-2">Number</th>
                              <th className="text-left px-3 py-2">Date</th>
                              <th className="text-right px-3 py-2">Amount</th>
                              <th className="text-left px-5 py-2">Memo</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map((t) => (
                              <tr key={t.id} style={{ borderTop: "1px solid var(--border)" }}>
                                <td className="px-5 py-2 text-xs">{t.txn_type}</td>
                                <td className="px-3 py-2 text-xs font-mono">{t.txn_number || "—"}</td>
                                <td className="px-3 py-2 text-xs">{t.txn_date || "—"}</td>
                                <td className="px-3 py-2 text-xs tabular-nums text-right">{fmtMoney(t.amount)}</td>
                                <td className="px-5 py-2 text-xs truncate max-w-[260px]" title={t.memo ?? ""}>{t.memo ?? "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )
                  })}

                  {/* Notes */}
                  <div className="rounded-xl p-5"
                    style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}
                  >
                    <div className="flex items-center gap-2 mb-3">
                      <MessageSquare size={14} strokeWidth={1.8} style={{ color: "var(--text-muted)" }} />
                      <h3 className="text-sm font-semibold text-theme">Notes for this {entityLabel.toLowerCase()}</h3>
                    </div>
                    <ul className="space-y-2 mb-3">
                      {itemNotes.map((n) => (
                        <li key={n.id} className="rounded-md p-2.5"
                          style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
                          <p className="text-xs whitespace-pre-wrap text-theme">{n.body}</p>
                          <p className="text-[10px] mt-1" style={{ color: "var(--text-muted)" }}>
                            {new Date(n.created_at).toLocaleString()}
                          </p>
                        </li>
                      ))}
                      {itemNotes.length === 0 && (
                        <p className="text-xs italic" style={{ color: "var(--text-muted)" }}>No notes yet.</p>
                      )}
                    </ul>
                    <div className="flex items-center gap-2">
                      <input
                        value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)}
                        placeholder="Add a note…"
                        onKeyDown={(e) => { if (e.key === "Enter" && noteDraft.trim()) addNote.mutate() }}
                        className="flex-1 rounded-lg px-3 py-2 text-sm outline-none"
                        style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }}
                      />
                      <Button size="sm" icon={<Send size={12} strokeWidth={1.8} />}
                        disabled={!noteDraft.trim()} loading={addNote.isPending}
                        onClick={() => addNote.mutate()}
                      >
                        Add note
                      </Button>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Tiles ─────────────────────────────────────────────────────────────────────

function SummaryTile({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg px-3 py-2.5"
      style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
      <p className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>{label}</p>
      <p className="text-base font-bold tabular-nums mt-0.5" style={{ color: tone ?? "var(--text)" }}>{value}</p>
    </div>
  )
}

function AgingTile({ label, v, tone }: { label: string; v: string; tone?: string }) {
  const n = parseFloat(v)
  return (
    <div className="rounded-lg px-2 py-2 text-center"
      style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
      <p className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>{label}</p>
      <p className="text-sm font-semibold tabular-nums mt-0.5"
        style={{ color: tone && n > 0 ? tone : "var(--text)" }}>
        {n > 0 ? fmtMoney(v) : "—"}
      </p>
    </div>
  )
}
