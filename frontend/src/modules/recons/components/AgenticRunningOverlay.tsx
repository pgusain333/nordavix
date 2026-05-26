/**
 * AgenticRunningOverlay — full-screen-ish status visual that appears
 * while the AI agentic preparer is running. The Nordavix logo sits at
 * low opacity in the center with sparkles orbiting around it; a Stop
 * button below lets the user interrupt the run between accounts.
 *
 * The overlay is non-modal in a strict sense (the page underneath
 * still mounts), but its backdrop catches clicks so the user can't
 * accidentally trigger another mutation while AI is mid-run.
 */
import { useEffect, useState } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { Sparkles, X } from "lucide-react"
import { Spinner } from "@/core/ui/components"

interface Props {
  open:          boolean
  /** Optional period being processed — shown in the status text. */
  periodLabel?:  string | null
  /** Disables the Stop button (e.g. while the cancel request is in flight). */
  cancelling?:   boolean
  onStop:        () => void
}

// Pre-computed positions for the orbiting sparkles around the logo —
// 8 evenly spaced on a circle. Animated independently for a less
// mechanical feel.
const SPARKLE_POSITIONS = Array.from({ length: 8 }, (_, i) => {
  const angle = (i / 8) * Math.PI * 2
  return {
    x: Math.cos(angle) * 90,
    y: Math.sin(angle) * 90,
    delay: i * 0.18,
    size: 9 + (i % 3) * 3,
  }
})

const STATUS_LINES = [
  "Reading period transactions from QuickBooks…",
  "Building subledger from opening + reconciling items…",
  "Checking which accounts tie out to the penny…",
  "Asking Claude to explain the gaps…",
  "Writing AI commentary into row notes…",
  "Saving prepared work with audit trail…",
]

export function AgenticRunningOverlay({ open, periodLabel, cancelling, onStop }: Props) {
  // Cycle through status lines so the user feels progress even though
  // the actual backend run is one big request (no streaming).
  const [statusIdx, setStatusIdx] = useState(0)
  useEffect(() => {
    if (!open) return
    setStatusIdx(0)
    const id = setInterval(() => {
      setStatusIdx((i) => (i + 1) % STATUS_LINES.length)
    }, 2400)
    return () => clearInterval(id)
  }, [open])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="agentic-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{
            background: "color-mix(in oklab, var(--bg) 88%, transparent)",
            backdropFilter: "blur(6px)",
            WebkitBackdropFilter: "blur(6px)",
          }}
        >
          {/* Center stack: logo + sparkles + status + stop */}
          <motion.div
            initial={{ scale: 0.94, opacity: 0, y: 8 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.94, opacity: 0, y: 8 }}
            transition={{ duration: 0.24, ease: "easeOut" }}
            className="relative flex flex-col items-center"
          >
            {/* Glow ring behind the logo */}
            <motion.div
              className="absolute rounded-full"
              style={{
                width: 220,
                height: 220,
                background: "radial-gradient(circle, var(--green-subtle) 0%, transparent 70%)",
              }}
              animate={{ opacity: [0.6, 1, 0.6], scale: [0.96, 1.04, 0.96] }}
              transition={{ duration: 3.2, repeat: Infinity, ease: "easeInOut" }}
            />

            {/* Logo at low opacity, gently pulsing */}
            <motion.div
              className="relative h-28 w-28 mb-6 flex items-center justify-center"
              animate={{ opacity: [0.55, 0.85, 0.55], scale: [1, 1.02, 1] }}
              transition={{ duration: 2.6, repeat: Infinity, ease: "easeInOut" }}
            >
              <img src="/logo-mark-dark.svg" alt="" className="h-28 w-28 dark:hidden" />
              <img src="/logo-mark-light.svg" alt="" className="h-28 w-28 hidden dark:block" />

              {/* Orbiting sparkles */}
              {SPARKLE_POSITIONS.map((p, i) => (
                <motion.div
                  key={i}
                  className="absolute inline-flex items-center justify-center"
                  style={{ color: "var(--green)" }}
                  initial={{ x: p.x, y: p.y, scale: 0, opacity: 0 }}
                  animate={{
                    x: [p.x, p.x * 1.15, p.x],
                    y: [p.y, p.y * 1.15, p.y],
                    scale: [0.4, 1, 0.4],
                    opacity: [0, 1, 0],
                    rotate: [0, 180, 360],
                  }}
                  transition={{
                    duration: 2.4,
                    delay: p.delay,
                    repeat: Infinity,
                    ease: "easeInOut",
                  }}
                >
                  <Sparkles size={p.size} strokeWidth={1.8} />
                </motion.div>
              ))}
            </motion.div>

            {/* Status text + cycling activity line */}
            <p className="text-base font-bold text-theme mb-1">
              AI is working
              {periodLabel && (
                <span className="font-normal" style={{ color: "var(--text-muted)" }}>
                  {" "}on {periodLabel}
                </span>
              )}
            </p>
            <div className="h-5 mb-5 overflow-hidden text-center">
              <AnimatePresence mode="wait">
                <motion.p
                  key={statusIdx}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.32, ease: "easeOut" }}
                  className="text-[12px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  {STATUS_LINES[statusIdx]}
                </motion.p>
              </AnimatePresence>
            </div>

            {/* Stop button */}
            <button
              type="button"
              onClick={onStop}
              disabled={cancelling}
              className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold transition-all disabled:opacity-50"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border-strong)",
                color: "var(--text)",
                boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
              }}
              onMouseEnter={(e) => {
                if (cancelling) return
                ;(e.currentTarget as HTMLElement).style.borderColor = "#dc2626"
                ;(e.currentTarget as HTMLElement).style.color = "#dc2626"
              }}
              onMouseLeave={(e) => {
                if (cancelling) return
                ;(e.currentTarget as HTMLElement).style.borderColor = "var(--border-strong)"
                ;(e.currentTarget as HTMLElement).style.color = "var(--text)"
              }}
            >
              {cancelling ? <Spinner className="h-3.5 w-3.5" /> : <X size={14} strokeWidth={2} />}
              {cancelling ? "Stopping…" : "Stop"}
            </button>

            <p className="text-[10px] mt-3 max-w-xs text-center" style={{ color: "var(--text-muted)" }}>
              Stops after the current account finishes — any work already
              committed stays. Click Run AI again to resume.
            </p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
