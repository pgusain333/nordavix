import { SignedIn, SignedOut, RedirectToSignIn } from "@clerk/clerk-react"
import { Routes, Route, Navigate, useLocation } from "react-router-dom"
import { AnimatePresence, motion } from "framer-motion"
import { ThreePaneLayout } from "@/core/layout/ThreePaneLayout"
import { DashboardHome } from "@/modules/dashboard/pages/DashboardHome"
import { FluxDashboard } from "@/modules/flux/pages/FluxDashboard"
import { HomePage } from "@/marketing/HomePage"
import { WorkspaceGate } from "@/core/auth/WorkspaceGate"
import { ReconciliationsDashboard } from "@/modules/recons/pages/ReconciliationsDashboard"
import { ARReconciliations } from "@/modules/recons/pages/ARReconciliations"
import { APReconciliations } from "@/modules/recons/pages/APReconciliations"
import { ReconciliationDetail } from "@/modules/recons/pages/ReconciliationDetail"
import { OverridesDashboard } from "@/modules/recons/pages/OverridesDashboard"
import { CompaniesPanel } from "@/modules/onboarding/pages/CompaniesPanel"
import { ConnectionsPage } from "@/modules/connections/pages/ConnectionsPage"

/**
 * Route-level transition wrapper.
 *
 * Each top-level app page is keyed by the first two path segments so that
 * sibling pages (e.g. /app vs /app/flux vs /app/reconciliations) fade between
 * each other, but in-page state changes (?param updates, child route swaps
 * like /reconciliations/:reconId) don't trigger a full re-mount.
 */
function AppRoutes() {
  const location = useLocation()
  // Use the first two segments as the transition key — that's our "page".
  const segments = location.pathname.split("/").filter(Boolean)
  const transitionKey = segments.slice(0, 2).join("/") || "root"

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={transitionKey}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -6 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
        className="h-full"
      >
        <Routes location={location}>
          <Route index element={<DashboardHome />} />
          <Route path="connections"  element={<ConnectionsPage />} />
          <Route path="flux"         element={<FluxDashboard />} />
          <Route path="flux/:tbId"   element={<FluxDashboard />} />
          <Route path="reconciliations"            element={<ReconciliationsDashboard />} />
          <Route path="reconciliations/overrides"  element={<OverridesDashboard />} />
          <Route path="reconciliations/ar"         element={<ARReconciliations />} />
          <Route path="reconciliations/ap"         element={<APReconciliations />} />
          <Route path="reconciliations/:reconId"   element={<ReconciliationDetail />} />
        </Routes>
      </motion.div>
    </AnimatePresence>
  )
}

export default function App() {
  return (
    <Routes>
      {/* Public marketing pages */}
      <Route path="/" element={<HomePage />} />

      {/* Company picker — standalone, no sidebar/layout. Reachable directly
          (for switching) and rendered automatically by WorkspaceGate when
          the signed-in user has no active company. */}
      <Route
        path="/app/companies"
        element={
          <>
            <SignedOut><RedirectToSignIn /></SignedOut>
            <SignedIn><CompaniesPanel /></SignedIn>
          </>
        }
      />

      {/* Auth-required application — needs an active company */}
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
                  <AppRoutes />
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
