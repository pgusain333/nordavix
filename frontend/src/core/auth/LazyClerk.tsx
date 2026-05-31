/**
 * LazyClerk — code-splits @clerk/clerk-react out of the main bundle.
 *
 * Why this exists: a fresh visitor landing on /, /solutions, /blog, or
 * any other marketing route doesn't need the Clerk SDK at all. Bundling
 * it in main.tsx means every anonymous visitor pays ~100 KB of JS they
 * never touch. By wrapping ClerkProvider in React.lazy + Suspense, the
 * SDK is fetched only when the user actually hits an authenticated
 * route (or a route that renders Clerk's sign-in/up surface).
 *
 * Behavior is otherwise identical to the original setup:
 *   - Same publishableKey + sign-in URL config
 *   - Same redirect-after-auth targets
 *   - SignedIn / SignedOut / RedirectToSignIn still work
 *
 * The chunk loads in <300 ms on a typical connection because Clerk's
 * SDK is well-tree-shaken. While loading we render a tiny centered
 * Spinner — the same component the rest of the app uses for lazy
 * route fallbacks, so it feels like an extension of the normal
 * loading state, not a separate auth-boot step.
 */
import { lazy, Suspense, type ReactNode } from "react"
import { Spinner } from "@/core/ui/components"

// React.lazy needs a default export — wrap Clerk's named export.
const ClerkProvider = lazy(() =>
  import("@clerk/clerk-react").then((m) => ({ default: m.ClerkProvider })),
)

interface LazyClerkProps {
  publishableKey: string
  children:       ReactNode
}

function ClerkBootSpinner() {
  return (
    <div className="h-screen w-full flex items-center justify-center"
      style={{ background: "var(--bg)" }}>
      <Spinner className="h-6 w-6" />
    </div>
  )
}

export function LazyClerkProvider({ publishableKey, children }: LazyClerkProps) {
  return (
    <Suspense fallback={<ClerkBootSpinner />}>
      <ClerkProvider
        publishableKey={publishableKey}
        signInUrl="/sign-in"
        signUpUrl="/sign-up"
        signInFallbackRedirectUrl="/app"
        signUpFallbackRedirectUrl="/app"
      >
        {children}
      </ClerkProvider>
    </Suspense>
  )
}
