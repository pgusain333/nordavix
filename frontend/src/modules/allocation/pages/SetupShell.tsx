/**
 * SetupShell — the split screen every setup screen shares.
 *
 * Work on the left, "can this client be run" on the right. Setup is a sequence
 * of decisions whose only purpose is to make a run possible, so the answer to
 * "am I done yet" should never be somewhere else — it belongs beside the work,
 * visible while you do it.
 *
 * The month selector lives here too, because every registry is effective-dated:
 * the same client reads differently in March than in September, and a screen
 * that doesn't say which period it's showing is a screen you can't trust.
 */
import { ReactNode } from "react"
import { CalendarDays } from "lucide-react"
import { MonthPicker, useAllocationPeriod } from "../components/MonthPicker"
import { ReadinessRail } from "../components/ReadinessRail"

interface Props {
  title: string
  subtitle: string
  /** Rendered with the period the shell owns, so panels can't drift from it. */
  children: (ctx: { periodEnd: string; periodStart: string }) => ReactNode
  /** Set for screens where the period genuinely doesn't apply (settings). */
  hidePeriod?: boolean
}

export function SetupShell({ title, subtitle, children, hidePeriod }: Props) {
  const [periodEnd, setPeriodEnd] = useAllocationPeriod()
  const periodStart = `${periodEnd.slice(0, 7)}-01`

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[1180px] mx-auto px-5 py-6">

        <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
          <div>
            <h1 className="text-lg font-semibold text-theme tracking-tight">{title}</h1>
            <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>{subtitle}</p>
          </div>
          {!hidePeriod && (
            <div className="flex items-center gap-2">
              <CalendarDays size={14} strokeWidth={1.8} style={{ color: "var(--text-muted)" }} />
              <MonthPicker value={periodEnd} onChange={setPeriodEnd} />
            </div>
          )}
        </div>

        {/* On a narrow screen the rail comes FIRST: a blocker you scroll past is
            a blocker you don't see. On desktop it sits alongside and sticks. */}
        <div className="flex flex-col lg:flex-row gap-4 items-start">
          <div className="flex-1 min-w-0 w-full">
            {children({ periodEnd, periodStart })}
          </div>
          <aside className="w-full lg:w-[300px] shrink-0 order-first lg:order-none lg:sticky lg:top-6">
            <ReadinessRail periodEnd={periodEnd} />
          </aside>
        </div>
      </div>
    </div>
  )
}
