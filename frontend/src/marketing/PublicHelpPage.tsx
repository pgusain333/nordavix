/**
 * Public help page at /help — no login required.
 *
 * Same help content as /app/help, wrapped in the marketing site chrome
 * (marketing header with logo + nav, shared MarketingFooter). Hostable
 * on the public internet, indexed by search engines, shareable with
 * anyone.
 *
 * The shared <HelpContent /> component does the heavy lifting; this
 * file is just the layout shell.
 */
import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { motion } from "framer-motion"
import { ArrowRight, BookOpen, ExternalLink } from "lucide-react"

import { HelpContent } from "@/modules/help/HelpContent"
import { MarketingFooter } from "@/marketing/MarketingFooter"
import { SEO, breadcrumbSchema } from "@/marketing/seo/SEO"

export function PublicHelpPage() {
  // Burgundy-on-scroll header behavior — mirrors Home / Solutions /
  // Blog / Legal so the marketing chrome is identical across the site.
  // Theme toggle was removed from this top bar per the site-wide rule
  // that theme toggling belongs in the footer only (MarketingFooter
  // already renders one).
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 10)
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => window.removeEventListener("scroll", onScroll)
  }, [])

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "var(--bg)" }}>
      <SEO
        title="Help & documentation — how to use Nordavix"
        description="How Nordavix works: connect QuickBooks, run reconciliations and flux analysis, close the books. Step-by-step guides for controllers and CPAs."
        path="/help"
        jsonLd={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Help", path: "/help" },
        ])}
      />
      {/* ── Marketing header ── */}
      <header className="sticky top-0 z-30 border-b transition-colors duration-300"
        style={{
          background: scrolled ? "#0C2620" : "color-mix(in oklab, var(--surface) 88%, transparent)",
          borderColor: scrolled ? "rgba(255,255,255,0.10)" : "var(--border)",
        }}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-14 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2">
            {scrolled ? (
              <img src="/logo-mark-light.svg" alt="Nordavix" className="h-7 w-7" />
            ) : (
              <>
                <img src="/logo-mark-dark.svg" alt="Nordavix" className="h-7 w-7 dark:hidden" />
                <img src="/logo-mark-light.svg" alt="Nordavix" className="h-7 w-7 hidden dark:block" />
              </>
            )}
            <span className="text-lg font-semibold tracking-tight"
              style={{ color: scrolled ? "#FFFFFF" : "var(--text)" }}>
              nordavix<span style={{ color: scrolled ? "rgba(255,255,255,0.85)" : "var(--green)" }}>.</span>
            </span>
          </Link>
          <div className="flex items-center gap-3">
            <Link to="/" className="text-sm font-medium hidden sm:inline-flex items-center transition-colors"
              style={{ color: scrolled ? "rgba(255,255,255,0.85)" : "var(--text-2)" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = scrolled ? "#FFFFFF" : "var(--text)")}
              onMouseLeave={(e) => (e.currentTarget.style.color = scrolled ? "rgba(255,255,255,0.85)" : "var(--text-2)")}>
              Home
            </Link>
            <Link to="/solutions" className="text-sm font-medium hidden sm:inline-flex items-center transition-colors"
              style={{ color: scrolled ? "rgba(255,255,255,0.85)" : "var(--text-2)" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = scrolled ? "#FFFFFF" : "var(--text)")}
              onMouseLeave={(e) => (e.currentTarget.style.color = scrolled ? "rgba(255,255,255,0.85)" : "var(--text-2)")}>
              Solutions
            </Link>
            <Link to="/sign-in"
              className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-semibold text-white transition-opacity hover:opacity-90"
              style={{ background: "var(--green)" }}>
              Sign in
              <ArrowRight size={12} strokeWidth={2.2} />
            </Link>
          </div>
        </div>
      </header>

      {/* ── Hero ── */}
      <motion.div
        initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}
        className="border-b"
        style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider mb-4"
            style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
            <BookOpen size={12} strokeWidth={2.2} />
            Help center
          </div>
          <h1 className="font-bold text-theme leading-[1.1] tracking-tight mb-3"
            style={{ fontSize: "clamp(28px, 5vw, 44px)" }}>
            Nordavix Help
          </h1>
          <p className="text-base sm:text-lg max-w-3xl leading-relaxed"
            style={{ color: "var(--text-2)" }}>
            Every workflow, every screen, in order. The same guide we hand
            to new Beta users on day one. Browse the table of contents to
            jump to a section, or share a section link with a colleague —
            no login required.
          </p>
          <div className="flex items-center gap-3 mt-5 flex-wrap text-xs"
            style={{ color: "var(--text-muted)" }}>
            <span>
              Have a Nordavix account? The same guide is in your sidebar at
              <Link to="/app/help" className="font-semibold ml-1 inline-flex items-center gap-1"
                style={{ color: "var(--green)" }}>
                /app/help <ExternalLink size={10} strokeWidth={2} />
              </Link>
            </span>
          </div>
        </div>
      </motion.div>

      {/* ── Content ── */}
      <main className="flex-1">
        <HelpContent publicMode />
      </main>

      {/* ── Footer ── */}
      <MarketingFooter />
    </div>
  )
}
