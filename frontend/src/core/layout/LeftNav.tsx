/**
 * Left navigation sidebar — Nordavix app shell.
 * Theme-aware, mobile-ready (accepts onClose for overlay dismiss).
 *
 * Collapsible: on desktop the rail defaults to ICON-ONLY (~68px) and can be
 * expanded to the full labelled sidebar (240px) via the toggle in the header.
 * The choice persists in localStorage. When collapsed, every icon carries a
 * native `title` tooltip so labels are one hover away. The mobile slide-in
 * drawer (onClose present) is always full-width — collapse is desktop-only.
 */
import { useEffect, useRef, useState } from "react"
import { NavLink, useNavigate } from "react-router-dom"
import { UserButton, useOrganization, useUser } from "@clerk/clerk-react"
import {
  LayoutDashboard, BarChart3, Scale, FileText, ArrowLeftRight,
  Plug, Users, X, Pencil, Check, CheckSquare, BookOpen,
  MessageSquare, Settings, Lightbulb, LifeBuoy, ClipboardList, Search,
  PanelLeft, PanelLeftClose, Sparkles, ShieldCheck, Target, Rocket, ListChecks,
  type LucideIcon,
} from "lucide-react"
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import { cn } from "@/core/ui/utils"
import { Badge } from "@/core/ui/components"
import { ThemeToggle } from "@/core/theme/ThemeToggle"
import { FeedbackDialog } from "@/core/ui/FeedbackDialog"
import { WorkspaceSwitcher } from "@/core/layout/WorkspaceSwitcher"
import { workspaceApi } from "@/modules/workspace/api"
import { tasksApi } from "@/modules/tasks/api"
import { reconsApi } from "@/modules/recons/api"
import { api as fluxApi } from "@/modules/flux/api"
import { CMDK_EVENT } from "@/core/ui/CommandPalette"
import { NotificationBell } from "@/modules/notifications/NotificationBell"

const COLLAPSE_KEY = "ndvx.nav.collapsed"

interface NavItem {
  label:     string
  path:      string
  icon:      LucideIcon
  available: boolean
}

/**
 * Kick off the dynamic import for a lazy-loaded route on hover. Once
 * the chunk is fetched, the next time the user actually navigates the
 * page renders without a Suspense flash.
 *
 * Maps each nav path to the same lazy import App.tsx uses. Calling
 * import() a second time is free — Vite returns the already-resolved
 * promise — so we don't bother memoizing.
 */
