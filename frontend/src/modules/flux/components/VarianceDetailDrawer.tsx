/**
 * Right-side detail drawer for one variance row.
 *
 * Mirrors the AccountDetailDrawer pattern from the Reconciliations
 * dashboard so the two apps feel consistent:
 *   - Slide-in panel from the right (full-width sheet on mobile)
 *   - Sticky header with Prev/Next + Close
 *   - Tabs: Summary · Commentary · Transactions
 *   - Sticky action footer (Approve / Re-open / Flag)
 *   - ESC closes, ← / → flip between variances
 *   - URL hash `#var=<id>&tab=<tab>` for refresh resilience
 *   - User-resizable width via the left-edge drag handle (persisted)
 *
 * The Commentary + Transactions tab bodies come in via render-props so
 * the parent (VarianceTable) keeps owning the NarrativePanel +
 * VarianceTxnsSection components — drawer is presentation only.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AnimatePresence, motion } from "framer-motion"
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  FileText,
  GripVertical,
  Layers,
  Lightbulb,
  MessageSquare,
  Receipt,
  ShieldCheck,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Users,
  X,
} from "lucide-react"

import type { VarianceRow, AICommentary } from "@/modules/flux/api"
import { formatDateTime } from "@/core/lib/dates"
import { CommentThread } from "@/modules/comments/CommentThread"

const TABS = [
  { id: "summary",      label: "Summary",      icon: Sparkles },
  { id: "commentary",   label: "Commentary",   icon: FileText },
  { id: "transactions", label: "Transactions", icon: Receipt  },
  { id: "discussion",   label: "Discussion",   icon: MessageSquare },
] as const
type TabId = typeof TABS[number]["id"]
export type VarianceDrawerTabId = TabId

interface Props {
  /** Currently open variance row; null = drawer closed. */
  row:           VarianceRow | null
  /** Ordered list the user is browsing — drives Prev/Next. */
  rows:          VarianceRow[]
  /** True when books are closed → drawer renders read-only. */
  readOnly:      boolean
  /** Called when the user picks a different variance. */
  onNavigate:    (row: VarianceRow) => void
  /** Called when the user closes the drawer (X / ESC / backdrop). */
  onClose:       () => void
  /** Render the Commentary tab body (NarrativePanel + edit). */
  renderCommentary?:   (row: VarianceRow) => React.ReactNode
  /** Render the Transactions tab body (VarianceTxnsSection). */
  renderTransactions?: (row: VarianceRow) => React.ReactNode
  /** Sticky action footer (Approve / Re-open / Flag). */
  renderFooter?:       (row: VarianceRow) => React.ReactNode
}

// ── Width persistence ─────────────────────────────────────────────────

const WIDTH_KEY = "nordavix:variance-drawer-width"
// Wider default so commentary + transactions tab tables breathe.
const DEFAULT_WIDTH = 720
const MIN_WIDTH = 400
const MAX_WIDTH_VW = 0.85

function loadWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_KEY)
    const n = raw ? parseInt(raw, 10) : NaN
    if (Number.isFinite(n) && n >= MIN_WIDTH) return n
  } catch { /* private mode */ }
  return DEFAULT_WIDTH
}

function persistWidth(w: number): void {
  try { localStorage.setItem(WIDTH_KEY, String(Math.round(w))) } catch { /* */ }
}

