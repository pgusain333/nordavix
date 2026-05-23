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
      <div className="flex h-full w-56 shrink-0 flex-col border-r border-ink-100 bg-white">
        <div className="flex items-center justify-between px-3 py-3 border-b border-ink-100">
          <span className="text-xs font-semibold text-ink-600 uppercase tracking-wide">
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
              <p className="text-xs text-ink-400">No runs yet</p>
              <button
                className="text-xs text-green hover:underline mt-1"
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
                    isActive
                      ? "bg-ink-50 border-r-2 border-green"
                      : "hover:bg-ink-50"
                  )}
                  onClick={() => navigate(`/app/flux/${tb.id}`)}
                >
                  <span className={cn(
                    "mt-1.5 h-1.5 w-1.5 rounded-full shrink-0",
                    STATUS_COLORS[tb.status] ?? "bg-ink-200"
                  )} />
                  <div className="min-w-0 flex-1">
                    <p className={cn(
                      "text-xs font-medium truncate",
                      isActive ? "text-ink" : "text-ink-600"
                    )}>
                      {tb.name}
                    </p>
                    <p className="text-[10px] text-ink-400 mt-0.5 tabular-nums">
                      {new Date(tb.period_current).toLocaleDateString("en-US", {
                        month: "short", year: "numeric"
                      })}
                    </p>
                    <span className={cn(
                      "text-[9px] font-semibold uppercase tracking-wider",
                      tb.status === "complete" ? "text-green" :
                      tb.status === "error" ? "text-unfav" :
                      ["generating", "processing"].includes(tb.status) ? "text-material" :
                      "text-ink-400"
                    )}>
                      {STATUS_LABELS[tb.status] ?? tb.status}
                    </span>
                  </div>
                </button>
              )
            })
          )}
        </div>
      </div>

      {/* ── Right panel: content ── */}
      <div className="flex flex-1 flex-col overflow-hidden bg-ink-50 min-w-0">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-3.5 bg-white border-b border-ink-100 shrink-0">
          <div>
            {selectedTb ? (
              <>
                <h1 className="text-sm font-semibold text-ink">{selectedTb.name}</h1>
                <p className="text-xs text-ink-400 mt-0.5">
                  {new Date(selectedTb.period_prior).toLocaleDateString("en-US", { month: "short", year: "numeric" })}
                  {" → "}
                  {new Date(selectedTb.period_current).toLocaleDateString("en-US", { month: "short", year: "numeric" })}
                  {" · materiality $"}
                  {parseFloat(selectedTb.materiality_threshold).toLocaleString()}
                </p>
              </>
            ) : (
              <>
                <h1 className="text-sm font-semibold text-ink">Flux Analysis</h1>
                <p className="text-xs text-ink-400 mt-0.5">AI-powered month-end variance commentary</p>
              </>
            )}
          </div>

          <div className="flex items-center gap-2">
            {selectedTb && (
              <span className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium",
                selectedTb.status === "complete" ? "bg-green-50 text-green-600" :
                selectedTb.status === "error" ? "bg-unfav-light text-unfav" :
                ["generating", "processing"].includes(selectedTb.status) ? "bg-material-light text-material" :
                "bg-ink-100 text-ink-600"
              )}>
                <span className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  selectedTb.status === "complete" ? "bg-green" :
                  selectedTb.status === "error" ? "bg-unfav" :
                  ["generating", "processing"].includes(selectedTb.status) ? "bg-material animate-pulse" :
                  "bg-ink-400"
                )} />
                {STATUS_LABELS[selectedTb.status] ?? selectedTb.status}
              </span>
            )}
            {showVarianceTable && (
              <Button
                variant="outline"
                size="sm"
                icon={<Download size={14} strokeWidth={1.6} />}
                onClick={handleExport}
              >
                Export
              </Button>
            )}
            <Button
              size="sm"
              icon={<Plus size={14} strokeWidth={1.6} />}
              onClick={handleNewAnalysis}
            >
              New Analysis
            </Button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden">

          {/* Upload flow — shown when no TB selected or TB is pending */}
          {showUploadFlow && (
            <div className="h-full overflow-y-auto">
              <UploadFlow
                onComplete={handleTbComplete}
                qboConnected={!!qboConn}
              />
            </div>
          )}

          {/* Processing */}
          {showProcessing && (
            <div className="flex flex-col items-center justify-center h-full text-center p-8">
              <div className="relative h-16 w-16 mb-5">
                <div className="absolute inset-0 rounded-full bg-material-light animate-ping opacity-40" />
                <div className="relative h-16 w-16 rounded-full bg-material-light flex items-center justify-center">
                  <Spinner className="text-material h-7 w-7" />
                </div>
              </div>
              <p className="text-base font-semibold text-ink mb-2">Processing your file…</p>
              <p className="text-sm text-ink-400 max-w-xs leading-relaxed">
                We're reading your trial balance and computing variances. This usually takes a few seconds.
              </p>
            </div>
          )}

          {/* Error */}
          {showError && (
            <div className="flex flex-col items-center justify-center h-full text-center p-8">
              <div className="h-14 w-14 rounded-full bg-unfav-light flex items-center justify-center mb-4">
                <AlertCircle size={28} strokeWidth={1.6} className="text-unfav" />
              </div>
              <p className="text-base font-semibold text-ink mb-2">Processing failed</p>
              <p className="text-sm text-ink-400 max-w-xs leading-relaxed mb-2">
                {selectedTb?.error_detail ?? "An error occurred while processing your file."}
              </p>
              <p className="text-xs text-ink-400 mb-5">
                Please check your file format and try uploading again.
              </p>
              <Button
                variant="outline"
                size="sm"
                icon={<RefreshCw size={14} strokeWidth={1.6} />}
                onClick={handleNewAnalysis}
              >
                Try Again
              </Button>
            </div>
          )}

          {/* Variance Table */}
          {showVarianceTable && (
            <VarianceTable
              tbId={tbId!}
              rows={variances}
              isLoading={variancesLoading}
              onExport={handleExport}
            />
          )}

          {/* Empty state — no TB selected, no TBs exist */}
          {!tbId && !tbsLoading && tbs.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center p-8">
              <div className="h-14 w-14 rounded-full bg-ink-50 flex items-center justify-center mb-4">
                <BarChart3 size={28} strokeWidth={1.6} className="text-ink-400" />
              </div>
              <p className="text-base font-semibold text-ink mb-2">No flux runs yet</p>
              <p className="text-sm text-ink-400 max-w-sm leading-relaxed mb-5">
                Upload a trial balance or connect QuickBooks to generate your first AI-powered variance commentary.
              </p>
              <Button
                icon={<Plus size={16} strokeWidth={1.6} />}
                onClick={handleNewAnalysis}
              >
                Start First Analysis
              </Button>
            </div>
          )}

        </div>
      </div>
    </div>
  )
}
