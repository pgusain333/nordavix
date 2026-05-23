/**
 * Dev-only shell: renders the app without Clerk auth.
 * Used when VITE_CLERK_PUBLISHABLE_KEY is not configured (local preview).
 * Never imported in production — tree-shaken by Vite's build.
 */
import { Routes, Route, Navigate } from "react-router-dom"
import { FluxDashboard } from "@/modules/flux/pages/FluxDashboard"
import { HomePage } from "@/marketing/HomePage"

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
              <Route index element={<Navigate to="flux" replace />} />
              <Route path="flux" element={<FluxDashboard />} />
              <Route path="flux/:tbId" element={<FluxDashboard />} />
            </Routes>
          </DevAppWrapper>
        }
      />

      {/* Legacy redirect */}
      <Route path="/flux/*" element={<Navigate to="/app/flux" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

function DevAppWrapper({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden bg-slate-50">
      <aside className="flex h-screen w-60 shrink-0 flex-col bg-nav-bg border-r border-nav-border">
        <div className="flex items-center gap-2 px-4 py-5 border-b border-nav-border">
          <div className="flex h-7 w-7 items-center justify-center rounded bg-blue-600 text-white text-xs font-bold">
            N
          </div>
          <span className="text-sm font-semibold text-nav-text-active tracking-tight">
            Nordavix
          </span>
        </div>
        <div className="px-4 py-2 border-b border-nav-border">
          <p className="text-xs text-nav-text">Demo Org</p>
        </div>
        <nav className="flex-1 px-2 py-3 space-y-0.5">
          {[
            { label: "Flux Analysis", active: true },
            { label: "Reconciliations", active: false },
            { label: "Workpapers", active: false },
            { label: "Intercompany", active: false },
          ].map((item) => (
            <div
              key={item.label}
              className={`flex items-center justify-between rounded px-3 py-2 text-sm ${
                item.active
                  ? "bg-nav-active text-nav-text-active font-medium"
                  : "text-nav-text/40 cursor-not-allowed"
              }`}
            >
              <span>{item.label}</span>
              {!item.active && (
                <span className="text-[10px] uppercase tracking-wider border border-nav-border rounded px-1 py-0.5">
                  soon
                </span>
              )}
            </div>
          ))}
        </nav>
        <div className="flex items-center gap-3 px-4 py-4 border-t border-nav-border">
          <div className="h-7 w-7 rounded-full bg-blue-500 flex items-center justify-center text-white text-xs font-bold">
            P
          </div>
          <span className="text-xs text-nav-text truncate">pankaj@rovapartners.com</span>
        </div>
      </aside>
      <main className="flex flex-1 flex-col overflow-hidden min-w-0">
        {children}
      </main>
    </div>
  )
}
