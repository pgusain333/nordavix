/**
 * Workspace dashboard — unified view across Flux Analysis + Reconciliations.
 *
 * Layout:
 *   - Greeting header
 *   - Setup checklist (only renders steps that are incomplete)
 *   - KPI strip: open recons / total variance / pending flux / members
 *   - Two-column body:
 *       LEFT  → Reconciliations status (counts per bucket, top open accounts)
 *       RIGHT → Flux Analysis (recent analyses) + recent activity feed
 *   - Recent activity feed displays *real names* via the workspace lookup.
 *
 * All data is read-only and behind cached queries (5-minute staleTime) so
 * the dashboard doesn't hammer QBO every time the user navigates here.
 */
import { useEffect, useMemo, useState } from "react"
import { useUser, useOrganization } from "@clerk/clerk-react"
import { useSelectedPeriod } from "@/core/hooks/useSelectedPeriod"
import { readMeta } from "@/modules/onboarding/components/CompanyForm"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { motion, AnimatePresence } from "framer-motion"
import { formatDate, formatDateLong } from "@/core/lib/dates"

/** Resolve the current workspace's month-end close target in days
 * (default 15). Reads from CompanyMeta in localStorage so the value
 * propagates the moment the user saves it in the setup form. */
function useCloseTargetDays(): number {
  const { organization } = useOrganization()
  if (!organization?.id) return 15
  const raw = readMeta(organization.id).month_end_close_target_days
  const v = parseInt(raw ?? "15", 10)
  return Number.isFinite(v) && v > 0 ? v : 15
}
import {
  CheckCircle2,
  ArrowRight,
  Plug,
  ListChecks,
  Scale,
  BarChart3,
  Users,
  Clock,
  ShieldCheck,
  Lock,
  Circle,
  CalendarCheck,
  Lightbulb,
  Sparkles,
} from "lucide-react"
import { api as fluxApi } from "@/modules/flux/api"
import { useQboConnection } from "@/modules/flux/hooks"
import { reconsApi } from "@/modules/recons/api"
import { useBooksStatus } from "@/modules/recons/hooks"
import { workspaceApi } from "@/modules/workspace/api"
import { Button, Spinner } from "@/core/ui/components"
import { humanize } from "@/core/ui/utils"

// ── Helpers ────────────────────────────────────────────────────────────────

function getGreeting(name: string): string {
  const hour = new Date().getHours()
  const first = (name || "").split(" ")[0] || "there"
  if (hour < 12) return `Good morning, ${first}.`
  if (hour < 17) return `Good afternoon, ${first}.`
  return `Good evening, ${first}.`
}

