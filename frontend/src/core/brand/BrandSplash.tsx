/**
 * BrandSplash — hosts the LogoSting at the two moments we chose for it:
 *
 *   1. WELCOME    — once ever, per user, right after their first sign-in.
 *                   Carries a greeting ("Welcome to Nordavix, <name>").
 *   2. COLD START — once per tab session otherwise, when the app first opens.
 *                   No caption; a quiet brand beat over the loading shell.
 *
 * It's a non-blocking portal overlay: the app loads underneath and the splash
 * auto-dismisses (or click / Esc to skip). Welcome wins over cold-start, and
 * playing either marks the session so a brand-new user never sees two in a row.
 *
 * prefers-reduced-motion → no splash at all (the LogoSting would have no motion
 * to show, and a flash-and-gone overlay just reads as jank).
 */
import { useCallback, useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { AnimatePresence, motion, useReducedMotion } from "framer-motion"
import { useUser } from "@clerk/clerk-react"
import { LogoSting } from "@/core/brand/LogoSting"

const welcomeKey = (id: string) => `nordavix:welcomed:v1:${id}`
const SESSION_KEY = "nordavix:splash:v1"

type Mode = "welcome" | "coldstart"

export function BrandSplash() {
  const reduce = useReducedMotion()
  const { user, isLoaded } = useUser()
  const [mode, setMode] = useState<Mode | null>(null)
  const [show, setShow] = useState(false)
  const [decided, setDecided] = useState(false)

  // Decide once, after Clerk resolves the user (so the welcome flag is keyed
  // to the right person). Reduced-motion users get nothing.
  useEffect(() => {
    if (decided || reduce || !isLoaded) return
    const uid = user?.id ?? "anon"
    let m: Mode | null = null
    try {
      if (!localStorage.getItem(welcomeKey(uid))) m = "welcome"
      else if (!sessionStorage.getItem(SESSION_KEY)) m = "coldstart"
    } catch { m = null }
    if (m) { setMode(m); setShow(true) }
    setDecided(true)
  }, [decided, reduce, isLoaded, user])

  const finish = useCallback(() => {
    const uid = user?.id ?? "anon"
    try {
      if (mode === "welcome") localStorage.setItem(welcomeKey(uid), "1")
      sessionStorage.setItem(SESSION_KEY, "1")
    } catch { /* private mode — splash just won't be suppressed next time */ }
    setShow(false)
  }, [mode, user])

  // Esc to skip (click anywhere also skips, via the overlay handler).
  useEffect(() => {
    if (!show) return
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") finish() }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [show, finish])

  const greeting = user?.firstName ? `Welcome to Nordavix, ${user.firstName}` : "Welcome to Nordavix"

  return createPortal(
    <AnimatePresence>
      {show && mode && (
        <motion.div
          key="brand-splash"
          role="dialog"
          aria-label="Nordavix"
          className="fixed inset-0 z-[120] cursor-pointer"
          initial={{ opacity: 1 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.5, ease: "easeInOut" }}
          onClick={finish}
        >
          <LogoSting
            theme="ink"
            caption={mode === "welcome" ? greeting : undefined}
            holdMs={mode === "welcome" ? 2900 : 2300}
            onDone={finish}
          />
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
