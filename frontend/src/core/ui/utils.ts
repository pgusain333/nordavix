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
