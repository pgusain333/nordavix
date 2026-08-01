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
 * /setup is kept as a redirect rather than deleted. Its ?tab= links are in
 * bookmarks, in the readiness checklist and in older screenshots, and a dead
 * link is a support ticket.
 */
import { Navigate, Route, Routes, useSearchParams } from "react-router-dom"
import { AllocationDashboard } from "./pages/AllocationDashboard"
import { AllocationPayroll } from "./pages/AllocationPayroll"
import { AllocationRuns } from "./pages/AllocationRuns"
import { AllocationYearEnd } from "./pages/AllocationYearEnd"
import {
  AccountsPage, EligibilityPage, EmployeesPage, PoolsPage, SettingsPage, SpacesPage,
} from "./pages/setupPages"

const SETUP_TABS = ["eligibility", "pools", "accounts", "spaces", "employees", "settings"]

/** /allocation/setup?tab=spaces → /allocation/spaces */
function SetupRedirect() {
  const [params] = useSearchParams()
  const tab = params.get("tab")
  const to = tab && SETUP_TABS.includes(tab) ? `/allocation/${tab}` : "/allocation/eligibility"
  return <Navigate to={to} replace />
}

export function AllocationRoutes() {
  return (
    <Routes>
      <Route index element={<AllocationDashboard />} />

      {/* Set up */}
      <Route path="eligibility" element={<EligibilityPage />} />
      <Route path="pools"       element={<PoolsPage />} />
      <Route path="accounts"    element={<AccountsPage />} />
      <Route path="spaces"      element={<SpacesPage />} />
      <Route path="employees"   element={<EmployeesPage />} />
      <Route path="settings"    element={<SettingsPage />} />

      {/* Every month */}
      <Route path="payroll" element={<AllocationPayroll />} />
      <Route path="runs"    element={<AllocationRuns />} />

      {/* Year end */}
      <Route path="year-end" element={<AllocationYearEnd />} />

      <Route path="setup" element={<SetupRedirect />} />
      <Route path="*" element={<Navigate to="/allocation" replace />} />
    </Routes>
  )
}
