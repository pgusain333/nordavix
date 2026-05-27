import { ReactNode, useEffect, useState } from "react"
import { Menu, X } from "lucide-react"
import { AnimatePresence, motion } from "framer-motion"
import { LeftNav } from "./LeftNav"
import { ClerkApiWirer } from "@/core/auth/ClerkProvider"

interface ThreePaneLayoutProps {
  children: ReactNode
}

export function ThreePaneLayout({ children }: ThreePaneLayoutProps) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  // Lock body scroll while the mobile drawer is open so the page
  // underneath doesn't scroll-jack when the user pans the drawer.
  useEffect(() => {
    if (!mobileNavOpen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => { document.body.style.overflow = prev }
  }, [mobileNavOpen])

  return (
    <div className="flex h-screen overflow-hidden bg-theme">
      <ClerkApiWirer />

      {/* ── Desktop sidebar ── */}
      <div className="hidden lg:flex">
        <LeftNav />
      </div>

      {/* ── Mobile nav overlay ──
          Backdrop and drawer are siblings inside an AnimatePresence so they
          enter and exit together cleanly. Previously the backdrop snapped
          in instantly while the drawer slid — the timing mismatch felt
          janky. Now both animate on a 260ms cubic easing curve. The
          drawer ships in from -100% and shoots back when closed; the
          backdrop just fades. */}
      <AnimatePresence>
        {mobileNavOpen && (
          <>
            <motion.div
              key="nav-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.22 }}
              className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm lg:hidden"
              onClick={() => setMobileNavOpen(false)}
            />
            <motion.div
              key="nav-drawer"
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
              className="fixed inset-y-0 left-0 z-50 lg:hidden"
            >
              <LeftNav onClose={() => setMobileNavOpen(false)} />
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* ── Main content ── */}
      <div className="flex flex-1 flex-col overflow-hidden min-w-0">

        {/* Mobile top bar */}
        <div
          className="flex lg:hidden items-center justify-between px-4 py-3 shrink-0"
          style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}
        >
          <button
            onClick={() => setMobileNavOpen(true)}
            className="flex items-center justify-center h-8 w-8 rounded-lg transition-colors text-theme-2"
            style={{ background: "var(--surface-2)" }}
          >
            {mobileNavOpen ? <X size={18} strokeWidth={1.6} /> : <Menu size={18} strokeWidth={1.6} />}
          </button>
          <div className="flex items-center gap-1.5">
            {/* logo-mark-dark = dark-colored mark (use on light bg) */}
            <img src="/logo-mark-dark.svg"  alt="Nordavix" className="h-6 w-6 dark:hidden" />
            <img src="/logo-mark-light.svg" alt="Nordavix" className="h-6 w-6 hidden dark:block" />
            <span className="text-sm font-semibold text-theme tracking-tight">
              nordavix<span style={{ color: "var(--green)" }}>.</span>
            </span>
          </div>
          {/* Theme toggle lives at the bottom of LeftNav — no duplicate here. */}
          <span className="w-8" aria-hidden="true" />
        </div>

        <main className="flex flex-1 flex-col overflow-hidden min-w-0">
          {children}
        </main>
      </div>
    </div>
  )
}
