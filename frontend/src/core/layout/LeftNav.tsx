/**
 * Left navigation sidebar — Nordavix app shell.
 * Theme-aware, mobile-ready (accepts onClose for overlay dismiss).
 */
import { NavLink, useNavigate } from "react-router-dom"
import { UserButton, useOrganization, useUser } from "@clerk/clerk-react"
import {
  LayoutDashboard, BarChart3, Scale, FileText, ArrowLeftRight,
  X, type LucideIcon,
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
  { label: "Dashboard",       path: "/app",                 icon: LayoutDashboard, available: true  },
  { label: "Flux Analysis",   path: "/app/flux",            icon: BarChart3,       available: true  },
  { label: "Reconciliations", path: "/app/reconciliations", icon: Scale,           available: false },
  { label: "Workpapers",      path: "/app/workpapers",      icon: FileText,        available: false },
  { label: "Intercompany",    path: "/app/intercompany",    icon: ArrowLeftRight,  available: false },
]

interface Props {
  onClose?: () => void
}

export function LeftNav({ onClose }: Props) {
  const { organization } = useOrganization()
  const { user } = useUser()
  const navigate = useNavigate()

  return (
    <aside
      className="flex h-screen w-60 shrink-0 flex-col"
      style={{ background: "var(--nav-bg)", borderRight: "1px solid var(--nav-border)" }}
    >
      {/* Brand */}
      <div className="flex items-center justify-between px-4 py-[18px]"
        style={{ borderBottom: "1px solid var(--nav-border)" }}>
        <button
          onClick={() => { navigate("/"); onClose?.() }}
          className="flex items-center gap-2.5 min-w-0 flex-1"
        >
          <img src="/logo-mark-dark.svg"  alt="Nordavix" className="h-7 w-7 shrink-0 dark:hidden" />
          <img src="/logo-mark-light.svg" alt="Nordavix" className="h-7 w-7 shrink-0 hidden dark:block" />
          <span className="text-[15px] font-semibold tracking-tight text-theme truncate">
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
              className={({ isActive }) =>
                cn("flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-all duration-150",
                  isActive ? "font-medium" : "")
              }
              style={({ isActive }) => isActive
                ? { background: "var(--nav-active)", color: "var(--nav-text-act)" }
                : { color: "var(--nav-text)" }
              }
            >
              {({ isActive }) => (
                <>
                  <Icon size={22} strokeWidth={1.6} className="shrink-0"
                    style={{ color: isActive ? "var(--green)" : "var(--nav-text)" }} />
                  <span className="truncate">{item.label}</span>
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

      {/* Bottom: theme + user */}
      <div className="px-3 py-3 space-y-3" style={{ borderTop: "1px solid var(--nav-border)" }}>
        <div className="flex items-center justify-between px-1">
          <span className="text-[11px] font-medium" style={{ color: "var(--text-muted)" }}>Theme</span>
          <ThemeToggle />
        </div>
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
