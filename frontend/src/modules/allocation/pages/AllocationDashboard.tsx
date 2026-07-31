/**
 * AllocationDashboard — the practice roster, and the landing screen for
 * Nordavix Allocate.
 *
 * One row per cannabis client for the selected month: eligibility, whether the
 * allocation drivers are current, what capitalized, and where the run stands.
 *
 * S0 SCOPE: this is the shell. The roster endpoint is S4 (it reads across
 * tenants via get_system_db, the same pattern the close app's Command Center
 * uses), and the allocation engine that produces the numbers is S2. Until then
 * this deliberately renders an empty state rather than placeholder figures —
 * fabricated dollar amounts on an accounting surface are worse than no amounts.
 */
import { useMemo, useState } from "react"
import { Building2, CalendarDays, ChevronLeft, ChevronRight } from "lucide-react"

interface Kpi {
  label: string
  value: string
  tone?: "default" | "positive" | "danger"
}

function monthLabel(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" })
}

export function AllocationDashboard() {
  // Default to the prior calendar month — the one a practice is actually
  // working. Built from local date parts (never toISOString, which shifts the
  // month in any timezone behind UTC).
  const [anchor, setAnchor] = useState(() => {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth() - 1, 1)
  })

  const kpis: Kpi[] = useMemo(() => [
    { label: "Clients",   value: "—" },
    { label: "Approved",  value: "—", tone: "positive" },
    { label: "In review", value: "—" },
    { label: "Blocked",   value: "—", tone: "danger" },
  ], [])

  const shiftMonth = (delta: number) =>
    setAnchor((d) => new Date(d.getFullYear(), d.getMonth() + delta, 1))

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-6xl mx-auto px-5 py-6 space-y-5">

        {/* Header */}
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-lg font-semibold text-theme tracking-tight">Clients</h1>
            <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
              §471(c) cost allocation · one run per client per month
            </p>
          </div>

          {/* Period stepper */}
          <div
            className="flex items-center gap-1 rounded-lg px-1 py-1"
            style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
          >
            <button
              onClick={() => shiftMonth(-1)}
              className="flex items-center justify-center h-7 w-7 rounded-md transition-colors"
              style={{ color: "var(--text-2)" }}
              aria-label="Previous month"
            >
              <ChevronLeft size={15} strokeWidth={1.8} />
            </button>
            <span className="flex items-center gap-1.5 px-2 text-[13px] font-medium text-theme whitespace-nowrap">
              <CalendarDays size={14} strokeWidth={1.8} style={{ color: "var(--text-muted)" }} />
              {monthLabel(anchor)}
            </span>
            <button
              onClick={() => shiftMonth(1)}
              className="flex items-center justify-center h-7 w-7 rounded-md transition-colors"
              style={{ color: "var(--text-2)" }}
              aria-label="Next month"
            >
              <ChevronRight size={15} strokeWidth={1.8} />
            </button>
          </div>
        </div>

        {/* KPI strip */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
          {kpis.map((k) => (
            <div
              key={k.label}
              className="rounded-lg px-3.5 py-3"
              style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
            >
              <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>{k.label}</div>
              <div
                className="text-xl font-semibold tabular-nums mt-0.5"
                style={{
                  color:
                    k.tone === "positive" ? "var(--positive)"
                    : k.tone === "danger" ? "var(--danger)"
                    : "var(--text)",
                }}
              >
                {k.value}
              </div>
            </div>
          ))}
        </div>

        {/* Roster */}
        <div className="rounded-xl overflow-hidden" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
          <div
            className="grid grid-cols-[minmax(0,2fr)_1fr_1fr_0.7fr_1fr] gap-3 px-4 py-2.5 text-[11px]"
            style={{ color: "var(--text-muted)", borderBottom: "1px solid var(--border)" }}
          >
            <span>Client</span>
            <span>Drivers</span>
            <span className="text-right">Capitalized</span>
            <span className="text-right">Rate</span>
            <span className="text-right">Status</span>
          </div>

          <div className="px-6 py-14 flex flex-col items-center text-center">
            <div
              className="h-11 w-11 rounded-full flex items-center justify-center mb-3"
              style={{ background: "var(--green-subtle)" }}
            >
              <Building2 size={19} strokeWidth={1.7} style={{ color: "var(--green)" }} />
            </div>
            <p className="text-sm font-medium text-theme">No clients set up for allocation yet</p>
            <p className="text-xs mt-1.5 max-w-md leading-relaxed" style={{ color: "var(--text-muted)" }}>
              A client becomes eligible for a monthly run once three things exist: its
              square-footage registry, its employee classifications, and its
              account&rarr;pool map. Those live under Setup.
            </p>
          </div>
        </div>

      </div>
    </div>
  )
}
