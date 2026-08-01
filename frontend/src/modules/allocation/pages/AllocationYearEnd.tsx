/**
 * AllocationYearEnd — twelve months become one number on a return.
 *
 * The completeness checklist leads, and everything below it is greyed by a
 * banner until the checklist is clean. That order is the whole point: an annual
 * total that omits August, or includes a draft nobody reviewed, or opens April
 * at a figure March never closed at, is wrong on a filed return and looks
 * entirely ordinary while being wrong. The figure is not the deliverable —
 * the figure plus the evidence of what it's made of is.
 *
 * Every exception routes to the month that fixes it.
 */
import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import {
  AlertTriangle, ArrowRight, CalendarCheck2, CheckCircle2, Download,
  FileSpreadsheet, XCircle,
} from "lucide-react"
import { Button, Select, Spinner } from "@/core/ui"
import { allocationApi, money, type AnnualRollup } from "../api"
import { useAllocationPeriod } from "../components/MonthPicker"

/** "2026-08-31" → "Aug 2026". Split, never Date-parsed: a UTC parse shifts the
 *  month in every timezone behind UTC and would label the wrong period. */
function monthLabel(iso: string): string {
  const [y, m] = iso.split("-")
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  return `${MONTHS[Number(m) - 1] ?? m} ${y}`
}

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft", in_review: "In review", approved: "Approved", superseded: "Superseded",
}

export function AllocationYearEnd() {
  const navigate = useNavigate()
  const [, setPeriodEnd] = useAllocationPeriod()
  const [taxYear, setTaxYear] = useState<number | null>(null)

  const { data: yearsInfo } = useQuery({
    queryKey: ["allocation", "tax-years"],
    queryFn:  allocationApi.listTaxYears,
    staleTime: 60_000,
  })

  // Default to the newest year that has runs, once we know what that is.
  useEffect(() => {
    if (taxYear === null && yearsInfo?.years.length) setTaxYear(yearsInfo.years[0])
  }, [taxYear, yearsInfo])

  const { data, isLoading } = useQuery({
    queryKey: ["allocation", "annual", taxYear],
    queryFn:  () => allocationApi.getAnnual(taxYear!),
    enabled:  taxYear !== null,
  })

  /** Jump to the month that resolves an exception, on the screen that fixes it. */
  const goToMonth = (periodEnd: string) => {
    setPeriodEnd(periodEnd)
    navigate("/allocation/runs")
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-6xl mx-auto px-5 py-6 space-y-5">

        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-lg font-semibold text-theme tracking-tight">Year end</h1>
            <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
              The year rolled up, what it&rsquo;s made of, and the Form 1125-A lines
            </p>
          </div>
          <div className="flex items-center gap-2">
            {data && (
              <Button variant="outline" icon={<Download size={14} strokeWidth={1.8} />}
                onClick={() => allocationApi.downloadAnnualWorkpaperCsv(data.tax_year)}>
                Workpaper
              </Button>
            )}
            <Select
              value={taxYear ?? ""}
              onChange={(e) => setTaxYear(Number(e.target.value))}
              className="w-[130px]"
              aria-label="Tax year"
            >
              {(yearsInfo?.years ?? []).map((y) => (
                <option key={y} value={y}>Tax year {y}</option>
              ))}
            </Select>
          </div>
        </div>

        {isLoading || !data ? (
          <div className="flex justify-center py-16"><Spinner className="h-5 w-5" /></div>
        ) : (
          <>
            <Checklist data={data} onGoToMonth={goToMonth} />
            <MonthlyRoll data={data} onGoToMonth={goToMonth} />
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
              <RollForward data={data} />
              <Form1125A data={data} />
            </div>
            <ByPool data={data} />
          </>
        )}
      </div>
    </div>
  )
}

// ── Completeness ──────────────────────────────────────────────────────────────

