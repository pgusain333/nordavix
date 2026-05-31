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
import { useQuery } from "@tanstack/react-query"
import { AnimatePresence, motion } from "framer-motion"
import {
  AlertTriangle,
  Banknote,
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
import { formatDateTime } from "@/core/lib/dates"
import { schedulesApi } from "@/modules/schedules/api"

const TABS = [
  { id: "summary",     label: "Summary",     icon: Sparkles },
  { id: "bank_match",  label: "Bank match",  icon: Banknote, bankOnly: true },
  { id: "items",       label: "Items",       icon: Receipt   },
  { id: "suggestions", label: "Suggestions", icon: Layers    },
  { id: "evidence",    label: "Evidence",    icon: Paperclip },
  { id: "ai",          label: "AI",          icon: Brain     },
] as const
export type DrawerTabId = typeof TABS[number]["id"]
/** Tab ids that correspond to InlineSubledgerForm sections. Summary
 *  and bank_match are the drawer's own sections, not the form. */
export type DrawerFormSection = Exclude<DrawerTabId, "summary" | "bank_match">

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
  /** Render the bank-rec worksheet (only invoked when the "bank_match"
   *  tab is active AND the account is a Bank type — the tab itself is
   *  hidden otherwise). */
  renderBankBody?: (account: OverviewAccount) => React.ReactNode
  /** Renders a sticky action footer at the bottom of the drawer. The
   *  context object carries flags the footer needs to gate buttons
   *  beyond what's in `account` alone (e.g. has the user reviewed the
   *  Suggestions tab when suggestions exist for this account?). */
  renderFooter?:        (account: OverviewAccount, ctx: FooterCtx) => React.ReactNode
}

export interface FooterCtx {
  /** True when at least one of prepaid/accrual/FA/lease/loan
   *  per-account suggestion endpoints returns ≥1 item for this
   *  (account, period). When true, the user must visit the
   *  Suggestions tab before the footer enables prepare/approve —
   *  enforced by the consumer via `hasViewedSuggestionsTab`. */
  hasSuggestions:         boolean
  /** Sticks at true once the user has clicked the Suggestions tab
   *  during this drawer-open session. Resets when the account changes
   *  so a different account starts fresh. */
  hasViewedSuggestionsTab: boolean
}

// ── Width persistence ─────────────────────────────────────────────────

