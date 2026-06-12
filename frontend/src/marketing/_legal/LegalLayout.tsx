/**
 * LegalLayout — shared chrome for Terms of Service and Privacy Policy.
 *
 * Layout:
 *   [Marketing navbar]              (sticky, scroll-aware — same look as HomePage / Solutions)
 *   [Hero]                          title · effective date pill · last updated pill · Print
 *   [Two-column body]               sticky sidebar TOC (desktop) · long-form content (right)
 *                                   Scrollspy highlights the active section as user scrolls.
 *                                   Mobile collapses TOC into an accordion above the content.
 *   [Contact card]                  email + mailing address + governing law footer
 *   [Marketing footer]              same dark footer as the rest of the marketing site
 *
 * Conventions for callers:
 *   - Pass `sections` as an array of { id, title, body } where id is the
 *     URL hash anchor (lowercased, hyphenated). The component renders
 *     numbered h2 headings and registers each anchor for scrollspy.
 *   - `intro` renders above the first section; use it for the "Plain
 *     English summary" callout that big-SaaS legal pages all have now.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { formatDateLong } from "@/core/lib/dates"
import { Link, useNavigate } from "react-router-dom"
import { useUser } from "@clerk/clerk-react"
import { motion } from "framer-motion"
import {
  Menu, X, ArrowRight, ArrowUp, Printer, FileText, ShieldCheck, Lock,
  Mail, ChevronDown,
} from "lucide-react"
import { ThemeToggle } from "@/core/theme/ThemeToggle"
import { openCookiePreferences } from "@/core/consent/useCookieConsent"

export interface LegalSection {
  /** Lowercased URL-friendly hash, e.g. "data-retention" */
  id:    string
  /** Short heading shown in both TOC and section h2 */
  title: string
  /** Full prose for the section — paragraphs, lists, callouts as JSX */
  body:  ReactNode
}

interface Props {
  /** Page title — "Terms of Service" or "Privacy Policy" */
  title:         string
  /** Short sub-headline for the hero — one sentence */
  subtitle:      string
  /** ISO date (YYYY-MM-DD) shown in the "Effective" pill */
  effectiveDate: string
  /** ISO date (YYYY-MM-DD) shown in the "Last updated" pill */
  lastUpdated:   string
  /** Plain-English summary rendered as a callout above the first section */
  summary:       ReactNode
  /** Ordered list of sections */
  sections:      LegalSection[]
  /** Icon shown in the hero next to the title */
  Icon:          React.ElementType
  /** Sibling page link in the hero (e.g. on Terms page, link to Privacy) */
  related?:      { label: string; to: string }
}