function Checklist({ data, onGoToMonth }: {
  data: AnnualRollup
  onGoToMonth: (periodEnd: string) => void
}) {
  const c = data.checklist

  /** One exception line, with the months that caused it as jump targets. */
  const Row = ({ ok, label, periods, detail }: {
    ok: boolean; label: string; periods?: string[]; detail?: string
  }) => (
    <li className="flex items-start gap-2.5 py-1.5">
      {ok
        ? <CheckCircle2 size={14} strokeWidth={2} className="mt-[3px] shrink-0" style={{ color: "var(--positive)" }} />
        : <XCircle size={14} strokeWidth={2} className="mt-[3px] shrink-0" style={{ color: "var(--danger)" }} />}
      <div className="min-w-0">
        <span className="text-[12.5px]" style={{ color: ok ? "var(--text-2)" : "var(--text)" }}>
          {label}
        </span>
        {detail && (
          <span className="text-[11.5px] block mt-0.5" style={{ color: "var(--text-muted)" }}>{detail}</span>
        )}
        {!ok && periods && periods.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {periods.map((p) => (
              <button key={p} onClick={() => onGoToMonth(p)}
                className="text-[11px] font-medium px-2 py-[3px] rounded-md transition-opacity hover:opacity-75"
                style={{ background: "var(--surface-2)", color: "var(--green)" }}>
                {monthLabel(p)}
              </button>
            ))}
          </div>
        )}
      </div>
    </li>
  )

  return (
    <div className="rounded-xl p-4"
      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          {data.complete
            ? <CheckCircle2 size={17} strokeWidth={2} style={{ color: "var(--positive)" }} />
            : <AlertTriangle size={17} strokeWidth={2} style={{ color: "var(--warn)" }} />}
          <span className="text-sm font-semibold text-theme">
            {data.complete
              ? `Tax year ${data.tax_year} is complete`
              : `Tax year ${data.tax_year} is not ready to file`}
          </span>
        </div>
        <span className="text-[11px] tabular-nums" style={{ color: "var(--text-muted)" }}>
          {data.year_start} to {data.year_end}
          {data.fiscal_year_end && data.fiscal_year_end !== "12-31" && " · fiscal year"}
        </span>
      </div>

      <ul className="mt-2.5" style={{ borderTop: "1px solid var(--border)" }}>
        <Row ok={c.missing_periods.length === 0}
          label={`All ${c.months_expected} months allocated`}
          detail={`${c.months_present} of ${c.months_expected} present`}
          periods={c.missing_periods} />
        <Row ok={c.unapproved_periods.length === 0}
          label="Every month approved"
          detail="A month nobody reviewed shouldn't reach a return"
          periods={c.unapproved_periods} />
        <Row ok={c.unposted_periods.length === 0}
          label="Every reclass entry confirmed in the books"
          detail="§471(c) follows the books — an entry that was never posted leaves the ledger contradicting the return"
          periods={c.unposted_periods} />
        <Row ok={c.inventory_breaks.length === 0}
          label="Inventory chain unbroken"
          detail={c.inventory_breaks.length === 0
            ? "Each month opens where the last one closed"
            // money() already parenthesises negatives — don't wrap it again.
            : c.inventory_breaks.map((b) =>
                `${monthLabel(b.period_end)} opens at ${money(b.beginning)} against ` +
                `${money(b.prior_ending)} closing ${monthLabel(b.prior_period_end)} — ` +
                `${money(b.difference)} unexplained`).join(" · ")}
          periods={c.inventory_breaks.map((b) => b.period_end)} />
        <Row ok={c.periods_missing_inventory.length === 0}
          label="Inventory captured every month"
          detail="Beginning and ending inventory drive the annual cost of goods sold"
          periods={c.periods_missing_inventory} />
        <Row ok={c.eligibility_concluded && c.eligible !== false}
          label="§448(c) small business taxpayer test concluded"
          detail={!c.eligibility_concluded
            ? "No conclusion on file for this year — §471(c) is only open below the threshold"
            : c.eligible
              ? "Concluded eligible"
              : "Concluded NOT eligible — this client cannot use §471(c) for this year"} />
      </ul>
    </div>
  )
}

// ── The twelve months ─────────────────────────────────────────────────────────

