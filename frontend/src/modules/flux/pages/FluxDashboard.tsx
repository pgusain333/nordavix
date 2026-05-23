/**
 * FluxDashboard — main Flux Analysis workspace.
 *
 * Layout:
 *   Left panel (240px): list of trial balance runs + "New Analysis" button
 *   Right panel (flex-1): UploadFlow wizard OR VarianceTable based on TB status
 *
 * State machine for the right panel:
 *   no selection           → welcome / empty state
 *   status = pending       → UploadFlow
 *   status = processing    → processing spinner
 *   status = generating    → generating spinner
 *   status = parsed | ready_for_review | complete  → VarianceTable
 *   status = error         → error state
 */
import { useEffect } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  BarChart3,
  Plus,
  AlertCircle,
  RefreshCw,
  Download,
} from "lucide-react"
import { api, type TrialBalance } from "@/modules/flux/api"
import { UploadFlow } from "@/modules/flux/components/UploadFlow"
import { VarianceTable } from "@/modules/flux/components/VarianceTable"
import { Button, Spinner } from "@/core/ui/components"
import { cn } from "@/core/ui/utils"

const STATUS_COLORS: Record<string, string> = {
  pending:          "bg-ink-200",
  processing:       "bg-material",
  parsed:           "bg-blue-400",
  ready_for_review: "bg-blue-400",
  generating:       "bg-material",
  complete:         "bg-green",
  error:            "bg-unfav",
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

export function FluxDashboard() {
  const { tbId }   = useParams<{ tbId?: string }>()
  const navigate   = useNavigate()
  const qc         = useQueryClient()

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

  // Auto-select first TB when none is selected
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

  function handleNewAnalysis() {
    navigate("/app/flux")
  }

  function handleTbComplete(tb: TrialBalance) {
    qc.invalidateQueries({ queryKey: ["trial-balances"] })
    navigate(`/app/flux/${tb.id}`)
  }

  function handleExport() {
    if (tbId) api.exportExcel(tbId)
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const showUploadFlow = !tbId || (selectedTb && selectedTb.status === "pending")
  const showVarianceTable = selectedTb &&
    ["parsed", "ready_for_review", "generating", "complete"].includes(selectedTb.status)
  const showProcessing = selectedTb && selectedTb.status === "processing"
  const showError      = selectedTb && selectedTb.status === "error"

  return (
    <div className="flex h-full overflow-hidden">

      {/* ── Left panel: TB list ── */}
      <div className={cn(
        "flex h-full shrink-0 flex-col",
        // Mobile: full width when no TB selected, hidden when TB selected
        "w-full lg:w-56",
        tbId ? "hidden lg:flex" : "flex",
        // Desktop: always show with border
        "lg:border-r",
      )}
        style={{ background: "var(--surface)", borderColor: "var(--border)" }}
      >
        <div className="flex items-center justify-between px-3 py-3"
          style={{ borderBottom: "1px solid var(--border)" }}>
          <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
            Runs
          </span>
          <Button
            size="icon-sm"
            variant="ghost"
            title="New analysis"
            onClick={handleNewAnalysis}
          >
            <Plus size={16} strokeWidth={1.6} />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto py-1">
          {tbsLoading ? (
            <div className="flex items-center justify-center py-8">
              <Spinner className="h-4 w-4" />
            </div>
          ) : tbs.length === 0 ? (
            <div className="px-3 py-6 text-center">
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>No runs yet</p>
              <button
                className="text-xs mt-1 hover:underline"
                style={{ color: "var(--green)" }}
                onClick={handleNewAnalysis}
              >
                Start first run
              </button>
            </div>
          ) : (
            tbs.map((tb) => {
              const isActive = tb.id === tbId
              return (
                <button
                  key={tb.id}
                  className={cn(
                    "w-full text-left px-3 py-2.5 flex items-start gap-2 transition-colors",
                  )}
                  style={isActive
                    ? { background: "var(--surface-2)", borderRight: "2px solid var(--green)" }
                    : {}}
                  onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = "var(--surface-2)" }}
                  onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = "" }}
                  onClick={() => navigate(`/app/flux/${tb.id}`)}
                >
                  <span className={cn(
                    "mt-1.5 h-1.5 w-1.5 rounded-full shrink-0",
                    STATUS_COLORS[tb.status] ?? "bg-ink-200"
                  )} />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium truncate text-theme">
                      {tb.name}
                    </p>
                    <p className="text-[10px] mt-0.5 tabular-nums" style={{ color: "var(--text-muted)" }}>
                      {new Date(tb.period_current).toLocaleDateString("en-US", {
                        month: "short", year: "numeric"
                      })}
                    </p>
                    <span className="text-[9px] font-semibold uppercase tracking-wider"
                      style={{ color:
                        tb.status === "complete" ? "var(--green)" :
                        tb.status === "error" ? "#dc2626" :
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
      </div>

      {/* ── Right panel: content — hidden on mobile when no TB selected ── */}
      <div className={cn(
        "flex flex-1 flex-col overflow-hidden min-w-0",
        !tbId ? "hidden lg:flex" : "flex",
      )}
        style={{ background: "var(--bg)" }}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 sm:px-6 py-3.5 shrink-0"
          style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>

          {/* Mobile back button */}
          <button
            className="lg:hidden flex items-center justify-center h-7 w-7 rounded-md mr-1 transition-colors text-theme-2"
            style={{ background: "var(--surface-2)" }}
            onClick={() => navigate("/app/flux")}
          >
            <BarChart3 size={15} strokeWidth={1.6} />
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
                  background: selectedTb.status === "complete" ? "var(--green-subtle)" :
                    selectedTb.status === "error" ? "#fee2e2" :
                    ["generating","processing"].includes(selectedTb.status) ? "#fef3c7" : "var(--surface-2)",
                  color: selectedTb.status === "complete" ? "var(--green)" :
                    selectedTb.status === "error" ? "#dc2626" :
                    ["generating","processing"].includes(selectedTb.status) ? "#92400e" : "var(--text-2)",
                }}>
                <span className="h-1.5 w-1.5 rounded-full" style={{
                  background: selectedTb.status === "complete" ? "var(--green)" :
                    selectedTb.status === "error" ? "#dc2626" :
                    ["generating","processing"].includes(selectedTb.status) ? "#f59e0b" : "var(--border-strong)",
                }} />
                {STATUS_LABELS[selectedTb.status] ?? selectedTb.status}
              </span>
            )}
            {showVarianceTable && (
              <Button variant="outline" size="sm" icon={<Download size={14} strokeWidth={1.6} />} onClick={handleExport}>
                <span className="hidden sm:inline">Export</span>
              </Button>
            )}
            <Button size="sm" icon={<Plus size={14} strokeWidth={1.6} />} onClick={handleNewAnalysis}>
              <span className="hidden sm:inline">New Analysis</span>
            </Button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden">

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

          {!tbId && !tbsLoading && tbs.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center p-8">
              <div className="h-14 w-14 rounded-full flex items-center justify-center mb-4" style={{ background: "var(--surface-2)" }}>
                <BarChart3 size={28} strokeWidth={1.6} style={{ color: "var(--text-muted)" }} />
              </div>
              <p className="text-base font-semibold text-theme mb-2">No flux runs yet</p>
              <p className="text-sm max-w-sm leading-relaxed mb-5" style={{ color: "var(--text-muted)" }}>
                Upload a trial balance or connect QuickBooks to generate your first AI-powered variance commentary.
              </p>
              <Button icon={<Plus size={16} strokeWidth={1.6} />} onClick={handleNewAnalysis}>
                Start First Analysis
              </Button>
            </div>
          )}

        </div>
      </div>
    </div>
  )
}
