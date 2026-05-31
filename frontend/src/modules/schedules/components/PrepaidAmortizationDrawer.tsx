/**
 * PrepaidAmortizationDrawer — right-to-left slide-in showing the full
 * amortization schedule + journal entry preview for one prepaid item.
 *
 * Math respects item.amortization_method:
 *
 *   "daily_rate"    — each row = (total / total_days) × days in that
 *                     month overlapping the coverage window. Precise
 *                     down to the day; partial months are pro-rated.
 *
 *   "straight_line" — total / number_of_months_in_window, applied
 *                     evenly to every month. The last month absorbs
 *                     any rounding residual so cumulative ties to
 *                     `total` exactly. Standard CPA convention: every
 *                     calendar month overlapping the window gets the
 *                     full monthly amount, regardless of partial-month
 *                     coverage. "Day count" on each row is still shown
 *                     for context but doesn't drive the math.
 *
 * Computed client-side from the item's fields — no API call. Each
 * period_end is the last day of a calendar month in [start, end].
 *
 * The drawer renders two stacked sections:
 *   1. Journal-entry preview for the current period
 *   2. Month-by-month schedule
 */
import { useMemo } from "react"
import { motion } from "framer-motion"
import { X, FileText, CheckCircle2 } from "lucide-react"
import type { PrepaidItem, PrepaidAmortMethod } from "@/modules/schedules/types"

interface Props {
  item:     PrepaidItem
  onClose:  () => void
}

interface ScheduleRow {
  period_end:   string
  days:         number
  amount:       number
  cumulative:   number
  remaining:    number
  is_current?:  boolean   // marked when this row is the "today" month
}

interface ScheduleResult {
  rows:           ScheduleRow[]
  method:         PrepaidAmortMethod
  /** Days-based daily rate — populated for both methods so the KPI
   *  strip can show it as context, but only drives row amounts when
   *  method === "daily_rate". */
  dailyRate:      number
  /** Straight-line monthly amount — populated for both methods so the
   *  KPI strip can show it; drives row amounts when method ===
   *  "straight_line". */
  monthlyAmount:  number
  totalDays:      number
  totalMonths:    number
}

