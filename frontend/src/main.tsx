import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { ClerkProvider } from "@clerk/clerk-react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { BrowserRouter } from "react-router-dom"
import App from "./App"
import DevShell from "./DevShell"
import { ThemeProvider } from "@/core/theme/ThemeProvider"
import "./index.css"

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string
const IS_DEV_PLACEHOLDER = !PUBLISHABLE_KEY || PUBLISHABLE_KEY.startsWith("pk_test_placeholder")

/**
 * Global TanStack Query defaults — tuned for "instant updates, no hard
 * refresh." The goal is that every query is opportunistically fresh
 * without anyone having to click a Refresh button.
 *
 * Why these values:
 *   staleTime 60s            — long enough that a typical click doesn't
 *                              trigger a redundant fetch; short enough
 *                              that crossing a tab gets you fresh data.
 *   gcTime 5min              — keeps cache warm so back-nav is instant.
 *   refetchOnWindowFocus     — tabbing back to Nordavix silently
 *                              refreshes anything stale (cheap, smooth).
 *   refetchOnReconnect       — coming back from network blip refreshes.
 *   retry 1                  — one auto-retry on flaky networks; more
 *                              than that just delays error UX.
 *   networkMode "online"     — pause queries when offline instead of
 *                              firing dead requests.
 *
 * Mutation defaults:
 *   retry 0                  — mutations should never silently double-fire.
 *   networkMode "online"     — same as queries.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      gcTime:    5 * 60_000,
      retry: 1,
      refetchOnWindowFocus: true,
      refetchOnReconnect:   true,
      networkMode: "online",
    },
    mutations: {
      retry: 0,
      networkMode: "online",
    },
  },
})

const root = document.getElementById("root")
if (!root) throw new Error("Root element not found")

// When a real Clerk key is not configured, render the layout shell directly
// so the UI can be developed and previewed without auth infrastructure.
// This branch is never reached in production (VITE_ vars are baked at build time).
if (IS_DEV_PLACEHOLDER) {
  createRoot(root).render(
    <StrictMode>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <DevShell />
          </BrowserRouter>
        </QueryClientProvider>
      </ThemeProvider>
    </StrictMode>,
  )
} else {
  if (!PUBLISHABLE_KEY) {
    throw new Error("VITE_CLERK_PUBLISHABLE_KEY is not set. Copy .env.example to frontend/.env.local.")
  }
  createRoot(root).render(
    <StrictMode>
      <ThemeProvider>
        <ClerkProvider
          publishableKey={PUBLISHABLE_KEY}
          signInUrl="/sign-in"
          signUpUrl="/sign-up"
          signInFallbackRedirectUrl="/app"
          signUpFallbackRedirectUrl="/app"
        >
          <QueryClientProvider client={queryClient}>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </QueryClientProvider>
        </ClerkProvider>
      </ThemeProvider>
    </StrictMode>,
  )
}
