/**
 * AutopilotRunOverlay — the "wow" moment when a close runs.
 *
 * A full-screen, brand-immersive takeover (ink ground + green glow + the
 * Nordavix mark) that animates the close stages live while Autopilot works,
 * then resolves into a finale with the REAL run results. Driven entirely by the
 * parent's run state:
 *   - while `!finished`: a glowing core + the stage list advancing in sequence
 *     (held on the last stage until the run truly finishes — never faked-complete).
 *   - when `finished`: a check/alert burst + the actual result chips + Done.
 *
 * The run lives server-side, so closing the overlay never cancels it — the
 * header banner keeps showing "Running" and the result lands either way.
 * Respects prefers-reduced-motion (no infinite loops; instant states).
 */
import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { motion, AnimatePresence } from "framer-motion"
import { CheckCircle2, AlertTriangle, X, Loader2, type LucideIcon } from "lucide-react"

export interface RunStage {
  key: string
  label: string
  working: string
  icon: LucideIcon
}

interface Props {
  open: boolean
  finished: boolean
  status: "completed" | "partial" | "failed" | null
  periodLabel: string | null
  stages: RunStage[]
  chips: string[]
  errorCount: number
  reduce: boolean
  onClose: () => void
}

const INK = "#0E1112"
const GREEN = "#3E8F66"
const GREENL = "#5BB089"
const MUTED = "#A6A9A6"

