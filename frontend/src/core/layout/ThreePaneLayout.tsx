import { ReactNode, useEffect, useState } from "react"
import { Menu, X, Search } from "lucide-react"
import { AnimatePresence, motion } from "framer-motion"
import { LeftNav } from "./LeftNav"
import { TopBar } from "./TopBar"
import { ClerkApiWirer } from "@/core/auth/ClerkProvider"
import { CommandPalette, CMDK_EVENT } from "@/core/ui/CommandPalette"
import { NotificationsPanel } from "@/modules/notifications/NotificationsPanel"
import { NotificationToaster } from "@/modules/notifications/NotificationToaster"
import { NotificationBell } from "@/modules/notifications/NotificationBell"
import { DemoModeProvider, DemoBanner } from "@/core/demo/DemoModeProvider"
import { BrandSplash } from "@/core/brand/BrandSplash"

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

  // Compact density — shrink the authenticated app a notch (type + rem-based
  // spacing) so more fits on screen, like a gentle zoom-out. Scoped to the app
  // shell: the class is removed on unmount, so the marketing site keeps its full
  // size. See `html.app-dense` in index.css for the actual scale.
  useEffect(() => {
    document.documentElement.classList.add("app-dense")
    return () => document.documentElement.classList.remove("app-dense")
  }, [])

  return (
    <DemoModeProvider>
    <div className="flex h-screen overflow-hidden bg-theme">
      <ClerkApiWirer />
      <BrandSplash />
      <CommandPalette />
      <NotificationsPanel />
      <NotificationToaster />

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
              transition={{ duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
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

        <DemoBanner />

        {/* Desktop top bar — notification bell + signed-in user (lg+ only). */}
        <TopBar />

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
          {/* Notifications bell + search (search opens the ⌘K palette — no
              keyboard on mobile). */}
          <div className="flex items-center gap-1.5">
            <NotificationBell />
            <button
              onClick={() => window.dispatchEvent(new Event(CMDK_EVENT))}
              className="flex items-center justify-center h-8 w-8 rounded-lg transition-colors text-theme-2"
              style={{ background: "var(--surface-2)" }}
              aria-label="Search"
            >
              <Search size={18} strokeWidth={1.6} />
            </button>
          </div>
        </div>

        <main className="flex flex-1 flex-col overflow-hidden min-w-0">
          {children}
        </main>
      </div>
    </div>
    </DemoModeProvider>
  )
}
