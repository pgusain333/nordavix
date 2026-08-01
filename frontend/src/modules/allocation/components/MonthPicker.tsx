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
import { useQuery } from "@tanstack/react-query"
import { toISODate } from "@/core/lib/dates"
import { Select } from "@/core/ui"
import { allocationApi, type AllocationFrequency } from "../api"

interface Props {
  /** Period end, YYYY-MM-DD. */
  value: string
  onChange: (periodEnd: string) => void
  /** How far back to offer. */
  months?: number
  /** Annual clients pick a YEAR — offering them twelve months would invite a
   *  run addressed to March that actually covers the whole year. */
  frequency?: "monthly" | "annual"
  /** "MM-DD". Only read for annual clients, whose period end IS the year end. */
  fiscalYearEnd?: string | null
}

/** The year-end date for a tax year, honouring a non-calendar fiscal year.
 *  Mirrors `fiscal_year_bounds` in the engine. */
export function fiscalYearEndDate(taxYear: number, fiscalYearEnd?: string | null): string {
  const [m, d] = (fiscalYearEnd ?? "12-31").split("-").map(Number)
  const month = Number.isFinite(m) && m >= 1 && m <= 12 ? m : 12
  const day = Number.isFinite(d) && d >= 1 && d <= 31 ? d : 31
  // Day 0 of the next month clamps a bad day (e.g. 02-31) to the real month end.
  const end = new Date(taxYear, month - 1, day)
  const clamp = new Date(taxYear, month, 0)
  return toISODate(end > clamp ? clamp : end)
}

/** [periodStart, periodEnd] for the month containing a period-end date. */
export function monthRange(periodEnd: string): { periodStart: string; periodEnd: string } {
  const d = new Date(periodEnd + "T00:00:00")
  return {
    periodStart: toISODate(new Date(d.getFullYear(), d.getMonth(), 1)),
    periodEnd:   toISODate(new Date(d.getFullYear(), d.getMonth() + 1, 0)),
  }
}

/**
 * The window a run actually covers. Mirrors `period_bounds` in the engine.
 *
 * For an ANNUAL client this is the whole fiscal year. Deriving it as the month
 * of period_end — which is what every screen used to do — would pull one month
 * of expense and one month of wages into a figure presented as the year.
 */
export function periodRange(
  periodEnd: string,
  frequency: "monthly" | "annual" = "monthly",
  fiscalYearEnd?: string | null,
): { periodStart: string; periodEnd: string } {
  if (frequency !== "annual") return monthRange(periodEnd)

  const end = fiscalYearEndDate(
    // period_end IS the year end for an annual client; if a stale monthly date
    // is in storage, the tax year it falls in is still the right answer.
    taxYearFor(periodEnd, fiscalYearEnd), fiscalYearEnd,
  )
  const e = new Date(end + "T00:00:00")
  const start = new Date(e.getFullYear(), e.getMonth() + 1, 1)
  start.setFullYear(start.getFullYear() - 1)
  return { periodStart: toISODate(start), periodEnd: end }
}

/** Which tax year a date belongs to. Mirrors `tax_year_for` in the engine. */
export function taxYearFor(iso: string, fiscalYearEnd?: string | null): number {
  const year = Number(iso.slice(0, 4))
  return iso > fiscalYearEndDate(year, fiscalYearEnd) ? year + 1 : year
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

/**
 * The client's allocation cadence, from one cached source.
 *
 * Every screen that shows a period picker or derives a run window reads this,
 * so none of them can disagree with the engine about what "this period" means.
 */
export function useAllocationFrequency(): {
  frequency: AllocationFrequency
  fiscalYearEnd: string | null
} {
  const { data } = useQuery({
    queryKey: ["allocation", "settings"],
    queryFn:  allocationApi.getSettings,
    staleTime: 5 * 60_000,
  })
  return {
    frequency: data?.allocation_frequency ?? "monthly",
    fiscalYearEnd: data?.fiscal_year_end ?? null,
  }
}

/**
 * The period every screen should actually work on.
 *
 * The stored period is whatever was last picked, which for an annual client can
 * be a leftover MONTHLY date — switch a client to annual and "2026-07-31" is
 * still in local storage. Normalising here means readiness, the registries and
 * the run all address the same date; without it the picker said "Tax year 2026"
 * while readiness was checking July, which is the two-different-truths bug this
 * product keeps having to be defended against.
 */
export function useAllocationWindow(): {
  periodStart: string
  periodEnd: string
  setPeriodEnd: (v: string) => void
  frequency: AllocationFrequency
  fiscalYearEnd: string | null
} {
  const [stored, setPeriodEnd] = useAllocationPeriod()
  const { frequency, fiscalYearEnd } = useAllocationFrequency()
  const { periodStart, periodEnd } = periodRange(stored, frequency, fiscalYearEnd)
  return { periodStart, periodEnd, setPeriodEnd, frequency, fiscalYearEnd }
}

export function MonthPicker({
  value, onChange, months = 24, frequency = "monthly", fiscalYearEnd,
}: Props) {
  const isAnnual = frequency === "annual"

  const options = useMemo(() => {
    const now = new Date()
    const out: { value: string; label: string }[] = []

    if (isAnnual) {
      // Tax years, newest first. A year whose end hasn't passed yet is still
      // offered — an annual client's work happens after year end, but a
      // preparer builds the file before then.
      const thisYear = now.getFullYear()
      for (let i = 0; i < 6; i++) {
        const y = thisYear - i
        out.push({ value: fiscalYearEndDate(y, fiscalYearEnd), label: `Tax year ${y}` })
      }
      return out
    }

    // i = 0 is the month just ended; walk backwards from there.
    for (let i = 0; i < months; i++) {
      const end = new Date(now.getFullYear(), now.getMonth() - i, 0)
      out.push({
        value: toISODate(end),
        label: end.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
      })
    }
    return out
  }, [months, isAnnual, fiscalYearEnd])

  // A value outside the window (a deep link, or an older run) still has to be
  // selectable, so it's prepended rather than silently snapping to something else.
  const known = options.some((o) => o.value === value)
  const all = known || !value
    ? options
    : [{
        value,
        label: isAnnual
          ? `Tax year ${value.slice(0, 4)}`
          : new Date(value + "T00:00:00").toLocaleDateString("en-US", {
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