export function VarianceDetailDrawer({
  row, rows, readOnly, onNavigate, onClose,
  renderCommentary, renderTransactions, renderFooter,
}: Props) {
  const [tab, setTab] = useTabHash(row?.id ?? null)
  const [width, setWidth] = useState<number>(() => loadWidth())
  // Desktop slides in from the right + pushes content; mobile becomes
  // a bottom-sheet covering 85vh so the variance table's KPI strip /
  // filters stay visible at the top. Tracks viewport changes so
  // tablet rotation re-picks the right pattern.
  const isLgUp = useMatchMedia("(min-width: 1024px)")

  const index = useMemo(() => {
    if (!row) return -1
    return rows.findIndex((r) => r.id === row.id)
  }, [row, rows])

  const prevRow = index > 0 ? rows[index - 1] : null
  const nextRow = index >= 0 && index < rows.length - 1 ? rows[index + 1] : null

  // Keyboard nav: ESC closes; ← / → between rows when focus isn't in a field.
  useEffect(() => {
    if (!row) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return }
      const t = e.target as HTMLElement | null
      const tag = t?.tagName ?? ""
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tag) || t?.isContentEditable) return
      if (e.key === "ArrowLeft" && prevRow)  { e.preventDefault(); onNavigate(prevRow) }
      if (e.key === "ArrowRight" && nextRow) { e.preventDefault(); onNavigate(nextRow) }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [row, prevRow, nextRow, onNavigate, onClose])

  // Push page content aside on desktop only. On mobile we render a
  // bottom-sheet (see below), so this var stays unset and the page
  // gets no padding push (would be pointless when the sheet covers
  // 85vh from the bottom).
  useEffect(() => {
    if (!row || !isLgUp) return
    document.body.style.setProperty("--detail-drawer-width", `${Math.min(width, window.innerWidth)}px`)
    document.body.classList.add("detail-drawer-open")
    return () => {
      document.body.style.removeProperty("--detail-drawer-width")
      document.body.classList.remove("detail-drawer-open")
    }
  }, [row, width, isLgUp])

  // Drag-to-resize: same pattern as the recon drawer.
  const resizingRef = useRef(false)
  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    resizingRef.current = true
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"

    const onMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return
      const next = Math.min(
        Math.max(window.innerWidth - ev.clientX, MIN_WIDTH),
        window.innerWidth * MAX_WIDTH_VW,
      )
      setWidth(next)
    }
    const onUp = () => {
      resizingRef.current = false
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseup", onUp)
      setWidth((w) => { persistWidth(w); return w })
    }
    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
  }, [])

  return (
    <AnimatePresence>
      {row && (
        <Fragment>
          {/* Backdrop — mobile only. Covers only the visible strip of
              the variance page (top 15vh) so tapping anywhere in that
              strip dismisses the sheet. Desktop has no backdrop
              because the drawer pushes content aside. */}
          {!isLgUp && (
            <motion.div
              key="backdrop"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="fixed left-0 right-0 top-0 z-40"
              style={{
                height: "15vh",
                background: "linear-gradient(to bottom, rgba(15, 23, 42, 0.35), rgba(15, 23, 42, 0.05))",
              }}
              onClick={onClose}
            />
          )}
          <motion.aside
            key="drawer"
            initial={isLgUp ? { x: "100%" } : { y: "100%" }}
            animate={isLgUp ? { x: 0 } : { y: 0 }}
            exit={isLgUp ? { x: "100%" } : { y: "100%" }}
            // Material-style ease — predictable, no spring overshoot.
            // willChange:transform composites the panel on the GPU.
            transition={{ duration: 0.32, ease: [0.4, 0, 0.2, 1] }}
            className="fixed z-50 flex flex-col"
            style={
              isLgUp
                ? {
                    top: 0, right: 0, bottom: 0,
                    width: `min(${width}px, 100vw)`,
                    background: "var(--surface)",
                    borderLeft: "1px solid var(--border-strong)",
                    boxShadow: "-20px 0 40px rgba(0, 0, 0, 0.12)",
                    willChange: "transform",
                  }
                : {
                    left: 0, right: 0, bottom: 0,
                    height: "85vh",
                    background: "var(--surface)",
                    borderTopLeftRadius: 16,
                    borderTopRightRadius: 16,
                    borderTop: "1px solid var(--border-strong)",
                    boxShadow: "0 -20px 40px rgba(0, 0, 0, 0.18)",
                    willChange: "transform",
                  }
            }
            role="dialog"
            aria-label={`Variance ${row.account_name} details`}
          >
            {/* Drag-handle indicator on mobile — visual cue this is a
                sheet, and that the visible strip above is tappable. */}
            {!isLgUp && (
              <div className="flex justify-center pt-2 pb-1 shrink-0">
                <span style={{
                  width: 40, height: 4, borderRadius: 2,
                  background: "var(--border-strong)",
                }} />
              </div>
            )}
            {/* Resize handle — desktop only */}
            <div
              onMouseDown={onResizeStart}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize drawer"
              title="Drag to resize"
              className="absolute top-0 left-0 h-full hidden lg:flex items-center justify-center transition-colors"
              style={{
                width: 6, cursor: "col-resize", marginLeft: -3, zIndex: 60,
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.background = "rgba(99, 102, 241, 0.18)"
              }}
              onMouseLeave={(e) => {
                if (!resizingRef.current) (e.currentTarget as HTMLElement).style.background = "transparent"
              }}>
              <GripVertical size={12} strokeWidth={1.6} style={{ color: "var(--text-muted)", pointerEvents: "none" }} />
            </div>

            <DrawerHeader
              row={row}
              index={index}
              total={rows.length}
              prevRow={prevRow}
              nextRow={nextRow}
              readOnly={readOnly}
              onNavigate={onNavigate}
              onClose={onClose}
            />

            <TabBar value={tab} onChange={setTab} />

            {/* Body. Each tab gets its own scroll container. Tabs are
                conditionally rendered (not display:none) because the
                commentary edit form has its own internal state and we
                want it to reset on close — unlike the recons drawer
                where state preservation matters. */}
            <div className="flex-1 overflow-y-auto">
              {tab === "summary" && (
                <div className="px-5 py-5">
                  <SummaryTab row={row} />
                </div>
              )}
              {tab === "commentary" && (
                <div className="px-5 py-5">
                  {renderCommentary ? renderCommentary(row) : (
                    <PlaceholderTab title="Commentary" hint="Wire renderCommentary on the parent." />
                  )}
                </div>
              )}
              {tab === "transactions" && (
                <div className="px-5 py-5">
                  {renderTransactions ? renderTransactions(row) : (
                    <PlaceholderTab title="Transactions" hint="Wire renderTransactions on the parent." />
                  )}
                </div>
              )}
              {tab === "discussion" && (
                <div className="px-5 py-5">
                  <CommentThread
                    entityType="variance"
                    entityId={row.id}
                    link={`/app/flux#var=${row.id}&vtab=discussion`}
                  />
                </div>
              )}
            </div>

            {/* Sticky action footer */}
            {renderFooter && (
              <div className="px-4 py-3 sticky bottom-0"
                style={{
                  background: "var(--surface)",
                  borderTop: "1px solid var(--border-strong)",
                  boxShadow: "0 -4px 12px rgba(0, 0, 0, 0.04)",
                }}>
                {renderFooter(row)}
              </div>
            )}
          </motion.aside>
        </Fragment>
      )}
    </AnimatePresence>
  )
}

