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
} from "lucide-react"
import { api, type TrialBalance } from "@/modules/flux/api"
import { useQboConnection } from "@/modules/flux/hooks"
import { UploadFlow } from "@/modules/flux/components/UploadFlow"
import { VarianceTable } from "@/modules/flux/components/VarianceTable"
import { DatePicker } from "@/core/ui/DatePicker"
import { Button, Spinner } from "@/core/ui/components"
import { AgenticRunningOverlay } from "@/modules/recons/components/AgenticRunningOverlay"
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

  // Poll selected TB if it's processing/generating
  useEffect(() => {
    if (!selectedTb) return
    if (!["processing", "generating"].includes(selectedTb.status)) return
    const interval = setInterval(() => {
      qc.invalidateQueries({ queryKey: ["trial-balances"] })
    }, 5_000)
    return () => clearInterval(interval)
  }, [selectedTb?.id, selectedTb?.status, qc])


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

  // Approve the entire analysis — stamps approved_by/at + moves to "complete"
  const approveTbMut = useMutation({
    mutationFn: (id: string) => api.approveTrialBalance(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["trial-balances"] })
    },
  })

  // Run AI analysis on all material+pending variances
  const runFluxMut = useMutation({
    mutationFn: (id: string) => api.runFlux(id),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["trial-balances"] })
      qc.invalidateQueries({ queryKey: ["variances", tbId] })
      if (data.status === "queued") {
        setRunMsg({ kind: "ok", text: data.message ?? "AI analysis started." })
      } else {
        setRunMsg({ kind: "info", text: data.message ?? "All variances already have AI commentary." })
      }
    },
    onError: (e: unknown) => {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setRunMsg({ kind: "err", text: detail ?? "Could not start AI analysis. Try again." })
    },
  })

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
    <div className="flex h-full overflow-hidden relative">
      {/* ANALYSES sidebar removed — FluxMonthIndex is the navigation
          surface now. FluxDashboard is a focused single-analysis view,
          reached via the month-list page (or a direct deep link). */}

      {/* ── Single panel: takes full width ── */}
      <div
        className="flex flex-1 flex-col overflow-hidden min-w-0"
        style={{ background: "var(--bg)" }}
      >
        {/* Header — compact (py-2 to match recon for visual parity); gap
            shrinks on mobile so the icon-only action cluster still fits
            next to the back/title on a 360px viewport. */}
        <div className="flex items-center gap-1.5 sm:gap-2 px-3 sm:px-6 py-2 shrink-0"
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

          <div className="flex-1 min-w-0">
            {selectedTb ? (
              <>
                <h1 className="text-sm font-semibold text-theme truncate">{selectedTb.name}</h1>
                <p className="text-xs mt-0.5 truncate" style={{ color: "var(--text-muted)" }}>
                  {new Date(selectedTb.period_prior).toLocaleDateString("en-US", { month: "short", year: "numeric" })}
                  {" → "}
                  {new Date(selectedTb.period_current).toLocaleDateString("en-US", { month: "short", year: "numeric" })}
                  {" · $"}{parseFloat(selectedTb.materiality_threshold).toLocaleString()}
                </p>
              </>
            ) : (
              <>
                <h1 className="text-sm font-semibold text-theme">Flux Analysis</h1>
                <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>AI-powered variance commentary</p>
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
            {/* Find reasons: kicks off the AI variance-explanation pass.
                Only meaningful when we have variances to explain. */}
            {showVarianceTable && (
              <Button
                size="sm"
                icon={<Sparkles size={14} strokeWidth={1.8} />}
                loading={runFluxMut.isPending}
                onClick={() => tbId && runFluxMut.mutate(tbId)}
                title="Have the AI re-analyze every material variance"
              >
                <span className="hidden sm:inline">Find reasons</span>
              </Button>
            )}
            {/* Approve analysis — only shown for TBs with results that aren't yet approved */}
            {showVarianceTable && selectedTb && !selectedTb.approved_at && (
              <Button
                variant="outline"
                size="sm"
                icon={<CheckCircle2 size={14} strokeWidth={1.8} />}
                loading={approveTbMut.isPending}
                onClick={() => tbId && approveTbMut.mutate(tbId)}
                title="Sign off on this analysis"
                style={{ borderColor: "var(--green)", color: "var(--green)" }}
              >
                <span className="hidden sm:inline">Approve</span>
              </Button>
            )}
            {/* Approved badge in place of the button once signed off */}
            {showVarianceTable && selectedTb && selectedTb.approved_at && (
              <span className="hidden sm:inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold"
                style={{ background: "var(--green-subtle)", color: "var(--green)" }}
                title={`Approved on ${new Date(selectedTb.approved_at).toLocaleString()}`}
              >
                <CheckCircle2 size={11} strokeWidth={2} />
                Approved
              </span>
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

        {/* ── Animated content ── */}
        <div className="flex-1 overflow-hidden relative">
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

              {showVarianceTable && (
                <div className="px-4 sm:px-6 pt-3">
                  <FluxKpiStrip
                    rows={variances}
                    onRunAgentic={() => runAgenticFluxMut.mutate()}
                    isRunning={runAgenticFluxMut.isPending}
                  />
                </div>
              )}

              {showVarianceTable && (
                <VarianceTable
                  tbId={tbId!}
                  rows={variances}
                  isLoading={variancesLoading}
                  onExport={handleExport}
                  periodCurrent={selectedTb?.period_current}
                  periodPrior={selectedTb?.period_prior}
                />
              )}

              {/* AI-working overlay — appears while the agentic-flux
                  run is in flight. Stop button signals cooperative
                  cancel; the run exits after the current variance. */}
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

            </motion.div>
          </AnimatePresence>
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
    try {
      return new Date(iso + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
    } catch { return iso }
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

function FluxKpiStrip({
  rows, onRunAgentic, isRunning,
}: { rows: VarianceRow[]; onRunAgentic: () => void; isRunning: boolean }) {
  const total = rows.length
  const material = rows.filter((r) => r.is_material)
  const approved = material.filter((r) => r.status === "approved")
  const withNarrative = material.filter((r) =>
    r.status === "generated" || r.status === "edited" || r.status === "approved",
  )
  const totalAbsVar = rows.reduce((s, r) => s + Math.abs(parseFloat(r.dollar_variance) || 0), 0)
  const approvalPct = material.length > 0
    ? Math.round((approved.length / material.length) * 100)
    : 0
  const coveragePct = material.length > 0
    ? Math.round((withNarrative.length / material.length) * 100)
    : 0
  const pendingMaterial = material.length - withNarrative.length

  // Run-AI button label + style based on state
  const runLabel = isRunning
    ? "Running…"
    : pendingMaterial > 0
      ? `Run AI on ${pendingMaterial} pending`
      : "All material commented"

  return (
    <div className="rounded-xl p-3 sm:p-4 mb-3"
      style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
        <FluxKpi
          label="Material variances"
          value={String(material.length)}
          sub={total > 0 ? `of ${total} total` : "no variances"}
          tone={material.length > 0 ? "var(--text)" : "var(--text-muted)"} />
        <FluxKpi
          label="Total |variance|"
          value={fmtMoneyShort(totalAbsVar)}
          sub="sum of absolute movements"
          tone="var(--text)" />
        <FluxKpi
          label="Approval"
          value={`${approved.length} / ${material.length}`}
          sub={material.length > 0 ? `${approvalPct}% of material` : "—"}
          tone={approvalPct === 100 && material.length > 0 ? "var(--green)" : "var(--text)"} />
        <FluxKpi
          label="AI coverage"
          value={`${withNarrative.length} / ${material.length}`}
          sub={material.length > 0 ? `${coveragePct}% commentary written` : "—"}
          tone={coveragePct === 100 && material.length > 0 ? "var(--green)" : "var(--text)"} />
      </div>

      {/* Agentic Mode CTA — bottom row of the KPI card */}
      <div className="pt-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2"
        style={{ borderTop: "1px solid var(--border)" }}>
        <div className="flex items-center gap-2">
          <span className="h-7 w-7 rounded-md flex items-center justify-center shrink-0"
            style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
            <Sparkles size={14} strokeWidth={1.8} />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-wider" style={{ color: "var(--text)" }}>
              Agentic Mode
            </p>
            <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
              AI writes commentary for every material variance — biggest movers first.
            </p>
          </div>
        </div>
        <Button
          size="sm"
          loading={isRunning}
          disabled={isRunning || pendingMaterial === 0}
          icon={<Sparkles size={12} strokeWidth={1.8} />}
          onClick={onRunAgentic}
        >
          {runLabel}
        </Button>
      </div>
    </div>
  )
}

function FluxKpi({ label, value, sub, tone }: { label: string; value: string; sub: string; tone: string }) {
  return (
    <div className="rounded-lg p-3"
      style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
      <p className="text-[10px] font-bold uppercase tracking-wider mb-1" style={{ color: "var(--text-muted)" }}>{label}</p>
      <p className="text-lg sm:text-xl font-bold tabular-nums leading-tight" style={{ color: tone }}>{value}</p>
      <p className="text-[10px] mt-0.5" style={{ color: "var(--text-muted)" }}>{sub}</p>
    </div>
  )
}

function fmtMoneyShort(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `$${(abs / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000) return `$${(abs / 1_000).toFixed(1)}K`
  return `$${abs.toFixed(0)}`
}
