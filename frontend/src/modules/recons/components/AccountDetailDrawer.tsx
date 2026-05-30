/**
 * Right-side detail drawer for one reconciliation account.
 *
 * Behavior:
 *   - Slide-in panel from the right (full-screen on mobile)
 *   - List stays visible on the left for prev/next browsing
 *   - Sticky header with status pill + Prev/Next + Close
 *   - Tabs: Summary · Items · Suggestions · Evidence · AI
 *   - Sticky action footer at the bottom (Mark prepared / Approve / Re-open)
 *   - ESC closes; ←/→ arrows move between accounts when focus isn't in a field
 *   - URL hash (#acct=<qbo_id>&tab=<tab>) for deep linking
 *   - User-resizable width via left-edge drag handle (persisted)
 *
 * Performance note:
 *   The deep reconcile body is mounted ONCE and never unmounts as the
 *   user switches tabs — sections that don't belong to the active tab
 *   are CSS-hidden inside the form via its `visibleSection` prop. This
 *   means tab switches are instant (no React tree teardown, no query
 *   re-subscription, no state loss).
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AnimatePresence, motion } from "framer-motion"
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  FileText,
  GripVertical,
  Layers,
  Paperclip,
  Receipt,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react"

import type { OverviewAccount } from "@/modules/recons/api"

const TABS = [
  { id: "summary",     label: "Summary",     icon: Sparkles  },
  { id: "items",       label: "Items",       icon: Receipt   },
  { id: "suggestions", label: "Suggestions", icon: Layers    },
  { id: "evidence",    label: "Evidence",    icon: Paperclip },
  { id: "ai",          label: "AI",          icon: Brain     },
] as const
export type DrawerTabId = typeof TABS[number]["id"]
/** Tab ids that correspond to InlineSubledgerForm sections. Summary is
 *  the drawer's own section, not the form. */
export type DrawerFormSection = Exclude<DrawerTabId, "summary">

interface Props {
  /** Currently open account; null = drawer closed. */
  account:          OverviewAccount | null
  /** Ordered list of accounts the user is browsing — used by Prev/Next. */
  accounts:         OverviewAccount[]
  /** Period the drawer is scoped to. */
  periodEnd:        string
  /** Books closed → drawer renders in read-only mode like the accordion does. */
  readOnly:         boolean
  /** Called when the user picks a different account (prev/next button or shortcut). */
  onNavigate:       (account: OverviewAccount) => void
  /** Called when the user closes the drawer (X, ESC, or backdrop). */
  onClose:          () => void
  /** Render the InlineSubledgerForm. The parent passes a callback so we
   *  can call it with the current tab's section filter — that way the
   *  form stays mounted but only the right sections render. */
  renderReconcileBody?: (account: OverviewAccount, section: DrawerFormSection) => React.ReactNode
  /** Renders a sticky action footer at the bottom of the drawer. */
  renderFooter?:        (account: OverviewAccount) => React.ReactNode
}

// ── Width persistence ─────────────────────────────────────────────────

const WIDTH_KEY = "nordavix:recons-drawer-width"
const DEFAULT_WIDTH = 560
const MIN_WIDTH = 400
const MAX_WIDTH_VW = 0.85   // 85% of viewport — leaves the list visible

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

