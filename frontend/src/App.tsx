import { lazy, Suspense, useEffect } from "react"
import { SignedIn, SignedOut, RedirectToSignIn } from "@clerk/clerk-react"
import { Routes, Route, Navigate, useLocation } from "react-router-dom"
import { AnimatePresence, motion } from "framer-motion"
import { HomePage } from "@/marketing/HomePage"
import { TopProgressBar } from "@/core/ui/TopProgressBar"
import { CookieBanner } from "@/core/consent/CookieBanner"
import { Spinner } from "@/core/ui/components"
import { MOTION, EASE } from "@/core/motion"

// ── Code-split heavy app modules ─────────────────────────────────────────
// Anything not on the critical first-paint path gets pulled into its
// own chunk so the initial JS payload stays small. Vite turns each
// `lazy(() => import(...))` into a separate file under /assets, fetched
// the first time the user lands on that route.
//
// Eager (kept in main bundle): HomePage only — the marketing landing page,
// the SEO-critical first paint for anonymous visitors. Everything the
// AUTHENTICATED app needs (app shell, dashboard, auth surface) is lazy below,
// so a marketing visitor never downloads it. Trade-off: a signed-in user
// hitting /app sees a ~150ms loader on first visit while the app-shell chunk
// loads — then it's cached (immutable) for every subsequent visit.
//
// Lazy: everything else, each its own chunk fetched on first navigation.
const ThreePaneLayout = lazy(() => import("@/core/layout/ThreePaneLayout").then(m => ({ default: m.ThreePaneLayout })))
const WorkspaceGate   = lazy(() => import("@/core/auth/WorkspaceGate").then(m => ({ default: m.WorkspaceGate })))
const AuthPage        = lazy(() => import("@/modules/auth/pages/AuthPage").then(m => ({ default: m.AuthPage })))
const DashboardHome   = lazy(() => import("@/modules/dashboard/pages/DashboardHome").then(m => ({ default: m.DashboardHome })))
const FluxDashboard           = lazy(() => import("@/modules/flux/pages/FluxDashboard").then(m => ({ default: m.FluxDashboard })))
const FluxMonthIndex          = lazy(() => import("@/modules/flux/pages/FluxMonthIndex").then(m => ({ default: m.FluxMonthIndex })))
const ReconciliationsDashboard = lazy(() => import("@/modules/recons/pages/ReconciliationsDashboard").then(m => ({ default: m.ReconciliationsDashboard })))
const ReconciliationsMonthIndex = lazy(() => import("@/modules/recons/pages/ReconciliationsMonthIndex").then(m => ({ default: m.ReconciliationsMonthIndex })))
const ARReconciliations       = lazy(() => import("@/modules/recons/pages/ARReconciliations").then(m => ({ default: m.ARReconciliations })))
const APReconciliations       = lazy(() => import("@/modules/recons/pages/APReconciliations").then(m => ({ default: m.APReconciliations })))
const ReconciliationDetail    = lazy(() => import("@/modules/recons/pages/ReconciliationDetail").then(m => ({ default: m.ReconciliationDetail })))
const OverridesDashboard      = lazy(() => import("@/modules/recons/pages/OverridesDashboard").then(m => ({ default: m.OverridesDashboard })))
const TasksPage               = lazy(() => import("@/modules/tasks/pages/TasksPage").then(m => ({ default: m.TasksPage })))
const IntercompanyPage        = lazy(() => import("@/modules/intercompany/pages/IntercompanyPage").then(m => ({ default: m.IntercompanyPage })))
const FinancialsPage          = lazy(() => import("@/modules/financials/pages/FinancialsPage").then(m => ({ default: m.FinancialsPage })))
const InsightsPage            = lazy(() => import("@/modules/insights/pages/InsightsPage").then(m => ({ default: m.InsightsPage })))
const AdjustmentsPage         = lazy(() => import("@/modules/adjustments/pages/AdjustmentsPage").then(m => ({ default: m.AdjustmentsPage })))
const SchedulesOverview       = lazy(() => import("@/modules/schedules/pages/SchedulesOverview").then(m => ({ default: m.SchedulesOverview })))
const PrepaidsPage            = lazy(() => import("@/modules/schedules/pages/PrepaidsPage").then(m => ({ default: m.PrepaidsPage })))
const AccrualsPage            = lazy(() => import("@/modules/schedules/pages/AccrualsPage").then(m => ({ default: m.AccrualsPage })))
const FixedAssetsPage         = lazy(() => import("@/modules/schedules/pages/FixedAssetsPage").then(m => ({ default: m.FixedAssetsPage })))
const LeasesPage              = lazy(() => import("@/modules/schedules/pages/LeasesPage").then(m => ({ default: m.LeasesPage })))
const LoansPage               = lazy(() => import("@/modules/schedules/pages/LoansPage").then(m => ({ default: m.LoansPage })))
const BooksSetupWizard        = lazy(() => import("@/modules/onboarding/pages/BooksSetupWizard").then(m => ({ default: m.BooksSetupWizard })))
const TeamPage                = lazy(() => import("@/modules/workspace/pages/TeamPage").then(m => ({ default: m.TeamPage })))
const CompaniesPanel          = lazy(() => import("@/modules/onboarding/pages/CompaniesPanel").then(m => ({ default: m.CompaniesPanel })))
const CreateCompanyPage       = lazy(() => import("@/modules/onboarding/pages/CreateCompanyPage").then(m => ({ default: m.CreateCompanyPage })))
const SettingsPage            = lazy(() => import("@/modules/settings/pages/SettingsPage").then(m => ({ default: m.SettingsPage })))
const ConnectionsPage         = lazy(() => import("@/modules/connections/pages/ConnectionsPage").then(m => ({ default: m.ConnectionsPage })))
const HelpPage                = lazy(() => import("@/modules/help/pages/HelpPage").then(m => ({ default: m.HelpPage })))
const SolutionsPage           = lazy(() => import("@/marketing/SolutionsPage").then(m => ({ default: m.SolutionsPage })))
const TermsPage               = lazy(() => import("@/marketing/TermsPage").then(m => ({ default: m.TermsPage })))
const PrivacyPage             = lazy(() => import("@/marketing/PrivacyPage").then(m => ({ default: m.PrivacyPage })))
const SecurityPage            = lazy(() => import("@/marketing/SecurityPage").then(m => ({ default: m.SecurityPage })))
const PublicHelpPage          = lazy(() => import("@/marketing/PublicHelpPage").then(m => ({ default: m.PublicHelpPage })))
const BlogIndex               = lazy(() => import("@/marketing/blog/BlogIndex").then(m => ({ default: m.BlogIndex })))
const BlogPostPage            = lazy(() => import("@/marketing/blog/BlogPostPage").then(m => ({ default: m.BlogPostPage })))

