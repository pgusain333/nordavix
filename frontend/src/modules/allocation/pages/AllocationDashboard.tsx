/**
 * AllocationDashboard — where a §471(c) client stands right now.
 *
 * Scoped to the ACTIVE client, not a multi-client roster. A practice-wide roster
 * needs a cross-tenant read and belongs with the firm Command Center pattern;
 * showing a placeholder roster here would be worse than showing real data for
 * the client actually selected.
 *
 * The page answers, in order: whose books are these, what is the ONE next thing
 * to do, how is setup progressing, what did this month conclude, and where does
 * the tax year stand. The next action is computed rather than listed, because a
 * dashboard that offers six equally-weighted links is a dashboard that has
 * declined to answer the question.
 */
import { useOrganization } from "@clerk/clerk-react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import {
  AlertTriangle, ArrowRight, CalendarCheck2, CalendarDays, CheckCircle2, Circle,
  FileDown, Play, Receipt, Scale, XCircle,
} from "lucide-react"
import { Spinner } from "@/core/ui"
import { allocationApi, factorPct, money, type Readiness } from "../api"
import { MonthPicker, useAllocationPeriod } from "../components/MonthPicker"
import { routeForFix } from "../components/ReadinessRail"

/** "2026-03-31" → "March 2026". Split, never Date-parsed — a UTC parse shifts
 *  the month in every timezone behind UTC and would label the wrong period. */
function monthName(iso: string): string {
  const [y, m] = iso.split("-")
  const MONTHS = ["January", "February", "March", "April", "May", "June",
                  "July", "August", "September", "October", "November", "December"]
  return `${MONTHS[Number(m) - 1] ?? m} ${y}`
}

function shortMonth(iso: string): string {
  const [y, m] = iso.split("-")
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  return `${MONTHS[Number(m) - 1] ?? m} ${y}`
}

export function AllocationDashboard() {
  const [periodEnd, setPeriodEnd] = useAllocationPeriod()
  // Which client this is. Every figure on the page belongs to one company, and
  // running the wrong client's allocation is an easy mistake to make when the
  // screen never says whose numbers these are.
  const { organization } = useOrganization()

  const { data: readiness, isLoading: loadingReadiness } = useQuery({
    queryKey: ["allocation", "readiness", periodEnd],
    queryFn:  () => allocationApi.getReadiness(periodEnd),
  })
  const { data: runs = [], isLoading: loadingRuns } = useQuery({
    queryKey: ["allocation", "runs"],
    queryFn:  allocationApi.listRuns,
  })
  const { data: years } = useQuery({
    queryKey: ["allocation", "tax-years"],
    queryFn:  allocationApi.listTaxYears,
    staleTime: 60_000,
  })
  const taxYear = years?.years?.[0] ?? null
  const { data: annual } = useQuery({
    queryKey: ["allocation", "annual", taxYear],
    queryFn:  () => allocationApi.getAnnual(taxYear!),
    enabled:  taxYear !== null,
  })

  const current = runs.find((r) => r.period_end === periodEnd && r.status !== "superseded")

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[1180px] mx-auto px-5 py-6 space-y-5">

        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-lg font-semibold text-theme tracking-tight">
              {organization?.name ?? "Cost allocation"}
            </h1>
            <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
              §471(c) cost allocation{organization?.name ? "" : " — no client selected"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <CalendarDays size={14} strokeWidth={1.8} style={{ color: "var(--text-muted)" }} />
            <MonthPicker value={periodEnd} onChange={setPeriodEnd} />
          </div>
        </div>

        {/* Setup progress leads. The five steps ARE the product's shape, so the
            page opens by showing where this client is in it; the detail of
            what's blocking sits directly underneath rather than above. */}
        {readiness && <SetupProgress readiness={readiness} />}

        {loadingReadiness ? (
          <div className="rounded-xl px-4 py-5 flex items-center gap-2 text-xs"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text-muted)" }}>
            <Spinner className="h-4 w-4" /> Checking this client…
          </div>
        ) : !readiness ? (
          <div className="rounded-xl px-4 py-5"
            style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>Couldn&rsquo;t load status.</p>
          </div>
        ) : (
          <NextAction readiness={readiness} periodEnd={periodEnd} hasRun={!!current && !current.blocked_reason} />
        )}

        {/* This month's conclusion */}
        {current && !current.blocked_reason && (
          <div className="space-y-2.5">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-[13px] font-semibold text-theme">{monthName(periodEnd)}</h2>
              <Link to="/allocation/runs" className="inline-flex items-center gap-1 text-[11.5px] font-medium"
                style={{ color: "var(--green)" }}>
                Workpaper and journal entry <ArrowRight size={11} strokeWidth={2} />
              </Link>
            </div>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
              <Kpi label="Total expenses" value={money(current.total_expenses)} />
              <Kpi label="Capitalized" value={money(current.capitalized_total)} tone="var(--green)" />
              <Kpi label="Disallowed (§280E)" value={money(current.disallowed_total)} tone="var(--danger)" />
              <Kpi label="Payroll / occupancy"
                value={`${factorPct(current.payroll_factor, 1)} · ${factorPct(current.occupancy_factor, 1)}`} />
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4 items-start">
          <RecentRuns runs={runs} loading={loadingRuns} />
          {annual && <YearToDate annual={annual} />}
        </div>
      </div>
    </div>
  )
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg px-3.5 py-3"
      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>{label}</div>
      <div className="text-lg font-semibold tabular-nums mt-0.5" style={{ color: tone ?? "var(--text)" }}>
        {value}
      </div>
    </div>
  )
}

