/**
 * AllocationRoutes — the route table for Nordavix Allocate.
 *
 * Mounted under /allocation/* by App.tsx, inside AllocationLayout. Kept
 * separate from the close app's AppRoutes so the two products can evolve
 * independently — adding a screen here can't affect the close app's routing.
 *
 * Every route resolves to a real screen: no stubs, no dead ends. /settings is
 * a redirect into the Setup tab that owns it rather than a second place to look.
 */
import { Navigate, Route, Routes } from "react-router-dom"
import { AllocationDashboard } from "./pages/AllocationDashboard"
import { AllocationPayroll } from "./pages/AllocationPayroll"
import { AllocationRuns } from "./pages/AllocationRuns"
import { AllocationSetup } from "./pages/AllocationSetup"

export function AllocationRoutes() {
  return (
    <Routes>
      <Route index element={<AllocationDashboard />} />
      <Route path="runs"    element={<AllocationRuns />} />
      <Route path="payroll" element={<AllocationPayroll />} />
      <Route path="setup" element={<AllocationSetup />} />
      <Route path="settings" element={<Navigate to="/allocation/setup?tab=settings" replace />} />
      <Route path="*" element={<Navigate to="/allocation" replace />} />
    </Routes>
  )
}
