/**
 * Optimistic-update helpers for schedule pages (prepaid, accrual, fixed_asset,
 * lease, loan). Each page owns its query key + item type, but the cache-patch
 * dance is identical: cancel in-flight refetch → snapshot → mutate → roll back
 * on error → invalidate on settle so the truth from the server lands.
 *
 * Why this helper exists: every schedule add/edit/delete used to wait the full
 * 200-500ms server roundtrip before the row reflected the change. With the
 * helper, the UI flips instantly while the request is still in flight.
 *
 * Usage:
 *   const optimistic = useScheduleOptimistic("prepaid", filterAccount)
 *   const deleteMut = useMutation({
 *     mutationFn: (id: string) => schedulesApi.deleteItem("prepaid", id),
 *     onMutate:   (id)        => optimistic.beginDelete(id),
 *     onError:    (_e, _v, c) => optimistic.rollback(c),
 *     onSettled:  ()          => optimistic.settle(),
 *   })
 */
import { type QueryClient, useQueryClient } from "@tanstack/react-query"
import type { ScheduleType } from "@/modules/schedules/types"

type AnyItem = { id: string;[k: string]: unknown }
type ListResponse = { schedule_type: ScheduleType; items: AnyItem[] }

interface OptimisticContext {
  /** Tuple of [queryKey, snapshot] entries so rollback can restore exactly
   *  what was cached, even across multiple filter-account variants. */
  snapshots: Array<[readonly unknown[], ListResponse | undefined]>
}

/** Cancel any in-flight refetch + snapshot the current cache values that
 *  match `["schedules", type, "items", ...]`. Returns a context object the
 *  rollback handler can use to put state back. */
async function snapshotItemsLists(
  qc: QueryClient, type: ScheduleType,
): Promise<OptimisticContext> {
  // Cancel pending refetches so they don't clobber our optimistic update.
  await qc.cancelQueries({ queryKey: ["schedules", type, "items"] })

  // Find every active query that matches the items list shape — there can
  // be more than one if the user has flipped filterAccount multiple times.
  const matches = qc.getQueriesData<ListResponse>({
    queryKey: ["schedules", type, "items"],
  })
  return { snapshots: matches.map(([key, data]) => [key, data]) }
}

/** Apply `mutator` to every cached items-list for this schedule type. */
function patchAllLists(
  qc: QueryClient,
  type: ScheduleType,
  mutator: (items: AnyItem[]) => AnyItem[],
): void {
  qc.setQueriesData<ListResponse>(
    { queryKey: ["schedules", type, "items"] },
    (prev) => {
      if (!prev) return prev
      return { ...prev, items: mutator(prev.items) }
    },
  )
}

/** Restore the snapshotted lists, used as `onError`. */
function rollbackLists(qc: QueryClient, ctx: OptimisticContext | undefined): void {
  if (!ctx) return
  for (const [key, data] of ctx.snapshots) {
    qc.setQueryData(key, data)
  }
}

/** React hook that bundles all helpers for one schedule type. */
export function useScheduleOptimistic(type: ScheduleType) {
  const qc = useQueryClient()

  return {
    /** Call from `onMutate` when deleting. Removes the row instantly. */
    beginDelete: async (id: string): Promise<OptimisticContext> => {
      const ctx = await snapshotItemsLists(qc, type)
      patchAllLists(qc, type, (items) => items.filter((it) => it.id !== id))
      return ctx
    },

    /** Call from `onMutate` when updating. Patches the matching row instantly. */
    beginUpdate: async (id: string, patch: Partial<AnyItem>): Promise<OptimisticContext> => {
      const ctx = await snapshotItemsLists(qc, type)
      patchAllLists(qc, type, (items) =>
        items.map((it) => (it.id === id ? { ...it, ...patch } : it)),
      )
      return ctx
    },

    /** Call from `onMutate` when creating. Inserts a placeholder row instantly
     *  with a temp id so it shows up at the top of the list. Server response
     *  will reconcile via the settle/invalidate. */
    beginCreate: async (placeholder: AnyItem): Promise<OptimisticContext> => {
      const ctx = await snapshotItemsLists(qc, type)
      patchAllLists(qc, type, (items) => [placeholder, ...items])
      return ctx
    },

    /** Standard `onError` handler — restores the snapshot. */
    rollback: (ctx: OptimisticContext | undefined) => rollbackLists(qc, ctx),

    /** Standard `onSettled` handler — invalidates so the server truth lands. */
    settle: () => {
      qc.invalidateQueries({ queryKey: ["schedules"] })
    },
  }
}
