/**
 * Re-exported from @clerk/clerk-react for convenience.
 * The actual ClerkProvider wrapping happens in main.tsx.
 *
 * This file wires Clerk's session token into the API client so every
 * axios request carries a valid Bearer token without callers needing
 * to handle auth themselves.
 */
import { useEffect } from "react"
import { useSession } from "@clerk/clerk-react"
import { setApiAuthProvider } from "@/core/api/client"

export function ClerkApiWirer(): null {
  const { session } = useSession()

  useEffect(() => {
    if (session) {
      setApiAuthProvider(() => session.getToken())
    }
  }, [session])

  return null
}
