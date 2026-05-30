/**
 * Left navigation sidebar — Nordavix app shell.
 * Theme-aware, mobile-ready (accepts onClose for overlay dismiss).
 */
import { useEffect, useRef, useState } from "react"
import { NavLink, useNavigate } from "react-router-dom"
import { UserButton, useOrganization, useUser } from "@clerk/clerk-react"
import {
  LayoutDashboard, BarChart3, Scale, FileText, ArrowLeftRight,
  Plug, Users, X, Pencil, Check, CheckSquare, BookOpen,
  MessageSquare, Settings, Lightbulb, LifeBuoy, ClipboardList,
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
  // returns just the numbers, not the full list. 30-second freshness +
  // refetch-on-focus is enough so the badge follows what the user does
  // without hammering the API.
  const { data: tasksCount } = useQuery({
    queryKey: ["tasks", "count"],
    queryFn:  tasksApi.getCount,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    enabled:  !!organization,
  })
  const roleMeta = me ? ({
    admin:    { label: "Admin",    bg: "rgba(245, 158, 11, 0.15)", fg: "#f59e0b" },
    reviewer: { label: "Reviewer", bg: "#dbeafe",                  fg: "#1d4ed8" },
    preparer: { label: "Preparer", bg: "var(--surface-2)",         fg: "var(--text-muted)" },
  } as const)[me.role as "admin" | "reviewer" | "preparer"] : null

  return (
    <aside
      // h-screen + overflow-y-auto on the aside itself (not just the inner
      // <nav>) so on short mobile viewports the user can scroll all the way
      // down to the account section + theme toggle. The previous layout
      // pinned the bottom of the aside to the screen edge, which on iOS
      // Safari + small Android phones often hid the account row behind
      // the browser chrome — leaving no way for users to reach Settings,
      // Send feedback, or switch theme. min-h-0 on flex children stops
      // the inner <nav>'s overflow-y-auto from fighting the outer scroll.
      className="flex h-screen w-60 shrink-0 flex-col overflow-y-auto"
      style={{ background: "var(--nav-bg)", borderRight: "1px solid var(--nav-border)" }}
    >
      {/* Brand */}
      <div className="flex items-center justify-between px-4 py-[18px]"
        style={{ borderBottom: "1px solid var(--nav-border)" }}>
        <button
          onClick={() => { navigate("/"); onClose?.() }}
          className="flex items-center gap-2.5 min-w-0 flex-1"
        >
          {/* Logo + wordmark — smaller on mobile (32px / 20px) so the
              header doesn't dominate the narrow slide-in drawer;
              full size on desktop (40px / 26px) where the 240px
              sidebar has room to breathe. */}
          <img src="/logo-mark-dark.svg"  alt="Nordavix"
            className="h-8 w-8 lg:h-10 lg:w-10 shrink-0 dark:hidden" />
          <img src="/logo-mark-light.svg" alt="Nordavix"
            className="h-8 w-8 lg:h-10 lg:w-10 shrink-0 hidden dark:block" />
          <span className="text-xl lg:text-[26px] font-semibold tracking-tight text-theme leading-none truncate">
            nordavix<span style={{ color: "var(--green)" }}>.</span>
          </span>
        </button>
        {/* Mobile close button */}
        {onClose && (
          <button
            onClick={onClose}
            className="lg:hidden ml-2 flex items-center justify-center h-7 w-7 rounded-md text-theme-muted hover:text-theme transition-colors"
          >
            <X size={16} strokeWidth={1.6} />
          </button>
        )}
      </div>

      {/* Org name — click to rename */}
      {organization && (
        <OrgNameInline organizationName={organization.name} onRename={(n) => organization.update({ name: n })} />
      )}

      {/* Navigation. flex-shrink-0 (not flex-1) so it doesn't try to
          fill the aside — outer aside scroll handles overflow. The nav
          takes its natural content height; bottom sections sit right
          below it on small viewports, which the outer scroll then
          reveals when needed. On desktop the aside is tall enough that
          everything fits without scrolling. */}
      <nav className="shrink-0 px-2 py-3 space-y-0.5">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon

          if (!item.available) {
            return (
              <div
                key={item.path}
                className="flex items-center justify-between rounded-md px-3 py-2 text-sm cursor-not-allowed opacity-35"
                style={{ color: "var(--nav-text)" }}
              >
                <span className="flex items-center gap-2.5">
                  <Icon size={22} strokeWidth={1.6} className="shrink-0" />
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
              // Prefetch the destination's lazy chunk + its primary
              // query when the user hovers the nav item. Means clicking
              // the link starts rendering immediately instead of waiting
              // for JS + JSON to land. Fire-and-forget; safe to spam.
              onMouseEnter={() => prefetchRoute(item.path)}
              onFocus={() => prefetchRoute(item.path)}
              className={({ isActive }) =>
                cn("flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-all duration-150",
                  isActive ? "font-medium" : "")
              }
              style={({ isActive }) => isActive
                ? { background: "var(--nav-active)", color: "var(--nav-text-act)" }
                : { color: "var(--nav-text)" }
              }
            >
              {({ isActive }) => {
                // Tasks nav item gets a count badge when there's open
                // work. Critical items get a red pill; routine open
                // count gets a neutral pill. Hides entirely at 0 so
                // the nav doesn't look noisy on a clean day.
                const isTasksItem = item.path === "/app/tasks"
                const taskBadge = isTasksItem && tasksCount
                  ? (tasksCount.critical > 0
                      ? { count: tasksCount.open, bg: "#fee2e2", fg: "#b91c1c" }
                      : tasksCount.open > 0
                        ? { count: tasksCount.open, bg: "var(--green-subtle)", fg: "var(--green)" }
                        : null)
                  : null
                return (
                  <>
                    <Icon size={22} strokeWidth={1.6} className="shrink-0"
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

      {/* Settings + Feedback — utility actions above the Theme/User
          section. Settings goes first since it's a more frequent
          destination; Feedback stays below as a secondary action. */}
      <div className="px-3 pt-2 pb-1 space-y-1.5" style={{ borderTop: "1px solid var(--nav-border)" }}>
        <NavLink
          to="/app/settings"
          onClick={onClose}
          className={({ isActive }) =>
            cn(
              "w-full inline-flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              isActive ? "" : "hover:opacity-90",
            )
          }
          style={({ isActive }) => ({
            color: isActive ? "var(--green)" : "var(--nav-text)",
            background: isActive ? "var(--green-subtle)" : "transparent",
          })}
          title="Edit company profile, address, tax info, accounting defaults"
        >
          <Settings size={16} strokeWidth={1.8} className="shrink-0" />
          <span className="flex-1 text-left">Settings</span>
        </NavLink>
        <NavLink
          to="/app/help"
          onClick={onClose}
          className={({ isActive }) =>
            cn(
              "w-full inline-flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              isActive ? "" : "hover:opacity-90",
            )
          }
          style={({ isActive }) => ({
            color: isActive ? "var(--green)" : "var(--nav-text)",
            background: isActive ? "var(--green-subtle)" : "transparent",
          })}
          title="Step-by-step guide — every workflow, every screen"
        >
          <LifeBuoy size={16} strokeWidth={1.8} className="shrink-0" />
          <span className="flex-1 text-left">Help</span>
        </NavLink>
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
      </div>
      <FeedbackDialog open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />

      {/* Bottom: theme + user */}
      <div className="px-3 py-3 space-y-3" style={{ borderTop: "1px solid var(--nav-border)" }}>
        <div className="flex items-center justify-between px-1">
          <span className="text-[11px] font-medium" style={{ color: "var(--text-muted)" }}>Theme</span>
          <ThemeToggle />
        </div>
        <div className="flex items-center gap-2 px-1">
          <UserButton
            afterSignOutUrl="/sign-in"
            appearance={{ elements: { avatarBox: "h-7 w-7" } }}
          />
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
        </div>
      </div>
    </aside>
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
              belongs to, + "Create company" footer. Replaces the
              previous plain-text "Switch company" link with a proper
              menu so users can flip workspaces without leaving the
              sidebar. */}
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
