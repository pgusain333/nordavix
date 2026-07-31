/**
 * AllocationRoutes — the route table for Nordavix Allocate.
 *
 * Mounted under /allocation/* by App.tsx, inside AllocationLayout. Kept
 * separate from the close app's AppRoutes so the two products can evolve
 * independently — adding a screen here can't affect the close app's routing.
 */
import { Navigate, Route, Routes } from "react-router-dom"
import { ListChecks, Settings } from "lucide-react"
import { AllocationDashboard } from "./pages/AllocationDashboard"
import { AllocationSetup } from "./pages/AllocationSetup"
import { AllocationStub } from "./pages/AllocationStub"

export function AllocationRoutes() {
  return (
    <Routes>
      <Route index element={<AllocationDashboard />} />

      <Route
        path="runs"
        element={
          <AllocationStub
            title="Runs"
            icon={ListChecks}
            summary="This month's allocation queue across every client"
            pending={[
              "S2 — the allocation engine (pools × drivers, largest-remainder rounding)",
              "S3 — the monthly run: QBO pull, workpaper, and the reclass journal entry",
            ]}
          />
        }
      />

      <Route path="setup" element={<AllocationSetup />} />

      <Route
        path="settings"
        element={
          <AllocationStub
            title="Settings"
            icon={Settings}
            summary="Method election, AFS status, and eligibility"
            pending={[
              "The §448(c) three-year gross-receipts test, pulled from QuickBooks",
              "Method election capture and attestation",
            ]}
          />
        }
      />

      <Route path="*" element={<Navigate to="/allocation" replace />} />
    </Routes>
  )
}
