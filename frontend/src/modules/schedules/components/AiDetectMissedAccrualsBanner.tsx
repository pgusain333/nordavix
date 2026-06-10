/**
 * AiDetectMissedAccrualsBanner — feature (a) of the accruals AI suite.
 *
 * "Scan for missed accruals" button → backend pulls GL for the month
 * AFTER the viewed period_end (plus first 15 days of the month after
 * that) and asks Claude which payments look like work performed in
 * the viewed month. Each likely-missed accrual surfaces as a
 * confidence-chipped row with [Add accrual] / [Not missed] actions.
 *
 * Mirrors AiDetectBanner (prepaids Phase 2) in structure + brand
 * palette (purple). Differs in semantics: prepaids look forward
 * (multi-period benefit), accruals look backward (work already
 * performed, paid in the wrong period).
 */
import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { motion, AnimatePresence } from "framer-motion"
import {
  Sparkles, ScanLine, Plus, AlertCircle, CheckCircle2, RefreshCw, ChevronDown, ChevronRight,
} from "lucide-react"

import { Button, Spinner } from "@/core/ui/components"
import { formatDate } from "@/core/lib/dates"
import { schedulesApi } from "@/modules/schedules/api"
import { SuggestedJePreview } from "@/modules/schedules/components/SuggestedJePreview"
import type { MissedAccrualCandidate } from "@/modules/schedules/types"

interface Props {
  periodEnd: string
  onAccept: (candidate: MissedAccrualCandidate) => void
}

export function AiDetectMissedAccrualsBanner({ periodEnd, onAccept }: Props) {
  const qc = useQueryClient()
  const [collapsed, setCollapsed] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { data: listData } = useQuery({
    queryKey: ["schedules", "accrual", "ai-missed", periodEnd],
    queryFn:  () => schedulesApi.listMissedAccrualCandidates(periodEnd, "open"),
    staleTime: 30_000,
  })

  const scanMut = useMutation({
    mutationFn: () => schedulesApi.scanForMissedAccruals(periodEnd),
    onSuccess: () => {
      setError(null)
      qc.invalidateQueries({ queryKey: ["schedules", "accrual", "ai-missed", periodEnd] })
    },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { detail?: string } } }).response?.data?.detail
      setError(msg ?? "Scan failed — try again in a moment.")
    },
  })

  const dismissMut = useMutation({
    mutationFn: (id: string) => schedulesApi.dismissMissedAccrualCandidate(id),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ["schedules", "accrual", "ai-missed", periodEnd] }),
  })

  const candidates = useMemo(
    () => (scanMut.data?.candidates ?? listData?.candidates ?? []) as MissedAccrualCandidate[],
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
            AI missed-accrual detection
          </p>
          <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
            {isScanning ? (
              <>Scanning the post-{formatDate(periodEnd)} GL for missed accruals…</>
            ) : hasResults ? (
              <>
                <span className="font-semibold" style={{ color: "#54588a" }}>
                  {candidates.length} payment{candidates.length === 1 ? "" : "s"} look{candidates.length === 1 ? "s" : ""} like missed {candidates.length === 1 ? "accrual" : "accruals"}
                </span>
                {" — accept to book retroactively + auto-reverse"}
              </>
            ) : scanned ? (
              <>
                Scanned {scanned.scanned_txns} txns across {scanned.scanned_accounts} expense accounts —
                no missed accruals detected.
              </>
            ) : (
              <>Scan next month's GL for invoices dated for work done in {formatDate(periodEnd)}'s month.</>
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
        >
          {isScanning ? "Scanning…"
            : hasResults ? <><RefreshCw size={11} strokeWidth={2} /> Re-scan</>
            : <><ScanLine size={11} strokeWidth={2} /> Scan for missed accruals</>}
        </Button>
      </div>

      {error && (
        <div className="px-4 py-2 text-[11px]"
          style={{ background: "#f7eeec", color: "#86332e", borderTop: "1px solid #ecd7d3" }}>
          {error}
        </div>
      )}

      {!hasResults && !isScanning && !scanned && !error && (
        <div className="px-4 pb-4 pt-1">
          <div className="rounded-lg p-3 text-[12px]"
            style={{ background: "rgba(84, 88, 138, 0.04)", color: "var(--text-2)" }}>
            <p className="leading-relaxed">
              The AI scans payments hitting expense accounts in the 6 weeks AFTER{" "}
              <span className="font-mono font-semibold">{formatDate(periodEnd)}</span>{" "}
              and flags any that look like work performed in the prior month —
              legal invoices for "March services", utility bills for prior-period
              usage, contractor invoices dated for completed work, etc. Each candidate
              is one click to book retroactively (with a reversal in the current period
              so the JE nets to a single expense recognition).
            </p>
          </div>
        </div>
      )}

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
                <MissedAccrualRow
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

      {!hasResults && scanned && !isScanning && (
        <div className="px-4 pb-4 pt-1">
          <div className="rounded-lg px-3 py-2.5 inline-flex items-center gap-2 text-[12px]"
            style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
            <CheckCircle2 size={13} strokeWidth={2} />
            All clear — no missed accruals detected for {formatDate(periodEnd)}.
          </div>
        </div>
      )}
    </motion.div>
  )
}

function MissedAccrualRow({
  candidate, onAccept, onDismiss, isDismissing,
}: {
  candidate: MissedAccrualCandidate
  onAccept:    () => void
  onDismiss:   () => void
  isDismissing: boolean
}) {
  const [showJe, setShowJe] = useState(false)
  const paidAmt = parseFloat(candidate.gl_amount) || 0
  const accrueAmt = parseFloat(candidate.ai_suggested_amount ?? candidate.gl_amount) || paidAmt
  const conf = parseFloat(candidate.ai_confidence) || 0
  const confTone =
    conf >= 0.8 ? { bg: "var(--green-subtle)", fg: "var(--green)", label: "High" }
    : conf >= 0.5 ? { bg: "#f4eddf", fg: "#7a5622", label: "Med" }
    : { bg: "var(--surface-2)", fg: "var(--text-muted)", label: "Low" }
  const partial = accrueAmt !== paidAmt
  const fmt = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`

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
              {partial
                ? `${fmt(accrueAmt)} of ${fmt(paidAmt)} paid`
                : `${fmt(paidAmt)} paid`
              }
            </span>
            <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
              style={{ background: confTone.bg, color: confTone.fg }}>
              {confTone.label} confidence
            </span>
          </div>
          <p className="text-[11px] mt-0.5 truncate" style={{ color: "var(--text-2)" }}>
            Paid {formatDate(candidate.gl_txn_date)} · posted to <span className="font-medium">{candidate.gl_account_name}</span>
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
            <Plus size={11} strokeWidth={2.4} /> Add accrual
          </button>
          <button
            type="button"
            onClick={onDismiss}
            disabled={isDismissing}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[11px] font-semibold transition-colors disabled:opacity-40"
            style={{ background: "white", color: "var(--text-2)", border: "1px solid var(--border)" }}
            title="Not a missed accrual — silence permanently"
          >
            {isDismissing ? <Spinner className="h-3 w-3" /> : <AlertCircle size={11} strokeWidth={2} />}
            Not missed
          </button>
        </div>
      </div>
      {showJe && <SuggestedJePreview kind="missed_accrual" candidate={candidate} />}
    </div>
  )
}
