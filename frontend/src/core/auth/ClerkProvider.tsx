/**
 * Clerk-side effects bridge.
 *
 *   1. Wires Clerk's session token into our axios client so every API
 *      request carries a valid Bearer token without callers handling it.
 *   2. Watches the active Clerk organization and resets the React Query
 *      cache when it changes — switching companies must show the new
 *      company's data, not stale cached data from the previous one.
 *
 * Mounted once inside ThreePaneLayout.
 */
import { useEffect, useRef } from "react"
import { useOrganization, useSession } from "@clerk/clerk-react"
import { useQueryClient } from "@tanstack/react-query"
import { setApiAuthProvider } from "@/core/api/client"

export function ClerkApiWirer(): null {
  const { session } = useSession()
  const { organization } = useOrganization()
  const queryClient = useQueryClient()
  const previousOrgId = useRef<string | null | undefined>(undefined)

  // Wire the auth token provider — runs on every session change. The
  // provider passes through the opts bag so the response interceptor
  // can request a cache-bypassing fresh token after a 401 (org-switch
  // race recovery).
  useEffect(() => {
    if (session) {
      setApiAuthProvider((opts) => session.getToken(opts))
    }
  }, [session])

  // Reset the entire React Query cache the moment Clerk reports a different
  // active org. The first render initializes the ref without resetting;
  // subsequent changes (user switched company) wipe stale data so the next
  // render fetches fresh data scoped to the new tenant.
  //
  // Also force-refresh Clerk's session-token cache: Clerk's getToken() is
  // cached per session, and although `setActive` invalidates it in theory,
  // we've seen the next API call still carry a stale JWT (org_id from
  // the previous workspace). Calling getToken({ skipCache: true }) here
  // bakes the new org_id into the cache before any /api/* request fires.
  useEffect(() => {
    const currentOrgId = organization?.id ?? null
    if (previousOrgId.current === undefined) {
      // First read — just remember it; nothing to reset on initial mount
      previousOrgId.current = currentOrgId
      return
    }
    if (previousOrgId.current !== currentOrgId) {
      // Hard reset: removeQueries clears cached data AND any in-flight
      // observers re-fetch with the new tenant scope on the next render.
      queryClient.removeQueries()
      previousOrgId.current = currentOrgId
      // Also wipe any localStorage caches we hydrate from — they're
      // not React Query state so removeQueries doesn't touch them.
      // Without this, the previous workspace's "QBO connected" can
      // leak into the new workspace's empty-state for one render.
      try {
        localStorage.removeItem("nordavix:qbo-connection-cache")
      } catch { /* private mode — ignore */ }
      // Force a fresh token so the new org_id reaches the backend on
      // the very next request. Fire-and-forget; failures are harmless
      // (the next request will fall through to a fresh getToken anyway).
      if (session) {
        session.getToken({ skipCache: true }).catch(() => {})
      }
    }
  }, [organization?.id, queryClient, session])

  return null
}