// ── Header ─────────────────────────────────────────────────────────────

function DrawerHeader({
  row, index, total, prevRow, nextRow, readOnly, onNavigate, onClose,
}: {
  row:        VarianceRow
  index:      number
  total:      number
  prevRow:    VarianceRow | null
  nextRow:    VarianceRow | null
  readOnly:   boolean
  onNavigate: (r: VarianceRow) => void
  onClose:    () => void
}) {
  return (
    <div className="px-5 pt-4 pb-3 sticky top-0 z-10"
      style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
      {/* Top row: position + nav + close */}
      <div className="flex items-center justify-between mb-3">
        <div className="text-[10px] font-semibold uppercase tracking-wider"
          style={{ color: "var(--text-muted)" }}>
          Variance {index + 1} of {total}
        </div>
        <div className="flex items-center gap-1">
          <IconBtn
            label="Previous variance (←)"
            disabled={!prevRow}
            onClick={() => prevRow && onNavigate(prevRow)}>
            <ChevronLeft size={14} strokeWidth={2} />
          </IconBtn>
          <IconBtn
            label="Next variance (→)"
            disabled={!nextRow}
            onClick={() => nextRow && onNavigate(nextRow)}>
            <ChevronRight size={14} strokeWidth={2} />
          </IconBtn>
          <div className="w-px h-5 mx-1" style={{ background: "var(--border)" }} />
          <IconBtn label="Close (ESC)" onClick={onClose}>
            <X size={14} strokeWidth={2} />
          </IconBtn>
        </div>
      </div>

      {/* Title + status */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-[11px] font-mono"
              style={{ color: "var(--text-muted)" }}>{row.account_number}</span>
            {row.fs_category && (
              <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded"
                style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}>
                {row.fs_category}
              </span>
            )}
            {row.is_material && (
              <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded"
                style={{ background: "rgba(245, 158, 11, 0.12)", color: "#b45309" }}>
                Material
              </span>
            )}
            {readOnly && (
              <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded"
                style={{ background: "rgba(245, 158, 11, 0.12)", color: "#b45309" }}>
                Read-only
              </span>
            )}
          </div>
          <h2 className="text-base font-semibold text-theme truncate">
            {row.account_name}
          </h2>
        </div>
        <StatusPill status={row.status} />
      </div>

      {/* Current / Prior / Change strip. The third cell is labeled by
          DIRECTION — "Increase" / "Decrease" — which reads more plainly
          than the accounting term "Variance" (it's literally the
          period-over-period movement in the account balance). */}
      <div className="mt-3 grid grid-cols-3 gap-3">
        <BalanceCell label="Current" value={row.current_balance} />
        <BalanceCell label="Prior"   value={row.prior_balance} />
        <BalanceCell
          label={(() => {
            const v = parseFloat(row.dollar_variance) || 0
            return v > 0 ? "Increase vs prior" : v < 0 ? "Decrease vs prior" : "No change"
          })()}
          value={row.dollar_variance}
          accent={Math.abs(parseFloat(row.dollar_variance)) >= 0.5}
          percent={row.pct_variance} />
      </div>
    </div>
  )
}