const WIDTH_KEY = "nordavix:recons-drawer-width"
// Wider default — the deep reconcile workflow (build-up + items + evidence)
// breathes much better at 720px. Users can drag narrower if they want
// more list visibility, or wider if they want more form room.
const DEFAULT_WIDTH = 720
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
  account, accounts, periodEnd, readOnly,
  onNavigate, onClose, renderReconcileBody, renderBankBody, renderFooter,
}: Props) {
  const [tab, setTab] = useTabHash(account?.qbo_id ?? null)
  const [width, setWidth] = useState<number>(() => loadWidth())

  // Suggestions presence — drives the "review Suggestions tab" gate on
  // the footer. Fires the 5 per-account suggestion queries in parallel.
  // React Query dedupes against the form's own subsequent fetches, so
  // the duplicate work is zero (cache hit) once the user opens the
  // Suggestions tab.
  const hasSuggestions = useHasSuggestionsForAccount(account?.qbo_id ?? null, periodEnd)

  // Sticky "has user looked at the Suggestions tab" flag. Resets when
  // the user navigates to a different account so each account gets its
  // own fresh acknowledgement.
  const [hasViewedSuggestionsTab, setHasViewedSuggestionsTab] = useState(false)
  const acctKeyRef = useRef<string | null>(account?.qbo_id ?? null)
  useEffect(() => {
    if (acctKeyRef.current !== (account?.qbo_id ?? null)) {
      acctKeyRef.current = account?.qbo_id ?? null
      setHasViewedSuggestionsTab(false)
    }
  }, [account])
  useEffect(() => {
    if (tab === "suggestions") setHasViewedSuggestionsTab(true)
  }, [tab])
  // Desktop vs mobile layout: desktop slides in from the right and
  // pushes the page content aside; mobile uses a bottom-sheet that
  // covers ~85vh, leaving the dashboard's KPI cards visible at the
  // top so the user keeps context. Tracks viewport changes (rotation,
  // window resize) so a tablet swap between portrait + landscape
  // re-picks the right pattern.
  const isLgUp = useMatchMedia("(min-width: 1024px)")

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

  // Push the page content aside on desktop only. We don't want the
  // drawer to OVERLAY the dashboard — that hides KPI cards + the
  // accounts list behind it. Publish the drawer's current width as a
  // CSS custom property on <body> so the page-level scroll container
  // can add a matching `padding-right` with a tweened transition.
  // On mobile (< lg) we use a bottom-sheet instead (see below), so
  // this var stays unset and no padding push happens.
  useEffect(() => {
    if (!account || !isLgUp) return
    document.body.style.setProperty("--detail-drawer-width", `${Math.min(width, window.innerWidth)}px`)
    document.body.classList.add("detail-drawer-open")
    return () => {
      document.body.style.removeProperty("--detail-drawer-width")
      document.body.classList.remove("detail-drawer-open")
    }
  }, [account, width, isLgUp])

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
          {/* Backdrop — semi-transparent click-to-close, mobile only.
              On mobile the drawer is a bottom-sheet so the backdrop
              covers ONLY the visible strip of dashboard above the
              sheet (15vh). Tap that strip to dismiss; tap a card on
              the dashboard requires closing first (standard sheet
              behavior). On desktop there's no backdrop — the drawer
              pushes content aside and the page stays interactive. */}
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
          {/* Drawer panel.
              Desktop: right-side panel that pushes the page content
              aside (see useEffect above that sets --detail-drawer-width).
              Mobile: bottom sheet that covers 85vh, leaving the top
              15vh strip showing the dashboard's KPI cards + page
              header. Slides up from the bottom with a calm spring. */}
          <motion.aside
            key="drawer"
            initial={isLgUp ? { x: "100%" } : { y: "100%" }}
            animate={isLgUp ? { x: 0 } : { y: 0 }}
            exit={isLgUp ? { x: "100%" } : { y: "100%" }}
            // Material-style ease for predictable, glide-y motion (no
            // spring overshoot, no jitter). willChange hint pushes the
            // panel onto the GPU compositor so the transform animates
            // off the main thread and stays smooth even while the
            // page content is reflowing for the push-aside layout.
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
            aria-label={`Account ${account.account_name} details`}
          >
            {/* Drag-handle indicator — visual cue that this is a
                dismissible sheet on mobile. Tap-target is the backdrop
                above the sheet. */}
            {!isLgUp && (
              <div className="flex justify-center pt-2 pb-1 shrink-0">
                <span style={{
                  width: 40, height: 4, borderRadius: 2,
                  background: "var(--border-strong)",
                }} />
              </div>
            )}
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

            <TabBar
              value={tab}
              onChange={setTab}
              account={account}
              suggestionsBadge={hasSuggestions && !hasViewedSuggestionsTab}
            />

            {/* "Review Suggestions" callout — visible whenever there's
                something in the Suggestions tab the user hasn't opened
                yet. Hidden once they click into Suggestions. Disappears
                entirely when no suggestions exist for this account. */}
            {hasSuggestions && !hasViewedSuggestionsTab && tab !== "suggestions" && (
              <div
                className="px-4 py-2 text-[11px] flex items-start gap-2"
                style={{
                  background: "rgba(124, 58, 237, 0.08)",
                  borderBottom: "1px solid var(--border)",
                  color: "#5b21b6",
                }}
              >
                <Sparkles size={12} strokeWidth={2} className="shrink-0 mt-px" />
                <span>
                  <span className="font-semibold">Auto-detected schedule entries are waiting in the Suggestions tab.</span>{" "}
                  Open that tab to review prepaid amortization, accrual reversals,
                  fixed-asset depreciation, lease, or loan lines for this account before
                  marking the recon prepared or approving it.
                </span>
                <button
                  type="button"
                  onClick={() => setTab("suggestions")}
                  className="ml-auto shrink-0 inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-bold uppercase tracking-wider transition-opacity hover:opacity-90"
                  style={{ background: "#7c3aed", color: "white" }}
                >
                  Open Suggestions
                </button>
              </div>
            )}

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
              {/* Bank-rec worksheet — only mounts when the tab is
                  active so the upload queries don't fire for non-bank
                  accounts (or even for bank accounts the user hasn't
                  opened this tab on yet). */}
              {tab === "bank_match" && renderBankBody && (
                <div className="px-1 py-1">
                  {renderBankBody(account)}
                </div>
              )}
              <div style={{ display: tab !== "summary" && tab !== "bank_match" ? "block" : "none" }}>
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
                {renderFooter(account, { hasSuggestions, hasViewedSuggestionsTab })}
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

/** Accounting-style currency: positive = $1,234.56, negative = $(1,234.56).
 *  Standard convention CPAs expect — beats the leading-minus style which
 *  is easy to miss when scanning a column. */
function fmtMoneyAcct(value: number): string {
  const abs = Math.abs(value).toLocaleString(undefined, {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })
  return value < 0 ? `$(${abs})` : `$${abs}`
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
        {fmtMoneyAcct(n)}
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

function TabBar({ value, onChange, account, suggestionsBadge }: {
  value:    DrawerTabId
  onChange: (v: DrawerTabId) => void
  account:  OverviewAccount
  /** When true, the Suggestions tab is decorated with a purple dot to
   *  draw the user's eye — paired with the body-level callout and the
   *  footer prepare/approve gate to enforce "review before signing". */
  suggestionsBadge?: boolean
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
  const tooltip: Partial<Record<DrawerTabId, string>> = {
    suggestions: "Auto-detected line items from Schedules (prepaids, accruals, fixed assets, leases, loans). Click to add them as reconciling items.",
  }
  return (
    // sticky + sub-header so tabs stay glued under the account name
    // header even when the user scrolls the form. overflow-x-auto +
    // shrink-0 buttons + scroll-snap so the active tab can scroll into
    // view on mobile when there isn't room for all five at once.
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
        // Hide bank-only tabs unless the account is actually a Bank type.
        const isBankAcct = (account.account_type || "").toLowerCase().includes("bank")
        if ((t as { bankOnly?: boolean }).bankOnly && !isBankAcct) return null
        const active = t.id === value
        const Icon = t.icon
        const count = badge[t.id]
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            title={tooltip[t.id]}
            className="relative inline-flex items-center gap-1.5 px-3 py-2 text-[11px] font-semibold whitespace-nowrap transition-colors shrink-0"
            style={{
              color: active ? "var(--text)" : "var(--text-muted)",
              borderBottom: active ? "2px solid var(--text)" : "2px solid transparent",
              marginBottom: "-1px",
              scrollSnapAlign: "center",
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
            {t.id === "suggestions" && suggestionsBadge && (
              <span
                className="inline-block rounded-full"
                style={{
                  width: 7,
                  height: 7,
                  background: "#7c3aed",
                  marginLeft: 2,
                }}
                aria-label="Unreviewed suggestions"
              />
            )}
          </button>
        )
      })}
    </div>
  )
}

// ── Suggestions presence hook ─────────────────────────────────────────
//
// "Does this (account, period) have any AI-driven schedule suggestions
// the user should review before marking the recon prepared / approved?"
//
// Fires the 5 per-account suggestion endpoints in parallel. React Query
// caches each result by (kind, qboId, periodEnd), so when the user
// later opens the Suggestions tab the form's internal queries hit the
// same cache and don't re-fetch. Only enabled when `qboId` is set
// (drawer open).

function useHasSuggestionsForAccount(
  qboId: string | null,
  periodEnd: string,
): boolean {
  const enabled = !!qboId
  const prepaid = useQuery({
    queryKey: ["schedules", "prepaid", "suggestions", qboId, periodEnd],
    queryFn:  () => schedulesApi.getPrepaidSuggestions(qboId!, periodEnd),
    enabled,
    staleTime: 30_000,
  })
  const accrual = useQuery({
    queryKey: ["schedules", "accrual", "suggestions", qboId, periodEnd],
    queryFn:  () => schedulesApi.getAccrualSuggestions(qboId!, periodEnd),
    enabled,
    staleTime: 30_000,
  })
  const fa = useQuery({
    queryKey: ["schedules", "fixed_asset", "suggestions", qboId, periodEnd],
    queryFn:  () => schedulesApi.getFixedAssetSuggestions(qboId!, periodEnd),
    enabled,
    staleTime: 30_000,
  })
  const lease = useQuery({
    queryKey: ["schedules", "lease", "suggestions", qboId, periodEnd],
    queryFn:  () => schedulesApi.getLeaseSuggestions(qboId!, periodEnd),
    enabled,
    staleTime: 30_000,
  })
  const loan = useQuery({
    queryKey: ["schedules", "loan", "suggestions", qboId, periodEnd],
    queryFn:  () => schedulesApi.getLoanSuggestions(qboId!, periodEnd),
    enabled,
    staleTime: 30_000,
  })

  if (!enabled) return false
  return (
    (prepaid.data?.items?.length ?? 0) > 0
    || (accrual.data?.items?.length ?? 0) > 0
    || (fa.data?.items?.length ?? 0) > 0
    || (lease.data?.items?.length ?? 0) > 0
    || (loan.data?.items?.length ?? 0) > 0
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
                {`${fmtMoneyAcct(variance)} unreconciled.`}
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
                {" "}· {formatDateTime(account.reviewed_at)}
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

/** Minimal SSR-safe matchMedia subscription. Returns the current value
 *  and re-renders when it changes. Defaulted to false during SSR. */
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
