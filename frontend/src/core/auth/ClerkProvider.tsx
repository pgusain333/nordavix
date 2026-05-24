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

  // Wire the auth token provider — runs on every session change.
  useEffect(() => {
    if (session) {
      setApiAuthProvider(() => session.getToken())
    }
  }, [session])

  // Reset the entire React Query cache the moment Clerk reports a different
  // active org. The first render initializes the ref without resetting;
  // subsequent changes (user switched company) wipe stale data so the next
  // render fetches fresh data scoped to the new tenant.
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
    }
  }, [organization?.id, queryClient])

  return null
}
