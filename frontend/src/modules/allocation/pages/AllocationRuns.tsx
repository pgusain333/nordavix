/**
 * AllocationRuns — the monthly run: start one, then review what it produced.
 *
 * The whole loop lives here, because splitting "start a run" from "look at a
 * run" is what made the portal feel like it did nothing. Pick a month, run it,
 * and the workpaper and journal entry appear below.
 *
 * A blocked run is shown as a first-class result rather than an error: the
 * reason is stated with a route to fix it. "This client has no square footage
 * on file" is a task, not a failure.
 */
import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { AlertTriangle, ArrowRight, CalendarDays, CheckCircle2, Play } from "lucide-react"
import { Button, Input, Spinner } from "@/core/ui"
import { allocationApi, factorPct, money, type AllocRun } from "../api"
import { WorkpaperTable } from "../components/WorkpaperTable"
import { JournalEntryPanel } from "../components/JournalEntryPanel"
import { MonthPicker, defaultPeriodEnd, monthRange } from "../components/MonthPicker"

const STATUS_TONE: Record<string, { bg: string; fg: string }> = {
  draft:       { bg: "var(--surface-2)",   fg: "var(--text-2)" },
  in_review:   { bg: "var(--info-subtle)", fg: "var(--info)" },
  approved:    { bg: "var(--green-subtle)", fg: "var(--positive)" },
  superseded:  { bg: "var(--surface-2)",   fg: "var(--text-muted)" },
}

