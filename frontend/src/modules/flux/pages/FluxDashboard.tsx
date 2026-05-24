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
import { useEffect, useState } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { motion, AnimatePresence } from "framer-motion"
import {
  Plus,
  AlertCircle,
  RefreshCw,
  Download,
  X,
  History,
  RotateCcw,
  Trash2,
  Sparkles,
} from "lucide-react"
import { api, type TrialBalance } from "@/modules/flux/api"
import { UploadFlow } from "@/modules/flux/components/UploadFlow"
import { VarianceTable } from "@/modules/flux/components/VarianceTable"
import { Button, Spinner } from "@/core/ui/components"

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

  /** Controls the mobile slide-in analyses list overlay */
  const [showMobileHistory, setShowMobileHistory] = useState(false)

  /** Two-step confirm for destructive actions: null | "reset" | "delete" */
  const [pendingAction, setPendingAction] = useState<"reset" | "delete" | null>(null)

  /** Transient banner shown after Find-reasons runs ("Queued X analyses…") */
  const [runMsg, setRunMsg] = useState<{ kind: "ok" | "info" | "err"; text: string } | null>(null)

  // List of all TBs
  const { data: tbs = [], isLoading: tbsLoading } = useQuery({
    queryKey: ["trial-balances"],
    queryFn:  api.listTrialBalances,
    staleTime: 20_000,
    refetchInterval: 10_000,
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

  // QBO connection status
  const { data: qboConn } = useQuery({
    queryKey: ["qbo-connection"],
    queryFn:  api.getQboConnection,
    staleTime: 60_000,
  })

  // Auto-select most recent TB when none is selected (desktop UX convenience)
  useEffect(() => {
    if (!tbId && tbs.length > 0) {
      navigate(`/app/flux/${tbs[0].id}`, { replace: true })
    }
  }, [tbs, tbId, navigate])

  // Poll selected TB if it's processing/generating
  useEffect(() => {
    if (!selectedTb) return
    if (!["processing", "generating"].includes(selectedTb.status)) return
    const interval = setInterval(() => {
      qc.invalidateQueries({ queryKey: ["trial-balances"] })
    }, 5_000)
    return () => clearInterval(interval)
  }, [selectedTb?.id, selectedTb?.status, qc])

  // Close mobile history overlay when a TB is selected
  useEffect(() => {
    if (tbId) setShowMobileHistory(false)
  }, [tbId])

  function handleNewAnalysis() {
    navigate("/app/flux")
    setShowMobileHistory(false)
  }

  function handleTbComplete(tb: TrialBalance) {
    qc.invalidateQueries({ queryKey: ["trial-balances"] })
    navigate(`/app/flux/${tb.id}`)
  }

  function handleExport() {
    if (tbId) api.exportExcel(tbId)
  }

  // Reset wipes the data; the user stays on this analysis and re-uploads.
  const resetMut = useMutation({
    mutationFn: (id: string) => api.resetTrialBalance(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["trial-balances"] })
      qc.invalidateQueries({ queryKey: ["variances", tbId] })
      setPendingAction(null)
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

  const showUploadFlow    = !tbId || (selectedTb && selectedTb.status === "pending")
  const showVarianceTable = selectedTb &&
    ["parsed", "ready_for_review", "generating", "complete"].includes(selectedTb.status)
  const showProcessing = selectedTb && selectedTb.status === "processing"
  const showError      = selectedTb && selectedTb.status === "error"

  // Key drives AnimatePresence exit+enter on content changes
  const contentKey = showUploadFlow ? "upload"
    : showProcessing ? "processing"
    : showError      ? "error"
    : showVarianceTable ? `variance-${tbId}`
    : "upload"

  // ── Shared analyses list (used in both desktop sidebar + mobile overlay) ──
  const AnalysesList = () => (
    <>
      <div className="flex items-center justify-between px-3 py-3"
        style={{ borderBottom: "1px solid var(--border)" }}>
        <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
          Analyses
        </span>
        <div className="flex items-center gap-1">
          {/* Mobile close button */}
          <button
            className="lg:hidden flex items-center justify-center h-6 w-6 rounded-md text-theme-muted hover:text-theme transition-colors"
            onClick={() => setShowMobileHistory(false)}
          >
            <X size={15} strokeWidth={1.6} />
          </button>
          <Button size="icon-sm" variant="ghost" title="New analysis" onClick={handleNewAnalysis}>
            <Plus size={16} strokeWidth={1.6} />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {tbsLoading ? (
          <div className="flex items-center justify-center py-8">
            <Spinner className="h-4 w-4" />
          </div>
        ) : tbs.length === 0 ? (
          <div className="px-3 py-6 text-center">
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>No analyses yet</p>
            <button className="text-xs mt-1 hover:underline" style={{ color: "var(--green)" }}
              onClick={handleNewAnalysis}>
              Start first run
            </button>
          </div>
        ) : (
          tbs.map((tb) => {
            const isActive = tb.id === tbId
            return (
              <button
                key={tb.id}
                className="w-full text-left px-3 py-2.5 flex items-start gap-2 transition-colors duration-150"
                style={isActive
                  ? { background: "var(--surface-2)", borderRight: "2px solid var(--green)" }
                  : {}}
                onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = "var(--surface-2)" }}
                onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = "" }}
                onClick={() => { navigate(`/app/flux/${tb.id}`); setShowMobileHistory(false) }}
              >
                <span
                  className="mt-1.5 h-1.5 w-1.5 rounded-full shrink-0"
                  style={{ background: STATUS_DOT[tb.status] ?? "var(--border-strong)" }}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium truncate text-theme">{tb.name}</p>
                  <p className="text-[10px] mt-0.5 tabular-nums" style={{ color: "var(--text-muted)" }}>
                    {new Date(tb.period_current).toLocaleDateString("en-US", { month: "short", year: "numeric" })}
                  </p>
                  <span className="text-[9px] font-semibold uppercase tracking-wider"
                    style={{ color:
                      tb.status === "complete"  ? "var(--green)" :
                      tb.status === "error"     ? "#dc2626" :
                      ["generating","processing"].includes(tb.status) ? "#92400e" :
                      "var(--text-muted)"
                    }}>
                    {STATUS_LABELS[tb.status] ?? tb.status}
                  </span>
                </div>
              </button>
            )
          })
        )}
      </div>
    </>
  )

  return (
    <div className="flex h-full overflow-hidden relative">

      {/* ── Left panel: desktop sidebar (hidden on mobile) ── */}
      <div
        className="hidden lg:flex h-full w-56 shrink-0 flex-col border-r"
        style={{ background: "var(--surface)", borderColor: "var(--border)" }}
      >
        <AnalysesList />
      </div>

      {/* ── Mobile overlay: analyses list slides in ── */}
      <AnimatePresence>
        {showMobileHistory && (
          <>
            {/* Backdrop */}
            <motion.div
              key="backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="lg:hidden absolute inset-0 z-20"
              style={{ background: "rgba(0,0,0,0.4)" }}
              onClick={() => setShowMobileHistory(false)}
            />
            {/* Drawer */}
            <motion.div
              key="drawer"
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ duration: 0.22, ease: "easeOut" as const }}
              className="lg:hidden absolute left-0 top-0 bottom-0 z-30 flex flex-col w-72"
              style={{ background: "var(--surface)", borderRight: "1px solid var(--border)" }}
            >
              <AnalysesList />
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* ── Right panel: always visible ── */}
      <div
        className="flex flex-1 flex-col overflow-hidden min-w-0"
        style={{ background: "var(--bg)" }}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 sm:px-6 py-3.5 shrink-0"
          style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>

          {/* Mobile: history toggle button */}
          <button
            className="lg:hidden flex items-center justify-center h-7 w-7 rounded-md mr-1 transition-colors text-theme-2"
            style={{ background: "var(--surface-2)" }}
            title="View analyses"
            onClick={() => setShowMobileHistory(true)}
          >
            <History size={15} strokeWidth={1.6} />
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

          <div className="flex items-center gap-2 shrink-0">
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

              {showUploadFlow && (
                <div className="h-full overflow-y-auto">
                  <UploadFlow onComplete={handleTbComplete} qboConnected={!!qboConn} />
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
                <VarianceTable tbId={tbId!} rows={variances} isLoading={variancesLoading} onExport={handleExport} />
              )}

            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}