/** Lightweight loading state shown while a lazy route is being fetched.
 *  Intentionally minimal: a single centered spinner with the same
 *  surface color as the app shell so the transition feels like a
 *  natural loading state, not a flash of empty page. */
function RouteLoader() {
  return (
    <div className="h-full flex items-center justify-center" style={{ background: "var(--bg)" }}>
      <Spinner className="h-6 w-6" />
    </div>
  )
}

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

  // Scroll restoration: a new page starts at the top. Without this, React
  // Router preserves the previous page's scroll offset, so Recons → Schedules
  // landed mid-page. Keyed on the full pathname (drilling month → period also
  // resets) but NOT the hash — the recon drawer drives tab/account state via
  // #acct=…, and opening it must not yank the list back to the top.
  // "instant" bypasses the global CSS scroll-behavior:smooth so route changes
  // don't animate a long scroll.
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" })
  }, [location.pathname])

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={transitionKey}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -6 }}
        transition={{ duration: MOTION.DEFAULT, ease: EASE.OUT }}
        className="h-full"
      >
        <Suspense fallback={<RouteLoader />}>
          <Routes location={location}>
            <Route index element={<DashboardHome />} />
            <Route path="setup/books"  element={<BooksSetupWizard />} />
            <Route path="settings"     element={<SettingsPage />} />
            <Route path="team"         element={<TeamPage />} />
            <Route path="connections"  element={<ConnectionsPage />} />
            <Route path="help"         element={<HelpPage />} />
            <Route path="tasks"        element={<TasksPage />} />
            <Route path="intercompany" element={<IntercompanyPage />} />
            <Route path="financials"   element={<FinancialsPage />} />
            <Route path="insights"     element={<InsightsPage />} />
            <Route path="adjustments"  element={<AdjustmentsPage />} />
            {/* Schedules — overview + 5 type-specific detail pages. Each
                schedule's ending balance auto-populates the subledger on
                its GL account's reconciliation via the committed snapshot. */}
            <Route path="schedules"                element={<SchedulesOverview />} />
            <Route path="schedules/prepaids"       element={<PrepaidsPage />} />
            <Route path="schedules/accruals"       element={<AccrualsPage />} />
            <Route path="schedules/fixed-assets"   element={<FixedAssetsPage />} />
            <Route path="schedules/leases"         element={<LeasesPage />} />
            <Route path="schedules/loans"          element={<LoansPage />} />
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
        </Suspense>
      </motion.div>
    </AnimatePresence>
  )
}

export default function App() {
  return (
    <>
    {/* Global top progress bar — lights up on any in-flight query/mutation. */}
    <TopProgressBar />
    {/* Cookie consent — single mount, persisted via localStorage. Only
        renders the banner on first visit; afterwards it's invisible
        until the user clicks "Cookie preferences" in a footer (or the
        policy version is bumped). */}
    <CookieBanner />
    <Suspense fallback={<RouteLoader />}>
      <Routes>
        {/* Public marketing pages */}
        <Route path="/" element={<HomePage />} />
        <Route path="/solutions" element={<SolutionsPage />} />
        {/* Legal pages — public, no auth required. Required URLs for the
            Google OAuth consent screen (Branding section needs both
            Privacy Policy and Terms of Service URLs). */}
        <Route path="/terms"   element={<TermsPage />} />
        <Route path="/privacy" element={<PrivacyPage />} />
        {/* Security & Trust — public + indexable (a sales asset, unlike the
            noindex legal pages). Reuses LegalLayout for the long-form chrome. */}
        <Route path="/security" element={<SecurityPage />} />
        {/* Public Help — same content as /app/help, hosted at the
            marketing root so it's shareable + indexable. */}
        <Route path="/help"    element={<PublicHelpPage />} />

        {/* Blog — public, indexed, SEO-targeted. /blog lists posts;
            /blog/:slug renders an individual post. Registry-driven so
            adding a post is one file in /marketing/blog/posts/. */}
        <Route path="/blog"        element={<BlogIndex />} />
        <Route path="/blog/:slug"  element={<BlogPostPage />} />

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
    </Suspense>
    </>
  )
}