export function AllocationRuns() {
  // Declared before the queries whose closures read them.
  const [periodEnd, setPeriodEnd] = useState(defaultPeriodEnd)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [beginning, setBeginning] = useState("")
  const [ending, setEnding] = useState("")
  const [purchases, setPurchases] = useState("")
  const [error, setError] = useState<string | null>(null)
  const qc = useQueryClient()

  const { periodStart } = useMemo(() => monthRange(periodEnd), [periodEnd])

  const { data: runs = [], isLoading } = useQuery({
    queryKey: ["allocation", "runs"],
    queryFn:  allocationApi.listRuns,
  })

  const { data: readiness } = useQuery({
    queryKey: ["allocation", "readiness", periodEnd],
    queryFn:  () => allocationApi.getReadiness(periodEnd),
  })

  // The run being viewed: an explicit pick, else this month's live run.
  const activeId = selectedId
    ?? runs.find((r) => r.period_end === periodEnd && r.status !== "superseded")?.id
    ?? null

  const { data: detail } = useQuery({
    queryKey: ["allocation", "run", activeId],
    queryFn:  () => allocationApi.getRun(activeId!),
    enabled:  !!activeId,
  })

  const run = useMutation({
    mutationFn: () => allocationApi.createRun({
      period_start: periodStart,
      period_end:   periodEnd,
      beginning_inventory: beginning === "" ? null : Number(beginning),
      ending_inventory:    ending === "" ? null : Number(ending),
      purchases:           purchases === "" ? null : Number(purchases),
    }),
    onSuccess: (created) => {
      setSelectedId(created.id)
      qc.invalidateQueries({ queryKey: ["allocation", "runs"] })
      qc.invalidateQueries({ queryKey: ["allocation", "run"] })
      qc.invalidateQueries({ queryKey: ["allocation", "journal-entry"] })
    },
    onError: (e: unknown) => {
      const ex = e as { response?: { data?: { detail?: string } }; message?: string }
      setError(ex.response?.data?.detail ?? ex.message ?? "The run failed to start.")
    },
  })

  const approve = useMutation({
    mutationFn: (id: string) => allocationApi.approveRun(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["allocation", "runs"] })
      qc.invalidateQueries({ queryKey: ["allocation", "run"] })
    },
    onError: (e: unknown) => {
      const ex = e as { response?: { data?: { detail?: string } }; message?: string }
      setError(ex.response?.data?.detail ?? ex.message ?? "Could not approve.")
    },
  })

  const pickMonth = (pe: string) => {
    setPeriodEnd(pe)
    setSelectedId(null)   // show the new month's run, not the last viewed one
    setError(null)
  }

  const Kpi = ({ label, value, tone }: { label: string; value: string; tone?: string }) => (
    <div className="rounded-lg px-3.5 py-3" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>{label}</div>
      <div className="text-lg font-semibold tabular-nums mt-0.5" style={{ color: tone ?? "var(--text)" }}>{value}</div>
    </div>
  )

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-6xl mx-auto px-5 py-6 space-y-5">

        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-lg font-semibold text-theme tracking-tight">Runs</h1>
            <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
              One §471(c) allocation per client per month
            </p>
          </div>
          <div className="flex items-center gap-2">
            <CalendarDays size={14} strokeWidth={1.8} style={{ color: "var(--text-muted)" }} />
            <MonthPicker value={periodEnd} onChange={pickMonth} />
          </div>
        </div>

        {/* Start a run */}
        <div className="rounded-xl p-4 space-y-3"
          style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
          {readiness && !readiness.ready ? (
            <div className="flex items-start gap-2.5">
              <AlertTriangle size={16} strokeWidth={2} style={{ color: "var(--warn)" }} className="mt-0.5 shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-theme">This client isn&rsquo;t ready to run</p>
                <ul className="mt-1.5 space-y-1">
                  {readiness.blockers.map((b) => (
                    <li key={b.code} className="text-xs" style={{ color: "var(--text-2)" }}>{b.message}</li>
                  ))}
                </ul>
                <Link to="/allocation/setup"
                  className="inline-flex items-center gap-1 text-xs font-medium mt-2"
                  style={{ color: "var(--green)" }}>
                  Go to Setup <ArrowRight size={12} strokeWidth={2} />
                </Link>
              </div>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <label className="block">
                  <span className="text-[11px] font-medium" style={{ color: "var(--text-muted)" }}>
                    Beginning inventory
                  </span>
                  <Input type="number" value={beginning} placeholder="Optional"
                    onChange={(e) => setBeginning(e.target.value)} />
                </label>
                <label className="block">
                  <span className="text-[11px] font-medium" style={{ color: "var(--text-muted)" }}>
                    Ending inventory
                  </span>
                  <Input type="number" value={ending} placeholder="Optional"
                    onChange={(e) => setEnding(e.target.value)} />
                </label>
                <label className="block">
                  <span className="text-[11px] font-medium" style={{ color: "var(--text-muted)" }}>
                    Direct purchases
                  </span>
                  <Input type="number" value={purchases} placeholder="Optional"
                    onChange={(e) => setPurchases(e.target.value)} />
                </label>
              </div>
              <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                Inventory figures are optional — supply beginning and ending together to
                get COGS on the run. The allocation itself computes either way.
              </p>
              <Button onClick={() => { setError(null); run.mutate() }} loading={run.isPending}
                icon={<Play size={14} strokeWidth={1.9} />}>
                {run.isPending ? "Pulling from QuickBooks…" : "Run allocation"}
              </Button>
            </>
          )}
          {error && <p className="text-xs" style={{ color: "var(--danger)" }}>{error}</p>}
        </div>

        {/* Result */}
        {detail && (
          <>
            {detail.blocked_reason ? (
              <div className="rounded-xl p-4 flex items-start gap-2.5"
                style={{ background: "var(--surface)", border: "1px solid var(--danger)" }}>
                <AlertTriangle size={16} strokeWidth={2} style={{ color: "var(--danger)" }} className="mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-medium text-theme">Run blocked</p>
                  <p className="text-xs mt-1" style={{ color: "var(--text-2)" }}>{detail.blocked_reason}</p>
                </div>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 lg:grid-cols-5 gap-2.5">
                  <Kpi label="Total expenses" value={money(detail.total_expenses)} />
                  <Kpi label="Capitalized" value={money(detail.capitalized_total)} tone="var(--green)" />
                  <Kpi label="Disallowed (280E)" value={money(detail.disallowed_total)} tone="var(--danger)" />
                  <Kpi label="Payroll factor" value={factorPct(detail.payroll_factor)} />
                  <Kpi label="Occupancy factor" value={factorPct(detail.occupancy_factor)} />
                </div>

                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2">
                    <span className="rounded-full px-2.5 py-1 text-[11px] font-medium"
                      style={{
                        background: (STATUS_TONE[detail.status] ?? STATUS_TONE.draft).bg,
                        color: (STATUS_TONE[detail.status] ?? STATUS_TONE.draft).fg,
                      }}>
                      {detail.status.replace("_", " ")}
                    </span>
                    {detail.cogs && (
                      <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                        COGS {money(detail.cogs)}
                      </span>
                    )}
                  </div>
                  {detail.status !== "approved" && detail.status !== "superseded" && (
                    <Button variant="outline" onClick={() => approve.mutate(detail.id)}
                      loading={approve.isPending}
                      icon={<CheckCircle2 size={14} strokeWidth={1.9} />}>
                      Approve run
                    </Button>
                  )}
                </div>

                {detail.lines && detail.lines.length > 0 && <WorkpaperTable lines={detail.lines} />}
                <JournalEntryPanel runId={detail.id} periodEnd={detail.period_end} />
              </>
            )}
          </>
        )}

        {/* History */}
        <div>
          <h2 className="text-[13px] font-semibold text-theme mb-2">Run history</h2>
          {isLoading ? (
            <div className="flex justify-center py-8"><Spinner className="h-5 w-5" /></div>
          ) : runs.length === 0 ? (
            <div className="rounded-xl px-6 py-10 text-center"
              style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
              <p className="text-sm font-medium text-theme">No runs yet</p>
              <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
                Pick a month above and run the allocation.
              </p>
            </div>
          ) : (
            <div className="rounded-xl overflow-hidden"
              style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
              {runs.map((r: AllocRun, i) => (
                <button key={r.id} onClick={() => setSelectedId(r.id)}
                  className="w-full grid grid-cols-[minmax(0,1.4fr)_1fr_1fr_auto] gap-3 items-center px-4 py-2.5 text-left"
                  style={{
                    borderTop: i === 0 ? undefined : "1px solid var(--border)",
                    background: r.id === activeId ? "var(--surface-2)" : undefined,
                  }}>
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
                  <span className="rounded-full px-2 py-0.5 text-[10.5px] font-medium justify-self-end"
                    style={{
                      background: (STATUS_TONE[r.status] ?? STATUS_TONE.draft).bg,
                      color: (STATUS_TONE[r.status] ?? STATUS_TONE.draft).fg,
                    }}>
                    {r.status.replace("_", " ")}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
