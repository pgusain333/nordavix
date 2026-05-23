import { SignedIn, SignedOut, RedirectToSignIn } from "@clerk/clerk-react"
import { Routes, Route, Navigate } from "react-router-dom"
import { ThreePaneLayout } from "@/core/layout/ThreePaneLayout"
import { DashboardHome } from "@/modules/dashboard/pages/DashboardHome"
import { FluxDashboard } from "@/modules/flux/pages/FluxDashboard"
import { HomePage } from "@/marketing/HomePage"

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
              <ThreePaneLayout>
                <Routes>
                  <Route index element={<DashboardHome />} />
                  <Route path="flux"         element={<FluxDashboard />} />
                  <Route path="flux/:tbId"   element={<FluxDashboard />} />
                </Routes>
              </ThreePaneLayout>
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
