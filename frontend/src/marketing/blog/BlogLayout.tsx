/**
 * BlogLayout — shared chrome for /blog and /blog/:slug.
 *
 * Marketing navbar at the top (logo + Solutions/Blog/Help nav + sign in/up),
 * the page's children in the middle, MarketingFooter at the bottom. Keeps
 * the blog visually consistent with the rest of the marketing site so a
 * visitor moving from /solutions → /blog → /sign-up never sees a chrome
 * change.
 */
import { Link } from "react-router-dom"
import { useUser } from "@clerk/clerk-react"
import { ArrowRight } from "lucide-react"
import { ThemeToggle } from "@/core/theme/ThemeToggle"
import { MarketingFooter } from "@/marketing/MarketingFooter"

export function BlogLayout({ children }: { children: React.ReactNode }) {
  const { isSignedIn } = useUser()

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "var(--bg)" }}>
      {/* Marketing header — sticky, theme-aware, matches /help layout */}
      <header className="sticky top-0 z-30 border-b backdrop-blur"
        style={{
          background: "color-mix(in oklab, var(--surface) 88%, transparent)",
          borderColor: "var(--border)",
        }}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-14 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2">
            <img src="/logo-mark-dark.svg"  alt="Nordavix" className="h-7 w-7 dark:hidden" />
            <img src="/logo-mark-light.svg" alt="Nordavix" className="h-7 w-7 hidden dark:block" />
            <span className="font-bold text-base tracking-tight text-theme">
              nordavix<span style={{ color: "var(--green)" }}>.</span>
            </span>
          </Link>
          <nav className="hidden md:flex items-center gap-6 text-sm">
            <Link to="/solutions" className="font-medium transition-colors hover:text-theme"
              style={{ color: "var(--text-2)" }}>Solutions</Link>
            <Link to="/blog" className="font-semibold transition-colors text-theme">Blog</Link>
            <Link to="/help" className="font-medium transition-colors hover:text-theme"
              style={{ color: "var(--text-2)" }}>Help</Link>
          </nav>
          <div className="flex items-center gap-2">
            <ThemeToggle />
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
