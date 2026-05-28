/**
 * Shared header for every schedule detail page.
 *
 * Back-link → /app/schedules, then title/blurb on the left and period
 * selector + "+ Add" button on the right. Uses the type's accent colour
 * so each page has a clear visual identity.
 */
import { Link } from "react-router-dom"
import { motion } from "framer-motion"
import { ArrowLeft, Plus } from "lucide-react"
import { DatePicker } from "@/core/ui/DatePicker"
import { Button } from "@/core/ui/components"
import { SCHEDULE_BLURB, SCHEDULE_HUMAN, type ScheduleType } from "@/modules/schedules/types"

interface Props {
  type:        ScheduleType
  icon:        React.ReactNode
  accent:      { fg: string; bg: string }
  periodEnd:   string
  onPeriod:    (v: string) => void
  onAddItem:   () => void
  addLabel?:   string
}

export function SchedulePageHeader({
  type, icon, accent, periodEnd, onPeriod, onAddItem, addLabel,
}: Props) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}
      className="px-4 sm:px-8 pt-6 pb-5"
      style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
      <Link
        to="/app/schedules"
        className="inline-flex items-center gap-1 text-[11px] font-medium mb-3 transition-opacity hover:opacity-70"
        style={{ color: "var(--text-muted)" }}>
        <ArrowLeft size={12} strokeWidth={2} />
        Back to schedules
      </Link>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5 mb-1">
            <div className="h-9 w-9 rounded-lg flex items-center justify-center shrink-0"
              style={{ background: accent.bg, color: accent.fg }}>
              {icon}
            </div>
            <h1 className="text-2xl font-bold text-theme" style={{ letterSpacing: "-0.01em" }}>
              {SCHEDULE_HUMAN[type]}
            </h1>
          </div>
          <p className="text-xs sm:text-sm max-w-2xl" style={{ color: "var(--text-muted)" }}>
            {SCHEDULE_BLURB[type]}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="inline-flex items-center gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wide"
              style={{ color: "var(--text-muted)" }}>Period end</span>
            <DatePicker
              value={periodEnd}
              onChange={onPeriod}
              triggerClassName="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium border outline-none transition-colors"
            />
          </div>
          <Button size="sm" icon={<Plus size={14} strokeWidth={2} />} onClick={onAddItem}>
            {addLabel ?? "Add item"}
          </Button>
        </div>
      </div>
    </motion.div>
  )
}
