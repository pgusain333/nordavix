/**
 * Close Command Center — the firm-level cockpit.
 *
 * One screen, every company the user belongs to, sorted by who needs
 * attention first. Each row answers the Monday-morning questions in a
 * single glance:
 *
 *   [Company]  [Focus month + recon progress bar]  [Flux · Adjustments
 *    · QBO chips]  [days since period end]  [Open →]
 *
 * Sorting doctrine (most actionable first):
 *   1. Ready to close (all approved — one click from done)
 *   2. In progress / not started, most days overdue first
 *   3. Setup needed (no books / no QBO)
 *   4. Fully caught up
 *
 * Clicking Open switches the active Clerk organization (same mechanism
 * as the company switcher) and lands on that company's dashboard — the
 * org-change listener invalidates every query, so data can never bleed
 * between companies.
 *
 * Color doctrine matches the app: muted by default, color only where it
 * carries meaning (green = done, amber = aging, red = overdue/flagged).
 */
import { useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useOrganization, useOrganizationList } from "@clerk/clerk-react"
import { motion } from "framer-motion"
import {
  ArrowRight,
  Building2,
  CalendarClock,
  CheckCircle2,
  Flag,
  Plug,
  Plus,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  TrendingUp,
  UserCheck,
} from "lucide-react"
import { Spinner } from "@/core/ui/components"
import { PageHeader } from "@/core/ui/PageHeader"
import { firmApi, type CommandCenterCompany } from "@/modules/firm/api"

// ── Sorting: most actionable first ──────────────────────────────────────────

function urgencyScore(c: CommandCenterCompany): number {
  // Anything blocked on THIS person outranks everything else — a partner's
  // approval is the scarce resource, and a client waiting on them is stalled
  // no matter how the progress bar looks. High-severity findings come next:
  // books that are wrong beat books that are merely unfinished.
  const mine = c.awaiting_you?.total ?? 0
  if (mine > 0) return 9000 + Math.min(mine, 999)
  if ((c.risk?.high ?? 0) > 0) return 8000 + Math.min(c.risk.high, 999)
  if (!c.books_set || !c.qbo_connected) return 1000
  if (!c.focus) return 0                                  // fully caught up
  if (c.focus.status === "complete") return 4000          // ready to close NOW
  return 3000 + Math.min(c.focus.days_since_period_end, 365)
}

/** Why this company is at the top — the sentence a partner reads instead of
 *  decoding a progress bar. Null when nothing needs them. */
function attentionReason(c: CommandCenterCompany): string | null {
  const mine = c.awaiting_you?.total ?? 0
  if (mine > 0) {
    const parts: string[] = []
    if (c.awaiting_you.recons) parts.push(`${c.awaiting_you.recons} reconciliation${c.awaiting_you.recons === 1 ? "" : "s"}`)
    if (c.awaiting_you.adjustments) parts.push(`${c.awaiting_you.adjustments} adjustment${c.awaiting_you.adjustments === 1 ? "" : "s"}`)
    return `${parts.join(" and ")} waiting on your approval`
  }
  if ((c.risk?.high ?? 0) > 0) {
    return `${c.risk.high} high-severity finding${c.risk.high === 1 ? "" : "s"} in the books`
  }
  if (!c.books_set || !c.qbo_connected) return "Not set up yet"
  if (c.focus && c.focus.days_since_period_end >= 14) {
    return `Day ${c.focus.days_since_period_end} of the close, ${c.focus.approved}/${c.focus.total} approved`
  }
  return null
}

// ── Small atoms ──────────────────────────────────────────────────────────────

function Chip({ icon, label, fg, bg, title }: {
  icon?: React.ReactNode
  label: string
  fg: string
  bg: string
  title?: string
}) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold whitespace-nowrap"
      style={{ color: fg, background: bg }}
    >
      {icon}
      {label}
    </span>
  )
}

/** Segmented recon progress: approved (green) → prepared (sage) →
 *  flagged (red) → remainder (track). Tooltip carries the counts. */
function ProgressBar({ approved, reviewed, flagged, total }: {
  approved: number; reviewed: number; flagged: number; total: number
}) {
  const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0)
  return (
    <div
      className="h-1.5 rounded-full overflow-hidden flex w-full"
      style={{ background: "var(--surface-2)" }}
      title={`${approved} approved · ${reviewed} prepared · ${flagged} flagged · ${total} accounts`}
    >
      <div style={{ width: `${pct(approved)}%`, background: "var(--green)" }} />
      <div style={{ width: `${pct(reviewed)}%`, background: "#7FB89B" }} />
      <div style={{ width: `${pct(flagged)}%`, background: "#b4533d" }} />
    </div>
  )
}

