/**
 * AiDetectFixedAssetBanner — capitalization-miss detection banner
 * for the Fixed Assets page. Mirrors AiDetectBanner (prepaid) but
 * surfaces capitalization-specific fields: asset description,
 * category (Computer Hardware / Office Furniture / etc.), and
 * useful-life suggestion.
 *
 * State machine matches the prepaid banner:
 *   [empty]    no candidates loaded     → Big "Scan GL for missed capitalizations" CTA
 *   [scanning] POST /fixed_asset/ai/scan inflight → spinner
 *   [results]  N candidates returned    → list with Capitalize / Not a fixed asset
 *   [done]     0 candidates returned    → "All clear" tile
 *
 * Each result row shows:
 *   ✨ asset description (clean name from AI)        $cost     in-service date
 *   GL account · category · useful life · confidence chip
 *   AI reasoning (one line)
 *   [ Capitalize ]  [ Not a fixed asset ]
 *
 * Confidence chip: high (>=0.80, green) / med (0.50-0.79, amber) /
 * low (<0.50, gray). Low-confidence rows are still shown but cued for
 * extra scrutiny.
 */
import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { motion, AnimatePresence } from "framer-motion"
import {
  Sparkles, ScanLine, X, Plus, AlertCircle, CheckCircle2, RefreshCw, ChevronDown, ChevronRight,
} from "lucide-react"

import { Button, Spinner } from "@/core/ui/components"
import { formatDate } from "@/core/lib/dates"
import { schedulesApi } from "@/modules/schedules/api"
import { SuggestedJePreview } from "@/modules/schedules/components/SuggestedJePreview"
import type { FixedAssetCandidate } from "@/modules/schedules/types"

interface Props {
  periodEnd: string
  /** Called when the user clicks "Capitalize" — parent opens the
   * FADialog pre-filled with the candidate's data and on save also
   * fires the accept API to record the linkage. */
  onAccept: (candidate: FixedAssetCandidate) => void
}

