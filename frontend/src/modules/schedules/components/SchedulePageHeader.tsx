/**
 * Shared header for every schedule detail page.
 *
 * Back-link → /app/schedules, then title/blurb on the left and period
 * selector + "+ Add" button on the right. Uses the type's accent colour
 * so each page has a clear visual identity.
 */
import { Link } from "react-router-dom"
import { motion } from "framer-motion"
import { ArrowLeft, Download, Plus } from "lucide-react"
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
  /** When supplied, renders a "Download Excel" button (left of "+ Add").
   *  The handler should call schedulesApi.downloadScheduleExcel for the
   *  current type + period_end. We pass downloading separately so each
   *  page can drive its own spinner state. */
  onExport?:   () => void
  exporting?:  boolean
}

export function SchedulePageHeader({
  type, icon, accent, periodEnd, onPeriod, onAddItem, addLabel,
  onExport, exporting,
}: Props) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}
      className="px-4 sm:px-8 pt-3 sm:pt-4 pb-3"
      style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          {/* Icon-only back — same affordance + height as the recon / flux pages. */}
          <Link
            to="/app/schedules"
            className="flex items-center justify-center h-7 w-7 rounded-md transition-colors hover:bg-[var(--surface-2)] shrink-0"
            style={{ color: "var(--text-muted)" }}
            title="Back to schedules"
            aria-label="Back to schedules"
          >
            <ArrowLeft size={15} strokeWidth={1.8} />
          </Link>
          <div className="min-w-0">
            <div className="flex items-center gap-2 lg:hidden">
              <div className="h-7 w-7 rounded-md flex items-center justify-center shrink-0"
                style={{ background: accent.bg, color: accent.fg }}>
                {icon}
              </div>
              <h1 style={{ fontSize: "clamp(16px, 3vw, 20px)", fontWeight: 700, lineHeight: 1.15, letterSpacing: "-0.01em", color: "var(--text)", margin: 0 }}>
                {SCHEDULE_HUMAN[type]}
              </h1>
            </div>
            <p className="text-[11px] mt-0.5 truncate max-w-2xl" style={{ color: "var(--text-muted)" }}>
              {SCHEDULE_BLURB[type]}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap w-full sm:w-auto">
          <DatePicker
            value={periodEnd}
            onChange={onPeriod}
            className="inline-block"
            triggerClassName="inline-flex items-center gap-1.5 h-[26px] px-2.5 text-xs rounded-md outline-none transition-colors hover:bg-[var(--surface)]"
          />
          {onExport && (
            <Button
              size="sm"
              variant="outline"
              icon={<Download size={14} strokeWidth={2} />}
              onClick={onExport}
              loading={exporting}
              title="Download this schedule as Excel"
            >
              Excel
            </Button>
          )}
          <Button size="sm" icon={<Plus size={14} strokeWidth={2} />} onClick={onAddItem}>
            {addLabel ?? "Add item"}
          </Button>
        </div>
      </div>
    </motion.div>
  )
}
