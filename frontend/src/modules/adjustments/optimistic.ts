/**
 * Optimistic cache helpers for adjustments.
 *
 * Every adjustment surface — the consolidated queue (["adjustments","queue"])
 * and each inline list (["adjustments", source, sourceRef, period]) — reads the
 * same shared cache. These helpers patch ALL of those queries at once so an
 * Approve / Dismiss / re-point / Save reflects instantly, before the server
 * round-trip, then reconcile on settle (and roll back on error).
 */
import type { QueryClient, QueryKey } from "@tanstack/react-query"

import type { ProposedEntry, ProposedEntryList } from "./api"

type Snapshot = [QueryKey, ProposedEntryList | undefined][]

/** Apply `patch` to every cached proposed entry matching `match`, across all
 *  ["adjustments", …] list queries. Recomputes open_count so tab badges and the
 *  "all approved" gating update in the same paint. Non-list adjustments queries
 *  (e.g. the accounts lookup) are array-shaped and left untouched by the guard. */
export function patchAdjustments(
  qc: QueryClient,
  match: (e: ProposedEntry) => boolean,
  patch: Partial<ProposedEntry>,
): void {
  qc.setQueriesData<ProposedEntryList>({ queryKey: ["adjustments"] }, (old) => {
    if (!old || !Array.isArray(old.items)) return old
    let openDelta = 0
    const items = old.items.map((e) => {
      if (!match(e)) return e
      const next = { ...e, ...patch } as ProposedEntry
      if (e.status === "open" && next.status !== "open") openDelta -= 1
      return next
    })
    return { ...old, items, open_count: Math.max(0, (old.open_count ?? 0) + openDelta) }
  })
}

/** Lifecycle handlers for an optimistic adjustments mutation: patch immediately,
 *  roll back the exact prior snapshot on error, reconcile with the server on
 *  settle. Spread onto a useMutation for instant, safe updates. */
export function optimisticAdjust<TVars = void>(
  qc: QueryClient,
  match: (e: ProposedEntry) => boolean,
  patch: Partial<ProposedEntry>,
) {
  return {
    onMutate: async (_vars: TVars): Promise<{ prev: Snapshot }> => {
      await qc.cancelQueries({ queryKey: ["adjustments"] })
      const prev = qc.getQueriesData<ProposedEntryList>({ queryKey: ["adjustments"] }) as Snapshot
      patchAdjustments(qc, match, patch)
      return { prev }
    },
    onError: (_err: unknown, _vars: TVars, ctx: { prev: Snapshot } | undefined) => {
      ctx?.prev?.forEach(([k, d]) => qc.setQueryData(k, d))
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["adjustments"] })
    },
  }
}
