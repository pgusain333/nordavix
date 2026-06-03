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
  PanelLeft, PanelLeftClose,
  type LucideIcon,
} from "lucide-react"
import { useQuery } from "@tanstack/react-query"
import { cn } from "@/core/ui/utils"
import { Badge } from "@/core/ui/components"
import { ThemeToggle } from "@/core/theme/ThemeToggle"
import { FeedbackDialog } from "@/core/ui/FeedbackDialog"
import { WorkspaceSwitcher } from "@/core/layout/WorkspaceSwitcher"
import { workspaceApi } from "@/modules/workspace/api"
import { tasksApi } from "@/modules/tasks/api"
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
    case "tasks":          void import("@/modules/tasks/pages/TasksPage");                  return
    case "connections":    void import("@/modules/connections/pages/ConnectionsPage");      return
    case "flux":           void import("@/modules/flux/pages/FluxMonthIndex");              return
    case "reconciliations":void import("@/modules/recons/pages/ReconciliationsMonthIndex"); return
    case "schedules":      void import("@/modules/schedules/pages/SchedulesOverview");      return
    case "intercompany":   void import("@/modules/intercompany/pages/IntercompanyPage");    return
    case "financials":     void import("@/modules/financials/pages/FinancialsPage");        return
    case "insights":       void import("@/modules/insights/pages/InsightsPage");            return
    case "team":           void import("@/modules/workspace/pages/TeamPage");               return
    case "settings":       void import("@/modules/settings/pages/SettingsPage");            return
    case "help":           void import("@/modules/help/pages/HelpPage");                    return
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
  { label: "Close Tasks",        path: "/app/tasks",           icon: CheckSquare,     available: true  },
  { label: "Connections",        path: "/app/connections",     icon: Plug,            available: true  },
  { label: "Schedules",          path: "/app/schedules",       icon: ClipboardList,   available: true  },
  { label: "Flux Analysis",      path: "/app/flux",            icon: BarChart3,       available: true  },
  { label: "Intercompany",       path: "/app/intercompany",    icon: ArrowLeftRight,  available: true  },
  { label: "Reconciliations",    path: "/app/reconciliations", icon: Scale,           available: true  },
  { label: "Insights",           path: "/app/insights",        icon: Lightbulb,       available: true  },
  { label: "Financial Package",  path: "/app/financials",      icon: BookOpen,        available: true  },
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
  const [feedbackOpen, setFeedbackOpen] = useState(false)

  // Collapsed (icon-only) rail — persisted; defaults to collapsed so the app
  // opens lean. Only applies to the desktop rail; the mobile drawer (onClose
  // present) is always the full labelled sidebar.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return true
    return localStorage.getItem(COLLAPSE_KEY) !== "0"
  })
  const isCollapsed = collapsed && !onClose
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
    admin:    { label: "Admin",    bg: "rgba(245, 158, 11, 0.15)", fg: "#f59e0b" },
    reviewer: { label: "Reviewer", bg: "#dbeafe",                  fg: "#1d4ed8" },
    preparer: { label: "Preparer", bg: "var(--surface-2)",         fg: "var(--text-muted)" },
  } as const)[me.role as "admin" | "reviewer" | "preparer"] : null

  return (
    <aside
      // h-screen + overflow-y-auto on the aside itself so short mobile
      // viewports can scroll to the account section. transition-[width] gives
      // a smooth expand/collapse. overflow-x-hidden stops labels from spilling
      // during the width animation.
      className={cn(
        // no-scrollbar: the rail can still scroll on short viewports, we just
        // hide the scrollbar chrome for a cleaner look.
        "no-scrollbar flex h-screen shrink-0 flex-col overflow-y-auto overflow-x-hidden transition-[width] duration-200",
        isCollapsed ? "w-[84px]" : "w-[376px]",
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
          <img src="/logo-mark-dark.svg"  alt="Nordavix"
            className="h-8 w-8 lg:h-9 lg:w-9 shrink-0 dark:hidden" />
          <img src="/logo-mark-light.svg" alt="Nordavix"
            className="h-8 w-8 lg:h-9 lg:w-9 shrink-0 hidden dark:block" />
          {!isCollapsed && (
            <span className="text-xl lg:text-[24px] font-semibold tracking-tight text-theme leading-none truncate">
              nordavix<span style={{ color: "var(--green)" }}>.</span>
            </span>
          )}
        </button>

        {/* Collapse / expand — desktop only (hidden inside the mobile drawer) */}
        {!onClose && (
          <button
            onClick={toggleCollapsed}
            className="hidden lg:flex items-center justify-center h-8 w-8 rounded-md transition-colors shrink-0"
            style={{ color: "var(--text-muted)" }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--surface-2)"; e.currentTarget.style.color = "var(--text)" }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-muted)" }}
            title={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {isCollapsed ? <PanelLeft size={16} strokeWidth={1.8} /> : <PanelLeftClose size={16} strokeWidth={1.8} />}
          </button>
        )}

        {/* Mobile close button (drawer only) */}
        {onClose && (
          <button
            onClick={onClose}
            className="lg:hidden ml-2 flex items-center justify-center h-7 w-7 rounded-md text-theme-muted hover:text-theme transition-colors"
          >
            <X size={16} strokeWidth={1.6} />
          </button>
        )}
      </div>

      {/* Org name — click to rename (hidden when collapsed) */}
      {organization && !isCollapsed && (
        <OrgNameInline organizationName={organization.name} onRename={(n) => organization.update({ name: n })} />
      )}

      {/* Quick search → opens the ⌘K command palette + notifications bell. */}
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
        {/* Bell opens the right-side notifications panel; badge polls unread. */}
        <NotificationBell onOpen={onClose} className="h-9 w-9" />
      </div>

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
              onMouseEnter={() => prefetchRoute(item.path)}
              onFocus={() => prefetchRoute(item.path)}
              title={isCollapsed ? item.label : undefined}
              className={({ isActive }) =>
                cn("flex items-center rounded-md text-sm transition-all duration-150",
                  isCollapsed ? "relative justify-center h-10" : "gap-2.5 px-3 py-2",
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
                      ? { count: tasksCount.open, bg: "#fee2e2", fg: "#b91c1c" }
                      : tasksCount.open > 0
                        ? { count: tasksCount.open, bg: "var(--green-subtle)", fg: "var(--green)" }
                        : null)
                  : null

                if (isCollapsed) {
                  return (
                    <>
                      <Icon size={23} strokeWidth={1.8}
                        style={{ color: isActive ? "var(--green)" : "var(--nav-text)" }} />
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
                      style={{ color: isActive ? "var(--green)" : "var(--nav-text)" }} />
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
                        style={{ background: "var(--green)" }} />
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
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--green-subtle)"; e.currentTarget.style.color = "var(--green)" }}
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
              border: "1px dashed var(--border-strong)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--green-subtle)"
              e.currentTarget.style.color = "var(--green)"
              e.currentTarget.style.borderColor = "var(--green)"
              e.currentTarget.style.borderStyle = "solid"
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent"
              e.currentTarget.style.color = "var(--nav-text)"
              e.currentTarget.style.borderColor = "var(--border-strong)"
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
            <span className="text-[11px] font-medium" style={{ color: "var(--text-muted)" }}>Theme</span>
            <ThemeToggle />
          </div>
        )}

        <div className={cn("flex items-center", isCollapsed ? "justify-center" : "gap-2 px-1")}>
          <UserButton
            afterSignOutUrl="/sign-in"
            appearance={{ elements: { avatarBox: "h-7 w-7" } }}
          />
          {!isCollapsed && (
            <div className="min-w-0 flex-1">
              <p className="text-xs truncate" style={{ color: "var(--nav-text)" }}>
                {user?.primaryEmailAddress?.emailAddress ?? "Account"}
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
      </div>
    </aside>
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
          "w-full inline-flex items-center rounded-md text-sm font-medium transition-colors",
          isCollapsed ? "justify-center h-10" : "gap-2.5 px-3 py-2",
          isActive ? "" : "hover:opacity-90",
        )
      }
      style={({ isActive }) => ({
        color: isActive ? "var(--green)" : "var(--nav-text)",
        background: isActive ? "var(--green-subtle)" : "transparent",
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
}

function OrgNameInline({ organizationName, onRename }: OrgNameInlineProps) {
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
          {/* Workspace switcher — dropdown listing every org the user
              belongs to, + "Create company" footer. */}
          <div className="mt-1">
            <WorkspaceSwitcher />
          </div>
        </>
      )}
      {error && (
        <p className="text-[10px] mt-1" style={{ color: "#dc2626" }}>{error}</p>
      )}
    </div>
  )
}
