import { ReactNode, useState } from "react"
import { Menu, X } from "lucide-react"
import { LeftNav } from "./LeftNav"
import { ClerkApiWirer } from "@/core/auth/ClerkProvider"

interface ThreePaneLayoutProps {
  children: ReactNode
}

export function ThreePaneLayout({ children }: ThreePaneLayoutProps) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  return (
    <div className="flex h-screen overflow-hidden bg-theme">
      <ClerkApiWirer />

      {/* ── Desktop sidebar ── */}
      <div className="hidden lg:flex">
        <LeftNav />
      </div>

      {/* ── Mobile nav overlay ── */}
      {mobileNavOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm lg:hidden"
          onClick={() => setMobileNavOpen(false)}
        />
      )}
      <div
        className={[
          "fixed inset-y-0 left-0 z-50 lg:hidden transition-transform duration-300 ease-in-out",
          mobileNavOpen ? "translate-x-0" : "-translate-x-full",
        ].join(" ")}
      >
        <LeftNav onClose={() => setMobileNavOpen(false)} />
      </div>

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
