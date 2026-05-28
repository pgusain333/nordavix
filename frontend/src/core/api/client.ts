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
}

apiClient.interceptors.request.use(async (config) => {
  if (_getToken) {
    const token = await _getToken()
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
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
    if (status === 401 && original && !original._nordavixAuthRetry && _getToken) {
      original._nordavixAuthRetry = true
      try {
        const fresh = await _getToken({ skipCache: true })
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
