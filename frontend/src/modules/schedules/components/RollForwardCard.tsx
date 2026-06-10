/**
 * Visual roll-forward: beginning + additions − expense − payments = ending.
 *
 * Compact card that shows the snapshot math at a glance. Each block has
 * its own colour: beginning (neutral), additions (green), expense (amber),
 * payments (blue), ending (bold).
 *
 * Empty state (no account picked) shows a friendly nudge instead.
 */
import { motion } from "framer-motion"
import { ArrowRight, CheckCircle2, Save, RefreshCw, AlertTriangle } from "lucide-react"
import { Button } from "@/core/ui/components"
import { formatDateTime } from "@/core/lib/dates"
import type { Snapshot } from "@/modules/schedules/types"

interface Props {
  snapshot:        Snapshot | undefined
  isLoading:       boolean
  hasAccount:      boolean
  expenseLabel?:   string   // e.g. "Amortization", "Depreciation", "Interest"
  paymentLabel?:  string    // e.g. "Disposals", "Payments", "Principal paid"
  onCommit:        () => void
  committing:      boolean
  alreadyCommitted: boolean
  /** Was committed, but items changed since → prompt a re-commit. */
  stale?:          boolean
}

function fmt(s: string): string {
  const n = parseFloat(s) || 0
  const abs = `$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  return n < 0 ? `(${abs})` : abs
}

export function RollForwardCard({
  snapshot, isLoading, hasAccount,
  expenseLabel = "Period expense",
  paymentLabel = "Payments",
  onCommit, committing, alreadyCommitted, stale = false,
}: Props) {
  if (!hasAccount) {
    return (
      <div className="rounded-xl p-8 text-center"
        style={{ background: "var(--surface)", border: "1px dashed var(--border-strong)" }}>
        <p className="text-sm font-semibold text-theme mb-1">Pick an account to see its roll-forward</p>
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          Each schedule rolls up to one balance-sheet GL account. Select one above to
          see beginning / additions / expense / ending for this period.
        </p>
      </div>
    )
  }

  if (isLoading || !snapshot) {
    return (
      <div className="rounded-xl p-6"
        style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
        <div className="h-16 rounded animate-pulse" style={{ background: "var(--surface-2)" }} />
      </div>
    )
  }

  const cells = [
    { label: "Beginning",  value: snapshot.beginning_balance, color: "var(--text-2)" },
    { label: "+ Additions", value: snapshot.additions,         color: "var(--green)" },
    { label: `− ${expenseLabel}`, value: snapshot.period_expense, color: "#8a6326" },
    { label: `− ${paymentLabel}`, value: snapshot.payments,    color: "#3c5a76" },
  ]

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}
      className="rounded-xl p-5"
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        boxShadow: "var(--card-shadow)",
      }}>
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <p className="text-sm font-semibold text-theme mb-0.5">Period roll-forward</p>
          <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
            Computed from active items overlapping this period. Commit to push the
            ending balance into the recon as the subledger.
          </p>
        </div>
        {stale ? (
          // Was committed, but items changed since → must re-commit so the
          // persisted snapshot + recon subledger pick up the new lines.
          <Button size="sm" loading={committing} onClick={onCommit}
            icon={<RefreshCw size={12} strokeWidth={2} />}>
            Re-commit snapshot
          </Button>
        ) : alreadyCommitted ? (
          // Committed and current. Show the badge but keep a quiet
          // re-commit affordance so it's never a dead end.
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider"
              style={{ background: "var(--green-subtle)", color: "var(--green)", border: "1px solid var(--green)" }}>
              <CheckCircle2 size={10} strokeWidth={2.4} />
              Committed
            </span>
            <Button size="sm" variant="ghost" loading={committing} onClick={onCommit}
              icon={<RefreshCw size={11} strokeWidth={2} />}>
              Re-commit
            </Button>
          </div>
        ) : (
          <Button size="sm" loading={committing} onClick={onCommit}
            icon={<Save size={12} strokeWidth={2} />}>
            Commit snapshot
          </Button>
        )}
      </div>
      {stale && (
        <div className="flex items-start gap-2 rounded-lg px-3 py-2 mb-3"
          style={{ background: "rgba(180, 83, 9, 0.08)", border: "1px solid rgba(180, 83, 9, 0.35)" }}>
          <AlertTriangle size={13} strokeWidth={2} style={{ color: "#8a6326", marginTop: 1 }} />
          <p className="text-[11px] leading-snug" style={{ color: "#8a6326" }}>
            Schedule items changed since this period was last committed
            {snapshot.committed_at ? <> ({formatDateTime(snapshot.committed_at)})</> : null}.
            The numbers below are live — <span className="font-semibold">re-commit</span> to
            update the reconciliation subledger and re-close this schedule task.
          </p>
        </div>
      )}
      <div className="flex flex-wrap items-end gap-2">
        {cells.map((c) => (
          <div key={c.label}
            className="flex-1 min-w-[140px] rounded-lg p-3"
            style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
            <p className="text-[10px] font-semibold uppercase tracking-wider mb-1"
              style={{ color: "var(--text-muted)" }}>{c.label}</p>
            <p className="text-base font-bold tabular-nums" style={{ color: c.color }}>
              {fmt(c.value)}
            </p>
          </div>
        ))}
        <ArrowRight size={18} strokeWidth={1.8} style={{ color: "var(--text-muted)" }} />
        <div className="flex-1 min-w-[160px] rounded-lg p-3"
          style={{
            background: "var(--green-subtle)",
            border: "1.5px solid var(--green)",
          }}>
          <p className="text-[10px] font-semibold uppercase tracking-wider mb-1"
            style={{ color: "var(--green)" }}>= Ending</p>
          <p className="text-lg font-bold tabular-nums" style={{ color: "var(--green)" }}>
            {fmt(snapshot.ending_balance)}
          </p>
        </div>
      </div>
      <p className="text-[10px] mt-3" style={{ color: "var(--text-muted)" }}>
        {snapshot.item_count} active item{snapshot.item_count === 1 ? "" : "s"} contributing.
        {alreadyCommitted && snapshot.committed_at && (
          <> Committed {formatDateTime(snapshot.committed_at)}.</>
        )}
      </p>
    </motion.div>
  )
}
