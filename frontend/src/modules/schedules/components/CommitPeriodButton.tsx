/**
 * Always-visible "Commit this period" action for the schedule page header.
 *
 * One click commits the period roll-forward for EVERY GL account that has active
 * items in this schedule — no need to drill into each account first. When the
 * schedule has no items there's nothing to roll forward, so the button shows a
 * clear, disabled "Nothing to commit" (an empty schedule never blocks the close).
 *
 * Self-contained: it reads the unfiltered item list to decide enabled/empty, and
 * on success invalidates the schedule, recon, and close caches so the roll-forward
 * cards, recon subledger, and close checklist all refresh.
 */
import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useOrganization } from "@clerk/clerk-react"
import { CheckCircle2, FileCheck2 } from "lucide-react"
import { Button } from "@/core/ui/components"
import { schedulesApi } from "@/modules/schedules/api"
import type { ScheduleType } from "@/modules/schedules/types"

export function CommitPeriodButton({
  scheduleType,
  periodEnd,
}: {
  scheduleType: ScheduleType
  periodEnd: string
}) {
  const qc = useQueryClient()
  const { organization } = useOrganization()
  const [justDone, setJustDone] = useState(false)

  // Unfiltered item list → the distinct GL accounts that actually have active
  // items. Drives the enabled / "nothing to commit" state without the user
  // having to pick an account.
  const { data: itemsResp } = useQuery({
    queryKey: ["schedules", scheduleType, "items", ""],
    queryFn:  () => schedulesApi.listItems(scheduleType, {}),
    enabled:  !!organization,
  })
  const accountCount = useMemo(() => {
    const ids = new Set(
      (itemsResp?.items ?? [])
        .filter((i) => i.is_active && i.qbo_account_id)
        .map((i) => i.qbo_account_id),
    )
    return ids.size
  }, [itemsResp])

  const commitMut = useMutation({
    mutationFn: () => schedulesApi.commitAllSnapshots(scheduleType, periodEnd),
    onSuccess: () => {
      // Refresh the roll-forward cards, the recon subledger (commit re-flags
      // approved recons), and the close checklist / schedule chips.
      qc.invalidateQueries({ queryKey: ["schedules", scheduleType] })
      qc.invalidateQueries({ queryKey: ["recons-overview"] })
      qc.invalidateQueries({ queryKey: ["close"] })
      setJustDone(true)
      setTimeout(() => setJustDone(false), 2500)
    },
  })

  if (accountCount === 0) {
    return (
      <Button
        size="sm"
        variant="outline"
        disabled
        title="No items in this schedule for the period — nothing to commit. This schedule won't block your close."
      >
        Nothing to commit
      </Button>
    )
  }

  return (
    <Button
      size="sm"
      variant="outline"
      loading={commitMut.isPending}
      onClick={() => commitMut.mutate()}
      icon={justDone
        ? <CheckCircle2 size={14} strokeWidth={2} style={{ color: "var(--green)" }} />
        : <FileCheck2 size={14} strokeWidth={2} />}
      title={`Commit the roll-forward for all ${accountCount} account${accountCount === 1 ? "" : "s"} with items this period`}
    >
      {justDone ? "Committed" : accountCount > 1 ? `Commit period (${accountCount})` : "Commit period"}
    </Button>
  )
}