function StatusPill({ status }: { status: string }) {
  const tone: Record<string, { bg: string; fg: string; icon: typeof CheckCircle2; label: string }> = {
    approved:   { bg: "rgba(16, 185, 129, 0.12)", fg: "#047857", icon: ShieldCheck,   label: "Approved" },
    generated:  { bg: "rgba(59, 130, 246, 0.12)", fg: "#1d4ed8", icon: Sparkles,      label: "Generated" },
    edited:     { bg: "rgba(59, 130, 246, 0.12)", fg: "#1d4ed8", icon: Sparkles,      label: "Edited" },
    generating: { bg: "rgba(124, 58, 237, 0.12)", fg: "#7c3aed", icon: Layers,        label: "Generating" },
    flagged:    { bg: "rgba(239, 68, 68, 0.12)",  fg: "#b91c1c", icon: AlertTriangle, label: "Flagged" },
    pending:    { bg: "var(--surface-2)",         fg: "var(--text-muted)", icon: Clock, label: "Pending" },
  }
  const t = tone[status] ?? { bg: "var(--surface-2)", fg: "var(--text-muted)", icon: Clock, label: status }
  const Icon = t.icon
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wider shrink-0"
      style={{ background: t.bg, color: t.fg }}>
      <Icon size={11} strokeWidth={2.2} />
      {t.label}
    </span>
  )
}

/** Accounting-style currency: positive = $1,234.56, negative = $(1,234.56). */
function fmtMoneyAcct(value: number): string {
  const abs = Math.abs(value).toLocaleString(undefined, {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })
  return value < 0 ? `$(${abs})` : `$${abs}`
}

function BalanceCell({ label, value, accent, percent }: {
  label:    string
  value:    string
  accent?:  boolean
  percent?: string | null
}) {
  const n = parseFloat(value) || 0
  return (
    <div className="rounded-lg px-2.5 py-2"
      style={{ background: accent ? "rgba(239, 68, 68, 0.06)" : "var(--surface-2)" }}>
      <div className="text-[9px] font-semibold uppercase tracking-wider"
        style={{ color: "var(--text-muted)" }}>{label}</div>
      <div className="text-sm font-semibold tabular-nums mt-0.5"
        style={{ color: accent ? "#b91c1c" : "var(--text)" }}>
        {fmtMoneyAcct(n)}
      </div>
      {percent && (
        <div className="text-[10px] mt-0.5 tabular-nums" style={{ color: "var(--text-muted)" }}>
          {`${(parseFloat(percent) * 100).toFixed(1)}%`}
        </div>
      )}
    </div>
  )
}