function prefetchRoute(path: string): void {
  // Strip query/hash + the /app prefix for matching.
  const p = path.replace(/[?#].*$/, "").replace(/^\/app\/?/, "")
  switch (p) {
    case "":               return // Dashboard is eager
    case "autopilot":      void import("@/modules/autopilot/pages/AutopilotPage");          return
    case "close":          void import("@/modules/close/pages/CloseWorkflowPage");          return
    case "tasks":          void import("@/modules/tasks/pages/TasksPage");                  return
    case "connections":    void import("@/modules/connections/pages/ConnectionsPage");      return
    case "flux":           void import("@/modules/flux/pages/FluxMonthIndex");              return
    case "reconciliations":void import("@/modules/recons/pages/ReconciliationsMonthIndex"); return
    case "schedules":      void import("@/modules/schedules/pages/SchedulesOverview");      return
    case "intercompany":   void import("@/modules/intercompany/pages/IntercompanyPage");    return
    case "financials":     void import("@/modules/financials/pages/FinancialsPage");        return
    case "insights":       void import("@/modules/insights/pages/InsightsPage");            return
    case "adjustments":    void import("@/modules/adjustments/pages/AdjustmentsPage");       return
    case "review":         void import("@/modules/review/pages/CloseReviewPage");           return
    case "advisory":       void import("@/modules/advisory/pages/AdvisoryPage");             return
    case "team":           void import("@/modules/workspace/pages/TeamPage");               return
    case "settings":       void import("@/modules/settings/pages/SettingsPage");            return
    case "help":           void import("@/modules/help/pages/HelpPage");                    return
  }
}

/**
 * Warm the destination's DATA on hover, not just its code chunk — this is what
 * makes the numbers paint instantly on click. We prefetch the period-agnostic
 * queries each page reads first (books-status, period-tracker, flux TBs, the
 * tasks list) using the EXACT same queryKey + queryFn + staleTime as the pages
 * themselves, so React Query treats it as the same cache entry: fresh data →
 * no-op; stale/missing → fetched in the hover-to-click gap. Pages still own
 * their period-keyed queries, but those fire immediately on mount because the
 * books-status / tracker gates they `enabled:`-wait on are already cached —
 * collapsing the old two-round-trip serial chain into zero or one.
 */
function prefetchData(qc: QueryClient, path: string): void {
  const p = path.replace(/[?#].*$/, "").replace(/^\/app\/?/, "")
  const warm = (queryKey: unknown[], queryFn: () => Promise<unknown>, staleTime: number) =>
    void qc.prefetchQuery({ queryKey, queryFn, staleTime }).catch(() => {})
  const books   = () => warm(["books-status"],          reconsApi.getBooksStatus,    5 * 60_000)
  const tracker = () => warm(["period-tracker"],        reconsApi.listPeriodTracker, 60_000)
  const fluxTBs = () => warm(["flux-trial-balances"],   fluxApi.listTrialBalances,   30_000)
  const tasks   = () => warm(["tasks", "all-with-closed"], () => tasksApi.list(true), 30_000)
  switch (p) {
    case "":               books(); tracker(); fluxTBs(); tasks(); return  // dashboard reads all four
    case "reconciliations":
    case "schedules":
    case "adjustments":    books(); tracker();           return
    case "flux":           books(); tracker(); fluxTBs(); return
    case "tasks":          tasks();                      return
  }
}

// Order (per spec):
//   Dashboard → Tasks → Connections → Schedules → Flux → Intercompany
//   → Reconciliations → Insights → Financial Package → Team
// Rationale: connections sets up data sources, then the close mechanics
// flow in the order they typically run during a month-end: schedules
// (commit prepaid/accrual/etc balances), flux (variance analysis on
// the synced TB), intercompany (eliminate IC), reconciliations (tie
// out balance-sheet accounts), insights (analytical review), then
// the financial package (output deliverable). Team is admin / settings-
// adjacent and sits last.
const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard",          path: "/app",                 icon: LayoutDashboard, available: true  },
  { label: "Close Autopilot",    path: "/app/autopilot",       icon: Rocket,          available: true  },
  { label: "Close Workflow",     path: "/app/close",           icon: ListChecks,      available: true  },
  { label: "Close Tasks",        path: "/app/tasks",           icon: CheckSquare,     available: true  },
  { label: "Connections",        path: "/app/connections",     icon: Plug,            available: true  },
  { label: "Schedules",          path: "/app/schedules",       icon: ClipboardList,   available: true  },
  { label: "Flux Analysis",      path: "/app/flux",            icon: BarChart3,       available: true  },
  { label: "Intercompany",       path: "/app/intercompany",    icon: ArrowLeftRight,  available: true  },
  { label: "Reconciliations",    path: "/app/reconciliations", icon: Scale,           available: true  },
  { label: "Adjustments",        path: "/app/adjustments",     icon: Sparkles,        available: true  },
  { label: "Close Review",       path: "/app/review",          icon: ShieldCheck,     available: true  },
  { label: "Insights",           path: "/app/insights",        icon: Lightbulb,       available: true  },
  { label: "Advisory",           path: "/app/advisory",        icon: Target,          available: true  },
  { label: "Financial Statements", path: "/app/financials",     icon: BookOpen,        available: true  },
  { label: "Team",               path: "/app/team",            icon: Users,           available: true  },
  { label: "Workpapers",         path: "/app/workpapers",      icon: FileText,        available: false },
]

interface Props {
  onClose?: () => void
}

export function LeftNav({ onClose }: Props) {
  const { organization } = useOrganization()
  const { user } = useUser()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [feedbackOpen, setFeedbackOpen] = useState(false)

  // Role for UI gating (shared cache key — TopBar/Adjustments use the same
  // query, so this is a cache hit, not an extra request). Only admins get
  // the company-rename affordance below.
  const { data: meRole } = useQuery({
    queryKey: ["workspace-me"],
    queryFn:  workspaceApi.getMe,
    staleTime: 5 * 60_000,
  })
  const isAdmin = meRole?.role === "admin"

  // Collapsed (icon-only) rail — persisted; defaults to collapsed so the app
  // opens lean. Only applies to the desktop rail; the mobile drawer (onClose
  // present) is always the full labelled sidebar.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return true
    return localStorage.getItem(COLLAPSE_KEY) !== "0"
  })
  // Peek-on-hover: when the rail is collapsed, hovering it slides the full
  // sidebar open — floating OVER the page (no content reflow) — and moving
  // away collapses it back. Short open + close delays keep a quick mouse
  // pass-by from triggering it and avoid flicker at the edge.
  const [hovered, setHovered] = useState(false)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  function onRailEnter() {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = setTimeout(() => setHovered(true), 130)   // open delay
  }
  function onRailLeave() {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = setTimeout(() => setHovered(false), 140)  // close delay
  }
  useEffect(() => () => { if (hoverTimer.current) clearTimeout(hoverTimer.current) }, [])

  const pinnedCollapsed = collapsed && !onClose    // the user's persisted desktop choice
  const isCollapsed = pinnedCollapsed && !hovered  // whether it's visually icon-only right now
  function toggleCollapsed() {
    setCollapsed((c) => {
      const next = !c
      try { localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0") } catch { /* private mode */ }
      return next
    })
  }

  // Resolve the current user's role so we can show a small chip next to
  // the account email at the bottom of the nav. Long staleTime — role
  // changes rarely.
  const { data: me } = useQuery({
    queryKey: ["workspace-me"],
    queryFn:  workspaceApi.getMe,
    staleTime: 10 * 60_000,
    enabled:  !!organization,
  })

  // Open-tasks count for the Tasks nav badge. Lightweight call — server
  // returns just the numbers, not the full list. 30-second staleness +
  // refetch-on-navigation keeps the badge current without re-firing on
  // every tab-switch (inherits the global refetchOnWindowFocus:false).
  const { data: tasksCount } = useQuery({
    queryKey: ["tasks", "count"],
    queryFn:  tasksApi.getCount,
    staleTime: 30_000,
    enabled:  !!organization,
  })
  const roleMeta = me ? ({
    admin:    { label: "Admin",    bg: "rgba(199, 154, 82, 0.15)", fg: "#c79a52" },
    reviewer: { label: "Reviewer", bg: "#e9eef3",                  fg: "#3c5a76" },
    preparer: { label: "Preparer", bg: "var(--surface-2)",         fg: "var(--text-muted)" },
  } as const)[me.role as "admin" | "reviewer" | "preparer"] : null

  return (
    <>
      {/* Desktop spacer — reserves the *pinned* width in the flex row so the
          rail's hover-peek floats OVER the page instead of reflowing it.
          (Not rendered in the mobile drawer, which is full-width already.) */}
      {!onClose && (
        <div
          aria-hidden
          className={cn(
            "hidden lg:block shrink-0 transition-[width] duration-200 ease-out",
            pinnedCollapsed ? "w-[84px]" : "w-[282px]",
          )}
        />
      )}
    <aside
      onMouseEnter={onClose ? undefined : onRailEnter}
      onMouseLeave={onClose ? undefined : onRailLeave}
      // h-screen + overflow-y-auto on the aside itself so short mobile
      // viewports can scroll to the account section. transition-[width] gives
      // a smooth expand/collapse. overflow-x-hidden stops labels from spilling
      // during the width animation.
      className={cn(
        // no-scrollbar: the rail can still scroll on short viewports, we just
        // hide the scrollbar chrome for a cleaner look.
        "no-scrollbar flex h-screen flex-col overflow-y-auto overflow-x-hidden transition-[width] duration-200 ease-out",
        // Desktop: fixed so a hover-peek floats over content (the spacer above
        // holds the layout width). Mobile drawer (onClose) stays a normal
        // full-width panel inside its own fixed parent.
        onClose ? "w-[376px]" : "fixed inset-y-0 left-0 z-40",
        !onClose && (isCollapsed ? "w-[84px]" : "w-[282px]"),
        // Lift the rail with a shadow only while it's peeking open over content.
        !onClose && hovered && pinnedCollapsed && "shadow-2xl",
      )}
      style={{ background: "var(--nav-bg)", borderRight: "1px solid var(--nav-border)" }}
    >
      {/* Brand + collapse toggle */}
      <div
        className={cn(
          "flex px-3 py-[18px]",
          isCollapsed ? "flex-col items-center gap-2" : "items-center justify-between",
        )}
        style={{ borderBottom: "1px solid var(--nav-border)" }}
      >
        <button
          onClick={() => { navigate("/"); onClose?.() }}
          className={cn("flex items-center min-w-0", isCollapsed ? "justify-center" : "gap-2.5 flex-1")}
          title="Nordavix home"
        >
          {/* White mark on the burgundy rail (same in light + dark). */}
          <img src="/logo-mark-white.svg" alt="Nordavix"
            className="h-8 w-8 lg:h-9 lg:w-9 shrink-0" />
          {!isCollapsed && (
            <span className="text-xl lg:text-[24px] font-semibold tracking-tight leading-none truncate"
              style={{ color: "#FFFFFF" }}>
              nordavix<span style={{ color: "#9CC4AD" }}>.</span>
            </span>
          )}
        </button>

        {/* Collapse / expand — desktop only (hidden inside the mobile drawer) */}
        {!onClose && (
          <button
            onClick={toggleCollapsed}
            className="hidden lg:flex items-center justify-center h-8 w-8 rounded-md transition-colors shrink-0"
            style={{ color: "var(--nav-text)" }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--nav-hover)"; e.currentTarget.style.color = "var(--nav-text-act)" }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--nav-text)" }}
            title={collapsed ? "Keep sidebar open" : "Collapse sidebar"}
            aria-label={collapsed ? "Keep sidebar open" : "Collapse sidebar"}
          >
            {collapsed ? <PanelLeft size={16} strokeWidth={1.8} /> : <PanelLeftClose size={16} strokeWidth={1.8} />}
          </button>
        )}

        {/* Mobile close button (drawer only) */}
        {onClose && (
          <button
            onClick={onClose}
            className="lg:hidden ml-2 flex items-center justify-center h-7 w-7 rounded-md transition-colors"
            style={{ color: "var(--nav-text)" }}
          >
            <X size={16} strokeWidth={1.6} />
          </button>
        )}
      </div>

      {/* Org name — click to rename (hidden when collapsed) */}
      {organization && !isCollapsed && (
        <OrgNameInline organizationName={organization.name} canRename={isAdmin}
          onRename={(n) => organization.update({ name: n })} />
      )}

      {/* Quick search + bell — desktop has these in the top bar now, so this
          row renders only inside the mobile drawer (onClose present). */}
      {onClose && (
      <div className={cn("px-2 pt-2.5 flex gap-1.5", isCollapsed ? "flex-col items-center" : "items-center")}>
        {isCollapsed ? (
          <button
            // Collapsed rail is desktop-only (collapse never applies in the
            // mobile drawer), so there's no drawer to close here.
            onClick={() => window.dispatchEvent(new Event(CMDK_EVENT))}
            className="flex items-center justify-center h-10 w-10 rounded-md transition-colors"
            style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}
            title="Search and jump anywhere (⌘K)" aria-label="Search"
          >
            <Search size={18} strokeWidth={1.8} style={{ color: "var(--text-muted)" }} />
          </button>
        ) : (
          <button
            onClick={() => { window.dispatchEvent(new Event(CMDK_EVENT)); onClose?.() }}
            className="flex-1 min-w-0 inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors"
            style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}
            title="Search and jump anywhere (⌘K)"
          >
            <Search size={16} strokeWidth={1.8} className="shrink-0" style={{ color: "var(--text-muted)" }} />
            <span className="flex-1 text-left" style={{ color: "var(--text-muted)" }}>Search…</span>
            <kbd className="text-[10px] px-1 py-0.5 rounded"
              style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text-muted)" }}>⌘K</kbd>
          </button>
        )}
        {/* Bell lives in the desktop top bar now; this row is mobile-only, so
            it shows here for quick access inside the drawer. */}
        <NotificationBell onOpen={onClose} className="h-9 w-9" />
      </div>
      )}

      <nav className="shrink-0 px-2 py-3 space-y-0.5">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon

          if (!item.available) {
            if (isCollapsed) {
              return (
                <div
                  key={item.path}
                  className="flex items-center justify-center h-10 rounded-md opacity-35 cursor-not-allowed"
                  style={{ color: "var(--nav-text)" }}
                  title={`${item.label} (coming soon)`}
                >
                  <Icon size={23} strokeWidth={1.6} />
                </div>
              )
            }
            return (
              <div
                key={item.path}
                className="flex items-center justify-between rounded-md px-3 py-2 text-sm cursor-not-allowed opacity-35"
                style={{ color: "var(--nav-text)" }}
              >
                <span className="flex items-center gap-2.5">
                  <Icon size={24} strokeWidth={1.6} className="shrink-0" />
                  {item.label}
                </span>
                <Badge variant="soon">soon</Badge>
              </div>
            )
          }

          return (
            <NavLink
              key={item.path}
              to={item.path}
              end={item.path === "/app"}
              onClick={() => onClose?.()}
              // Prefetch the destination's lazy chunk on hover/focus so the
              // click renders immediately instead of waiting for JS.
              onMouseEnter={() => { prefetchRoute(item.path); prefetchData(qc, item.path) }}
              onFocus={() => { prefetchRoute(item.path); prefetchData(qc, item.path) }}
              title={isCollapsed ? item.label : undefined}
              className={({ isActive }) =>
                cn("flex items-center rounded-md text-sm transition-colors duration-150",
                  isCollapsed ? "relative justify-center h-10" : "gap-2.5 px-3 py-2",
                  // Hover = simple row highlight only — no slide / motion.
                  "hover:bg-[var(--nav-hover)]",
                  isActive ? "font-medium" : "")
              }
              style={({ isActive }) => isActive
                ? { background: "var(--nav-active)", color: "var(--nav-text-act)" }
                : { color: "var(--nav-text)" }
              }
            >
              {({ isActive }) => {
                // Tasks nav item gets a count badge when there's open work.
                const isTasksItem = item.path === "/app/tasks"
                const taskBadge = isTasksItem && tasksCount
                  ? (tasksCount.critical > 0
                      ? { count: tasksCount.open, bg: "#f4e9e7", fg: "#9b3d37" }
                      : tasksCount.open > 0
                        ? { count: tasksCount.open, bg: "var(--green-subtle)", fg: "var(--green)" }
                        : null)
                  : null

                if (isCollapsed) {
                  return (
                    <>
                      <Icon size={23} strokeWidth={1.8}
                        style={{ color: isActive ? "var(--nav-text-act)" : "var(--nav-text)" }} />
                      {taskBadge && (
                        <span className="absolute top-0.5 right-0.5 inline-flex items-center justify-center min-w-[15px] h-[15px] rounded-full px-1 text-[9px] font-bold tabular-nums"
                          style={{ background: taskBadge.bg, color: taskBadge.fg }}
                          title={`${tasksCount?.open ?? 0} open tasks`}>
                          {taskBadge.count > 9 ? "9+" : taskBadge.count}
                        </span>
                      )}
                    </>
                  )
                }
                return (
                  <>
                    <Icon size={24} strokeWidth={1.6} className="shrink-0"
                      style={{ color: isActive ? "var(--nav-text-act)" : "var(--nav-text)" }} />
                    <span className="truncate flex-1">{item.label}</span>
                    {taskBadge && (
                      <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] rounded-full px-1 text-[10px] font-bold tabular-nums shrink-0"
                        style={{ background: taskBadge.bg, color: taskBadge.fg }}
                        title={tasksCount?.critical
                          ? `${tasksCount.critical} critical of ${tasksCount.open} open tasks`
                          : `${tasksCount?.open ?? 0} open tasks`}>
                        {taskBadge.count > 99 ? "99+" : taskBadge.count}
                      </span>
                    )}
                    {isActive && !taskBadge && (
                      <span className="ml-auto h-1.5 w-1.5 rounded-full shrink-0"
                        style={{ background: "var(--nav-text-act)" }} />
                    )}
                  </>
                )
              }}
            </NavLink>
          )
        })}
      </nav>

      {/* Settings + Help + Feedback — utility actions. */}
      <div
        className={cn("pt-2 pb-1", isCollapsed ? "px-2 space-y-1" : "px-3 space-y-1.5")}
        style={{ borderTop: "1px solid var(--nav-border)" }}
      >
        <UtilLink to="/app/settings" icon={Settings} label="Settings"
          title="Edit company profile, address, tax info, accounting defaults"
          isCollapsed={isCollapsed} onClose={onClose} />
        <UtilLink to="/app/help" icon={LifeBuoy} label="Help"
          title="Step-by-step guide — every workflow, every screen"
          isCollapsed={isCollapsed} onClose={onClose} />

        {isCollapsed ? (
          <button
            type="button"
            onClick={() => setFeedbackOpen(true)}
            title="Share a bug, idea, or comment with the Nordavix team"
            className="w-full flex items-center justify-center h-10 rounded-md transition-colors"
            style={{ color: "var(--nav-text)" }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--nav-hover)"; e.currentTarget.style.color = "var(--nav-text-act)" }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--nav-text)" }}
          >
            <MessageSquare size={18} strokeWidth={1.8} />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setFeedbackOpen(true)}
            className="w-full inline-flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-all"
            style={{
              color: "var(--nav-text)",
              background: "transparent",
              border: "1px dashed rgba(255,255,255,0.35)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--nav-hover)"
              e.currentTarget.style.color = "var(--nav-text-act)"
              e.currentTarget.style.borderColor = "rgba(255,255,255,0.7)"
              e.currentTarget.style.borderStyle = "solid"
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent"
              e.currentTarget.style.color = "var(--nav-text)"
              e.currentTarget.style.borderColor = "rgba(255,255,255,0.35)"
              e.currentTarget.style.borderStyle = "dashed"
            }}
            title="Share a bug, idea, or comment with the Nordavix team"
          >
            <MessageSquare size={16} strokeWidth={1.8} className="shrink-0" />
            <span className="flex-1 text-left">Send feedback</span>
          </button>
        )}
      </div>
      <FeedbackDialog open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />

      {/* Bottom: theme + user */}
      <div
        className={cn("py-3", isCollapsed ? "px-2 flex flex-col items-center gap-3" : "px-3 space-y-3")}
        style={{ borderTop: "1px solid var(--nav-border)" }}
      >
        {isCollapsed ? (
          <div title="Toggle theme"><ThemeToggle /></div>
        ) : (
          <div className="flex items-center justify-between px-1">
            <span className="text-[11px] font-medium" style={{ color: "var(--nav-text)" }}>Theme</span>
            <ThemeToggle />
          </div>
        )}

        {/* Account block lives in the desktop top bar now; keep it in the
            mobile drawer (onClose present) for sign-out + role access. */}
        {onClose && (
          <div className={cn("flex items-center", isCollapsed ? "justify-center" : "gap-2 px-1")}>
            <UserButton
              afterSignOutUrl="/sign-in"
              appearance={{ elements: { avatarBox: "h-7 w-7" } }}
            />
            {!isCollapsed && (
              <div className="min-w-0 flex-1">
                <p className="text-xs truncate" style={{ color: "var(--nav-text)" }}>
                  {user?.fullName ?? user?.primaryEmailAddress?.emailAddress ?? "Account"}
                </p>
                {roleMeta && (
                  <span
                    onClick={() => { navigate("/app/team"); onClose?.() }}
                    className="mt-0.5 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide cursor-pointer transition-opacity hover:opacity-80"
                    style={{ background: roleMeta.bg, color: roleMeta.fg }}
                    title="Click to open the Team page"
                  >
                    {roleMeta.label}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
    </>
  )
}

// ── Utility nav link (Settings / Help) — collapses to an icon button ─────────

function UtilLink({ to, icon: Icon, label, title, isCollapsed, onClose }: {
  to: string
  icon: LucideIcon
  label: string
  title?: string
  isCollapsed: boolean
  onClose?: () => void
}) {
  return (
    <NavLink
      to={to}
      onClick={onClose}
      title={isCollapsed ? label : title}
      className={({ isActive }) =>
        cn(
          "w-full inline-flex items-center rounded-md text-sm font-medium transition-colors duration-150",
          isCollapsed ? "justify-center h-10" : "gap-2.5 px-3 py-2",
          isActive ? "" : "hover:bg-[var(--nav-hover)]",
        )
      }
      style={({ isActive }) => ({
        color: isActive ? "var(--nav-text-act)" : "var(--nav-text)",
        background: isActive ? "var(--nav-active)" : "transparent",
      })}
    >
      <Icon size={isCollapsed ? 20 : 18} strokeWidth={1.8} className="shrink-0" />
      {!isCollapsed && <span className="flex-1 text-left">{label}</span>}
    </NavLink>
  )
}

// ── OrgNameInline ───────────────────────────────────────────────────────────
// Click the workspace name to rename. Enter saves; Esc cancels.
// Wraps Clerk's `organization.update({ name })` so members with admin
// permission can change the workspace label without leaving the app.

interface OrgNameInlineProps {
  organizationName: string
  onRename: (name: string) => Promise<unknown>
  /** Only admins may rename the company. When false the name renders as
   *  plain text — no pencil, no dead-end edit attempt. */
  canRename?: boolean
}

function OrgNameInline({ organizationName, onRename, canRename = false }: OrgNameInlineProps) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(organizationName)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Stay in sync if Clerk updates the org from elsewhere
  useEffect(() => { setValue(organizationName) }, [organizationName])

  // Focus & select-all when entering edit mode
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  async function commit() {
    const next = value.trim()
    if (!next || next === organizationName) { setEditing(false); setValue(organizationName); return }
    setSaving(true); setError(null)
    try {
      await onRename(next)
      setEditing(false)
    } catch {
      // Most likely cause: user isn't an admin of this org
      setError("Couldn't rename. You may not have permission.")
    } finally {
      setSaving(false)
    }
  }

  function cancel() {
    setValue(organizationName)
    setEditing(false)
    setError(null)
  }

  return (
    <div
      className="px-4 py-2 group relative"
      style={{ borderBottom: "1px solid var(--nav-border)" }}
    >
      {editing ? (
        <div className="flex items-center gap-1.5">
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit()
              else if (e.key === "Escape") cancel()
            }}
            disabled={saving}
            className="flex-1 min-w-0 rounded px-1.5 py-0.5 text-xs outline-none"
            style={{
              background: "var(--surface-2)",
              border: "1px solid var(--border-strong)",
              color: "var(--text)",
            }}
            onFocus={(e) => (e.currentTarget.style.borderColor = "var(--green)")}
            onBlur={(e) => (e.currentTarget.style.borderColor = "var(--border-strong)")}
          />
          <button
            onClick={commit}
            disabled={saving}
            className="shrink-0 h-5 w-5 rounded flex items-center justify-center"
            style={{ color: "var(--green)" }}
            title="Save"
          >
            <Check size={13} strokeWidth={2.2} />
          </button>
          <button
            onClick={cancel}
            disabled={saving}
            className="shrink-0 h-5 w-5 rounded flex items-center justify-center"
            style={{ color: "var(--text-muted)" }}
            title="Cancel"
          >
            <X size={13} strokeWidth={2.2} />
          </button>
        </div>
      ) : (
        <>
          {canRename ? (
            <button
              onClick={() => setEditing(true)}
              className="flex items-center gap-1.5 w-full text-left group/btn"
              title="Click to rename company"
            >
              <p className="text-xs truncate flex-1" style={{ color: "var(--nav-text)" }}>{organizationName}</p>
              <Pencil
                size={11}
                strokeWidth={1.8}
                className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                style={{ color: "var(--text-muted)" }}
              />
            </button>
          ) : (
            // Preparers/reviewers: company name is read-only (admin renames).
            <p className="text-xs truncate" style={{ color: "var(--nav-text)" }} title={organizationName}>
              {organizationName}
            </p>
          )}
          {/* Workspace switcher — dropdown listing every org the user
              belongs to, + "Create company" footer. */}
          <div className="mt-1">
            <WorkspaceSwitcher />
          </div>
        </>
      )}
      {error && (
        <p className="text-[10px] mt-1" style={{ color: "#9b3d37" }}>{error}</p>
      )}
    </div>
  )
}