function lastOfMonth(year: number, month: number): Date {
  // month is 0-indexed (0 = Jan). Day 0 of next month = last day of current.
  return new Date(year, month + 1, 0)
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function daysInclusive(start: Date, end: Date): number {
  if (end < start) return 0
  return Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1
}

function fmt(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/**
 * Build the period-by-period schedule honoring the item's
 * amortization_method. See file-top docstring for math details.
 */
function buildSchedule(item: PrepaidItem): ScheduleResult {
  const method: PrepaidAmortMethod = item.amortization_method === "straight_line"
    ? "straight_line"
    : "daily_rate"

  const total = parseFloat(item.total_amount) || 0
  const start = new Date(item.start_date + "T00:00:00")
  const end   = new Date(item.end_date   + "T00:00:00")
  const totalDays = daysInclusive(start, end) || 1
  const dailyRate = total / totalDays

  // Count calendar months in the coverage window (inclusive of both
  // endpoints). Jan 15 → Dec 14 = 12 months; Jan 1 → Jan 31 = 1 month.
  const totalMonths = Math.max(
    1,
    (end.getFullYear() - start.getFullYear()) * 12
      + (end.getMonth() - start.getMonth())
      + 1,
  )
  // Straight-line monthly is exact total / months. Per-row rounding to
  // cents may leave a residual cent or two; we apply that to the last
  // row so cumulative ties to `total` perfectly.
  const monthlyAmount = total / totalMonths

  const rows: ScheduleRow[] = []
  let cursor = new Date(start.getFullYear(), start.getMonth(), 1)
  const finalMonthStart = new Date(end.getFullYear(), end.getMonth(), 1)

  const today = new Date()
  const currentMonthStart = new Date(today.getFullYear(), today.getMonth(), 1)
  let cumulative = 0
  let rowIndex = 0

  while (cursor <= finalMonthStart) {
    const monthEnd = lastOfMonth(cursor.getFullYear(), cursor.getMonth())
    const overlapStart = cursor < start ? start : cursor
    const overlapEnd   = monthEnd > end  ? end   : monthEnd
    const days = daysInclusive(overlapStart, overlapEnd)

    let amount: number
    if (method === "straight_line") {
      // Every month in the window gets the SAME monthly amount —
      // partial first/last months still get the full monthly amount
      // per standard CPA convention. The last row absorbs any cent of
      // rounding residual so total ties exactly.
      const isLastRow = cursor.getTime() === finalMonthStart.getTime()
      if (isLastRow) {
        amount = Math.round((total - cumulative) * 100) / 100
      } else {
        amount = Math.round(monthlyAmount * 100) / 100
      }
    } else {
      // daily_rate: precise per-day math, partial months pro-rated.
      amount = days > 0 ? Math.round(dailyRate * days * 100) / 100 : 0
    }

    cumulative = Math.round((cumulative + amount) * 100) / 100
    const remaining = Math.round((total - cumulative) * 100) / 100
    rows.push({
      period_end: ymd(monthEnd),
      days,
      amount,
      cumulative,
      remaining: Math.max(0, remaining),
      is_current: cursor.getTime() === currentMonthStart.getTime(),
    })
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
    rowIndex++
  }
  void rowIndex  // reserved for future debug-only callouts

  return { rows, method, dailyRate, monthlyAmount, totalDays, totalMonths }
}

export function PrepaidAmortizationDrawer({ item, onClose }: Props) {
  const { rows, method, dailyRate, monthlyAmount, totalDays, totalMonths } =
    useMemo(() => buildSchedule(item), [item])
  const total = parseFloat(item.total_amount) || 0
  const currentRow = rows.find((r) => r.is_current) ?? rows[0]
  const finishedCount = rows.filter((r) => r.cumulative >= total - 0.005).length

  // Method-driven labels. These thread through the header kicker, KPI
  // strip, JE memo, and explainer note so every part of the drawer
  // says the same thing as the math it just rendered.
  const isStraightLine = method === "straight_line"
  const methodLabel  = isStraightLine ? "straight-line" : "days-based"
  const methodKicker = isStraightLine
    ? "Amortization schedule · straight-line"
    : "Amortization schedule · days-based"
  // The KPI tile beside Total — flips between Monthly (straight-line)
  // and Daily rate (days-based) so the headline number always matches
  // how the rows are being computed.
  const rateLabel = isStraightLine ? "Monthly" : "Daily rate"
  const rateValue = isStraightLine ? fmt(monthlyAmount) : fmt(dailyRate)
  const periodCountLabel = isStraightLine
    ? `${totalMonths} month${totalMonths === 1 ? "" : "s"}`
    : `${totalDays} day${totalDays === 1 ? "" : "s"}`

  return (
    <>
      {/* Backdrop */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
        className="fixed inset-0 z-40"
        style={{ background: "rgba(0,0,0,0.45)" }}
        onClick={onClose}
      />

      {/* Drawer — slides in from the right */}
      <motion.aside
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        exit={{ x: "100%" }}
        transition={{ type: "tween", duration: 0.25, ease: "easeOut" }}
        className="fixed inset-y-0 right-0 z-50 w-full sm:w-[640px] flex flex-col"
        style={{
          background: "var(--bg)",
          borderLeft: "1px solid var(--border)",
          boxShadow: "-12px 0 32px rgba(0,0,0,0.18)",
        }}
      >
        {/* Header */}
        <div className="px-5 py-4 flex items-start justify-between gap-3"
          style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1">
              <FileText size={15} strokeWidth={1.8} style={{ color: "#1d4ed8" }} />
              <p className="text-[10px] font-semibold uppercase tracking-wider"
                style={{ color: "#1d4ed8" }}>
                {methodKicker}
              </p>
            </div>
            <h2 className="text-base font-bold text-theme truncate">{item.description}</h2>
            <p className="text-[11px] mt-0.5" style={{ color: "var(--text-muted)" }}>
              {item.vendor ?? "—"}
              {item.reference && <span> · {item.reference}</span>}
              {" · "}{item.start_date} → {item.end_date}
            </p>
          </div>
          <button onClick={onClose}
            className="h-7 w-7 rounded-md flex items-center justify-center hover:bg-[var(--surface-2)]"
            style={{ color: "var(--text-muted)" }} title="Close">
            <X size={15} strokeWidth={1.8} />
          </button>
        </div>

        {/* Quick stats */}
        <div className="px-5 py-3 grid grid-cols-2 sm:grid-cols-4 gap-3"
          style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
          <Kpi label="Total" value={fmt(total)} />
          {/* Period count flips between Days (daily_rate) and Months
              (straight_line) so the figure beside Total matches the
              denominator the rate is calculated against. */}
          <Kpi
            label={isStraightLine ? "Months" : "Days"}
            value={isStraightLine ? totalMonths.toString() : totalDays.toString()}
          />
          {/* Rate tile is the headline number the method uses: Monthly
              for straight-line, Daily rate for days-based. */}
          <Kpi label={rateLabel} value={rateValue} />
          <Kpi label="Periods" value={`${finishedCount} / ${rows.length} done`} />
        </div>

        {/* Body — scrollable */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Initial recording JE — posted ONCE at item inception.
              Recognizes the prepaid asset on the BS and clears cash
              (or sets up the payable if accrued). Shown at the top of
              the drawer as standing documentation of what should be
              booked when the item is first added. Single render — does
              NOT repeat in every monthly row of the schedule table. */}
          {total > 0 && (
            <section>
              <p className="text-[10px] font-semibold uppercase tracking-wider mb-2"
                style={{ color: "var(--text-muted)" }}>
                Initial recording entry · {item.invoice_date ?? item.start_date}
                {" "}(post once at inception)
              </p>
              <div className="rounded-lg overflow-hidden"
                style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
                <table className="w-full text-xs">
                  <thead>
                    <tr style={{ background: "var(--surface-2)" }}>
                      <th className="text-left px-3 py-1.5 font-semibold"
                        style={{ color: "var(--text-muted)" }}>Account</th>
                      <th className="text-right px-3 py-1.5 font-semibold"
                        style={{ color: "var(--text-muted)" }}>Debit</th>
                      <th className="text-right px-3 py-1.5 font-semibold"
                        style={{ color: "var(--text-muted)" }}>Credit</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr style={{ borderTop: "1px solid var(--border)" }}>
                      <td className="px-3 py-2 text-theme">Prepaid Asset (BS)</td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold text-theme">
                        {fmt(total)}
                      </td>
                      <td className="px-3 py-2 text-right" style={{ color: "var(--text-muted)" }}>—</td>
                    </tr>
                    <tr style={{ borderTop: "1px solid var(--border)" }}>
                      <td className="px-3 py-2 text-theme pl-6">Cash / Accounts Payable (BS)</td>
                      <td className="px-3 py-2 text-right" style={{ color: "var(--text-muted)" }}>—</td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold text-theme">
                        {fmt(total)}
                      </td>
                    </tr>
                  </tbody>
                </table>
                <div className="px-3 py-2 text-[10px]"
                  style={{ background: "var(--surface-2)", color: "var(--text-muted)", borderTop: "1px solid var(--border)" }}>
                  Memo: Record prepaid {item.description}
                  {item.vendor && <> from {item.vendor}</>}
                  {" — "}coverage {item.start_date} → {item.end_date}.
                </div>
              </div>
            </section>
          )}

          {/* Current period JE preview */}
          {currentRow && currentRow.amount > 0 && (
            <section>
              <p className="text-[10px] font-semibold uppercase tracking-wider mb-2"
                style={{ color: "var(--text-muted)" }}>
                Journal entry · {currentRow.period_end}
                {" "}
                {isStraightLine
                  ? `(straight-line · 1 of ${totalMonths} months)`
                  : `(${currentRow.days} days)`}
              </p>
              <div className="rounded-lg overflow-hidden"
                style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
                <table className="w-full text-xs">
                  <thead>
                    <tr style={{ background: "var(--surface-2)" }}>
                      <th className="text-left px-3 py-1.5 font-semibold"
                        style={{ color: "var(--text-muted)" }}>Account</th>
                      <th className="text-right px-3 py-1.5 font-semibold"
                        style={{ color: "var(--text-muted)" }}>Debit</th>
                      <th className="text-right px-3 py-1.5 font-semibold"
                        style={{ color: "var(--text-muted)" }}>Credit</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr style={{ borderTop: "1px solid var(--border)" }}>
                      <td className="px-3 py-2 text-theme">Amortization Expense (P&amp;L)</td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold text-theme">
                        {fmt(currentRow.amount)}
                      </td>
                      <td className="px-3 py-2 text-right" style={{ color: "var(--text-muted)" }}>—</td>
                    </tr>
                    <tr style={{ borderTop: "1px solid var(--border)" }}>
                      <td className="px-3 py-2 text-theme pl-6">
                        Prepaid Asset (BS)
                      </td>
                      <td className="px-3 py-2 text-right" style={{ color: "var(--text-muted)" }}>—</td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold text-theme">
                        {fmt(currentRow.amount)}
                      </td>
                    </tr>
                  </tbody>
                </table>
                <div className="px-3 py-2 text-[10px]"
                  style={{ background: "var(--surface-2)", color: "var(--text-muted)", borderTop: "1px solid var(--border)" }}>
                  Memo: amortize {item.description}
                  {" — "}
                  {isStraightLine
                    ? <>1/{totalMonths} of {fmt(total)} ({fmt(monthlyAmount)}) · straight-line</>
                    : <>{currentRow.days} day{currentRow.days === 1 ? "" : "s"} at {fmt(dailyRate)}/day</>}.
                </div>
              </div>
            </section>
          )}

          {/* Full schedule */}
          <section>
            <p className="text-[10px] font-semibold uppercase tracking-wider mb-2"
              style={{ color: "var(--text-muted)" }}>
              Period-by-period schedule
            </p>
            <div className="rounded-lg overflow-hidden"
              style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
              <table className="w-full text-xs">
                <thead>
                  <tr style={{ background: "var(--surface-2)" }}>
                    <Th>Period end</Th>
                    <Th right>Days</Th>
                    <Th right>Amortization</Th>
                    <Th right>Cumulative</Th>
                    <Th right>Remaining</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const done = r.remaining < 0.005
                    return (
                      <tr key={r.period_end}
                        style={{
                          borderTop: "1px solid var(--border)",
                          background: r.is_current ? "rgba(29, 78, 216, 0.06)" : "transparent",
                        }}>
                        <td className="px-3 py-1.5">
                          <span className="text-theme">{r.period_end}</span>
                          {r.is_current && (
                            <span className="ml-2 text-[9px] font-semibold uppercase tracking-wider"
                              style={{ color: "#1d4ed8" }}>· this month</span>
                          )}
                          {done && !r.is_current && (
                            <span className="ml-2 inline-flex items-center gap-1 text-[9px] font-semibold"
                              style={{ color: "var(--green)" }}>
                              <CheckCircle2 size={9} strokeWidth={2.4} />
                              Fully amortized
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums"
                          style={{ color: "var(--text-2)" }}>{r.days}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-theme">
                          {fmt(r.amount)}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums"
                          style={{ color: "var(--text-2)" }}>
                          {fmt(r.cumulative)}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums font-medium text-theme">
                          {fmt(r.remaining)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-[10px] mt-2" style={{ color: "var(--text-muted)" }}>
              {isStraightLine ? (
                <>
                  Straight-line ({methodLabel}): each row = total ({fmt(total)}) ÷
                  {" "}{totalMonths} months = {fmt(monthlyAmount)} per month. Every
                  calendar month in the coverage window gets the same amount; the
                  last row absorbs any cent of rounding so cumulative ties to the
                  total exactly. Day counts are shown for context only — they don't
                  drive the math on this method.
                </>
              ) : (
                <>
                  Days-based ({methodLabel}): each row's amortization = daily rate
                  ({fmt(dailyRate)}) × days in that calendar month overlapping the
                  coverage window. Sums to {fmt(total)} over {periodCountLabel}.
                </>
              )}
            </p>
          </section>
        </div>
      </motion.aside>
    </>
  )
}

// ── Helpers ────────────────────────────────────────────────────────────────

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider"
        style={{ color: "var(--text-muted)" }}>{label}</p>
      <p className="text-sm font-bold tabular-nums mt-0.5 text-theme">{value}</p>
    </div>
  )
}

function Th({ children, right }: { children?: React.ReactNode; right?: boolean }) {
  return (
    <th className={`px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide ${right ? "text-right" : "text-left"}`}
      style={{ color: "var(--text-muted)" }}>
      {children}
    </th>
  )
}
