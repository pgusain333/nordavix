/**
 * useCookieConsent — single source of truth for the user's cookie
 * consent state. Persists to localStorage under a versioned key so
 * we can force a re-prompt if the policy changes (bump the version
 * and old saves stop matching).
 *
 * Categories:
 *   - strictly_necessary  always true — required for login, CSRF,
 *                         session continuity. Cannot be turned off.
 *   - functional          theme preference, active workspace pin,
 *                         sidebar collapsed state, etc.
 *   - analytics           aggregate usage measurement. Currently we
 *                         don't ship a third-party analytics SDK,
 *                         but the toggle is here so we can wire one
 *                         in later without re-prompting users.
 *
 * Compliance posture: equal prominence for Accept and Reject; no
 * categories pre-checked except strictly_necessary; user choice is
 * captured + timestamped + versioned. "Customized" status means the
 * user opened the preferences dialog and saved specific toggles
 * rather than blanket accepting/rejecting.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react"

const STORAGE_KEY = "nordavix.cookies.v1"
/** Bump when the cookies in use change in a way that requires re-consent. */
const POLICY_VERSION = 1

export type ConsentStatus = "unknown" | "accepted" | "rejected" | "customized"

export interface CookiePreferences {
  strictly_necessary: true
  functional:         boolean
  analytics:          boolean
}

export interface ConsentRecord {
  status:      ConsentStatus
  preferences: CookiePreferences
  /** ISO timestamp of the user's most recent decision. */
  decided_at:  string | null
  /** Policy version at the time of the decision. */
  version:     number
}

const DEFAULT_PREFERENCES: CookiePreferences = {
  strictly_necessary: true,
  functional:         false,
  analytics:          false,
}

const INITIAL_RECORD: ConsentRecord = {
  status:      "unknown",
  preferences: DEFAULT_PREFERENCES,
  decided_at:  null,
  version:     POLICY_VERSION,
}

// ── Cross-component subscription plumbing ───────────────────────────────────
// useSyncExternalStore so multiple mounted instances of the hook (banner +
// preferences dialog + footer button) all see the same state without
// prop-drilling. Updates flow through a single broadcaster.

type Listener = () => void
const listeners = new Set<Listener>()
function notify() { listeners.forEach((l) => l()) }
function subscribe(cb: Listener) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function readFromStorage(): ConsentRecord {
  if (typeof window === "undefined") return INITIAL_RECORD
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return INITIAL_RECORD
    const parsed = JSON.parse(raw) as ConsentRecord
    // If the policy version has moved on since their last decision,
    // treat them as "unknown" again — we need fresh consent.
    if (parsed.version !== POLICY_VERSION) return INITIAL_RECORD
    return {
      ...INITIAL_RECORD,
      ...parsed,
      preferences: { ...DEFAULT_PREFERENCES, ...parsed.preferences },
    }
  } catch {
    return INITIAL_RECORD
  }
}

function writeToStorage(record: ConsentRecord) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(record))
  } catch {
    // Safari private mode / quota errors — silently ignore.
  }
}

// Cache the latest snapshot so getSnapshot returns referentially-stable
// data between subscribe → notify cycles. useSyncExternalStore requires
// stable identity until something actually changes.
let snapshot: ConsentRecord = readFromStorage()

function getSnapshot(): ConsentRecord { return snapshot }
function getServerSnapshot(): ConsentRecord { return INITIAL_RECORD }

function updateRecord(next: ConsentRecord) {
  snapshot = next
  writeToStorage(next)
  notify()
}

// ── Hook ────────────────────────────────────────────────────────────────────

export function useCookieConsent() {
  const record = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

  // Cross-tab sync — if the user opens preferences in another tab and saves,
  // we refresh our snapshot from storage so the banner / dialog update here.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return
      snapshot = readFromStorage()
      notify()
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [])

  const acceptAll = useCallback(() => {
    updateRecord({
      status: "accepted",
      preferences: { strictly_necessary: true, functional: true, analytics: true },
      decided_at: new Date().toISOString(),
      version: POLICY_VERSION,
    })
  }, [])

  const rejectAll = useCallback(() => {
    updateRecord({
      status: "rejected",
      preferences: { strictly_necessary: true, functional: false, analytics: false },
      decided_at: new Date().toISOString(),
      version: POLICY_VERSION,
    })
  }, [])

  const savePreferences = useCallback((prefs: Partial<CookiePreferences>) => {
    updateRecord({
      status: "customized",
      preferences: {
        strictly_necessary: true,
        functional: prefs.functional ?? false,
        analytics:  prefs.analytics  ?? false,
      },
      decided_at: new Date().toISOString(),
      version: POLICY_VERSION,
    })
  }, [])

  /** Wipe the user's decision so the banner re-appears on next render.
   *  Used by tests / debug controls / "I changed my mind" flows. */
  const reset = useCallback(() => {
    if (typeof window !== "undefined") {
      try { window.localStorage.removeItem(STORAGE_KEY) } catch { /* noop */ }
    }
    snapshot = INITIAL_RECORD
    notify()
  }, [])

  return {
    status:           record.status,
    preferences:      record.preferences,
    decidedAt:        record.decided_at,
    needsDecision:    record.status === "unknown",
    acceptAll,
    rejectAll,
    savePreferences,
    reset,
  }
}

// ── Global re-open trigger ──────────────────────────────────────────────────
// Footer "Cookie preferences" links anywhere in the app dispatch this event;
// the CookieBanner listens for it and opens the dialog without needing the
// component tree to be wired up via props/context.

const REOPEN_EVENT = "nordavix:cookies:open"

export function openCookiePreferences() {
  if (typeof window === "undefined") return
  window.dispatchEvent(new Event(REOPEN_EVENT))
}

export function onCookiePreferencesRequested(cb: () => void) {
  if (typeof window === "undefined") return () => {}
  window.addEventListener(REOPEN_EVENT, cb)
  return () => window.removeEventListener(REOPEN_EVENT, cb)
}
