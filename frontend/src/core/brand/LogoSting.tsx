/**
 * LogoSting — the Nordavix brand reveal.
 *
 * A lightweight in-app port of the standalone "logo sting" animation: the
 * mark's "n" stroke draws in, the dot pops, and the `nordavix.` wordmark
 * resolves into the lockup over a soft drifting aurora. Two themes (ink /
 * paper) drawn from our CSS-token brand colours, an optional caption, and an
 * `onDone` fired once the reveal has settled.
 *
 * Built on the app's existing React + framer-motion — no bundled framework,
 * no extra fonts (the wordmark is rendered in our own type, exactly like the
 * LeftNav). Honors prefers-reduced-motion: it snaps to the final lockup and
 * calls onDone almost immediately, with no movement.
 *
 * The mark geometry is the canonical Nordavix mark (see /public/logo-mark-*).
 */
import { useEffect } from "react"
import { motion, useReducedMotion } from "framer-motion"

const MARK_PATH = "M15 34 L15 17 M15 21 Q15 17 19 17 L29 17 Q33 17 33 21 L33 34"

interface Props {
  theme?: "ink" | "paper"
  /** Optional line under the lockup (e.g. a welcome greeting). */
  caption?: string
  /** Fired once the reveal has played + held. */
  onDone?: () => void
  /** Total ms the sting holds before onDone (ignored under reduced-motion,
   *  which resolves in ~650ms with no animation). Default 2600. */
  holdMs?: number
}

export function LogoSting({ theme = "ink", caption, onDone, holdMs = 2600 }: Props) {
  const reduce = useReducedMotion()
  const ink = theme === "ink"

  // Brand palette, by theme — pulled to match /public/logo-mark-*.svg + the
  // LeftNav wordmark so the sting reads as the real logo, not a lookalike.
  const bg      = ink ? "#0C2620" : "#F4F1E9"   // deep pine / cream
  const square  = ink ? null      : "#0E1112"   // paper theme shows the squared mark
  const stroke  = ink ? "#FFFFFF" : "#F7F5F0"
  const dot     = ink ? "#9CC4AD" : "#3E8F66"
  const word    = ink ? "#F4F1E9" : "#0E1112"
  const period  = ink ? "#9CC4AD" : "#2E7A55"
  const glow    = ink ? "rgba(156,196,173,0.22)" : "rgba(46,122,85,0.14)"
  const capCol  = ink ? "rgba(244,241,233,0.72)" : "rgba(16,34,28,0.66)"

  useEffect(() => {
    const t = setTimeout(() => onDone?.(), reduce ? 650 : holdMs)
    return () => clearTimeout(t)
  }, [onDone, holdMs, reduce])

  // Reduced motion: no transitions — everything renders in its final state.
  const draw = reduce
    ? { initial: false as const, animate: { pathLength: 1, opacity: 1 } }
    : {
        initial: { pathLength: 0, opacity: 0 },
        animate: { pathLength: 1, opacity: 1 },
        transition: { pathLength: { duration: 0.95, ease: "easeInOut" as const, delay: 0.3 }, opacity: { duration: 0.2, delay: 0.3 } },
      }
  const popDot = reduce
    ? { initial: false as const, animate: { scale: 1, opacity: 1 } }
    : {
        initial: { scale: 0, opacity: 0 },
        animate: { scale: 1, opacity: 1 },
        transition: { delay: 1.2, type: "spring" as const, stiffness: 460, damping: 16 },
      }
  const wordIn = reduce
    ? { initial: false as const, animate: { opacity: 1, x: 0, filter: "blur(0px)" } }
    : {
        initial: { opacity: 0, x: -10, filter: "blur(5px)" },
        animate: { opacity: 1, x: 0, filter: "blur(0px)" },
        transition: { delay: 1.4, duration: 0.55, ease: "easeOut" as const },
      }
  const capIn = reduce
    ? { initial: false as const, animate: { opacity: 1, y: 0 } }
    : {
        initial: { opacity: 0, y: 8 },
        animate: { opacity: 1, y: 0 },
        transition: { delay: 1.95, duration: 0.5, ease: "easeOut" as const },
      }

  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center overflow-hidden"
      style={{ background: bg }}
    >
      {/* Soft aurora glow — slow drift behind the lockup. Lives only for the
          sting's lifetime, so the infinite loop never lingers. */}
      {!reduce && (
        <motion.div
          aria-hidden
          className="pointer-events-none absolute"
          style={{
            width: 620, height: 620, borderRadius: "50%",
            background: `radial-gradient(circle, ${glow} 0%, transparent 68%)`,
            filter: "blur(8px)",
          }}
          initial={{ x: 0, y: 0, scale: 1 }}
          animate={{ x: ["0%", "5%", "-3%", "0%"], y: ["0%", "3%", "5%", "0%"], scale: [1, 1.08, 1.04, 1] }}
          transition={{ duration: 12, ease: "easeInOut", repeat: Infinity }}
        />
      )}

      {/* Lockup: animated mark + wordmark */}
      <div className="relative flex items-center gap-3 sm:gap-4">
        <svg viewBox="0 0 48 48" width={64} height={64} aria-hidden className="shrink-0">
          {square && (
            <motion.rect
              x="0.75" y="0.75" width="46.5" height="46.5" rx="9.5" fill={square}
              initial={reduce ? false : { scale: 0.86, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={reduce ? undefined : { duration: 0.5, ease: "easeOut" }}
              style={{ transformBox: "fill-box", transformOrigin: "center" }}
            />
          )}
          <motion.path
            d={MARK_PATH} fill="none" stroke={stroke} strokeWidth={3.6}
            strokeLinecap="round" strokeLinejoin="round"
            {...draw}
          />
          <motion.circle
            cx="33" cy="34" r="2.6" fill={dot}
            style={{ transformBox: "fill-box", transformOrigin: "center" }}
            {...popDot}
          />
        </svg>

        <motion.span
          {...wordIn}
          style={{
            fontSize: "clamp(34px, 7vw, 46px)", fontWeight: 600,
            letterSpacing: "-0.03em", lineHeight: 1, color: word,
          }}
        >
          nordavix<span style={{ color: period }}>.</span>
        </motion.span>
      </div>

      {caption && (
        <motion.p
          {...capIn}
          className="mt-5 px-6 text-center"
          style={{ fontSize: 14, letterSpacing: "0.01em", color: capCol }}
        >
          {caption}
        </motion.p>
      )}
    </div>
  )
}
