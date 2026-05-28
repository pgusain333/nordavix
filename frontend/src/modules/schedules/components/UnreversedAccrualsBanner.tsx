/**
 * UnreversedAccrualsBanner — feature (d) of the accruals AI suite.
 *
 * Lists every active, not-reversed accrual whose reversal date has
 * passed (or whose accrual_date is in a prior month with no
 * reverses_on set). For each, the backend already matched against
 * the current period's GL to suggest the next action:
 *
 *   auto_reverse        — strong vendor + amount match (±5%)
 *                         One-click "Mark reversed" is safe
 *   reverse_with_trueup — match found but amount differs
 *                         User reviews the delta before reversing
 *   manual_review       — no matching payment found yet
 *                         User leaves it open or marks reversed
 *                         (some accruals reverse via manual JE
 *                         outside QBO bill payment)
 *
 * Color: red — these are unreversed liabilities sitting on the BS
 * and could double-book expense if missed.
 *
 * Marking reversed → PUT updateItem with is_reversed=true via the
 * existing schedule items endpoint (no new mutation needed).
 */
import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { motion, AnimatePresence } from "framer-motion"
import {
  AlertTriangle, CheckCircle2, Repeat, X,
} from "lucide-react"

import { Spinner } from "@/core/ui/components"
import { formatDate } from "@/core/lib/dates"
import { schedulesApi } from "@/modules/schedules/api"
import type { AccrualItem, UnreversedAccrual } from "@/modules/schedules/types"

interface Props {
  periodEnd: string
}

