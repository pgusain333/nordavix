import axios, { type AxiosRequestConfig } from "axios"

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000"

export const apiClient = axios.create({
  baseURL: BASE_URL,
  headers: { "Content-Type": "application/json" },
})

/**
 * Call this once after Clerk initializes to inject the session token into
 * every outgoing request. Clerk tokens are short-lived; the interceptor
 * fetches a fresh one per request via getToken() which uses Clerk's cache.
 *
 * The provider receives an options bag so the response interceptor can
 * force a cache-bypassing token mint after a 401 (Clerk's local token
 * cache sometimes lags an org switch by a few hundred ms).
 *
 * Usage in ClerkProvider.tsx:
 *   setApiAuthProvider((opts) => session.getToken(opts))
 */
type GetTokenOpts = { skipCache?: boolean }
let _getToken: ((opts?: GetTokenOpts) => Promise<string | null>) | null = null

export function setApiAuthProvider(
  getToken: (opts?: GetTokenOpts) => Promise<string | null>,
): void {
  _getToken = getToken
  // Wipe any cached token; the new provider owns auth from here on.
  _tokenCache = null
}

/**
 * Demo mode: when the registered provider returns true, every request carries
 * the `X-Nordavix-Demo` header so the backend serves the read-only sample
 * tenant. Set by DemoModeProvider; reads localStorage so it's race-free.
 */
let _isDemo: (() => boolean) | null = null
export function setDemoModeProvider(fn: () => boolean): void {
  _isDemo = fn
}

/**
 * Tiny in-flight token cache: Clerk's getToken is internally cached, but
 * still triggers a microtask + promise round-trip per call. When the UI
 * fires a burst of mutations (e.g. bulk-approve 12 recon rows at once),
 * that's 12 sequential awaits. Coalescing them in-memory for a few
 * seconds drops each subsequent request's auth overhead to ~0ms.
 *
 * Skipped entirely when `skipCache` is requested (401 retry path).
 */
type CachedToken = { token: string; expiresAt: number }
let _tokenCache: CachedToken | null    = null
let _tokenInflight: Promise<string | null> | null = null
const TOKEN_TTL_MS = 4_000   // shorter than Clerk's own 60s — just to coalesce bursts.

async function obtainToken(opts?: GetTokenOpts): Promise<string | null> {
  if (!_getToken) return null

  // Bypass the in-flight cache on explicit skipCache (401 retry).
  if (opts?.skipCache) {
    _tokenCache    = null
    _tokenInflight = null
    return _getToken({ skipCache: true })
  }

  const now = Date.now()
  if (_tokenCache && _tokenCache.expiresAt > now) {
    return _tokenCache.token
  }
  if (_tokenInflight) return _tokenInflight

  _tokenInflight = (async () => {
    try {
      const t = await _getToken!()
      if (t) {
        _tokenCache = { token: t, expiresAt: Date.now() + TOKEN_TTL_MS }
      }
      return t
    } finally {
      _tokenInflight = null
    }
  })()
  return _tokenInflight
}

/** External entrypoint for ClerkProvider's org-switch effect to drop
 *  the cached token instantly (so the next request mints a fresh one
 *  scoped to the new org). */
export function clearApiTokenCache(): void {
  _tokenCache    = null
  _tokenInflight = null
}

/** API origin — exported so non-axios callers (SSE via fetch) hit the same host. */
export const API_BASE_URL = BASE_URL

/**
 * Auth + demo headers for callers that can't use the axios instance — e.g. the
 * assistant's SSE stream, which uses fetch() to read a ReadableStream. Mirrors
 * the request interceptor: a fresh Clerk Bearer token (coalesced via the same
 * cache) plus the demo header when demo mode is active.
 */
export async function authHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {}
  const token = await obtainToken()
  if (token) headers.Authorization = `Bearer ${token}`
  if (_isDemo?.()) headers["X-Nordavix-Demo"] = "1"
  return headers
}

apiClient.interceptors.request.use(async (config) => {
  if (_getToken) {
    const token = await obtainToken()
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
  }
  // Read-only sample-company demo: route reads to the seeded demo tenant.
  if (_isDemo?.()) {
    config.headers["X-Nordavix-Demo"] = "1"
  }
  return config
})

// Internal marker so we only retry an auth-bounced request once. Without
// this guard, a permanently-bad token would loop forever.
type RetryableConfig = AxiosRequestConfig & { _nordavixAuthRetry?: boolean }

apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    // Self-heal stale-JWT races: right after createOrganization /
    // setActive, Clerk's session-token cache can briefly hold a JWT
    // with the OLD (or empty) org_id. The first /api/* request fires
    // with that stale token and the backend tenant filter rejects it
    // with 401. Re-mint a token bypassing Clerk's cache and replay
    // the request once — by then the new org_id has propagated.
    //
    // Only retries 401s, and only once per request, so a genuinely
    // expired session still bubbles up as an error after one attempt.
    const status   = error?.response?.status
    const original = error?.config as RetryableConfig | undefined

    // The active workspace was deleted (soft-deleted on the backend). Every
    // request to it now returns 410 tenant_deleted. This happens when a
    // workspace is deleted in another tab, or a refetch races the delete
    // flow. Bounce the user to the company picker so they pick a live
    // workspace. Guard against a redirect loop: only redirect when we're not
    // already on the companies page.
    if (status === 410 && error?.response?.data?.code === "tenant_deleted") {
      try {
        clearApiTokenCache()
        const path = window.location.pathname
        if (!path.startsWith("/app/companies")) {
          window.location.assign("/app/companies")
        }
      } catch { /* non-browser / SSR — ignore */ }
      return Promise.reject(error)
    }

    if (status === 401 && original && !original._nordavixAuthRetry && _getToken) {
      original._nordavixAuthRetry = true
      try {
        // skipCache:true bypasses our in-memory cache AND Clerk's cache.
        const fresh = await obtainToken({ skipCache: true })
        if (fresh) {
          original.headers = { ...(original.headers ?? {}), Authorization: `Bearer ${fresh}` }
          return apiClient.request(original)
        }
      } catch {
        // Falls through to the standard error path below.
      }
    }
    // Let callers handle non-recoverable errors; don't swallow them.
    // Sentry will pick these up via its axios integration if configured.
    return Promise.reject(error)
  },
)
