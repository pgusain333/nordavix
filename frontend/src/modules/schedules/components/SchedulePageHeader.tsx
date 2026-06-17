/**
 * Shared header for every schedule detail page.
 *
 * Uses the app-wide <PageHeader> so the schedule's name is ALWAYS shown on
 * the bar (identical chrome + height to every other module), with the type's
 * blurb as the one-line subtitle and the period picker / Excel / Add controls
 * on the right. Back goes to /app/schedules.
 *
 * `icon` / `accent` remain in the props (callers still pass them) but are no
 * longer rendered — PageHeader is icon-less by design, matching the rest of
 * the app. Kept on the interface so the five callers don't need to change.
 */
import { Download, Plus } from "lucide-react"
import { DatePicker } from "@/core/ui/DatePicker"
import { Button } from "@/core/ui/components"
import { PageHeader } from "@/core/ui/PageHeader"
import { CommitPeriodButton } from "@/modules/schedules/components/CommitPeriodButton"
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
  type, periodEnd, onPeriod, onAddItem, addLabel, onExport, exporting,
}: Props) {
  return (
    <PageHeader
      title={SCHEDULE_HUMAN[type]}
      subtitle={SCHEDULE_BLURB[type]}
      backTo="/app/schedules"
      actions={
        <>
          <DatePicker value={periodEnd} onChange={onPeriod} />
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
          <CommitPeriodButton scheduleType={type} periodEnd={periodEnd} />
          <Button size="sm" icon={<Plus size={14} strokeWidth={2} />} onClick={onAddItem}>
            {addLabel ?? "Add item"}
          </Button>
        </>
      }
    />
  )
}
