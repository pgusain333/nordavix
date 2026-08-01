/**
 * AllocationRoutes — the route table for Nordavix Allocate.
 *
 * Mounted under /allocation/* by App.tsx, inside AllocationLayout. Kept
 * separate from the close app's AppRoutes so the two products can evolve
 * independently — adding a screen here can't affect the close app's routing.
 *
 * Ordered the way the work happens: set up, run a month, close the year. Every
 * route resolves to a real screen — no stubs, no dead ends.
 *
 * SPLIT PER SCREEN. The whole product used to arrive as one chunk, so opening
 * the Dashboard also downloaded the Excel export builder, the year-end
 * roll-up, the workpaper table and the transaction drawer — none of which a
 * preparer checking readiness is going to touch. Each screen is its own chunk
 * now, and `prefetchAllocationRoute` warms one on nav hover, so splitting buys
 * a smaller first load without making the second click feel slower.
 *
 * /setup is kept as a redirect rather than deleted. Its ?tab= links are in
 * bookmarks, in the readiness checklist and in older screenshots, and a dead
 * link is a support ticket.
 */
import { Suspense, lazy } from "react"
import { Link, Navigate, Route, Routes, useLocation, useSearchParams } from "react-router-dom"
import { AlertTriangle, RotateCcw } from "lucide-react"
import { Spinner } from "@/core/ui"
import { ErrorBoundary } from "@/core/ui/ErrorBoundary"

const AllocationDashboard = lazy(() => import("./pages/AllocationDashboard").then(m => ({ default: m.AllocationDashboard })))
const AllocationRuns      = lazy(() => import("./pages/AllocationRuns").then(m => ({ default: m.AllocationRuns })))
const AllocationPayroll   = lazy(() => import("./pages/AllocationPayroll").then(m => ({ default: m.AllocationPayroll })))
const AllocationYearEnd   = lazy(() => import("./pages/AllocationYearEnd").then(m => ({ default: m.AllocationYearEnd })))
const AllocationExports   = lazy(() => import("./pages/AllocationExports").then(m => ({ default: m.AllocationExports })))
const TeamPage            = lazy(() => import("@/modules/workspace/pages/TeamPage").then(m => ({ default: m.TeamPage })))

// The six setup screens share SetupShell and the readiness rail, so they ride
// in one chunk — splitting them further would trade a round trip for nothing.
const EligibilityPage = lazy(() => import("./pages/setupPages").then(m => ({ default: m.EligibilityPage })))
const PoolsPage       = lazy(() => import("./pages/setupPages").then(m => ({ default: m.PoolsPage })))
const AccountsPage    = lazy(() => import("./pages/setupPages").then(m => ({ default: m.AccountsPage })))
const SpacesPage      = lazy(() => import("./pages/setupPages").then(m => ({ default: m.SpacesPage })))
const EmployeesPage   = lazy(() => import("./pages/setupPages").then(m => ({ default: m.EmployeesPage })))
const SettingsPage    = lazy(() => import("./pages/setupPages").then(m => ({ default: m.SettingsPage })))

/**
 * Warm a screen's chunk before it's asked for.
 *
 * Called from the nav on hover/focus. By the time a click lands the module is
 * usually parsed, so a split route feels the same as an inlined one. Failures
 * are swallowed on purpose — this is an optimisation, and a prefetch that
 * throws on a flaky network must never surface as an error.
 */
export function prefetchAllocationRoute(path: string): void {
  const load = (): Promise<unknown> => {
    if (path === "/allocation")          return import("./pages/AllocationDashboard")
    if (path.endsWith("/runs"))          return import("./pages/AllocationRuns")
    if (path.endsWith("/payroll"))       return import("./pages/AllocationPayroll")
    if (path.endsWith("/year-end"))      return import("./pages/AllocationYearEnd")
    if (path.endsWith("/export"))        return import("./pages/AllocationExports")
    if (path.endsWith("/team"))          return import("@/modules/workspace/pages/TeamPage")
    return import("./pages/setupPages")
  }
  void load().catch(() => {})
}

const SETUP_TABS = ["eligibility", "pools", "accounts", "spaces", "employees", "settings"]

