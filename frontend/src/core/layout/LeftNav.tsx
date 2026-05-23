/**
 * Left navigation sidebar — Nordavix app shell.
 *
 * Design: theme-aware (light/dark), green active accent.
 * Icons: Lucide, 22px, strokeWidth=1.6
 */
import { NavLink, useNavigate } from "react-router-dom"
import { UserButton, useOrganization, useUser } from "@clerk/clerk-react"
import {
  LayoutDashboard,
  BarChart3,
  Scale,
  FileText,
  ArrowLeftRight,
  type LucideIcon,
} from "lucide-react"
import { cn } from "@/core/ui/utils"
import { Badge } from "@/core/ui/components"
import { ThemeToggle } from "@/core/theme/ThemeToggle"

interface NavItem {
  label:     string
  path:      string
  icon:      LucideIcon
  available: boolean
}

const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard",       path: "/app",                icon: LayoutDashboard, available: true  },
  { label: "Flux Analysis",   path: "/app/flux",           icon: BarChart3,       available: true  },
  { label: "Reconciliations", path: "/app/reconciliations",icon: Scale,           available: false },
  { label: "Workpapers",      path: "/app/workpapers",     icon: FileText,        available: false },
  { label: "Intercompany",    path: "/app/intercompany",   icon: ArrowLeftRight,  available: false },
]

export function LeftNav() {
  const { organization } = useOrganization()
  const { user } = useUser()
  const navigate = useNavigate()

  return (
    <aside className="flex h-screen w-60 shrink-0 flex-col" style={{
      background: "var(--nav-bg)",
      borderRight: "1px solid var(--nav-border)",
    }}>

      {/* Brand */}
      <button
        onClick={() => navigate("/app")}
        className="flex items-center gap-2.5 px-4 py-[18px] w-full text-left transition-colors"
        style={{ borderBottom: "1px solid var(--nav-border)" }}
        onMouseEnter={e => (e.currentTarget.style.background = "var(--nav-active)")}
        onMouseLeave={e => (e.currentTarget.style.background = "")}
      >
        <img src="/logo-mark-light.svg" alt="Nordavix" className="h-7 w-7 shrink-0 dark:hidden" />
        <img src="/logo-mark-dark.svg"  alt="Nordavix" className="h-7 w-7 shrink-0 hidden dark:block" />
        <span className="text-[15px] font-semibold tracking-tight text-theme">
          nordavix<span style={{ color: "var(--green)" }}>.</span>
        </span>
      </button>

      {/* Org name */}
      {organization && (
        <div className="px-4 py-2" style={{ borderBottom: "1px solid var(--nav-border)" }}>
          <p className="text-xs truncate" style={{ color: "var(--nav-text)" }}>{organization.name}</p>
        </div>
      )}

      {/* Navigation */}
      <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon

          if (!item.available) {
            return (
              <div
                key={item.path}
                className="flex items-center justify-between rounded-md px-3 py-2 text-sm cursor-not-allowed opacity-40"
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

          const isIndex = item.path === "/app"

          return (
            <NavLink
              key={item.path}
              to={item.path}
              end={isIndex}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-all duration-150",
                  isActive ? "font-medium" : ""
                )
              }
              style={({ isActive }) => isActive
                ? { background: "var(--nav-active)", color: "var(--nav-text-act)" }
                : { color: "var(--nav-text)" }
              }
              onMouseEnter={e => {
                const el = e.currentTarget
                if (!el.classList.contains("active")) el.style.background = "var(--nav-active)"
              }}
              onMouseLeave={e => {
                const el = e.currentTarget
                if (!el.getAttribute("aria-current")) el.style.background = ""
              }}
            >
              {({ isActive }) => (
                <>
                  <Icon
                    size={22}
                    strokeWidth={1.6}
                    className="shrink-0 transition-colors"
                    style={{ color: isActive ? "var(--green)" : "var(--nav-text)" }}
                  />
                  {item.label}
                  {isActive && (
                    <span className="ml-auto h-1.5 w-1.5 rounded-full shrink-0"
                      style={{ background: "var(--green)" }} />
                  )}
                </>
              )}
            </NavLink>
          )
        })}
      </nav>

      {/* Bottom: theme toggle + user */}
      <div className="px-3 py-3 space-y-3" style={{ borderTop: "1px solid var(--nav-border)" }}>
        {/* Theme toggle */}
        <div className="flex items-center justify-between px-1">
          <span className="text-[11px] font-medium" style={{ color: "var(--text-muted)" }}>Theme</span>
          <ThemeToggle />
        </div>
        {/* User */}
        <div className="flex items-center gap-3 px-1">
          <UserButton appearance={{ elements: { avatarBox: "h-7 w-7" } }} />
          <span className="text-xs truncate" style={{ color: "var(--nav-text)" }}>
            {user?.primaryEmailAddress?.emailAddress ?? "Account"}
          </span>
        </div>
      </div>
    </aside>
  )
}