function MonthlyRoll({ data, onGoToMonth }: {
  data: AnnualRollup
  onGoToMonth: (periodEnd: string) => void
}) {
  const present = new Map(data.months.filter((m) => m.status !== "superseded").map((m) => [m.period_end, m]))
  const t = data.totals

  return (
    <div className="rounded-xl overflow-hidden"
      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
        <h2 className="text-[13px] font-semibold text-theme">Monthly roll</h2>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr style={{ color: "var(--text-muted)" }}>
              <th className="text-left font-medium px-4 py-2">Month</th>
              <th className="text-left font-medium px-3 py-2">Status</th>
              <th className="text-right font-medium px-3 py-2">Expenses</th>
              <th className="text-right font-medium px-3 py-2">Capitalized</th>
              <th className="text-right font-medium px-3 py-2">Disallowed</th>
              <th className="text-right font-medium px-3 py-2">Beginning</th>
              <th className="text-right font-medium px-4 py-2">Ending</th>
            </tr>
          </thead>
          <tbody>
            {/* Driven by the EXPECTED periods, not by the runs found — a month
                nobody ran has to appear as a gap rather than vanish. */}
            {data.expected_periods.map((p) => {
              const m = present.get(p)
              return (
                <tr key={p} className="cursor-pointer transition-colors hover:opacity-80"
                  onClick={() => onGoToMonth(p)}
                  style={{ borderTop: "1px solid var(--border)" }}>
                  <td className="px-4 py-2 text-theme whitespace-nowrap">{monthLabel(p)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {!m ? (
                      <span className="inline-flex items-center gap-1" style={{ color: "var(--danger)" }}>
                        <XCircle size={12} strokeWidth={2} /> Not run
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5"
                        style={{ color: m.status === "approved" ? "var(--positive)" : "var(--text-2)" }}>
                        {STATUS_LABEL[m.status] ?? m.status}
                        {m.posted
                          ? <span title="Confirmed posted in QuickBooks" style={{ color: "var(--positive)" }}>· posted</span>
                          : <span title="Not confirmed in the client's books" style={{ color: "var(--warn)" }}>· not posted</span>}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums" style={{ color: "var(--text-2)" }}>
                    {m ? money(m.total_expenses) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-theme">
                    {m ? money(m.capitalized) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums" style={{ color: "var(--text-2)" }}>
                    {m ? money(m.disallowed) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums" style={{ color: "var(--text-muted)" }}>
                    {m ? money(m.beginning_inventory) : "—"}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums" style={{ color: "var(--text-muted)" }}>
                    {m ? money(m.ending_inventory) : "—"}
                  </td>
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: "2px solid var(--border)" }}>
              <td className="px-4 py-2.5 font-semibold text-theme" colSpan={2}>Year</td>
              <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-theme">{money(t.total_expenses)}</td>
              <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-theme">{money(t.capitalized)}</td>
              <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-theme">{money(t.disallowed)}</td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}

// ── Roll-forward and the form ─────────────────────────────────────────────────

function Line({ label, value, sub, strong, top }: {
  label: string; value: string; sub?: string; strong?: boolean; top?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-4 py-2"
      style={{ borderTop: top ? "2px solid var(--border)" : "1px solid var(--border)" }}>
      <div className="min-w-0">
        <div className={`text-[12.5px] ${strong ? "font-semibold text-theme" : ""}`}
          style={strong ? undefined : { color: "var(--text-2)" }}>{label}</div>
        {sub && <div className="text-[10.5px] mt-0.5" style={{ color: "var(--text-muted)" }}>{sub}</div>}
      </div>
      <div className={`tabular-nums whitespace-nowrap ${strong ? "text-[14px] font-semibold text-theme" : "text-[12.5px] text-theme"}`}>
        {value}
      </div>
    </div>
  )
}

function RollForward({ data }: { data: AnnualRollup }) {
  const rf = data.roll_forward
  return (
    <div className="rounded-xl overflow-hidden"
      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <div className="px-4 py-3 flex items-center gap-2">
        <CalendarCheck2 size={14} strokeWidth={1.9} style={{ color: "var(--text-muted)" }} />
        <h2 className="text-[13px] font-semibold text-theme">Annual inventory roll-forward</h2>
      </div>
      {!rf ? (
        <div className="px-4 pb-4 pt-1">
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            Not available yet — beginning inventory for the first month and ending
            inventory for the last are both needed. Enter them on the monthly run.
          </p>
        </div>
      ) : (
        <div>
          <Line label="Beginning inventory" sub={`As at ${data.year_start}`} value={money(rf.beginning_inventory)} />
          <Line label="Capitalized cost" sub="From the twelve monthly allocations" value={money(rf.capitalized)} />
          <Line label="Purchases" sub="Inventoriable cost bought directly into stock" value={money(rf.purchases)} />
          <Line label="Ending inventory" sub={`As at ${data.year_end}`} value={`(${money(rf.ending_inventory)})`} />
          <Line label="Cost of goods sold" value={money(rf.cogs)} strong top />
        </div>
      )}
    </div>
  )
}

function Form1125A({ data }: { data: AnnualRollup }) {
  const f = data.form_1125a
  return (
    <div className="rounded-xl overflow-hidden"
      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <div className="px-4 py-3 flex items-center gap-2">
        <FileSpreadsheet size={14} strokeWidth={1.9} style={{ color: "var(--text-muted)" }} />
        <h2 className="text-[13px] font-semibold text-theme">Form 1125-A</h2>
      </div>
      <Line label="1 · Inventory at beginning of year" value={money(f.line_1_beginning_inventory)} />
      <Line label="2 · Purchases" value={money(f.line_2_purchases)} />
      <Line label="3 · Cost of labor" sub="Pools marked as labor on the Pools tab" value={money(f.line_3_cost_of_labor)} />
      <Line label="5 · Other costs" sub="Everything else capitalized under §471(c)" value={money(f.line_5_other_costs)} />
      <Line label="6 · Total" value={money(f.line_6_total)} strong top />
      <Line label="7 · Inventory at end of year" value={money(f.line_7_ending_inventory)} />
      <Line label="8 · Cost of goods sold" value={money(f.line_8_cogs)} strong top />
      <div className="px-4 py-3" style={{ borderTop: "1px solid var(--border)" }}>
        <p className="text-[10.5px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
          Line 4 (additional §263A costs) is not presented: §280E denies §263A to this
          taxpayer, which is the reason §471(c) is being used.
        </p>
        {!f.based_on_complete_year && (
          <p className="text-[11px] mt-2 flex items-start gap-1.5" style={{ color: "var(--warn)" }}>
            <AlertTriangle size={12} strokeWidth={2} className="mt-[2px] shrink-0" />
            Built on an incomplete year — clear the checklist above before relying on these lines.
          </p>
        )}
      </div>
    </div>
  )
}

// ── Where the capitalized cost came from ──────────────────────────────────────

function ByPool({ data }: { data: AnnualRollup }) {
  const navigate = useNavigate()
  if (data.by_pool.length === 0) return null

  return (
    <div className="rounded-xl overflow-hidden"
      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <div className="px-4 py-3 flex items-center justify-between gap-3"
        style={{ borderBottom: "1px solid var(--border)" }}>
        <h2 className="text-[13px] font-semibold text-theme">Capitalized cost by pool</h2>
        <button onClick={() => navigate("/allocation/setup?tab=pools")}
          className="text-[11.5px] font-medium inline-flex items-center gap-1"
          style={{ color: "var(--green)" }}>
          Change a pool&rsquo;s 1125-A line <ArrowRight size={12} strokeWidth={2} />
        </button>
      </div>
      <table className="w-full text-[12.5px]">
        <tbody>
          {data.by_pool.map((p, i) => (
            <tr key={p.pool_name} style={{ borderTop: i === 0 ? undefined : "1px solid var(--border)" }}>
              <td className="px-4 py-2 text-theme">{p.pool_name}</td>
              <td className="px-3 py-2" style={{ color: "var(--text-muted)" }}>
                {p.form_1125a_line === "labor" ? "Line 3 — cost of labor" : "Line 5 — other costs"}
              </td>
              <td className="px-4 py-2 text-right tabular-nums text-theme">{money(p.capitalized)}</td>
            </tr>
          ))}
          <tr style={{ borderTop: "2px solid var(--border)" }}>
            <td className="px-4 py-2.5 font-semibold text-theme" colSpan={2}>Total capitalized</td>
            <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-theme">
              {money(data.totals.capitalized)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}
