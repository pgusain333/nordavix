/**
 * MonthPicker — pick the period a screen is working on.
 *
 * A dropdown rather than chevron steppers: reaching a month eight back took
 * eight clicks and gave no sense of where you were in the year. This shows the
 * whole range at once.
 *
 * Months run newest-first and stop at the current one — you can't allocate a
 * period that hasn't finished. `value` is the period END date (YYYY-MM-DD),
 * which is the key every allocation endpoint is addressed by.
 */
import { useMemo } from "react"
import { toISODate } from "@/core/lib/dates"
import { Select } from "@/core/ui"

interface Props {
  /** Period end, YYYY-MM-DD. */
  value: string
  onChange: (periodEnd: string) => void
  /** How far back to offer. */
  months?: number
}

/** [periodStart, periodEnd] for the month containing a period-end date. */
export function monthRange(periodEnd: string): { periodStart: string; periodEnd: string } {
  const d = new Date(periodEnd + "T00:00:00")
  return {
    periodStart: toISODate(new Date(d.getFullYear(), d.getMonth(), 1)),
    periodEnd:   toISODate(new Date(d.getFullYear(), d.getMonth() + 1, 0)),
  }
}

/** Period end of the most recent COMPLETE month — the sensible default. */
export function defaultPeriodEnd(): string {
  const n = new Date()
  // Day 0 of the current month is the last day of the previous one.
  return toISODate(new Date(n.getFullYear(), n.getMonth(), 0))
}

export function MonthPicker({ value, onChange, months = 24 }: Props) {
  const options = useMemo(() => {
    const now = new Date()
    const out: { value: string; label: string }[] = []
    // i = 0 is the month just ended; walk backwards from there.
    for (let i = 0; i < months; i++) {
      const end = new Date(now.getFullYear(), now.getMonth() - i, 0)
      out.push({
        value: toISODate(end),
        label: end.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
      })
    }
    return out
  }, [months])

  // A value outside the window (a deep link, or an older run) still has to be
  // selectable, so it's prepended rather than silently snapping to something else.
  const known = options.some((o) => o.value === value)
  const all = known || !value
    ? options
    : [{
        value,
        label: new Date(value + "T00:00:00").toLocaleDateString("en-US", {
          month: "long", year: "numeric",
        }),
      }, ...options]

  return (
    <Select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label="Period"
      style={{ width: "auto", minWidth: 176 }}
    >
      {all.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </Select>
  )
}