export function AiDetectFixedAssetBanner({ periodEnd, onAccept }: Props) {
  const qc = useQueryClient()
  const [collapsed, setCollapsed] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { data: listData } = useQuery({
    queryKey: ["schedules", "fixed_asset", "ai-candidates"],
    queryFn:  () => schedulesApi.listFixedAssetCandidates("open"),
    staleTime: 30_000,
  })

  const scanMut = useMutation({
    mutationFn: () => schedulesApi.scanForFixedAssetCandidates(periodEnd),
    onSuccess: () => {
      setError(null)
      qc.invalidateQueries({ queryKey: ["schedules", "fixed_asset", "ai-candidates"] })
    },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { detail?: string } } }).response?.data?.detail
      setError(msg ?? "Scan failed — try again in a moment.")
    },
  })

  const dismissMut = useMutation({
    mutationFn: (id: string) => schedulesApi.dismissFixedAssetCandidate(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["schedules", "fixed_asset", "ai-candidates"] }),
  })

  const candidates = useMemo(
    () => (scanMut.data?.candidates ?? listData?.candidates ?? []) as FixedAssetCandidate[],
    [scanMut.data, listData],
  )
  const scanned = scanMut.data
  const hasResults = candidates.length > 0
  const isScanning = scanMut.isPending

  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      className="rounded-xl overflow-hidden"
      style={{
        background: "var(--surface)",
        border: `1px solid ${hasResults ? "rgba(84, 88, 138, 0.30)" : "var(--border)"}`,
        boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
      }}
    >
      {/* Header */}
      <div className="px-4 py-3 flex items-center gap-3"
        style={{ background: hasResults ? "rgba(84, 88, 138, 0.06)" : "var(--surface)" }}>
        <span className="h-7 w-7 rounded-lg inline-flex items-center justify-center shrink-0"
          style={{ background: "rgba(84, 88, 138, 0.12)", color: "#54588a" }}>
          <Sparkles size={13} strokeWidth={2} />
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold" style={{ color: "var(--text)" }}>
            AI missed-capitalization detection
          </p>
          <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
            {isScanning ? (
              <>Scanning expense GL for items that should have been capitalized…</>
            ) : hasResults ? (
              <>
                <span className="font-semibold" style={{ color: "#54588a" }}>
                  {candidates.length} {candidates.length === 1 ? "candidate" : "candidates"} found
                </span>
                {" — review each and capitalize or dismiss"}
              </>
            ) : scanned ? (
              <>
                Scanned {scanned.scanned_txns} txns across {scanned.scanned_accounts} expense accounts —
                nothing looks like a missed capitalization.
              </>
            ) : (
              <>Scan the period's GL to find expenses that should have been capitalized as fixed assets.</>
            )}
          </p>
        </div>
        {hasResults && (
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            className="text-[11px] font-medium uppercase tracking-wider px-2 transition-colors hover:opacity-80"
            style={{ color: "#54588a" }}
          >
            {collapsed ? "Show" : "Hide"}
          </button>
        )}
        <Button
          size="sm"
          variant={hasResults ? "ghost" : undefined}
          onClick={() => scanMut.mutate()}
          loading={isScanning}
          disabled={isScanning}
          title={hasResults ? "Re-scan for new candidates" : "Run AI scan over the period's GL"}
        >
          {isScanning ? "Scanning…"
            : hasResults ? <><RefreshCw size={11} strokeWidth={2} /> Re-scan</>
            : <><ScanLine size={11} strokeWidth={2} /> Scan GL for missed capitalizations</>}
        </Button>
      </div>

      {/* Error band */}
      {error && (
        <div className="px-4 py-2 text-[11px]"
          style={{ background: "#f7eeec", color: "#86332e", borderTop: "1px solid #ecd7d3" }}>
          {error}
        </div>
      )}

      {/* Empty (no scan yet) — friendly explainer */}
      {!hasResults && !isScanning && !scanned && !error && (
        <div className="px-4 pb-4 pt-1">
          <div className="rounded-lg p-3 text-[12px]"
            style={{ background: "rgba(84, 88, 138, 0.04)", color: "var(--text-2)" }}>
            <p className="leading-relaxed">
              When you scan, the AI looks at every journal entry at or above{" "}
              <span className="font-mono font-semibold">$1,000</span> hitting expense accounts and flags
              ones that meet US-GAAP capitalization criteria: a tangible asset with useful life over a year
              at or above your capitalization threshold.
              {" "}For each, it suggests an asset category (Computer Hardware, Office Furniture, Machinery,
              Vehicle, etc.) and a useful life in months. You always have the final say.
            </p>
          </div>
        </div>
      )}

      {/* Results list */}
      <AnimatePresence initial={false}>
        {hasResults && !collapsed && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            style={{ overflow: "hidden" }}
          >
            <div className="px-4 pb-3 pt-1 space-y-1.5">
              {candidates.map((c) => (
                <CandidateRow
                  key={c.id}
                  candidate={c}
                  onAccept={() => onAccept(c)}
                  onDismiss={() => dismissMut.mutate(c.id)}
                  isDismissing={dismissMut.isPending && dismissMut.variables === c.id}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Done — all clear */}
      {!hasResults && scanned && !isScanning && (
        <div className="px-4 pb-4 pt-1">
          <div className="rounded-lg px-3 py-2.5 inline-flex items-center gap-2 text-[12px]"
            style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
            <CheckCircle2 size={13} strokeWidth={2} />
            All clear — no missed capitalizations in this period.
          </div>
        </div>
      )}
    </motion.div>
  )
}


// ── Per-candidate row ──────────────────────────────────────────────────

function CandidateRow({
  candidate, onAccept, onDismiss, isDismissing,
}: {
  candidate: FixedAssetCandidate
  onAccept:    () => void
  onDismiss:   () => void
  isDismissing: boolean
}) {
  const [showJe, setShowJe] = useState(false)
  const amount = parseFloat(candidate.gl_amount) || 0
  const amountFmt = `$${amount.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
  const conf = parseFloat(candidate.ai_confidence) || 0
  const lifeMo = candidate.ai_useful_life_months
  const lifeLabel = lifeMo
    ? lifeMo % 12 === 0
      ? `${lifeMo / 12}-yr life`
      : `${lifeMo}-mo life`
    : null

  const confTone =
    conf >= 0.8 ? { bg: "var(--green-subtle)", fg: "var(--green)", label: "High" }
    : conf >= 0.5 ? { bg: "#f4eddf", fg: "#7a5622", label: "Med" }
    : { bg: "var(--surface-2)", fg: "var(--text-muted)", label: "Low" }

  // Asset name preference: AI's clean description > vendor > memo > placeholder
  const displayName =
    candidate.ai_description ||
    candidate.ai_vendor ||
    candidate.gl_vendor ||
    candidate.gl_memo ||
    "(no description)"

  return (
    <div className="rounded-lg p-3 transition-colors"
      style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "rgba(84, 88, 138, 0.40)" }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--border)" }}
    >
      <div className="flex items-start gap-3 flex-wrap sm:flex-nowrap">
        <span className="h-7 w-7 rounded-md inline-flex items-center justify-center shrink-0 mt-0.5"
          style={{ background: "white", color: "#54588a", border: "1px solid var(--border)" }}>
          <Sparkles size={12} strokeWidth={2} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold truncate" style={{ color: "var(--text)" }}>
              {displayName}
            </p>
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded font-semibold"
              style={{ background: "white", color: "var(--text)", border: "1px solid var(--border)" }}>
              {amountFmt}
            </span>
            <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
              style={{ background: confTone.bg, color: confTone.fg }}>
              {confTone.label} confidence
            </span>
          </div>
          <p className="text-[11px] mt-0.5 truncate" style={{ color: "var(--text-2)" }}>
            <span className="font-medium">{candidate.gl_account_name}</span>
            {" · "}{formatDate(candidate.gl_txn_date)}
            {candidate.ai_category ? <> · <span className="font-medium">{candidate.ai_category}</span></> : null}
            {lifeLabel ? <> · {lifeLabel}</> : null}
          </p>
          {candidate.ai_reasoning && (
            <p className="text-[11px] italic mt-1 leading-relaxed" style={{ color: "var(--text-muted)" }}>
              AI: {candidate.ai_reasoning}
            </p>
          )}
          <button
            type="button"
            onClick={() => setShowJe((v) => !v)}
            className="mt-1.5 inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider transition-colors hover:opacity-80"
            style={{ color: "#54588a" }}
          >
            {showJe
              ? <><ChevronDown size={11} strokeWidth={2} /> Hide suggested entries</>
              : <><ChevronRight size={11} strokeWidth={2} /> Show suggested journal entries</>
            }
          </button>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={onAccept}
            disabled={isDismissing}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[11px] font-semibold transition-opacity hover:opacity-90 disabled:opacity-40"
            style={{ background: "#2e7a55", color: "white" }}
            title="Open the New Asset dialog pre-filled with this candidate"
          >
            <Plus size={11} strokeWidth={2.4} /> Capitalize
          </button>
          <button
            type="button"
            onClick={onDismiss}
            disabled={isDismissing}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[11px] font-semibold transition-colors disabled:opacity-40"
            style={{ background: "white", color: "var(--text-2)", border: "1px solid var(--border)" }}
            title="Not a fixed asset — silence this suggestion permanently"
          >
            {isDismissing ? <Spinner className="h-3 w-3" /> : <AlertCircle size={11} strokeWidth={2} />}
            Not a fixed asset
          </button>
          <button
            type="button"
            onClick={onDismiss}
            disabled={isDismissing}
            className="sm:hidden inline-flex items-center justify-center h-7 w-7 rounded-md transition-colors disabled:opacity-40"
            style={{ color: "var(--text-muted)" }}
            title="Dismiss"
          >
            <X size={12} strokeWidth={2} />
          </button>
        </div>
      </div>
      {showJe && <SuggestedJePreview kind="fixed_asset" candidate={candidate} />}
    </div>
  )
}
