/**
 * FluxDashboard — main Flux Analysis workspace.
 *
 * Layout:
 *   Left panel (240px, desktop only): list of analyses + "New Analysis" button
 *   Right panel (flex-1):             UploadFlow wizard OR VarianceTable
 *
 * Mobile: right panel is always the primary view.
 *         A "History" overlay button slides in the analyses list.
 *
 * State machine for the right panel:
 *   no selection           → UploadFlow (new analysis)
 *   status = pending       → UploadFlow
 *   status = processing    → processing spinner
 *   status = generating    → generating spinner
 *   status = parsed | ready_for_review | complete  → VarianceTable
 *   status = error         → error state
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { useParams, useNavigate, useSearchParams } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { motion, AnimatePresence } from "framer-motion"
import { formatDate, formatDateLong } from "@/core/lib/dates"
import {
  Plus,
  AlertCircle,
  RefreshCw,
  Download,
  X,
  RotateCcw,
  Trash2,
  Sparkles,
  CheckCircle2,
  Upload,
  ArrowLeft,
  Lock,
  Unlock,
} from "lucide-react"
import { api, type TrialBalance } from "@/modules/flux/api"
import { useQboConnection } from "@/modules/flux/hooks"
import { UploadFlow } from "@/modules/flux/components/UploadFlow"
import { VarianceTable } from "@/modules/flux/components/VarianceTable"
import { DatePicker } from "@/core/ui/DatePicker"
import { Button, Spinner } from "@/core/ui/components"
import { AgenticRunningOverlay } from "@/modules/recons/components/AgenticRunningOverlay"
import { reconsApi } from "@/modules/recons/api"
import { workspaceApi } from "@/modules/workspace/api"
import { useUserNames } from "@/modules/workspace/hooks"
import type { VarianceRow } from "@/modules/flux/api"

// ── Status dot colours (inline styles — no Tailwind bg-* needed) ────────────

const STATUS_DOT: Record<string, string> = {
  pending:          "var(--border-strong)",
  processing:       "#f59e0b",
  parsed:           "#3b82f6",
  ready_for_review: "#3b82f6",
  generating:       "#f59e0b",
  complete:         "var(--green)",
  error:            "#dc2626",
}

const STATUS_LABELS: Record<string, string> = {
  pending:          "Pending",
  processing:       "Processing",
  parsed:           "Ready",
  ready_for_review: "In Review",
  generating:       "AI Running",
  complete:         "Complete",
  error:            "Error",
}

// ── Framer Motion variants ────────────────────────────────────────────────────

const panelVariants = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.22, ease: "easeOut" as const } },
  exit:    { opacity: 0, y: -10, transition: { duration: 0.15, ease: "easeIn" as const } },
}

// ── Component ─────────────────────────────────────────────────────────────────

export function FluxDashboard() {
  const { tbId }   = useParams<{ tbId?: string }>()
  const navigate   = useNavigate()
  const qc         = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()

  /** Two-step confirm for destructive actions: null | "reset" | "delete" */
  const [pendingAction, setPendingAction] = useState<"reset" | "delete" | null>(null)

  /** Transient banner shown after Find-reasons runs ("Queued X analyses…") */
  const [runMsg, setRunMsg] = useState<{ kind: "ok" | "info" | "err"; text: string } | null>(null)

  // KPI sticky-on-scroll — exact same pattern as the Reconciliations
  // dashboard. Once the user scrolls past ~140px the 4-card grid
  // collapses into a single compact horizontal bar that stays pinned
  // to the top while they review the variance table. AnimatePresence
  // mode="wait" handles the fade-and-slide between the two layouts so
  // the swap feels smooth rather than abrupt.
  const pageScrollRef = useRef<HTMLDivElement>(null)
  const [isKpiCompact, setIsKpiCompact] = useState(false)
  useEffect(() => {
    const el = pageScrollRef.current
    if (!el) return
    const handler = () => setIsKpiCompact(el.scrollTop > 140)
    el.addEventListener("scroll", handler, { passive: true })
    return () => el.removeEventListener("scroll", handler)
  }, [tbId])  // re-bind when navigating between analyses (ref may swap)

  // List of all TBs — only auto-refresh while one is mid-processing.
  // Idle list re-fetches on mount / explicit invalidation only.
  const { data: tbs = [], isLoading: tbsLoading } = useQuery({
    queryKey: ["trial-balances"],
    queryFn:  api.listTrialBalances,
    staleTime: 30_000,
    refetchInterval: (q) => {
      const list = q.state.data
      if (!list) return false
      return list.some(t => t.status === "processing" || t.status === "generating") ? 5_000 : false
    },
  })

  // Currently selected TB
  const selectedTb = tbs.find((t) => t.id === tbId) ?? null

  // Variances for selected TB (only when it has data)
  const shouldFetchVariances = selectedTb &&
    ["parsed", "ready_for_review", "generating", "complete"].includes(selectedTb.status)

  const { data: variances = [], isLoading: variancesLoading } = useQuery({
    queryKey: ["variances", tbId],
    queryFn:  () => api.listVariances(tbId!),
    enabled:  !!shouldFetchVariances,
    staleTime: 15_000,
    refetchInterval: selectedTb?.status === "generating" ? 5_000 : false,
  })

  // QBO connection status — localStorage-cached for instant render on refresh.
  const { data: qboConn } = useQboConnection()

  // Auto-select most recent TB on first visit (desktop UX convenience).
  // Skipped when ?new=1 is present — that signals the user explicitly asked
  // for the new-analysis picker (e.g. via +New or after a Reset).
  useEffect(() => {
    if (searchParams.get("new") === "1") return
    if (!tbId && tbs.length > 0) {
      navigate(`/app/flux/${tbs[0].id}`, { replace: true })
    }
  }, [tbs, tbId, navigate, searchParams])

  // The ["trial-balances"] query above already polls on a 5s
  // refetchInterval whenever any TB is processing/generating, so no
  // separate setInterval effect is needed here. (Previously we ran a
  // duplicate timer that invalidated the same query — pure noise.)


  // Deep-link: ?connect=qbo auto-redirects to Intuit's OAuth page once.
  // Dashboard / nav links use this so the user lands in the connect flow immediately.
  useEffect(() => {
    if (searchParams.get("connect") !== "qbo") return
    let cancelled = false;
    (async () => {
      try {
        const url = await api.getQboConnectUrl()
        if (!cancelled) window.location.href = url
      } catch {
        // Clear the param so we don't loop on failure
        const sp = new URLSearchParams(searchParams)
        sp.delete("connect")
        setSearchParams(sp, { replace: true })
      }
    })()
    return () => { cancelled = true }
  }, [searchParams, setSearchParams])

  function handleNewAnalysis() {
    // ?new=1 tells the auto-select effect to skip — user wants the picker,
    // not the most-recent analysis.
    navigate("/app/flux?new=1")
  }

  function handleTbComplete(tb: TrialBalance) {
    qc.invalidateQueries({ queryKey: ["trial-balances"] })
    navigate(`/app/flux/${tb.id}`)
  }

  function handleExport() {
    if (tbId) api.exportExcel(tbId)
  }

  // Reset = "Start over" → wipe the TB data AND remove the analysis record,
  // then send the user back to the new-analysis picker. This matches the
  // intuitive expectation ("reset = clean slate, pick fresh periods")
  // rather than leaving them stranded on an empty upload form.
  const resetMut = useMutation({
    mutationFn: async (id: string) => {
      // Wipe data first, then delete the record so the user lands cleanly
      await api.resetTrialBalance(id)
      await api.deleteTrialBalance(id)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["trial-balances"] })
      qc.invalidateQueries({ queryKey: ["variances", tbId] })
      setPendingAction(null)
      navigate("/app/flux?new=1", { replace: true })
    },
    onError: () => setPendingAction(null),
  })

  // Delete removes the analysis entirely; we navigate away.
  const deleteMut = useMutation({
    mutationFn: (id: string) => api.deleteTrialBalance(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["trial-balances"] })
      setPendingAction(null)
      navigate("/app/flux", { replace: true })
    },
    onError: () => setPendingAction(null),
  })

  // TB-level "Sign off on this analysis" — separate from per-variance
  // approval. Sets TrialBalance.approved_by + approved_at on the
  // server. Required by the month-end close gate, which won't let
  // admins lock the books until every flux analysis for the closing
  // month is TB-approved (not just line-approved). Without a UI
  // affordance for this, reviewers had no way to complete the close.
  const { data: me } = useQuery({
    queryKey: ["workspace-me"],
    queryFn:  workspaceApi.getMe,
    staleTime: 5 * 60_000,
  })
  const canSignOff = me?.role === "admin" || me?.role === "reviewer"
  const isAdmin    = me?.role === "admin"

  // Books-closed lookup — same source as the recons banner. When the
  // current TB's period_current falls in a closed period, the entire
  // analysis goes read-only. Mirrors the recons UX: big amber banner
  // + bulk actions and sign-off buttons hidden + Reopen for admin.
  const { data: closedPeriods = [] } = useQuery({
    queryKey: ["closed-periods"],
    queryFn:  reconsApi.listClosedPeriods,
    staleTime: 60_000,
  })
  const closedEntry = useMemo(() => {
    if (!selectedTb?.period_current) return null
    // Match by month — close-period dates are calendar-month-ends,
    // flux period_current is typically the same. Compare exact match
    // first; if the TB period happens to fall WITHIN a closed month
    // (different day in the same month), also count that as closed
    // since the month-end close locks the whole month.
    const pc = selectedTb.period_current.slice(0, 10)
    const ym = pc.slice(0, 7)
    return closedPeriods.find((c) =>
      c.period_end === pc || c.period_end.slice(0, 7) === ym,
    ) ?? null
  }, [selectedTb, closedPeriods])
  const isClosed = closedEntry !== null
  const closedByName = useUserNames([closedEntry?.closed_by])[closedEntry?.closed_by ?? ""]

  // Reopen — admin-only escape hatch (mirrors recons). Lets the admin
  // unlock the period from inside the flux page without bouncing back
  // to the reconciliations dashboard.
  const reopenMut = useMutation({
    mutationFn: () => {
      if (!closedEntry) throw new Error("Period isn't closed")
      return reconsApi.reopenPeriod(closedEntry.period_end)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["closed-periods"] })
      qc.invalidateQueries({ queryKey: ["period-tracker"] })
      qc.invalidateQueries({ queryKey: ["recons-overview"] })
      setRunMsg({ kind: "ok", text: `Period ${closedEntry?.period_end} reopened.` })
    },
    onError: (e: unknown) => {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setRunMsg({ kind: "err", text: detail ?? "Could not reopen the period." })
    },
  })

  const approveTbMut = useMutation({
    mutationFn: (id: string) => api.approveTrialBalance(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["trial-balances"] })
      qc.invalidateQueries({ queryKey: ["period-tracker"] })
      setRunMsg({ kind: "ok", text: "Analysis signed off. Ready for month-end close." })
    },
    onError: (e: unknown) => {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setRunMsg({ kind: "err", text: detail ?? "Could not approve analysis. Try again." })
    },
  })

  // (Removed: runFluxMut — the Find-reasons button it backed was
  // dropped in favor of Agentic Mode, which has a better UX and
  // covers the same flow. api.runFlux is still called from
  // UploadFlow's "Generate" step at the end of the wizard.)

  // Agentic Flux — one click writes AI commentary for every material
  // variance that doesn't have one yet. Runs synchronously; the
  // AgenticRunningOverlay (mounted below) shows progress + Stop button.
  const runAgenticFluxMut = useMutation({
    mutationFn: () => api.runAgenticFlux(tbId!),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["variances", tbId] })
      qc.invalidateQueries({ queryKey: ["trial-balances"] })
      const total = data.processed + data.skipped + data.failed
      const summary = `Wrote commentary on ${data.processed} of ${total} material variance${total === 1 ? "" : "s"}`
        + (data.failed > 0 ? ` · ${data.failed} failed` : "")
        + (data.skipped > 0 ? ` · ${data.skipped} skipped` : "")
      setRunMsg({ kind: "ok", text: summary })
    },
    onError: (e: unknown) => {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setRunMsg({ kind: "err", text: detail ?? "Agentic flux failed. Try again." })
    },
  })

  const cancelAgenticFluxMut = useMutation({
    mutationFn: () => api.cancelAgenticFlux(tbId!),
    onError: (e: unknown) => {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setRunMsg({ kind: "err", text: detail ?? "Could not signal stop." })
    },
  })

  // Auto-dismiss the run banner
  useEffect(() => {
    if (!runMsg) return
    const t = setTimeout(() => setRunMsg(null), 5_000)
    return () => clearTimeout(t)
  }, [runMsg])

  // Auto-clear the pending-confirm state after 4s of inactivity
  useEffect(() => {
    if (!pendingAction) return
    const t = setTimeout(() => setPendingAction(null), 4_000)
    return () => clearTimeout(t)
  }, [pendingAction])

  function handleReset() {
    if (!tbId) return
    if (pendingAction === "reset") resetMut.mutate(tbId)
    else setPendingAction("reset")
  }

  function handleDelete() {
    if (!tbId) return
    if (pendingAction === "delete") deleteMut.mutate(tbId)
    else setPendingAction("delete")
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  // UploadFlow renders for a TB that's been created but not yet uploaded
  // (legacy path). New flows go through showEmpty + FluxEmptyState picker.
  const showUploadFlow    = selectedTb && selectedTb.status === "pending"
  const showVarianceTable = selectedTb &&
    ["parsed", "ready_for_review", "generating", "complete"].includes(selectedTb.status)
  const showProcessing = selectedTb && selectedTb.status === "processing"
  const showError      = selectedTb && selectedTb.status === "error"
  // Show the new-analysis picker whenever:
  //   - there are no analyses at all, OR
  //   - user explicitly asked for it via +New or after a Reset (?new=1)
  const showEmpty      = !tbId && !tbsLoading && (tbs.length === 0 || searchParams.get("new") === "1")

  const contentKey = showEmpty ? "empty"
    : showUploadFlow ? "upload"
    : showProcessing ? "processing"
    : showError      ? "error"
    : showVarianceTable ? `variance-${tbId}`
    : "loading"

  // (Removed: AnalysesList component + desktop sidebar + mobile drawer.
  // FluxMonthIndex is now the single navigation surface for analyses.)

  return (
    <div
      className="flex h-full overflow-hidden relative"
      style={{
        // When the variance detail drawer is open on desktop it sets
        // --detail-drawer-width on <body>. We shrink the page by that
        // width so the analysis filters + variance table stay visible
        // alongside the drawer instead of disappearing under it.
        // Mobile leaves the var unset → padding stays 0.
        paddingRight: "var(--detail-drawer-width, 0px)",
        transition: "padding-right 320ms cubic-bezier(0.4, 0, 0.2, 1)",
      }}>
      {/* ANALYSES sidebar removed — FluxMonthIndex is the navigation
          surface now. FluxDashboard is a focused single-analysis view,
          reached via the month-list page (or a direct deep link). */}

      {/* ── Single panel: takes full width ── */}
      <div
        className="flex flex-1 flex-col overflow-hidden min-w-0"
        style={{ background: "var(--bg)" }}
      >
        {/* Header — outer padding matches the Reconciliations dashboard
            (px-4 sm:px-8 pt-3 sm:pt-4 pb-3) so the two close-workflow
            pages share the exact same header chrome. Gap shrinks on
            mobile so the icon-only action cluster still fits next to
            the back/title on a 360px viewport. */}
        <div className="flex items-center gap-1.5 sm:gap-2 px-4 sm:px-8 pt-3 sm:pt-4 pb-3 shrink-0"
          style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>

          {/* Back to the flux month-index (one step up — obeys URL
              hierarchy instead of jumping all the way to /app). */}
          <button
            className="flex items-center justify-center h-7 w-7 rounded-md mr-1 transition-colors hover:bg-[var(--surface-2)]"
            style={{ color: "var(--text-muted)" }}
            title="Back to the month list"
            onClick={() => navigate("/app/flux")}
          >
            <ArrowLeft size={16} strokeWidth={1.8} />
          </button>

          {/* Title block — typography matches the Reconciliations
              header exactly (clamp 16-20 h1, 11px sub) so the two
              workflow pages read as one product. */}
          <div className="flex-1 min-w-0">
            {selectedTb ? (
              <>
                <h1 style={{
                    fontSize: "clamp(16px, 3vw, 20px)",
                    fontWeight: 700,
                    lineHeight: 1.15,
                    letterSpacing: "-0.01em",
                    color: "var(--text)",
                    margin: 0,
                  }}
                  className="truncate">
                  {selectedTb.name}
                </h1>
                <p className="text-[11px] mt-0.5 truncate" style={{ color: "var(--text-muted)" }}>
                  {new Date(selectedTb.period_prior).toLocaleDateString("en-US", { month: "short", year: "numeric" })}
                  {" → "}
                  {new Date(selectedTb.period_current).toLocaleDateString("en-US", { month: "short", year: "numeric" })}
                  {" · materiality $"}{parseFloat(selectedTb.materiality_threshold).toLocaleString()}
                </p>
              </>
            ) : (
              <>
                <h1 style={{
                    fontSize: "clamp(16px, 3vw, 20px)",
                    fontWeight: 700,
                    lineHeight: 1.15,
                    letterSpacing: "-0.01em",
                    color: "var(--text)",
                    margin: 0,
                  }}>
                  Flux Analysis
                </h1>
                <p className="text-[11px] mt-0.5" style={{ color: "var(--text-muted)" }}>
                  AI-powered variance commentary on every material movement.
                </p>
              </>
            )}
          </div>

          <div className="flex items-center gap-1 sm:gap-2 shrink-0">
            {selectedTb && (
              <span className="hidden sm:inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium"
                style={{
                  background: selectedTb.status === "complete"  ? "var(--green-subtle)" :
                    selectedTb.status === "error" ? "#fee2e2" :
                    ["generating","processing"].includes(selectedTb.status) ? "#fef3c7" : "var(--surface-2)",
                  color: selectedTb.status === "complete"  ? "var(--green)" :
                    selectedTb.status === "error" ? "#dc2626" :
                    ["generating","processing"].includes(selectedTb.status) ? "#92400e" : "var(--text-2)",
                }}>
                <span className="h-1.5 w-1.5 rounded-full"
                  style={{ background: STATUS_DOT[selectedTb.status] ?? "var(--border-strong)" }} />
                {STATUS_LABELS[selectedTb.status] ?? selectedTb.status}
              </span>
            )}
            {/* Reset: only meaningful when the TB has data to wipe */}
            {selectedTb && selectedTb.status !== "pending" && (
              <Button
                variant="outline"
                size="sm"
                icon={<RotateCcw size={14} strokeWidth={1.6} />}
                onClick={handleReset}
                title={pendingAction === "reset" ? "Click again to confirm" : "Wipe uploaded data — keeps the analysis, lets you re-upload"}
                style={pendingAction === "reset"
                  ? { borderColor: "#f59e0b", color: "#92400e" }
                  : undefined}
              >
                <span className="hidden sm:inline">
                  {pendingAction === "reset" ? "Confirm reset?" : "Reset"}
                </span>
              </Button>
            )}
            {/* Delete: always available on a selected TB */}
            {selectedTb && (
              <Button
                variant="outline"
                size="sm"
                icon={<Trash2 size={14} strokeWidth={1.6} />}
                onClick={handleDelete}
                title={pendingAction === "delete" ? "Click again to confirm" : "Delete this analysis permanently"}
                style={pendingAction === "delete"
                  ? { borderColor: "#dc2626", color: "#dc2626" }
                  : undefined}
              >
                <span className="hidden sm:inline">
                  {pendingAction === "delete" ? "Confirm delete?" : "Delete"}
                </span>
              </Button>
            )}
            {/* Agentic Mode — AI writes commentary on every material
                variance in one shot. Mirrors the Reconciliations
                dashboard's AgenticModeToggle: lives in the header,
                stays clickable even when there's nothing pending
                (clicking when 100%-covered surfaces the "already done"
                message via the run banner — same behaviour as recon's
                agentic toggle), only disabled while a run is
                in-flight. */}
            {showVarianceTable && (() => {
              // Materiality dropped — Agentic now runs across EVERY
              // variance, biggest movers first (handled server-side).
              const pendingMat = variances.filter((r) =>
                !["generated", "edited", "approved"].includes(r.status),
              ).length
              const isPending = runAgenticFluxMut.isPending
              const nothingPending = pendingMat === 0
              const label = isPending
                ? "Running…"
                : nothingPending
                  ? "Agentic Mode"
                  : `Agentic Mode (${pendingMat})`
              return (
                <Button
                  size="sm"
                  loading={isPending}
                  disabled={isPending || isClosed}
                  icon={<Sparkles size={14} strokeWidth={1.8} />}
                  onClick={() => runAgenticFluxMut.mutate()}
                  title={
                    isClosed
                      ? "Books are closed for this period — reopen to run AI."
                      : nothingPending
                        ? "Every material variance already has AI commentary — click to re-check (use per-row Regenerate to refresh a specific one)"
                        : `Run AI on ${pendingMat} material variance${pendingMat === 1 ? "" : "s"} without commentary — biggest movers first`
                  }
                  // Dimmed when there's nothing pending so the
                  // visual hierarchy still tells the user "this is
                  // idle right now", but the button itself remains
                  // clickable so they're never stuck wondering why
                  // it's frozen.
                  style={{
                    background: nothingPending ? "var(--surface-2)" : "var(--green)",
                    color:      nothingPending ? "var(--text-2)"   : "white",
                    borderColor: nothingPending ? "var(--border-strong)" : "var(--green)",
                  }}
                >
                  <span className="hidden sm:inline">{label}</span>
                </Button>
              )
            })()}

            {/* (Find reasons button removed — Agentic Mode covers the
                same flow with better UX. Users who want to regenerate
                a single variance can click Regenerate inside the
                expanded row.) */}
            {/* TB-level sign-off. Per-variance approvals stay in the
                row check icon / bulk action bar; THIS is the final
                "I sign off on the whole analysis" step that the
                month-end close gate requires. Visible only to admin
                + reviewer; preparers see the badge if already signed
                off but never the action button. Hidden when the
                period is closed — the period lock already provides
                the same guarantee. */}
            {showVarianceTable && selectedTb && !isClosed && (
              selectedTb.approved_at ? (
                <span className="hidden sm:inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold"
                  style={{ background: "var(--green-subtle)", color: "var(--green)" }}
                  title={`Approved on ${new Date(selectedTb.approved_at).toLocaleString()}`}
                >
                  <CheckCircle2 size={11} strokeWidth={2} />
                  Approved
                </span>
              ) : canSignOff ? (
                (() => {
                  // Sign-off rule: every variance row approved (materiality
                  // dropped — was previously a subset filter on is_material).
                  const linesApproved = variances.filter((v) => v.status === "approved")
                  const allLinesDone = variances.length > 0 && linesApproved.length === variances.length
                  const remaining = variances.length - linesApproved.length
                  return (
                    <Button
                      size="sm"
                      icon={<CheckCircle2 size={14} strokeWidth={1.8} />}
                      loading={approveTbMut.isPending}
                      disabled={!allLinesDone}
                      onClick={() => tbId && approveTbMut.mutate(tbId)}
                      title={
                        variances.length === 0
                          ? "No variances yet — generate the analysis first."
                          : !allLinesDone
                            ? `Approve all ${variances.length} variance${variances.length === 1 ? "" : "s"} first (${remaining} remaining).`
                            : "Sign off on this analysis — required before the books can be closed for this month."
                      }
                    >
                      <span className="hidden sm:inline">
                        {allLinesDone ? "Sign off analysis" : `Sign off (${remaining} left)`}
                      </span>
                    </Button>
                  )
                })()
              ) : null
            )}

            {/* Reopen — admin escape hatch when books are closed.
                Same pattern as recons: unlocks the period from
                inside the locked surface so the admin doesn't have
                to navigate back to the dashboard. */}
            {showVarianceTable && isClosed && isAdmin && (
              <Button
                size="sm"
                variant="outline"
                icon={<Unlock size={14} strokeWidth={1.8} />}
                loading={reopenMut.isPending}
                onClick={() => reopenMut.mutate()}
                style={{ borderColor: "#f59e0b", color: "#b45309" }}
                title="Reopen the books for this period — admins can edit again"
              >
                <span className="hidden sm:inline">Reopen books</span>
              </Button>
            )}
            {showVarianceTable && (
              <Button variant="outline" size="sm" icon={<Download size={14} strokeWidth={1.6} />} onClick={handleExport}>
                <span className="hidden sm:inline">Export</span>
              </Button>
            )}
            {/* "New Analysis" in header is only shown on mobile (desktop has + in sidebar) */}
            <Button
              size="sm"
              icon={<Plus size={14} strokeWidth={1.6} />}
              onClick={handleNewAnalysis}
              className="lg:hidden"
              title="Start a new analysis"
            />
          </div>
        </div>

        {/* Transient feedback banner */}
        <AnimatePresence>
          {runMsg && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2 }}
              className="px-4 sm:px-6 py-2 text-xs font-medium flex items-center gap-2"
              style={{
                background:
                  runMsg.kind === "ok"   ? "var(--green-subtle)" :
                  runMsg.kind === "err"  ? "#fee2e2" :
                                           "var(--surface-2)",
                color:
                  runMsg.kind === "ok"   ? "var(--green)" :
                  runMsg.kind === "err"  ? "#b91c1c" :
                                           "var(--text-2)",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <Sparkles size={12} strokeWidth={1.8} />
              <span className="flex-1">{runMsg.text}</span>
              <button onClick={() => setRunMsg(null)} className="opacity-60 hover:opacity-100">
                <X size={12} strokeWidth={2} />
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Animated content ──
            Two render paths share this region:
              · Variance state → page-level scroll container with a
                sticky KPI strip that collapses to a compact bar
                once the user scrolls (mirrors Reconciliations).
              · Every other state (empty / upload / processing /
                error) keeps the AnimatePresence + absolute-position
                swap because they're single-screen layouts.            */}
        <div className="flex-1 overflow-hidden relative">
          {showVarianceTable ? (
            <div ref={pageScrollRef} className="absolute inset-0 overflow-y-auto">
              {/* Sticky KPI cards — full-grid layout collapses to a
                  compact horizontal bar after ~140px of scroll. */}
              <div className="sticky top-0 z-20 px-4 sm:px-6 pt-3 pb-2"
                style={{ background: "var(--bg)" }}>
                <FluxKpiStrip rows={variances} compact={isKpiCompact} />
              </div>

              {/* Books-closed banner — mirrors the recons UX so a
                  closed period looks the same across both surfaces.
                  Big amber stripe, locked icon, closed-by attribution,
                  Reopen button for admins. The VarianceTable below
                  goes read-only (readOnly prop) so approve/edit
                  buttons disappear. */}
              {isClosed && (
                <div className="mx-4 sm:mx-6 mb-3 rounded-xl overflow-hidden"
                  style={{
                    background: "linear-gradient(135deg, var(--surface-2) 0%, var(--surface) 100%)",
                    border: "1px solid var(--border-strong)",
                    boxShadow: "var(--card-shadow)",
                  }}>
                  <div className="flex items-center gap-4 p-5">
                    <div className="h-12 w-12 rounded-full flex items-center justify-center shrink-0"
                      style={{
                        background: "rgba(245, 158, 11, 0.15)",
                        border: "2px solid #f59e0b",
                      }}>
                      <Lock size={20} strokeWidth={2} style={{ color: "#b45309" }} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[10px] font-bold uppercase tracking-wider mb-0.5"
                        style={{ color: "#b45309" }}>
                        Books closed
                      </p>
                      <h3 className="text-lg sm:text-xl font-bold text-theme leading-tight">
                        Period {closedEntry?.period_end} is locked
                      </h3>
                      <p className="text-xs mt-1" style={{ color: "var(--text-2)" }}>
                        Closed by <span className="font-semibold text-theme">{closedByName || "an admin"}</span>
                        {closedEntry?.closed_at && (
                          <> on {formatDateLong(closedEntry.closed_at)}</>
                        )}.
                        This flux analysis is frozen — reviewers and preparers can view but not edit.
                      </p>
                      {closedEntry?.notes && (
                        <p className="text-xs mt-1.5 italic" style={{ color: "var(--text-muted)" }}>
                          &quot;{closedEntry.notes}&quot;
                        </p>
                      )}
                    </div>
                    {isAdmin && (
                      <Button
                        size="sm"
                        variant="outline"
                        icon={<Unlock size={12} strokeWidth={1.8} />}
                        loading={reopenMut.isPending}
                        onClick={() => reopenMut.mutate()}
                        style={{ borderColor: "#f59e0b", color: "#b45309" }}>
                        Reopen
                      </Button>
                    )}
                  </div>
                </div>
              )}

              <VarianceTable
                tbId={tbId!}
                rows={variances}
                isLoading={variancesLoading}
                onExport={handleExport}
                periodCurrent={selectedTb?.period_current}
                periodPrior={selectedTb?.period_prior}
                onMessage={setRunMsg}
                readOnly={isClosed}
              />
            </div>
          ) : (
            <AnimatePresence mode="wait">
              <motion.div
                key={contentKey}
                variants={panelVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                className="absolute inset-0 flex flex-col"
              >

                {showEmpty && (
                  <div className="h-full overflow-y-auto">
                    <FluxEmptyState
                      qboConnected={!!qboConn}
                      qboCompany={qboConn?.company}
                      onComplete={handleTbComplete}
                      onConnectQbo={() => navigate("/app/connections")}
                    />
                  </div>
                )}

                {showUploadFlow && (
                  <div className="h-full overflow-y-auto">
                    {/* Re-upload path: the TB record exists (status=pending) but
                        has no file yet. UploadFlow handles upload+parse+run. */}
                    <UploadFlow onComplete={handleTbComplete} qboConnected={!!qboConn} forceSource="upload" />
                  </div>
                )}

                {showProcessing && (
                  <div className="flex flex-col items-center justify-center h-full text-center p-8">
                    <div className="relative h-16 w-16 mb-5">
                      <div className="absolute inset-0 rounded-full animate-ping opacity-40" style={{ background: "#fef3c7" }} />
                      <div className="relative h-16 w-16 rounded-full flex items-center justify-center" style={{ background: "#fef3c7" }}>
                        <Spinner className="h-7 w-7 text-[#92400e]" />
                      </div>
                    </div>
                    <p className="text-base font-semibold text-theme mb-2">Processing your file…</p>
                    <p className="text-sm max-w-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
                      Reading your trial balance and computing variances. Usually takes a few seconds.
                    </p>
                  </div>
                )}

                {showError && (
                  <div className="flex flex-col items-center justify-center h-full text-center p-8">
                    <div className="h-14 w-14 rounded-full flex items-center justify-center mb-4" style={{ background: "#fee2e2" }}>
                      <AlertCircle size={28} strokeWidth={1.6} style={{ color: "#dc2626" }} />
                    </div>
                    <p className="text-base font-semibold text-theme mb-2">Processing failed</p>
                    <p className="text-sm max-w-xs leading-relaxed mb-5" style={{ color: "var(--text-muted)" }}>
                      {selectedTb?.error_detail ?? "An error occurred while processing your file."}
                    </p>
                    <Button variant="outline" size="sm" icon={<RefreshCw size={14} strokeWidth={1.6} />} onClick={handleNewAnalysis}>
                      Try Again
                    </Button>
                  </div>
                )}

              </motion.div>
            </AnimatePresence>
          )}

          {/* AI-working overlay — independent of which state is
              showing. Lives outside the conditional so it can
              cover any content while the agentic-flux run is in
              flight. Stop button signals cooperative cancel; the
              run exits after the current variance. */}
          <AgenticRunningOverlay
            open={runAgenticFluxMut.isPending}
            periodLabel={selectedTb?.name ?? null}
            cancelling={cancelAgenticFluxMut.isPending}
            onStop={() => cancelAgenticFluxMut.mutate()}
            title="AI is writing flux commentary"
            statusLines={[
              "Reading the GL detail behind each material variance…",
              "Pulling transaction evidence from QuickBooks…",
              "Drafting drivers, one-offs, and normalized run-rate…",
              "Asking Claude for the most plausible explanation…",
              "Saving commentary with a confidence score…",
            ]}
          />
        </div>
      </div>
    </div>
  )
}

// ── Empty state with inline "Run from QBO" + Upload ─────────────────────────

interface FluxEmptyStateProps {
  qboConnected: boolean
  qboCompany?: string | null
  onComplete:  (tb: TrialBalance) => void
  onConnectQbo:() => void
}

function FluxEmptyState({ qboConnected, qboCompany, onComplete, onConnectQbo }: FluxEmptyStateProps) {
  const [mode, setMode] = useState<"choose" | "qbo" | "upload">(qboConnected ? "qbo" : "choose")

  return (
    <div className="max-w-xl mx-auto px-6 py-10">
      <div className="mb-6">
        <p className="text-base font-semibold text-theme">Start a new flux analysis</p>
        <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
          {qboConnected
            ? `Connected to ${qboCompany ?? "QuickBooks"}. Pull a trial balance directly, or upload a file.`
            : "Connect QuickBooks for one-click pulls, or upload a trial balance file."}
        </p>
      </div>

      {/* Source selector */}
      <div className="grid grid-cols-2 gap-2 mb-5">
        <button
          onClick={() => setMode("qbo")}
          disabled={!qboConnected}
          className="rounded-lg p-3 text-left transition-all"
          style={{
            background: mode === "qbo" ? "var(--green-subtle)" : "var(--surface)",
            border: `1px solid ${mode === "qbo" ? "var(--green)" : "var(--border)"}`,
            opacity: qboConnected ? 1 : 0.5,
            cursor: qboConnected ? "pointer" : "not-allowed",
          }}
        >
          <div className="flex items-center gap-2 mb-1">
            <Sparkles size={14} strokeWidth={1.8} style={{ color: "var(--green)" }} />
            <span className="text-sm font-semibold text-theme">From QuickBooks</span>
          </div>
          <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
            {qboConnected ? "Pull both periods automatically." : "Connect QuickBooks first."}
          </p>
        </button>
        <button
          onClick={() => setMode("upload")}
          className="rounded-lg p-3 text-left transition-all"
          style={{
            background: mode === "upload" ? "var(--green-subtle)" : "var(--surface)",
            border: `1px solid ${mode === "upload" ? "var(--green)" : "var(--border)"}`,
          }}
        >
          <div className="flex items-center gap-2 mb-1">
            <Upload size={14} strokeWidth={1.8} style={{ color: "var(--text-2)" }} />
            <span className="text-sm font-semibold text-theme">Upload file</span>
          </div>
          <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
            Excel or CSV with current + prior columns.
          </p>
        </button>
      </div>

      {!qboConnected && mode !== "upload" && (
        <div className="mb-5 rounded-lg p-3 flex items-start gap-2"
          style={{ background: "#fef3c7", border: "1px solid #f59e0b" }}>
          <AlertCircle size={14} strokeWidth={1.8} style={{ color: "#92400e" }} className="shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-xs" style={{ color: "#92400e" }}>
              QuickBooks isn't connected — pulling a trial balance automatically is disabled. You can upload a file instead, or connect QBO.
            </p>
          </div>
          <Button size="sm" onClick={onConnectQbo}>Connect</Button>
        </div>
      )}

      {/* Body for chosen mode */}
      {mode === "qbo" && qboConnected && (
        <QboFluxInlineForm onComplete={onComplete} />
      )}
      {mode === "upload" && (
        <UploadFlow onComplete={onComplete} qboConnected={qboConnected} forceSource="upload" />
      )}
    </div>
  )
}

interface QboInlineProps {
  onComplete: (tb: TrialBalance) => void
}

// ── Period preset helpers ───────────────────────────────────────────────────
// All presets compute (currentStart, currentEnd) AND (priorStart, priorEnd)
// directly. "Prior" semantics differ per preset:
//   - "vs prior X" presets compare to the immediately preceding period
//   - "vs same X last year" presets compare to the same window one year back
// This avoids the ambiguity of always-minus-one-year for, say, a Q1 vs Q4 ask.

interface PeriodPreset {
  key: string
  label: string
  /** Returns [currentStart, currentEnd, priorStart, priorEnd] as ISO strings */
  compute: () => [string, string, string, string]
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10)
}
function lastDayOfMonth(year: number, monthIdx0: number): Date {
  return new Date(year, monthIdx0 + 1, 0)
}

const PERIOD_PRESETS: PeriodPreset[] = [
  {
    key: "mtd_vs_prior_month",
    label: "This month vs last month",
    compute: () => {
      const now = new Date()
      const cStart = new Date(now.getFullYear(), now.getMonth(), 1)
      const cEnd   = now
      const pStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      const pEnd   = lastDayOfMonth(now.getFullYear(), now.getMonth() - 1)
      return [iso(cStart), iso(cEnd), iso(pStart), iso(pEnd)]
    },
  },
  {
    key: "last_month_vs_prior_month",
    label: "Last month vs prior month",
    compute: () => {
      const now = new Date()
      const cStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      const cEnd   = lastDayOfMonth(now.getFullYear(), now.getMonth() - 1)
      const pStart = new Date(now.getFullYear(), now.getMonth() - 2, 1)
      const pEnd   = lastDayOfMonth(now.getFullYear(), now.getMonth() - 2)
      return [iso(cStart), iso(cEnd), iso(pStart), iso(pEnd)]
    },
  },
  {
    key: "last_month_vs_same_last_year",
    label: "Last month vs same month last year",
    compute: () => {
      const now = new Date()
      const cStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      const cEnd   = lastDayOfMonth(now.getFullYear(), now.getMonth() - 1)
      const pStart = new Date(now.getFullYear() - 1, now.getMonth() - 1, 1)
      const pEnd   = lastDayOfMonth(now.getFullYear() - 1, now.getMonth() - 1)
      return [iso(cStart), iso(cEnd), iso(pStart), iso(pEnd)]
    },
  },
  {
    key: "this_qtr_vs_prior_qtr",
    label: "This quarter vs prior quarter",
    compute: () => {
      const now = new Date()
      const qIdx = Math.floor(now.getMonth() / 3)             // 0..3 = Q1..Q4
      const cStart = new Date(now.getFullYear(), qIdx * 3, 1)
      const cEnd   = lastDayOfMonth(now.getFullYear(), qIdx * 3 + 2)
      const prevQ  = qIdx === 0 ? 3 : qIdx - 1
      const prevYr = qIdx === 0 ? now.getFullYear() - 1 : now.getFullYear()
      const pStart = new Date(prevYr, prevQ * 3, 1)
      const pEnd   = lastDayOfMonth(prevYr, prevQ * 3 + 2)
      return [iso(cStart), iso(cEnd), iso(pStart), iso(pEnd)]
    },
  },
  {
    key: "this_qtr_vs_same_last_year",
    label: "This quarter vs same quarter last year",
    compute: () => {
      const now = new Date()
      const qIdx = Math.floor(now.getMonth() / 3)
      const cStart = new Date(now.getFullYear(), qIdx * 3, 1)
      const cEnd   = lastDayOfMonth(now.getFullYear(), qIdx * 3 + 2)
      const pStart = new Date(now.getFullYear() - 1, qIdx * 3, 1)
      const pEnd   = lastDayOfMonth(now.getFullYear() - 1, qIdx * 3 + 2)
      return [iso(cStart), iso(cEnd), iso(pStart), iso(pEnd)]
    },
  },
  {
    key: "ytd_vs_prior_ytd",
    label: "This year (YTD) vs prior YTD",
    compute: () => {
      const now = new Date()
      const cStart = new Date(now.getFullYear(), 0, 1)
      const cEnd   = now
      const pStart = new Date(now.getFullYear() - 1, 0, 1)
      // Same calendar day as today, one year back
      const pEnd   = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate())
      return [iso(cStart), iso(cEnd), iso(pStart), iso(pEnd)]
    },
  },
  {
    key: "last_full_year_vs_prior_year",
    label: "Last full year vs prior year",
    compute: () => {
      const now = new Date()
      const yr = now.getFullYear() - 1
      return [iso(new Date(yr, 0, 1)), iso(new Date(yr, 11, 31)),
              iso(new Date(yr - 1, 0, 1)), iso(new Date(yr - 1, 11, 31))]
    },
  },
]