export function AccountDetailDrawer({
  account, accounts, periodEnd: _periodEnd, readOnly,
  onNavigate, onClose, renderReconcileBody, renderFooter,
}: Props) {
  const [tab, setTab] = useTabHash(account?.qbo_id ?? null)
  const [width, setWidth] = useState<number>(() => loadWidth())

  // Position in the visible accounts list (drives Prev/Next).
  const index = useMemo(() => {
    if (!account) return -1
    return accounts.findIndex((a) => a.qbo_id === account.qbo_id)
  }, [account, accounts])

  const prevAcct = index > 0 ? accounts[index - 1] : null
  const nextAcct = index >= 0 && index < accounts.length - 1 ? accounts[index + 1] : null

  // Keyboard nav: ESC closes; ← / → move between accounts (only when focus
  // isn't sitting in an input/textarea/contenteditable).
  useEffect(() => {
    if (!account) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return }
      const t = e.target as HTMLElement | null
      const tag = t?.tagName ?? ""
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tag) || t?.isContentEditable) return
      if (e.key === "ArrowLeft" && prevAcct)  { e.preventDefault(); onNavigate(prevAcct) }
      if (e.key === "ArrowRight" && nextAcct) { e.preventDefault(); onNavigate(nextAcct) }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [account, prevAcct, nextAcct, onNavigate, onClose])

  // Drag-to-resize. Mousedown on the left-edge handle begins tracking;
  // mousemove updates the width state; mouseup persists it. We clamp to
  // [MIN_WIDTH, 85% of viewport] so the user can't accidentally hide
  // the entire list or shrink the drawer below readable.
  const resizingRef = useRef(false)
  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    resizingRef.current = true
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"

    const onMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return
      // Drawer is anchored to the right edge, so width = viewport - mouseX.
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
      {account && (
        <Fragment>
          {/* Backdrop — semi-transparent click-to-close on mobile / overflow areas */}
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-40 lg:hidden"
            style={{ background: "rgba(15, 23, 42, 0.5)" }}
            onClick={onClose}
          />
          {/* Drawer panel */}
          <motion.aside
            key="drawer"
            initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }}
            transition={{ type: "tween", duration: 0.24, ease: [0.32, 0.72, 0, 1] }}
            className="fixed top-0 right-0 z-50 h-full flex flex-col"
            style={{
              width: `min(${width}px, 100vw)`,
              background: "var(--surface)",
              borderLeft: "1px solid var(--border-strong)",
              boxShadow: "-20px 0 40px rgba(0, 0, 0, 0.12)",
            }}
            role="dialog"
            aria-label={`Account ${account.account_name} details`}
          >
            {/* Resize handle — desktop only. Drag to widen/narrow. */}
            <div
              onMouseDown={onResizeStart}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize drawer"
              title="Drag to resize"
              className="absolute top-0 left-0 h-full hidden lg:flex items-center justify-center transition-colors"
              style={{
                width: 6,
                cursor: "col-resize",
                marginLeft: -3,
                zIndex: 60,
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
              account={account}
              index={index}
              total={accounts.length}
              prevAcct={prevAcct}
              nextAcct={nextAcct}
              readOnly={readOnly}
              onNavigate={onNavigate}
              onClose={onClose}
            />

            <TabBar value={tab} onChange={setTab} account={account} />

            {/* Body. Both panels mount; tab toggles visibility via CSS so
                that switching is instant + state survives. The form's
                internal section filter (visibleSection) hides sections
                that don't belong to the active tab. */}
            <div className="flex-1 overflow-y-auto">
              <div style={{ display: tab === "summary" ? "block" : "none" }}>
                <div className="px-5 py-5">
                  <SummaryTab account={account} />
                </div>
              </div>
              <div style={{ display: tab !== "summary" ? "block" : "none" }}>
                {renderReconcileBody ? (
                  // The form decides which sections to actually render
                  // based on its visibleSection prop. The render-prop
                  // gets the current tab id so it can pass through.
                  <div className="px-1 py-1">
                    {renderReconcileBody(account, tab as DrawerFormSection)}
                  </div>
                ) : (
                  <PlaceholderTab title="Coming soon" hint="The reconcile body will appear here when wired." />
                )}
              </div>
            </div>

            {/* Sticky action footer — sits below the scrollable body,
                always visible. Parent decides which buttons render
                given the row's review_status. */}
            {renderFooter && (
              <div className="px-4 py-3 sticky bottom-0"
                style={{
                  background: "var(--surface)",
                  borderTop: "1px solid var(--border-strong)",
                  boxShadow: "0 -4px 12px rgba(0, 0, 0, 0.04)",
                }}>
                {renderFooter(account)}
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
  account, index, total, prevAcct, nextAcct, readOnly, onNavigate, onClose,
}: {
  account:    OverviewAccount
  index:      number
  total:      number
  prevAcct:   OverviewAccount | null
  nextAcct:   OverviewAccount | null
  readOnly:   boolean
  onNavigate: (a: OverviewAccount) => void
  onClose:    () => void
}) {
  return (
    <div className="px-5 pt-4 pb-3 sticky top-0 z-10"
      style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
      {/* Top row: position + nav + close */}
      <div className="flex items-center justify-between mb-3">
        <div className="text-[10px] font-semibold uppercase tracking-wider"
          style={{ color: "var(--text-muted)" }}>
          Account {index + 1} of {total}
        </div>
        <div className="flex items-center gap-1">
          <IconBtn
            label="Previous account (←)"
            disabled={!prevAcct}
            onClick={() => prevAcct && onNavigate(prevAcct)}
          >
            <ChevronLeft size={14} strokeWidth={2} />
          </IconBtn>
          <IconBtn
            label="Next account (→)"
            disabled={!nextAcct}
            onClick={() => nextAcct && onNavigate(nextAcct)}
          >
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
              style={{ color: "var(--text-muted)" }}>{account.account_number}</span>
            <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded"
              style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}>
              {account.group_label}
            </span>
            {readOnly && (
              <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded"
                style={{ background: "rgba(245, 158, 11, 0.12)", color: "#b45309" }}>
                Read-only
              </span>
            )}
          </div>
          <h2 className="text-base font-semibold text-theme truncate">
            {account.account_name}
          </h2>
        </div>
        <StatusPill status={account.review_status} />
      </div>

      {/* Balance strip — quick scan, mirrors the accordion's variance strip */}
      <div className="mt-3 grid grid-cols-3 gap-3">
        <BalanceCell label="GL"        value={account.gl_balance} />
        <BalanceCell label="Subledger" value={account.subledger_balance} />
        <BalanceCell label="Variance"  value={account.variance} accent={Math.abs(parseFloat(account.variance)) >= 0.5} />
      </div>
    </div>
  )
}

function StatusPill({ status }: { status: OverviewAccount["review_status"] }) {
  const tone = {
    approved: { bg: "rgba(16, 185, 129, 0.12)", fg: "#047857", icon: ShieldCheck, label: "Approved" },
    reviewed: { bg: "rgba(59, 130, 246, 0.12)", fg: "#1d4ed8", icon: CheckCircle2, label: "Reviewed" },
    flagged:  { bg: "rgba(239, 68, 68, 0.12)",  fg: "#b91c1c", icon: AlertTriangle, label: "Flagged" },
    pending:  { bg: "var(--surface-2)",         fg: "var(--text-muted)", icon: Clock, label: "Pending" },
  }[status] ?? { bg: "var(--surface-2)", fg: "var(--text-muted)", icon: Clock, label: status }
  const Icon = tone.icon
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wider shrink-0"
      style={{ background: tone.bg, color: tone.fg }}>
      <Icon size={11} strokeWidth={2.2} />
      {tone.label}
    </span>
  )
}

