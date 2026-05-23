import { NavLink } from "react-router-dom"
import { UserButton, useOrganization } from "@clerk/clerk-react"
import { cn } from "@/core/ui/utils"

interface NavItem {
  label: string
  path: string
  available: boolean
}

const NAV_ITEMS: NavItem[] = [
  { label: "Flux Analysis", path: "/flux", available: true },
  { label: "Reconciliations", path: "/reconciliations", available: false },
  { label: "Workpapers", path: "/workpapers", available: false },
  { label: "Intercompany", path: "/intercompany", available: false },
]

export function LeftNav() {
  const { organization } = useOrganization()

  return (
    <aside className="flex h-screen w-60 shrink-0 flex-col bg-nav-bg border-r border-nav-border">
      {/* Brand */}
      <div className="flex items-center gap-2 px-4 py-5 border-b border-nav-border">
        <div className="flex h-7 w-7 items-center justify-center rounded bg-blue-600 text-white text-xs font-bold">
          N
        </div>
        <span className="text-sm font-semibold text-nav-text-active tracking-tight">
          Nordavix
        </span>
      </div>

      {/* Org name */}
      {organization && (
        <div className="px-4 py-2 border-b border-nav-border">
          <p className="text-xs text-nav-text truncate">{organization.name}</p>
        </div>
      )}

      {/* Navigation */}
      <nav className="flex-1 px-2 py-3 space-y-0.5">
        {NAV_ITEMS.map((item) =>
          item.available ? (
            <NavLink
              key={item.path}
              to={item.path}
              className={({ isActive }) =>
                cn(
                  "flex items-center rounded px-3 py-2 text-sm transition-colors",
                  isActive
                    ? "bg-nav-active text-nav-text-active font-medium"
                    : "text-nav-text hover:bg-nav-active/50 hover:text-nav-text-hover",
                )
              }
            >
              {item.label}
            </NavLink>
          ) : (
            <div
              key={item.path}
              className="flex items-center justify-between rounded px-3 py-2 text-sm text-nav-text/40 cursor-not-allowed"
            >
              <span>{item.label}</span>
              <span className="text-[10px] uppercase tracking-wider border border-nav-border rounded px-1 py-0.5">
                soon
              </span>
            </div>
          ),
        )}
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
        <span className="text-xs text-nav-text truncate">Account</span>
      </div>
    </aside>
  )
}
