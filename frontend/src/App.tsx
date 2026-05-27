import { SignedIn, SignedOut, RedirectToSignIn } from "@clerk/clerk-react"
import { Routes, Route, Navigate, useLocation } from "react-router-dom"
import { AnimatePresence, motion } from "framer-motion"
import { ThreePaneLayout } from "@/core/layout/ThreePaneLayout"
import { DashboardHome } from "@/modules/dashboard/pages/DashboardHome"
import { FluxDashboard } from "@/modules/flux/pages/FluxDashboard"
import { HomePage } from "@/marketing/HomePage"
import { WorkspaceGate } from "@/core/auth/WorkspaceGate"
import { ReconciliationsDashboard } from "@/modules/recons/pages/ReconciliationsDashboard"
import { ReconciliationsMonthIndex } from "@/modules/recons/pages/ReconciliationsMonthIndex"
import { ARReconciliations } from "@/modules/recons/pages/ARReconciliations"
import { APReconciliations } from "@/modules/recons/pages/APReconciliations"
import { ReconciliationDetail } from "@/modules/recons/pages/ReconciliationDetail"
import { OverridesDashboard } from "@/modules/recons/pages/OverridesDashboard"
import { FluxMonthIndex } from "@/modules/flux/pages/FluxMonthIndex"
import { TasksPage } from "@/modules/tasks/pages/TasksPage"
import { IntercompanyPage } from "@/modules/intercompany/pages/IntercompanyPage"
import { FinancialsPage } from "@/modules/financials/pages/FinancialsPage"
import { InsightsPage } from "@/modules/insights/pages/InsightsPage"
import { BooksSetupWizard } from "@/modules/onboarding/pages/BooksSetupWizard"
import { TeamPage } from "@/modules/workspace/pages/TeamPage"
import { CompaniesPanel } from "@/modules/onboarding/pages/CompaniesPanel"
import { CreateCompanyPage } from "@/modules/onboarding/pages/CreateCompanyPage"
import { AuthPage } from "@/modules/auth/pages/AuthPage"
import { SolutionsPage } from "@/marketing/SolutionsPage"
import { TermsPage } from "@/marketing/TermsPage"
import { PrivacyPage } from "@/marketing/PrivacyPage"
import { SettingsPage } from "@/modules/settings/pages/SettingsPage"
import { ConnectionsPage } from "@/modules/connections/pages/ConnectionsPage"
import { TopProgressBar } from "@/core/ui/TopProgressBar"

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
          <Route path="setup/books"  element={<BooksSetupWizard />} />
          <Route path="settings"     element={<SettingsPage />} />
          <Route path="team"         element={<TeamPage />} />
          <Route path="connections"  element={<ConnectionsPage />} />
          <Route path="tasks"        element={<TasksPage />} />
          <Route path="intercompany" element={<IntercompanyPage />} />
          <Route path="financials"   element={<FinancialsPage />} />
          <Route path="insights"     element={<InsightsPage />} />
          {/* Flux: index = month-row list, /analyses = full workspace,
              /:tbId = deep link into a specific analysis. */}
          <Route path="flux"                  element={<FluxMonthIndex />} />
          <Route path="flux/analyses"         element={<FluxDashboard />} />
          <Route path="flux/:tbId"            element={<FluxDashboard />} />
          {/* Recons: index = month-row list, /period/:periodEnd = full
              dashboard for that month, /overrides = manual overrides admin.
              :reconId stays last so it doesn't gobble static children. */}
          <Route path="reconciliations"                         element={<ReconciliationsMonthIndex />} />
          <Route path="reconciliations/period/:periodEnd"       element={<ReconciliationsDashboard />} />
          <Route path="reconciliations/overrides"               element={<OverridesDashboard />} />
          <Route path="reconciliations/ar"                      element={<ARReconciliations />} />
          <Route path="reconciliations/ap"                      element={<APReconciliations />} />
          <Route path="reconciliations/:reconId"                element={<ReconciliationDetail />} />
        </Routes>
      </motion.div>
    </AnimatePresence>
  )
}

export default function App() {
  return (
    <>
    {/* Global top progress bar — lights up on any in-flight query/mutation. */}
    <TopProgressBar />
    <Routes>
      {/* Public marketing pages */}
      <Route path="/" element={<HomePage />} />
      <Route path="/solutions" element={<SolutionsPage />} />
      {/* Legal pages — public, no auth required. Required URLs for the
          Google OAuth consent screen (Branding section needs both
          Privacy Policy and Terms of Service URLs). */}
      <Route path="/terms"   element={<TermsPage />} />
      <Route path="/privacy" element={<PrivacyPage />} />

      {/* Custom-branded auth surface — replaces Clerk's hosted page.
          The trailing /* lets Clerk handle its own sub-routes
          (verification, MFA, OAuth callback, etc.). */}
      <Route path="/sign-in/*" element={<AuthPage mode="sign-in" />} />
      <Route path="/sign-up/*" element={<AuthPage mode="sign-up" />} />

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

      {/* Create-company page — standalone, focused flow. Mounted outside
          the app shell so the form gets the whole viewport. */}
      <Route
        path="/app/companies/new"
        element={
          <>
            <SignedOut><RedirectToSignIn /></SignedOut>
            <SignedIn><CreateCompanyPage /></SignedIn>
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
    </>
  )
}
