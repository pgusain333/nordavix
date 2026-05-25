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
import { useMemo, useState } from "react"
import { useUser } from "@clerk/clerk-react"
import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { motion } from "framer-motion"
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
} from "lucide-react"
import { api as fluxApi } from "@/modules/flux/api"
import { reconsApi } from "@/modules/recons/api"
import { workspaceApi } from "@/modules/workspace/api"
import { Button, Spinner } from "@/core/ui/components"

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
  const [period] = useState<string>(defaultPeriodEnd())

  // QBO connection — needed for setup checklist + recons overview
  const { data: qbo, isLoading: qboLoading } = useQuery({
    queryKey: ["qbo-connection"],
    queryFn:  fluxApi.getQboConnection,
    staleTime: 5 * 60_000,
  })

  // Books status — needed for setup checklist
  const { data: books } = useQuery({
    queryKey: ["books-status"],
    queryFn:  reconsApi.getBooksStatus,
    staleTime: 5 * 60_000,
  })

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

  const recentTBs = useMemo(
    () => (trialBalances ?? []).slice(0, 4),
    [trialBalances],
  )

  // Recons buckets — open / reviewed / approved counts derived from the overview
  const buckets = useMemo(() => {
    const c = { open: 0, reviewed: 0, approved: 0, total: overview?.accounts.length ?? 0 }
    overview?.accounts.forEach((a) => {
      if (a.review_status === "approved") c.approved++
      else if (a.review_status === "reviewed") c.reviewed++
      else c.open++
    })
    return c
  }, [overview])

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
        <h1 style={{
          fontSize: "clamp(22px, 5vw, 28px)", fontWeight: 700, lineHeight: 1.2,
          letterSpacing: "-0.01em", color: "var(--text)", margin: 0,
        }}>
          {getGreeting(user?.fullName || user?.firstName || "")}
        </h1>
        <p className="text-xs sm:text-sm mt-1.5" style={{ color: "var(--text-muted)" }}>
          {books?.seeded
            ? `Books locked to ${books.books_start_date}. Reconciling period ${overview?.period_end ?? period}.`
            : "Welcome to Nordavix — finish the setup below to start reconciling."}
        </p>
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
          ) : (
            <>
            <div className="overflow-x-auto">
              <div className="flex gap-2 px-4 py-3" style={{ minWidth: "min-content" }}>
                {tracker!.periods.map((p) => {
                  const meta = {
                    closed:      { bg: "rgba(245, 158, 11, 0.10)", border: "#f59e0b",         fg: "#b45309",         icon: <Lock size={12} strokeWidth={2} /> },
                    complete:    { bg: "var(--green-subtle)",      border: "var(--green)",    fg: "var(--green)",    icon: <CheckCircle2 size={12} strokeWidth={2} /> },
                    in_progress: { bg: "#dbeafe",                  border: "#3b82f6",         fg: "#1d4ed8",         icon: <Circle size={12} strokeWidth={2} /> },
                    not_started: { bg: "var(--surface-2)",         border: "var(--border)",   fg: "var(--text-muted)", icon: <Circle size={12} strokeWidth={2} /> },
                  }[p.status]
                  return (
                    <button
                      key={p.period_end}
                      onClick={() => navigate(`/app/reconciliations?period=${p.period_end}`)}
                      className="rounded-lg p-3 text-left transition-all hover:shadow-md hover:-translate-y-px"
                      style={{
                        background: meta.bg,
                        border: `1px solid ${meta.border}`,
                        minWidth: 150,
                      }}
                    >
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-xs font-bold" style={{ color: meta.fg }}>{p.label}</span>
                        <span style={{ color: meta.fg }}>{meta.icon}</span>
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
                        <span className="text-[10px] italic" style={{ color: meta.fg, opacity: 0.7 }}>
                          Not started
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
            <div className="px-4 py-2 text-[10px]" style={{ borderTop: "1px solid var(--border)", background: "var(--surface-2)", color: "var(--text-muted)" }}>
              Books started {tracker!.books_start_date} · {tracker!.periods.length} period{tracker!.periods.length === 1 ? "" : "s"} ·
              {" "}{tracker!.periods.filter((p) => p.status === "closed").length} closed · click a month to drill in
            </div>
            </>
          )}
        </div>

        {/* ── KPI strip ────────────────────────────────────────── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Kpi label="Open accounts to reconcile" value={String(buckets.open)} tone="#dc2626"
            sub={buckets.total > 0 ? `${buckets.total} total this period` : "Sync to see"} />
          <Kpi label="Total variance" value={fmtMoney(totalVariance)} tone="var(--text)"
            sub={buckets.total > 0 ? "across all accounts" : "—"} />
          <Kpi label="Recent flux analyses" value={String((trialBalances ?? []).length)} tone="var(--text)"
            sub={recentTBs.length > 0 ? "ready to drill in" : "no analyses yet"} />
          <Kpi label="Team members" value={String(members?.length ?? 0)} tone="var(--text)" sub="see settings" />
        </div>

        {/* ── Two-column body ─────────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

          {/* Reconciliations panel — spans 2/3 */}
          <div className="lg:col-span-2 rounded-xl overflow-hidden"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
            <div className="px-4 py-3 flex items-center justify-between"
              style={{ borderBottom: "1px solid var(--border)" }}>
              <div className="flex items-center gap-2">
                <Scale size={16} strokeWidth={1.8} style={{ color: "var(--green)" }} />
                <h2 className="text-sm font-semibold text-theme">Reconciliations</h2>
              </div>
              <Button size="sm" variant="outline" icon={<ArrowRight size={12} strokeWidth={1.8} />}
                onClick={() => navigate("/app/reconciliations")}>
                Open dashboard
              </Button>
            </div>

            {/* Buckets summary */}
            <div className="grid grid-cols-3 divide-x" style={{ borderBottom: "1px solid var(--border)" }}>
              <BucketTile label="Open" count={buckets.open} fg="#b91c1c" bg="#fef2f2"
                onClick={() => navigate("/app/reconciliations")} />
              <BucketTile label="Reviewed" count={buckets.reviewed} fg="#1d4ed8" bg="#dbeafe"
                onClick={() => navigate("/app/reconciliations")} />
              <BucketTile label="Approved" count={buckets.approved} fg="var(--green)" bg="var(--green-subtle)"
                onClick={() => navigate("/app/reconciliations")} />
            </div>

            {/* Top open accounts */}
            <div className="px-4 py-3">
              <p className="text-[10px] font-semibold uppercase tracking-wide mb-2" style={{ color: "var(--text-muted)" }}>
                Top open accounts by variance
              </p>
              {!overview ? (
                <p className="text-xs py-4" style={{ color: "var(--text-muted)" }}>
                  {!qbo ? "Connect QuickBooks to load."
                    : !books?.seeded ? "Finish books setup to load."
                    : "No reconciliation data for this period yet."}
                </p>
              ) : topOpen.length === 0 ? (
                <div className="py-4 text-center text-xs" style={{ color: "var(--text-muted)" }}>
                  <CheckCircle2 size={20} strokeWidth={1.6} className="mx-auto mb-1" style={{ color: "var(--green)" }} />
                  Nothing open. All accounts reviewed or approved.
                </div>
              ) : (
                <ul className="divide-y" style={{ borderColor: "var(--border)" }}>
                  {topOpen.map((a) => {
                    const v = parseFloat(a.variance) || 0
                    return (
                      <li key={a.qbo_id}
                        className="flex items-center gap-3 py-2 px-1 rounded transition-colors cursor-pointer"
                        onClick={() => navigate("/app/reconciliations")}>
                        <span className="font-mono text-[11px]" style={{ color: "var(--text-muted)" }}>
                          {a.account_number || "—"}
                        </span>
                        <span className="flex-1 truncate text-sm text-theme">{a.account_name}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full"
                          style={{
                            background: a.review_status === "flagged" ? "#fee2e2" : "var(--surface-2)",
                            color: a.review_status === "flagged" ? "#b91c1c" : "var(--text-muted)",
                          }}>
                          {a.review_status}
                        </span>
                        <span className="text-sm tabular-nums font-semibold"
                          style={{ color: Math.abs(v) >= 1 ? "#dc2626" : "var(--green)" }}>
                          {fmtMoney(a.variance)}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </div>

          {/* Right side: Flux + Recent activity */}
          <div className="space-y-5">
            <div className="rounded-xl overflow-hidden"
              style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
              <div className="px-4 py-3 flex items-center justify-between"
                style={{ borderBottom: "1px solid var(--border)" }}>
                <div className="flex items-center gap-2">
                  <BarChart3 size={16} strokeWidth={1.8} style={{ color: "var(--green)" }} />
                  <h2 className="text-sm font-semibold text-theme">Flux Analysis</h2>
                </div>
                <Button size="sm" variant="outline" icon={<ArrowRight size={12} strokeWidth={1.8} />}
                  onClick={() => navigate("/app/flux")}>
                  Open
                </Button>
              </div>
              <div className="px-4 py-3">
                {recentTBs.length === 0 ? (
                  <p className="text-xs py-2 text-center" style={{ color: "var(--text-muted)" }}>
                    No analyses yet.
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {recentTBs.map((tb) => (
                      <li key={tb.id}
                        className="flex items-center gap-2 text-xs cursor-pointer rounded px-1 py-1 transition-colors"
                        onClick={() => navigate(`/app/flux/${tb.id}`)}>
                        <span className="h-1.5 w-1.5 rounded-full"
                          style={{ background: tb.status === "completed" ? "var(--green)" : "var(--text-muted)" }} />
                        <span className="flex-1 truncate text-theme">
                          {tb.name || `Period ${tb.period_current}`}
                        </span>
                        <span style={{ color: "var(--text-muted)" }}>{tb.status}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

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
                              <p className="truncate" style={{ color: "var(--text-muted)" }}>
                                {e.summary}
                              </p>
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

function BucketTile({ label, count, fg, bg, onClick }:
  { label: string; count: number; fg: string; bg: string; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className="px-4 py-3 text-left transition-colors hover:opacity-80"
      style={{ borderColor: "var(--border)" }}>
      <p className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>{label}</p>
      <div className="mt-1 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-bold"
        style={{ background: bg, color: fg }}>
        {count}
      </div>
    </button>
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
    "recon.account_reviewed":      "marked an account reviewed",
    "recon.account_flagged":       "flagged an account",
    "recon.account_pending":       "reset an account to pending",
    "recon.bulk_approved":         "bulk-approved accounts",
    "recon.bulk_reviewed":         "bulk-marked accounts reviewed",
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

