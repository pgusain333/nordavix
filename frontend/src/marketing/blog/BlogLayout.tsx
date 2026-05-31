/**
 * BlogLayout — shared chrome for /blog and /blog/:slug.
 *
 * Marketing navbar at the top (logo + Solutions/Blog/Help nav + sign in/up),
 * the page's children in the middle, MarketingFooter at the bottom. Keeps
 * the blog visually consistent with the rest of the marketing site so a
 * visitor moving from /solutions → /blog → /sign-up never sees a chrome
 * change.
 *
 * Header behavior matches the other marketing pages: transparent at the
 * top of the page, solid burgundy (#8B1538) with white logo + nav once
 * the user scrolls. Theme toggle was removed from the top bar — per the
 * site-wide rule that theme toggling lives in the footer only.
 */
import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { useUser } from "@clerk/clerk-react"
import { ArrowRight } from "lucide-react"
import { MarketingFooter } from "@/marketing/MarketingFooter"

export function BlogLayout({ children }: { children: React.ReactNode }) {
  const { isSignedIn } = useUser()
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 10)
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => window.removeEventListener("scroll", onScroll)
  }, [])

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "var(--bg)" }}>
      <header className="sticky top-0 z-30 border-b transition-colors duration-300"
        style={{
          background: scrolled ? "#8B1538" : "color-mix(in oklab, var(--surface) 88%, transparent)",
          borderColor: scrolled ? "rgba(255,255,255,0.10)" : "var(--border)",
        }}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-14 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2">
            {scrolled ? (
              <img src="/logo-mark-light.svg" alt="Nordavix" className="h-7 w-7" />
            ) : (
              <>
                <img src="/logo-mark-dark.svg"  alt="Nordavix" className="h-7 w-7 dark:hidden" />
                <img src="/logo-mark-light.svg" alt="Nordavix" className="h-7 w-7 hidden dark:block" />
              </>
            )}
            <span className="font-bold text-base tracking-tight"
              style={{ color: scrolled ? "#FFFFFF" : "var(--text)" }}>
              nordavix<span style={{ color: scrolled ? "rgba(255,255,255,0.85)" : "var(--green)" }}>.</span>
            </span>
          </Link>
          <nav className="hidden md:flex items-center gap-6 text-sm">
            <Link to="/solutions" className="font-medium transition-colors"
              style={{ color: scrolled ? "rgba(255,255,255,0.85)" : "var(--text-2)" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = scrolled ? "#FFFFFF" : "var(--text)")}
              onMouseLeave={(e) => (e.currentTarget.style.color = scrolled ? "rgba(255,255,255,0.85)" : "var(--text-2)")}>
              Solutions
            </Link>
            <Link to="/blog" className="font-semibold transition-colors"
              style={{ color: scrolled ? "#FFFFFF" : "var(--text)" }}>
              Blog
            </Link>
            <Link to="/help" className="font-medium transition-colors"
              style={{ color: scrolled ? "rgba(255,255,255,0.85)" : "var(--text-2)" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = scrolled ? "#FFFFFF" : "var(--text)")}
              onMouseLeave={(e) => (e.currentTarget.style.color = scrolled ? "rgba(255,255,255,0.85)" : "var(--text-2)")}>
              Help
            </Link>
          </nav>
          <div className="flex items-center gap-2">
            {isSignedIn ? (
              <Link to="/app"
                className="text-xs font-semibold text-white px-3 py-1.5 rounded-md transition-all hover:opacity-90"
                style={{ background: "var(--green)" }}>
                Open dashboard <ArrowRight size={11} className="inline -mt-0.5 ml-0.5" />
              </Link>
            ) : (
              <Link to="/sign-up"
                className="text-xs font-semibold text-white px-3 py-1.5 rounded-md transition-all hover:opacity-90"
                style={{ background: "var(--green)" }}>
                Start free
              </Link>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1">{children}</main>
      <MarketingFooter />
    </div>
  )
}
