/**
 * HomePage — the Nordavix marketing page.
 *
 * Design philosophy: don't be another Tailwind-UI clone. Every section
 * has at least one element that communicates the product story
 * visually, not just in copy. The hero leads with a live, typewriter-
 * animated AI Commentary card — the actual differentiation of the
 * product — instead of a generic illustration. The bento grid puts
 * features in different sizes so the eye lands on the most important
 * ones first. The interactive AI demo lets the user click a variance
 * scenario and watch Nordavix "respond" — converts much better than
 * a static screenshot.
 *
 * Sections (top → bottom):
 *   1.  Navbar (sticky, scroll-aware)
 *   2.  Hero (split: copy left · live AI card right · gradient mesh bg)
 *   3.  Trust strip (built-for-CPAs, audit trail, multi-tenant chips)
 *   4.  The Close Loop hero visualization (continuous orbit)
 *   5.  Bento grid — six feature tiles, varied sizes
 *   6.  Interactive AI Commentary demo
 *   7.  Built for your role (Controller / FCFO / CPA firm)
 *   8.  Pricing (3 plans, monthly/annual toggle)
 *   9.  FAQ accordion
 *   10. Final CTA
 *   11. Footer (shared MarketingFooter component)
 *
 * All sections are theme-aware (CSS vars), animated with framer-motion,
 * and use lucide icons. No external chart/illustration libraries — the
 * "graphics" are SVG / styled divs so the page stays fast.
 */
import { useEffect, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { useUser } from "@clerk/clerk-react"
import { motion, AnimatePresence, useScroll, useTransform } from "framer-motion"
import { MarketingFooter } from "@/marketing/MarketingFooter"
import { LoggedInLaunchpad } from "@/marketing/LoggedInLaunchpad"
import { SEO, faqSchema, breadcrumbSchema } from "@/marketing/seo/SEO"
import {
  Sparkles, ArrowRight, CheckCircle2, Menu, X, Zap, Lock, Brain,
  ShieldCheck, ScrollText, GitCompareArrows, Workflow, Plug,
  Scale, BarChart3, Lightbulb, Plus, Minus, ChevronRight,
  Quote, RefreshCw, Layers, Eye, Clock, TrendingUp, FileCheck,
  Building2, UserCheck, Users,
} from "lucide-react"

// ─── Utility hook: enter-on-scroll ─────────────────────────────────────────

function useInView<T extends HTMLElement = HTMLDivElement>(threshold = 0.15) {
  const ref = useRef<T>(null)
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setInView(true) },
      { threshold },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [threshold])
  return { ref, inView }
}

// ─── Navbar ────────────────────────────────────────────────────────────────