function fmtMoney(s: string | number): string {
  const n = typeof s === "string" ? parseFloat(s) : s
  if (!Number.isFinite(n)) return "$0"
  const abs = `$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
  if (n === 0) return abs
  return n < 0 ? `(${abs})` : abs
}

function defaultPeriodEnd(): string {
  const d = new Date()
  d.setDate(0)
  return d.toISOString().slice(0, 10)
}

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return ""
  const d = new Date(iso).getTime()
  const s = Math.floor((Date.now() - d) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

// ── Main component ─────────────────────────────────────────────────────────

export function DashboardHome() {
  const { user } = useUser()
  const navigate = useNavigate()
  const qc       = useQueryClient()
  // Selected month drives every KPI + action card on this page. Changing it
  // refetches the recons overview and re-derives the flux summary, so the
  // dashboard is always showing one month at a time. Click "Open" on either
  // action card to drill into the full module-level view for the same month.
  //
  // ALSO persists to localStorage via useSelectedPeriod so every other app
  // (Schedules, Recons, Insights, Financials) opens to the same month on
  // their next mount. Apps can still override locally after landing.
  const [period, setPeriod] = useSelectedPeriod(defaultPeriodEnd())

  // Sequential-close gate state — when the user clicks a future tile
  // that's blocked by an earlier unapproved month, we surface an inline
  // message instead of refocusing. Cleared automatically after a few
  // seconds OR when the user clicks a valid tile.
  const [blockMsg, setBlockMsg] = useState<string | null>(null)
  // Inline confirmation banner for the Close-books action, kept simple
  // (success ✓ / error ✕). 4-second auto-dismiss like blockMsg.
  const [closeMsg, setCloseMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null)
  useEffect(() => {
    if (!closeMsg) return
    const t = setTimeout(() => setCloseMsg(null), 4_000)
    return () => clearTimeout(t)
  }, [closeMsg])

  // Current user's role — gates the Close-books button on the
  // close-progress card to admins only.
  const { data: me } = useQuery({
    queryKey: ["workspace-me"],
    queryFn:  workspaceApi.getMe,
    staleTime: 5 * 60_000,
  })
  const isAdmin = me?.role === "admin"

  // QBO connection — uses the localStorage-cached hook so refreshes
  // don't flash the "not connected" banner while the verify-fetch
  // round-trips.
  const { data: qbo, isLoading: qboLoading } = useQboConnection()

  // Books status — localStorage-cached hook so we don't flash the
  // "Welcome — finish the setup below" hero + the "Set up books to
  // enable the tracker" CTA for 200–2500ms on every refresh.
  // Once seeded, the cache survives reloads and the page renders
  // in the seeded state instantly while a background fetch verifies.
  const { data: books } = useBooksStatus()

  // Recons overview — drives recon KPIs and the status panel
  const { data: overview } = useQuery({
    queryKey: ["recons-overview", period],
    queryFn:  () => reconsApi.getOverview(period),
    enabled:  !!qbo && books?.seeded === true,
    staleTime: 5 * 60_000,
  })

  // Month-end close tracker — one entry per month from books_start
  // through current. Drives the close-status timeline component below.
  const { data: tracker } = useQuery({
    queryKey: ["period-tracker"],
    queryFn:  reconsApi.listPeriodTracker,
    enabled:  books?.seeded === true,
    staleTime: 60_000,
  })

  // Workspace members count
  const { data: members } = useQuery({
    queryKey: ["workspace-members"],
    queryFn:  workspaceApi.listMembers,
    staleTime: 10 * 60_000,
  })

  // Flux trial balances — list of recent analyses
  const { data: trialBalances } = useQuery({
    queryKey: ["flux-trial-balances"],
    queryFn:  fluxApi.listTrialBalances,
    staleTime: 60_000,
  })

  // TBs whose current period falls in the selected month — the "flux for
  // this month" count and link target. Match by year+month of period_current.
  const monthlyFlux = useMemo(() => {
    if (!trialBalances || !period) return []
    const [y, m] = period.split("-")
    return trialBalances.filter((tb) => {
      const pc = (tb.period_current || "").split("-")
      return pc[0] === y && pc[1] === m
    })
  }, [trialBalances, period])

  // Flux readiness for the close gate. Mirrors the server-side rule:
  // at least one flux analysis must exist for the month AND all must
  // be approved. Drives the Close-books CTA on the progress card.
  const fluxStatus = useMemo(() => {
    const unapproved = monthlyFlux.filter((tb) => !tb.approved_by)
    return {
      total:           monthlyFlux.length,
      unapprovedCount: unapproved.length,
      allApproved:     monthlyFlux.length > 0 && unapproved.length === 0,
    }
  }, [monthlyFlux])

  // Friendly label for the selected month (e.g. "April 2026")
  const monthLabel = useMemo(() => {
    if (!period) return ""
    try {
      const d = new Date(period + "T00:00:00")
      return d.toLocaleDateString(undefined, { month: "long", year: "numeric" })
    } catch { return period }
  }, [period])

  // Year filter — drives which months render in the tracker. Months
  // are visible as tiles below, so the dropdown only needs to scope
  // the year (vs. picking individual months which was redundant).
  // Defaults to current year, or the most recent year with data when
  // the tracker arrives.
  const [year, setYear] = useState<string>(() => String(new Date().getFullYear()))
  const yearOptions = useMemo(() => {
    const s = new Set<string>()
    for (const p of tracker?.periods ?? []) s.add(p.period_end.slice(0, 4))
    const arr = Array.from(s).sort().reverse()
    const cur = String(new Date().getFullYear())
    if (!arr.includes(cur)) arr.unshift(cur)
    return arr
  }, [tracker])
  // If the picked year isn't actually in the list when tracker loads,
  // snap to the most recent available year.
  useEffect(() => {
    if (yearOptions.length === 0) return
    if (!yearOptions.includes(year)) setYear(yearOptions[0])
  }, [yearOptions, year])
  // When the year changes, re-anchor the focused period to the most
  // recent month within that year (so KPIs / Open cards align).
  useEffect(() => {
    const periods = tracker?.periods ?? []
    const inYear = periods.filter((p) => p.period_end.startsWith(year))
    if (inYear.length === 0) return
    if (!period.startsWith(year)) {
      // Most recent month in the new year (tracker is sorted ascending)
      setPeriod(inYear[inYear.length - 1].period_end)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, tracker])
  // Filter tracker tiles to the selected year.
  const trackerPeriodsInYear = useMemo(() => {
    if (!tracker?.periods) return []
    return tracker.periods.filter((p) => p.period_end.startsWith(year))
  }, [tracker, year])

  // Sequential-close gate: a month M is blocked iff any earlier month
  // M' < M is "in_progress" or "not_started" (i.e. not closed and not
  // fully approved). Mirrors the backend gate in /admin/close-period.
  // Map blocked period_end → label of the first earlier month that
  // needs attention, so the inline error can be specific.
  const blockedBy = useMemo(() => {
    const map = new Map<string, { label: string; period_end: string; unapproved: number }>()
    const periods = tracker?.periods ?? []
    for (let i = 0; i < periods.length; i++) {
      const p = periods[i]
      // Walk earlier periods (the tracker list is sorted chronologically
      // ascending, so anything before i is earlier in time). Stop at the
      // first blocker — naming one specific cause is more actionable
      // than listing all of them.
      for (let j = 0; j < i; j++) {
        const prior = periods[j]
        if (prior.status === "closed" || prior.status === "complete") continue
        const unapproved = (prior.counts.pending ?? 0) + (prior.counts.reviewed ?? 0) + (prior.counts.flagged ?? 0)
        map.set(p.period_end, { label: prior.label, period_end: prior.period_end, unapproved })
        break
      }
    }
    return map
  }, [tracker])

  // Auto-clear the block message after 4 seconds.
  useEffect(() => {
    if (!blockMsg) return
    const t = setTimeout(() => setBlockMsg(null), 4_000)
    return () => clearTimeout(t)
  }, [blockMsg])

  // Close-books mutation. Lives here (not on the reconciliations
  // dashboard) so the Close action sits next to the month-end tracker
  // tiles where the user decides a month is finished. Reopen still
  // lives on the recons page so an admin can unlock a closed period
  // without leaving it.
  const closeMut = useMutation({
    mutationFn: () => reconsApi.closePeriod(period),
    onSuccess: () => {
      setCloseMsg({ kind: "ok", text: `Books closed for ${monthLabel}.` })
      qc.invalidateQueries({ queryKey: ["period-tracker"] })
      qc.invalidateQueries({ queryKey: ["books-status"] })
      qc.invalidateQueries({ queryKey: ["recons-overview", period] })
      qc.invalidateQueries({ queryKey: ["closed-periods"] })
      qc.invalidateQueries({ queryKey: ["tasks"] })
      qc.invalidateQueries({ queryKey: ["dashboard-audit"] })
    },
    onError: (err: unknown) => {
      const ex = err as { response?: { data?: { detail?: string } }; message?: string }
      setCloseMsg({ kind: "err", text: ex.response?.data?.detail ?? ex.message ?? "Could not close period" })
    },
  })

  function handleCloseBooks() {
    if (!confirm(`Close the books for ${monthLabel}? Once locked, reviewers and preparers can't edit anything for this period.`)) return
    closeMut.mutate()
  }

  // Recons buckets — open / reviewed / approved counts derived from the overview.
  // Used by the KPI strip ("Open in <month>" + "Variance"). NOT used by the
  // close-progress card — that reads from `trackerEntry` so it can render
  // instantly off the cached tracker payload instead of waiting on the
  // heavy QBO-backed overview query.
  const buckets = useMemo(() => {
    const c = { open: 0, reviewed: 0, approved: 0, total: overview?.accounts.length ?? 0 }
    overview?.accounts.forEach((a) => {
      if (a.review_status === "approved") c.approved++
      else if (a.review_status === "reviewed") c.reviewed++
      else c.open++
    })
    return c
  }, [overview])

  // Tracker entry for the focused month — derived synchronously from the
  // cached tracker payload. Memoized so the CloseProgressCard gets a
  // stable reference and only re-renders when the actual entry changes.
  const trackerEntry = useMemo(
    () => tracker?.periods.find((p) => p.period_end === period),
    [tracker, period],
  )

  const totalVariance = useMemo(() => {
    if (!overview) return 0
    return overview.accounts.reduce(
      (n, a) => n + Math.abs(parseFloat(a.variance) || 0),
      0,
    )
  }, [overview])

  // Top open accounts — pending/flagged, sorted by variance magnitude
  const topOpen = useMemo(() => {
    if (!overview) return []
    return overview.accounts
      .filter((a) => a.review_status === "pending" || a.review_status === "flagged")
      .sort((x, y) => Math.abs(parseFloat(y.variance)) - Math.abs(parseFloat(x.variance)))
      .slice(0, 5)
  }, [overview])

  // Recent audit activity (last ~10 events) — fetched directly. Names get
  // resolved by a second query so the feed shows "Jatin" not "4c1d-..."
  const { data: audit } = useQuery({
    queryKey: ["dashboard-audit"],
    queryFn:  async () => {
      const { apiClient } = await import("@/core/api/client")
      const { data } = await apiClient.get<{
        entries: { id: string; user_id: string | null; action: string; created_at: string; summary: string }[]
      }>("/api/audit", { params: { limit: 10 } })
      return data.entries
    },
    staleTime: 60_000,
  })

  const uniqueUserIds = useMemo(
    () => Array.from(new Set((audit ?? []).map((e) => e.user_id).filter(Boolean) as string[])),
    [audit],
  )
  const { data: userNames } = useQuery({
    queryKey: ["audit-user-names", uniqueUserIds.join(",")],
    queryFn:  () => workspaceApi.lookupUsers(uniqueUserIds),
    enabled:  uniqueUserIds.length > 0,
    staleTime: 5 * 60_000,
  })

  // Setup checklist — only shows steps that aren't done yet
  const setupSteps = useMemo(() => {
    const steps: { label: string; done: boolean; href: string }[] = []
    if (!qboLoading) {
      steps.push({ label: "Connect QuickBooks", done: !!qbo, href: "/app/connections" })
    }
    if (books) {
      steps.push({ label: "Set books start date + opening balances", done: books.seeded, href: "/app/setup/books" })
    }
    return steps
  }, [qbo, qboLoading, books])

  const setupIncomplete = setupSteps.filter((s) => !s.done)

  return (
    <div className="flex flex-col h-full overflow-y-auto" style={{ background: "var(--bg)" }}>
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}
        className="px-4 sm:px-8 pt-6 pb-4"
        style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <h1 style={{
              fontSize: "clamp(22px, 5vw, 28px)", fontWeight: 700, lineHeight: 1.2,
              letterSpacing: "-0.01em", color: "var(--text)", margin: 0,
            }}>
              {getGreeting(user?.fullName || user?.firstName || "")}
            </h1>
            <p className="text-xs sm:text-sm mt-1.5" style={{ color: "var(--text-muted)" }}>
              {books?.seeded
                ? `Viewing ${monthLabel}. Click any month tile below to refocus KPIs, or pick a different year above.`
                : "Welcome to Nordavix — finish the setup below to start reconciling."}
            </p>
          </div>
          {/* Year picker — scopes the tracker tiles below to one year.
              Individual months are clickable as tiles, so the dropdown
              just narrows by year (used to be a Month picker; was
              redundant with the tiles). */}
          {books?.seeded && yearOptions.length > 0 && (
            <label className="flex flex-col">
              <span className="text-[10px] font-semibold uppercase tracking-wide mb-1" style={{ color: "var(--text-muted)" }}>
                Year
              </span>
              <select
                value={year}
                onChange={(e) => setYear(e.target.value)}
                className="rounded-lg px-3 py-1.5 text-sm outline-none"
                style={{
                  background: "var(--surface-2)",
                  border: "1px solid var(--border-strong)",
                  color: "var(--text)",
                }}
              >
                {yearOptions.map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </label>
          )}
        </div>
      </motion.div>

      <div className="flex-1 px-4 sm:px-8 py-5 max-w-7xl w-full mx-auto space-y-5">
        {/* ── Setup checklist (only if anything's missing) ───────── */}
        {setupIncomplete.length > 0 && (
          <div className="rounded-xl p-4"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
            <div className="flex items-center gap-2 mb-3">
              <ShieldCheck size={16} strokeWidth={1.8} style={{ color: "var(--green)" }} />
              <h2 className="text-sm font-semibold text-theme">Finish setting up your workspace</h2>
            </div>
            <ol className="space-y-2">
              {setupSteps.map((s, i) => (
                <li key={i}
                  className="flex items-center gap-3 px-3 py-2 rounded-lg"
                  style={{ background: s.done ? "var(--green-subtle)" : "var(--surface-2)" }}>
                  {s.done
                    ? <CheckCircle2 size={16} strokeWidth={2} style={{ color: "var(--green)" }} />
                    : <span className="h-4 w-4 rounded-full" style={{ border: "2px solid var(--text-muted)" }} />}
                  <span className="flex-1 text-sm"
                    style={{ color: s.done ? "var(--green)" : "var(--text)", textDecoration: s.done ? "line-through" : "none" }}>
                    {s.label}
                  </span>
                  {!s.done && (
                    <Button size="sm" variant="outline" icon={<ArrowRight size={12} strokeWidth={1.8} />}
                      onClick={() => navigate(s.href)}>
                      Open
                    </Button>
                  )}
                </li>
              ))}
            </ol>
          </div>
        )}

        {/* ── Month-end close tracker — always shown ─────────────────
            When books haven't been set up, the section explains why no
            timeline can be drawn and links to the wizard. When set up,
            shows one color-coded tile per month from books_start through
            the current month. */}
        <div className="rounded-xl overflow-hidden"
          style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
          <div className="px-4 py-3 flex items-center justify-between flex-wrap gap-2"
            style={{ borderBottom: "1px solid var(--border)" }}>
            <div className="flex items-center gap-2">
              <CalendarCheck size={16} strokeWidth={1.8} style={{ color: "var(--green)" }} />
              <h2 className="text-sm font-semibold text-theme">Month-end close tracker</h2>
            </div>
            {books?.seeded && (
              <div className="flex items-center gap-3 text-[10px] flex-wrap" style={{ color: "var(--text-muted)" }}>
                <span className="inline-flex items-center gap-1"><Lock size={9} strokeWidth={2} style={{ color: "#b45309" }} /> Closed</span>
                <span className="inline-flex items-center gap-1"><CheckCircle2 size={9} strokeWidth={2} style={{ color: "var(--green)" }} /> Complete</span>
                <span className="inline-flex items-center gap-1"><Circle size={9} strokeWidth={2} style={{ color: "#1d4ed8" }} /> In progress</span>
                <span className="inline-flex items-center gap-1"><Circle size={9} strokeWidth={2} style={{ color: "var(--text-muted)" }} /> Open</span>
              </div>
            )}
          </div>

          {!books?.seeded ? (
            <div className="px-6 py-10 text-center">
              <div className="h-12 w-12 mx-auto rounded-full flex items-center justify-center mb-3"
                style={{ background: "rgba(245, 158, 11, 0.15)", border: "2px dashed #f59e0b" }}>
                <CalendarCheck size={20} strokeWidth={1.6} style={{ color: "#b45309" }} />
              </div>
              <p className="text-sm font-semibold text-theme mb-1">Set up books to enable the tracker</p>
              <p className="text-xs mb-4 max-w-md mx-auto" style={{ color: "var(--text-muted)" }}>
                The month-end tracker draws one tile per month from your books start date. Pick a start date and seed your opening balances — then every month rolls forward automatically.
              </p>
              <Button size="sm" icon={<ArrowRight size={12} strokeWidth={1.8} />}
                onClick={() => navigate("/app/setup/books")}>
                Set books start date
              </Button>
            </div>
          ) : (tracker?.periods.length ?? 0) === 0 ? (
            <div className="px-6 py-10 text-center">
              <p className="text-sm" style={{ color: "var(--text-muted)" }}>
                Books start date is set but no monthly periods yet. They'll appear here once you reconcile your first month.
              </p>
            </div>
          ) : trackerPeriodsInYear.length === 0 ? (
            <div className="px-6 py-8 text-center">
              <p className="text-sm" style={{ color: "var(--text-muted)" }}>
                No months in {year} yet. Pick a different year above.
              </p>
            </div>
          ) : (
            <>
            <div className="overflow-x-auto">
              <div className="flex gap-2 px-4 py-3" style={{ minWidth: "min-content" }}>
                {trackerPeriodsInYear.map((p) => {
                  const meta = {
                    closed:      { bg: "rgba(245, 158, 11, 0.10)", border: "#f59e0b",         fg: "#b45309",         icon: <Lock size={12} strokeWidth={2} /> },
                    complete:    { bg: "var(--green-subtle)",      border: "var(--green)",    fg: "var(--green)",    icon: <CheckCircle2 size={12} strokeWidth={2} /> },
                    in_progress: { bg: "#dbeafe",                  border: "#3b82f6",         fg: "#1d4ed8",         icon: <Circle size={12} strokeWidth={2} /> },
                    not_started: { bg: "var(--surface-2)",         border: "var(--border)",   fg: "var(--text-muted)", icon: <Circle size={12} strokeWidth={2} /> },
                  }[p.status]
                  const isSelected = p.period_end === period
                  // Sequential-close gate. If an earlier month isn't
                  // fully approved (or closed), this tile is locked:
                  // dimmed visually, click surfaces an inline error
                  // instead of refocusing, and any Start CTA is
                  // suppressed (the user has to finish prior months
                  // first).
                  const blocker = blockedBy.get(p.period_end)
                  return (
                    <button
                      key={p.period_end}
                      onClick={() => {
                        if (blocker) {
                          setBlockMsg(
                            `${p.label} is locked. ${blocker.label} has ${blocker.unapproved} open account${blocker.unapproved === 1 ? "" : "s"} ` +
                            `— approve all of them first.`
                          )
                          return
                        }
                        setBlockMsg(null)
                        setPeriod(p.period_end)
                      }}
                      className="rounded-lg p-3 text-left transition-all hover:shadow-md hover:-translate-y-px relative"
                      style={{
                        background: meta.bg,
                        border: `${isSelected ? "2px" : "1px"} solid ${isSelected ? "var(--green)" : meta.border}`,
                        minWidth: 150,
                        boxShadow: isSelected ? "0 0 0 3px rgba(16, 185, 129, 0.15)" : undefined,
                        opacity: blocker ? 0.5 : 1,
                        cursor: blocker ? "not-allowed" : "pointer",
                      }}
                      title={blocker
                        ? `Locked — ${blocker.label} must be fully approved first`
                        : `Refocus the dashboard to ${p.label}`}
                    >
                      {/* Small lock badge in the corner when blocked,
                          so the visual reason is obvious at a glance. */}
                      {blocker && (
                        <span className="absolute top-1.5 right-1.5"
                          style={{ color: "var(--text-muted)" }}>
                          <Lock size={10} strokeWidth={2.4} />
                        </span>
                      )}
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-xs font-bold" style={{ color: meta.fg }}>{p.label}</span>
                        {!blocker && <span style={{ color: meta.fg }}>{meta.icon}</span>}
                      </div>
                      {p.total > 0 ? (
                        <>
                          <div className="text-[10px] mb-1" style={{ color: meta.fg }}>
                            {p.counts.approved} / {p.total} approved
                          </div>
                          {/* Progress bar */}
                          <div className="h-1.5 w-full rounded-full overflow-hidden"
                            style={{ background: "rgba(0,0,0,0.08)" }}>
                            <div className="h-full rounded-full transition-all"
                              style={{
                                width: `${p.approved_pct}%`,
                                background: meta.fg,
                              }} />
                          </div>
                          <div className="flex items-center gap-1 mt-1.5 text-[9px]" style={{ color: meta.fg, opacity: 0.85 }}>
                            {p.counts.flagged > 0 && <span>🚩 {p.counts.flagged}</span>}
                            {p.counts.pending > 0 && <span>⌛ {p.counts.pending}</span>}
                            {p.counts.reviewed > 0 && <span>👁 {p.counts.reviewed}</span>}
                          </div>
                        </>
                      ) : (
                        <>
                          <span className="text-[10px] italic block mb-1.5" style={{ color: meta.fg, opacity: 0.7 }}>
                            Not started
                          </span>
                          {/* "Start month-end close" CTA — only when
                              this month isn't locked by a prior unapproved
                              month. Otherwise the lock badge in the
                              corner already tells the story. */}
                          {!blocker && (
                            <span
                              onClick={(e) => {
                                e.stopPropagation()
                                navigate(`/app/reconciliations/period/${p.period_end}?autosync=1`)
                              }}
                              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide cursor-pointer transition-colors hover:opacity-80"
                              style={{
                                background: "var(--green)",
                                color: "white",
                              }}
                              title={`Start month-end close for ${p.label} — auto-syncs QuickBooks for ${p.period_end}`}
                            >
                              Start <ArrowRight size={9} strokeWidth={2.4} />
                            </span>
                          )}
                        </>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
            {/* Inline block message — shown when the user clicked a
                locked future tile. Auto-dismisses after 4s. */}
            <AnimatePresence>
              {blockMsg && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.18 }}
                  className="px-4 py-2.5 flex items-start gap-2 text-xs"
                  style={{
                    background: "rgba(245, 158, 11, 0.10)",
                    borderTop: "1px solid #f59e0b",
                    color: "#92400e",
                    overflow: "hidden",
                  }}>
                  <Lock size={12} strokeWidth={2} className="shrink-0 mt-0.5" style={{ color: "#b45309" }} />
                  <span className="flex-1">{blockMsg}</span>
                </motion.div>
              )}
            </AnimatePresence>
            <div className="px-4 py-2 text-[10px]" style={{ borderTop: "1px solid var(--border)", background: "var(--surface-2)", color: "var(--text-muted)" }}>
              Books started {tracker!.books_start_date} · {tracker!.periods.length} period{tracker!.periods.length === 1 ? "" : "s"} ·
              {" "}{tracker!.periods.filter((p) => p.status === "closed").length} closed · click a month to refocus the dashboard
            </div>
            </>
          )}
        </div>

        {/* ── KPI strip — reflects the selected month ───────────── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Kpi label={`Open in ${monthLabel}`} value={String(buckets.open)} tone="#dc2626"
            sub={buckets.total > 0 ? `${buckets.total} accounts total` : "—"} />
          <Kpi label="Variance this month" value={fmtMoney(totalVariance)} tone={totalVariance > 0 ? "#dc2626" : "var(--green)"}
            sub={buckets.total > 0 ? "absolute, all accounts" : "—"} />
          <Kpi label="Flux analyses" value={String(monthlyFlux.length)} tone="var(--text)"
            sub={monthlyFlux.length > 0 ? `for ${monthLabel}` : `no flux for ${monthLabel}`} />
          <Kpi label="Team members" value={String(members?.length ?? 0)} tone="var(--text)" sub="see settings" />
        </div>

        {/* ── Month-end Close Progress card ────────────────────────
            Updates whenever the user clicks a tile in the tracker.
            Surfaces where we are in the close cycle for the focused
            month: % approved, status breakdown, days vs target close
            (period_end + 15 days, same as the Tasks default due).
            Hosts the Close Books button for admins when the month is
            fully approved and not blocked by an earlier open month. */}
        <CloseProgressCard
          monthLabel={monthLabel}
          period={period}
          trackerEntry={trackerEntry}
          onOpen={() => navigate(`/app/reconciliations/period/${period}`)}
          isAdmin={isAdmin}
          blocker={blockedBy.get(period) ?? null}
          onCloseBooks={handleCloseBooks}
          closing={closeMut.isPending}
          closeMsg={closeMsg}
          fluxStatus={fluxStatus}
          onOpenFlux={() => navigate(`/app/flux/analyses?period=${period}`)}
        />

        {/* ── Two big "Open" action cards ────────────────────────
            One per workspace module. Each card summarizes the current
            month at a glance and links into the module's full dashboard
            (which also defaults to the same month). */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

          {/* Open Reconciliations */}
          {(() => {
            const selectedBlocker = blockedBy.get(period)
            return (
              <button
                onClick={() => {
                  if (selectedBlocker) {
                    setBlockMsg(
                      `Cannot open ${monthLabel} reconciliations. ${selectedBlocker.label} has ` +
                      `${selectedBlocker.unapproved} open account${selectedBlocker.unapproved === 1 ? "" : "s"} — ` +
                      `approve all of them first.`
                    )
                    return
                  }
                  navigate(`/app/reconciliations/period/${period}`)
                }}
                className="rounded-xl overflow-hidden text-left transition-all hover:shadow-lg hover:-translate-y-0.5"
                style={{
                  background: "var(--surface)",
                  border: `1px solid ${selectedBlocker ? "#f59e0b" : "var(--border)"}`,
                  boxShadow: "var(--card-shadow)",
                  cursor: selectedBlocker ? "not-allowed" : "pointer",
                  opacity: selectedBlocker ? 0.75 : 1,
                }}
              >
            <div className="px-4 py-3 flex items-center justify-between"
              style={{ borderBottom: "1px solid var(--border)" }}>
              <div className="flex items-center gap-2">
                <Scale size={18} strokeWidth={1.8} style={{ color: "var(--green)" }} />
                <h2 className="text-base font-semibold text-theme">Open Reconciliations</h2>
              </div>
              <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold"
                style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
                {monthLabel}
              </span>
            </div>
            {/* Buckets summary */}
            <div className="grid grid-cols-3 divide-x" style={{ borderBottom: "1px solid var(--border)" }}>
              <BucketTile label="Open" count={buckets.open} fg="#b91c1c" bg="#fef2f2" />
              <BucketTile label="Prepared" count={buckets.reviewed} fg="#1d4ed8" bg="#dbeafe" />
              <BucketTile label="Approved" count={buckets.approved} fg="var(--green)" bg="var(--green-subtle)" />
            </div>
            {/* Top 3 open accounts */}
            <div className="px-4 py-3">
              <p className="text-[10px] font-semibold uppercase tracking-wide mb-2" style={{ color: "var(--text-muted)" }}>
                Top open accounts
              </p>
              {!overview ? (
                <p className="text-xs py-3" style={{ color: "var(--text-muted)" }}>
                  {!qbo ? "Connect QuickBooks to load." : !books?.seeded ? "Finish books setup." : "Sync to load."}
                </p>
              ) : topOpen.length === 0 ? (
                <p className="text-xs py-3 text-center inline-flex items-center justify-center gap-1.5 w-full"
                  style={{ color: "var(--green)" }}>
                  <CheckCircle2 size={14} strokeWidth={2} /> Everything reconciled.
                </p>
              ) : (
                <ul>
                  {topOpen.slice(0, 3).map((a) => {
                    const v = parseFloat(a.variance) || 0
                    return (
                      <li key={a.qbo_id} className="flex items-center gap-2 py-1 text-xs">
                        <span className="font-mono" style={{ color: "var(--text-muted)" }}>{a.account_number || "—"}</span>
                        <span className="flex-1 truncate text-theme">{a.account_name}</span>
                        <span className="tabular-nums font-semibold"
                          style={{ color: Math.abs(v) >= 1 ? "#dc2626" : "var(--green)" }}>
                          {fmtMoney(a.variance)}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
            <div className="px-4 py-2.5 flex items-center justify-between"
              style={{ borderTop: "1px solid var(--border)", background: "var(--surface-2)" }}>
              <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                {buckets.total} accounts · {fmtMoney(totalVariance)} variance
              </span>
              {selectedBlocker ? (
                <span className="inline-flex items-center gap-1 text-xs font-semibold" style={{ color: "#b45309" }}>
                  <Lock size={11} strokeWidth={2} />
                  Locked by {selectedBlocker.label}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-xs font-semibold" style={{ color: "var(--green)" }}>
                  Open dashboard <ArrowRight size={12} strokeWidth={2} />
                </span>
              )}
            </div>
              </button>
            )
          })()}

          {/* Open Flux Analysis — mirrors the recons tile behavior.
              When the month already has analyses, jump straight to
              the most-recent one (deep link to its detail page so the
              user can review/approve). When it doesn't, drop them on
              the flux month index page with ?period= so the Start
              CTA pre-fills the period — same shape as the recons
              "Start month-end close" flow. We deliberately do NOT
              pass ?new=1 anymore — it auto-opened the wizard, which
              the user found jarring. They wanted a confirm + sync
              step, not an instant upload picker. */}
          <button
            onClick={() => {
              if (monthlyFlux.length > 0) {
                // Most recent analysis for the month
                navigate(`/app/flux/${monthlyFlux[0].id}`)
              } else {
                // Month index with period pre-loaded
                navigate(`/app/flux?period=${period}`)
              }
            }}
            className="rounded-xl overflow-hidden text-left transition-all hover:shadow-lg hover:-translate-y-0.5"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
            <div className="px-4 py-3 flex items-center justify-between"
              style={{ borderBottom: "1px solid var(--border)" }}>
              <div className="flex items-center gap-2">
                <BarChart3 size={18} strokeWidth={1.8} style={{ color: "var(--green)" }} />
                <h2 className="text-base font-semibold text-theme">Open Flux Analysis</h2>
              </div>
              <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold"
                style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
                {monthLabel}
              </span>
            </div>
            <div className="px-4 py-3">
              {monthlyFlux.length === 0 ? (
                <div className="py-6 text-center">
                  <p className="text-xs mb-2" style={{ color: "var(--text-muted)" }}>
                    No flux analysis for {monthLabel} yet.
                  </p>
                  <span className="inline-block text-[11px] px-2 py-1 rounded"
                    style={{ background: "var(--surface-2)", color: "var(--text-2)" }}>
                    Click to start one in the Flux Analysis dashboard
                  </span>
                </div>
              ) : (
                <ul>
                  {monthlyFlux.slice(0, 4).map((tb) => {
                    // Approval lives on tb.approved_by / approved_at —
                    // tb.status itself stays as the lifecycle state
                    // ("complete", "ready_for_review") even after sign-
                    // off. So "Approved" wins the label race when
                    // approved_at is set; otherwise we humanize the
                    // raw status.
                    const approved = !!tb.approved_at
                    return (
                      <li key={tb.id} className="flex items-center gap-2 py-1.5 text-xs"
                        onClick={(e) => { e.stopPropagation(); navigate(`/app/flux/${tb.id}`) }}>
                        <span className="h-1.5 w-1.5 rounded-full"
                          style={{ background: approved ? "var(--green)" : "var(--text-muted)" }} />
                        <span className="flex-1 truncate text-theme">{tb.name || `Period ${tb.period_current}`}</span>
                        <span className="text-[10px]"
                          style={{ color: approved ? "var(--green)" : "var(--text-muted)" }}>
                          {approved ? "Approved" : humanize(tb.status, { ready_for_review: "In review" })}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
            <div className="px-4 py-2.5 flex items-center justify-between"
              style={{ borderTop: "1px solid var(--border)", background: "var(--surface-2)" }}>
              <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                {monthlyFlux.length} this month · {(trialBalances ?? []).length} total
              </span>
              <span className="inline-flex items-center gap-1 text-xs font-semibold" style={{ color: "var(--green)" }}>
                Open dashboard <ArrowRight size={12} strokeWidth={2} />
              </span>
            </div>
          </button>
        </div>

        {/* ── Insights tile (full width) ─────────────────────────── */}
        <button
          onClick={() => navigate(`/app/insights?period=${period}`)}
          className="rounded-xl overflow-hidden text-left transition-all hover:shadow-lg hover:-translate-y-0.5 w-full"
          style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
          <div className="px-4 py-3 flex items-center justify-between"
            style={{ borderBottom: "1px solid var(--border)" }}>
            <div className="flex items-center gap-2">
              <Lightbulb size={18} strokeWidth={1.8} style={{ color: "var(--green)" }} />
              <h2 className="text-base font-semibold text-theme">Insights</h2>
            </div>
            <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold"
              style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
              {monthLabel}
            </span>
          </div>
          <div className="px-4 py-3.5 grid grid-cols-2 sm:grid-cols-4 gap-3">
            <InsightHint label="Liquidity"        sub="Cash · Burn · Runway · OCF" />
            <InsightHint label="Profitability"    sub="Revenue · GP · Net margin" />
            <InsightHint label="AR / AP"          sub="DSO · DPO · Aging · Top dues" />
            <InsightHint label="Expense monitor"  sub="Top categories · MoM movers" />
          </div>
          <div className="px-4 py-2.5 flex items-center justify-between"
            style={{ borderTop: "1px solid var(--border)", background: "var(--surface-2)" }}>
            <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
              AI-generated risks &amp; recommendations for {monthLabel}
            </span>
            <span className="inline-flex items-center gap-1 text-xs font-semibold" style={{ color: "var(--green)" }}>
              Open Insights <ArrowRight size={12} strokeWidth={2} />
            </span>
          </div>
        </button>

        {/* ── Recent activity feed (slim, full-width below) ──────── */}
        <div className="rounded-xl overflow-hidden"
          style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
          <div className="px-4 py-3 flex items-center gap-2" style={{ borderBottom: "1px solid var(--border)" }}>
            <Clock size={16} strokeWidth={1.8} style={{ color: "var(--green)" }} />
            <h2 className="text-sm font-semibold text-theme">Recent activity</h2>
          </div>
          <div className="px-4 py-3">
            {!audit ? (
              <div className="py-4 flex items-center justify-center"><Spinner className="h-4 w-4" /></div>
            ) : audit.length === 0 ? (
              <p className="text-xs py-2 text-center" style={{ color: "var(--text-muted)" }}>
                No activity yet.
              </p>
            ) : (
              <ul className="space-y-2">
                {audit.slice(0, 8).map((e) => {
                  const who = e.user_id ? (userNames?.[e.user_id]?.display_name ?? "Someone") : "System"
                  const verb = humanizeAction(e.action)
                  return (
                    <li key={e.id} className="flex items-start gap-2 text-[11px]">
                      <span className="h-1.5 w-1.5 rounded-full mt-1.5 shrink-0"
                        style={{ background: "var(--green)" }} />
                      <div className="min-w-0 flex-1">
                        <p className="text-theme">
                          <span className="font-medium">{who}</span> {verb}
                        </p>
                        {e.summary && (
                          <p className="truncate" style={{ color: "var(--text-muted)" }}>{e.summary}</p>
                        )}
                      </div>
                      <span className="text-[10px] whitespace-nowrap" style={{ color: "var(--text-muted)" }}>
                        {timeAgo(e.created_at)}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>

        {/* Footer — quick links */}
        <div className="flex items-center justify-center gap-2 flex-wrap pt-2">
          <FooterPill icon={<Plug size={11} strokeWidth={1.8} />} label="Connections"
            onClick={() => navigate("/app/connections")} />
          <FooterPill icon={<Users size={11} strokeWidth={1.8} />} label="Companies"
            onClick={() => navigate("/app/companies")} />
          <FooterPill icon={<ListChecks size={11} strokeWidth={1.8} />} label="Overrides"
            onClick={() => navigate("/app/reconciliations/overrides")} />
        </div>
      </div>
    </div>
  )
}

// ── Subcomponents ──────────────────────────────────────────────────────────

/**
 * CloseProgressCard — at-a-glance "where am I in this month's close"
 * for the period the user has focused. Updates whenever the user
 * clicks a different tile in the month-end tracker above.
 *
 * Renders three states:
 *   • Closed → green confirmation banner ("Books closed on … by …")
 *   • In progress (has work) → progress bar + status breakdown +
 *     days into close vs target (period_end + 15 days)
 *   • Not started (no AccountReviewStatus rows yet) → friendly nudge
 *     to start the close
 */
function CloseProgressCard({
  monthLabel, period, trackerEntry, onOpen,
  isAdmin, blocker, onCloseBooks, closing, closeMsg,
  fluxStatus, onOpenFlux,
}: {
  monthLabel: string
  period: string
  // All counts/status come from the lightweight tracker payload (one
  // cheap DB query, cached 60s). The card USED to also read from the
  // recons `overview` query — but that triggers live QBO calls and
  // makes the card pop in 3-8s after you click a month tile. Tracker
  // alone has identical info (total + counts.{pending,reviewed,approved,
  // flagged} + approved_pct + closed_at) and renders instantly because
  // the full tracker payload is already cached when the page first loads.
  trackerEntry?: {
    status: string
    approved_pct: number
    closed_at: string | null
    closed_by: string | null
    total: number
    counts: { pending: number; reviewed: number; approved: number; flagged: number }
  }
  onOpen: () => void
  // Close-books wiring — surfaces a Ready-to-close CTA inside State 3
  // (in-progress) when every account is approved AND no earlier month
  // is blocking. Admin-only; preparers/reviewers see the progress bar
  // but no action.
  isAdmin: boolean
  blocker: { label: string; period_end: string; unapproved: number } | null
  onCloseBooks: () => void
  closing: boolean
  closeMsg: { kind: "ok" | "err"; text: string } | null
  // Flux gate state — the server also requires every flux analysis for
  // the month to be approved before closing. Surface this in the UI so
  // the admin knows why the Close button is disabled.
  fluxStatus: { total: number; unapprovedCount: number; allApproved: boolean }
  onOpenFlux: () => void
}) {
  // Parse period for date math
  const periodEnd = (() => {
    try { return new Date(period + "T00:00:00") } catch { return null }
  })()
  const today = new Date(new Date().toDateString())
  const daysSinceClose = periodEnd ? Math.floor((today.getTime() - periodEnd.getTime()) / 86_400_000) : 0
  // Close-target window comes from the company meta (set during create-
  // company / Settings). Fallback to 15 days when unset so legacy
  // workspaces still get a sensible target.
  const targetDays = useCloseTargetDays()
  const targetClose = periodEnd ? new Date(periodEnd.getTime() + targetDays * 86_400_000) : null
  const daysToTarget = targetClose ? Math.ceil((targetClose.getTime() - today.getTime()) / 86_400_000) : 0
  const targetLabel    = targetClose ? formatDate(targetClose) : ""
  const periodEndLabel = periodEnd    ? formatDate(periodEnd)   : period
  const pct = Math.min(100, Math.max(0, Math.round(trackerEntry?.approved_pct ?? 0)))
  const status = trackerEntry?.status ?? "not_started"
  // Derive bucket counts directly from the tracker entry so the card
  // can render synchronously off the cached tracker payload.
  const counts = trackerEntry?.counts ?? { pending: 0, reviewed: 0, approved: 0, flagged: 0 }
  const total = trackerEntry?.total ?? 0
  const openCount = counts.pending  // "open" = unreviewed accounts

  // ── State 1: closed ─────────────────────────────────────────────
  if (status === "closed") {
    const closedAt = trackerEntry?.closed_at ? formatDateLong(trackerEntry.closed_at) : ""
    return (
      <ClosedStateCard
        monthLabel={monthLabel}
        period={period}
        closedAt={closedAt}
        approvedCount={counts.approved}
        total={total}
        onOpen={onOpen}
      />
    )
  }

  // ── State 2: not started ────────────────────────────────────────
  if (status === "not_started" || total === 0) {
    return (
      <div className="rounded-xl overflow-hidden"
        style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
        <div className="px-5 py-4 flex items-center gap-4">
          <div className="h-12 w-12 rounded-full flex items-center justify-center shrink-0"
            style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}>
            <Circle size={20} strokeWidth={1.8} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-wider mb-0.5" style={{ color: "var(--text-muted)" }}>
              Month-end close progress · {monthLabel}
            </p>
            <h3 className="text-base font-semibold text-theme leading-tight">Not started yet</h3>
            <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
              Click the {monthLabel} tile above and Start to begin the close.
            </p>
          </div>
          <Button size="sm" onClick={onOpen}>Open</Button>
        </div>
      </div>
    )
  }

  // ── State 3: in progress (the meat) ─────────────────────────────
  const isOverdue = daysToTarget < 0
  return (
    <div className="rounded-xl overflow-hidden"
      style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
      <div className="px-5 py-4 flex items-center justify-between flex-wrap gap-2"
        style={{ borderBottom: "1px solid var(--border)" }}>
        <div className="flex items-center gap-2">
          <CalendarCheck size={16} strokeWidth={1.8} style={{ color: "var(--green)" }} />
          <h3 className="text-sm font-semibold text-theme">
            Month-end close progress · <span style={{ color: "var(--green)" }}>{monthLabel}</span>
          </h3>
        </div>
        <span className="inline-flex items-center gap-1 text-xs font-bold tabular-nums px-2 py-0.5 rounded-full"
          style={{
            background: pct === 100 ? "var(--green-subtle)" : "var(--surface-2)",
            color: pct === 100 ? "var(--green)" : "var(--text-2)",
          }}>
          {pct}% approved
        </span>
      </div>

      {/* Progress bar */}
      <div className="px-5 pt-4 pb-2">
        <div className="h-2 w-full rounded-full overflow-hidden" style={{ background: "rgba(0,0,0,0.08)" }}>
          <div className="h-full rounded-full transition-all"
            style={{
              width: `${pct}%`,
              background: pct === 100 ? "var(--green)" : pct >= 50 ? "#3b82f6" : "#f59e0b",
            }} />
        </div>
        <p className="text-[11px] mt-1.5" style={{ color: "var(--text-muted)" }}>
          {counts.approved} of {total} accounts approved
          {pct === 100 && <> · ready to lock the books</>}
        </p>
      </div>

      {/* Status breakdown — 4 mini-tiles */}
      <div className="grid grid-cols-4 divide-x" style={{ borderTop: "1px solid var(--border)" }}>
        <ProgressTile label="Open"     count={openCount}        fg="#b91c1c"      bg="rgba(220,38,38,0.06)" />
        <ProgressTile label="Prepared" count={counts.reviewed}  fg="#1d4ed8"      bg="rgba(29,78,216,0.06)" />
        <ProgressTile label="Approved" count={counts.approved}  fg="var(--green)" bg="var(--green-subtle)" />
        <ProgressTile label="Flagged"  count={counts.flagged}   fg="#ef4444"      bg="rgba(239,68,68,0.06)" />
      </div>

      {/* Timeline footer */}
      <div className="px-5 py-3 flex items-center justify-between flex-wrap gap-2 text-[11px]"
        style={{ borderTop: "1px solid var(--border)", background: "var(--surface-2)" }}>
        <div style={{ color: "var(--text-muted)" }}>
          Period ended {periodEndLabel} · Target close {targetLabel}
        </div>
        <div className="inline-flex items-center gap-2">
          <span style={{ color: "var(--text-muted)" }}>
            {daysSinceClose < 0
              ? `${Math.abs(daysSinceClose)} days until period-end`
              : `${daysSinceClose} day${daysSinceClose === 1 ? "" : "s"} into close`}
          </span>
          <span style={{
            color: isOverdue ? "#dc2626" : pct === 100 ? "var(--green)" : "var(--text-2)",
            fontWeight: 600,
          }}>
            ·
            {" "}{isOverdue
              ? `${Math.abs(daysToTarget)} day${Math.abs(daysToTarget) === 1 ? "" : "s"} overdue`
              : `${daysToTarget} day${daysToTarget === 1 ? "" : "s"} to target`}
          </span>
        </div>
      </div>

      {/* ── Ready-to-close CTA bar ─────────────────────────────
          Two-gate close: every recon account approved (pct === 100)
          AND every flux analysis for the month approved (fluxStatus.allApproved).
          Tone of the bar shifts based on which gates pass:
            • Both pass → green "ready to close" + admin Close button.
            • Recons done, flux not → amber "still need flux approvals"
              + link to the Flux page (no Close button).
            • Recons not done → strip hidden (the progress bar tells
              that story already).
          The server-side close gate enforces both rules either way; we
          mirror them here so the admin doesn't click the button only
          to bounce off a 409. */}
      {pct === 100 && (
        <div className="px-5 py-3 flex items-center justify-between flex-wrap gap-2"
          style={{
            borderTop: "1px solid var(--border)",
            background: fluxStatus.allApproved ? "var(--green-subtle)" : "rgba(245, 158, 11, 0.10)",
          }}>
          <div className="flex items-center gap-2 min-w-0">
            {fluxStatus.allApproved ? (
              <>
                <CheckCircle2 size={14} strokeWidth={2} style={{ color: "var(--green)" }} className="shrink-0" />
                <span className="text-xs font-semibold" style={{ color: "var(--green)" }}>
                  {monthLabel} is reconciled — every account
                  {fluxStatus.total > 0
                    ? ` and ${fluxStatus.total} flux analysis${fluxStatus.total === 1 ? "" : "es"}`
                    : ""} approved.
                </span>
              </>
            ) : (
              <>
                <Lock size={14} strokeWidth={2} style={{ color: "#b45309" }} className="shrink-0" />
                <span className="text-xs font-semibold" style={{ color: "#b45309" }}>
                  {fluxStatus.total === 0
                    ? `Flux analysis required for ${monthLabel}.`
                    : `${fluxStatus.unapprovedCount} flux analysis${fluxStatus.unapprovedCount === 1 ? "" : "es"} still need approval.`
                  }
                </span>
              </>
            )}
          </div>
          {isAdmin && (
            blocker ? (
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold" style={{ color: "#b45309" }}>
                <Lock size={11} strokeWidth={2} />
                Close {blocker.label} first
              </span>
            ) : !fluxStatus.allApproved ? (
              <Button
                size="sm"
                variant="outline"
                onClick={onOpenFlux}
                icon={<BarChart3 size={12} strokeWidth={1.8} />}
                title={fluxStatus.total === 0
                  ? "Open Flux Analysis to create one for this month"
                  : "Open Flux Analysis to approve the pending analyses"
                }
                style={{ borderColor: "#f59e0b", color: "#b45309" }}
              >
                {fluxStatus.total === 0 ? "Start flux" : "Approve flux"}
              </Button>
            ) : (
              <Button
                size="sm"
                icon={<Lock size={12} strokeWidth={1.8} />}
                loading={closing}
                onClick={onCloseBooks}
                title="Lock the books for this period — preparers + reviewers will no longer be able to edit"
              >
                Close month-end books
              </Button>
            )
          )}
        </div>
      )}

      {/* Inline confirmation banner — success or error from the
          close-books mutation. Sits at the very bottom so it doesn't
          shift the layout above. Auto-clears via parent's timer. */}
      <AnimatePresence>
        {closeMsg && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18 }}
            className="px-5 py-2 flex items-start gap-2 text-xs"
            style={{
              background: closeMsg.kind === "ok" ? "var(--green-subtle)" : "#fef2f2",
              color:      closeMsg.kind === "ok" ? "var(--green)" : "#b91c1c",
              borderTop:  "1px solid var(--border)",
              overflow:   "hidden",
            }}>
            {closeMsg.kind === "ok"
              ? <CheckCircle2 size={12} strokeWidth={2} className="shrink-0 mt-0.5" />
              : <Lock size={12} strokeWidth={2} className="shrink-0 mt-0.5" />}
            <span className="flex-1">{closeMsg.text}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── ClosedStateCard ──────────────────────────────────────────────────────
//
// Subcomponent for the "books closed" state of CloseProgressCard.
// Pulled out because it owns its own mutation (executive report
// download) and was getting cluttered inline. Surfaces a primary
// "Download executive report" button right where the user is — the
// previous flow buried it at the bottom of Financial Package and
// the user couldn't find it.

function ClosedStateCard({
  monthLabel, period, closedAt, approvedCount, total, onOpen,
}: {
  monthLabel: string
  period: string
  closedAt: string
  approvedCount: number
  total: number
  onOpen: () => void
}) {
  const [execError, setExecError] = useState<string | null>(null)
  const execMut = useMutation({
    mutationFn: async () => {
      const { financialsApi } = await import("@/modules/financials/api")
      return financialsApi.exportExecutiveReport(period)
    },
    onMutate: () => setExecError(null),
    onError: (e: Error) => setExecError(e.message),
  })
  // Auto-dismiss errors so the card doesn't carry a permanent failure
  // message after the user retries.
  useEffect(() => {
    if (!execError) return
    const t = setTimeout(() => setExecError(null), 6_000)
    return () => clearTimeout(t)
  }, [execError])

  return (
    <div className="rounded-xl overflow-hidden"
      style={{ background: "var(--green-subtle)", border: "1px solid var(--green)", boxShadow: "var(--card-shadow)" }}>
      <div className="px-5 py-4 flex items-center gap-4 flex-wrap">
        <div className="h-12 w-12 rounded-full flex items-center justify-center shrink-0"
          style={{ background: "var(--green)", color: "white" }}>
          <Lock size={20} strokeWidth={2} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-wider mb-0.5" style={{ color: "var(--green)" }}>
            Month-end close complete
          </p>
          <h3 className="text-lg font-bold text-theme leading-tight">{monthLabel} books closed</h3>
          <p className="text-xs mt-1" style={{ color: "var(--text-2)" }}>
            {closedAt && <>Closed on {closedAt} · </>}
            {approvedCount} of {total} account{total === 1 ? "" : "s"} approved
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button size="sm" variant="outline" onClick={onOpen}>
            View
          </Button>
          {/* Executive Report — board-ready AI-narrated PDF.
              Lives here because the user kept asking "where do I
              generate the executive report" — burying it inside the
              Financial Package tab (where it requires Load + scroll)
              made it invisible. The dashboard is the natural place
              once books are closed. */}
          <Button
            size="sm"
            icon={<Sparkles size={12} strokeWidth={1.8} />}
            loading={execMut.isPending}
            onClick={() => execMut.mutate()}
            title="Download the AI-narrated executive report (10+ page board package)"
          >
            {execMut.isPending ? "Generating…" : "Download executive report"}
          </Button>
        </div>
      </div>
      {execError && (
        <div className="px-5 py-2 text-xs flex items-start gap-2"
          style={{ background: "#fef2f2", color: "#991b1b", borderTop: "1px solid #fecaca" }}>
          <AlertCircleIcon /> <span className="flex-1">{execError}</span>
        </div>
      )}
      {execMut.isPending && (
        <div className="px-5 py-2 text-[11px] italic" style={{ color: "var(--text-muted)", borderTop: "1px solid var(--border)" }}>
          Pulling financials + insights + flux, then asking Claude for the narrative. About 10–30 seconds.
        </div>
      )}
    </div>
  )
}

// Tiny inline alert icon so we don't haul lucide-react's AlertCircle
// out for a one-off error stripe inside this card.
function AlertCircleIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5">
      <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  )
}

function ProgressTile({ label, count, fg, bg }: { label: string; count: number; fg: string; bg: string }) {
  return (
    <div className="px-3 py-2.5 text-center" style={{ background: count > 0 ? bg : undefined }}>
      <p className="text-[10px] uppercase tracking-wide font-semibold"
        style={{ color: count > 0 ? fg : "var(--text-muted)" }}>{label}</p>
      <p className="text-lg font-bold tabular-nums mt-0.5"
        style={{ color: count > 0 ? fg : "var(--text-muted)" }}>{count}</p>
    </div>
  )
}

function Kpi({ label, value, tone, sub }: { label: string; value: string; tone: string; sub?: string }) {
  return (
    <div className="rounded-xl p-4"
      style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
      <p className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>{label}</p>
      <p className="text-xl sm:text-2xl font-bold tabular-nums mt-1" style={{ color: tone }}>{value}</p>
      {sub && <p className="text-[10px] mt-1" style={{ color: "var(--text-muted)" }}>{sub}</p>}
    </div>
  )
}

function InsightHint({ label, sub }: { label: string; sub: string }) {
  return (
    <div className="rounded-lg px-3 py-2.5"
      style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
      <p className="text-[11px] font-bold uppercase tracking-wider" style={{ color: "var(--green)" }}>{label}</p>
      <p className="text-[11px] mt-0.5" style={{ color: "var(--text-muted)" }}>{sub}</p>
    </div>
  )
}

function BucketTile({ label, count, fg, bg, onClick }:
  { label: string; count: number; fg: string; bg: string; onClick?: () => void }) {
  return (
    <div onClick={onClick}
      className="px-4 py-3 text-left"
      style={{ borderColor: "var(--border)", cursor: onClick ? "pointer" : "default" }}>
      <p className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>{label}</p>
      <div className="mt-1 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-bold"
        style={{ background: bg, color: fg }}>
        {count}
      </div>
    </div>
  )
}

function FooterPill({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-medium transition-colors hover:opacity-80"
      style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text-2)" }}>
      {icon}
      {label}
    </button>
  )
}

// Map raw audit actions to friendly verbs for the feed.
function humanizeAction(action: string): string {
  const m: Record<string, string> = {
    "recon.account_approved":      "approved an account",
    "recon.account_reviewed":      "marked an account prepared",
    "recon.account_flagged":       "flagged an account",
    "recon.account_pending":       "reset an account to pending",
    "recon.bulk_approved":         "bulk-approved accounts",
    "recon.bulk_reviewed":         "bulk-marked accounts prepared",
    "recon.bulk_flagged":          "bulk-flagged accounts",
    "recon.evidence_uploaded":     "uploaded supporting evidence",
    "recon.evidence_deleted":      "deleted an evidence file",
    "recon.evidence_verified":     "verified evidence with AI",
    "recon.subledger_override_set":     "set a manual subledger",
    "recon.subledger_override_cleared": "cleared a manual subledger",
    "recon.books_seeded":          "set books start date",
    "narrative.approve":           "approved a narrative",
    "narrative.edit":              "edited a narrative",
    "trial_balance.upload":        "uploaded a trial balance",
    "flux.run":                    "ran a flux analysis",
  }
  return m[action] ?? action.replace(/[._]/g, " ")
}

