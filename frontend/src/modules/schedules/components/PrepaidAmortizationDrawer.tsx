/**
 * PrepaidAmortizationDrawer — right-to-left slide-in showing the full
 * amortization schedule + journal entry preview for one prepaid item.
 *
 * Math is all days-based (matches the backend). Computed client-side
 * from the item's existing fields — no API call. Each period_end is
 * the last day of a calendar month in [start_date, end_date].
 *
 * The drawer renders two stacked sections:
 *   1. Month-by-month schedule (period_end · days · amount · cumulative · remaining)
 *   2. Journal-entry preview for the current period (Dr expense / Cr prepaid)
 */
import { useMemo } from "react"
import { motion } from "framer-motion"
import { X, FileText, CheckCircle2 } from "lucide-react"
import type { PrepaidItem } from "@/modules/schedules/types"

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

/** Build the period-by-period schedule using calendar-month buckets + days-based math. */
function buildSchedule(item: PrepaidItem): { rows: ScheduleRow[]; dailyRate: number; totalDays: number } {
  const total = parseFloat(item.total_amount) || 0
  const start = new Date(item.start_date + "T00:00:00")
  const end   = new Date(item.end_date   + "T00:00:00")
  const totalDays = daysInclusive(start, end) || 1
  const dailyRate = total / totalDays

  const rows: ScheduleRow[] = []
  // Cursor walks first → last month of the coverage window.
  let cursor = new Date(start.getFullYear(), start.getMonth(), 1)
  const finalMonthStart = new Date(end.getFullYear(), end.getMonth(), 1)

  const today = new Date()
  const currentMonthStart = new Date(today.getFullYear(), today.getMonth(), 1)
  let cumulative = 0

  while (cursor <= finalMonthStart) {
    const monthEnd = lastOfMonth(cursor.getFullYear(), cursor.getMonth())
    const periodStart = cursor < start ? new Date(cursor) : new Date(cursor)
    const overlapStart = periodStart < start ? start : periodStart
    const overlapEnd   = monthEnd  > end   ? end   : monthEnd
    const days = daysInclusive(overlapStart, overlapEnd)
    const amount = days > 0 ? Math.round(dailyRate * days * 100) / 100 : 0
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
  }

  return { rows, dailyRate, totalDays }
}

export function PrepaidAmortizationDrawer({ item, onClose }: Props) {
  const { rows, dailyRate, totalDays } = useMemo(() => buildSchedule(item), [item])
  const total = parseFloat(item.total_amount) || 0
  const currentRow = rows.find((r) => r.is_current) ?? rows[0]
  const finishedCount = rows.filter((r) => r.cumulative >= total - 0.005).length

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
                Amortization schedule · days-based
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
          <Kpi label="Days" value={totalDays.toString()} />
          <Kpi label="Daily rate" value={fmt(dailyRate)} />
          <Kpi label="Periods" value={`${finishedCount} / ${rows.length} done`} />
        </div>

        {/* Body — scrollable */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Current period JE preview */}
          {currentRow && currentRow.amount > 0 && (
            <section>
              <p className="text-[10px] font-semibold uppercase tracking-wider mb-2"
                style={{ color: "var(--text-muted)" }}>
                Journal entry · {currentRow.period_end} ({currentRow.days} days)
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
                  Memo: amortize {item.description} for {currentRow.days} days at {fmt(dailyRate)}/day.
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
              Days-based: each row's amortization = daily_rate ({fmt(dailyRate)}) × days in that
              calendar month overlapping the coverage window. Sums to {fmt(total)} over {totalDays} days.
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