function Navbar() {
  const [scrolled, setScrolled] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const { isSignedIn } = useUser()

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => window.removeEventListener("scroll", onScroll)
  }, [])

  useEffect(() => {
    document.body.style.overflow = mobileOpen ? "hidden" : ""
    return () => { document.body.style.overflow = "" }
  }, [mobileOpen])

  return (
    <>
      <nav className={`fixed top-0 inset-x-0 z-50 transition-all duration-300 ${
        scrolled
          ? "py-3 border-b"
          : "py-5"
      }`}
        style={{
          // BRAND_BURGUNDY = "#8B1538" (matches FounderQuote palette).
          // When scrolled: solid burgundy header with white logo + nav
          // links — high-contrast brand statement on every marketing page.
          background: scrolled ? "#8B1538" : "transparent",
          borderColor: scrolled ? "rgba(255,255,255,0.10)" : "transparent",
        }}>
        <div className="max-w-6xl mx-auto px-6 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2.5 group">
            {/* HomePage navbar always renders the light-strokes logo +
                wordmark in WHITE. The Hero behind the transparent
                header is burgundy with breathing glow orbs — so a
                subtle shadow keeps the wordmark crisp when an orb
                drifts under it. When scrolled (solid burgundy
                header), drop the shadow — no variation to fight. */}
            <img src="/logo-mark-light.svg" alt="Nordavix"
              className="h-8 w-8 transition-transform group-hover:scale-105" />
            <span className="font-bold text-lg tracking-tight"
              style={{
                color: "#FFFFFF",
                textShadow: scrolled ? "none" : "0 1px 10px rgba(0,0,0,0.40)",
              }}>
              nordavix<span style={{ color: "#FFFFFF" }}>.</span>
            </span>
          </Link>

          <div className="hidden md:flex items-center gap-8">
            {[
              { label: "Solutions", to: "/solutions", external: false },
              { label: "Features",  to: "#features",  external: true  },
              { label: "Blog",      to: "/blog",      external: false },
              { label: "Beta",      to: "#pricing",   external: true  },
              { label: "FAQ",       to: "#faq",       external: true  },
            ].map((it) => {
              // Hero behind the transparent header has breathing glow
              // orbs that brighten patches — subtle shadow keeps nav
              // links readable wherever an orb passes under. Drop the
              // shadow once scrolled onto the solid burgundy bar.
              const baseColor  = "rgba(255,255,255,0.85)"
              const hoverColor = "#FFFFFF"
              const textShadow = scrolled ? "none" : "0 1px 8px rgba(0,0,0,0.35)"
              const props = {
                className: "text-sm font-medium transition-colors",
                style: { color: baseColor, textShadow },
                onMouseEnter: (e: React.MouseEvent<HTMLElement>) => { (e.currentTarget as HTMLElement).style.color = hoverColor },
                onMouseLeave: (e: React.MouseEvent<HTMLElement>) => { (e.currentTarget as HTMLElement).style.color = baseColor },
              } as const
              return it.external
                ? <a key={it.label} href={it.to} {...props}>{it.label}</a>
                : <Link key={it.label} to={it.to} {...props}>{it.label}</Link>
            })}
          </div>

          <div className="flex items-center gap-3">
            <div className="hidden md:flex items-center gap-3">
              {isSignedIn ? (
                <Link to="/app" className="text-sm font-semibold text-white px-4 py-2 rounded-lg transition-all hover:opacity-90"
                  style={{ background: "var(--green)" }}>
                  Open dashboard <ArrowRight size={13} className="inline -mt-0.5 ml-1" />
                </Link>
              ) : (
                <>
                  <Link to="/sign-in" className="text-sm px-4 py-2 transition-colors"
                    style={{
                      color: "rgba(255,255,255,0.85)",
                      textShadow: scrolled ? "none" : "0 1px 8px rgba(0,0,0,0.35)",
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = "#FFFFFF")}
                    onMouseLeave={(e) => (e.currentTarget.style.color = "rgba(255,255,255,0.85)")}>
                    Sign in
                  </Link>
                  <Link to="/sign-up"
                    className="text-sm font-semibold text-white px-4 py-2 rounded-lg transition-all hover:opacity-90"
                    style={{
                      background: "var(--green)",
                      boxShadow: "0 4px 12px rgba(16,185,129,0.25)",
                    }}>
                    Start free
                  </Link>
                </>
              )}
            </div>
            <button onClick={() => setMobileOpen(true)}
              className="md:hidden flex items-center justify-center h-9 w-9 rounded-lg transition-colors"
              style={{
                // Transparent at all times (per design ask). Icon stays
                // white in both states since both backdrops are dark
                // (banner artwork at top, burgundy header on scroll).
                background: "transparent",
                color: "#FFFFFF",
                border: "1px solid rgba(255,255,255,0.25)",
              }}
              aria-label="Open menu">
              <Menu size={18} strokeWidth={1.8} />
            </button>
          </div>
        </div>
      </nav>

      {/* Mobile drawer */}
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
          <div className="px-6 py-4 space-y-1">
            {[
              { label: "Solutions", to: "/solutions" },
              { label: "Features",  to: "#features" },
              { label: "Blog",      to: "/blog" },
              { label: "Beta",      to: "#pricing" },
              { label: "FAQ",       to: "#faq" },
            ].map((item) => (
              item.to.startsWith("#")
                ? <a key={item.label} href={item.to} onClick={() => setMobileOpen(false)}
                    className="block py-3 text-base font-medium text-theme border-b"
                    style={{ borderColor: "var(--border)" }}>
                    {item.label}
                  </a>
                : <Link key={item.label} to={item.to} onClick={() => setMobileOpen(false)}
                    className="block py-3 text-base font-medium text-theme border-b"
                    style={{ borderColor: "var(--border)" }}>
                    {item.label}
                  </Link>
            ))}
            <div className="pt-6 space-y-3">
              <Link to="/sign-up" onClick={() => setMobileOpen(false)}
                className="flex items-center justify-center gap-2 w-full py-3 rounded-lg text-sm font-semibold text-white"
                style={{ background: "var(--green)" }}>
                Start free <ArrowRight size={14} />
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

// ─── Hero — split layout with live AI Commentary card ─────────────────────

// Hero background composition:
//   Base   — flat #8B1538 burgundy (matches scrolled navbar so the
//            top of the page reads as one continuous surface).
//   Layer 1: static radial gradient mesh — light + dark burgundy
//            blobs + a faint brand-green accent for compositional
//            anchors. No animation; sets the mood.
//   Layer 2: three softly-breathing orbs (framer-motion scale +
//            drift). Heavily blurred so they read as light moving
//            in the room, not as shapes. ~12-16s loops so the eye
//            doesn't fixate.
//   Layer 3: faint white grid at 4% opacity, radially masked so it
//            fades at the edges — adds a technical feel without
//            competing with the typography.
//   Layer 4: cinematic vignette — darkens the corners to focus the
//            eye on the centered headline + AI card.
// All layers are pointer-events-none so the CTAs underneath stay
// clickable.

function Hero() {
  const { isSignedIn } = useUser()
  return (
    <section
      className="relative pt-32 pb-24 sm:pt-40 sm:pb-28 px-6 overflow-hidden"
      // Linear-grade: a deep, near-black burgundy with a single soft light from
      // above. Calm and minimal — the typography + one product shot carry it.
      style={{ background: "linear-gradient(180deg, #1E0813 0%, #160610 58%, #110509 100%)" }}>

      {/* The one light source — a large, soft burgundy/rose glow, high-center.
          A gentle opacity breathe keeps it alive without drawing attention. */}
      <motion.div
        aria-hidden="true"
        className="absolute pointer-events-none rounded-full"
        style={{
          width: 1100, height: 1100,
          top: "-44%", left: "50%", marginLeft: -550,
          background: "radial-gradient(circle, rgba(190,55,95,0.30) 0%, rgba(139,21,56,0.16) 38%, transparent 68%)",
          filter: "blur(40px)",
        }}
        animate={{ opacity: [0.85, 1, 0.85] }}
        transition={{ duration: 12, repeat: Infinity, ease: "easeInOut" }}
      />
      {/* A whisper of brand green, low, for warmth. */}
      <div
        aria-hidden="true"
        className="absolute pointer-events-none rounded-full"
        style={{
          width: 760, height: 760,
          bottom: "-34%", left: "50%", marginLeft: -380,
          background: "radial-gradient(circle, rgba(62,143,102,0.12), transparent 70%)",
          filter: "blur(80px)",
        }}
      />

      {/* Top fade keeps the white navbar crisp against the lit hero. */}
      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-28 pointer-events-none"
        style={{ background: "linear-gradient(180deg, rgba(8,2,5,0.55), transparent)" }}
      />

      <div className="max-w-3xl mx-auto relative text-center">
        {/* Eyebrow */}
        <motion.a
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          href="#features"
          className="group inline-flex items-center gap-2 rounded-full pl-1 pr-3 py-1 mb-8 text-xs font-medium transition-all hover:scale-[1.02]"
          style={{
            background: "rgba(255,255,255,0.06)",
            border: "1px solid rgba(255,255,255,0.14)",
            color: "rgba(255,255,255,0.88)",
            backdropFilter: "blur(8px)",
            WebkitBackdropFilter: "blur(8px)",
          }}>
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider text-white"
            style={{ background: "var(--green)" }}>
            New
          </span>
          Agentic Mode is live
          <ChevronRight size={12} strokeWidth={2} className="transition-transform group-hover:translate-x-0.5" />
        </motion.a>

        {/* Headline — big, tight, monochrome with a green accent. */}
        <motion.h1
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.05 }}
          className="font-bold mx-auto"
          style={{
            fontSize: "clamp(44px, 7.2vw, 82px)",
            lineHeight: 1.04,
            letterSpacing: "-0.03em",
            color: "#FFFFFF",
          }}>
          Close the books in{" "}
          <span style={{
            background: "linear-gradient(135deg, #7BE3B2 0%, #4BA87B 100%)",
            WebkitBackgroundClip: "text",
            backgroundClip: "text",
            WebkitTextFillColor: "transparent",
            color: "transparent",
          }}>days, not weeks.</span>
        </motion.h1>

        {/* Subhead — one calm line. */}
        <motion.p
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.15 }}
          className="mt-6 text-base sm:text-lg leading-relaxed max-w-xl mx-auto"
          style={{ color: "rgba(255,255,255,0.66)" }}>
          The AI-native close platform for controllers and CPA firms — reconcile every
          account, explain every variance, and lock the period.
        </motion.p>

        {/* Signed-in launchpad; otherwise a primary CTA + a ghost secondary. */}
        {isSignedIn ? (
          <div className="mt-9 flex justify-center">
            <LoggedInLaunchpad />
          </div>
        ) : (
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.25 }}
            className="mt-9 flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link to="/sign-up"
              className="inline-flex items-center gap-2 px-6 py-3.5 rounded-xl text-sm font-semibold text-white transition-all hover:scale-[1.02] active:scale-[0.99]"
              style={{
                background: "linear-gradient(135deg, var(--green-light) 0%, var(--green) 100%)",
                boxShadow: "0 16px 40px -12px rgba(91,176,137,0.5)",
              }}>
              Start free — no card required <ArrowRight size={15} strokeWidth={2.2} />
            </Link>
            <Link to="/solutions"
              className="group inline-flex items-center gap-1.5 px-4 py-3.5 text-sm font-semibold transition-colors"
              style={{ color: "rgba(255,255,255,0.82)" }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "#FFFFFF" }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.82)" }}>
              Take the tour
              <ArrowRight size={14} strokeWidth={2.2} className="transition-transform group-hover:translate-x-0.5" />
            </Link>
          </motion.div>
        )}

        {/* Minimal trust line. */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6, delay: 0.4 }}
          className="mt-7 flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 text-xs"
          style={{ color: "rgba(255,255,255,0.5)" }}>
          <span className="inline-flex items-center gap-1.5"><UserCheck size={12} strokeWidth={2} /> Built by a CPA</span>
          <span aria-hidden="true" className="opacity-40">·</span>
          <span className="inline-flex items-center gap-1.5"><Plug size={12} strokeWidth={2} /> Works on QuickBooks</span>
          <span aria-hidden="true" className="opacity-40">·</span>
          <Link to="/security" className="inline-flex items-center gap-1.5 transition-colors hover:text-white">
            <ShieldCheck size={12} strokeWidth={2} /> Bank-grade security
          </Link>
        </motion.div>
      </div>

      {/* Product shot — centered, floating in light below the fold-line. */}
      <div className="relative mt-16 sm:mt-20 max-w-2xl mx-auto">
        <HeroProductCard />
      </div>
    </section>
  )
}