function QboFluxInlineForm({ onComplete }: QboInlineProps) {
  // Default preset = last month vs prior month. BUT when the dashboard
  // routes here with ?period=YYYY-MM-DD (its currently-focused month),
  // anchor the form on that month instead so the user only needs to
  // click "Pull from QuickBooks". The comparison stays MoM-style
  // (prior calendar month, one-year-back option still available via
  // the YoY preset chip).
  const [searchParamsForForm] = useSearchParams()
  const initial = useMemo(() => {
    const fromUrl = searchParamsForForm.get("period")
    if (fromUrl && /^\d{4}-\d{2}-\d{2}$/.test(fromUrl)) {
      const d = new Date(fromUrl + "T00:00:00")
      const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0)
      const firstDay = new Date(d.getFullYear(), d.getMonth(), 1)
      const priorLast = new Date(d.getFullYear(), d.getMonth(), 0)
      const priorFirst = new Date(d.getFullYear(), d.getMonth() - 1, 1)
      const iso = (x: Date) => x.toISOString().slice(0, 10)
      return [iso(firstDay), iso(lastDay), iso(priorFirst), iso(priorLast)] as const
    }
    return PERIOD_PRESETS[1].compute()
  }, [searchParamsForForm])

  const [name,        setName]        = useState(`Flux ${initial[1].slice(0, 7)}`)
  const [periodStart, setPeriodStart] = useState(initial[0])
  const [periodEnd,   setPeriodEnd]   = useState(initial[1])
  const [priorStart,  setPriorStart]  = useState(initial[2])
  const [priorEnd,    setPriorEnd]    = useState(initial[3])
  // If we seeded from ?period= no preset is "active" (the URL took
  // precedence); otherwise default to the MoM preset highlight.
  const [activePreset, setActivePreset] = useState<string | null>(
    searchParamsForForm.get("period") ? null : PERIOD_PRESETS[1].key,
  )
  const [threshold,   setThreshold]   = useState("5000")
  const [error,       setError]       = useState<string | null>(null)

  function applyPreset(p: PeriodPreset) {
    const [cs, ce, ps, pe] = p.compute()
    setPeriodStart(cs); setPeriodEnd(ce)
    setPriorStart(ps);  setPriorEnd(pe)
    setActivePreset(p.key)
    setName(`Flux ${ce.slice(0, 7)}`)
  }

  // When user manually edits dates, clear the active preset highlight + recompute
  // prior to match (same range, one year back) only if they had been on a preset.
  function onPeriodStartChange(v: string) {
    setPeriodStart(v)
    if (activePreset) {
      setActivePreset(null)
      // Compute new prior as same-dates-one-year-back
      const d = new Date(v + "T00:00:00")
      d.setFullYear(d.getFullYear() - 1)
      setPriorStart(d.toISOString().slice(0, 10))
    }
  }
  function onPeriodEndChange(v: string) {
    setPeriodEnd(v)
    if (activePreset) {
      setActivePreset(null)
      const d = new Date(v + "T00:00:00")
      d.setFullYear(d.getFullYear() - 1)
      setPriorEnd(d.toISOString().slice(0, 10))
    }
  }

  const fmt = (iso: string) => {
    return formatDate(iso) || iso
  }

  const run = useMutation({
    mutationFn: () => api.createTrialBalanceFromQbo({
      name: name.trim() || `Flux ${periodEnd.slice(0, 7)}`,
      period_current:       periodEnd,
      period_prior:         priorEnd,
      period_start_current: periodStart,
      period_start_prior:   priorStart,
      materiality_threshold: Number(threshold) || 5000,
    }),
    onSuccess: onComplete,
    onError: (e: unknown) => {
      const ex = e as { response?: { data?: { detail?: string } }; message?: string }
      setError(ex.response?.data?.detail ?? ex.message ?? "Could not pull from QuickBooks.")
    },
  })

  // Auto-run when arriving from the main dashboard's "Open Flux Analysis"
  // tile (which routes here with both ?new=1 AND ?period=YYYY-MM-DD set).
  // The picker is bypassed entirely — the user just wants the analysis
  // for that month, not a date-picker step in between. If they need to
  // change dates or use a different preset, the picker reappears as
  // soon as the run errors out.
  const autoStartedRef = useRef(false)
  const shouldAutoStart =
    searchParamsForForm.get("new") === "1" &&
    !!searchParamsForForm.get("period")
  useEffect(() => {
    if (!shouldAutoStart || autoStartedRef.current) return
    autoStartedRef.current = true
    run.mutate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Show the loading screen while we either (a) waiting for the auto-run
  // to fire its first request, or (b) the mutation is in flight, OR
  // (c) the request succeeded and we're waiting for the parent to
  // navigate. Errors fall through to the picker UI so the user can
  // adjust dates and retry.
  const showLoading =
    run.isPending ||
    (shouldAutoStart && !error && !run.isError)

  if (showLoading) {
    return (
      <div className="rounded-xl p-12 flex flex-col items-center justify-center text-center"
        style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
        <div className="relative h-20 w-20 mb-6">
          <div className="absolute inset-0 rounded-full animate-ping opacity-50"
            style={{ background: "var(--green-subtle)" }} />
          <div className="relative h-20 w-20 rounded-full flex items-center justify-center"
            style={{ background: "var(--green-subtle)" }}>
            <Spinner className="h-8 w-8" />
          </div>
        </div>
        <h3 className="text-lg font-bold text-theme mb-1">Pulling your trial balance…</h3>
        <p className="text-sm max-w-md" style={{ color: "var(--text-muted)" }}>
          Hitting QuickBooks for {fmt(periodEnd)} and {fmt(priorEnd)} —
          usually 5-15 seconds depending on account count.
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-xl p-5 space-y-4"
      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>

      {/* Period presets — click any chip to autofill both periods */}
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wide mb-2" style={{ color: "var(--text-muted)" }}>
          Quick periods
        </p>
        <div className="flex flex-wrap gap-1.5">
          {PERIOD_PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => applyPreset(p)}
              className="px-2.5 py-1 rounded-full text-[11px] font-medium transition-all"
              style={activePreset === p.key
                ? { background: "var(--green)", color: "#fff", border: "1px solid var(--green)" }
                : { background: "var(--surface-2)", color: "var(--text-2)", border: "1px solid var(--border-strong)" }}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <FieldLabel label="Analysis name">
          <input value={name} onChange={(e) => setName(e.target.value)} className="flux-input" />
        </FieldLabel>
        <FieldLabel label="Materiality threshold ($)">
          <input value={threshold} onChange={(e) => setThreshold(e.target.value)} type="number" min="0" className="flux-input" />
        </FieldLabel>
        <FieldLabel label="Period start">
          <DatePicker
            value={periodStart} onChange={onPeriodStartChange}
            className="block w-full"
            triggerClassName="flux-input inline-flex items-center gap-2"
          />
        </FieldLabel>
        <FieldLabel label="Period end">
          <DatePicker
            value={periodEnd} onChange={onPeriodEndChange}
            className="block w-full"
            triggerClassName="flux-input inline-flex items-center gap-2"
          />
        </FieldLabel>
      </div>

      {/* Confirms exactly what will be pulled (auto from preset or computed from current dates) */}
      <div className="rounded-lg p-3 flex items-start gap-2"
        style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
        <RefreshCw size={12} strokeWidth={1.8} style={{ color: "var(--text-muted)" }} className="mt-0.5 shrink-0" />
        <div className="text-[11px] leading-snug" style={{ color: "var(--text-2)" }}>
          <span style={{ color: "var(--text-muted)" }}>Comparing against: </span>
          <span className="font-medium">{fmt(priorStart)} → {fmt(priorEnd)}</span>
        </div>
      </div>

      {error && (
        <p className="text-xs flex items-start gap-1.5" style={{ color: "#dc2626" }}>
          <AlertCircle size={11} strokeWidth={1.8} className="mt-0.5 shrink-0" />
          {error}
        </p>
      )}

      <Button onClick={() => run.mutate()} loading={run.isPending}
        icon={<Sparkles size={14} strokeWidth={1.8} />}
      >
        {run.isPending ? "Pulling from QuickBooks…" : "Run analysis"}
      </Button>

      <style>{`
        .flux-input {
          width: 100%;
          background: var(--surface-2);
          border: 1px solid var(--border-strong);
          color: var(--text);
          border-radius: 8px;
          padding: 8px 10px;
          font-size: 13px;
          outline: none;
          transition: border-color 0.15s;
        }
        .flux-input:focus { border-color: var(--green); }
      `}</style>
    </div>
  )
}

function FieldLabel({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[11px] font-medium mb-1 block" style={{ color: "var(--text-2)" }}>{label}</span>
      {children}
    </label>
  )
}

// ── FluxKpiStrip ────────────────────────────────────────────────────────────
//
// Four cards above the variance table summarising the analysis at a
// glance: material count, total |variance|, approval progress, AI
// commentary coverage. Plus a Run-AI button that fires the agentic
// flux runner (handler comes from the parent).

function FluxKpiStrip({ rows, compact }: { rows: VarianceRow[]; compact: boolean }) {
  // Materiality dropped — all KPIs now compute across every variance,
  // not just material ones. Approval progress + AI coverage reflect
  // the whole set so the workflow is "review everything", not
  // "review the big ones".
  const total = rows.length
  const approved = rows.filter((r) => r.status === "approved")
  const withNarrative = rows.filter((r) =>
    r.status === "generated" || r.status === "edited" || r.status === "approved",
  )
  const totalAbsVar = rows.reduce((s, r) => s + Math.abs(parseFloat(r.dollar_variance) || 0), 0)
  const approvalPct = total > 0 ? Math.round((approved.length / total) * 100) : 0
  const coveragePct = total > 0 ? Math.round((withNarrative.length / total) * 100) : 0

  // Same compact/full KPI swap pattern as the Reconciliations dashboard:
  //   · compact = pinned horizontal bar with inline metric pills + an
  //     approval progress bar on the right.
  //   · full    = 4-card grid, each tile its own rounded-xl with the
  //     standard card shadow.
  // AnimatePresence mode="wait" + initial={false} = fade-and-slide swap
  // when the user crosses the scroll threshold.
  return (
    <AnimatePresence mode="wait" initial={false}>
      {compact ? (
        <motion.div
          key="flux-kpi-compact"
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.16, ease: "easeOut" }}
          className="rounded-lg flex items-center gap-3 sm:gap-5 px-4 py-2.5 overflow-x-auto"
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            boxShadow: "0 4px 12px rgba(0,0,0,0.06)",
          }}>
          <KpiInline
            label="Rows"
            value={String(total)}
            tone={total > 0 ? "var(--text)" : "var(--text-muted)"} />
          <KpiInline
            label="Var"
            value={fmtMoneyShort(totalAbsVar)}
            tone="var(--text)" />
          <KpiInline
            label="AI"
            value={`${withNarrative.length}/${total}`}
            tone={coveragePct === 100 && total > 0 ? "var(--green)" : "var(--text)"} />
          <div className="ml-auto flex items-center gap-2 shrink-0">
            <span className="text-[11px] font-semibold tabular-nums"
              style={{ color: approvalPct === 100 && total > 0 ? "var(--green)" : "var(--text)" }}>
              {approved.length}/{total}
            </span>
            <div className="h-1.5 w-20 rounded-full overflow-hidden" style={{ background: "var(--surface-2)" }}>
              <motion.div className="h-full"
                initial={{ width: 0 }}
                animate={{ width: `${approvalPct}%` }}
                transition={{ duration: 0.4, ease: "easeOut" }}
                style={{ background: approvalPct === 100 && total > 0 ? "var(--green)" : "var(--text-muted)" }} />
            </div>
            <span className="text-[10px] hidden sm:inline" style={{ color: "var(--text-muted)" }}>
              {approvalPct}%
            </span>
          </div>
        </motion.div>
      ) : (
        <motion.div
          key="flux-kpi-full"
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.16, ease: "easeOut" }}
          className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <FluxKpi
            label="Variance rows"
            value={String(total)}
            sub={total > 0 ? `across all accounts` : "no variances"}
            tone={total > 0 ? "var(--text)" : "var(--text-muted)"} />
          <FluxKpi
            label="Total |variance|"
            value={fmtMoneyShort(totalAbsVar)}
            sub="sum of absolute movements"
            tone="var(--text)" />
          <FluxKpi
            label="Approval"
            value={`${approved.length} / ${total}`}
            sub={total > 0 ? `${approvalPct}% approved` : "—"}
            tone={approvalPct === 100 && total > 0 ? "var(--green)" : "var(--text)"} />
          <FluxKpi
            label="AI coverage"
            value={`${withNarrative.length} / ${total}`}
            sub={total > 0 ? `${coveragePct}% commentary written` : "—"}
            tone={coveragePct === 100 && total > 0 ? "var(--green)" : "var(--text)"} />
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// Matches the Kpi component in ReconciliationsDashboard exactly — same
// rounded-xl, padding, font sizes, and card shadow so the two pages
// look like cousins not strangers.
function FluxKpi({ label, value, sub, tone }: { label: string; value: string; sub: string; tone: string }) {
  return (
    <div className="rounded-xl p-4"
      style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
      <p className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>{label}</p>
      <p className="text-xl sm:text-2xl font-bold tabular-nums mt-1" style={{ color: tone }}>{value}</p>
      {sub && <p className="text-[10px] mt-1" style={{ color: "var(--text-muted)" }}>{sub}</p>}
    </div>
  )
}

/**
 * Compact inline KPI used by the sticky condensed KPI bar.
 * Single row, tight typography — pairs a label + value (no sub).
 * Same shape as the KpiInline in ReconciliationsDashboard so the two
 * compact bars look identical when the user scrolls.
 */
function KpiInline({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="flex items-baseline gap-1.5 shrink-0">
      <span className="text-[10px] font-bold uppercase tracking-wider"
        style={{ color: "var(--text-muted)" }}>{label}</span>
      <span className="text-sm font-bold tabular-nums" style={{ color: tone }}>{value}</span>
    </div>
  )
}

function fmtMoneyShort(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `$${(abs / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000) return `$${(abs / 1_000).toFixed(1)}K`
  return `$${abs.toFixed(0)}`
}
