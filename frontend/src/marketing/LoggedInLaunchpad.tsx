/**
 * LoggedInLaunchpad — the hero card a signed-in visitor sees on the marketing
 * homepage instead of the generic "Start free" CTA.
 *
 * Greets them, names the active workspace, and shows ONE adaptive primary
 * action — finish setup / resume the close / all caught up — plus a couple of
 * live stat chips (open tasks, unread notifications) and quick links into the
 * app. Designed to sit on the burgundy hero (glass card, white text).
 *
 * Robust by design: every piece of live data is optional. If the API isn't
 * reachable yet (or the queries are still loading), the card still renders a
 * clean "Open dashboard" CTA — the stats are enhancement, never a requirement.
 */
import { useUser, useOrganization } from "@clerk/clerk-react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { motion } from "framer-motion"
import {
  ArrowRight, BarChart3, Bell, BookOpen, CheckCircle2, ListChecks, Scale, Sparkles,
  type LucideIcon,
} from "lucide-react"
import { ClerkApiWirer } from "@/core/auth/ClerkProvider"
import { onboardingApi } from "@/modules/onboarding/api"
import { tasksApi } from "@/modules/tasks/api"
import { notificationsApi } from "@/modules/notifications/api"

const QUICK_LINKS: { label: string; to: string; icon: LucideIcon }[] = [
  { label: "Tasks",           to: "/app/tasks",           icon: ListChecks },
  { label: "Reconciliations", to: "/app/reconciliations", icon: Scale      },
  { label: "Flux",            to: "/app/flux",            icon: BarChart3  },
  { label: "Financials",      to: "/app/financials",      icon: BookOpen   },
]

export function LoggedInLaunchpad() {
  const { isSignedIn, user } = useUser()
  const { organization } = useOrganization()
  // Live stats need an active workspace (tenant scope) + a wired token.
  const enabled = !!isSignedIn && !!organization

  const { data: onboarding } = useQuery({
    queryKey: ["onboarding", "status"],
    queryFn:  onboardingApi.getStatus,
    enabled,
    staleTime: 60_000,
  })
  const { data: tasks } = useQuery({
    queryKey: ["tasks", "count"],
    queryFn:  tasksApi.getCount,
    enabled,
    staleTime: 30_000,
  })
  const { data: unread = 0 } = useQuery({
    queryKey: ["notifications", "count"],
    queryFn:  notificationsApi.count,
    enabled,
    staleTime: 30_000,
  })

  if (!isSignedIn) return null

  const firstName = user?.firstName || user?.fullName?.split(" ")[0] || "there"
  const orgName   = organization?.name
  const open      = tasks?.open ?? 0
  const critical  = tasks?.critical ?? 0

  // Adaptive primary action.
  let title = "Open dashboard"
  let sub: string | null = null
  let showCheck = false
  if (onboarding && !onboarding.complete) {
    title = "Finish setting up"
    sub   = `${onboarding.done} of ${onboarding.total} steps done`
  } else if (open > 0) {
    title = "Resume your close"
    sub   = `${open} open task${open === 1 ? "" : "s"}` +
            (critical > 0 ? ` · ${critical} need${critical === 1 ? "s" : ""} attention` : "")
  } else if (onboarding?.complete) {
    title = "You're all caught up"
    sub   = "Books are current — open the dashboard"
    showCheck = true
  }

  return (
    <>
      {/* Wire Clerk's token into the API client — the app shell's wirer isn't
          mounted on the marketing page, so without this the stat queries 401. */}
      <ClerkApiWirer />

      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.2 }}
        className="mt-8 w-full max-w-md mx-auto lg:mx-0 rounded-2xl p-5 text-left"
        style={{
          background: "rgba(255,255,255,0.10)",
          border: "1px solid rgba(255,255,255,0.22)",
          backdropFilter: "blur(10px)",
          WebkitBackdropFilter: "blur(10px)",
          boxShadow: "0 12px 40px -12px rgba(0,0,0,0.45)",
        }}
      >
        {/* Greeting */}
        <div className="flex items-center gap-2">
          <Sparkles size={14} strokeWidth={2} style={{ color: "var(--green)" }} />
          <span className="text-sm font-semibold text-white">Welcome back, {firstName}</span>
        </div>
        {orgName && (
          <p className="text-xs mt-0.5 mb-4 truncate" style={{ color: "rgba(255,255,255,0.65)" }}>{orgName}</p>
        )}
        {!orgName && <div className="mb-4" />}

        {/* Adaptive primary CTA */}
        <Link
          to="/app"
          className="flex items-center justify-between gap-3 rounded-xl px-4 py-3 transition-transform hover:scale-[1.01] active:scale-[0.99]"
          style={{ background: "var(--green)", boxShadow: "0 10px 28px -8px rgba(16,185,129,0.5)" }}
        >
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 text-sm font-semibold text-white">
              {showCheck && <CheckCircle2 size={15} strokeWidth={2.2} />}
              {title}
            </span>
            {sub && (
              <span className="block text-[11px] mt-0.5 truncate" style={{ color: "rgba(255,255,255,0.85)" }}>{sub}</span>
            )}
          </span>
          <ArrowRight size={16} strokeWidth={2.2} className="text-white shrink-0" />
        </Link>

        {/* Live stat chips */}
        {(open > 0 || unread > 0) && (
          <div className="flex flex-wrap gap-2 mt-3">
            {open > 0   && <Chip to="/app/tasks" icon={ListChecks} label={`${open} open task${open === 1 ? "" : "s"}`} />}
            {unread > 0 && <Chip to="/app"       icon={Bell}       label={`${unread} new`} />}
          </div>
        )}

        {/* Quick nav */}
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-4 pt-3"
          style={{ borderTop: "1px solid rgba(255,255,255,0.15)" }}>
          {QUICK_LINKS.map((q) => {
            const Icon = q.icon
            return (
              <Link key={q.to} to={q.to}
                className="inline-flex items-center gap-1.5 text-xs transition-colors"
                style={{ color: "rgba(255,255,255,0.78)" }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "#fff" }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.78)" }}
              >
                <Icon size={12} strokeWidth={1.8} /> {q.label}
              </Link>
            )
          })}
        </div>
      </motion.div>
    </>
  )
}

function Chip({ to, icon: Icon, label }: { to: string; icon: LucideIcon; label: string }) {
  return (
    <Link to={to}
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium text-white transition-transform hover:scale-[1.03]"
      style={{ background: "rgba(255,255,255,0.12)", border: "1px solid rgba(255,255,255,0.2)" }}
    >
      <Icon size={11} strokeWidth={2} /> {label}
    </Link>
  )
}
