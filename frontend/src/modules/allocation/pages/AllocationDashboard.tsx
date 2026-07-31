/**
 * AllocationDashboard — where a §471(c) client stands right now.
 *
 * Scoped to the ACTIVE client, not a multi-client roster. A practice-wide roster
 * needs a cross-tenant read and belongs with the firm Command Center pattern;
 * showing a placeholder roster here would be worse than showing real data for
 * the client actually selected.
 *
 * The page answers three questions in order: is this client ready, what did the
 * last run conclude, and what do I do next.
 */
import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import {
  AlertTriangle, ArrowRight, CalendarDays, CheckCircle2, Play, Settings2, XCircle,
} from "lucide-react"
import { Spinner } from "@/core/ui"
import { allocationApi, factorPct, money } from "../api"
import { MonthPicker, defaultPeriodEnd } from "../components/MonthPicker"

export function AllocationDashboard() {
  const [periodEnd, setPeriodEnd] = useState(defaultPeriodEnd)

  const { data: readiness, isLoading: loadingReadiness } = useQuery({
    queryKey: ["allocation", "readiness", periodEnd],
    queryFn:  () => allocationApi.getReadiness(periodEnd),
  })
  const { data: runs = [], isLoading: loadingRuns } = useQuery({
    queryKey: ["allocation", "runs"],
    queryFn:  allocationApi.listRuns,
  })

  const current = runs.find((r) => r.period_end === periodEnd && r.status !== "superseded")

  const Kpi = ({ label, value, tone }: { label: string; value: string; tone?: string }) => (
    <div className="rounded-lg px-3.5 py-3"
      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>{label}</div>
      <div className="text-lg font-semibold tabular-nums mt-0.5" style={{ color: tone ?? "var(--text)" }}>
        {value}
      </div>
    </div>
  )

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-5xl mx-auto px-5 py-6 space-y-5">

        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-lg font-semibold text-theme tracking-tight">Cost allocation</h1>
            <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
              §471(c) inventory costing for the active client
            </p>
          </div>
          <div className="flex items-center gap-2">
            <CalendarDays size={14} strokeWidth={1.8} style={{ color: "var(--text-muted)" }} />
            <MonthPicker value={periodEnd} onChange={setPeriodEnd} />
          </div>
        </div>

        {/* Status */}
        <div className="rounded-xl p-4"
          style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
          {loadingReadiness ? (
            <div className="flex items-center gap-2 text-xs" style={{ color: "var(--text-muted)" }}>
              <Spinner className="h-4 w-4" /> Checking this client…
            </div>
          ) : !readiness ? (
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>Couldn&rsquo;t load status.</p>
          ) : (
            <>
              <div className="flex items-center gap-2">
                {readiness.ready
                  ? <CheckCircle2 size={17} strokeWidth={2} style={{ color: "var(--positive)" }} />
                  : <XCircle size={17} strokeWidth={2} style={{ color: "var(--danger)" }} />}
                <span className="text-sm font-semibold text-theme">
                  {readiness.ready ? "Ready to run" : "Setup incomplete"}
                </span>
              </div>
              {readiness.blockers.length > 0 && (
                <ul className="mt-2.5 space-y-1">
                  {readiness.blockers.map((b) => (
                    <li key={b.code} className="text-xs" style={{ color: "var(--text-2)" }}>{b.message}</li>
                  ))}
                </ul>
              )}
              {readiness.warnings.map((w) => (
                <p key={w.code} className="mt-2 flex items-start gap-1.5 text-xs" style={{ color: "var(--text-2)" }}>
                  <AlertTriangle size={12} strokeWidth={2} className="mt-[3px] shrink-0"
                    style={{ color: "var(--warn)" }} />
                  {w.message}
                </p>
              ))}

              <div className="flex flex-wrap gap-2 mt-3.5">
                <Link to="/allocation/runs"
                  className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-medium"
                  style={{ background: "var(--green)", color: "#fff" }}>
                  <Play size={13} strokeWidth={2} /> Go to runs
                </Link>
                <Link to="/allocation/setup"
                  className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-medium"
                  style={{ color: "var(--text-2)", border: "1px solid var(--border)" }}>
                  <Settings2 size={13} strokeWidth={2} /> Setup
                </Link>
              </div>
            </>
          )}
        </div>

        {/* This month's conclusion */}
        {current && !current.blocked_reason && (
          <div className="space-y-2.5">
            <h2 className="text-[13px] font-semibold text-theme">
              {new Date(periodEnd + "T00:00:00").toLocaleDateString("en-US", { month: "long", year: "numeric" })} allocation
            </h2>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
              <Kpi label="Total expenses" value={money(current.total_expenses)} />
              <Kpi label="Capitalized" value={money(current.capitalized_total)} tone="var(--green)" />
              <Kpi label="Disallowed (280E)" value={money(current.disallowed_total)} tone="var(--danger)" />
              <Kpi label="Occupancy factor" value={factorPct(current.occupancy_factor)} />
            </div>
            <Link to="/allocation/runs"
              className="inline-flex items-center gap-1 text-xs font-medium"
              style={{ color: "var(--green)" }}>
              Open the workpaper and journal entry <ArrowRight size={12} strokeWidth={2} />
            </Link>
          </div>
        )}

        {/* Recent runs */}
        <div>
          <h2 className="text-[13px] font-semibold text-theme mb-2">Recent runs</h2>
          {loadingRuns ? (
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
                  className="grid grid-cols-[minmax(0,1.2fr)_1fr_1fr_auto] gap-3 items-center px-4 py-2.5"
                  style={{ borderTop: i === 0 ? undefined : "1px solid var(--border)" }}>
                  <span className="text-[13px] text-theme">
                    {new Date(r.period_end + "T00:00:00").toLocaleDateString("en-US", {
                      month: "short", year: "numeric",
                    })}
                  </span>
                  <span className="text-[12px] tabular-nums text-right" style={{ color: "var(--text-2)" }}>
                    {money(r.capitalized_total)}
                  </span>
                  <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                    {r.blocked_reason ? "blocked" : r.has_journal_entry ? "JE ready" : "no JE"}
                  </span>
                  <span className="text-[11px] justify-self-end" style={{ color: "var(--text-muted)" }}>
                    {r.status.replace("_", " ")}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
