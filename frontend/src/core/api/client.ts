import axios from "axios"

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
 * Usage in ClerkProvider.tsx:
 *   setApiAuthProvider(() => session.getToken)
 */
let _getToken: (() => Promise<string | null>) | null = null

export function setApiAuthProvider(getToken: () => Promise<string | null>): void {
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

apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    // Let callers handle errors; don't swallow them here.
    // Sentry will pick these up via its axios integration if configured.
    return Promise.reject(error)
  },
)
