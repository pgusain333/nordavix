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
import { useMemo, useState } from "react"
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

/**
 * Is an effective-dated row in force at this period end?
 *
 * Mirrors `is_effective` in the engine. The registry panels have to apply the
 * SAME rule the server does, or a screen shows two different truths at once —
 * which is exactly what happened: the Spaces tab totalled 340 sq ft while
 * readiness, filtering by period, reported none on file.
 */
export function isEffective(
  effectiveFrom: string, effectiveTo: string | null, periodEnd: string,
): boolean {
  if (effectiveFrom > periodEnd) return false
  return effectiveTo === null || effectiveTo >= periodEnd
}

const STORAGE_KEY = "nordavix:allocation-period"

/**
 * The period the whole product is working on, remembered across screens.
 *
 * Each screen used to own its own `useState(defaultPeriodEnd)`, so choosing
 * January on Setup and then opening Runs silently snapped back to the default
 * month — and you could end up running a period you hadn't chosen. The period
 * is a property of the SESSION, not of a screen, so it lives in one place.
 *
 * It deliberately isn't scoped per client: a preparer working March closes it
 * across several clients, and re-picking the month for each one is friction.
 */
export function useAllocationPeriod(): [string, (v: string) => void] {
  const [periodEnd, setState] = useState<string>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved && /^\d{4}-\d{2}-\d{2}$/.test(saved)) return saved
    } catch { /* private mode — fall through */ }
    return defaultPeriodEnd()
  })

  const setPeriodEnd = (v: string) => {
    setState(v)
    try { localStorage.setItem(STORAGE_KEY, v) } catch { /* ignore */ }
  }

  return [periodEnd, setPeriodEnd]
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
