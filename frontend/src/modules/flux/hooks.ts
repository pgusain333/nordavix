/**
 * Shared React Query wrappers for flux-module data that callers across
 * the app need. Currently just the QBO connection — it's checked
 * everywhere (dashboards, wizards, banners) and benefits from a single
 * source of truth + localStorage caching.
 */
import { useQuery } from "@tanstack/react-query"
import { api as fluxApi, type QboConnection } from "@/modules/flux/api"

const QBO_CACHE_KEY = "nordavix:qbo-connection-cache"

/**
 * useQboConnection — drop-in for the previous useQuery(["qbo-connection"]).
 *
 * On top of the regular fetch, this hook:
 *   1. Renders the cached value INSTANTLY on mount (via initialData),
 *      so refreshes don't flash the "QuickBooks isn't connected"
 *      banner for the 200–2500ms it takes Clerk + Fly to respond.
 *   2. Marks the initial data as already-stale so the query still
 *      refetches in the background to verify and update the cache.
 *   3. Writes through to localStorage on every successful fetch —
 *      sets the value when connected, clears it when disconnected.
 *
 * The cache survives page reloads and tab restores. Cross-tab sync
 * isn't needed (each tab refetches on mount anyway).
 */
export function useQboConnection() {
  return useQuery<QboConnection | null>({
    queryKey: ["qbo-connection"],
    queryFn:  async () => {
      const conn = await fluxApi.getQboConnection()
      try {
        if (conn) localStorage.setItem(QBO_CACHE_KEY, JSON.stringify(conn))
        else      localStorage.removeItem(QBO_CACHE_KEY)
      } catch { /* private mode / quota — ignore */ }
      return conn
    },
    // Hydrate from localStorage so the page renders the cached state
    // instantly. `undefined` falls back to React Query's normal loading
    // behavior (so a fresh session with no cache still works).
    initialData: () => {
      try {
        const raw = localStorage.getItem(QBO_CACHE_KEY)
        if (!raw) return undefined
        return JSON.parse(raw) as QboConnection
      } catch { return undefined }
    },
    // Pretend the cached value is from epoch — forces a background
    // refetch on mount to verify the connection is still good.
    initialDataUpdatedAt: 0,
    staleTime: 5 * 60_000,
  })
}