export function AutopilotRunOverlay({
  open, finished, status, periodLabel, stages, chips, errorCount, reduce, onClose,
}: Props) {
  const [active, setActive] = useState(0)

  useEffect(() => { if (open) setActive(0) }, [open])

  // Advance through the stages while the run is in flight; hold on the last one
  // until the run actually finishes so the UI never claims "done" early.
  useEffect(() => {
    if (!open || finished || reduce || stages.length === 0) return
    const t = setInterval(
      () => setActive((i) => Math.min(i + 1, stages.length - 1)),
      1900,
    )
    return () => clearInterval(t)
  }, [open, finished, reduce, stages.length])

  // Esc closes (the run continues in the background regardless).
  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    window.addEventListener("keydown", h)
    document.body.style.overflow = "hidden"
    return () => {
      window.removeEventListener("keydown", h)
      document.body.style.overflow = ""
    }
  }, [open, onClose])

  if (!open) return null

  const ok = status === "completed"
  const headline = !finished
    ? `Closing ${periodLabel ?? "the books"}`
    : status === "failed"
      ? "The run hit a snag"
      : status === "partial"
        ? "Closed — a few items need you"
        : "Your books are closed"
  const subline = !finished
    ? (stages[Math.min(active, stages.length - 1)]?.working ?? "Working…")
    : status === "failed"
      ? "Autopilot couldn't finish this run. Open the run history below for details."
      : status === "partial"
        ? `Autopilot did the heavy lifting — ${errorCount} step${errorCount === 1 ? "" : "s"} need a human eye.`
        : "Autopilot prepared the whole close. Review and sign off whenever you're ready."

  const accent = finished ? (ok ? GREEN : status === "failed" ? "#C2453B" : "#B8893A") : GREEN

  return createPortal(
    <AnimatePresence>
      <motion.div
        key="ap-overlay"
        className="fixed inset-0 z-[100] flex items-center justify-center p-5"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        transition={{ duration: reduce ? 0 : 0.25 }}
        role="dialog" aria-modal="true" aria-label="Close Autopilot run"
        style={{
          background:
            `radial-gradient(60% 60% at 80% 12%, rgba(62,143,102,0.26) 0%, rgba(62,143,102,0) 55%), ${INK}`,
        }}
      >
        {/* close */}
        <button
          onClick={onClose}
          aria-label="Hide"
          className="absolute top-4 right-4 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium"
          style={{ color: MUTED, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.10)" }}
        >
          <X size={14} strokeWidth={2} /> {finished ? "Close" : "Hide"}
        </button>

        <motion.div
          className="w-full max-w-md mx-auto text-center"
          initial={{ opacity: 0, y: reduce ? 0 : 14, scale: reduce ? 1 : 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: reduce ? 0 : 0.3, ease: "easeOut" }}
        >
          {/* ── Core ── */}
          <div className="relative mx-auto mb-7 flex items-center justify-center" style={{ width: 132, height: 132 }}>
            {!finished && !reduce && [0, 1].map((i) => (
              <motion.span
                key={i}
                className="absolute rounded-full"
                style={{ width: 92, height: 92, border: `1.5px solid ${GREENL}` }}
                initial={{ scale: 0.7, opacity: 0.5 }}
                animate={{ scale: 1.45, opacity: 0 }}
                transition={{ duration: 2.4, repeat: Infinity, ease: "easeOut", delay: i * 1.2 }}
              />
            ))}
            {!finished && !reduce && (
              <motion.span
                className="absolute rounded-full"
                style={{ width: 112, height: 112, border: `2px solid transparent`, borderTopColor: GREEN, borderRightColor: GREEN }}
                animate={{ rotate: 360 }}
                transition={{ duration: 2.2, repeat: Infinity, ease: "linear" }}
              />
            )}
            <motion.div
              className="relative flex items-center justify-center rounded-full"
              style={{
                width: 92, height: 92,
                background: finished ? (ok ? "rgba(62,143,102,0.16)" : "rgba(255,255,255,0.05)") : "rgba(255,255,255,0.04)",
                border: `1px solid ${finished ? accent : "rgba(255,255,255,0.10)"}`,
                boxShadow: `0 0 44px ${ok || !finished ? "rgba(62,143,102,0.45)" : "rgba(184,137,58,0.35)"}`,
              }}
              animate={finished || reduce ? {} : { scale: [1, 1.04, 1] }}
              transition={finished || reduce ? {} : { duration: 2.2, repeat: Infinity, ease: "easeInOut" }}
            >
              <AnimatePresence mode="wait">
                {finished ? (
                  <motion.span key="done"
                    initial={{ scale: reduce ? 1 : 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
                    transition={{ type: reduce ? "tween" : "spring", stiffness: 380, damping: 18, duration: reduce ? 0 : undefined }}>
                    {ok
                      ? <CheckCircle2 size={48} strokeWidth={2} style={{ color: GREEN }} />
                      : <AlertTriangle size={44} strokeWidth={2} style={{ color: accent }} />}
                  </motion.span>
                ) : (
                  <motion.img key="mark" src="/logo-mark-white.svg" alt="" draggable={false}
                    style={{ width: 40, height: 40 }}
                    initial={{ opacity: 0 }} animate={{ opacity: 1 }} />
                )}
              </AnimatePresence>
            </motion.div>
          </div>

          {/* ── Headline ── */}
          <motion.h2 className="text-[26px] font-bold leading-tight" style={{ color: "#fff" }}
            key={headline} initial={{ opacity: 0, y: reduce ? 0 : 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reduce ? 0 : 0.3 }}>
            {headline}
          </motion.h2>
          <div className="mt-2 min-h-[44px]">
            <AnimatePresence mode="wait">
              <motion.p key={subline} className="text-[14px] leading-relaxed mx-auto max-w-sm" style={{ color: MUTED }}
                initial={{ opacity: 0, y: reduce ? 0 : 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reduce ? 0 : -6 }}
                transition={{ duration: reduce ? 0 : 0.25 }}>
                {subline}
              </motion.p>
            </AnimatePresence>
          </div>

          {/* ── Body: stage list (running) or result chips (finished) ── */}
          {!finished ? (
            <div className="mt-7 text-left space-y-1.5">
              {stages.map((s, i) => {
                const state = i < active ? "done" : i === active ? "working" : "pending"
                const Icon = s.icon
                return (
                  <motion.div key={s.key}
                    initial={{ opacity: 0, x: reduce ? 0 : -8 }} animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: reduce ? 0 : i * 0.06, duration: 0.3 }}
                    className="flex items-center gap-3 rounded-xl px-3.5 py-2.5"
                    style={{
                      background: state === "working" ? "rgba(62,143,102,0.12)" : "rgba(255,255,255,0.03)",
                      border: `1px solid ${state === "working" ? "rgba(91,176,137,0.45)" : "rgba(255,255,255,0.07)"}`,
                      opacity: state === "pending" ? 0.5 : 1,
                      transition: "background .25s, border-color .25s, opacity .25s",
                    }}>
                    <span className="flex items-center justify-center rounded-lg shrink-0"
                      style={{ width: 30, height: 30, background: "rgba(255,255,255,0.05)", color: state === "pending" ? MUTED : GREENL }}>
                      <Icon size={15} strokeWidth={1.9} />
                    </span>
                    <span className="text-[13.5px] font-semibold flex-1" style={{ color: state === "pending" ? MUTED : "#fff" }}>
                      {s.label}
                    </span>
                    <span className="shrink-0">
                      {state === "done" ? (
                        <CheckCircle2 size={17} strokeWidth={2.4} style={{ color: GREEN }} />
                      ) : state === "working" ? (
                        <Loader2 size={16} strokeWidth={2.4} style={{ color: GREENL }}
                          className={reduce ? "" : "animate-spin"} />
                      ) : (
                        <span className="block rounded-full" style={{ width: 7, height: 7, background: "rgba(255,255,255,0.22)" }} />
                      )}
                    </span>
                  </motion.div>
                )
              })}
            </div>
          ) : (
            <>
              {chips.length > 0 && (
                <div className="mt-6 flex flex-wrap justify-center gap-2">
                  {chips.map((c, i) => (
                    <motion.span key={c}
                      initial={{ opacity: 0, scale: reduce ? 1 : 0.85 }} animate={{ opacity: 1, scale: 1 }}
                      transition={{ delay: reduce ? 0 : 0.15 + i * 0.07, duration: 0.3 }}
                      className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] font-medium"
                      style={{ background: "rgba(255,255,255,0.05)", color: "#E9EBE9", border: "1px solid rgba(255,255,255,0.12)" }}>
                      <CheckCircle2 size={12} strokeWidth={2.6} style={{ color: GREENL }} />
                      {c}
                    </motion.span>
                  ))}
                </div>
              )}
              <motion.button
                onClick={onClose}
                initial={{ opacity: 0, y: reduce ? 0 : 8 }} animate={{ opacity: 1, y: 0 }}
                transition={{ delay: reduce ? 0 : 0.15 + chips.length * 0.07 + 0.1, duration: 0.3 }}
                className="mt-8 inline-flex items-center justify-center rounded-xl px-6 py-2.5 text-[14px] font-bold"
                style={{ background: ok ? GREEN : "rgba(255,255,255,0.10)", color: "#fff", border: ok ? "1px solid transparent" : `1px solid ${accent}` }}>
                {ok ? "Review the close" : "Got it"}
              </motion.button>
            </>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  )
}
