import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { workspaceApi } from "@/modules/workspace/api"

/**
 * Resolve a set of internal user UUIDs into display names. Backed by the
 * /workspace/users/lookup endpoint and cached aggressively — names rarely
 * change inside a session. Empty/null IDs are dropped.
 *
 * Usage:
 *   const names = useUserNames([row.reviewed_by, row.approved_by])
 *   <span>{names[row.reviewed_by] ?? "—"}</span>
 */
export function useUserNames(ids: (string | null | undefined)[]): Record<string, string> {
  // Stable key so React Query doesn't refetch when the array reference
  // changes but the contents don't.
  const cleaned = useMemo(() => {
    const set = new Set<string>()
    for (const id of ids) if (id) set.add(id)
    return Array.from(set).sort()
  }, [ids])

  const { data } = useQuery({
    queryKey: ["user-names", cleaned.join(",")],
    queryFn:  () => workspaceApi.lookupUsers(cleaned),
    enabled:  cleaned.length > 0,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  })

  return useMemo(() => {
    const out: Record<string, string> = {}
    for (const id of cleaned) {
      out[id] = data?.[id]?.display_name ?? "—"
    }
    return out
  }, [cleaned, data])
}