function BalanceCell({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  const n = parseFloat(value) || 0
  return (
    <div className="rounded-lg px-2.5 py-2"
      style={{ background: accent ? "rgba(239, 68, 68, 0.06)" : "var(--surface-2)" }}>
      <div className="text-[9px] font-semibold uppercase tracking-wider"
        style={{ color: "var(--text-muted)" }}>{label}</div>
      <div className="text-sm font-semibold tabular-nums mt-0.5"
        style={{ color: accent ? "#b91c1c" : "var(--text)" }}>
        {`$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
      </div>
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

function TabBar({ value, onChange, account }: {
  value:    DrawerTabId
  onChange: (v: DrawerTabId) => void
  account:  OverviewAccount
}) {
  // Light badges for tabs where we know counts cheaply.
  const itemsCount     = account.reconciling_items?.length ?? 0
  const evidenceCount  = account.evidence_count ?? 0
  const aiBadge        = account.ai_commentary ? 1 : 0
  const badge: Partial<Record<DrawerTabId, number>> = {
    items:    itemsCount,
    evidence: evidenceCount,
    ai:       aiBadge,
  }
  return (
    <div className="px-2 flex items-center gap-0 overflow-x-auto"
      style={{ borderBottom: "1px solid var(--border)" }}>
      {TABS.map((t) => {
        const active = t.id === value
        const Icon = t.icon
        const count = badge[t.id]
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            className="relative inline-flex items-center gap-1.5 px-3 py-2 text-[11px] font-semibold whitespace-nowrap transition-colors"
            style={{
              color: active ? "var(--text)" : "var(--text-muted)",
              borderBottom: active ? "2px solid var(--text)" : "2px solid transparent",
              marginBottom: "-1px",
            }}>
            <Icon size={12} strokeWidth={1.8} />
            {t.label}
            {count !== undefined && count > 0 && (
              <span className="inline-flex items-center justify-center rounded-full px-1.5 text-[9px] font-bold"
                style={{
                  background: active ? "var(--text)" : "var(--surface-2)",
                  color:      active ? "var(--surface)" : "var(--text-muted)",
                  minWidth: 16,
                  height: 16,
                }}>
                {count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

// ── Summary tab (real content) ────────────────────────────────────────

function SummaryTab({ account }: { account: OverviewAccount }) {
  const variance = parseFloat(account.variance) || 0
  const hasVariance = Math.abs(variance) >= 0.5

  return (
    <div className="space-y-4">
      {/* AI verdict snapshot */}
      {account.ai_commentary ? (
        <Card title="AI verdict" icon={<Brain size={13} strokeWidth={1.8} />}>
          <div className="flex items-center gap-2 mb-2">
            <ConfidencePill confidence={account.ai_commentary.confidence} />
            <RecommendationPill recommendation={account.ai_commentary.recommendation} />
          </div>
          <p className="text-[12px] leading-relaxed" style={{ color: "var(--text)" }}>
            {account.ai_commentary.narrative}
          </p>
          {account.ai_commentary.checks && account.ai_commentary.checks.length > 0 && (
            <ul className="mt-3 space-y-1.5">
              {account.ai_commentary.checks.map((c, i) => (
                <li key={i} className="flex items-start gap-2 text-[11px]">
                  <CheckDot status={c.status} />
                  <div>
                    <div className="font-semibold text-theme">{c.name}</div>
                    <div style={{ color: "var(--text-muted)" }}>{c.detail}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : (
        <Card title="AI verdict" icon={<Brain size={13} strokeWidth={1.8} />}>
          <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
            No AI commentary yet for this account. Run Agentic Mode from the row
            actions to generate a narrative + check list.
          </p>
        </Card>
      )}

      {/* Variance status */}
      <Card title="Variance status" icon={<FileText size={13} strokeWidth={1.8} />}>
        {!hasVariance ? (
          <div className="flex items-center gap-2">
            <CheckCircle2 size={14} strokeWidth={2} style={{ color: "#10b981" }} />
            <span className="text-[12px] text-theme">GL ties to subledger.</span>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <AlertTriangle size={14} strokeWidth={2} style={{ color: "#b45309" }} />
              <span className="text-[12px] text-theme">
                {`$${Math.abs(variance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} unreconciled.`}
              </span>
            </div>
            <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
              Jump to the <strong>Items</strong> tab to investigate the reconciling
              transactions.
            </p>
          </div>
        )}
      </Card>

      {/* Evidence at a glance */}
      <Card title="Supporting evidence" icon={<Paperclip size={13} strokeWidth={1.8} />}>
        <div className="text-[12px] text-theme">
          {account.evidence_count > 0
            ? `${account.evidence_count} file${account.evidence_count === 1 ? "" : "s"} attached.`
            : "No evidence uploaded yet."}
        </div>
      </Card>

      {/* Reviewer */}
      {account.reviewed_by && (
        <Card title="Reviewed" icon={<CheckCircle2 size={13} strokeWidth={1.8} />}>
          <div className="text-[12px] text-theme">
            By {account.reviewed_by}
            {account.reviewed_at && (
              <span style={{ color: "var(--text-muted)" }}>
                {" "}· {new Date(account.reviewed_at).toLocaleString()}
              </span>
            )}
          </div>
        </Card>
      )}
    </div>
  )
}

// ── Smaller building blocks ───────────────────────────────────────────

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

function PlaceholderTab({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-12 px-6">
      <div className="h-10 w-10 rounded-full flex items-center justify-center mb-3"
        style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}>
        <FileText size={18} strokeWidth={1.6} />
      </div>
      <h3 className="text-sm font-semibold text-theme mb-1">{title}</h3>
      <p className="text-[12px] max-w-xs" style={{ color: "var(--text-muted)" }}>
        {hint}
      </p>
    </div>
  )
}

function ConfidencePill({ confidence }: { confidence: "high" | "medium" | "low" }) {
  const tone = {
    high:   { bg: "rgba(16, 185, 129, 0.12)", fg: "#047857" },
    medium: { bg: "rgba(245, 158, 11, 0.12)", fg: "#b45309" },
    low:    { bg: "rgba(239, 68, 68, 0.12)",  fg: "#b91c1c" },
  }[confidence]
  return (
    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider"
      style={{ background: tone.bg, color: tone.fg }}>
      {confidence} confidence
    </span>
  )
}

function RecommendationPill({ recommendation }: { recommendation: "approve" | "review" | "investigate" }) {
  const tone = {
    approve:     { bg: "rgba(16, 185, 129, 0.12)", fg: "#047857" },
    review:      { bg: "rgba(59, 130, 246, 0.12)", fg: "#1d4ed8" },
    investigate: { bg: "rgba(239, 68, 68, 0.12)",  fg: "#b91c1c" },
  }[recommendation]
  return (
    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider"
      style={{ background: tone.bg, color: tone.fg }}>
      Recommend: {recommendation}
    </span>
  )
}

function CheckDot({ status }: { status: "pass" | "warn" | "fail" }) {
  const color = status === "pass" ? "#10b981" : status === "warn" ? "#f59e0b" : "#ef4444"
  return (
    <span className="inline-block rounded-full mt-1"
      style={{ width: 7, height: 7, background: color, flexShrink: 0 }} />
  )
}

// ── URL-hash <-> tab sync ──────────────────────────────────────────────

/** Reads / writes `#acct=<qbo_id>&tab=<tab>` so a refresh keeps the
 *  drawer open on the same account + tab and the URL is shareable. */
function useTabHash(qboId: string | null): [DrawerTabId, (t: DrawerTabId) => void] {
  const initial = readTabFromHash()
  const tabRef = useRef<DrawerTabId>(initial)
  const [, force] = useState(0)

  const setTab = useCallback((next: DrawerTabId) => {
    tabRef.current = next
    writeHashState(qboId, next)
    force((n) => n + 1)
  }, [qboId])

  // Whenever account changes, sync the hash with the open account.
  useEffect(() => {
    writeHashState(qboId, tabRef.current)
  }, [qboId])

  return [tabRef.current, setTab]
}

function readTabFromHash(): DrawerTabId {
  if (typeof window === "undefined") return "summary"
  const m = window.location.hash.match(/tab=([a-z]+)/)
  const candidate = (m?.[1] ?? "summary") as DrawerTabId
  return TABS.some((t) => t.id === candidate) ? candidate : "summary"
}

function writeHashState(qboId: string | null, tab: DrawerTabId): void {
  if (typeof window === "undefined") return
  const params = new URLSearchParams()
  if (qboId) params.set("acct", qboId)
  if (tab !== "summary") params.set("tab", tab)
  const next = params.toString()
  const target = next ? `#${next}` : ""
  if (window.location.hash !== target) {
    history.replaceState(null, "", `${window.location.pathname}${window.location.search}${target}`)
  }
}

/** Hook other components can use to read the deep-linked qbo_id on mount.
 *  Returns null when no acct in hash. */
export function readDrawerAcctFromHash(): string | null {
  if (typeof window === "undefined") return null
  const m = window.location.hash.match(/acct=([^&]+)/)
  return m?.[1] ?? null
}
