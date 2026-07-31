/**
 * AllocationSetup — everything a client needs before an allocation can run.
 *
 * The readiness checklist leads, because the question a preparer actually has
 * is "why can't I run this client", and the answer should be one glance rather
 * than four screens of hunting. Blockers stop a run; warnings don't, but they
 * are the things that weaken an allocation on examination.
 *
 * Tabs below it maintain the three registries plus the pools that drive them.
 */
import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  AlertTriangle, Building2, CalendarDays, CheckCircle2, ChevronLeft, ChevronRight,
  Layers, ListTree, Users, XCircle,
} from "lucide-react"
import { toISODate } from "@/core/lib/dates"
import { Spinner } from "@/core/ui"
import { allocationApi } from "../api"
import { PoolsPanel } from "../components/PoolsPanel"
import { AccountsPanel } from "../components/AccountsPanel"
import { SpacesPanel } from "../components/SpacesPanel"
import { EmployeesPanel } from "../components/EmployeesPanel"

type TabId = "pools" | "accounts" | "spaces" | "employees"

const TABS: { id: TabId; label: string; icon: typeof Layers }[] = [
  { id: "pools",     label: "Pools",     icon: Layers },
  { id: "accounts",  label: "Accounts",  icon: ListTree },
  { id: "spaces",    label: "Spaces",    icon: Building2 },
  { id: "employees", label: "Employees", icon: Users },
]

export function AllocationSetup() {
  // Declared before the queries whose option closures read them.
  const [anchor, setAnchor] = useState(() => {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth() - 1, 1)
  })
  const [tab, setTab] = useState<TabId>("pools")

  // Local calendar dates — never toISOString(), which shifts the month in any
  // timezone behind UTC and would silently allocate the wrong period.
  const { periodStart, periodEnd } = useMemo(() => ({
    periodStart: toISODate(new Date(anchor.getFullYear(), anchor.getMonth(), 1)),
    periodEnd:   toISODate(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0)),
  }), [anchor])

  const { data: readiness, isLoading } = useQuery({
    queryKey: ["allocation", "readiness", periodEnd],
    queryFn:  () => allocationApi.getReadiness(periodEnd),
    staleTime: 15_000,
  })

  const shiftMonth = (d: number) =>
    setAnchor((a) => new Date(a.getFullYear(), a.getMonth() + d, 1))

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-5xl mx-auto px-5 py-6 space-y-5">

        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-lg font-semibold text-theme tracking-tight">Setup</h1>
            <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
              Pools, account mapping, square footage and employee classifications
            </p>
          </div>
          <div className="flex items-center gap-1 rounded-lg px-1 py-1"
            style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
            <button onClick={() => shiftMonth(-1)} aria-label="Previous month"
              className="flex items-center justify-center h-7 w-7 rounded-md"
              style={{ color: "var(--text-2)" }}>
              <ChevronLeft size={15} strokeWidth={1.8} />
            </button>
            <span className="flex items-center gap-1.5 px-2 text-[13px] font-medium text-theme whitespace-nowrap">
              <CalendarDays size={14} strokeWidth={1.8} style={{ color: "var(--text-muted)" }} />
              {anchor.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
            </span>
            <button onClick={() => shiftMonth(1)} aria-label="Next month"
              className="flex items-center justify-center h-7 w-7 rounded-md"
              style={{ color: "var(--text-2)" }}>
              <ChevronRight size={15} strokeWidth={1.8} />
            </button>
          </div>
        </div>

        {/* Readiness */}
        <div className="rounded-xl p-4"
          style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
          {isLoading ? (
            <div className="flex items-center gap-2 text-xs" style={{ color: "var(--text-muted)" }}>
              <Spinner className="h-4 w-4" /> Checking readiness…
            </div>
          ) : readiness ? (
            <>
              <div className="flex items-center gap-2">
                {readiness.ready
                  ? <CheckCircle2 size={17} strokeWidth={2} style={{ color: "var(--positive)" }} />
                  : <XCircle size={17} strokeWidth={2} style={{ color: "var(--danger)" }} />}
                <span className="text-sm font-semibold text-theme">
                  {readiness.ready ? "Ready to run" : "Not ready to run"}
                </span>
              </div>

              {readiness.blockers.length > 0 && (
                <ul className="mt-3 space-y-1.5">
                  {readiness.blockers.map((b) => (
                    <li key={b.code} className="flex items-start gap-2 text-xs" style={{ color: "var(--text)" }}>
                      <XCircle size={13} strokeWidth={2} className="mt-[2px] shrink-0"
                        style={{ color: "var(--danger)" }} />
                      {b.message}
                    </li>
                  ))}
                </ul>
              )}
              {readiness.warnings.length > 0 && (
                <ul className="mt-2 space-y-1.5">
                  {readiness.warnings.map((w) => (
                    <li key={w.code} className="flex items-start gap-2 text-xs" style={{ color: "var(--text-2)" }}>
                      <AlertTriangle size={13} strokeWidth={2} className="mt-[2px] shrink-0"
                        style={{ color: "var(--warn)" }} />
                      {w.message}
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-3.5 pt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-[11px]"
                style={{ borderTop: "1px solid var(--border)", color: "var(--text-muted)" }}>
                <span>{readiness.counts.pools} pools</span>
                <span>{readiness.counts.mapped_accounts} accounts mapped</span>
                <span>
                  {readiness.counts.spaces} spaces
                  {readiness.requires.occupancy ? "" : " (not required)"}
                </span>
                <span>
                  {readiness.counts.employees} employees
                  {readiness.requires.payroll ? "" : " (not required)"}
                </span>
              </div>
            </>
          ) : (
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              Couldn&rsquo;t load readiness.
            </p>
          )}
        </div>

        {/* Tabs */}
        <div className="flex flex-wrap gap-1.5">
          {TABS.map((t) => {
            const Icon = t.icon
            const active = tab === t.id
            return (
              <button key={t.id} onClick={() => setTab(t.id)}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition-colors"
                style={active
                  ? { background: "var(--green)", color: "#fff", border: "1px solid var(--green)" }
                  : { background: "var(--surface)", color: "var(--text-2)", border: "1px solid var(--border)" }}
              >
                <Icon size={14} strokeWidth={1.9} /> {t.label}
              </button>
            )
          })}
        </div>

        {tab === "pools"     && <PoolsPanel />}
        {tab === "accounts"  && <AccountsPanel periodStart={periodStart} periodEnd={periodEnd} />}
        {tab === "spaces"    && <SpacesPanel />}
        {tab === "employees" && <EmployeesPanel />}
      </div>
    </div>
  )
}
