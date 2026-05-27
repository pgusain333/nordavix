/**
 * Shared React Query wrappers for recons-module data the dashboard +
 * other surfaces need. Currently just the books-status hook — it's
 * the answer to "should the setup-books CTA flash on every refresh?"
 *
 * Pattern mirrors `flux/hooks.ts::useQboConnection`: localStorage
 * cache → instant render on mount → background fetch verifies.
 */
import { useQuery } from "@tanstack/react-query"

import { reconsApi, type BooksStatus } from "@/modules/recons/api"

const BOOKS_STATUS_CACHE_KEY = "nordavix:books-status-cache"

/**
 * useBooksStatus — drop-in for the old useQuery(["books-status"]).
 *
 * Why this hook exists: on every page refresh the React Query for
 * /setup/books-status takes 200–2500ms to round-trip while
 * `data` is undefined. During that window, components that gate on
 * `books?.seeded` see undefined → falsy → render their NOT-SEEDED
 * branch (the "Welcome — finish the setup below" hero and the
 * "Set up books to enable the tracker" CTA card). Then the response
 * arrives with seeded=true and the UI snaps to the real dashboard.
 *
 * The flash is small but visible and "setup screen → real screen"
 * is a really jarring transition because they look nothing alike.
 *
 * Fix: hydrate from localStorage so the cached `seeded: true` ships
 * with the initial render. React Query still refetches in the
 * background (initialDataUpdatedAt = 0 marks it pre-stale) so a
 * change between sessions still flows through.
 *
 * Write-through: on every successful fetch we mirror the result back
 * to localStorage. When seeded flips false (rare — books reset), we
 * remove the cache so the next refresh doesn't show a stale "seeded"
 * state until the response lands.
 */
export function useBooksStatus() {
  return useQuery<BooksStatus>({
    queryKey: ["books-status"],
    queryFn:  async () => {
      const data = await reconsApi.getBooksStatus()
      try {
        if (data.seeded) {
          localStorage.setItem(BOOKS_STATUS_CACHE_KEY, JSON.stringify(data))
        } else {
          localStorage.removeItem(BOOKS_STATUS_CACHE_KEY)
        }
      } catch { /* private mode / quota — ignore */ }
      return data
    },
    initialData: () => {
      try {
        const raw = localStorage.getItem(BOOKS_STATUS_CACHE_KEY)
        if (!raw) return undefined
        const parsed = JSON.parse(raw) as BooksStatus
        // Defensive: only honor the cache if it parses to the
        // expected shape AND seeded=true. We never cache the
        // un-seeded state.
        if (typeof parsed?.seeded === "boolean" && parsed.seeded) return parsed
        return undefined
      } catch { return undefined }
    },
    // Force a background refetch on mount so the cached value gets
    // verified against the server.
    initialDataUpdatedAt: 0,
    staleTime: 5 * 60_000,
  })
}
