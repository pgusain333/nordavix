/**
 * Desktop top bar (lg+ only). Three zones:
 *   left   — company › page-title breadcrumb (active workspace + where you are)
 *   center — search (opens the ⌘K command palette)
 *   right  — notification bell · divider · signed-in user (name · role · menu)
 *
 * Mounted in ThreePaneLayout. The mobile layout keeps its own top bar
 * (search + bell) and the nav drawer keeps the account block, so these
 * controls never double-render on mobile.
 */
import { UserButton, useOrganization, useUser } from "@clerk/clerk-react"
import { useNavigate, useLocation } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { Search, Building2, ChevronRight } from "lucide-react"
import { workspaceApi } from "@/modules/workspace/api"
import { NotificationBell } from "@/modules/notifications/NotificationBell"
import { CMDK_EVENT } from "@/core/ui/CommandPalette"

// Route → page title. Longest/most-specific paths first; "/app" (Dashboard)
// stays LAST so it only matches the exact dashboard route, not its children.
const PAGE_TITLES: [string, string][] = [
  ["/app/reconciliations", "Reconciliations"],
  ["/app/flux",            "Flux Analysis"],
  ["/app/schedules",       "Schedules"],
  ["/app/intercompany",    "Intercompany"],
  ["/app/financials",      "Financial Package"],
  ["/app/insights",        "Insights"],
  ["/app/connections",     "Connections"],
  ["/app/tasks",           "Close Tasks"],
  ["/app/team",            "Team"],
  ["/app/settings",        "Settings"],
  ["/app/help",            "Help"],
  ["/app/companies",       "Companies"],
  ["/app",                 "Dashboard"],
]

export function TopBar() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { organization } = useOrganization()
  const { user } = useUser()

  const pageTitle =
    PAGE_TITLES.find(([p]) => pathname === p || pathname.startsWith(p + "/"))?.[1] ?? ""

  // Role → chip. Same source + mapping the nav used; long staleTime.
  const { data: me } = useQuery({
    queryKey: ["workspace-me"],
    queryFn:  workspaceApi.getMe,
    staleTime: 10 * 60_000,
    enabled:  !!organization,
  })
  const roleMeta = me ? ({
    admin:    { label: "Admin",    bg: "rgba(245, 158, 11, 0.15)", fg: "#f59e0b" },
    reviewer: { label: "Reviewer", bg: "#dbeafe",                  fg: "#1d4ed8" },
    preparer: { label: "Preparer", bg: "var(--surface-2)",         fg: "var(--text-muted)" },
  } as const)[me.role as "admin" | "reviewer" | "preparer"] : null

  const name = user?.fullName ?? user?.primaryEmailAddress?.emailAddress ?? "Account"

  return (
    <div
      className="hidden lg:flex shrink-0 h-14 items-center gap-3 px-6"
      style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}
    >
      {/* Left — company › page context */}
      <div className="flex-1 flex items-center gap-2 min-w-0">
        {organization && (
          <button
            onClick={() => navigate("/app")}
            className="inline-flex items-center gap-1.5 min-w-0 transition-opacity hover:opacity-80"
            title={`${organization.name} — go to dashboard`}
          >
            <Building2 size={15} strokeWidth={1.8} className="shrink-0" style={{ color: "var(--text-muted)" }} />
            <span className="text-sm font-semibold truncate max-w-[200px]" style={{ color: "var(--text)" }}>
              {organization.name}
            </span>
          </button>
        )}
        {pageTitle && (
          <>
            <ChevronRight size={14} strokeWidth={1.8} className="shrink-0" style={{ color: "var(--text-muted)" }} />
            <span className="text-sm truncate" style={{ color: "var(--text-2)" }}>{pageTitle}</span>
          </>
        )}
      </div>

      {/* Center — search (opens ⌘K) */}
      <button
        onClick={() => window.dispatchEvent(new Event(CMDK_EVENT))}
        className="shrink-0 inline-flex items-center gap-2 rounded-lg h-9 w-[320px] px-3 text-sm transition-colors hover:border-[var(--border-strong)]"
        style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}
        title="Search and jump anywhere (⌘K)"
      >
        <Search size={15} strokeWidth={1.8} className="shrink-0" style={{ color: "var(--text-muted)" }} />
        <span className="flex-1 text-left" style={{ color: "var(--text-muted)" }}>Search or jump to…</span>
        <kbd className="text-[10px] px-1 py-0.5 rounded"
          style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text-muted)" }}>⌘K</kbd>
      </button>

      {/* Right — bell · divider · user */}
      <div className="flex-1 flex items-center justify-end gap-2.5">
        <NotificationBell className="h-9 w-9" />

        <div className="h-6 w-px" style={{ background: "var(--border)" }} aria-hidden />

        <div className="flex items-center gap-2.5">
          <div className="text-right leading-tight">
            <p className="text-xs font-semibold truncate max-w-[180px]" style={{ color: "var(--text)" }}>
              {name}
            </p>
            {roleMeta && (
              <button
                onClick={() => navigate("/app/team")}
                className="mt-0.5 inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide transition-opacity hover:opacity-80"
                style={{ background: roleMeta.bg, color: roleMeta.fg }}
                title="Open the Team page"
              >
                {roleMeta.label}
              </button>
            )}
          </div>
          <UserButton
            afterSignOutUrl="/sign-in"
            appearance={{ elements: { avatarBox: "h-8 w-8" } }}
          />
        </div>
      </div>
    </div>
  )
}
