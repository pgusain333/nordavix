/**
 * Dev-only shell: renders the app without Clerk auth.
 * Used when VITE_CLERK_PUBLISHABLE_KEY is not configured (local preview).
 * Never imported in production — tree-shaken by Vite's build.
 */
import { Routes, Route, Navigate, NavLink, useNavigate } from "react-router-dom"
import {
  LayoutDashboard,
  BarChart3,
  Scale,
  FileText,
  ArrowLeftRight,
} from "lucide-react"
import { FluxDashboard } from "@/modules/flux/pages/FluxDashboard"
import { DashboardHome } from "@/modules/dashboard/pages/DashboardHome"
import { HomePage } from "@/marketing/HomePage"
import { Badge } from "@/core/ui/components"
import { cn } from "@/core/ui/utils"

const NAV_ITEMS = [
  { label: "Dashboard",       path: "/app",                 Icon: LayoutDashboard, available: true  },
  { label: "Flux Analysis",   path: "/app/flux",            Icon: BarChart3,       available: true  },
  { label: "Reconciliations", path: "/app/reconciliations", Icon: Scale,           available: false },
  { label: "Workpapers",      path: "/app/workpapers",      Icon: FileText,        available: false },
  { label: "Intercompany",    path: "/app/intercompany",    Icon: ArrowLeftRight,  available: false },
]

export default function DevShell() {
  return (
    <Routes>
      {/* Public marketing homepage */}
      <Route path="/" element={<HomePage />} />

      {/* App shell (no auth gate in dev) */}
      <Route
        path="/app/*"
        element={
          <DevAppWrapper>
            <Routes>
              <Route index element={<DashboardHome />} />
              <Route path="flux"       element={<FluxDashboard />} />
              <Route path="flux/:tbId" element={<FluxDashboard />} />
            </Routes>
          </DevAppWrapper>
        }
      />

      {/* Legacy redirect */}
      <Route path="/flux/*" element={<Navigate to="/app/flux" replace />} />
      <Route path="*"       element={<Navigate to="/" replace />} />
    </Routes>
  )
}

function DevAppWrapper({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate()

  return (
    <div className="flex h-screen overflow-hidden bg-ink-50">
      {/* Left nav */}
      <aside className="flex h-screen w-60 shrink-0 flex-col bg-white border-r border-nav-border">

        {/* Brand */}
        <button
          onClick={() => navigate("/app")}
          className="flex items-center gap-2.5 px-4 py-[18px] border-b border-nav-border hover:bg-nav-active transition-colors text-left w-full"
        >
          <img src="/logo-mark-light.svg" alt="Nordavix" className="h-7 w-7 shrink-0" />
          <span className="text-[15px] font-semibold tracking-tight text-ink">
            nordavix<span className="text-green">.</span>
          </span>
        </button>

        {/* Org */}
        <div className="px-4 py-2 border-b border-nav-border">
          <p className="text-xs text-nav-text">Demo Workspace</p>
        </div>

        {/* Nav items */}
        <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
          {NAV_ITEMS.map(({ label, path, Icon, available }) => {
            if (!available) {
              return (
                <div
                  key={path}
                  className="flex items-center justify-between rounded-md px-3 py-2 text-sm text-nav-text/35 cursor-not-allowed"
                >
                  <span className="flex items-center gap-2.5">
                    <Icon size={22} strokeWidth={1.6} className="shrink-0" />
                    {label}
                  </span>
                  <Badge variant="soon">soon</Badge>
                </div>
              )
            }
            const isIndex = path === "/app"
            return (
              <NavLink
                key={path}
                to={path}
                end={isIndex}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
                    isActive
                      ? "bg-nav-active text-nav-text-active font-medium"
                      : "text-nav-text hover:bg-nav-active/60 hover:text-nav-text-hover"
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
                    {label}
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
          <div className="h-7 w-7 rounded-full bg-green flex items-center justify-center text-white text-xs font-semibold shrink-0">
            P
          </div>
          <span className="text-xs text-nav-text truncate">pankaj@rovapartners.com</span>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex flex-1 flex-col overflow-hidden min-w-0">
        {children}
      </main>
    </div>
  )
}
