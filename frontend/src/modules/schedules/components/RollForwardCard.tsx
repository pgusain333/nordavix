/**
 * Period roll-forward — beginning + additions − expense − payments = ending,
 * drawn as a WATERFALL so the period's movement reads at a glance. This is the
 * heart of every schedule page: committing it pushes the ending balance into
 * the reconciliation as the subledger.
 *
 * Empty state (no account picked) shows a friendly nudge instead. Shared by all
 * five schedule pages — the commit / stale / committed wiring is preserved
 * exactly via the same props.
 */
import { motion } from "framer-motion"
import { CheckCircle2, Save, RefreshCw, AlertTriangle } from "lucide-react"
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

      <RollForwardWaterfall
        snapshot={snapshot}
        expenseLabel={expenseLabel}
        paymentLabel={paymentLabel}
      />

      <p className="text-[10px] mt-3" style={{ color: "var(--text-muted)" }}>
        {snapshot.item_count} active item{snapshot.item_count === 1 ? "" : "s"} contributing.
        {alreadyCommitted && snapshot.committed_at && (
          <> Committed {formatDateTime(snapshot.committed_at)}.</>
        )}
      </p>
    </motion.div>
  )
}

// ── Waterfall ────────────────────────────────────────────────────────────────

function num(s: string): number { return parseFloat(s) || 0 }

/** Compact money for the bar labels — whole dollars, accounting negatives. */
function money(n: number): string {
  const abs = `$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
  return n < 0 ? `(${abs})` : abs
}

interface WStep {
  label: string
  sub:   string
  lo:    number   // bar bottom value
  hi:    number   // bar top value
  end:   number   // running balance at this step's right edge (connector level)
  fill:  string
  text:  string
}

function RollForwardWaterfall({ snapshot, expenseLabel, paymentLabel }: {
  snapshot:     Snapshot
  expenseLabel: string
  paymentLabel: string
}) {
  const beginning = num(snapshot.beginning_balance)
  const additions = num(snapshot.additions)
  const expense   = num(snapshot.period_expense)
  const payments  = num(snapshot.payments)
  const ending    = num(snapshot.ending_balance)

  const steps: WStep[] = []
  let run = beginning
  steps.push({
    label: "Beginning", sub: money(beginning),
    lo: Math.min(0, beginning), hi: Math.max(0, beginning), end: beginning,
    fill: "#8aa399", text: "var(--text-2)",
  })
  const addStep = (label: string, delta: number, fill: string, text: string) => {
    const from = run, to = run + delta
    steps.push({
      label, sub: `${delta >= 0 ? "+ " : "− "}${money(Math.abs(delta))}`,
      lo: Math.min(from, to), hi: Math.max(from, to), end: to, fill, text,
    })
    run = to
  }
  addStep("+ Additions",     additions, "var(--green)", "var(--green)")
  addStep(`− ${expenseLabel}`, -expense,  "#c79a52",      "#8a6326")
  addStep(`− ${paymentLabel}`, -payments, "#3c5a76",      "#3c5a76")
  // Any residual (e.g. "other" movements) so the waterfall always ties to the
  // authoritative ending balance.
  const residual = ending - run
  if (Math.abs(residual) > 0.5) {
    addStep("± Other", residual, "#888780", "var(--text-2)")
  }
  steps.push({
    label: "= Ending", sub: money(ending),
    lo: Math.min(0, ending), hi: Math.max(0, ending), end: ending,
    fill: "var(--green)", text: "var(--green)",
  })

  const cols = steps.length
  const SLOT = 120, BARW = 58, CH_TOP = 14, CH_BOT = 104, H = 142
  const W = cols * SLOT
  const vals = steps.flatMap((s) => [s.lo, s.hi]).concat([0])
  const maxV = Math.max(...vals)
  const minV = Math.min(...vals)
  const rng = maxV - minV || 1
  const y  = (v: number) => CH_BOT - ((v - minV) / rng) * (CH_BOT - CH_TOP)
  const cx = (i: number) => i * SLOT + SLOT / 2

  return (
    <div className="rounded-xl p-2 overflow-x-auto"
      style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet"
        style={{ display: "block", width: "100%", maxWidth: W }} role="img"
        aria-label="Period roll-forward waterfall">
        {/* Connectors at each running balance */}
        {steps.slice(0, -1).map((s, i) => (
          <line key={`c${i}`}
            x1={cx(i) + BARW / 2} y1={y(s.end)}
            x2={cx(i + 1) - BARW / 2} y2={y(s.end)}
            stroke="var(--border-strong)" strokeWidth="1" strokeDasharray="3 3" />
        ))}
        {/* Bars */}
        {steps.map((s, i) => {
          const h0 = y(s.lo) - y(s.hi)
          const height = Math.max(h0, 2)
          const by = y(s.hi) - (height - h0) / 2
          return <rect key={`b${i}`} x={cx(i) - BARW / 2} y={by} width={BARW} height={height} rx={3} fill={s.fill} />
        })}
        {/* Labels */}
        {steps.map((s, i) => (
          <g key={`l${i}`}>
            <text x={cx(i)} y={120} textAnchor="middle" fontSize="10" fill="var(--text-muted)">{s.label}</text>
            <text x={cx(i)} y={135} textAnchor="middle" fontSize="11.5" fontWeight="700" fill={s.text}>{s.sub}</text>
          </g>
        ))}
      </svg>
    </div>
  )
}
