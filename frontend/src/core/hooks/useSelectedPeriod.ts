/**
 * Cross-app "selected close period" — a single ISO YYYY-MM-DD that every
 * page uses as its default. When the user picks a month on the close
 * dashboard, every other app (Schedules, Reconciliations, Insights,
 * Financials, etc.) opens to the same period on next mount.
 *
 * Storage:
 *   localStorage key `nordavix:selected-period`, scoped per workspace
 *   via the active Clerk org id so switching companies doesn't carry
 *   the wrong month over.
 *
 * Behavior:
 *   - a `?period=YYYY-MM-DD` URL param wins over the stored value on mount,
 *     so a link that names a month lands on that month
 *   - readSelectedPeriod() — returns ISO date or null when unset
 *   - writeSelectedPeriod(iso) — persist; safe in private-mode browsers
 *   - useSelectedPeriodDefault(fallback) — returns the stored value on
 *     first render, else fallback. Subscribes to storage changes so a
 *     write in one tab updates others.
 */
import { useEffect, useState } from "react"
import { useOrganization } from "@clerk/clerk-react"

const KEY_PREFIX = "nordavix:selected-period"

function scopedKey(orgId: string | null | undefined): string {
  return orgId ? `${KEY_PREFIX}:${orgId}` : KEY_PREFIX
}

/**
 * A `?period=YYYY-MM-DD` in the URL, if present and well-formed.
 *
 * A link that names a period must land on that period. Task deep links, close
 * steps and anything shared between colleagues used to drop the month on the
 * floor — you clicked "Prepaids schedule · Mar 2026" and arrived on whatever
 * month your own localStorage happened to hold. The link is a more specific
 * intent than a stored default, so it wins.
 *
 * Read from window.location rather than useSearchParams so the plain
 * (non-hook) readers can use it too and no caller needs a Router context.
 */
export function periodFromUrl(): string | null {
  if (typeof window === "undefined") return null
  try {
    const v = new URLSearchParams(window.location.search).get("period")
    return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null
  } catch { return null }
}

export function readSelectedPeriod(orgId?: string | null): string | null {
  try {
    const v = localStorage.getItem(scopedKey(orgId))
    if (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v
  } catch { /* private mode — ignore */ }
  return null
}

export function writeSelectedPeriod(iso: string, orgId?: string | null): void {
  try {
    localStorage.setItem(scopedKey(orgId), iso)
  } catch { /* private mode — ignore */ }
}

/**
 * Read-only hook that returns the stored period or `fallback`. The
 * value is read ONCE on mount — apps own their own period state and
 * only consult this on first render so a user actively picking a date
 * on (e.g.) the Schedules page isn't yanked back to the dashboard's
 * selection mid-session.
 */
export function useSelectedPeriodDefault(fallback: string): string {
  const { organization } = useOrganization()
  const [val] = useState<string>(
    () => periodFromUrl() ?? readSelectedPeriod(organization?.id) ?? fallback,
  )
  return val
}

/**
 * Write-through for pages that derive their period from somewhere else — a
 * URL param on Reconciliations, a saved custom range on Financials and
 * Insights — and so can't hand ownership to useSelectedPeriod.
 *
 * The gap this closes: most pages READ the shared period on mount but never
 * wrote it back, so the month a user picked on Schedules didn't follow them
 * into Reconciliations. Publishing is enough — nobody is yanked mid-session,
 * because every reader takes its value once on mount.
 *
 * Ignores empty and malformed values, so a page can call it unconditionally
 * while its own state is still settling.
 */
export function usePublishSelectedPeriod(iso: string | null | undefined): void {
  const { organization } = useOrganization()
  useEffect(() => {
    if (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso)) writeSelectedPeriod(iso, organization?.id)
  }, [iso, organization?.id])
}

/**
 * Read + write — used by the dashboard's own month picker. Writes
 * propagate to every page that mounts after.
 */
export function useSelectedPeriod(fallback: string): [string, (iso: string) => void] {
  const { organization } = useOrganization()
  const [val, setVal] = useState<string>(
    () => periodFromUrl() ?? readSelectedPeriod(organization?.id) ?? fallback,
  )

  // Cross-tab sync — listen for storage events from other tabs and
  // resync local state. Same-tab updates write directly via setVal.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === scopedKey(organization?.id) && e.newValue && /^\d{4}-\d{2}-\d{2}$/.test(e.newValue)) {
        setVal(e.newValue)
      }
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [organization?.id])

  const set = (iso: string) => {
    setVal(iso)
    writeSelectedPeriod(iso, organization?.id)
  }
  return [val, set]
}