export function LegalLayout({
  title, subtitle, effectiveDate, lastUpdated, summary, sections, Icon, related,
}: Props) {
  const [activeId, setActiveId] = useState<string>(sections[0]?.id ?? "")
  const [showBackToTop, setShowBackToTop] = useState(false)
  const [mobileTocOpen, setMobileTocOpen] = useState(false)
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({})

  // Scrollspy — track which section is currently in the viewport and
  // highlight it in the TOC. Uses IntersectionObserver with rootMargin
  // that biases the trigger point ~30% from the top so the active
  // section flips slightly *before* it reaches the very top edge,
  // which feels more responsive when scrolling.
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (visible[0]) {
          const id = visible[0].target.id
          if (id) setActiveId(id)
        }
      },
      { rootMargin: "-30% 0px -60% 0px", threshold: 0 },
    )
    sections.forEach((s) => {
      const el = sectionRefs.current[s.id]
      if (el) observer.observe(el)
    })
    return () => observer.disconnect()
  }, [sections])

  // Back-to-top button visibility — appears once user scrolls past
  // the hero (which is ~360px tall).
  useEffect(() => {
    const onScroll = () => setShowBackToTop(window.scrollY > 600)
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => window.removeEventListener("scroll", onScroll)
  }, [])

  // Initial hash-jump — if the URL has #section-id we need to scroll
  // to it AFTER the page lays out (otherwise the browser jumps to a
  // stale offset before content paints).
  useEffect(() => {
    if (!window.location.hash) return
    const id = window.location.hash.slice(1)
    const el = sectionRefs.current[id]
    if (el) {
      requestAnimationFrame(() => {
        el.scrollIntoView({ behavior: "smooth", block: "start" })
      })
    }
  }, [])

  function jumpTo(id: string) {
    const el = sectionRefs.current[id]
    if (!el) return
    el.scrollIntoView({ behavior: "smooth", block: "start" })
    history.replaceState(null, "", `#${id}`)
    setMobileTocOpen(false)
  }

  function handlePrint() {
    window.print()
  }

  const fmtDate = useMemo(() => (iso: string) => {
    try {
      return formatDateLong(iso)
    } catch { return iso }
  }, [])

  return (
    <div className="min-h-screen text-theme" style={{ background: "var(--bg)" }}>
      <MarketingNavbar />

      {/* ── Hero ── */}
      <header className="pt-32 pb-12 sm:pt-40 sm:pb-16 px-6 print:pt-8 print:pb-6"
        style={{
          background: "linear-gradient(180deg, var(--green-subtle) 0%, var(--bg) 100%)",
        }}>
        <div className="max-w-6xl mx-auto">
          <div className="flex flex-col items-center text-center">
            <div className="h-14 w-14 rounded-2xl flex items-center justify-center mb-5 print:hidden"
              style={{
                background: "var(--green)",
                boxShadow: "0 8px 24px rgba(16, 185, 129, 0.25)",
              }}>
              <Icon size={26} strokeWidth={1.8} color="white" />
            </div>
            <h1 className="font-bold tracking-tight text-theme mb-3 leading-[1.1]"
              style={{ fontSize: "clamp(32px, 6vw, 56px)" }}>
              {title}
            </h1>
            <p className="text-base sm:text-lg max-w-2xl leading-relaxed mb-8"
              style={{ color: "var(--text-2)" }}>
              {subtitle}
            </p>

            {/* Pills row: effective · last updated · sibling link · print */}
            <div className="flex flex-wrap items-center justify-center gap-2 print:gap-1">
              <Pill label="Effective"     value={fmtDate(effectiveDate)} />
              <Pill label="Last updated"  value={fmtDate(lastUpdated)} accent />
              {related && (
                <Link to={related.to}
                  className="hidden sm:inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-all hover:opacity-80 print:hidden"
                  style={{
                    background: "var(--surface)",
                    border: "1px solid var(--border-strong)",
                    color: "var(--text-2)",
                  }}>
                  {related.label} <ArrowRight size={11} strokeWidth={1.8} />
                </Link>
              )}
              <button onClick={handlePrint}
                className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-all hover:opacity-80 print:hidden"
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--border-strong)",
                  color: "var(--text-2)",
                }}>
                <Printer size={11} strokeWidth={1.8} /> Print
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* ── Body ── */}
      <main className="px-6 pb-24 print:pb-0">
        <div className="max-w-6xl mx-auto">
          {/* Mobile TOC accordion */}
          <div className="lg:hidden mb-8 print:hidden">
            <button
              onClick={() => setMobileTocOpen((o) => !o)}
              className="w-full flex items-center justify-between px-4 py-3 rounded-xl transition-colors"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
              }}>
              <span className="text-sm font-semibold text-theme">
                {mobileTocOpen ? "Hide" : "Show"} table of contents · {sections.length} sections
              </span>
              <motion.div animate={{ rotate: mobileTocOpen ? 180 : 0 }}>
                <ChevronDown size={16} strokeWidth={1.8} style={{ color: "var(--text-muted)" }} />
              </motion.div>
            </button>
            {mobileTocOpen && (
              <motion.ol
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="mt-2 rounded-xl py-2 overflow-hidden"
                style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
                {sections.map((s, i) => (
                  <li key={s.id}>
                    <button onClick={() => jumpTo(s.id)}
                      className="w-full text-left px-4 py-2 text-sm transition-colors hover:bg-[var(--surface-2)]"
                      style={{ color: activeId === s.id ? "var(--green)" : "var(--text-2)" }}>
                      <span className="tabular-nums mr-2" style={{ color: "var(--text-muted)" }}>
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      {s.title}
                    </button>
                  </li>
                ))}
              </motion.ol>
            )}
          </div>

          <div className="lg:grid lg:grid-cols-[240px_1fr] lg:gap-12 xl:grid-cols-[260px_1fr]">
            {/* Sticky desktop TOC */}
            <aside className="hidden lg:block print:hidden">
              <nav className="sticky top-28">
                <p className="text-[10px] font-bold uppercase tracking-wider mb-4"
                  style={{ color: "var(--text-muted)" }}>
                  Contents
                </p>
                <ol className="space-y-0.5">
                  {sections.map((s, i) => {
                    const isActive = activeId === s.id
                    return (
                      <li key={s.id}>
                        <button onClick={() => jumpTo(s.id)}
                          className="w-full text-left text-[13px] leading-snug py-1.5 px-3 -mx-3 rounded-md transition-all"
                          style={{
                            color: isActive ? "var(--green)" : "var(--text-2)",
                            background: isActive ? "var(--green-subtle)" : "transparent",
                            fontWeight: isActive ? 600 : 400,
                            borderLeft: `2px solid ${isActive ? "var(--green)" : "transparent"}`,
                          }}>
                          <span className="tabular-nums mr-2 text-[11px]"
                            style={{ color: isActive ? "var(--green)" : "var(--text-muted)" }}>
                            {String(i + 1).padStart(2, "0")}
                          </span>
                          {s.title}
                        </button>
                      </li>
                    )
                  })}
                </ol>
                <div className="mt-6 pt-6 border-t" style={{ borderColor: "var(--border)" }}>
                  <button onClick={handlePrint}
                    className="inline-flex items-center gap-1.5 text-xs font-medium transition-colors"
                    style={{ color: "var(--text-muted)" }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-2)")}
                    onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}>
                    <Printer size={11} strokeWidth={1.8} /> Print this page
                  </button>
                </div>
              </nav>
            </aside>

            {/* Long-form content */}
            <article className="legal-body max-w-3xl">
              {/* Plain-English summary callout */}
              <div className="rounded-2xl p-5 sm:p-6 mb-12 print:mb-6"
                style={{
                  background: "var(--green-subtle)",
                  border: "1px solid color-mix(in oklab, var(--green) 30%, transparent)",
                }}>
                <p className="text-[10px] font-bold uppercase tracking-wider mb-2"
                  style={{ color: "var(--green)" }}>
                  In plain English
                </p>
                <div className="text-[15px] leading-relaxed" style={{ color: "var(--text)" }}>
                  {summary}
                </div>
              </div>

              {sections.map((s, i) => (
                <section
                  key={s.id}
                  id={s.id}
                  ref={(el) => { sectionRefs.current[s.id] = el }}
                  className="scroll-mt-24 mb-14 print:mb-8 print:scroll-mt-0">
                  <div className="flex items-baseline gap-3 mb-4">
                    <span className="tabular-nums text-[11px] font-bold uppercase tracking-wider mt-1"
                      style={{ color: "var(--green)" }}>
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <h2 className="text-2xl sm:text-[28px] font-bold text-theme tracking-tight leading-tight">
                      {s.title}
                    </h2>
                  </div>
                  <div className="prose-legal">
                    {s.body}
                  </div>
                </section>
              ))}

              {/* Contact card at the very bottom */}
              <div className="rounded-2xl p-6 sm:p-7 mt-16 print:mt-8"
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  boxShadow: "var(--card-shadow)",
                }}>
                <div className="flex items-start gap-4">
                  <div className="h-11 w-11 rounded-xl flex items-center justify-center shrink-0"
                    style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
                    <Mail size={18} strokeWidth={1.8} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="text-base font-bold text-theme mb-1">Questions about this {title.toLowerCase()}?</h3>
                    <p className="text-sm mb-3" style={{ color: "var(--text-2)" }}>
                      We're happy to walk you through anything that's unclear. The fastest way to reach us is by email.
                    </p>
                    <a href="mailto:legal@nordavix.com"
                      className="inline-flex items-center gap-1.5 text-sm font-semibold transition-opacity hover:opacity-80"
                      style={{ color: "var(--green)" }}>
                      legal@nordavix.com <ArrowRight size={13} strokeWidth={2} />
                    </a>
                  </div>
                </div>
              </div>
            </article>
          </div>
        </div>
      </main>

      {/* Floating back-to-top */}
      {showBackToTop && (
        <motion.button
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.8 }}
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          className="fixed bottom-6 right-6 z-40 h-11 w-11 rounded-full flex items-center justify-center print:hidden"
          style={{
            background: "var(--green)",
            color: "white",
            boxShadow: "0 8px 24px rgba(16, 185, 129, 0.35)",
          }}
          aria-label="Back to top">
          <ArrowUp size={18} strokeWidth={2} />
        </motion.button>
      )}

      <MarketingFooter />

      {/* Page-level styles: prose typography + print rules */}
      <style>{`
        /* Long-form legal copy — readable, generous, modern. */
        .legal-body .prose-legal {
          color: var(--text);
          font-size: 15px;
          line-height: 1.75;
        }
        .legal-body .prose-legal > p {
          margin: 0 0 1.1em;
        }
        .legal-body .prose-legal h3 {
          font-size: 17px;
          font-weight: 700;
          color: var(--text);
          margin: 1.8em 0 0.7em;
          letter-spacing: -0.005em;
        }
        .legal-body .prose-legal ul,
        .legal-body .prose-legal ol {
          margin: 0 0 1.2em 1.5em;
          padding: 0;
        }
        .legal-body .prose-legal ul { list-style: disc; }
        .legal-body .prose-legal ol { list-style: decimal; }
        .legal-body .prose-legal li {
          margin: 0.35em 0;
          padding-left: 0.25em;
        }
        .legal-body .prose-legal li::marker {
          color: var(--text-muted);
        }
        .legal-body .prose-legal strong {
          color: var(--text);
          font-weight: 600;
        }
        .legal-body .prose-legal a {
          color: var(--green);
          text-decoration: underline;
          text-underline-offset: 2px;
          text-decoration-thickness: 1px;
        }
        .legal-body .prose-legal a:hover {
          text-decoration-thickness: 2px;
        }
        .legal-body .prose-legal code {
          background: var(--surface-2);
          padding: 1px 6px;
          border-radius: 4px;
          font-size: 13px;
          font-family: ui-monospace, SFMono-Regular, monospace;
        }
        .legal-body .prose-legal table {
          width: 100%;
          border-collapse: collapse;
          margin: 1.5em 0;
          font-size: 14px;
        }
        .legal-body .prose-legal th,
        .legal-body .prose-legal td {
          padding: 10px 12px;
          text-align: left;
          border-bottom: 1px solid var(--border);
          vertical-align: top;
        }
        .legal-body .prose-legal th {
          font-weight: 600;
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          color: var(--text-muted);
          background: var(--surface-2);
        }
        .legal-body .prose-legal blockquote {
          border-left: 3px solid var(--green);
          padding-left: 1em;
          margin: 1.2em 0;
          color: var(--text-2);
          font-style: italic;
        }

        /* Tighter, print-clean version */
        @media print {
          @page { margin: 0.6in; }
          .legal-body .prose-legal { font-size: 11pt; line-height: 1.5; }
          .legal-body .prose-legal h3 { font-size: 12pt; }
          nav, aside, button, a[href^="mailto:"] { color: #000 !important; }
        }
      `}</style>
    </div>
  )
}

