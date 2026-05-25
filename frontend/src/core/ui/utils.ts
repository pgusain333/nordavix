import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/**
 * Format a number using accounting conventions:
 * - Positive: right-aligned with commas, no sign
 * - Negative: in parentheses (1,234) rather than -1,234
 * - Zero: "—" (em dash) to distinguish from missing data
 */
export function formatAccounting(
  value: number | string | null | undefined,
  decimals = 0,
): string {
  if (value === null || value === undefined || value === "") return "—"
  const num = typeof value === "string" ? parseFloat(value) : value
  if (isNaN(num)) return "—"
  if (num === 0) return "—"

  const abs = Math.abs(num)
  const formatted = abs.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })

  return num < 0 ? `(${formatted})` : formatted
}

/**
 * Format a percentage variance for display.
 * Returns "N/M" when pct is null (prior balance was zero).
 */
export function formatPct(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return "N/M"
  const num = typeof value === "string" ? parseFloat(value) : value
  if (isNaN(num)) return "N/M"

  const abs = Math.abs(num)
  const formatted = `${abs.toFixed(1)}%`
  return num < 0 ? `(${formatted})` : formatted
}

/**
 * Turn a snake_case identifier into a Title-cased human label so backend
 * enum keys (status, kind, etc.) never leak into the UI as e.g.
 * "ready_for_review" or "rolled_forward". Callers can also pass a
 * lookup map for cases where the auto-conversion isn't the nicest read
 * (e.g. "ready_for_review" → "In review").
 *
 * Examples:
 *   humanize("ready_for_review")              → "Ready For Review"
 *   humanize("ready_for_review", { ready_for_review: "In review" })
 *                                             → "In review"
 *   humanize("complete")                      → "Complete"
 */
export function humanize(s: string | null | undefined, overrides?: Record<string, string>): string {
  if (!s) return ""
  if (overrides && overrides[s]) return overrides[s]
  return s
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
}