function IconBtn({
  children, onClick, disabled, label,
}: { children: React.ReactNode; onClick: () => void; disabled?: boolean; label: string }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="h-7 w-7 rounded-md flex items-center justify-center transition-colors"
      style={{
        color: disabled ? "var(--border-strong)" : "var(--text-muted)",
        cursor: disabled ? "default" : "pointer",
      }}
      onMouseEnter={(e) => { if (!disabled) (e.currentTarget as HTMLElement).style.background = "var(--surface-2)" }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent" }}>
      {children}
    </button>
  )
}

// ── Tabs ───────────────────────────────────────────────────────────────

function TabBar({ value, onChange }: { value: TabId; onChange: (v: TabId) => void }) {
  return (
    <div
      className="px-2 flex items-center gap-0 overflow-x-auto sticky z-10"
      style={{
        borderBottom: "1px solid var(--border)",
        background: "var(--surface)",
        top: 0,
        scrollSnapType: "x proximity",
        WebkitOverflowScrolling: "touch",
      }}>
      {TABS.map((t) => {
        const active = t.id === value
        const Icon = t.icon
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            className="relative inline-flex items-center gap-1.5 px-3 py-2 text-[11px] font-semibold whitespace-nowrap transition-colors shrink-0"
            style={{
              color: active ? "var(--text)" : "var(--text-muted)",
              borderBottom: active ? "2px solid var(--text)" : "2px solid transparent",
              marginBottom: "-1px",
              scrollSnapAlign: "center",
            }}>
            <Icon size={12} strokeWidth={1.8} />
            {t.label}
          </button>
        )
      })}
    </div>
  )
}

// ── Summary tab ───────────────────────────────────────────────────────

function SummaryTab({ row }: { row: VarianceRow }) {
  const anomalyLabels: Record<string, string> = {
    new_account:         "No prior balance",
    sign_flip:           "Sign flip",
    large_pct_change:    "Large % change",
    dormant_reactivated: "Reactivated",
  }
  return (
    <div className="space-y-4">
      {/* AI verdict + bridge + actions */}
      {row.ai_commentary ? (
        <AiCommentaryView c={row.ai_commentary} />
      ) : row.narrative ? (
        <Card title="Commentary" icon={<FileText size={13} strokeWidth={1.8} />}>
          <p className="text-[12px] leading-relaxed" style={{ color: "var(--text)" }}>
            {row.narrative}
          </p>
        </Card>
      ) : (
        <Card title="Commentary" icon={<FileText size={13} strokeWidth={1.8} />}>
          <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
            {row.status === "generating"
              ? "AI commentary is being generated…"
              : "No commentary yet. Open the Commentary tab to edit, or run Agentic Mode from the table header."}
          </p>
        </Card>
      )}

      {/* Anomaly flags */}
      {row.anomaly_flags.length > 0 && (
        <Card title="Anomaly flags" icon={<AlertTriangle size={13} strokeWidth={1.8} />}>
          <div className="flex items-center gap-1.5 flex-wrap">
            {row.anomaly_flags.map((f) => (
              <Pill key={f} tone="warn">{anomalyLabels[f] ?? f}</Pill>
            ))}
          </div>
        </Card>
      )}

      {/* Approver stamp */}
      {row.approved_at && (
        <Card title="Approved" icon={<ShieldCheck size={13} strokeWidth={1.8} />}>
          <div className="text-[12px] text-theme">
            {row.approved_by && <>By {row.approved_by} · </>}
            {formatDateTime(row.approved_at)}
          </div>
        </Card>
      )}
    </div>
  )
}

// ── Smaller blocks ────────────────────────────────────────────────────

/**
 * Organized, actionable rendering of the structured AI commentary:
 *   1. Verdict   — headline + risk / justified / confidence pills + context
 *   2. Bridge    — itemized drivers that make up the change, with an
 *                  explained / unexplained reconciliation footer
 *   3. Actions   — the recommendations (previously computed but never shown)
 *   4. Drivers   — key customers/vendors (previously computed but never shown)
 * Every section after the verdict is conditional — older v1 commentaries
 * (no drivers/recommendations) just render the verdict, same as before.
 */
