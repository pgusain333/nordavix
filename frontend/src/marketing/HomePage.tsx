/**
 * HomePage — the Nordavix marketing landing page.
 *
 * Design philosophy ("Quiet confidence"): airy, light-first, editorial.
 * Generous whitespace, one idea per section, real product UI shown in
 * clean soft-shadowed frames, and gentle scroll-reveal motion. Brand is
 * warm — cream + ink + green, with burgundy as a sparing accent rather
 * than heavy dark blocks. Fully theme-aware via CSS vars + Tailwind
 * `dark:` so it reads beautifully in light AND dark.
 *
 * Sections (top → bottom):
 *   1.  Navbar (transparent → frosted-on-scroll)
 *   2.  Hero (centered copy + floating live AI-commentary card)
 *   3.  Quiet trust strip
 *   4.  The promise — Reconcile · Explain · Close
 *   5.  Feature story — alternating blocks for the real modules
 *   6.  Agentic spotlight — "your AI staff accountant"
 *   7.  Control you can prove — governance grid
 *   8.  Built for — personas
 *   9.  Founder note
 *   10. Early access (beta)
 *   11. FAQ accordion (feeds FAQPage JSON-LD)
 *   12. Final CTA
 *   13. Footer (shared MarketingFooter)
 *
 * No external chart/illustration libraries — visuals are SVG / styled
 * divs so the page stays fast.
 */
import { useEffect, useState, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { useUser } from "@clerk/clerk-react"
import { motion, AnimatePresence } from "framer-motion"
import { MarketingFooter } from "@/marketing/MarketingFooter"
import { LoggedInLaunchpad } from "@/marketing/LoggedInLaunchpad"
import { SEO, faqSchema, breadcrumbSchema } from "@/marketing/seo/SEO"
import {
  Sparkles, ArrowRight, CheckCircle2, Menu, X, ShieldCheck,
  GitCompareArrows, Brain, Workflow, Plug, Scale,
  FileCheck, Building2, UserCheck, Lock, Plus, Minus,
  ScrollText, TrendingUp, Layers, ChevronRight,
} from "lucide-react"

// Brand accent — used sparingly (eyebrow ticks, founder note, agentic panel).
const BURGUNDY = "#8B1538"

// ─── Motion: gentle scroll-reveal ───────────────────────────────────────────
const EASE = [0.22, 1, 0.36, 1] as const

function Reveal({
  children, delay = 0, y = 24, className = "",
}: { children: ReactNode; delay?: number; y?: number; className?: string }) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.6, ease: EASE, delay }}
    >
      {children}
    </motion.div>
  )
}

// Small green uppercase eyebrow label used above section headings.
function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.18em]"
      style={{ color: "var(--green)" }}>
      <span className="h-px w-6" style={{ background: "var(--green)" }} />
      {children}
    </span>
  )
}

// ─── Logo (theme-aware) ──────────────────────────────────────────────────────
function Logo() {
  return (
    <Link to="/" className="flex items-center gap-2.5 group shrink-0">
      <img src="/logo-mark-dark.svg" alt="Nordavix"
        className="h-8 w-8 dark:hidden transition-transform group-hover:scale-105" />
      <img src="/logo-mark-light.svg" alt="" aria-hidden="true"
        className="h-8 w-8 hidden dark:block transition-transform group-hover:scale-105" />
      <span className="font-bold text-lg tracking-tight text-theme">
        nordavix<span style={{ color: "var(--green)" }}>.</span>
      </span>
    </Link>
  )
}

// ─── Navbar — transparent over the hero, frosted surface on scroll ──────────
const NAV_LINKS = [
  { label: "Product",  to: "#features", external: true },
  { label: "Solutions", to: "/solutions", external: false },
  { label: "Blog",     to: "/blog", external: false },
  { label: "Early access", to: "#beta", external: true },
  { label: "FAQ",      to: "#faq", external: true },
]