/** /allocation/setup?tab=spaces → /allocation/spaces */
function SetupRedirect() {
  const [params] = useSearchParams()
  const tab = params.get("tab")
  const to = tab && SETUP_TABS.includes(tab) ? `/allocation/${tab}` : "/allocation/eligibility"
  return <Navigate to={to} replace />
}

/** Shown only when a chunk hasn't arrived yet — usually never, thanks to the
 *  hover prefetch. Deliberately quiet: a big spinner for a 40ms wait reads as
 *  slower than nothing at all. */
function RouteFallback() {
  return (
    <div className="flex-1 flex items-start justify-center pt-24">
      <Spinner className="h-5 w-5" />
    </div>
  )
}

export function AllocationRoutes() {
  // Keyed on the path so every screen change replays the entrance. Without the
  // key React reuses the subtree and the animation only ever runs once, on the
  // first render — which is why a keyed wrapper beats a class on each page.
  const { pathname } = useLocation()
  return (
    <div key={pathname} className="ndvx-rise flex flex-1 flex-col overflow-hidden min-w-0">
      {/* Keyed on the path too, so a boundary tripped on one screen doesn't
          keep showing the fallback after you navigate away — otherwise the
          only way out of a broken screen is a full reload. The nav and top bar
          live outside this, so there's always a way somewhere else. */}
      <ErrorBoundary key={`eb-${pathname}`} label="Nordavix Allocate" fallback={<RouteError />}>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route index element={<AllocationDashboard />} />

          {/* Set up */}
          <Route path="eligibility" element={<EligibilityPage />} />
          <Route path="pools"       element={<PoolsPage />} />
          <Route path="accounts"    element={<AccountsPage />} />
          <Route path="spaces"      element={<SpacesPage />} />
          <Route path="employees"   element={<EmployeesPage />} />
          <Route path="settings"    element={<SettingsPage />} />
          {/* The SAME component the close app mounts. One Clerk organization
              means one team — a second roster that could disagree with the
              first would be a bug, not a feature. */}
          <Route path="team"        element={<TeamPage />} />

          {/* Every month */}
          <Route path="payroll" element={<AllocationPayroll />} />
          <Route path="runs"    element={<AllocationRuns />} />

          {/* Year end */}
          <Route path="year-end" element={<AllocationYearEnd />} />
          <Route path="export"   element={<AllocationExports />} />

          <Route path="setup" element={<SetupRedirect />} />
          <Route path="*" element={<Navigate to="/allocation" replace />} />
        </Routes>
      </Suspense>
      </ErrorBoundary>
    </div>
  )
}

/**
 * What a broken screen looks like.
 *
 * The default boundary fallback prints the exception, which is right for a
 * panel a developer is debugging and wrong for a preparer mid-close: it reads
 * as the product falling apart. This says what's still true — the work is
 * saved, the rest of the product works — and offers the two things that
 * actually help.
 */
function RouteError() {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-lg mx-auto px-5 py-16 text-center">
        <div className="h-10 w-10 rounded-full grid place-items-center mx-auto mb-3"
          style={{ background: "var(--warn-subtle)" }}>
          <AlertTriangle size={18} strokeWidth={1.8} style={{ color: "var(--warn)" }} />
        </div>
        <p className="text-sm font-semibold text-theme">This screen didn&rsquo;t load</p>
        <p className="text-xs mt-1.5 leading-relaxed" style={{ color: "var(--text-muted)" }}>
          Nothing has been lost — allocations, mappings and registries are saved on the
          server, not in this page. Every other screen still works; use the menu on the
          left, or reload to try this one again.
        </p>
        <div className="flex items-center justify-center gap-2 mt-4">
          <button onClick={() => window.location.reload()}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-medium"
            style={{ background: "var(--green)", color: "#fff" }}>
            <RotateCcw size={13} strokeWidth={2} /> Reload
          </button>
          <Link to="/allocation"
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-medium"
            style={{ color: "var(--text-2)", border: "1px solid var(--border)" }}>
            Go to the dashboard
          </Link>
        </div>
      </div>
    </div>
  )
}
