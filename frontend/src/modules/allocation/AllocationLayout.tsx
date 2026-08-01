/**
 * AllocationLayout — the app shell for Nordavix Allocate (§471(c)).
 *
 * A SIBLING of ThreePaneLayout, not a child. The close app is deliberately
 * untouched by this product: separate shell, separate nav, separate dashboard,
 * separate route namespace (/allocation/*). The only things shared are the
 * Clerk session, the tenant model, and the platform chrome (command palette,
 * notifications) that every signed-in surface should have.
 *
 * Two classes go on <html> while mounted:
 *   app-dense             — same 15px compact density as the close app
 *   workspace-allocation  — swaps the BRAND accent to amber so staff can tell
 *                           the two products apart instantly (see index.css;
 *                           semantic colors are deliberately unchanged)
 * Both are removed on unmount, so switching back to close — or out to the
 * marketing site — restores the original palette exactly.
 */
import { ReactNode, useEffect, useState } from "react"
import { Menu, Search, X } from "lucide-react"
import { AnimatePresence, motion } from "framer-motion"
import { ErrorBoundary } from "@/core/ui/ErrorBoundary"
import { AllocationNav } from "./AllocationNav"
import { AllocationTopBar } from "./AllocationTopBar"

/** If the rail itself faults, you still need a way out of the product. */
function NavFallback() {
  return (
    <nav className="w-[248px] shrink-0 h-screen flex flex-col justify-between p-4"
      style={{ background: "var(--nav-bg)", borderRight: "1px solid var(--nav-border)" }}>
      <a href="/allocation" className="text-lg font-semibold tracking-tight"
        style={{ color: "#FFFFFF" }}>nordavix<span style={{ color: "var(--green-light)" }}>.</span></a>
      <p className="text-[11px] leading-snug" style={{ color: "var(--nav-text)" }}>
        The menu didn&rsquo;t load. Reload the page, or go to{" "}
        <a href="/allocation" className="underline">the dashboard</a>.
      </p>
    </nav>
  )
}
import { ClerkApiWirer } from "@/core/auth/ClerkProvider"
import { CommandPalette, CMDK_EVENT } from "@/core/ui/CommandPalette"
import { NotificationsPanel } from "@/modules/notifications/NotificationsPanel"
import { NotificationToaster } from "@/modules/notifications/NotificationToaster"
import { NotificationBell } from "@/modules/notifications/NotificationBell"
import { rememberProduct } from "@/core/layout/ProductSwitcher"

interface Props {
  children: ReactNode
}

export function AllocationLayout({ children }: Props) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  // Lock body scroll while the mobile drawer is open.
  useEffect(() => {
    if (!mobileNavOpen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => { document.body.style.overflow = prev }
  }, [mobileNavOpen])

  // Density + product accent, scoped to this shell's lifetime.
  useEffect(() => {
    const el = document.documentElement
    el.classList.add("app-dense", "workspace-allocation")
    return () => el.classList.remove("app-dense", "workspace-allocation")
  }, [])

  // Landing here (deep link, bookmark, refresh) makes this the remembered
  // product, so the next sign-in returns to it.
  useEffect(() => { rememberProduct("allocation") }, [])

  return (
    <div className="flex h-screen overflow-hidden bg-theme">
      <ClerkApiWirer />
      <CommandPalette />
      <NotificationsPanel />
      <NotificationToaster />

      {/* Desktop rail. Boundaried too, but with a visible fallback — losing the
          nav silently would leave no way to move between screens. */}
      <div className="hidden lg:flex">
        <ErrorBoundary label="Allocate nav" fallback={<NavFallback />}>
          <AllocationNav />
        </ErrorBoundary>
      </div>

      {/* Mobile drawer */}
      <AnimatePresence>
        {mobileNavOpen && (
          <>
            <motion.div
              key="alloc-nav-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
              className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm lg:hidden"
              onClick={() => setMobileNavOpen(false)}
            />
            <motion.div
              key="alloc-nav-drawer"
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
              className="fixed inset-y-0 left-0 z-50 lg:hidden"
            >
              <AllocationNav onClose={() => setMobileNavOpen(false)} />
            </motion.div>
          </>
        )}
      </AnimatePresence>

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
            aria-label="Open menu"
          >
            {mobileNavOpen ? <X size={18} strokeWidth={1.6} /> : <Menu size={18} strokeWidth={1.6} />}
          </button>
          <span className="text-sm font-semibold text-theme tracking-tight">Cost allocation</span>
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

        {/* Desktop top bar — same component the close app mounts, so the two
            products read as one platform (hidden lg:flex lives inside it).

            Boundaried with a NULL fallback: the chrome is not the work. A fault
            in a breadcrumb or a status chip should cost you that chrome, not
            the product — and this one is outside the route boundary, so without
            this it blanks everything. Verified by breaking it deliberately. */}
        <ErrorBoundary label="Allocate top bar" fallback={null}>
          <AllocationTopBar />
        </ErrorBoundary>

        <main className="flex flex-1 flex-col overflow-hidden min-w-0">
          {children}
        </main>
      </div>
    </div>
  )
}
