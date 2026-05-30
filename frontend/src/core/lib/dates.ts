/**
 * Date formatting helpers — single source of truth for how dates render
 * across the app. US accounting convention: MM-DD-YYYY for day-precision
 * dates everywhere (audit log, due dates, joined-on, period ends, etc.).
 *
 * Why MM-DD-YYYY (not slashes)? Hyphens are unambiguous when copy-pasted
 * into Excel or another tool — slashes get re-parsed by the destination
 * locale (a Brit reading "03/04/2024" assumes April 3 instead of March 4).
 * Hyphens are inert: they always read as written.
 *
 * Use formatDate for any day-precision date the user reads (NOT for
 * filenames or API payloads — those stay ISO YYYY-MM-DD).
 *
 * Month-only labels ("Mar 2024", "March 2024") are intentionally left
 * to call sites — they aren't full dates and the long-month form is
 * more readable in headers than MM-YYYY would be.
 */

type DateLike = string | number | Date | null | undefined

function toDate(d: DateLike): Date | null {
  if (d == null || d === "") return null
  if (d instanceof Date) return isNaN(d.getTime()) ? null : d
  // ISO YYYY-MM-DD without time → anchor at local midnight so timezone
  // doesn't shift the displayed day backward (a "2024-03-15" input
  // shouldn't render as "03-14-2024" in PST due to UTC parsing).
  if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
    const out = new Date(d + "T00:00:00")
    return isNaN(out.getTime()) ? null : out
  }
  const out = new Date(d)
  return isNaN(out.getTime()) ? null : out
}

function pad2(n: number): string { return n.toString().padStart(2, "0") }

/**
 * Format as MM-DD-YYYY. Empty string for nullish/invalid input.
 * This is the default for any user-visible date in the app.
 */
export function formatDate(d: DateLike): string {
  const dt = toDate(d)
  if (!dt) return ""
  return `${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}-${dt.getFullYear()}`
}

/**
 * Format as MM-DD-YYYY hh:mm AM/PM in the user's local time. Used for
 * timestamps that need the time component (approval stamps, note
 * creation, audit entries, AI generation time). Same anti-locale-
 * ambiguity reasoning as formatDate — we control the layout, the
 * browser doesn't.
 */
export function formatDateTime(d: DateLike): string {
  const dt = toDate(d)
  if (!dt) return ""
  const date = formatDate(dt)
  let hours = dt.getHours()
  const ampm = hours >= 12 ? "PM" : "AM"
  hours = hours % 12
  if (hours === 0) hours = 12
  return `${date} ${pad2(hours)}:${pad2(dt.getMinutes())} ${ampm}`
}

/**
 * Optional long form for high-prominence dates (e.g., "March 15, 2024" on
 * the close-confirmation banner). Most places should use formatDate; only
 * use this when the extra readability is worth the extra width.
 */
export function formatDateLong(d: DateLike): string {
  const dt = toDate(d)
  if (!dt) return ""
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ]
  return `${months[dt.getMonth()]} ${dt.getDate()}, ${dt.getFullYear()}`
}

/**
 * Month-only display (e.g., "Mar 2024"). For tiles, dropdowns, headers
 * that summarize a period rather than a specific day.
 */
export function formatMonth(d: DateLike): string {
  const dt = toDate(d)
  if (!dt) return ""
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
  return `${months[dt.getMonth()]} ${dt.getFullYear()}`
}

/**
 * Long month form ("March 2024"). Same use case as formatMonth, but
 * for higher-prominence placements (page headers, confirmation banners).
 */
export function formatMonthLong(d: DateLike): string {
  const dt = toDate(d)
  if (!dt) return ""
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ]
  return `${months[dt.getMonth()]} ${dt.getFullYear()}`
}
