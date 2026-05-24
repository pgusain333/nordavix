import { SignedIn, SignedOut, RedirectToSignIn } from "@clerk/clerk-react"
import { Routes, Route, Navigate } from "react-router-dom"
import { ThreePaneLayout } from "@/core/layout/ThreePaneLayout"
import { DashboardHome } from "@/modules/dashboard/pages/DashboardHome"
import { FluxDashboard } from "@/modules/flux/pages/FluxDashboard"
import { HomePage } from "@/marketing/HomePage"
import { WorkspaceGate } from "@/core/auth/WorkspaceGate"
import { ReconciliationsDashboard } from "@/modules/recons/pages/ReconciliationsDashboard"
import { ARReconciliations } from "@/modules/recons/pages/ARReconciliations"
import { APReconciliations } from "@/modules/recons/pages/APReconciliations"
import { ReconciliationDetail } from "@/modules/recons/pages/ReconciliationDetail"

export default function App() {
  return (
    <Routes>
      {/* Public marketing pages */}
      <Route path="/" element={<HomePage />} />

      {/* Auth-required application */}
      <Route
        path="/app/*"
        element={
          <>
            <SignedOut>
              <RedirectToSignIn />
            </SignedOut>
            <SignedIn>
              <WorkspaceGate>
                <ThreePaneLayout>
                  <Routes>
                    <Route index element={<DashboardHome />} />
                    <Route path="flux"         element={<FluxDashboard />} />
                    <Route path="flux/:tbId"   element={<FluxDashboard />} />
                    <Route path="reconciliations"            element={<ReconciliationsDashboard />} />
                    <Route path="reconciliations/ar"         element={<ARReconciliations />} />
                    <Route path="reconciliations/ap"         element={<APReconciliations />} />
                    <Route path="reconciliations/:reconId"   element={<ReconciliationDetail />} />
                  </Routes>
                </ThreePaneLayout>
              </WorkspaceGate>
            </SignedIn>
          </>
        }
      />

      {/* Legacy redirects */}
      <Route path="/flux/*" element={<Navigate to="/app/flux" replace />} />
      <Route path="*"       element={<Navigate to="/" replace />} />
    </Routes>
  )
}