function AiCommentaryView({ c }: { c: AICommentary }) {
  const drivers = c.drivers ?? []
  const recs = c.recommendations ?? []
  const entities = c.key_entities ?? []
  const unexplained = parseFloat(c.unexplained_amount ?? "0") || 0
  const explained = parseFloat(c.explained_amount ?? "0") || 0

  return (
    <div className="space-y-3">
      {/* 1 — Verdict */}
      <Card title="AI verdict" icon={<Sparkles size={13} strokeWidth={1.8} />}>
        {c.headline && (
          <p className="text-[12.5px] font-semibold leading-snug mb-2" style={{ color: "var(--text)" }}>
            {c.headline}
          </p>
        )}
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          <Pill tone={c.risk_level === "high" ? "danger" : c.risk_level === "medium" ? "warn" : "success"}>
            {c.risk_level} risk
          </Pill>
          <Pill tone={c.justified === "yes" ? "success" : c.justified === "no" ? "danger" : "warn"}>
            {c.justified === "yes" ? "Justified" : c.justified === "no" ? "Not justified" : "Needs review"}
          </Pill>
          <Pill tone="info">{c.confidence} confidence</Pill>
        </div>
        {c.narrative && (
          <p className="text-[12px] leading-relaxed" style={{ color: "var(--text)" }}>
            {c.narrative}
          </p>
        )}
      </Card>

      {/* 2 — Variance bridge (the exact reasoning of what makes up the change) */}
      {drivers.length > 0 && (
        <Card title="What makes up the change" icon={<TrendingUp size={13} strokeWidth={1.8} />}>
          <div className="space-y-1.5">
            {drivers.map((d, i) => {
              const amt = parseFloat(d.amount) || 0
              const up = d.direction === "increase"
              return (
                <div key={i} className="flex items-start gap-2">
                  {up
                    ? <TrendingUp size={13} strokeWidth={2} style={{ color: "#047857", marginTop: 1, flexShrink: 0 }} />
                    : <TrendingDown size={13} strokeWidth={2} style={{ color: "#b91c1c", marginTop: 1, flexShrink: 0 }} />}
                  <span className="text-[12px] leading-snug flex-1" style={{ color: "var(--text)" }}>{d.label}</span>
                  <span className="text-[12px] font-semibold tabular-nums" style={{ color: up ? "#047857" : "#b91c1c" }}>
                    {up ? "+" : "−"}{fmtMoneyAcct(amt)}
                  </span>
                </div>
              )
            })}
          </div>
          {/* Reconciliation footer */}
          <div className="mt-2.5 pt-2 flex items-center justify-between gap-2 text-[11px]"
            style={{ borderTop: "1px solid var(--border)" }}>
            <span style={{ color: "var(--text-muted)" }}>
              Explained <span className="font-semibold tabular-nums" style={{ color: "var(--text)" }}>{fmtMoneyAcct(explained)}</span>
            </span>
            {Math.abs(unexplained) >= 1 && (
              <span className="inline-flex items-center gap-1 font-semibold" style={{ color: "#b45309" }}>
                <AlertTriangle size={11} strokeWidth={2} />
                {fmtMoneyAcct(unexplained)} unexplained
              </span>
            )}
          </div>
        </Card>
      )}

      {/* 3 — Recommended actions */}
      {recs.length > 0 && (
        <Card title="Recommended actions" icon={<Lightbulb size={13} strokeWidth={1.8} />}>
          <ul className="space-y-1.5">
            {recs.map((r, i) => (
              <li key={i} className="flex items-start gap-2 text-[12px] leading-snug" style={{ color: "var(--text)" }}>
                <span className="inline-flex items-center justify-center h-4 w-4 rounded-full text-[9px] font-bold shrink-0 mt-0.5"
                  style={{ background: "var(--green-subtle)", color: "var(--green)" }}>{i + 1}</span>
                {r}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* 4 — Key drivers (entities) */}
      {entities.length > 0 && (
        <Card title="Key customers / vendors" icon={<Users size={13} strokeWidth={1.8} />}>
          <div className="space-y-1">
            {entities.map((e, i) => (
              <div key={i} className="flex items-center gap-2 text-[12px]">
                <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider shrink-0"
                  style={{
                    background: e.type === "customer" ? "rgba(59,130,246,0.12)" : e.type === "vendor" ? "rgba(245,158,11,0.12)" : "var(--surface-2)",
                    color: e.type === "customer" ? "#1d4ed8" : e.type === "vendor" ? "#b45309" : "var(--text-muted)",
                  }}>
                  {e.type}
                </span>
                <span className="flex-1 truncate" style={{ color: "var(--text)" }}>{e.name}</span>
                {e.amount && (
                  <span className="font-semibold tabular-nums" style={{ color: "var(--text-2)" }}>
                    {fmtMoneyAcct(parseFloat(e.amount) || 0)}
                  </span>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}

function Card({ title, icon, children }: {
  title:    string
  icon:     React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="rounded-xl p-3"
      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <div className="flex items-center gap-1.5 mb-2 text-[10px] font-semibold uppercase tracking-wider"
        style={{ color: "var(--text-muted)" }}>
        {icon}
        {title}
      </div>
      {children}
    </div>
  )
}

function Pill({ children, tone }: {
  children: React.ReactNode
  tone:     "success" | "danger" | "warn" | "info"
}) {
  const map = {
    success: { bg: "rgba(16, 185, 129, 0.12)", fg: "#047857" },
    danger:  { bg: "rgba(239, 68, 68, 0.12)",  fg: "#b91c1c" },
    warn:    { bg: "rgba(245, 158, 11, 0.12)", fg: "#b45309" },
    info:    { bg: "rgba(59, 130, 246, 0.12)", fg: "#1d4ed8" },
  }[tone]
  return (
    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider"
      style={{ background: map.bg, color: map.fg }}>
      {children}
    </span>
  )
}

function PlaceholderTab({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-12 px-6">
      <div className="h-10 w-10 rounded-full flex items-center justify-center mb-3"
        style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}>
        <FileText size={18} strokeWidth={1.6} />
      </div>
      <h3 className="text-sm font-semibold text-theme mb-1">{title}</h3>
      <p className="text-[12px] max-w-xs" style={{ color: "var(--text-muted)" }}>{hint}</p>
    </div>
  )
}

// ── URL-hash <-> tab sync ─────────────────────────────────────────────

function useTabHash(varId: string | null): [TabId, (t: TabId) => void] {
  const initial = readTabFromHash()
  const tabRef = useRef<TabId>(initial)
  const [, force] = useState(0)

  const setTab = useCallback((next: TabId) => {
    tabRef.current = next
    writeHashState(varId, next)
    force((n) => n + 1)
  }, [varId])

  useEffect(() => {
    writeHashState(varId, tabRef.current)
  }, [varId])

  return [tabRef.current, setTab]
}

function readTabFromHash(): TabId {
  if (typeof window === "undefined") return "summary"
  const m = window.location.hash.match(/vtab=([a-z]+)/)
  const candidate = (m?.[1] ?? "summary") as TabId
  return TABS.some((t) => t.id === candidate) ? candidate : "summary"
}

function writeHashState(varId: string | null, tab: TabId): void {
  if (typeof window === "undefined") return
  const params = new URLSearchParams()
  if (varId) params.set("var", varId)
  if (tab !== "summary") params.set("vtab", tab)
  const next = params.toString()
  const target = next ? `#${next}` : ""
  if (window.location.hash !== target) {
    history.replaceState(null, "", `${window.location.pathname}${window.location.search}${target}`)
  }
}

export function readVarianceDrawerIdFromHash(): string | null {
  if (typeof window === "undefined") return null
  const m = window.location.hash.match(/var=([^&]+)/)
  return m?.[1] ?? null
}

/** SSR-safe matchMedia hook. Returns current value + subscribes to changes. */
function useMatchMedia(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === "undefined") return false
    return window.matchMedia(query).matches
  })
  useEffect(() => {
    if (typeof window === "undefined") return
    const mql = window.matchMedia(query)
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches)
    setMatches(mql.matches)
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [query])
  return matches
}
