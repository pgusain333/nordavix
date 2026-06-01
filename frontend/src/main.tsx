import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider, keepPreviousData } from "@tanstack/react-query"
import { BrowserRouter } from "react-router-dom"
import { HelmetProvider } from "react-helmet-async"
import App from "./App"
import DevShell from "./DevShell"
import { ThemeProvider } from "@/core/theme/ThemeProvider"
import { LazyClerkProvider } from "@/core/auth/LazyClerk"
import "./index.css"

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string
const IS_DEV_PLACEHOLDER = !PUBLISHABLE_KEY || PUBLISHABLE_KEY.startsWith("pk_test_placeholder")

/**
 * Global TanStack Query defaults — tuned so the app feels instant and never
 * "stuck loading." None of this changes what the queries fetch or compute; it
 * only governs caching, retries, and when a refetch is allowed to run.
 *
 * Why these values:
 *   staleTime 60s            — a typical click reuses cache instead of
 *                              re-fetching; data still refreshes on the next
 *                              navigation once it's older than this.
 *   gcTime 5min              — keeps cache warm so back-nav is instant.
 *   placeholderData          — keepPreviousData: when a query's key changes
 *                              (switch month / period / account / tab / page),
 *                              the PREVIOUS data stays on screen while the new
 *                              data loads in the background — no spinner flash,
 *                              the screen never goes blank mid-navigation.
 *   refetchOnWindowFocus off — returning from another tab (e.g. QuickBooks)
 *                              no longer reloads every screen. That focus
 *                              refetch was the main "I tab back and it's
 *                              loading again" symptom; it also fired a burst
 *                              of requests on every return. Data still
 *                              refreshes on navigation (staleTime) and via the
 *                              explicit Sync buttons.
 *   refetchOnReconnect       — coming back from a network blip refreshes.
 *   retry (smart)            — NEVER retry 4xx (400/401/403/404/409/422/429):
 *                              those can't succeed on a retry, so retrying just
 *                              keeps the screen "loading" before showing the
 *                              error. Network / 5xx errors retry up to twice
 *                              with a short, capped backoff so a flaky request
 *                              recovers fast without a long hang.
 *   networkMode "online"     — pause queries when offline instead of firing
 *                              dead requests.
 *
 * Mutation defaults:
 *   retry 0                  — mutations should never silently double-fire.
 */
const NO_RETRY_STATUS = new Set([400, 401, 403, 404, 405, 409, 410, 422, 429])

function smartRetry(failureCount: number, error: unknown): boolean {
  const status = (error as { response?: { status?: number } })?.response?.status
  if (status && NO_RETRY_STATUS.has(status)) return false
  return failureCount < 2
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      gcTime:    5 * 60_000,
      placeholderData: keepPreviousData,
      retry: smartRetry,
      retryDelay: (attempt) => Math.min(800 * 2 ** attempt, 4000),
      refetchOnWindowFocus: false,
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
      <HelmetProvider>
        <ThemeProvider>
          <QueryClientProvider client={queryClient}>
            <BrowserRouter>
              <DevShell />
            </BrowserRouter>
          </QueryClientProvider>
        </ThemeProvider>
      </HelmetProvider>
    </StrictMode>,
  )
} else {
  if (!PUBLISHABLE_KEY) {
    throw new Error("VITE_CLERK_PUBLISHABLE_KEY is not set. Copy .env.example to frontend/.env.local.")
  }
  createRoot(root).render(
    <StrictMode>
      <HelmetProvider>
        <ThemeProvider>
          <LazyClerkProvider publishableKey={PUBLISHABLE_KEY}>
            <QueryClientProvider client={queryClient}>
              <BrowserRouter>
                <App />
              </BrowserRouter>
            </QueryClientProvider>
          </LazyClerkProvider>
        </ThemeProvider>
      </HelmetProvider>
    </StrictMode>,
  )
}