function daysTone(days: number): { fg: string; bg: string } {
  if (days >= 15) return { fg: "#9b3d37", bg: "#f7eeec" }
  if (days >= 7)  return { fg: "#8a6326", bg: "rgba(199, 154, 82, 0.12)" }
  return { fg: "var(--text-muted)", bg: "var(--surface-2)" }
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function CommandCenterPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { organization } = useOrganization()
  const { setActive, userMemberships } = useOrganizationList({
    userMemberships: { infinite: true },
  })
  const [switchingId, setSwitchingId] = useState<string | null>(null)

  // Clerk is the canonical source for company names — the backend's
  // Tenant.name can lag (tenants provisioned before the org was named
  // hold the raw org_... id). Overlay Clerk's name whenever we have it.
  const orgNames = useMemo(() => {
    const m: Record<string, string> = {}
    for (const mem of userMemberships?.data ?? []) m[mem.organization.id] = mem.organization.name
    return m
  }, [userMemberships?.data])
  const displayName = (c: CommandCenterCompany) =>
    orgNames[c.clerk_org_id]
    ?? (c.name && !c.name.startsWith("org_") ? c.name : "Unnamed company")

  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ["command-center"],
    queryFn:  firmApi.getCommandCenter,
    staleTime: 60_000,
  })

  const companies = useMemo(
    () => [...(data?.companies ?? [])].sort((a, b) => urgencyScore(b) - urgencyScore(a)),
    [data],
  )

  const kpis = useMemo(() => {
    const list = data?.companies ?? []
    return {
      total:    list.length,
      // The partner's number: companies with something blocked on them, or
      // books showing high-severity findings. Everything else is "on track" —
      // a status grid where all twenty rows look equally important tells a
      // partner nothing.
      needsYou: list.filter((c) => (c.awaiting_you?.total ?? 0) > 0
                                   || (c.risk?.high ?? 0) > 0).length,
      waitingItems: list.reduce((n, c) => n + (c.awaiting_you?.total ?? 0), 0),
      ready:    list.filter((c) => c.focus?.status === "complete").length,
      behind:   list.filter((c) => c.focus && c.focus.status !== "complete"
                                   && c.focus.days_since_period_end >= 7).length,
      caughtUp: list.filter((c) => c.books_set && c.qbo_connected && !c.focus).length,
    }
  }, [data])

  /** Switch the active Clerk org, then land on that company's dashboard.
   *  The app-level org-change listener invalidates every query, so the
   *  next screen renders from the new company's data only. */
  async function openCompany(c: CommandCenterCompany) {
    if (c.clerk_org_id === organization?.id) {
      navigate("/app")
      return
    }
    if (!setActive) return
    setSwitchingId(c.tenant_id)
    try {
      await setActive({ organization: c.clerk_org_id })
      qc.clear()
      navigate("/app")
    } finally {
      setSwitchingId(null)
    }
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto" style={{ background: "var(--bg)" }}>
      <PageHeader
        title="Command Center"
        subtitle="Every company's close on one screen — who's on track, who's behind, and what needs you next."
        actions={
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold disabled:opacity-60 transition-opacity"
            style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }}
          >
            <RefreshCw size={12} strokeWidth={2.2} className={isFetching ? "animate-spin" : ""} />
            Refresh
          </button>
        }
      />

      <div className="flex-1 px-4 sm:px-8 py-5 max-w-6xl w-full mx-auto space-y-5">

        {/* Triage band — the one line a partner should be able to act on.
            A grid of twenty equally-weighted rows says nothing about where
            attention belongs; this says it in a sentence, and the list below
            is already sorted so the named companies are at the top. */}
        {!isLoading && !isError && kpis.total > 0 && (
          <div className="rounded-xl px-4 py-3.5 flex items-start gap-3"
            style={{
              background: kpis.needsYou ? "#fdf6ec" : "var(--surface)",
              border: `1px solid ${kpis.needsYou ? "#e7c99a" : "var(--border)"}`,
            }}>
            {kpis.needsYou
              ? <UserCheck size={17} strokeWidth={2} style={{ color: "#a5711d" }} className="mt-0.5 shrink-0" />
              : <CheckCircle2 size={17} strokeWidth={2} style={{ color: "var(--green)" }} className="mt-0.5 shrink-0" />}
            <div className="min-w-0">
              <p className="text-[14px] font-bold" style={{ color: "var(--text)" }}>
                {kpis.needsYou
                  ? `${kpis.needsYou} ${kpis.needsYou === 1 ? "client needs" : "clients need"} your attention`
                  : "Nothing is waiting on you"}
              </p>
              <p className="text-[12px] mt-0.5" style={{ color: "var(--text-muted)" }}>
                {kpis.waitingItems > 0 && (
                  <>{kpis.waitingItems} item{kpis.waitingItems === 1 ? "" : "s"} awaiting your approval · </>
                )}
                {kpis.total - kpis.needsYou} on track
                {kpis.ready > 0 && <> · {kpis.ready} ready to close</>}
                {kpis.behind > 0 && <> · {kpis.behind} running late</>}
              </p>
            </div>
          </div>
        )}

        {/* KPI strip */}
        {!isLoading && !isError && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              { label: "Companies",      value: kpis.total,    tone: "var(--text)" },
              { label: "Ready to close", value: kpis.ready,    tone: kpis.ready ? "var(--green)" : "var(--text)" },
              { label: "Behind",         value: kpis.behind,   tone: kpis.behind ? "#9b3d37" : "var(--text)" },
              { label: "Caught up",      value: kpis.caughtUp, tone: "var(--text)" },
            ].map((k) => (
              <div key={k.label} className="rounded-xl px-4 py-3"
                style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
                <p className="text-[10px] font-semibold uppercase tracking-wider"
                  style={{ color: "var(--text-muted)" }}>
                  {k.label}
                </p>
                <p className="text-2xl font-bold mt-0.5 tabular-nums" style={{ color: k.tone }}>
                  {k.value}
                </p>
              </div>
            ))}
          </div>
        )}

        {/* Loading skeleton — three shimmer rows keep the page shape */}
        {isLoading && (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="rounded-xl h-[88px] animate-pulse"
                style={{ background: "var(--surface)", border: "1px solid var(--border)" }} />
            ))}
          </div>
        )}

        {/* Error state */}
        {isError && (
          <div className="rounded-xl px-4 py-3 flex items-center gap-3"
            style={{ background: "#f7eeec", border: "1px solid #ecd7d3", color: "#86332e" }}>
            <p className="text-sm flex-1">Couldn't load the firm view. Check your connection and retry.</p>
            <button onClick={() => refetch()}
              className="text-xs font-bold underline underline-offset-2">Retry</button>
          </div>
        )}

        {/* Company rows */}
        {!isLoading && !isError && (
          <div className="space-y-3">
            {companies.map((c, i) => {
              const f = c.focus
              const needsSetup = !c.books_set || !c.qbo_connected
              const isCurrent = c.clerk_org_id === organization?.id
              const tone = f ? daysTone(f.days_since_period_end) : null
              const reason = attentionReason(c)
              return (
                <motion.div
                  key={c.tenant_id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.18, delay: Math.min(i * 0.04, 0.3) }}
                  className="rounded-xl px-4 sm:px-5 py-4 flex items-center gap-4 flex-wrap transition-colors"
                  style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
                >
                  {/* Identity */}
                  <div className="min-w-[180px] flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-[15px] font-bold truncate" style={{ color: "var(--text)" }}>
                        {displayName(c)}
                      </p>
                      {isCurrent && (
                        <Chip label="Current" fg="var(--green)" bg="var(--green-subtle)" />
                      )}
                      {c.is_demo && (
                        <Chip label="Sample" fg="var(--text-muted)" bg="var(--surface-2)" />
                      )}
                    </div>
                    {/* WHY this company is where it is in the list. A partner
                        shouldn't have to decode a progress bar to find out. */}
                    {reason ? (
                      <p className="text-[11.5px] mt-0.5 font-medium" style={{ color: "#a5711d" }}>
                        {reason}
                      </p>
                    ) : (
                      <p className="text-[11px] mt-0.5" style={{ color: "var(--text-muted)" }}>
                        {c.closed_through
                          ? `Closed through ${c.closed_through}`
                          : needsSetup ? "Not set up yet" : "No closed months yet"}
                      </p>
                    )}
                  </div>

                  {/* Focus month + progress */}
                  <div className="w-full sm:w-[230px]">
                    {needsSetup ? (
                      <Chip
                        icon={<Plug size={10} strokeWidth={2.2} />}
                        label={!c.books_set ? "Books setup needed" : "QuickBooks disconnected"}
                        fg="#8a6326" bg="rgba(199, 154, 82, 0.12)"
                      />
                    ) : f ? (
                      <>
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-xs font-semibold" style={{ color: "var(--text)" }}>
                            {f.label}
                          </span>
                          <span className="text-[11px] tabular-nums" style={{ color: "var(--text-muted)" }}>
                            {f.status === "not_started" ? "Not started" : `${f.approved}/${f.total} approved`}
                          </span>
                        </div>
                        <ProgressBar
                          approved={f.approved} reviewed={f.reviewed}
                          flagged={f.flagged} total={Math.max(f.total, 1)}
                        />
                      </>
                    ) : (
                      <Chip
                        icon={<CheckCircle2 size={10} strokeWidth={2.2} />}
                        label="All months closed"
                        fg="var(--green)" bg="var(--green-subtle)"
                      />
                    )}
                  </div>

                  {/* Signal chips */}
                  <div className="flex items-center gap-1.5 flex-wrap min-w-[150px]">
                    {f?.status === "complete" && (
                      <Chip icon={<CheckCircle2 size={10} strokeWidth={2.2} />}
                        label="Ready to close" fg="var(--green)" bg="var(--green-subtle)" />
                    )}
                    {(c.awaiting_you?.total ?? 0) > 0 && (
                      <Chip icon={<UserCheck size={10} strokeWidth={2.2} />}
                        title="Prepared by someone else and waiting on your approval"
                        label={`${c.awaiting_you.total} waiting on you`}
                        fg="#7a4b12" bg="#fdf0dc" />
                    )}
                    {(c.risk?.high ?? 0) > 0 && (
                      <Chip icon={<ShieldAlert size={10} strokeWidth={2.2} />}
                        title="Open high-severity findings from the GL accuracy watchdog"
                        label={`${c.risk.high} high risk`} fg="#9b3d37" bg="#f7eeec" />
                    )}
                    {(f?.flagged ?? 0) > 0 && (
                      <Chip icon={<Flag size={10} strokeWidth={2.2} />}
                        label={`${f!.flagged} flagged`} fg="#9b3d37" bg="#f7eeec" />
                    )}
                    {c.flux && (
                      <Chip icon={<TrendingUp size={10} strokeWidth={2.2} />}
                        label={`Flux ${c.flux.approved}/${c.flux.total}`}
                        fg={c.flux.state === "done" ? "var(--green)" : "#3c5a76"}
                        bg={c.flux.state === "done" ? "var(--green-subtle)" : "#e9eef3"} />
                    )}
                    {!c.flux && f && (
                      <Chip icon={<TrendingUp size={10} strokeWidth={2.2} />}
                        label="Flux not run" fg="var(--text-muted)" bg="var(--surface-2)" />
                    )}
                    {c.open_adjustments > 0 && (
                      <Chip icon={<Sparkles size={10} strokeWidth={2.2} />}
                        label={`${c.open_adjustments} adjustment${c.open_adjustments === 1 ? "" : "s"}`}
                        fg="var(--text-2)" bg="var(--surface-2)" />
                    )}
                  </div>

                  {/* Days since period end + open */}
                  <div className="flex items-center gap-3 ml-auto">
                    {f && tone && (
                      <Chip
                        icon={<CalendarClock size={10} strokeWidth={2.2} />}
                        label={`${f.days_since_period_end}d`}
                        title={`${f.days_since_period_end} days since ${f.label} ended`}
                        fg={tone.fg} bg={tone.bg}
                      />
                    )}
                    <button
                      onClick={() => openCompany(c)}
                      disabled={switchingId !== null}
                      className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-opacity hover:opacity-90 disabled:opacity-50"
                      style={isCurrent
                        ? { background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }
                        : { background: "var(--green)", color: "white" }}
                    >
                      {switchingId === c.tenant_id
                        ? <Spinner className="h-3 w-3" />
                        : <ArrowRight size={12} strokeWidth={2.2} />}
                      Open
                    </button>
                  </div>
                </motion.div>
              )
            })}

            {/* Add-company affordance */}
            <button
              onClick={() => navigate("/app/companies/new")}
              className="w-full rounded-xl px-5 py-4 flex items-center justify-center gap-2 text-sm font-semibold transition-colors hover:bg-[var(--surface)]"
              style={{ border: "1.5px dashed var(--border-strong)", color: "var(--text-muted)" }}
            >
              <Plus size={14} strokeWidth={2.2} />
              Add another company
            </button>

            {companies.length === 0 && (
              <div className="rounded-xl px-6 py-10 text-center"
                style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
                <Building2 size={22} strokeWidth={1.6} className="mx-auto mb-2"
                  style={{ color: "var(--text-muted)" }} />
                <p className="text-sm font-semibold" style={{ color: "var(--text)" }}>
                  No companies yet
                </p>
                <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
                  Create your first workspace and its close will show up here.
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
