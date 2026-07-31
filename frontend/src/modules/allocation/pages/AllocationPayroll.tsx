/**
 * AllocationPayroll — the payroll register, on its own screen.
 *
 * Promoted out of Setup because it isn't setup: setup is done once, the register
 * is imported EVERY month. Burying a recurring task inside a configuration
 * screen made it feel optional and hard to find.
 *
 * The screen always leads with what's already imported for the period, read
 * back from the server. Previously an import cleared the preview and returned
 * the panel to its empty state, so a successful import looked identical to one
 * that never happened — the single most confusing thing about the flow.
 */
import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  AlertTriangle, CalendarDays, CheckCircle2, RefreshCw, Trash2, Users,
} from "lucide-react"
import { Button, Spinner } from "@/core/ui"
import { allocationApi, factorPct, money } from "../api"
import { MonthPicker, monthRange, useAllocationPeriod } from "../components/MonthPicker"
import { PayrollPanel } from "../components/PayrollPanel"

export function AllocationPayroll() {
  const [periodEnd, setPeriodEnd] = useAllocationPeriod()
  const { periodStart } = useMemo(() => monthRange(periodEnd), [periodEnd])
  const qc = useQueryClient()

  const { data: status, isLoading } = useQuery({
    queryKey: ["allocation", "payroll-status", periodEnd],
    queryFn:  () => allocationApi.getPayrollStatus(periodEnd),
    staleTime: 10_000,
  })

  const clear = useMutation({
    mutationFn: () => allocationApi.clearPayroll(periodEnd),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["allocation", "payroll-status"] })
      qc.invalidateQueries({ queryKey: ["allocation", "readiness"] })
    },
  })

  const monthLabel = new Date(periodEnd + "T00:00:00")
    .toLocaleDateString("en-US", { month: "long", year: "numeric" })

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-5xl mx-auto px-5 py-6 space-y-5">

        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-lg font-semibold text-theme tracking-tight">Payroll register</h1>
            <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
              Imported every month — it drives the payroll factor and builds the roster
            </p>
          </div>
          <div className="flex items-center gap-2">
            <CalendarDays size={14} strokeWidth={1.8} style={{ color: "var(--text-muted)" }} />
            <MonthPicker value={periodEnd} onChange={setPeriodEnd} />
          </div>
        </div>

        {/* Standing state for the period — the thing that was missing. */}
        {isLoading ? (
          <div className="rounded-xl px-4 py-8 flex justify-center"
            style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
            <Spinner className="h-5 w-5" />
          </div>
        ) : status?.imported ? (
          <div className="rounded-xl overflow-hidden ndvx-fade-in"
            style={{ background: "var(--surface)", border: "1px solid var(--green)" }}>
            <div className="px-4 py-3 flex items-start justify-between gap-3 flex-wrap"
              style={{ borderBottom: "1px solid var(--border)" }}>
              <div className="flex items-start gap-2.5 min-w-0">
                <CheckCircle2 size={17} strokeWidth={2} style={{ color: "var(--positive)" }}
                  className="mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-theme">
                    Register imported for {monthLabel}
                  </p>
                  <p className="text-[11px] mt-0.5" style={{ color: "var(--text-muted)" }}>
                    {status.people} {status.people === 1 ? "person" : "people"}
                    {status.imported_at && ` · last updated ${
                      new Date(status.imported_at).toLocaleString("en-US", {
                        month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
                      })
                    }`}
                  </p>
                </div>
              </div>
              <Button variant="outline" onClick={() => clear.mutate()} loading={clear.isPending}
                icon={<Trash2 size={14} strokeWidth={1.8} />}>
                Clear and re-import
              </Button>
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-px" style={{ background: "var(--border)" }}>
              {[
                { label: "People", value: String(status.people) },
                { label: "Total labor cost", value: money(status.total_labor) },
                { label: "Counts as production", value: money(status.production_labor), tone: "var(--green)" },
                { label: "Payroll factor", value: factorPct(status.payroll_factor), tone: "var(--green)" },
              ].map((k) => (
                <div key={k.label} className="px-4 py-3" style={{ background: "var(--surface)" }}>
                  <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>{k.label}</div>
                  <div className="text-base font-semibold tabular-nums mt-0.5"
                    style={{ color: k.tone ?? "var(--text)" }}>{k.value}</div>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-[minmax(0,1.5fr)_minmax(0,1.1fr)_1fr_auto] gap-3 px-4 py-2 text-[11px]"
              style={{ color: "var(--text-muted)", borderTop: "1px solid var(--border)",
                       borderBottom: "1px solid var(--border)" }}>
              <span>Employee</span><span>Department</span>
              <span className="text-right">Labor cost</span>
              <span className="text-right">Production</span>
            </div>
            {status.rows.map((r, i) => (
              <div key={r.employee_id}
                className="grid grid-cols-[minmax(0,1.5fr)_minmax(0,1.1fr)_1fr_auto] gap-3 items-center px-4 py-2 text-[13px]"
                style={{ borderTop: i === 0 ? undefined : "1px solid var(--border)" }}>
                <span className="truncate text-theme">{r.name}</span>
                <span className="truncate text-[11.5px]" style={{ color: "var(--text-2)" }}>
                  {r.department ?? r.job_title ?? "—"}
                </span>
                <span className="text-right tabular-nums" style={{ color: "var(--text-2)" }}>
                  {money(r.labor_cost)}
                </span>
                <span className="text-right tabular-nums text-[12px] justify-self-end"
                  style={{ color: Number(r.production_pct) > 0 ? "var(--green)" : "var(--text-muted)" }}>
                  {Number(r.production_pct).toFixed(0)}%
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-xl px-4 py-3 flex items-start gap-2.5"
            style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
            <AlertTriangle size={15} strokeWidth={2} style={{ color: "var(--warn)" }}
              className="mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium text-theme">
                No register imported for {monthLabel}
              </p>
              <p className="text-[11px] mt-0.5" style={{ color: "var(--text-muted)" }}>
                Payroll-driven pools can&rsquo;t be allocated until this month&rsquo;s wages
                are in. Upload below.
              </p>
            </div>
          </div>
        )}

        {/* Upload / replace */}
        <div>
          <h2 className="text-[13px] font-semibold text-theme mb-2 flex items-center gap-1.5">
            {status?.imported
              ? <><RefreshCw size={13} strokeWidth={2} /> Replace the register</>
              : <><Users size={13} strokeWidth={2} /> Import the register</>}
          </h2>
          <PayrollPanel periodStart={periodStart} periodEnd={periodEnd} />
        </div>
      </div>
    </div>
  )
}