function Navbar() {
  const [scrolled, setScrolled] = useState(false)
  const [open, setOpen] = useState(false)
  const { isSignedIn } = useUser()

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => window.removeEventListener("scroll", onScroll)
  }, [])
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : ""
    return () => { document.body.style.overflow = "" }
  }, [open])

  return (
    <>
      <nav className="fixed top-0 inset-x-0 z-50 transition-all duration-300"
        style={{
          paddingTop: scrolled ? 12 : 20,
          paddingBottom: scrolled ? 12 : 20,
          background: scrolled ? "color-mix(in srgb, var(--bg) 82%, transparent)" : "transparent",
          backdropFilter: scrolled ? "saturate(180%) blur(12px)" : "none",
          WebkitBackdropFilter: scrolled ? "saturate(180%) blur(12px)" : "none",
          borderBottom: `1px solid ${scrolled ? "var(--border)" : "transparent"}`,
        }}>
        <div className="max-w-6xl mx-auto px-6 flex items-center justify-between gap-4">
          <Logo />

          <div className="hidden md:flex items-center gap-8">
            {NAV_LINKS.map((it) => {
              const cls = "text-sm font-medium text-theme-2 hover:text-theme transition-colors"
              return it.external
                ? <a key={it.label} href={it.to} className={cls}>{it.label}</a>
                : <Link key={it.label} to={it.to} className={cls}>{it.label}</Link>
            })}
          </div>

          <div className="flex items-center gap-3">
            <div className="hidden md:flex items-center gap-2">
              {isSignedIn ? (
                <Link to="/app"
                  className="text-sm font-semibold text-white px-4 py-2 rounded-full transition-all hover:opacity-90 inline-flex items-center gap-1.5"
                  style={{ background: "var(--green)" }}>
                  Open dashboard <ArrowRight size={14} />
                </Link>
              ) : (
                <>
                  <Link to="/sign-in" className="text-sm font-medium text-theme-2 hover:text-theme transition-colors px-3 py-2">
                    Sign in
                  </Link>
                  <Link to="/sign-up"
                    className="text-sm font-semibold text-white px-4 py-2 rounded-full transition-all hover:-translate-y-0.5"
                    style={{ background: "var(--green)", boxShadow: "0 6px 18px -6px rgba(62,143,102,0.55)" }}>
                    Start free
                  </Link>
                </>
              )}
            </div>
            <button onClick={() => setOpen(true)}
              className="md:hidden flex items-center justify-center h-9 w-9 rounded-lg transition-colors text-theme"
              style={{ border: "1px solid var(--border-strong)" }}
              aria-label="Open menu">
              <Menu size={18} strokeWidth={1.8} />
            </button>
          </div>
        </div>
      </nav>

      {open && (
        <div className="fixed inset-0 z-[60] md:hidden" style={{ background: "var(--bg)" }}>
          <div className="flex items-center justify-between px-6 py-5">
            <Logo />
            <button onClick={() => setOpen(false)} className="h-9 w-9 flex items-center justify-center rounded-lg text-theme-2"
              style={{ background: "var(--surface-2)" }} aria-label="Close menu">
              <X size={18} strokeWidth={1.8} />
            </button>
          </div>
          <div className="px-6 py-4 space-y-1">
            {NAV_LINKS.map((item) => (
              item.external
                ? <a key={item.label} href={item.to} onClick={() => setOpen(false)}
                    className="block py-3 text-base font-medium text-theme border-b" style={{ borderColor: "var(--border)" }}>
                    {item.label}
                  </a>
                : <Link key={item.label} to={item.to} onClick={() => setOpen(false)}
                    className="block py-3 text-base font-medium text-theme border-b" style={{ borderColor: "var(--border)" }}>
                    {item.label}
                  </Link>
            ))}
            <div className="pt-6 space-y-3">
              <Link to="/sign-up" onClick={() => setOpen(false)}
                className="flex items-center justify-center gap-2 w-full py-3 rounded-full text-sm font-semibold text-white"
                style={{ background: "var(--green)" }}>
                Start free <ArrowRight size={14} />
              </Link>
              <Link to="/sign-in" onClick={() => setOpen(false)}
                className="flex items-center justify-center w-full py-2.5 rounded-full text-sm font-medium text-theme-2"
                style={{ border: "1px solid var(--border-strong)" }}>
                Sign in
              </Link>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// ─── Hero ────────────────────────────────────────────────────────────────────
function Hero() {
  const { isSignedIn } = useUser()
  return (
    <header className="relative overflow-hidden" style={{ background: "var(--bg)" }}>
      {/* whisper glows — barely-there warmth, works in both themes */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute -top-24 left-1/2 -translate-x-1/2 h-[420px] w-[820px] rounded-full"
          style={{ background: "radial-gradient(closest-side, rgba(62,143,102,0.16), transparent)", filter: "blur(20px)" }} />
        <div className="absolute top-40 -left-32 h-[360px] w-[360px] rounded-full"
          style={{ background: "radial-gradient(closest-side, rgba(139,21,56,0.10), transparent)", filter: "blur(20px)" }} />
      </div>

      <div className="relative max-w-4xl mx-auto px-6 pt-36 md:pt-44 pb-16 text-center">
        <Reveal>
          <span className="inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-semibold"
            style={{ background: "var(--green-subtle)", color: "var(--green)", border: "1px solid color-mix(in srgb, var(--green) 25%, transparent)" }}>
            <Sparkles size={13} strokeWidth={2} /> AI-native month-end close
          </span>
        </Reveal>

        <Reveal delay={0.05}>
          <h1 className="mt-6 text-[2.6rem] leading-[1.05] sm:text-6xl md:text-7xl font-bold tracking-tight text-theme">
            Close the books in{" "}
            <span style={{ color: "var(--green)" }}>days</span>,
            <br className="hidden sm:block" /> not weeks.
          </h1>
        </Reveal>

        <Reveal delay={0.1}>
          <p className="mt-6 mx-auto max-w-2xl text-lg md:text-xl leading-relaxed text-theme-2">
            Nordavix reconciles every account, explains every variance, and locks the period —
            AI-prepared, human-approved, right on top of QuickBooks Online.
          </p>
        </Reveal>

        <Reveal delay={0.15}>
          <div className="mt-9">
            {isSignedIn ? (
              <div className="max-w-xl mx-auto"><LoggedInLaunchpad /></div>
            ) : (
              <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
                <Link to="/sign-up"
                  className="inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-full text-sm font-semibold text-white transition-all hover:-translate-y-0.5"
                  style={{ background: "var(--green)", boxShadow: "0 10px 28px -8px rgba(62,143,102,0.55)" }}>
                  Start free <ArrowRight size={16} />
                </Link>
                <a href="#features"
                  className="inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-full text-sm font-semibold text-theme transition-colors"
                  style={{ background: "var(--surface)", border: "1px solid var(--border-strong)" }}>
                  See how it works
                </a>
              </div>
            )}
          </div>
        </Reveal>

        <Reveal delay={0.2}>
          <p className="mt-7 text-[13px] text-theme-muted">
            Built by a CPA · QuickBooks-native · Maker-checker enforced · No card required
          </p>
        </Reveal>
      </div>

      {/* Floating live product card */}
      <div className="relative max-w-3xl mx-auto px-6 pb-20 md:pb-28">
        <Reveal delay={0.1} y={36}>
          <motion.div
            animate={{ y: [0, -8, 0] }}
            transition={{ duration: 7, repeat: Infinity, ease: "easeInOut" }}>
            <HeroAICard />
          </motion.div>
        </Reveal>
      </div>
    </header>
  )
}

// Live AI-commentary card — the product's actual differentiator, in light.
function HeroAICard() {
  return (
    <div className="rounded-3xl p-1.5"
      style={{ background: "color-mix(in srgb, var(--green) 14%, var(--surface))", border: "1px solid var(--border)" }}>
      <div className="rounded-[1.35rem] overflow-hidden"
        style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow-hover)" }}>
        {/* window chrome */}
        <div className="flex items-center justify-between px-5 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full"
              style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
              <Sparkles size={12} strokeWidth={2} /> AI commentary
            </span>
          </div>
          <span className="text-xs text-theme-muted tabular-nums">March 2026</span>
        </div>

        <div className="p-5 sm:p-6 text-left">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-sm font-bold text-theme">6400 · Marketing &amp; Advertising</div>
              <div className="text-xs text-theme-muted mt-0.5">Flux vs. February</div>
            </div>
            <div className="text-right shrink-0">
              <div className="text-lg font-bold tabular-nums" style={{ color: BURGUNDY }}>+$14,200</div>
              <div className="text-xs text-theme-muted tabular-nums">+38%</div>
            </div>
          </div>

          <p className="mt-4 text-sm leading-relaxed text-theme-2">
            Spend rose <span className="font-semibold text-theme">$14,200 (+38%)</span> over February,
            concentrated in three Q1 campaign launches (Meta, Google, and a trade-show deposit).
            All invoices match their POs; nothing unposted above the $500 threshold. The movement is
            operational, not an error.
          </p>

          <div className="mt-4 space-y-2">
            {["Ties to the general ledger", "Top 3 driving transactions reviewed", "No items over threshold"].map((c) => (
              <div key={c} className="flex items-center gap-2 text-[13px] text-theme-2">
                <CheckCircle2 size={15} strokeWidth={2} style={{ color: "var(--green)" }} /> {c}
              </div>
            ))}
          </div>

          <div className="mt-5 pt-4 flex items-center justify-between" style={{ borderTop: "1px solid var(--border)" }}>
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full"
              style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
              Confidence: High
            </span>
            <span className="text-xs text-theme-muted">3 transactions cited</span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Quiet trust strip ───────────────────────────────────────────────────────
function TrustStrip() {
  const items = [
    { Icon: Plug, label: "QuickBooks-native" },
    { Icon: Building2, label: "Built by a CPA" },
    { Icon: UserCheck, label: "Maker-checker enforced" },
    { Icon: ShieldCheck, label: "Bank-grade security" },
  ]
  return (
    <section style={{ background: "var(--bg)" }}>
      <div className="max-w-5xl mx-auto px-6 py-10">
        <Reveal>
          <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-4">
            {items.map(({ Icon, label }) => (
              <div key={label} className="inline-flex items-center gap-2 text-sm font-medium text-theme-muted">
                <Icon size={16} strokeWidth={1.8} /> {label}
              </div>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  )
}

// ─── The promise — Reconcile · Explain · Close ───────────────────────────────
function Triad() {
  const cols = [
    { Icon: GitCompareArrows, title: "Reconcile", body: "Tie every balance-sheet account to its subledger — roll-forward openings, ticked items, and attached evidence." },
    { Icon: Brain, title: "Explain", body: "AI grounds every variance in the actual transactions that moved it, with a confidence score you can trust." },
    { Icon: Workflow, title: "Close", body: "Lock the period when every account is approved. Sequential, audited, and defensible by design." },
  ]
  return (
    <section className="relative" style={{ background: "var(--surface-2)" }}>
      <div className="max-w-6xl mx-auto px-6 py-24 md:py-28">
        <Reveal className="max-w-2xl mx-auto text-center">
          <Eyebrow>One workspace</Eyebrow>
          <h2 className="mt-4 text-3xl md:text-5xl font-bold tracking-tight text-theme">
            The whole close, in three calm moves.
          </h2>
        </Reveal>
        <div className="mt-14 grid md:grid-cols-3 gap-6">
          {cols.map(({ Icon, title, body }, i) => (
            <Reveal key={title} delay={i * 0.08}>
              <div className="h-full rounded-2xl p-7"
                style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
                <div className="h-11 w-11 rounded-xl flex items-center justify-center"
                  style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
                  <Icon size={20} strokeWidth={1.9} />
                </div>
                <h3 className="mt-5 text-xl font-bold text-theme">{title}</h3>
                <p className="mt-2 text-[15px] leading-relaxed text-theme-2">{body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}

// ─── Feature story — alternating blocks ──────────────────────────────────────
interface FeatureBlockProps {
  eyebrow: string
  title: string
  body: string
  bullets: string[]
  visual: ReactNode
  flip?: boolean
}
function FeatureBlock({ eyebrow, title, body, bullets, visual, flip }: FeatureBlockProps) {
  return (
    <div className="grid lg:grid-cols-2 gap-10 lg:gap-16 items-center">
      <Reveal className={flip ? "lg:order-2" : ""}>
        <Eyebrow>{eyebrow}</Eyebrow>
        <h3 className="mt-4 text-3xl md:text-4xl font-bold tracking-tight text-theme">{title}</h3>
        <p className="mt-4 text-lg leading-relaxed text-theme-2">{body}</p>
        <ul className="mt-6 space-y-3">
          {bullets.map((b) => (
            <li key={b} className="flex items-start gap-3 text-[15px] text-theme-2">
              <CheckCircle2 size={18} strokeWidth={2} className="mt-0.5 shrink-0" style={{ color: "var(--green)" }} />
              <span>{b}</span>
            </li>
          ))}
        </ul>
      </Reveal>
      <Reveal delay={0.1} className={flip ? "lg:order-1" : ""} y={32}>
        {visual}
      </Reveal>
    </div>
  )
}

// frame wrapper for product visuals
function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-2xl overflow-hidden"
      style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow-hover)" }}>
      {children}
    </div>
  )
}

function ReconVisual() {
  const rows = [
    { n: "1000", name: "Operating cash", v: "$0.00", ok: true },
    { n: "1200", name: "Accounts receivable", v: "$0.00", ok: true },
    { n: "1400", name: "Prepaid expenses", v: "$0.00", ok: true },
    { n: "2000", name: "Accounts payable", v: "$1,450", ok: false },
  ]
  return (
    <Frame>
      <div className="flex items-center justify-between px-5 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
        <span className="text-sm font-semibold text-theme">Reconciliations · Mar 2026</span>
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full text-white" style={{ background: "var(--green)" }}>
          <Sparkles size={11} strokeWidth={2} /> Run AI
        </span>
      </div>
      <div className="px-2 py-1">
        <div className="grid grid-cols-[1fr_auto] px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-theme-muted">
          <span>Account</span><span>Variance</span>
        </div>
        {rows.map((r) => (
          <div key={r.n} className="grid grid-cols-[1fr_auto] items-center px-3 py-2.5 rounded-lg" style={{ borderTop: "1px solid var(--border)" }}>
            <div className="min-w-0">
              <span className="text-xs font-mono text-theme-muted mr-2">{r.n}</span>
              <span className="text-sm text-theme truncate">{r.name}</span>
            </div>
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold tabular-nums"
              style={{ color: r.ok ? "var(--green)" : BURGUNDY }}>
              {r.ok ? <CheckCircle2 size={14} strokeWidth={2} /> : <span className="h-2 w-2 rounded-full" style={{ background: BURGUNDY }} />}
              {r.ok ? "Tied" : r.v + " open"}
            </span>
          </div>
        ))}
      </div>
      <div className="px-5 py-3 text-xs text-theme-muted" style={{ borderTop: "1px solid var(--border)" }}>
        12 of 14 accounts reconciled · 2 awaiting review
      </div>
    </Frame>
  )
}

function InsightsVisual() {
  const kpis = [
    { label: "Cash on hand", value: "$1.24M" },
    { label: "Runway", value: "14 mo" },
    { label: "Gross margin", value: "61%" },
  ]
  return (
    <Frame>
      <div className="px-5 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
        <span className="text-sm font-semibold text-theme">Insights · March 2026</span>
      </div>
      <div className="grid grid-cols-3 gap-3 p-5">
        {kpis.map((k) => (
          <div key={k.label} className="rounded-xl p-3" style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
            <div className="text-[10px] uppercase tracking-wider text-theme-muted">{k.label}</div>
            <div className="mt-1 text-lg font-bold tabular-nums text-theme">{k.value}</div>
          </div>
        ))}
      </div>
      <div className="px-5 pb-5">
        <div className="rounded-xl p-4" style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-theme">Net revenue · 6 mo</span>
            <span className="inline-flex items-center gap-1 text-xs font-semibold" style={{ color: "var(--green)" }}>
              <TrendingUp size={13} strokeWidth={2} /> +18%
            </span>
          </div>
          <svg viewBox="0 0 320 64" className="mt-3 w-full h-16" preserveAspectRatio="none">
            <polyline points="0,52 53,46 106,48 160,34 213,28 266,20 320,10" fill="none"
              stroke="var(--green)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            <polyline points="0,52 53,46 106,48 160,34 213,28 266,20 320,10 320,64 0,64" fill="var(--green-subtle)" stroke="none" />
          </svg>
        </div>
      </div>
    </Frame>
  )
}

function ExecVisual() {
  return (
    <Frame>
      <div className="relative p-6" style={{ background: "var(--surface)" }}>
        <span className="absolute top-4 right-4 text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded"
          style={{ color: "var(--green)", border: "1px solid color-mix(in srgb, var(--green) 40%, transparent)" }}>
          AI-narrated
        </span>
        <div className="text-[11px] uppercase tracking-[0.2em] text-theme-muted">Executive report</div>
        <div className="mt-1 text-lg font-bold text-theme">Helio Logistics, Inc.</div>
        <div className="text-xs text-theme-muted">For the period ending March 31, 2026</div>

        <div className="mt-5 space-y-1.5">
          <div className="h-2 rounded-full w-full" style={{ background: "var(--surface-2)" }} />
          <div className="h-2 rounded-full w-[92%]" style={{ background: "var(--surface-2)" }} />
          <div className="h-2 rounded-full w-[78%]" style={{ background: "var(--surface-2)" }} />
        </div>

        <div className="mt-5 flex items-end gap-2 h-20">
          {[40, 62, 55, 78, 70, 92].map((h, i) => (
            <div key={i} className="flex-1 rounded-t-md" style={{ height: `${h}%`, background: i === 5 ? "var(--green)" : "var(--green-subtle)" }} />
          ))}
        </div>
        <div className="mt-4 flex items-center gap-2 text-xs text-theme-2">
          <FileCheck size={14} strokeWidth={2} style={{ color: "var(--green)" }} />
          Cover · summary · IS / BS / CF · charts · risks &amp; outlook
        </div>
      </div>
    </Frame>
  )
}

function Features() {
  return (
    <section id="features" style={{ background: "var(--bg)" }}>
      <div className="max-w-6xl mx-auto px-6 py-24 md:py-32">
        <Reveal className="max-w-2xl mx-auto text-center mb-16 md:mb-20">
          <Eyebrow>The product</Eyebrow>
          <h2 className="mt-4 text-3xl md:text-5xl font-bold tracking-tight text-theme">
            Everything your close needs. Nothing it doesn&apos;t.
          </h2>
          <p className="mt-4 text-lg text-theme-2">
            Six tools that share one source of truth — your live QuickBooks data.
          </p>
        </Reveal>

        <div className="space-y-24 md:space-y-32">
          <FeatureBlock
            eyebrow="Reconciliations"
            title="Every account, tied out."
            body="Reconcile every balance-sheet account against its subledger — openings roll forward from the prior close, items tick to zero, and evidence stays attached."
            bullets={[
              "GL ⇄ subledger with roll-forward openings and a full build-up",
              "Agentic Mode auto-prepares every open account in one click",
              "Upload a statement — AI reads the balance and matches it",
              "Maker-checker: no one approves their own work",
            ]}
            visual={<ReconVisual />}
          />
          <FeatureBlock
            flip
            eyebrow="Flux analysis"
            title="Every variance, explained."
            body="Compare any period to the prior and let AI write the narrative — grounded in the real transactions that moved the number, never a generic guess."
            bullets={[
              "Period-over-period variance across the P&L and balance sheet",
              "AI commentary cites the actual driving transactions",
              "Confidence score on every explanation",
              "Sign-off gate before a variance is considered reviewed",
            ]}
            visual={<HeroAICard />}
          />
          <FeatureBlock
            eyebrow="Insights"
            title="Every number, in context."
            body="A living analytics layer on top of your close — liquidity and runway, profitability, AR/AP health, and the expense movers worth a second look."
            bullets={[
              "Cash, burn, and runway at a glance",
              "Revenue, gross margin, and net income trends",
              "DSO / DPO, aging, and customer concentration",
              "Month-over-month expense movers, ranked",
            ]}
            visual={<InsightsVisual />}
          />
          <FeatureBlock
            flip
            eyebrow="Financial package + executive report"
            title="A board-ready package — written by AI."
            body="Income statement, balance sheet, and cash flow on screen and as an audit-ready PDF — plus a multi-page executive report your AI drafts in seconds."
            bullets={[
              "IS / BS / CF rendered live and exportable to PDF",
              "AI-narrated executive report: summary, charts, risks, outlook",
              "Built from your synced ledger — consistent every month",
              "Hand it to a board or a client as-is",
            ]}
            visual={<ExecVisual />}
          />
        </div>

        {/* and more — intercompany + schedules */}
        <Reveal className="mt-24 md:mt-28">
          <div className="grid md:grid-cols-2 gap-6">
            {[
              { Icon: Scale, title: "Intercompany", body: "Auto-detects intercompany accounts, suggests counterparty pairs, and produces eliminations and a consolidated trial balance across entities." },
              { Icon: Layers, title: "Schedules", body: "Prepaids, accruals, fixed assets, leases, and loans — amortized on schedule and auto-flowed straight into the right reconciliation." },
            ].map(({ Icon, title, body }) => (
              <div key={title} className="rounded-2xl p-7"
                style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
                <div className="h-11 w-11 rounded-xl flex items-center justify-center" style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
                  <Icon size={20} strokeWidth={1.9} />
                </div>
                <h3 className="mt-5 text-xl font-bold text-theme">{title}</h3>
                <p className="mt-2 text-[15px] leading-relaxed text-theme-2">{body}</p>
              </div>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  )
}

// ─── Agentic spotlight ───────────────────────────────────────────────────────
function AgenticSpotlight() {
  const steps = [
    { n: "01", t: "Pulls from QuickBooks", d: "Live balances and the transactions behind them." },
    { n: "02", t: "Ties out the account", d: "Rolls the opening, matches items, finds the gap." },
    { n: "03", t: "Writes the commentary", d: "A grounded narrative, risk flags, and a confidence score." },
    { n: "04", t: "Hands it to you", d: "Suggest-only. You review and approve — always." },
  ]
  return (
    <section style={{ background: "var(--surface-2)" }}>
      <div className="max-w-6xl mx-auto px-6 py-24 md:py-32">
        <Reveal className="max-w-2xl">
          <span className="inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold"
            style={{ background: "color-mix(in srgb, #8B1538 12%, transparent)", color: BURGUNDY }}>
            <Sparkles size={13} strokeWidth={2} /> Agentic Mode
          </span>
          <h2 className="mt-5 text-3xl md:text-5xl font-bold tracking-tight text-theme">
            Meet your AI staff accountant.
          </h2>
          <p className="mt-4 text-lg leading-relaxed text-theme-2">
            Click once and Nordavix runs the first pass across every open account — pulling, tying out,
            and writing the working paper. It never approves anything. You keep the judgment; it removes the grind.
          </p>
        </Reveal>

        <div className="mt-14 grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {steps.map(({ n, t, d }, i) => (
            <Reveal key={n} delay={i * 0.08}>
              <div className="h-full rounded-2xl p-6" style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
                <div className="text-sm font-bold tabular-nums" style={{ color: "var(--green)" }}>{n}</div>
                <h3 className="mt-3 text-base font-bold text-theme">{t}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-theme-2">{d}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}

// ─── Control you can prove ───────────────────────────────────────────────────
function ControlGrid() {
  const items = [
    { Icon: UserCheck, t: "Maker-checker enforced", d: "The person who enters a value can never approve it. Enforced server-side, not by policy." },
    { Icon: Workflow, t: "Sequential close gate", d: "You can't close March until February is locked. No skipping, no back-dating." },
    { Icon: ScrollText, t: "Every action audited", d: "A complete, attributed trail of who did what, when — replayable for review." },
    { Icon: Lock, t: "QuickBooks read-only", d: "Read-only OAuth scope. Nordavix never writes back to your books." },
  ]
  return (
    <section style={{ background: "var(--bg)" }}>
      <div className="max-w-6xl mx-auto px-6 py-24 md:py-28">
        <Reveal className="max-w-2xl mx-auto text-center mb-14">
          <Eyebrow>Trust &amp; control</Eyebrow>
          <h2 className="mt-4 text-3xl md:text-5xl font-bold tracking-tight text-theme">Control you can prove.</h2>
          <p className="mt-4 text-lg text-theme-2">The governance auditors ask for — built in, not bolted on.</p>
        </Reveal>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {items.map(({ Icon, t, d }, i) => (
            <Reveal key={t} delay={i * 0.06}>
              <div className="h-full rounded-2xl p-6" style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
                <Icon size={22} strokeWidth={1.8} style={{ color: "var(--green)" }} />
                <h3 className="mt-4 text-base font-bold text-theme">{t}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-theme-2">{d}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}

// ─── Personas ────────────────────────────────────────────────────────────────
function Personas() {
  const cards = [
    { Icon: ShieldCheck, role: "Controllers", pitch: "Run a tighter close.", bullets: ["Weeks down to days", "Every account reconciled & approved", "A defensible audit trail by default"] },
    { Icon: TrendingUp, role: "Fractional CFOs", pitch: "More clients, same calendar.", bullets: ["One clean workspace per client", "AI handles the first pass", "Board-ready reporting in a click"] },
    { Icon: Building2, role: "CPA firms", pitch: "Standardize every engagement.", bullets: ["Maker-checker on every file", "Consistent working papers", "Review faster across the book"] },
  ]
  return (
    <section style={{ background: "var(--surface-2)" }}>
      <div className="max-w-6xl mx-auto px-6 py-24 md:py-28">
        <Reveal className="max-w-2xl mx-auto text-center mb-14">
          <Eyebrow>Who it&apos;s for</Eyebrow>
          <h2 className="mt-4 text-3xl md:text-5xl font-bold tracking-tight text-theme">
            Built for the people who own the close.
          </h2>
        </Reveal>
        <div className="grid md:grid-cols-3 gap-6">
          {cards.map(({ Icon, role, pitch, bullets }, i) => (
            <Reveal key={role} delay={i * 0.08}>
              <div className="h-full rounded-2xl p-7" style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-xl flex items-center justify-center" style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
                    <Icon size={19} strokeWidth={1.9} />
                  </div>
                  <span className="text-sm font-semibold text-theme-muted">{role}</span>
                </div>
                <h3 className="mt-5 text-xl font-bold text-theme">{pitch}</h3>
                <ul className="mt-4 space-y-2.5">
                  {bullets.map((b) => (
                    <li key={b} className="flex items-start gap-2.5 text-sm text-theme-2">
                      <CheckCircle2 size={16} strokeWidth={2} className="mt-0.5 shrink-0" style={{ color: "var(--green)" }} /> {b}
                    </li>
                  ))}
                </ul>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}

// ─── Founder note ────────────────────────────────────────────────────────────
function FounderNote() {
  return (
    <section style={{ background: "var(--bg)" }}>
      <div className="max-w-4xl mx-auto px-6 py-24 md:py-28">
        <Reveal>
          <figure className="rounded-3xl p-8 md:p-12"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", borderLeft: `4px solid ${BURGUNDY}`, boxShadow: "var(--card-shadow)" }}>
            <blockquote className="text-xl md:text-2xl font-medium leading-relaxed text-theme">
              “I&apos;m a CPA. I&apos;ve lived the month-end grind — the 11&nbsp;pm tie-outs, the variance emails,
              the audit scramble. Nordavix is the tool I wished I had: AI does the first pass, you keep the
              judgment, and the close finally feels <span style={{ color: "var(--green)" }}>calm</span>.”
            </blockquote>
            <figcaption className="mt-6 text-sm font-semibold text-theme-muted">— The founding CPA</figcaption>
          </figure>
        </Reveal>
      </div>
    </section>
  )
}

// ─── Early access (beta) ─────────────────────────────────────────────────────
function EarlyAccess() {
  return (
    <section id="beta" style={{ background: "var(--surface-2)" }}>
      <div className="max-w-4xl mx-auto px-6 py-24 md:py-28 text-center">
        <Reveal>
          <Eyebrow>Pricing</Eyebrow>
          <h2 className="mt-4 text-3xl md:text-5xl font-bold tracking-tight text-theme">
            Pricing is on the way. Early access is open.
          </h2>
          <p className="mt-4 mx-auto max-w-xl text-lg text-theme-2">
            We&apos;re onboarding design partners now — the full feature set, no credit card, and a direct line
            to the founders.
          </p>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
            {["Full feature set", "No credit card", "Direct line to the founders"].map((p) => (
              <span key={p} className="inline-flex items-center gap-1.5 text-sm font-medium px-3.5 py-1.5 rounded-full text-theme-2"
                style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
                <CheckCircle2 size={14} strokeWidth={2} style={{ color: "var(--green)" }} /> {p}
              </span>
            ))}
          </div>
          <div className="mt-9 flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link to="/sign-up"
              className="inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-full text-sm font-semibold text-white transition-all hover:-translate-y-0.5"
              style={{ background: "var(--green)", boxShadow: "0 10px 28px -8px rgba(62,143,102,0.55)" }}>
              Request beta access <ArrowRight size={16} />
            </Link>
            <Link to="/solutions"
              className="inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-full text-sm font-semibold text-theme"
              style={{ background: "var(--surface)", border: "1px solid var(--border-strong)" }}>
              Explore the product
            </Link>
          </div>
        </Reveal>
      </div>
    </section>
  )
}

// ─── FAQ — the visible questions ALSO power the FAQPage JSON-LD ──────────────
export const FAQ_QUESTIONS = [
  {
    q: "How does Nordavix actually pull data from QuickBooks?",
    a: "When you connect your QBO account via OAuth (read-only scope), we make live calls to QBO's reporting APIs — TrialBalance, GeneralLedger, ProfitAndLoss, AgedReceivables, AgedPayables. We never write back. Data is pulled on demand per period, so what you see is always current.",
  },
  {
    q: "Where is the AI commentary actually generated?",
    a: "We send a structured prompt containing the relevant account, period balances, and (when you've pulled them) the top transactions driving the variance to Anthropic's Claude API over an encrypted connection. Our agreement with Anthropic prohibits training on your data. The full data flow is documented in our Privacy Policy.",
  },
  {
    q: "Can my preparers and reviewers have different access levels?",
    a: "Yes. Three built-in roles: admin (full access including period close), reviewer (can approve work), preparer (can enter data but can't approve own work). Maker/checker is enforced — a preparer can't approve their own reconciliation.",
  },
  {
    q: "Is my data isolated from other customers?",
    a: "Every row in our database is tagged with a tenant_id and access is enforced by a session-level filter at the ORM layer. Cross-tenant reads are physically blocked, not just hidden. We're working toward formal SOC 2 attestation.",
  },
  {
    q: "What happens to my data if I cancel?",
    a: "We retain your data for 30 days after cancellation so you can export it, then delete from active systems within 90 days. Backups purge on our standard rotation (no more than 180 days). Full detail in the Privacy Policy.",
  },
  {
    q: "Can I close my books with Nordavix?",
    a: "Yes — admins can lock a period once all accounts are approved. Once locked, reviewers and preparers can view but not edit anything for that period. We also enforce a sequential close gate: you can't close March until February's closed.",
  },
]

function FAQ() {
  const [openIdx, setOpenIdx] = useState<number | null>(0)
  return (
    <section id="faq" style={{ background: "var(--bg)" }}>
      <div className="max-w-3xl mx-auto px-6 py-24 md:py-28">
        <Reveal className="text-center mb-12">
          <Eyebrow>FAQ</Eyebrow>
          <h2 className="mt-4 text-3xl md:text-5xl font-bold tracking-tight text-theme">Questions, answered.</h2>
        </Reveal>
        <div className="space-y-3">
          {FAQ_QUESTIONS.map((item, i) => {
            const isOpen = openIdx === i
            return (
              <Reveal key={item.q} delay={i * 0.04}>
                <div className="rounded-2xl overflow-hidden"
                  style={{ background: "var(--surface)", border: `1px solid ${isOpen ? "var(--border-strong)" : "var(--border)"}` }}>
                  <button onClick={() => setOpenIdx(isOpen ? null : i)}
                    className="w-full flex items-center justify-between gap-4 text-left px-5 py-4"
                    aria-expanded={isOpen}>
                    <span className="text-[15px] font-semibold text-theme">{item.q}</span>
                    <span className="shrink-0 h-7 w-7 rounded-full flex items-center justify-center"
                      style={{ background: isOpen ? "var(--green-subtle)" : "var(--surface-2)", color: isOpen ? "var(--green)" : "var(--text-muted)" }}>
                      {isOpen ? <Minus size={15} strokeWidth={2.2} /> : <Plus size={15} strokeWidth={2.2} />}
                    </span>
                  </button>
                  <AnimatePresence initial={false}>
                    {isOpen && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.28, ease: EASE }}
                        className="overflow-hidden">
                        <p className="px-5 pb-5 text-[15px] leading-relaxed text-theme-2">{item.a}</p>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </Reveal>
            )
          })}
        </div>
      </div>
    </section>
  )
}

// ─── Final CTA ───────────────────────────────────────────────────────────────
function FinalCTA() {
  const { isSignedIn } = useUser()
  return (
    <section style={{ background: "var(--bg)" }}>
      <div className="max-w-5xl mx-auto px-6 pb-28">
        <Reveal>
          <div className="relative overflow-hidden rounded-[2rem] px-8 py-16 md:py-20 text-center"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow-hover)" }}>
            <div aria-hidden className="pointer-events-none absolute inset-0">
              <div className="absolute -top-20 left-1/2 -translate-x-1/2 h-72 w-[640px] rounded-full"
                style={{ background: "radial-gradient(closest-side, rgba(62,143,102,0.18), transparent)", filter: "blur(8px)" }} />
            </div>
            <div className="relative">
              <h2 className="text-3xl md:text-5xl font-bold tracking-tight text-theme">
                Your next close, but <span style={{ color: "var(--green)" }}>calm</span>.
              </h2>
              <p className="mt-4 mx-auto max-w-xl text-lg text-theme-2">
                Connect QuickBooks in a minute. Run your first AI reconciliation in five.
              </p>
              <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
                <Link to={isSignedIn ? "/app" : "/sign-up"}
                  className="inline-flex items-center justify-center gap-2 px-7 py-3.5 rounded-full text-sm font-semibold text-white transition-all hover:-translate-y-0.5"
                  style={{ background: "var(--green)", boxShadow: "0 10px 28px -8px rgba(62,143,102,0.55)" }}>
                  {isSignedIn ? "Open dashboard" : "Start free"} <ArrowRight size={16} />
                </Link>
                <Link to="/solutions"
                  className="inline-flex items-center justify-center gap-1.5 px-7 py-3.5 rounded-full text-sm font-semibold text-theme"
                  style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)" }}>
                  See the product <ChevronRight size={16} />
                </Link>
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  )
}

// ─── Page ────────────────────────────────────────────────────────────────────
export function HomePage() {
  const faqSchemaObj = faqSchema(FAQ_QUESTIONS.map((q) => ({ question: q.q, answer: q.a })))
  const crumbs = breadcrumbSchema([{ name: "Home", path: "/" }])

  return (
    <div className="min-h-screen text-theme" style={{ background: "var(--bg)" }}>
      <SEO
        title="Nordavix — AI month-end close software for CPAs and controllers"
        description="Close your books in days, not weeks. AI-prepared reconciliations, flux analysis, intercompany consolidation, schedules, and an executive financial package — all built on top of QuickBooks Online."
        path="/"
        bareTitle
        jsonLd={[faqSchemaObj, crumbs]}
      />
      <Navbar />
      <Hero />
      <TrustStrip />
      <Triad />
      <Features />
      <AgenticSpotlight />
      <ControlGrid />
      <Personas />
      <FounderNote />
      <EarlyAccess />
      <FAQ />
      <FinalCTA />
      <MarketingFooter />
    </div>
  )
}
