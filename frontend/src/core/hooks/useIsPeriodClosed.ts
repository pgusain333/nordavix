/**
 * useIsPeriodClosed — true when the given period_end (YYYY-MM-DD) is a closed
 * (locked) period for the active workspace.
 *
 * Shared so the Schedules pages can go read-only on a closed month, matching the
 * Recons and Flux dashboards. Sources the same `listClosedPeriods` list those
 * modules already use, so there's one source of truth for "is this month locked".
 */
import { useQuery } from "@tanstack/react-query"
import { useOrganization } from "@clerk/clerk-react"
import { reconsApi } from "@/modules/recons/api"

export function useIsPeriodClosed(periodEnd: string): boolean {
  const { organization } = useOrganization()
  const { data: closed = [] } = useQuery({
    queryKey: ["recons", "closed-periods"],
    queryFn:  reconsApi.listClosedPeriods,
    enabled:  !!organization,
    staleTime: 60_000,
  })
  return !!periodEnd && closed.some((c) => c.period_end === periodEnd)
}
