/**
 * Left navigation sidebar — Nordavix app shell.
 *
 * Design: white background, ink text, green active accent.
 * Icons: Lucide, 22px, strokeWidth=1.6
 * Logo: logo-mark-light.svg (ink box on white nav)
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
    <aside className="flex h-screen w-60 shrink-0 flex-col bg-nav-bg border-r border-nav-border">

      {/* Brand */}
      <button
        onClick={() => navigate("/app")}
        className="flex items-center gap-2.5 px-4 py-[18px] border-b border-nav-border hover:bg-nav-active transition-colors w-full text-left"
      >
        <img
          src="/logo-mark-light.svg"
          alt="Nordavix mark"
          className="h-7 w-7 shrink-0"
        />
        <span className="text-[15px] font-semibold tracking-tight text-ink">
          nordavix<span className="text-green">.</span>
        </span>
      </button>

      {/* Org name */}
      {organization && (
        <div className="px-4 py-2 border-b border-nav-border">
          <p className="text-xs text-nav-text truncate">{organization.name}</p>
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
                className="flex items-center justify-between rounded-md px-3 py-2 text-sm text-nav-text/35 cursor-not-allowed"
              >
                <span className="flex items-center gap-2.5">
                  <Icon size={22} strokeWidth={1.6} className="shrink-0" />
                  {item.label}
                </span>
                <Badge variant="soon">soon</Badge>
              </div>
            )
          }

          // Dashboard uses exact matching; sub-paths use prefix matching
          const isIndex = item.path === "/app"

          return (
            <NavLink
              key={item.path}
              to={item.path}
              end={isIndex}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
                  isActive
                    ? "bg-nav-active text-nav-text-active font-medium"
                    : "text-nav-text hover:bg-nav-active/60 hover:text-nav-text-hover",
                )
              }
            >
              {({ isActive }) => (
                <>
                  <Icon
                    size={22}
                    strokeWidth={1.6}
                    className={cn(
                      "shrink-0 transition-colors",
                      isActive ? "text-green" : "text-nav-text"
                    )}
                  />
                  {item.label}
                  {isActive && (
                    <span className="ml-auto h-1.5 w-1.5 rounded-full bg-green shrink-0" />
                  )}
                </>
              )}
            </NavLink>
          )
        })}
      </nav>

      {/* User */}
      <div className="flex items-center gap-3 px-4 py-4 border-t border-nav-border">
        <UserButton
          appearance={{
            elements: {
              avatarBox: "h-7 w-7",
            },
          }}
        />
        <span className="text-xs text-nav-text truncate">
          {user?.primaryEmailAddress?.emailAddress ?? "Account"}
        </span>
      </div>
    </aside>
  )
}
