/**
 * Shared motion constants — the entire app uses these so animations
 * stay synchronized. Mixing 0.12s / 0.18s / 0.2s timings across
 * neighboring elements made the UI feel slightly off-beat; this fixes
 * it by giving every motion the same heartbeat.
 *
 * Pick by intent, not by feel:
 *   - FAST     (0.12s) — tiny UI affordances: button presses, hover,
 *                        chip toggles. Imperceptible-but-felt.
 *   - DEFAULT  (0.18s) — the standard. Page transitions, drawer slides,
 *                        modal pop-in, tab switches.
 *   - SLOW     (0.30s) — large layout shifts, hero animations,
 *                        intentional "presentation" feel.
 *
 * Use the easing helpers when you want a curve other than the framer
 * default. EASE_OUT is right 90 % of the time (matches macOS-style
 * exits) — feels snappy without being abrupt.
 */

export const MOTION = {
  FAST:    0.12,
  DEFAULT: 0.18,
  SLOW:    0.30,
} as const

export const EASE = {
  /** Framer's "easeOut" — sharp start, soft end. Use almost everywhere. */
  OUT:     "easeOut",
  /** Symmetric. Use for hover toggles where you want the same in/out feel. */
  IN_OUT:  "easeInOut",
} as const