export function UnreversedAccrualsBanner({ periodEnd }: Props) {
  const qc = useQueryClient()
  const [collapsed, setCollapsed] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ["schedules", "accrual", "ai-unreversed", periodEnd],
    queryFn:  () => schedulesApi.listUnreversedAccruals(periodEnd),
    // 30s stale: this hits QBO so we don't want to refetch on every
    // remount but we do want fresh-ish data after the user closes a
    // dialog. Manual invalidate on reverseMut.onSuccess covers the
    // "I just marked one reversed, show me the rest" path.
    staleTime: 30_000,
  })

  const reverseMut = useMutation({
    mutationFn: (id: string) => schedulesApi.updateItem("accrual", id, { is_reversed: true } as Partial<AccrualItem>),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ["schedules"] }),
  })

  const items = useMemo(() => data?.items ?? [], [data])
  const autoCount = items.filter((i) => i.suggested_action === "auto_reverse").length
  const trueupCount = items.filter((i) => i.suggested_action === "reverse_with_trueup").length
  const reviewCount = items.filter((i) => i.suggested_action === "manual_review").length

  if (isLoading || items.length === 0) return null

  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      className="rounded-xl overflow-hidden"
      style={{
        background: "var(--surface)",
        border: "1px solid #fecaca",
        boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
      }}
    >
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="w-full px-4 py-3 flex items-center gap-3 text-left transition-colors hover:bg-[var(--surface-2)]"
        style={{ background: "#fef2f2" }}
      >
        <span className="h-7 w-7 rounded-lg inline-flex items-center justify-center shrink-0"
          style={{ background: "#fee2e2", color: "#b91c1c" }}>
          <Repeat size={13} strokeWidth={2} />
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold" style={{ color: "#7f1d1d" }}>
            {items.length} unreversed accrual{items.length === 1 ? "" : "s"} need attention
          </p>
          <p className="text-[11px]" style={{ color: "#991b1b" }}>
            {autoCount > 0 && <><span className="font-semibold">{autoCount} ready to auto-reverse</span></>}
            {autoCount > 0 && (trueupCount > 0 || reviewCount > 0) && " · "}
            {trueupCount > 0 && <>{trueupCount} need true-up</>}
            {trueupCount > 0 && reviewCount > 0 && " · "}
            {reviewCount > 0 && <>{reviewCount} need manual review</>}
          </p>
        </div>
        <span className="text-[11px] font-medium uppercase tracking-wider px-2" style={{ color: "#991b1b" }}>
          {collapsed ? "Show" : "Hide"}
        </span>
      </button>

      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            style={{ overflow: "hidden" }}
          >
            <div className="px-4 pb-3 pt-1 space-y-1.5">
              {items.map((row) => (
                <UnreversedRow
                  key={row.accrual.id}
                  row={row}
                  onMarkReversed={() => reverseMut.mutate(row.accrual.id)}
                  isReversing={reverseMut.isPending && reverseMut.variables === row.accrual.id}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

function UnreversedRow({
  row, onMarkReversed, isReversing,
}: {
  row: UnreversedAccrual
  onMarkReversed: () => void
  isReversing: boolean
}) {
  const accrualAmt = parseFloat(row.accrual.amount) || 0
  const best = row.matches[0]
  const action = row.suggested_action
  const fmt = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`

  const actionTone =
    action === "auto_reverse"
      ? { bg: "var(--green-subtle)", fg: "var(--green)", label: "Ready to reverse" }
    : action === "reverse_with_trueup"
      ? { bg: "#fef3c7", fg: "#92400e", label: "Reverse + true-up" }
    : { bg: "var(--surface-2)", fg: "var(--text-2)", label: "Manual review" }

  return (
    <div className="rounded-lg p-3"
      style={{ background: "#fff1f2", border: "1px solid #fecdd3" }}>
      <div className="flex items-start gap-3 flex-wrap sm:flex-nowrap">
        <span className="h-7 w-7 rounded-md inline-flex items-center justify-center shrink-0 mt-0.5"
          style={{ background: "white", color: "#b91c1c" }}>
          <AlertTriangle size={12} strokeWidth={2} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold truncate" style={{ color: "var(--text)" }}>
              {row.accrual.vendor || row.accrual.description}
            </p>
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded font-semibold"
              style={{ background: "white", color: "var(--text)", border: "1px solid var(--border)" }}>
              {fmt(accrualAmt)} accrued
            </span>
            <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
              style={{ background: actionTone.bg, color: actionTone.fg }}>
              {actionTone.label}
            </span>
          </div>
          <p className="text-[11px] mt-0.5 truncate" style={{ color: "var(--text-2)" }}>
            {row.accrual.vendor ? `${row.accrual.description} · ` : ""}
            Accrued {formatDate(row.accrual.accrual_date)}
            {row.accrual.reverses_on && <> · reverses {formatDate(row.accrual.reverses_on)}</>}
          </p>
          {best ? (
            <p className="text-[11px] mt-1 leading-snug" style={{ color: "var(--text-2)" }}>
              <span className="font-semibold">Likely match:</span>{" "}
              {fmt(parseFloat(best.gl_amount))} paid {formatDate(best.gl_txn_date)} to{" "}
              <span className="font-medium">{best.gl_vendor || "(unknown vendor)"}</span>
              {accrualAmt > 0 && parseFloat(best.gl_amount) !== accrualAmt && (
                <> · delta {fmt(parseFloat(best.gl_amount) - accrualAmt)}</>
              )}
            </p>
          ) : (
            <p className="text-[11px] mt-1 italic" style={{ color: "var(--text-muted)" }}>
              No matching payment found in this period — either it cleared via
              manual JE, or the invoice still hasn't arrived. Decide and mark
              accordingly.
            </p>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={onMarkReversed}
            disabled={isReversing}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[11px] font-semibold transition-opacity hover:opacity-90 disabled:opacity-40"
            style={{ background: "var(--green)", color: "white" }}
            title="Sets is_reversed=true. Removes the accrual from active balance."
          >
            {isReversing ? <Spinner className="h-3 w-3" /> : <CheckCircle2 size={11} strokeWidth={2.4} />}
            Mark reversed
          </button>
          <button
            type="button"
            disabled={isReversing}
            className="inline-flex items-center justify-center h-7 w-7 rounded-md transition-colors disabled:opacity-40"
            style={{ color: "var(--text-muted)", background: "transparent" }}
            title="Keep open — re-checks on next page load"
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "white" }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent" }}
          >
            <X size={12} strokeWidth={2} />
          </button>
        </div>
      </div>
    </div>
  )
}