// ── The one next thing ────────────────────────────────────────────────────────

function NextAction({ readiness, periodEnd, hasRun }: {
  readiness: Readiness; periodEnd: string; hasRun: boolean
}) {
  // Blocked wins over everything: nothing downstream is possible.
  if (!readiness.ready) {
    const first = readiness.blockers[0]
    return (
      <div className="rounded-xl p-4"
        style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
        <div className="flex items-center gap-2">
          <XCircle size={17} strokeWidth={2} style={{ color: "var(--danger)" }} />
          <span className="text-sm font-semibold text-theme">
            Setup incomplete for {monthName(periodEnd)}
          </span>
        </div>
        <ul className="mt-2.5 space-y-1.5">
          {readiness.blockers.map((b) => (
            <li key={b.code}>
              <Link to={routeForFix(b.fix)}
                className="flex items-start gap-2 text-xs hover:opacity-75 transition-opacity"
                style={{ color: "var(--text-2)" }}>
                <XCircle size={12} strokeWidth={2} className="mt-[3px] shrink-0"
                  style={{ color: "var(--danger)" }} />
                <span>
                  {b.message}
                  <span className="inline-flex items-center gap-0.5 ml-1 font-medium whitespace-nowrap"
                    style={{ color: "var(--green)" }}>
                    Fix <ArrowRight size={10} strokeWidth={2.2} />
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
        {first && (
          <Link to={routeForFix(first.fix)}
            className="mt-3.5 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-medium"
            style={{ background: "var(--green)", color: "#fff" }}>
            Start with the first <ArrowRight size={13} strokeWidth={2} />
          </Link>
        )}
      </div>
    )
  }

  return (
    <div className="rounded-xl p-4"
      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <div className="flex items-center gap-2">
        <CheckCircle2 size={17} strokeWidth={2} style={{ color: "var(--positive)" }} />
        <span className="text-sm font-semibold text-theme">
          {hasRun ? `${monthName(periodEnd)} is allocated` : `Ready to run ${monthName(periodEnd)}`}
        </span>
      </div>
      <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
        {hasRun
          ? "Review the workpaper, then export the reclass entry to QuickBooks."
          : "Every driver this client's pools need is on file for this period."}
      </p>

      {readiness.warnings.map((w) => (
        <Link key={w.code} to={routeForFix(w.fix)}
          className="mt-2 flex items-start gap-1.5 text-xs hover:opacity-75 transition-opacity"
          style={{ color: "var(--text-2)" }}>
          <AlertTriangle size={12} strokeWidth={2} className="mt-[3px] shrink-0"
            style={{ color: "var(--warn)" }} />
          {w.message}
        </Link>
      ))}

      <div className="flex flex-wrap gap-2 mt-3.5">
        <Link to="/allocation/runs"
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-medium"
          style={{ background: "var(--green)", color: "#fff" }}>
          {hasRun ? <><FileDown size={13} strokeWidth={2} /> Open the run</>
                  : <><Play size={13} strokeWidth={2} /> Run {shortMonth(periodEnd)}</>}
        </Link>
        <Link to="/allocation/payroll"
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-medium"
          style={{ color: "var(--text-2)", border: "1px solid var(--border)" }}>
          <Receipt size={13} strokeWidth={2} /> Payroll register
        </Link>
      </div>
    </div>
  )
}

// ── Setup progress ────────────────────────────────────────────────────────────

/**
 * Setup is a sequence now, so show where in it this client is. Derived from the
 * same readiness payload the rail uses — one source of truth, so this can't
 * disagree with the screen it links to.
 */
function SetupProgress({ readiness }: { readiness: Readiness }) {
  const blocked = new Set(readiness.blockers.map((b) => routeForFix(b.fix)))
  const warned = new Set(readiness.warnings.map((w) => routeForFix(w.fix)))

  const STEPS = [
    { label: "Eligibility", to: "/allocation/eligibility", icon: Scale,
      detail: readiness.blockers.some((b) => b.code === "not_eligible")
        ? "Not a small business taxpayer" : "§448(c) test" },
    { label: "Cost pools", to: "/allocation/pools", icon: Circle,
      detail: `${readiness.counts.pools} configured` },
    { label: "Accounts", to: "/allocation/accounts", icon: Circle,
      detail: `${readiness.counts.mapped_accounts} mapped` },
    { label: "Spaces", to: "/allocation/spaces", icon: Circle,
      detail: readiness.requires.occupancy
        ? `${readiness.counts.spaces} on file` : "Not required" },
    { label: "Employees", to: "/allocation/employees", icon: Circle,
      detail: readiness.requires.payroll
        ? `${readiness.counts.employees} classified` : "Not required" },
  ]

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5">
      {STEPS.map((s) => {
        const isBlocked = blocked.has(s.to)
        const isWarned = !isBlocked && warned.has(s.to)
        return (
          <Link key={s.to} to={s.to}
            className="rounded-lg px-3 py-2.5 transition-opacity hover:opacity-80"
            style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
            <div className="flex items-center gap-1.5">
              {isBlocked
                ? <XCircle size={12} strokeWidth={2.2} style={{ color: "var(--danger)" }} />
                : isWarned
                  ? <AlertTriangle size={12} strokeWidth={2.2} style={{ color: "var(--warn)" }} />
                  : <CheckCircle2 size={12} strokeWidth={2.2} style={{ color: "var(--positive)" }} />}
              <span className="text-[12px] font-medium text-theme truncate">{s.label}</span>
            </div>
            <div className="text-[10.5px] mt-0.5 truncate" style={{ color: "var(--text-muted)" }}>
              {s.detail}
            </div>
          </Link>
        )
      })}
    </div>
  )
}

// ── Recent runs ───────────────────────────────────────────────────────────────

function RecentRuns({ runs, loading }: {
  runs: Awaited<ReturnType<typeof allocationApi.listRuns>>; loading: boolean
}) {
  return (
    <div>
      <h2 className="text-[13px] font-semibold text-theme mb-2">Recent runs</h2>
      {loading ? (
        <div className="flex justify-center py-8"><Spinner className="h-5 w-5" /></div>
      ) : runs.length === 0 ? (
        <div className="rounded-xl px-6 py-10 text-center"
          style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
          <p className="text-sm font-medium text-theme">No allocations yet</p>
          <p className="text-xs mt-1 max-w-sm mx-auto" style={{ color: "var(--text-muted)" }}>
            Finish setup, then run a month. Each run produces a workpaper and a
            reclass journal entry you can export to QuickBooks.
          </p>
        </div>
      ) : (
        <div className="rounded-xl overflow-hidden"
          style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
          {runs.slice(0, 6).map((r, i) => (
            <Link key={r.id} to="/allocation/runs"
              className="grid grid-cols-[minmax(0,1.1fr)_1fr_auto_auto] gap-3 items-center px-4 py-2.5 hover:opacity-80 transition-opacity"
              style={{ borderTop: i === 0 ? undefined : "1px solid var(--border)" }}>
              <span className="text-[13px] text-theme">{shortMonth(r.period_end)}</span>
              <span className="text-[12px] tabular-nums text-right" style={{ color: "var(--text-2)" }}>
                {money(r.capitalized_total)}
              </span>
              <span className="text-[11px] justify-self-end whitespace-nowrap"
                style={{ color: r.posted_at ? "var(--positive)" : "var(--text-muted)" }}>
                {r.blocked_reason ? "blocked"
                  : r.posted_at ? "posted"
                  : r.has_journal_entry ? "JE ready" : "no JE"}
              </span>
              <span className="text-[11px] justify-self-end whitespace-nowrap"
                style={{ color: "var(--text-muted)" }}>
                {r.status.replace("_", " ")}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Where the tax year stands ─────────────────────────────────────────────────

function YearToDate({ annual }: { annual: NonNullable<Awaited<ReturnType<typeof allocationApi.getAnnual>>> }) {
  const c = annual.checklist
  const outstanding =
    c.missing_periods.length + c.unapproved_periods.length +
    c.unposted_periods.length + c.inventory_breaks.length

  return (
    <div className="rounded-xl overflow-hidden"
      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <div className="px-4 py-3 flex items-center gap-2" style={{ borderBottom: "1px solid var(--border)" }}>
        <CalendarCheck2 size={14} strokeWidth={1.9} style={{ color: "var(--text-muted)" }} />
        <h2 className="text-[13px] font-semibold text-theme">Tax year {annual.tax_year}</h2>
      </div>
      <div className="px-4 py-3 space-y-1.5">
        <Row label="Months allocated" value={`${c.months_present} of ${c.months_expected}`} />
        <Row label="Capitalized" value={money(annual.totals.capitalized)} />
        <Row label="Disallowed (§280E)" value={money(annual.totals.disallowed)} />
        {annual.roll_forward && (
          <Row label="Cost of goods sold" value={money(annual.roll_forward.cogs)} strong />
        )}
      </div>
      <Link to="/allocation/year-end"
        className="flex items-center justify-between gap-2 px-4 py-2.5 hover:opacity-80 transition-opacity"
        style={{ borderTop: "1px solid var(--border)" }}>
        <span className="text-[11.5px]" style={{ color: annual.complete ? "var(--positive)" : "var(--warn)" }}>
          {annual.complete
            ? "Complete — ready to file"
            : `${outstanding} thing${outstanding === 1 ? "" : "s"} outstanding`}
        </span>
        <ArrowRight size={12} strokeWidth={2} style={{ color: "var(--green)" }} />
      </Link>
    </div>
  )
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[11.5px]" style={{ color: "var(--text-muted)" }}>{label}</span>
      <span className={`tabular-nums ${strong ? "text-[13px] font-semibold text-theme" : "text-[12px]"}`}
        style={strong ? undefined : { color: "var(--text-2)" }}>{value}</span>
    </div>
  )
}
