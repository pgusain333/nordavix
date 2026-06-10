/**
 * AiDetectBanner — Phase 2 of the AI-prepaids spec.
 *
 * Surfaces AI-detected potential prepaid items found by scanning the
 * current period's expense-account GL. The user explicitly triggers
 * each scan ("On user click" trigger model chosen in design Q&A).
 *
 * State machine:
 *   [empty]    no candidates loaded     → Big "Scan GL for prepaids" CTA
 *   [scanning] POST /prepaid/ai/scan inflight → animated progress
 *   [results]  N candidates returned    → list with Accept / Dismiss
 *   [done]     0 candidates returned    → "All clear — nothing missed" tile
 *
 * Each result row shows:
 *   ✨ vendor (or memo)       $amount       MM-DD-YYYY
 *   GL account · service period suggestion · confidence chip
 *   AI reasoning (one line)
 *   [ Add to schedule ]  [ Not a prepaid ]
 *
 * Confidence chip: high (>=0.80, green) / med (0.50-0.79, amber) /
 * low (<0.50, gray). Low-confidence rows are still shown but the chip
 * cues the user to scrutinize more carefully.
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
import type { PrepaidCandidate } from "@/modules/schedules/types"

interface Props {
  periodEnd: string
  /** Called when user clicks "Add to schedule" — parent opens the
   * PrepaidDialog pre-filled with the candidate's data and on save
   * also fires the accept API to record the linkage. */
  onAccept: (candidate: PrepaidCandidate) => void
}

export function AiDetectBanner({ periodEnd, onAccept }: Props) {
  const qc = useQueryClient()
  const [collapsed, setCollapsed] = useState(false)
  const [error,     setError]     = useState<string | null>(null)

  // Cheap initial load — fetch any candidates already persisted from
  // a prior scan in this period so the banner hydrates without
  // forcing a fresh AI call.
  const { data: listData } = useQuery({
    queryKey: ["schedules", "prepaid", "ai-candidates"],
    queryFn:  () => schedulesApi.listPrepaidCandidates("open"),
    staleTime: 30_000,
  })

  const scanMut = useMutation({
    mutationFn: () => schedulesApi.scanForPrepaidCandidates(periodEnd),
    onSuccess: () => {
      setError(null)
      qc.invalidateQueries({ queryKey: ["schedules", "prepaid", "ai-candidates"] })
    },
    onError:   (e: unknown) => {
      const msg = (e as { response?: { data?: { detail?: string } } }).response?.data?.detail
      setError(msg ?? "Scan failed — try again in a moment.")
    },
  })

  const dismissMut = useMutation({
    mutationFn: (id: string) => schedulesApi.dismissPrepaidCandidate(id),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ["schedules", "prepaid", "ai-candidates"] }),
  })

  const candidates = useMemo(
    () => (scanMut.data?.candidates ?? listData?.candidates ?? []) as PrepaidCandidate[],
    [scanMut.data, listData],
  )
  const scanned = scanMut.data
  const hasResults = candidates.length > 0
  const isScanning = scanMut.isPending

  // ── Render ────────────────────────────────────────────────────────────
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
          style={{
            background: "rgba(84, 88, 138, 0.12)",
            color: "#54588a",
          }}>
          <Sparkles size={13} strokeWidth={2} />
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold" style={{ color: "var(--text)" }}>
            AI prepaid detection
          </p>
          <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
            {isScanning ? (
              <>Scanning expense GL for likely prepaids…</>
            ) : hasResults ? (
              <>
                <span className="font-semibold" style={{ color: "#54588a" }}>
                  {candidates.length} {candidates.length === 1 ? "candidate" : "candidates"} found
                </span>
                {" — review each and accept or dismiss"}
              </>
            ) : scanned ? (
              <>
                Scanned {scanned.scanned_txns} txns across {scanned.scanned_accounts} expense accounts —
                nothing looks like a missed prepaid.
              </>
            ) : (
              <>Scan your March GL to find invoices that should be amortized over multiple months.</>
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
            : <><ScanLine size={11} strokeWidth={2} /> Scan GL for prepaids</>}
        </Button>
      </div>

      {/* Error band */}
      {error && (
        <div className="px-4 py-2 text-[11px]"
          style={{ background: "#f7eeec", color: "#86332e", borderTop: "1px solid #ecd7d3" }}>
          {error}
        </div>
      )}

      {/* Empty (no scan yet) — render the friendly explainer state */}
      {!hasResults && !isScanning && !scanned && !error && (
        <div className="px-4 pb-4 pt-1">
          <div className="rounded-lg p-3 text-[12px]"
            style={{ background: "rgba(84, 88, 138, 0.04)", color: "var(--text-2)" }}>
            <p className="leading-relaxed">
              When you scan, the AI looks at every journal entry above{" "}
              <span className="font-mono font-semibold">$500</span> hitting expense
              accounts that commonly hide prepaids (Insurance, Software, Subscriptions,
              Rent, Memberships, Licenses, Maintenance Contracts).
              {" "}It flags ones that look like multi-period commitments rather than one-time
              expenses and suggests the vendor, term, and amortization method.
              {" "}You always have the final say.
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

      {/* Done — friendly all-clear */}
      {!hasResults && scanned && !isScanning && (
        <div className="px-4 pb-4 pt-1">
          <div className="rounded-lg px-3 py-2.5 inline-flex items-center gap-2 text-[12px]"
            style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
            <CheckCircle2 size={13} strokeWidth={2} />
            All clear — no missed prepaids in this period.
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
  candidate: PrepaidCandidate
  onAccept:    () => void
  onDismiss:   () => void
  isDismissing: boolean
}) {
  const [showJe, setShowJe] = useState(false)
  const amount = parseFloat(candidate.gl_amount) || 0
  const amountFmt = `$${amount.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
  const conf = parseFloat(candidate.ai_confidence) || 0
  const months = candidate.ai_service_months
  const methodLabel = candidate.ai_method === "daily_rate" ? "daily-rate" : "straight-line"

  const confTone =
    conf >= 0.8 ? { bg: "var(--green-subtle)", fg: "var(--green)", label: "High" }
    : conf >= 0.5 ? { bg: "#f4eddf", fg: "#7a5622", label: "Med" }
    : { bg: "var(--surface-2)", fg: "var(--text-muted)", label: "Low" }

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
              {candidate.ai_vendor || candidate.gl_vendor || candidate.gl_memo || "(no description)"}
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
            {months ? <> · <span className="font-medium">{months}-month term · {methodLabel}</span></> : null}
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
            style={{ background: "var(--green)", color: "white" }}
          >
            <Plus size={11} strokeWidth={2.4} /> Add to schedule
          </button>
          <button
            type="button"
            onClick={onDismiss}
            disabled={isDismissing}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[11px] font-semibold transition-colors disabled:opacity-40"
            style={{ background: "white", color: "var(--text-2)", border: "1px solid var(--border)" }}
            title="Not a prepaid — silence this suggestion permanently"
          >
            {isDismissing ? <Spinner className="h-3 w-3" /> : <AlertCircle size={11} strokeWidth={2} />}
            Not a prepaid
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
      {showJe && <SuggestedJePreview kind="prepaid" candidate={candidate} />}
    </div>
  )
}
