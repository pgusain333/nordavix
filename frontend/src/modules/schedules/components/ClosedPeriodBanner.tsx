/**
 * Amber "this period is closed" banner shown atop a schedule page when the
 * selected month is locked. Renders nothing for open periods. Mirrors the
 * closed-period banners on the Recons and Flux dashboards.
 */
import { Lock } from "lucide-react"
import { useIsPeriodClosed } from "@/core/hooks/useIsPeriodClosed"

export function ClosedPeriodBanner({ periodEnd }: { periodEnd: string }) {
  const isClosed = useIsPeriodClosed(periodEnd)
  if (!isClosed) return null
  return (
    <div
      className="flex items-start gap-2.5 rounded-xl px-4 py-3"
      style={{ background: "rgba(199,154,82,0.12)", border: "1px solid #d8b070" }}
    >
      <Lock size={15} strokeWidth={2} style={{ color: "#a9762a", marginTop: 1 }} />
      <div>
        <p className="text-sm font-semibold" style={{ color: "#8a6326" }}>This period is closed</p>
        <p className="text-[12px] leading-snug" style={{ color: "#8a6326" }}>
          The books are locked for this month, so this schedule is read-only. Switch to an open
          month to edit going forward, or reopen the period from the Close Workflow.
        </p>
      </div>
    </div>
  )
}