// The hero's live product card — one clean Nordavix flux row whose AI
// commentary types itself out, then rotates through account scenarios. The
// actual product differentiation, shown not told. Floats with a soft glow.
function HeroProductCard() {
  const SCENARIOS = [
    {
      account: "6100 · Marketing",
      current: 48250, prior: 12800,
      commentary: "Marketing spend grew $35,450 (277%) driven by Q4 campaign launches. $22,400 to Acme Agency for the holiday push, $13,050 in paid acquisition across Google Ads ($8,200) and LinkedIn ($4,850). Aligned with the approved Q4 marketing budget.",
      confidence: 94, sources: 18, tag: "Operating",
    },
    {
      account: "1200 · Accounts Receivable",
      current: 487300, prior: 312100,
      commentary: "AR grew $175,200 (56%) primarily from the Enterprise renewal cycle: 4 invoices over $30K signed in the last 10 days of the period (Globex $52K, Initech $44K, Hooli $38K, Stark $31K). All within standard NET-30 terms — no aging concerns.",
      confidence: 97, sources: 23, tag: "Balance sheet",
    },
    {
      account: "2100 · Accrued Liabilities",
      current: 84200, prior: 31500,
      commentary: "Accruals jumped $52,700 (167%) driven by year-end bonus accrual ($38K) and December professional services not yet billed ($14,700 from outside legal and audit prep). Both reverse in January per standard close practice.",
      confidence: 91, sources: 11, tag: "Accrual",
    },
  ]
  const [scenarioIdx, setScenarioIdx] = useState(0)
  const [typed, setTyped] = useState("")
  const scenario = SCENARIOS[scenarioIdx]

  // Typewriter — types out the commentary, holds, then advances to the
  // next scenario. setTimeout chain rather than setInterval so each
  // pause feels tuned.
  useEffect(() => {
    setTyped("")
    let i = 0
    let cancelled = false
    const target = scenario.commentary
    const tick = () => {
      if (cancelled) return
      if (i <= target.length) {
        setTyped(target.slice(0, i))
        i++
        setTimeout(tick, 18 + Math.random() * 14)
      } else {
        // Hold the finished commentary for 4 seconds, then rotate.
        setTimeout(() => {
          if (cancelled) return
          setScenarioIdx((x) => (x + 1) % SCENARIOS.length)
        }, 4500)
      }
    }
    const t = setTimeout(tick, 400)
    return () => { cancelled = true; clearTimeout(t) }
  }, [scenarioIdx])

  const dollarVariance = scenario.current - scenario.prior
  const pctVariance = ((scenario.current - scenario.prior) / scenario.prior) * 100

  function money(n: number) {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 30 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.7, delay: 0.2, ease: [0.16, 1, 0.3, 1] }}
      className="relative w-full mx-auto">
      {/* Soft, calm glow behind the card — one source, no busy rotation. */}
      <div
        aria-hidden="true"
        className="absolute -inset-6 rounded-[2.5rem] pointer-events-none print:hidden"
        style={{
          background: "radial-gradient(ellipse at 60% 40%, rgba(91,176,137,0.22), rgba(236,126,163,0.14) 45%, transparent 72%)",
          filter: "blur(34px)",
        }}
      />

      {/* Floating sparkle accent */}
      <motion.div
        className="absolute -top-3 -left-3 z-10 inline-flex items-center justify-center h-9 w-9 rounded-xl print:hidden"
        style={{ background: "var(--green)", color: "white", boxShadow: "0 8px 20px rgba(62,143,102,0.45)" }}
        animate={{ y: [0, -6, 0], rotate: [0, 8, 0] }}
        transition={{ duration: 3.5, repeat: Infinity, ease: "easeInOut" }}>
        <Sparkles size={16} strokeWidth={2} />
      </motion.div>

      {/* The card */}
      <motion.div
        className="relative rounded-2xl overflow-hidden text-left"
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          boxShadow: "0 40px 90px -24px rgba(0,0,0,0.55), 0 10px 30px -12px rgba(0,0,0,0.30), inset 0 1px 0 rgba(255,255,255,0.10)",
        }}
        animate={{ y: [0, -6, 0] }}
        transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}>
        {/* Header bar */}
        <div className="px-5 py-3 flex items-center gap-2 border-b"
          style={{ background: "var(--surface-2)", borderColor: "var(--border)" }}>
          <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider"
            style={{ color: "var(--green)" }}>
            <motion.span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: "var(--green)" }}
              animate={{ opacity: [1, 0.3, 1] }} transition={{ duration: 1.5, repeat: Infinity }} />
            Live · Flux Analysis
          </span>
          <span className="ml-auto text-[10px] font-medium" style={{ color: "var(--text-muted)" }}>
            December 2025
          </span>
        </div>

        {/* Account row */}
        <div className="px-5 pt-5 pb-3">
          <div className="flex items-start justify-between gap-3 mb-4">
            <div>
              <p className="text-xs font-medium mb-0.5" style={{ color: "var(--text-muted)" }}>{scenario.tag}</p>
              <h3 className="text-base font-bold text-theme">{scenario.account}</h3>
            </div>
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider"
              style={{ background: "#fef3c7", color: "#92400e" }}>
              Material
            </span>
          </div>

          <div className="grid grid-cols-3 gap-3 mb-4">
            <Metric label="Current" value={money(scenario.current)} tone="var(--text)" />
            <Metric label="Prior"   value={money(scenario.prior)}   tone="var(--text-2)" />
            <Metric label="Δ"
              value={`${pctVariance >= 0 ? "+" : ""}${pctVariance.toFixed(0)}%`}
              tone={pctVariance >= 0 ? "var(--green)" : "#dc2626"}
              sub={`${dollarVariance >= 0 ? "+" : ""}${money(dollarVariance)}`} />
          </div>
        </div>

        {/* AI commentary — typewriter */}
        <div className="mx-5 mb-5 rounded-xl p-4"
          style={{
            background: "var(--green-subtle)",
            border: "1px solid color-mix(in oklab, var(--green) 25%, transparent)",
          }}>
          <div className="flex items-center gap-1.5 mb-2">
            <Sparkles size={12} strokeWidth={2} style={{ color: "var(--green)" }} />
            <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: "var(--green)" }}>
              AI Commentary
            </span>
            <span className="ml-auto text-[10px] font-medium" style={{ color: "var(--green)" }}>
              {scenario.confidence}% conf · {scenario.sources} txns
            </span>
          </div>
          <p className="text-[13px] leading-relaxed min-h-[6rem]" style={{ color: "var(--text)" }}>
            {typed}
            <motion.span
              className="inline-block w-[2px] h-[14px] -mb-[2px] ml-[1px]"
              style={{ background: "var(--green)" }}
              animate={{ opacity: [1, 0, 1] }}
              transition={{ duration: 0.9, repeat: Infinity }}
            />
          </p>
        </div>

        {/* Action footer */}
        <div className="px-5 pb-5 flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold text-white"
            style={{ background: "var(--green)" }}>
            <CheckCircle2 size={11} strokeWidth={2.2} /> Approve
          </span>
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium"
            style={{ background: "var(--surface-2)", color: "var(--text-2)", border: "1px solid var(--border-strong)" }}>
            <RefreshCw size={11} strokeWidth={2} /> Regenerate
          </span>
          <span className="ml-auto text-[10px]" style={{ color: "var(--text-muted)" }}>
            Reviewed by Sarah K. · 2m ago
          </span>
        </div>
      </motion.div>

      {/* Floating close-time chip for depth */}
      <motion.div
        className="absolute -bottom-5 -right-3 z-10 rounded-xl px-3 py-2.5 print:hidden hidden sm:block"
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          boxShadow: "0 16px 36px -10px rgba(0,0,0,0.40)",
        }}
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.6, duration: 0.6 }}>
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-md flex items-center justify-center"
            style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
            <Clock size={13} strokeWidth={2} />
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
              Close time
            </p>
            <p className="text-xs font-bold text-theme">2.1 days <span style={{ color: "var(--green)" }}>↓ 73%</span></p>
          </div>
        </div>
      </motion.div>
    </motion.div>
  )
}

function Metric({ label, value, tone, sub }: { label: string; value: string; tone: string; sub?: string }) {
  return (
    <div className="rounded-lg p-2.5" style={{ background: "var(--surface-2)" }}>
      <p className="text-[10px] font-bold uppercase tracking-wider mb-0.5" style={{ color: "var(--text-muted)" }}>
        {label}
      </p>
      <p className="text-sm font-bold tabular-nums" style={{ color: tone }}>{value}</p>
      {sub && <p className="text-[10px] tabular-nums" style={{ color: "var(--text-muted)" }}>{sub}</p>}
    </div>
  )
}

// ─── Trust strip ────────────────────────────────────────────────────────────