// ─── Hero pill ──────────────────────────────────────────────────────────────

function Pill({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium"
      style={{
        background: accent ? "var(--green)" : "var(--surface)",
        color: accent ? "white" : "var(--text-2)",
        border: accent ? "none" : "1px solid var(--border-strong)",
      }}>
      <span className="opacity-75">{label}</span>
      <span className="font-semibold">{value}</span>
    </span>
  )
}

// ─── Navbar (slim re-implementation matching marketing pages) ──────────────

function MarketingNavbar() {
  const [scrolled, setScrolled] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const { isSignedIn } = useUser()
  const navigate = useNavigate()

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 10)
    window.addEventListener("scroll", onScroll)
    return () => window.removeEventListener("scroll", onScroll)
  }, [])

  useEffect(() => {
    document.body.style.overflow = mobileOpen ? "hidden" : ""
    return () => { document.body.style.overflow = "" }
  }, [mobileOpen])

  return (
    <>
      <nav className={`fixed top-0 inset-x-0 z-50 transition-all duration-300 print:hidden ${
        scrolled
          ? "border-b shadow-sm py-3"
          : "backdrop-blur-sm py-5"
      }`}
        style={{
          // Brand burgundy when scrolled — consistent across all
          // marketing pages (Home / Solutions / Legal / Help / Blog).
          background: scrolled ? "#0C2620" : "transparent",
          borderColor: scrolled ? "rgba(255,255,255,0.10)" : "transparent",
        }}>
        <div className="max-w-6xl mx-auto px-6 flex items-center justify-between">
          <button onClick={() => navigate("/")} className="flex items-center gap-2.5">
            {scrolled ? (
              <img src="/logo-mark-light.svg" alt="Nordavix" className="h-8 w-8" />
            ) : (
              <>
                <img src="/logo-mark-dark.svg"  alt="Nordavix" className="h-8 w-8 dark:hidden" />
                <img src="/logo-mark-light.svg" alt="Nordavix" className="h-8 w-8 hidden dark:block" />
              </>
            )}
            <span className="font-bold text-lg tracking-tight"
              style={{ color: scrolled ? "#FFFFFF" : "var(--text)" }}>
              nordavix<span style={{ color: scrolled ? "rgba(255,255,255,0.85)" : "var(--green)" }}>.</span>
            </span>
          </button>

          <div className="hidden md:flex items-center gap-8">
            {[
              { label: "Home",      to: "/",          external: false },
              { label: "Solutions", to: "/solutions", external: false },
              { label: "Pricing",   to: "/#pricing",  external: true  },
            ].map((it) => {
              const base = scrolled ? "rgba(255,255,255,0.85)" : "var(--text-2)"
              const hover = scrolled ? "#FFFFFF" : "var(--text)"
              const props = {
                className: "text-sm transition-colors",
                style: { color: base },
                onMouseEnter: (e: React.MouseEvent<HTMLElement>) => { (e.currentTarget as HTMLElement).style.color = hover },
                onMouseLeave: (e: React.MouseEvent<HTMLElement>) => { (e.currentTarget as HTMLElement).style.color = base },
              } as const
              return it.external
                ? <a key={it.label} href={it.to} {...props}>{it.label}</a>
                : <Link key={it.label} to={it.to} {...props}>{it.label}</Link>
            })}
          </div>

          <div className="flex items-center gap-3">
            <div className="hidden md:flex items-center gap-3">
              {isSignedIn ? (
                <Link to="/app" className="text-sm font-semibold text-white px-4 py-2 rounded-lg transition-opacity hover:opacity-90"
                  style={{ background: "var(--green)" }}>
                  Dashboard →
                </Link>
              ) : (
                <>
                  <Link to="/sign-in" className="text-sm px-4 py-2 transition-colors"
                    style={{ color: scrolled ? "rgba(255,255,255,0.85)" : "var(--text-2)" }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = scrolled ? "#FFFFFF" : "var(--text)")}
                    onMouseLeave={(e) => (e.currentTarget.style.color = scrolled ? "rgba(255,255,255,0.85)" : "var(--text-2)")}>
                    Sign in
                  </Link>
                  <Link to="/sign-up" className="text-sm font-semibold text-white px-4 py-2 rounded-lg transition-opacity hover:opacity-90"
                    style={{ background: "var(--green)" }}>
                    Get started free
                  </Link>
                </>
              )}
            </div>
            <button onClick={() => setMobileOpen(true)}
              className="md:hidden flex items-center justify-center h-9 w-9 rounded-lg transition-colors"
              style={{
                background: "transparent",
                color: scrolled ? "#FFFFFF" : "var(--text-2)",
                border: `1px solid ${scrolled ? "rgba(255,255,255,0.25)" : "var(--border)"}`,
              }}
              aria-label="Open menu">
              <Menu size={18} strokeWidth={1.8} />
            </button>
          </div>
        </div>
      </nav>

      {mobileOpen && (
        <div className="fixed inset-0 z-[60] md:hidden" style={{ background: "var(--bg)" }}>
          <div className="flex items-center justify-between px-6 py-5">
            <span className="font-bold text-lg tracking-tight text-theme">
              nordavix<span style={{ color: "var(--green)" }}>.</span>
            </span>
            <button onClick={() => setMobileOpen(false)} className="h-9 w-9 flex items-center justify-center rounded-lg"
              style={{ background: "var(--surface-2)", color: "var(--text-2)" }}>
              <X size={18} strokeWidth={1.8} />
            </button>
          </div>
          <div className="px-6 py-4 space-y-3">
            <Link to="/" onClick={() => setMobileOpen(false)} className="block py-2.5 text-base text-theme">Home</Link>
            <Link to="/solutions" onClick={() => setMobileOpen(false)} className="block py-2.5 text-base text-theme">Solutions</Link>
            <a href="/#pricing" onClick={() => setMobileOpen(false)} className="block py-2.5 text-base text-theme">Pricing</a>
            <Link to="/terms" onClick={() => setMobileOpen(false)} className="block py-2.5 text-base text-theme">Terms</Link>
            <Link to="/privacy" onClick={() => setMobileOpen(false)} className="block py-2.5 text-base text-theme">Privacy</Link>
            <Link to="/security" onClick={() => setMobileOpen(false)} className="block py-2.5 text-base text-theme">Security</Link>
            <div className="pt-4 space-y-3">
              <Link to="/sign-up" onClick={() => setMobileOpen(false)}
                className="flex items-center justify-center gap-2 w-full py-3 rounded-lg text-sm font-semibold text-white"
                style={{ background: "var(--green)" }}>
                Get started free <ArrowRight size={14} />
              </Link>
              <Link to="/sign-in" onClick={() => setMobileOpen(false)}
                className="flex items-center justify-center w-full py-2.5 rounded-lg text-sm font-medium"
                style={{ color: "var(--text-2)", border: "1px solid var(--border-strong)" }}>
                Sign in
              </Link>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// ─── Footer (matches the dark footer on HomePage) ──────────────────────────

function MarketingFooter() {
  return (
    <footer className="bg-slate-900 py-12 px-6 print:hidden">
      <div className="max-w-6xl mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8 mb-8">
          <div className="md:col-span-2">
            <div className="flex items-center gap-2 mb-3">
              <img src="/logo-mark-dark.svg" alt="Nordavix" className="h-7 w-7" loading="lazy" />
              <span className="font-bold text-white">nordavix<span style={{ color: "var(--green)" }}>.</span></span>
            </div>
            <p className="text-sm text-slate-500 leading-relaxed max-w-xs">
              AI-powered month-end close automation for controllers and accounting teams.
            </p>
          </div>
          <div>
            <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Product</h4>
            <ul className="space-y-2 text-sm text-slate-500">
              <li><Link to="/solutions" className="hover:text-slate-300 transition-colors">Solutions</Link></li>
              <li><Link to="/sign-up" className="hover:text-slate-300 transition-colors">Get started</Link></li>
              <li><Link to="/sign-in" className="hover:text-slate-300 transition-colors">Sign in</Link></li>
            </ul>
          </div>
          <div>
            <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Legal</h4>
            <ul className="space-y-2 text-sm text-slate-500">
              <li><Link to="/privacy" className="hover:text-slate-300 transition-colors inline-flex items-center gap-1.5">
                <ShieldCheck size={11} /> Privacy Policy
              </Link></li>
              <li><Link to="/terms" className="hover:text-slate-300 transition-colors inline-flex items-center gap-1.5">
                <FileText size={11} /> Terms of Service
              </Link></li>
              <li><Link to="/security" className="hover:text-slate-300 transition-colors inline-flex items-center gap-1.5">
                <Lock size={11} /> Security
              </Link></li>
              <li>
                <button onClick={openCookiePreferences}
                  className="hover:text-slate-300 transition-colors text-left">
                  Cookie preferences
                </button>
              </li>
              <li><a href="mailto:legal@nordavix.com" className="hover:text-slate-300 transition-colors">Contact legal</a></li>
            </ul>
          </div>
        </div>
        <div className="border-t border-slate-800 pt-8 flex flex-col md:flex-row items-center justify-between gap-4">
          <p className="text-xs text-slate-600">© {new Date().getFullYear()} Nordavix. All rights reserved.</p>
          <div className="dark"><ThemeToggle /></div>
          <p className="text-xs text-slate-700">Built for accountants, by accountants.</p>
        </div>
      </div>
    </footer>
  )
}
