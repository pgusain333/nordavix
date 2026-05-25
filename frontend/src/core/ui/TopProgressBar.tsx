/**
 * TopProgressBar — global, app-wide loading indicator.
 *
 * A thin 2px bar at the very top of the viewport that lights up whenever
 * React Query has any fetches OR mutations in flight. Mounted once at the
 * app root so individual pages don't need their own spinners for routine
 * loading — they get visible feedback for free.
 *
 * Design:
 *   - 2px tall, green (brand color), with a subtle shimmer overlay that
 *     sweeps left→right to indicate indeterminate work
 *   - Fades in after a 150ms grace period so super-fast queries don't
 *     flash an annoying flicker; fades out the moment everything settles
 *   - Always above content (z-[100])
 *
 * Driven by react-query's useIsFetching + useIsMutating hooks — they
 * return the count of currently-active queries/mutations, no per-page
 * wiring required.
 */
import { useEffect, useState } from "react"
import { useIsFetching, useIsMutating } from "@tanstack/react-query"
import { AnimatePresence, motion } from "framer-motion"

export function TopProgressBar() {
  const fetching = useIsFetching()
  const mutating = useIsMutating()
  const busy = fetching + mutating > 0

  // Debounce visible state — show only if busy for > 150ms (no flicker for
  // ~instant queries), hide immediately when settled.
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (busy) {
      const t = setTimeout(() => setVisible(true), 150)
      return () => clearTimeout(t)
    }
    setVisible(false)
  }, [busy])

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="fixed top-0 left-0 right-0 z-[100] h-[2px] overflow-hidden pointer-events-none"
          style={{ background: "rgba(16, 185, 129, 0.15)" }}
        >
          {/* Shimmer: a small bright segment sweeping left→right on loop */}
          <motion.div
            initial={{ x: "-30%" }}
            animate={{ x: "130%" }}
            transition={{
              duration: 1.2,
              ease: "easeInOut",
              repeat: Infinity,
              repeatType: "loop",
            }}
            className="absolute top-0 left-0 h-full w-1/3 rounded-full"
            style={{
              background: "linear-gradient(90deg, transparent 0%, var(--green) 30%, var(--green) 70%, transparent 100%)",
              boxShadow: "0 0 8px var(--green)",
            }}
          />
        </motion.div>
      )}
    </AnimatePresence>
  )
}