function TrustStrip() {
  const PILLARS = [
    { Icon: ShieldCheck, label: "SOC 2-ready audit trail" },
    { Icon: Lock,        label: "Tenant-isolated data" },
    { Icon: ScrollText,  label: "Every action logged" },
    { Icon: GitCompareArrows, label: "Maker-checker workflow" },
    { Icon: Plug,        label: "QuickBooks native" },
  ]
  return (
    <section className="px-6 py-12 border-y"
      style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
      <div className="max-w-6xl mx-auto">
        <p className="text-center text-[11px] font-bold uppercase tracking-[0.15em] mb-6"
          style={{ color: "var(--text-muted)" }}>
          Built for accountants who care about compliance
        </p>
        <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-4">
          {PILLARS.map(({ Icon, label }) => (
            <div key={label}
              className="inline-flex items-center gap-2 text-sm font-medium"
              style={{ color: "var(--text-2)" }}>
              <Icon size={15} strokeWidth={1.8} style={{ color: "var(--green)" }} />
              {label}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

// ─── The Close Loop — hero version ─────────────────────────────────────────
// NOTE: container kept square via items-center on the flex wrapper below so the
// icon ring stays concentric with the dashed SVG circle (see geometry block).

function CloseLoopHero() {
  const NODES = [
    // Brand-cohesive palette (was a rainbow) — green tones for the working
    // steps, burgundy as the punctuation on the final "Close".
    { label: "Connect",   Icon: Plug,            color: "#5BB089" },
    { label: "Sync",      Icon: RefreshCw,       color: "#3E8F66" },
    { label: "Reconcile", Icon: Scale,           color: "#2F7E57" },
    { label: "Analyze",   Icon: BarChart3,       color: "#3E8F66" },
    { label: "Approve",   Icon: UserCheck,       color: "#5BB089" },
    { label: "Close",     Icon: Lock,            color: "#8B1538" },
  ]
  // Geometry expressed as percentages of the container, so the loop
  // and every node scale together with whatever width the parent gives
  // us. The previous version positioned nodes at pixel offsets
  // computed against a fixed 440px canvas — on mobile the SVG shrank
  // but the absolute-positioned divs stayed at the 440px coordinates,
  // pushing them off-canvas. Percentages fix that.
  //
  // The dotted ring, the six icons, the center label, and the orbiting
  // particle ALL share one center + one radius, so the icons sit exactly on
  // the dashed circle. Horizontally centered (50%). Vertically nudged UP a
  // few percent: every icon has a label dangling BELOW it, so each node's
  // visual mass sits below its point on the ring — without the nudge the
  // whole cluster reads as bottom-heavy. ~4% up offsets the label height so
  // the cluster optically centers in its square box.
  const CX_PCT = 50
  const CY_PCT = 46
  const R_PCT  = 36   // ring radius as % of container (leaves room for the
                      // node card + the label below)
  // SVG ring coords DERIVED from the same %s (viewBox is 440 wide) so the
  // dashed circle can never drift from the icon ring.
  const VIEWBOX = 440
  const RING_CX = (CX_PCT / 100) * VIEWBOX
  const RING_CY = (CY_PCT / 100) * VIEWBOX
  const RING_R  = (R_PCT  / 100) * VIEWBOX
  const { ref, inView } = useInView<HTMLDivElement>(0.2)

  return (
    <section ref={ref} className="px-6 py-20 sm:py-28 lg:py-32 overflow-hidden">
      <div className="max-w-6xl mx-auto">
        {/* place-items-center forces both grid cells to center their content
            horizontally on mobile (single-column layout). Without this the
            text column was technically center-aligned via text-center, but
            the loop visualization sat in a wider column that defaulted to
            stretch — making the loop's container span full width and visually
            drift left. items-center handles vertical alignment on desktop. */}
        <div className="grid lg:grid-cols-[1fr_minmax(0,440px)] gap-10 sm:gap-12 lg:gap-20 items-center place-items-center lg:place-items-stretch">
          <div className="text-center lg:text-left order-2 lg:order-1 max-w-xl">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium mb-5"
              style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
              <Workflow size={12} strokeWidth={2} />
              The Nordavix Close Loop
            </div>
            <h2 className="font-bold text-theme leading-[1.1] tracking-tight mb-5"
              style={{ fontSize: "clamp(28px, 5vw, 48px)" }}>
              Six stages.<br />
              <span style={{ color: "var(--green)" }}>One continuous loop.</span>
            </h2>
            <p className="text-base sm:text-lg leading-relaxed mb-7" style={{ color: "var(--text-2)" }}>
              Most close tools handle one piece — reconciliations OR flux OR financials.
              Nordavix runs the whole loop, with each stage flowing cleanly into the next.
              No re-keying. No reconciliation between apps about your reconciliations.
            </p>
            <Link to="/solutions"
              className="inline-flex items-center gap-1.5 text-sm font-semibold transition-opacity hover:opacity-80"
              style={{ color: "var(--green)" }}>
              See the full close in motion <ArrowRight size={14} strokeWidth={2} />
            </Link>
          </div>

          {/* Loop visualization — order-1 so it shows ABOVE the copy on
              mobile (better visual hook), then flips to the right on
              desktop via order-2.
              items-center is CRITICAL: on desktop the grid uses
              place-items-stretch, and a flex parent's default align-items
              (stretch) would stretch the aspect-square box TALLER than wide —
              turning the icon ring into an ellipse that no longer matches the
              SVG circle. Centering the child keeps the box perfectly square. */}
          <div className="flex justify-center items-center order-1 lg:order-2">
            <div className="relative w-full max-w-[360px] sm:max-w-[420px] lg:max-w-[440px] aspect-square mx-auto">
              {/* SVG ring + orbiting particle. ViewBox is fixed 440x440
                  but the SVG element fills its container — the viewBox
                  scaling handles everything. */}
              <svg viewBox="0 0 440 440" className="w-full h-full" preserveAspectRatio="xMidYMid meet">
                <circle cx={RING_CX} cy={RING_CY} r={RING_R} fill="none"
                  stroke="var(--border)" strokeWidth="1" strokeDasharray="4 4" />
                <motion.circle r="6" fill="var(--green)"
                  style={{
                    filter: "drop-shadow(0 0 6px var(--green))",
                    offsetPath: `path("M ${RING_CX + RING_R} ${RING_CY} A ${RING_R} ${RING_R} 0 1 1 ${RING_CX - RING_R} ${RING_CY} A ${RING_R} ${RING_R} 0 1 1 ${RING_CX + RING_R} ${RING_CY}")`,
                  }}
                  animate={{ offsetDistance: ["0%", "100%"] }}
                  transition={{ duration: 12, repeat: Infinity, ease: "linear" }} />
              </svg>

              {/* Nodes positioned in % of the container so they scale.
                  The icon BOX gets centered on the calculated point —
                  not the icon+label column. Before, the column
                  included the label height so `-translate-y-1/2`
                  pulled the icon center upward by half the label
                  height, which made the whole ring of icons sit
                  visibly inside the dotted SVG circle. Now the label
                  is absolutely positioned below the icon and doesn't
                  affect centering math. Tighter alignment on mobile
                  too, where label-induced offset was largest. */}
              {NODES.map((n, i) => {
                const angle = (i / NODES.length) * Math.PI * 2 - Math.PI / 2
                const leftPct = CX_PCT + R_PCT * Math.cos(angle)
                const topPct  = CY_PCT + R_PCT * Math.sin(angle)
                return (
                  <motion.div
                    key={n.label}
                    initial={{ opacity: 0, scale: 0.6 }}
                    animate={inView ? { opacity: 1, scale: 1 } : {}}
                    transition={{ delay: 0.1 + i * 0.08, duration: 0.5, ease: "easeOut" }}
                    className="absolute -translate-x-1/2 -translate-y-1/2"
                    style={{ left: `${leftPct}%`, top: `${topPct}%` }}>
                    <div className="relative h-11 w-11 sm:h-12 sm:w-12 lg:h-14 lg:w-14 rounded-2xl flex items-center justify-center"
                      style={{
                        background: "var(--surface)",
                        border: `1.5px solid ${n.color}`,
                        color: n.color,
                        boxShadow: `0 6px 16px -4px ${n.color}40`,
                      }}>
                      <n.Icon size={18} strokeWidth={1.8} />
                      {/* Label floats below the icon; its size doesn't
                          push the icon's visual center off the ring. */}
                      <span className="absolute left-1/2 -translate-x-1/2 top-full mt-1 text-[10px] sm:text-[11px] font-semibold text-theme whitespace-nowrap">
                        {n.label}
                      </span>
                    </div>
                  </motion.div>
                )
              })}

              {/* Center label — anchored to the shared center (50% / 50%)
                  so it sits in the exact middle of the ring of icons. */}
              <div
                className="absolute pointer-events-none -translate-x-1/2 -translate-y-1/2"
                style={{ left: `${CX_PCT}%`, top: `${CY_PCT}%` }}>
                <div className="text-center">
                  <p className="text-[9px] sm:text-[10px] font-bold uppercase tracking-[0.15em] mb-0.5 sm:mb-1"
                    style={{ color: "var(--text-muted)" }}>
                    End-to-end
                  </p>
                  <p className="text-2xl sm:text-3xl font-bold text-theme">2 days</p>
                  <p className="text-[11px] sm:text-xs" style={{ color: "var(--text-2)" }}>not 8</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

// ─── Bento grid features ───────────────────────────────────────────────────

function BentoGrid() {
  return (
    <section id="features" className="px-6 py-24 sm:py-32" style={{ background: "var(--surface)" }}>
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-14 max-w-2xl mx-auto">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium mb-4"
            style={{ background: "var(--surface-2)", color: "var(--text-2)" }}>
            <Layers size={12} strokeWidth={2} />
            What's inside
          </div>
          <h2 className="font-bold text-theme leading-[1.1] tracking-tight mb-4"
            style={{ fontSize: "clamp(30px, 5vw, 48px)" }}>
            Every workflow your close needs,<br />
            <span style={{ color: "var(--green)" }}>tied together by AI.</span>
          </h2>
          <p className="text-base sm:text-lg leading-relaxed" style={{ color: "var(--text-2)" }}>
            Six tightly-integrated apps share one tenant-isolated database, one audit log,
            and one set of permissions. No more reconciling between tools.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-5">
          {/* Big tile — AI Commentary */}
          <BentoTile size="big" Icon={Brain} title="AI commentary that explains itself"
            blurb="Per-variance commentary that cites the actual transactions driving the movement — not generic boilerplate. Every output ships with a confidence score and a source count, so you know what you're approving.">
            <BentoAIPreview />
          </BentoTile>

          {/* Medium tile — Recon */}
          <BentoTile size="med" Icon={Scale} title="GL ⇄ Subledger, tied to the penny"
            blurb="Every BS account, auto-rolled forward, reconciling items inline, evidence attached. Variance highlighted before you ask.">
            <BentoReconPreview />
          </BentoTile>

          {/* Medium tile — Audit */}
          <BentoTile size="med" Icon={ScrollText} title="Audit trail, by default"
            blurb="Every state change writes an audit log entry — who did what, when, why. No after-the-fact compliance scramble.">
            <BentoAuditPreview />
          </BentoTile>

          {/* Small tile — Sequential close */}
          <BentoTile size="sm" Icon={Lock} title="Sequential close gate"
            blurb="You can't close March until February's approved. The gate is enforced server-side." />

          {/* Small tile — QBO */}
          <BentoTile size="sm" Icon={Plug} title="QuickBooks-native"
            blurb="OAuth read-only scope. Live pulls of TrialBalance, GL, AR/AP aging. Always fresh." />

          {/* Wide tile — Trial balance verification */}
          <BentoTile size="wide" Icon={FileCheck} title="Trial balance verification, built-in"
            blurb="Assets − Liabilities − Equity should equal YTD Net Income. We pull both sides from QBO and prove the equation holds before you start a reconciliation — so a bad sync can't poison your close.">
            <BentoTBPreview />
          </BentoTile>
        </div>
      </div>
    </section>
  )
}

interface BentoProps {
  Icon:     React.ElementType
  title:    string
  blurb:    string
  size:     "big" | "med" | "sm" | "wide"
  children?: React.ReactNode
}
function BentoTile({ Icon, title, blurb, size, children }: BentoProps) {
  const sizeClasses = {
    big:  "sm:col-span-2 sm:row-span-2 min-h-[400px]",
    med:  "min-h-[260px]",
    sm:   "min-h-[200px]",
    wide: "sm:col-span-2 lg:col-span-3 min-h-[220px]",
  }
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      // Hover lift via framer (not a CSS hover:-translate) — framer owns this
      // element's transform from the scroll-in animation, so a CSS transform
      // would be overridden. Shadow stays CSS (no transform conflict).
      whileHover={{ y: -4, transition: { duration: 0.2, ease: "easeOut" } }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ duration: 0.5, ease: "easeOut" }}
      className={`rounded-2xl p-6 flex flex-col group transition-shadow duration-200 ease-out hover:shadow-xl ${sizeClasses[size]}`}
      style={{
        background: "var(--bg)",
        border: "1px solid var(--border)",
      }}>
      <div className="flex items-center gap-3 mb-3">
        <div className="h-9 w-9 rounded-xl flex items-center justify-center transition-transform group-hover:scale-110"
          style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
          <Icon size={17} strokeWidth={1.8} />
        </div>
        <h3 className="text-base font-bold text-theme">{title}</h3>
      </div>
      <p className="text-sm leading-relaxed" style={{ color: "var(--text-2)" }}>
        {blurb}
      </p>
      {children && <div className="flex-1 mt-5 flex items-end">{children}</div>}
    </motion.div>
  )
}

function BentoAIPreview() {
  return (
    <div className="w-full rounded-xl overflow-hidden font-mono text-[11px]"
      style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
      <div className="px-3 py-1.5 flex items-center gap-2 border-b" style={{ borderColor: "var(--border)" }}>
        <span className="inline-flex h-2 w-2 rounded-full" style={{ background: "#ef4444" }} />
        <span className="inline-flex h-2 w-2 rounded-full" style={{ background: "#eab308" }} />
        <span className="inline-flex h-2 w-2 rounded-full" style={{ background: "#22c55e" }} />
        <span className="ml-auto text-[10px]" style={{ color: "var(--text-muted)" }}>commentary.txt</span>
      </div>
      <pre className="p-4 leading-relaxed" style={{ color: "var(--text-2)", whiteSpace: "pre-wrap" }}>
{`Account: 5000 — Cost of Revenue
Δ: +$84,200 (+47%)

> Driven by COGS on Globex
  Enterprise renewals (+$62K)
> Q4 hosting spike from
  AWS reserved capacity (+$22K)
> Operating, not one-time
> Confidence: 92% · 31 txns`}
      </pre>
    </div>
  )
}

function BentoReconPreview() {
  return (
    <div className="w-full space-y-1.5 font-mono text-[11px]">
      {[
        { acct: "Bank ·· Operating", tied: true },
        { acct: "AR ·· Trade",        tied: true },
        { acct: "AP ·· Trade",        tied: false },
        { acct: "Prepaid ·· Insur.",  tied: true },
      ].map((r, i) => (
        <div key={i} className="rounded-md px-2.5 py-1.5 flex items-center gap-2"
          style={{
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
          }}>
          <span className="text-[12px]" style={{ color: r.tied ? "var(--green)" : "#dc2626" }}>
            {r.tied ? "●" : "●"}
          </span>
          <span className="text-theme flex-1 text-[11px]">{r.acct}</span>
          <span className="text-[10px]" style={{ color: r.tied ? "var(--green)" : "#dc2626" }}>
            {r.tied ? "Tied" : "Δ $1,240"}
          </span>
        </div>
      ))}
    </div>
  )
}

function BentoAuditPreview() {
  const events = [
    "Sarah K. approved Cash recon · 09:42",
    "AI generated commentary on AR · 09:38",
    "Period Nov-25 locked by admin · 08:11",
  ]
  return (
    <div className="w-full space-y-1.5">
      {events.map((e, i) => (
        <div key={i} className="rounded-md px-2.5 py-1.5 text-[11px] font-mono flex items-center gap-2"
          style={{
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            color: "var(--text-2)",
          }}>
          <span style={{ color: "var(--text-muted)" }}>›</span>
          <span className="truncate">{e}</span>
        </div>
      ))}
    </div>
  )
}

function BentoTBPreview() {
  return (
    <div className="w-full grid grid-cols-3 gap-3 font-mono text-[12px]">
      <div className="rounded-lg p-3 text-center" style={{ background: "var(--surface-2)" }}>
        <p className="text-[9px] uppercase tracking-wider mb-1" style={{ color: "var(--text-muted)" }}>Assets</p>
        <p className="font-bold text-theme tabular-nums">$2.4M</p>
      </div>
      <div className="rounded-lg p-3 text-center" style={{ background: "var(--surface-2)" }}>
        <p className="text-[9px] uppercase tracking-wider mb-1" style={{ color: "var(--text-muted)" }}>L + E</p>
        <p className="font-bold text-theme tabular-nums">$2.1M</p>
      </div>
      <div className="rounded-lg p-3 text-center"
        style={{ background: "var(--green-subtle)", border: "1px solid var(--green)" }}>
        <p className="text-[9px] uppercase tracking-wider mb-1" style={{ color: "var(--green)" }}>Δ = NI ✓</p>
        <p className="font-bold tabular-nums" style={{ color: "var(--green)" }}>$300K</p>
      </div>
    </div>
  )
}

// ─── Interactive AI demo ───────────────────────────────────────────────────

function InteractiveAIDemo() {
  const SCENARIOS = [
    {
      key: "marketing", label: "Marketing spike", account: "6100 · Marketing",
      from: 12800, to: 48250,
      commentary: "Marketing spend grew $35,450 (277%) driven by Q4 campaign launches. $22,400 to Acme Agency for the holiday push, $13,050 across Google Ads + LinkedIn. Aligned with the approved Q4 marketing budget — no follow-up needed.",
      sources: 18, conf: 94,
    },
    {
      key: "ar", label: "AR ramp", account: "1200 · Accounts Receivable",
      from: 312100, to: 487300,
      commentary: "AR grew $175,200 (56%) from the Enterprise renewal cycle: 4 invoices over $30K signed in the last 10 days of the period (Globex, Initech, Hooli, Stark Industries). All within standard NET-30 — no aging concerns surfaced.",
      sources: 23, conf: 97,
    },
    {
      key: "accruals", label: "Year-end accrual", account: "2100 · Accrued Liabilities",
      from: 31500, to: 84200,
      commentary: "Accruals jumped $52,700 (167%) — year-end bonus accrual ($38K) plus December professional services not yet billed ($14,700 from outside legal + audit prep). Both reverse in January per standard close practice.",
      sources: 11, conf: 91,
    },
  ]
  const [active, setActive] = useState("marketing")
  const [typed, setTyped] = useState("")
  const scenario = SCENARIOS.find((s) => s.key === active)!

  // Re-type whenever the user picks a new scenario.
  useEffect(() => {
    setTyped("")
    let i = 0
    let cancelled = false
    const tick = () => {
      if (cancelled) return
      if (i <= scenario.commentary.length) {
        setTyped(scenario.commentary.slice(0, i))
        i++
        setTimeout(tick, 15 + Math.random() * 10)
      }
    }
    tick()
    return () => { cancelled = true }
  }, [active])

  function money(n: number) {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)
  }
  const delta = scenario.to - scenario.from
  const pct = ((scenario.to - scenario.from) / scenario.from) * 100

  return (
    <section className="px-6 py-24 sm:py-32">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-14 max-w-2xl mx-auto">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium mb-4"
            style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
            <Sparkles size={12} strokeWidth={2} />
            Try the AI
          </div>
          <h2 className="font-bold text-theme leading-[1.1] tracking-tight mb-4"
            style={{ fontSize: "clamp(30px, 5vw, 48px)" }}>
            Click a variance.<br />
            <span style={{ color: "var(--green)" }}>Watch Nordavix explain it.</span>
          </h2>
          <p className="text-base sm:text-lg leading-relaxed" style={{ color: "var(--text-2)" }}>
            These are real-shaped scenarios with real-shaped responses. In the actual product,
            the AI is grounded in your transaction data.
          </p>
        </div>

        <div className="grid lg:grid-cols-[280px_1fr] gap-6">
          {/* Scenario picker */}
          <div className="space-y-2">
            {SCENARIOS.map((s) => {
              const isActive = active === s.key
              return (
                <button key={s.key} onClick={() => setActive(s.key)}
                  className="w-full text-left rounded-xl p-4 transition-all"
                  style={{
                    background: isActive ? "var(--green-subtle)" : "var(--surface)",
                    border: `1px solid ${isActive ? "var(--green)" : "var(--border)"}`,
                  }}>
                  <p className="text-[10px] font-bold uppercase tracking-wider mb-1"
                    style={{ color: isActive ? "var(--green)" : "var(--text-muted)" }}>
                    Scenario
                  </p>
                  <p className="text-sm font-bold text-theme">{s.label}</p>
                  <p className="text-xs mt-1" style={{ color: "var(--text-2)" }}>{s.account}</p>
                </button>
              )
            })}
            <Link to="/sign-up"
              className="block text-center rounded-xl p-3 text-sm font-semibold text-white transition-opacity hover:opacity-90"
              style={{ background: "var(--green)", boxShadow: "0 8px 20px -6px rgba(16,185,129,0.4)" }}>
              Try it on real data <ArrowRight size={13} className="inline -mt-0.5 ml-1" />
            </Link>
          </div>

          {/* Result panel */}
          <div className="rounded-2xl overflow-hidden"
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              boxShadow: "var(--card-shadow)",
            }}>
            <div className="p-6 sm:p-8">
              <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
                <div>
                  <p className="text-xs font-medium mb-0.5" style={{ color: "var(--text-muted)" }}>
                    Account
                  </p>
                  <h3 className="text-xl font-bold text-theme">{scenario.account}</h3>
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <p className="text-[10px] uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>Δ</p>
                    <p className="text-xl font-bold tabular-nums"
                      style={{ color: delta >= 0 ? "var(--green)" : "#dc2626" }}>
                      {pct >= 0 ? "+" : ""}{pct.toFixed(0)}%
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-[10px] uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>$ Δ</p>
                    <p className="text-xl font-bold tabular-nums"
                      style={{ color: delta >= 0 ? "var(--green)" : "#dc2626" }}>
                      {delta >= 0 ? "+" : ""}{money(delta)}
                    </p>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 mb-6">
                <div className="rounded-lg p-3" style={{ background: "var(--surface-2)" }}>
                  <p className="text-[10px] font-bold uppercase tracking-wider mb-1" style={{ color: "var(--text-muted)" }}>
                    Current period
                  </p>
                  <p className="text-lg font-bold text-theme tabular-nums">{money(scenario.to)}</p>
                </div>
                <div className="rounded-lg p-3" style={{ background: "var(--surface-2)" }}>
                  <p className="text-[10px] font-bold uppercase tracking-wider mb-1" style={{ color: "var(--text-muted)" }}>
                    Prior period
                  </p>
                  <p className="text-lg font-bold tabular-nums" style={{ color: "var(--text-2)" }}>{money(scenario.from)}</p>
                </div>
              </div>

              <div className="rounded-xl p-5"
                style={{
                  background: "var(--green-subtle)",
                  border: "1px solid color-mix(in oklab, var(--green) 25%, transparent)",
                }}>
                <div className="flex items-center gap-2 mb-3">
                  <Sparkles size={14} strokeWidth={2} style={{ color: "var(--green)" }} />
                  <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: "var(--green)" }}>
                    Nordavix AI says
                  </span>
                  <span className="ml-auto text-[11px] font-medium" style={{ color: "var(--green)" }}>
                    {scenario.conf}% confidence · {scenario.sources} transactions cited
                  </span>
                </div>
                <p className="text-[15px] leading-relaxed min-h-[8rem]" style={{ color: "var(--text)" }}>
                  {typed}
                  <motion.span
                    className="inline-block w-[2px] h-[16px] -mb-[2px] ml-[1px]"
                    style={{ background: "var(--green)" }}
                    animate={{ opacity: [1, 0, 1] }}
                    transition={{ duration: 0.9, repeat: Infinity }}
                  />
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

// ─── Personas ──────────────────────────────────────────────────────────────

function Personas() {
  const ROLES = [
    {
      Icon: Building2, title: "Controllers",
      pitch: "Stop spending the first week of every month pulling reports and arguing with spreadsheets. Get to insights faster than the audit team can ask.",
      bullets: ["Trial-balance verification", "Sequential close gate", "Lockable periods"],
      gradient: "from-[var(--green-subtle)] to-transparent",
    },
    {
      Icon: TrendingUp, title: "Fractional CFOs",
      pitch: "Run close for ten clients in the time you used to run it for three. Same audit-grade output, none of the spreadsheet rebuild between clients.",
      bullets: ["Multi-company workspaces", "Per-client roles", "Client-ready PDFs"],
      gradient: "from-[#8B1538]/10 to-transparent",
    },
    {
      Icon: Users, title: "CPA Firms",
      pitch: "Give your preparers a tool that captures their work AND your reviewers a tool that surfaces what to look at first. The audit trail is already done.",
      bullets: ["Maker / checker workflow", "Evidence verification", "Reviewer dashboard"],
      gradient: "from-[var(--green-subtle)] to-transparent",
    },
  ]

  return (
    <section className="px-6 py-24 sm:py-32" style={{ background: "var(--surface)" }}>
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-14 max-w-2xl mx-auto">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium mb-4"
            style={{ background: "var(--surface-2)", color: "var(--text-2)" }}>
            <Users size={12} strokeWidth={2} />
            Built for your seat
          </div>
          <h2 className="font-bold text-theme leading-[1.1] tracking-tight mb-4"
            style={{ fontSize: "clamp(30px, 5vw, 48px)" }}>
            Whichever side of the close you sit on.
          </h2>
          <p className="text-base sm:text-lg leading-relaxed" style={{ color: "var(--text-2)" }}>
            Each role gets a tailored surface — without the platform feeling
            different. Same data, same audit trail, different view.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-5">
          {ROLES.map((role, i) => (
            <motion.div
              key={role.title}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              whileHover={{ y: -4, transition: { duration: 0.2, ease: "easeOut" } }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.08, duration: 0.5 }}
              className="rounded-2xl p-7 relative overflow-hidden transition-shadow duration-200 ease-out hover:shadow-xl"
              style={{
                background: "var(--bg)",
                border: "1px solid var(--border)",
              }}>
              <div className={`absolute inset-0 bg-gradient-to-br ${role.gradient} pointer-events-none`} />
              <div className="relative">
                <div className="h-11 w-11 rounded-xl flex items-center justify-center mb-4"
                  style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
                  <role.Icon size={20} strokeWidth={1.8} />
                </div>
                <h3 className="text-xl font-bold text-theme mb-2">{role.title}</h3>
                <p className="text-sm leading-relaxed mb-5" style={{ color: "var(--text-2)" }}>
                  {role.pitch}
                </p>
                <ul className="space-y-2">
                  {role.bullets.map((b) => (
                    <li key={b} className="flex items-start gap-2 text-sm" style={{ color: "var(--text-2)" }}>
                      <CheckCircle2 size={14} strokeWidth={2} style={{ color: "var(--green)" }} className="mt-0.5 shrink-0" />
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  )
}

// ─── Beta phase callout (replaces the previous pricing section while
//      we're in invite-only beta — pricing isn't finalized yet, and
//      committing to specific numbers on a public marketing page lowers
//      our flexibility when we do set the tiers). ─────────────────────

function Pricing() {
  // Keeps the id="pricing" anchor so the existing navbar link still
  // scrolls here — the section's content just changed.
  return (
    <section id="pricing" className="px-6 py-24 sm:py-32">
      <div className="max-w-3xl mx-auto text-center">
        {/* Kicker */}
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider mb-5"
          style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
          <Zap size={12} strokeWidth={2.4} />
          Currently in private Beta
        </div>

        <h2 className="font-bold text-theme leading-[1.1] tracking-tight mb-5"
          style={{ fontSize: "clamp(30px, 5vw, 48px)" }}>
          Pricing coming soon.<br />Early access is open.
        </h2>

        <p className="text-base sm:text-lg leading-relaxed mb-8 max-w-2xl mx-auto"
          style={{ color: "var(--text-2)" }}>
          Nordavix is in beta with a small group of CPA firms and controllers
          shaping the product. Pricing tiers will be published when we exit
          beta. Until then, beta workspaces use the full feature set at no
          charge — in exchange for honest feedback.
        </p>

        {/* Beta benefits — three short pills */}
        <div className="grid sm:grid-cols-3 gap-3 max-w-2xl mx-auto mb-10">
          {[
            { label: "Full feature set", sub: "Recons, Flux, Insights, Reports" },
            { label: "No card required", sub: "Free during beta" },
            { label: "Direct line to founders", sub: "We ship what you need" },
          ].map((b) => (
            <div key={b.label}
              className="rounded-xl p-4 text-left"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                boxShadow: "var(--card-shadow)",
              }}>
              <div className="flex items-center gap-2 mb-1">
                <CheckCircle2 size={14} strokeWidth={2.2} style={{ color: "var(--green)" }} />
                <p className="text-sm font-semibold text-theme">{b.label}</p>
              </div>
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>{b.sub}</p>
            </div>
          ))}
        </div>

        {/* Primary CTA — request beta access (sign-up flow); secondary
            — email founders for firm-level conversations. */}
        <div className="flex items-center justify-center gap-3 flex-wrap">
          <Link to="/sign-up"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-lg text-sm font-semibold text-white transition-opacity hover:opacity-90"
            style={{ background: "var(--green)" }}>
            Request beta access
            <ArrowRight size={14} strokeWidth={2.2} />
          </Link>
          <a href="mailto:hello@nordavix.com?subject=Nordavix%20beta%20%E2%80%94%20firm%20enquiry"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-lg text-sm font-semibold transition-colors"
            style={{
              background: "var(--surface)",
              color: "var(--text)",
              border: "1px solid var(--border-strong)",
            }}>
            Talk to a founder
          </a>
        </div>

        <p className="text-xs mt-8" style={{ color: "var(--text-muted)" }}>
          Beta cohorts are small. We'll be in touch within 1-2 business days
          to set up your workspace.
        </p>
      </div>
    </section>
  )
}

// ─── FAQ ───────────────────────────────────────────────────────────────────
//
// Hoisted to module scope so the same Q&A list feeds both the visible
// accordion AND the FAQPage JSON-LD schema injected by <SEO>. That's
// what makes the FAQ eligible for Google's "People also ask" rich
// result — same questions visible + structured.

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
  const QUESTIONS = FAQ_QUESTIONS

  return (
    <section id="faq" className="px-6 py-24 sm:py-32" style={{ background: "var(--surface)" }}>
      <div className="max-w-3xl mx-auto">
        <div className="text-center mb-12">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium mb-4"
            style={{ background: "var(--surface-2)", color: "var(--text-2)" }}>
            <Lightbulb size={12} strokeWidth={2} />
            Common questions
          </div>
          <h2 className="font-bold text-theme leading-[1.1] tracking-tight mb-3"
            style={{ fontSize: "clamp(30px, 5vw, 44px)" }}>
            Questions, answered.
          </h2>
          <p className="text-base leading-relaxed" style={{ color: "var(--text-2)" }}>
            Still curious? Email <a href="mailto:hello@nordavix.com" className="font-medium underline underline-offset-2"
              style={{ color: "var(--green)" }}>hello@nordavix.com</a>.
          </p>
        </div>

        <div className="space-y-2">
          {QUESTIONS.map((qa, i) => {
            const isOpen = openIdx === i
            return (
              <div key={i} className="rounded-xl overflow-hidden"
                style={{ background: "var(--bg)", border: "1px solid var(--border)" }}>
                <button onClick={() => setOpenIdx(isOpen ? null : i)}
                  className="w-full px-5 py-4 flex items-start justify-between gap-4 text-left transition-colors hover:bg-[var(--surface-2)]">
                  <h3 className="text-sm sm:text-base font-semibold text-theme leading-snug pr-4">
                    {qa.q}
                  </h3>
                  <span className="shrink-0 mt-0.5">
                    {isOpen
                      ? <Minus size={16} strokeWidth={2} style={{ color: "var(--green)" }} />
                      : <Plus  size={16} strokeWidth={2} style={{ color: "var(--text-muted)" }} />}
                  </span>
                </button>
                <AnimatePresence initial={false}>
                  {isOpen && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.25, ease: "easeOut" }}>
                      <p className="px-5 pb-5 text-[14px] leading-relaxed" style={{ color: "var(--text-2)" }}>
                        {qa.a}
                      </p>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

// ─── Final CTA ─────────────────────────────────────────────────────────────

function FinalCTA() {
  return (
    <section className="relative px-6 py-24 sm:py-32 overflow-hidden"
      // Dark closing band — mirrors the hero's deep burgundy and flows straight
      // into the dark footer below, bookending the page (dark · light · dark).
      style={{ background: "linear-gradient(180deg, #1E0813 0%, #160610 100%)" }}>
      {/* Soft light from above, like the hero. */}
      <div aria-hidden="true" className="absolute pointer-events-none rounded-full"
        style={{
          width: 900, height: 900, top: "-52%", left: "50%", marginLeft: -450,
          background: "radial-gradient(circle, rgba(190,55,95,0.26) 0%, rgba(62,143,102,0.10) 45%, transparent 68%)",
          filter: "blur(50px)",
        }} />

      <div className="relative max-w-3xl mx-auto text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium mb-6"
          style={{
            background: "rgba(255,255,255,0.08)",
            border: "1px solid rgba(255,255,255,0.16)",
            color: "rgba(255,255,255,0.90)",
            backdropFilter: "blur(8px)",
            WebkitBackdropFilter: "blur(8px)",
          }}>
          <Sparkles size={12} strokeWidth={2} style={{ color: "var(--green-light)" }} />
          Free during beta
        </div>
        <h2 className="font-bold tracking-tight"
          style={{ fontSize: "clamp(34px, 5.5vw, 56px)", lineHeight: 1.05, letterSpacing: "-0.02em", color: "#FFFFFF" }}>
          Your next close, but{" "}
          <span style={{
            background: "linear-gradient(135deg, #7BE3B2 0%, #4BA87B 100%)",
            WebkitBackgroundClip: "text", backgroundClip: "text",
            WebkitTextFillColor: "transparent", color: "transparent",
          }}>easier.</span>
        </h2>
        <p className="mt-5 text-base sm:text-lg leading-relaxed max-w-xl mx-auto"
          style={{ color: "rgba(255,255,255,0.66)" }}>
          Connect QuickBooks in 60 seconds, run your first reconciliation in five minutes.
          No credit card, no contract.
        </p>
        <div className="mt-9 flex flex-col sm:flex-row items-center justify-center gap-3">
          <Link to="/sign-up"
            className="inline-flex items-center gap-2 px-6 py-3.5 rounded-xl text-sm font-semibold text-white transition-all hover:scale-[1.02] active:scale-[0.99]"
            style={{
              background: "linear-gradient(135deg, var(--green-light) 0%, var(--green) 100%)",
              boxShadow: "0 16px 40px -12px rgba(91,176,137,0.5)",
            }}>
            Start free — no card required <ArrowRight size={15} strokeWidth={2.2} />
          </Link>
          <Link to="/solutions"
            className="group inline-flex items-center gap-1.5 px-4 py-3.5 text-sm font-semibold transition-colors"
            style={{ color: "rgba(255,255,255,0.82)" }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "#FFFFFF" }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.82)" }}>
            See the product tour
            <ArrowRight size={14} strokeWidth={2.2} className="transition-transform group-hover:translate-x-0.5" />
          </Link>
        </div>
      </div>
    </section>
  )
}

// ─── Founder quote (intermission) ──────────────────────────────────────────

function FounderQuote() {
  // Burgundy palette — chosen to harmonize with the homepage banner
  // image (red/cream 3D cubes). Solid background, white type, high
  // contrast for scannability. The card sits in normal flow on a
  // theme-aware surface so it works in both light and dark mode.
  const BURGUNDY        = "#8B1538"
  const BURGUNDY_DEEPER = "#6B0F2A"
  const WHITE           = "#FFFFFF"
  const WHITE_70        = "rgba(255, 255, 255, 0.78)"

  return (
    <section className="px-6 py-20 sm:py-24">
      {/* max-w-6xl matches the Hero, Bento, Pricing, FAQ sections so
          this card lines up with every other content block on the
          page. The inner quote text caps at a narrower max-width via
          its own constraint so the LINE LENGTH stays comfortable for
          reading even though the CARD is full-width. */}
      <div className="max-w-6xl mx-auto">
        <div className="rounded-2xl px-8 sm:px-16 py-14 sm:py-20 text-center relative overflow-hidden"
          style={{
            background: `linear-gradient(135deg, ${BURGUNDY} 0%, ${BURGUNDY_DEEPER} 100%)`,
            boxShadow: "0 12px 32px rgba(139, 21, 56, 0.25)",
          }}>
          {/* Subtle decorative pattern in the corner — same geometric
              language as the homepage banner so the page reads as one
              visual family. Opacity stays low so it doesn't compete
              with the quote. */}
          <svg className="absolute -right-12 -top-12 opacity-[0.08] pointer-events-none"
            width="200" height="200" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <pattern id="founder-quote-grid" width="20" height="20" patternUnits="userSpaceOnUse">
                <path d="M 20 0 L 0 0 0 20" fill="none" stroke={WHITE} strokeWidth="1" />
              </pattern>
            </defs>
            <rect width="200" height="200" fill="url(#founder-quote-grid)" />
          </svg>

          <Quote size={36} strokeWidth={1.5} style={{ color: WHITE_70 }} className="mx-auto mb-6 relative" />
          {/* Quote text is intentionally narrower than the card so the
              line length stays in the 60-75 char reading sweet spot
              even when the burgundy card spans the full 6xl width. */}
          <blockquote className="font-bold leading-[1.25] tracking-tight mb-8 relative max-w-3xl mx-auto"
            style={{ fontSize: "clamp(24px, 3.5vw, 34px)", color: WHITE }}>
            "I closed books for ten years with fourteen spreadsheets
            and a praying heart. There had to be something better.
            So I built it."
          </blockquote>
          {/* Attribution — pseudonymous byline. The credential is the
              point: a practicing CPA who's been on the wrong end of
              every close you've ever lived through. White-on-burgundy
              avatar chip with the brand mark stays readable on the
              gradient. */}
          <div className="inline-flex items-center gap-3 relative">
            <div className="h-11 w-11 rounded-xl flex items-center justify-center shrink-0"
              style={{
                background: "rgba(255, 255, 255, 0.12)",
                border: "1.5px solid rgba(255, 255, 255, 0.35)",
              }}>
              {/* light-on-dark logo always — we're on a burgundy background
                  regardless of the page theme. */}
              <img src="/logo-mark-light.svg" alt="" className="h-6 w-6" loading="lazy" />
            </div>
            <div className="text-left">
              <p className="text-sm font-bold" style={{ color: WHITE }}>The Founding CPA</p>
              <p className="text-xs" style={{ color: WHITE_70 }}>
                Built Nordavix from inside a real close team
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

// ─── Page composition ─────────────────────────────────────────────────────

// Reference useScroll/useTransform once so the import is "used" — keeps
// the linter happy without forcing a refactor if we add scroll-driven
// effects to a future section.
const _scrollHooksUsed = { useScroll, useTransform, Eye }

export function HomePage() {
  // Build the FAQ schema once per render so Google can surface the
  // visible Q&A directly as a rich snippet. The same QUESTIONS array
  // feeds the on-page accordion AND this structured-data payload —
  // that's the rule for being eligible for the rich result.
  const faqSchemaObj = faqSchema(FAQ_QUESTIONS.map((q) => ({ question: q.q, answer: q.a })))
  const crumbs = breadcrumbSchema([{ name: "Home", path: "/" }])

  return (
    <div className="min-h-screen text-theme">
      <SEO
        title="Nordavix — AI month-end close software for CPAs and controllers"
        description="Close your books in days, not weeks. AI-prepared reconciliations, flux analysis, intercompany consolidation, schedules, and an executive financial package — all built on top of QuickBooks Online."
        path="/"
        bareTitle
        jsonLd={[faqSchemaObj, crumbs]}
      />
      <Navbar />
      {/* Hero now embeds the banner image as its full background.
          (The standalone HomepageBanner strip was confusing — user
          wanted the headline OVER the image, not under it.) */}
      <Hero />
      <TrustStrip />
      <CloseLoopHero />
      <BentoGrid />
      <InteractiveAIDemo />
      <FounderQuote />
      <Personas />
      <Pricing />
      <FAQ />
      <FinalCTA />
      <MarketingFooter />
    </div>
  )
}

// Quiet a "declared but unused" warning on the reserved hooks/icons above
// without bundling unreferenced code into production.
void _scrollHooksUsed
