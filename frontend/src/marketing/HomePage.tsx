/**
 * HomePage — the Nordavix marketing landing page.
 *
 * Art direction: dark, premium, but NOT monotone — a soft-dark base with
 * colored panels (burgundy / green / rose) and warm cream moments for
 * contrast (a cream bento tile, and the product explorer on a cream section
 * with a dark card). Everything animates in with smooth scroll-reveal.
 *
 * Sections:
 *   1.  Navbar (transparent → frosted on scroll)
 *   2.  Hero — aurora bg · headline + CTAs · FIXED arrow + rotating phrase
 *   3.  Trust strip
 *   4.  Bento — mixed-size, mixed-color tiles with mini visuals
 *   5.  Product explorer — left tabs (modules) → swapping visual + capability
 *       list, on a warm cream section with a dark card (interactive)
 *   6.  Agentic spotlight · Control grid · Personas · Founder · Early access ·
 *       FAQ · Final CTA · Footer
 *
 * Real product mockups (recon working-paper "PDF", cash-runway chart,
 * break-even chart, AI commentary card, executive report) live inside the
 * explorer. Charts/mockups are SVG + styled divs — no external libraries.
 */
import { useEffect, useState, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { useUser } from "@clerk/clerk-react"
import { motion, AnimatePresence } from "framer-motion"
import { MarketingFooter } from "@/marketing/MarketingFooter"
import { SEO, faqSchema, breadcrumbSchema } from "@/marketing/seo/SEO"
import {
  Sparkles, ArrowRight, CheckCircle2, Menu, X, ShieldCheck,
  GitCompareArrows, Brain, Workflow, Plug, Scale, FileCheck,
  Building2, UserCheck, Lock, Plus, Minus, ScrollText, TrendingUp,
  Layers, ChevronRight,
} from "lucide-react"

// ─── Palette (calm light base + restrained accents) ─────────────────────────
const INK      = "#F7F5F0"   // page background — warm cream (matches the app)
const INK_2    = "#FFFFFF"
const SURFACE  = "#FFFFFF"   // cards / panels
const SURFACE2 = "#F2F0EA"
const LINE     = "rgba(14,17,18,0.08)"   // hairline on light
const LINE_2   = "rgba(14,17,18,0.14)"
const TXT      = "#14181A"   // primary text — near-black
const TXT_2    = "#4A4946"
const TXT_3    = "#8C8B88"
const GREEN    = "#3E8F66"   // brand sage (reads on light)
const GREEN_D  = "#2E7A55"
const ROSE     = "#A8546F"   // muted rose
const AMBER    = "#B07F3C"   // muted ochre
// deeper warm panel for banded "context" sections
const CREAM    = "#EFEBE3"
const ON_CREAM   = "#15181A"
const ON_CREAM_2 = "#4C5052"
// Soft tonal bands for section rhythm (Notion-style) + diffuse glows (Linear-style).
// Calm, low-chroma — they give the page depth without shouting.
const TINT_SAGE  = "#E9F2EC"   // soft green band
const TINT_SLATE = "#ECF1F5"   // soft blue-gray band
const TINT_SAND  = "#F5EFE4"   // soft warm band
const GLOW_SAGE  = "#6FB793"   // diffuse sage glow
const GLOW_WARM  = "#E6C79C"   // diffuse warm glow

const EASE = [0.22, 1, 0.36, 1] as const

// ─── Motion + small helpers ─────────────────────────────────────────────────
function Reveal({ children, delay = 0, y = 24, className = "" }:
  { children: ReactNode; delay?: number; y?: number; className?: string }) {
  return (
    <motion.div className={className}
      initial={{ opacity: 0, y }} whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.6, ease: EASE, delay }}>
      {children}
    </motion.div>
  )
}
function Eyebrow({ children, color = GREEN }: { children: ReactNode; color?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.18em]" style={{ color }}>
      <span className="h-px w-6" style={{ background: color }} />{children}
    </span>
  )
}
function GradWord({ children }: { children: ReactNode }) {
  return <span style={{ background: `linear-gradient(100deg, ${ROSE}, ${GREEN})`, WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }}>{children}</span>
}

// ─── Navbar ──────────────────────────────────────────────────────────────────
const NAV_LINKS = [
  { label: "Product", to: "#explore", external: true },
  { label: "Solutions", to: "/solutions", external: false },
  { label: "Blog", to: "/blog", external: false },
  { label: "Early access", to: "#beta", external: true },
  { label: "FAQ", to: "#faq", external: true },
]
function Navbar() {
  const [scrolled, setScrolled] = useState(false)
  const [open, setOpen] = useState(false)
  const { isSignedIn } = useUser()
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll(); window.addEventListener("scroll", onScroll, { passive: true })
    return () => window.removeEventListener("scroll", onScroll)
  }, [])
  useEffect(() => { document.body.style.overflow = open ? "hidden" : ""; return () => { document.body.style.overflow = "" } }, [open])
  const greenBtn = { color: "#06140D", background: GREEN, boxShadow: `0 8px 22px -8px ${GREEN}` }
  return (
    <>
      <nav className="fixed top-0 inset-x-0 z-50 transition-all duration-300"
        style={{ paddingTop: scrolled ? 12 : 18, paddingBottom: scrolled ? 12 : 18,
          background: scrolled ? "rgba(247,245,240,0.82)" : "transparent",
          backdropFilter: scrolled ? "saturate(160%) blur(14px)" : "none", WebkitBackdropFilter: scrolled ? "saturate(160%) blur(14px)" : "none",
          borderBottom: `1px solid ${scrolled ? LINE : "transparent"}` }}>
        <div className="max-w-6xl mx-auto px-6 flex items-center justify-between gap-4">
          <Link to="/" className="flex items-center gap-2.5 group shrink-0">
            <img src="/logo-mark-light.svg" alt="Nordavix" className="h-8 w-8 transition-transform group-hover:scale-105" />
            <span className="font-bold text-lg tracking-tight" style={{ color: TXT }}>nordavix<span style={{ color: GREEN }}>.</span></span>
          </Link>
          <div className="hidden md:flex items-center gap-8">
            {NAV_LINKS.map((it) => {
              const p = { className: "text-sm font-medium transition-colors", style: { color: TXT_2 },
                onMouseEnter: (e: { currentTarget: HTMLElement }) => { e.currentTarget.style.color = TXT },
                onMouseLeave: (e: { currentTarget: HTMLElement }) => { e.currentTarget.style.color = TXT_2 } }
              return it.external ? <a key={it.label} href={it.to} {...p}>{it.label}</a> : <Link key={it.label} to={it.to} {...p}>{it.label}</Link>
            })}
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden md:flex items-center gap-2">
              {isSignedIn ? (
                <Link to="/app" className="text-sm font-semibold px-4 py-2 rounded-full inline-flex items-center gap-1.5 transition-all hover:-translate-y-0.5" style={greenBtn}>Open dashboard <ArrowRight size={14} /></Link>
              ) : (
                <>
                  <Link to="/sign-in" className="text-sm font-medium px-3 py-2 transition-colors" style={{ color: TXT_2 }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = TXT)} onMouseLeave={(e) => (e.currentTarget.style.color = TXT_2)}>Sign in</Link>
                  <Link to="/sign-up" className="text-sm font-semibold px-4 py-2 rounded-full transition-all hover:-translate-y-0.5" style={greenBtn}>Start free</Link>
                </>
              )}
            </div>
            <button onClick={() => setOpen(true)} className="md:hidden h-9 w-9 flex items-center justify-center rounded-lg" style={{ color: TXT, border: `1px solid ${LINE_2}` }} aria-label="Open menu"><Menu size={18} /></button>
          </div>
        </div>
      </nav>
      {open && (
        <div className="fixed inset-0 z-[60] md:hidden" style={{ background: INK }}>
          <div className="flex items-center justify-between px-6 py-5">
            <span className="font-bold text-lg" style={{ color: TXT }}>nordavix<span style={{ color: GREEN }}>.</span></span>
            <button onClick={() => setOpen(false)} className="h-9 w-9 flex items-center justify-center rounded-lg" style={{ background: SURFACE2, color: TXT_2 }} aria-label="Close menu"><X size={18} /></button>
          </div>
          <div className="px-6 py-4 space-y-1">
            {NAV_LINKS.map((item) => item.external
              ? <a key={item.label} href={item.to} onClick={() => setOpen(false)} className="block py-3 text-base font-medium" style={{ color: TXT, borderBottom: `1px solid ${LINE}` }}>{item.label}</a>
              : <Link key={item.label} to={item.to} onClick={() => setOpen(false)} className="block py-3 text-base font-medium" style={{ color: TXT, borderBottom: `1px solid ${LINE}` }}>{item.label}</Link>)}
            <div className="pt-6 space-y-3">
              <Link to="/sign-up" onClick={() => setOpen(false)} className="flex items-center justify-center gap-2 w-full py-3 rounded-full text-sm font-semibold" style={greenBtn}>Start free <ArrowRight size={14} /></Link>
              <Link to="/sign-in" onClick={() => setOpen(false)} className="flex items-center justify-center w-full py-2.5 rounded-full text-sm font-medium" style={{ color: TXT_2, border: `1px solid ${LINE_2}` }}>Sign in</Link>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// ─── Hero (copy left · fixed-arrow rotating list right) ─────────────────────
const ROTATION = [
  "Reconcile every account",
  "Explain every variance",
  "Forecast your cash runway",
  "Pinpoint the break-even",
  "Build the financial package",
  "Write the executive report",
  "Lock the period — defensibly",
]
const N = ROTATION.length
const LH = 52            // px height of each rotating row
const VIS = 7            // rows visible in the window
const ARROW_SLOT = 3     // 0-indexed row the fixed arrow points at
const TRIPLE = [...ROTATION, ...ROTATION, ...ROTATION]

function Hero() {
  // Vertical carousel: the list scrolls up one row per tick so each phrase
  // arrives at the FIXED arrow line; then we snap back across the duplicated
  // copies with NO transition so it loops seamlessly. The row at the arrow is
  // bright; the rest are a lighter shade.
  const [active, setActive] = useState(N)
  const [withT, setWithT] = useState(true)
  useEffect(() => { const id = setInterval(() => setActive((a) => a + 1), 2600); return () => clearInterval(id) }, [])
  useEffect(() => {
    if (active < 2 * N) return
    const timer = setTimeout(() => { setWithT(false); setActive(N) }, 620)
    return () => clearTimeout(timer)
  }, [active])
  useEffect(() => {
    if (withT) return
    const id = requestAnimationFrame(() => setWithT(true))
    return () => cancelAnimationFrame(id)
  }, [withT])
  const y = -((active - ARROW_SLOT) * LH)

  return (
    <header
      className="relative overflow-hidden"
      style={{
        // Full-bleed abstract colour mesh — bold sage / amber / sky / rose blobs
        // over a tinted base, with a faint violet bloom at the core. Pure
        // gradients (no blur filter) so it fills the whole hero and paints cheaply.
        background: `
          radial-gradient(125% 100% at 4% 6%, rgba(74,164,121,0.55), transparent 56%),
          radial-gradient(120% 95% at 96% 2%, rgba(232,176,98,0.60), transparent 56%),
          radial-gradient(125% 105% at 84% 96%, rgba(108,164,208,0.56), transparent 58%),
          radial-gradient(115% 95% at 10% 100%, rgba(168,84,111,0.34), transparent 56%),
          radial-gradient(95% 80% at 52% 46%, rgba(124,116,196,0.20), transparent 62%),
          linear-gradient(135deg, #E4F0E8 0%, #F2ECE0 46%, #DFEAF3 100%)
        `,
      }}
    >
      <div aria-hidden className="pointer-events-none absolute inset-0">
        {/* faint grid texture over the colour wash */}
        <div className="absolute inset-0" style={{ backgroundImage: `linear-gradient(${LINE} 1px, transparent 1px), linear-gradient(90deg, ${LINE} 1px, transparent 1px)`, backgroundSize: "56px 56px", maskImage: "radial-gradient(140% 90% at 50% 0%, black, transparent 80%)", WebkitMaskImage: "radial-gradient(140% 90% at 50% 0%, black, transparent 80%)", opacity: 0.45 }} />
        {/* soft fade into the calm sections below so the band blends out */}
        <div className="absolute inset-x-0 bottom-0 h-32" style={{ background: `linear-gradient(to bottom, transparent, ${INK})` }} />
      </div>

      <div className="relative max-w-6xl mx-auto px-6 pt-36 md:pt-44 pb-20 md:pb-28">
        <div className="grid lg:grid-cols-[1.05fr_0.95fr] gap-12 lg:gap-10 items-center">
          {/* left — copy */}
          <div>
            <Reveal>
              <span className="inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-semibold" style={{ background: "rgba(14,17,18,0.04)", color: TXT, border: `1px solid ${LINE_2}` }}>
                <Sparkles size={13} strokeWidth={2} style={{ color: ROSE }} /> Built by a CPA · Agentic month-end close
              </span>
            </Reveal>
            <Reveal delay={0.05}>
              <h1 className="mt-6 text-[2.1rem] leading-[1.07] sm:text-[2.6rem] md:text-[3.15rem] font-bold tracking-tight" style={{ color: TXT }}>
                Close the books in <GradWord>days</GradWord>, not weeks.
              </h1>
            </Reveal>
            <Reveal delay={0.1}>
              <p className="mt-5 max-w-xl text-[15px] md:text-base leading-relaxed" style={{ color: TXT_2 }}>
                Every account reconciled, every variance explained, every report written — AI-prepared, you approve. Right on top of QuickBooks Online.
              </p>
            </Reveal>
            <Reveal delay={0.15}>
              <div className="mt-9">
                <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
                  <Link to="/sign-up" className="inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-full text-sm font-semibold transition-all hover:-translate-y-0.5" style={{ color: "#06140D", background: GREEN, boxShadow: `0 14px 34px -10px ${GREEN}` }}>Start free <ArrowRight size={16} /></Link>
                  <a href="#explore" className="inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-full text-sm font-semibold transition-colors" style={{ color: TXT, background: "rgba(14,17,18,0.04)", border: `1px solid ${LINE_2}` }}>See it work</a>
                </div>
              </div>
            </Reveal>
            <Reveal delay={0.2}><p className="mt-7 text-[13px]" style={{ color: TXT_3 }}>QuickBooks-native · Maker-checker enforced · Bank-grade security</p></Reveal>
          </div>

          {/* right — fixed arrow + rotating list */}
          <Reveal delay={0.15} className="lg:pl-8">
            <div className="text-[11px] font-bold uppercase tracking-[0.18em] mb-3" style={{ color: TXT_3 }}>One workspace that can</div>
            <div className="relative overflow-hidden" style={{ height: VIS * LH, WebkitMaskImage: "linear-gradient(transparent, #000 16%, #000 84%, transparent)", maskImage: "linear-gradient(transparent, #000 16%, #000 84%, transparent)" }}>
              {/* fixed arrow marker */}
              <div className="absolute left-0 z-10 flex items-center" style={{ top: ARROW_SLOT * LH, height: LH }}>
                <svg width="16" height="18" viewBox="0 0 13 15" aria-hidden><path d="M0 0 L13 7.5 L0 15 Z" fill={ROSE} /></svg>
              </div>
              {/* scrolling strip (3 copies → seamless loop) */}
              <div style={{ transform: `translateY(${y}px)`, transition: withT ? "transform 0.6s cubic-bezier(0.22,1,0.36,1)" : "none" }}>
                {TRIPLE.map((phrase, i) => {
                  const on = i === active
                  return (
                    <div key={i} className="flex items-center pl-9" style={{ height: LH }}>
                      <span className="text-2xl md:text-[1.7rem] tracking-tight transition-colors duration-300" style={{ color: on ? TXT : "#474d4c", fontWeight: on ? 800 : 600 }}>{phrase}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </header>
  )
}

// ─── Trust strip ─────────────────────────────────────────────────────────────
function TrustStrip() {
  const items = [{ Icon: Plug, label: "QuickBooks-native" }, { Icon: Building2, label: "Built by a CPA" }, { Icon: UserCheck, label: "Maker-checker enforced" }, { Icon: ShieldCheck, label: "Bank-grade security" }]
  return (
    <section style={{ background: INK }}>
      <div className="max-w-5xl mx-auto px-6 py-8" style={{ borderTop: `1px solid ${LINE}` }}>
        <Reveal>
          <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-4">
            {items.map(({ Icon, label }) => <div key={label} className="inline-flex items-center gap-2 text-sm font-medium" style={{ color: TXT_3 }}><Icon size={16} strokeWidth={1.8} /> {label}</div>)}
          </div>
        </Reveal>
      </div>
    </section>
  )
}

// ─── Bento — mixed-size, mixed-color tiles ──────────────────────────────────
function Bento() {
  return (
    <section style={{ background: INK }}>
      <div className="max-w-6xl mx-auto px-6 py-24 md:py-28">
        <Reveal className="max-w-2xl mb-12">
          <Eyebrow>One workspace</Eyebrow>
          <h2 className="mt-4 text-3xl md:text-5xl font-bold tracking-tight" style={{ color: TXT }}>Your whole month-end, <GradWord>connected</GradWord>.</h2>
        </Reveal>
        <div className="grid md:grid-cols-3 gap-4 md:auto-rows-fr">
          {/* big dark tile */}
          <Reveal className="md:col-span-2 md:row-span-2" y={28}>
            <div className="h-full rounded-2xl p-7 relative overflow-hidden" style={{ background: SURFACE, border: `1px solid ${LINE}` }}>
              <div aria-hidden className="absolute -top-16 -right-10 h-60 w-60 rounded-full" style={{ background: `radial-gradient(closest-side, ${GREEN_D}, transparent)`, opacity: 0.08, filter: "blur(30px)" }} />
              <div className="relative">
                <h3 className="text-2xl font-bold" style={{ color: TXT }}>The entire close on one canvas</h3>
                <p className="mt-2 max-w-md text-[15px] leading-relaxed" style={{ color: TXT_2 }}>Connect QuickBooks, sync the period, and every tool works off one source of truth — reconcile, explain, report, and close without leaving.</p>
                {/* close-flow mini visual */}
                <div className="mt-6 flex items-center gap-2 flex-wrap">
                  {["Connect", "Sync", "Reconcile", "Explain", "Approve", "Close"].map((s, i, a) => (
                    <div key={s} className="flex items-center gap-2">
                      <span className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full" style={{ background: i <= 3 ? "rgba(84,185,138,0.14)" : SURFACE2, color: i <= 3 ? GREEN : TXT_3, border: `1px solid ${LINE}` }}>
                        {i <= 3 && <CheckCircle2 size={11} strokeWidth={2.4} />}{s}
                      </span>
                      {i < a.length - 1 && <ChevronRight size={13} style={{ color: TXT_3 }} />}
                    </div>
                  ))}
                </div>
                <div className="mt-6 rounded-xl p-4" style={{ background: INK_2, border: `1px solid ${LINE}` }}>
                  <div className="flex items-center justify-between text-xs"><span style={{ color: TXT_3 }}>March 2026 · close progress</span><span className="font-bold" style={{ color: GREEN }}>86%</span></div>
                  <div className="mt-2 h-2 rounded-full overflow-hidden" style={{ background: SURFACE2 }}><div className="h-full rounded-full" style={{ width: "86%", background: `linear-gradient(90deg, ${GREEN}, ${GREEN_D})` }} /></div>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                    {[["Recons", "12/14"], ["Flux", "Signed"], ["Package", "Ready"]].map(([a2, b]) => (<div key={a2}><div className="text-[10px] uppercase tracking-wider" style={{ color: TXT_3 }}>{a2}</div><div className="text-sm font-bold" style={{ color: TXT }}>{b}</div></div>))}
                  </div>
                </div>
              </div>
            </div>
          </Reveal>
          {/* cream tile */}
          <Reveal delay={0.06} className="md:col-span-1">
            <div className="h-full rounded-2xl p-7" style={{ background: CREAM }}>
              <h3 className="text-xl font-bold" style={{ color: ON_CREAM }}>Every close tool, ready to go</h3>
              <p className="mt-2 text-sm leading-relaxed" style={{ color: ON_CREAM_2 }}>Six tools, one login, no setup.</p>
              <div className="mt-4 flex flex-wrap gap-2">
                {[[GitCompareArrows, "Reconciliations"], [Brain, "Flux"], [TrendingUp, "Insights"], [FileCheck, "Financials"], [Scale, "Intercompany"], [Layers, "Schedules"]].map(([Ic, label]) => {
                  const Icon = Ic as typeof GitCompareArrows
                  return <span key={label as string} className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1.5 rounded-full" style={{ background: "#FFFFFF", color: ON_CREAM, border: "1px solid rgba(0,0,0,0.08)" }}><Icon size={12} strokeWidth={2} style={{ color: GREEN_D }} /> {label as string}</span>
                })}
              </div>
            </div>
          </Reveal>
          {/* green tile */}
          <Reveal delay={0.12} className="md:col-span-1">
            <div className="h-full rounded-2xl p-7 relative overflow-hidden" style={{ background: "linear-gradient(155deg, #EEF7F2, #FFFFFF)", border: `1px solid rgba(62,143,102,0.30)` }}>
              <h3 className="text-xl font-bold" style={{ color: TXT }}>Your close in one click</h3>
              <p className="mt-2 text-sm leading-relaxed" style={{ color: TXT_2 }}>Agentic Mode prepares every open account, then hands it to you.</p>
              <div className="mt-5 inline-flex items-center gap-2 text-sm font-semibold px-3.5 py-2 rounded-full" style={{ color: "#06140D", background: GREEN }}><Sparkles size={14} strokeWidth={2} /> Run AI</div>
              <div className="mt-3 text-xs" style={{ color: TXT_3 }}>12 of 14 prepared · you approve</div>
            </div>
          </Reveal>
          {/* burgundy wide tile */}
          <Reveal delay={0.1} className="md:col-span-3">
            <div className="rounded-2xl p-7 relative overflow-hidden" style={{ background: "linear-gradient(120deg, #F7EEF1, #FFFFFF)", border: `1px solid rgba(168,84,111,0.28)` }}>
              <div className="grid md:grid-cols-2 gap-6 items-center">
                <div>
                  <h3 className="text-xl font-bold" style={{ color: TXT }}>One place, your whole team</h3>
                  <p className="mt-2 text-[15px] leading-relaxed" style={{ color: TXT_2 }}>Maker-checker is enforced — preparers prepare, reviewers approve, nobody signs off their own work. Every action is logged.</p>
                </div>
                <div className="flex items-center gap-2 flex-wrap md:justify-end">
                  {[["Preparer", "enters"], ["Reviewer", "approves"], ["Admin", "closes"]].map(([r, a], i, arr) => (
                    <div key={r} className="flex items-center gap-2">
                      <div className="rounded-xl px-4 py-3 text-center" style={{ background: "rgba(14,17,18,0.04)", border: `1px solid ${LINE}` }}><div className="text-sm font-bold" style={{ color: TXT }}>{r}</div><div className="text-[11px]" style={{ color: TXT_3 }}>{a}</div></div>
                      {i < arr.length - 1 && <ChevronRight size={14} style={{ color: ROSE }} />}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  )
}

// ─── Mockups (used inside the explorer) ─────────────────────────────────────
function ReconPaper() {
  return (
    <div className="rounded-2xl p-4 sm:p-6" style={{ background: "#FAFAF8", boxShadow: "0 20px 50px -30px rgba(14,17,18,0.22)" }}>
      <div className="flex items-center justify-between text-[10px] font-semibold tracking-wide" style={{ color: "#8A8F98" }}>
        <span>HELIO LOGISTICS, INC.</span><span className="text-right">RECONCILIATION PACKET<br /><span style={{ color: "#B6BAC0" }}>REC-202603-1100</span></span>
      </div>
      <div className="mt-3 pt-3" style={{ borderTop: "1px solid #ECEAE5" }}>
        <div className="text-[10px] font-bold tracking-[0.16em]" style={{ color: GREEN_D }}>GENERAL LEDGER RECONCILIATION</div>
        <div className="mt-1 text-xl font-bold" style={{ color: "#14181A" }}>Operating cash · 1100</div>
        <div className="text-xs" style={{ color: "#8A8F98" }}>Q1 2026 · period close</div>
      </div>
      <div className="mt-4 grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        <div><div className="text-[9px] uppercase tracking-wider" style={{ color: "#8A8F98" }}>Per general ledger</div><div className="text-lg font-bold tabular-nums" style={{ color: "#14181A" }}>$2,847,392</div></div>
        <div className="text-2xl font-light" style={{ color: GREEN_D }}>=</div>
        <div className="text-right"><div className="text-[9px] uppercase tracking-wider" style={{ color: "#8A8F98" }}>Per bank statement</div><div className="text-lg font-bold tabular-nums" style={{ color: "#14181A" }}>$2,847,392</div></div>
      </div>
      <div className="mt-4 space-y-1.5 text-xs" style={{ color: "#3C4146" }}>
        {[["Opening balance", "rolled fwd"], ["Deposits in transit", "+ 342,180"], ["Outstanding checks", "− 12,840"]].map(([a, b]) => <div key={a} className="flex justify-between"><span>{a}</span><span className="tabular-nums" style={{ color: "#8A8F98" }}>{b}</span></div>)}
        <div className="flex justify-between pt-1.5 font-bold" style={{ borderTop: "1px solid #14181A", color: "#14181A" }}><span>Reconciled balance — matches source</span><span className="tabular-nums" style={{ color: GREEN_D }}>$2,847,392</span></div>
      </div>
      <div className="mt-4 rounded-lg p-3 text-[11px] leading-relaxed" style={{ background: "#EAF4EE", borderLeft: `3px solid ${GREEN_D}`, color: "#3C4146" }}><span className="font-bold" style={{ color: GREEN_D }}>AI summary · </span>Outstanding items are timing differences only; both checks cleared 03 Apr. Variance $0.00. Defensible in audit.</div>
    </div>
  )
}
function CashRunwayChart() {
  const pts = [[30,28],[56,38],[82,50],[108,58],[134,72],[160,84],[186,98],[212,110],[238,122],[264,132],[290,140],[316,146],[340,150]]
  const line = pts.map((p) => p.join(",")).join(" ")
  return (
    <div className="rounded-2xl p-5" style={{ background: SURFACE, border: `1px solid ${LINE}` }}>
      <div className="flex items-center justify-between"><span className="text-sm font-semibold" style={{ color: TXT }}>Cash runway</span><span className="inline-flex items-center gap-1.5 text-xs font-semibold px-2 py-0.5 rounded-full" style={{ background: "rgba(84,185,138,0.14)", color: GREEN }}>14 months</span></div>
      <svg viewBox="0 0 360 168" className="mt-3 w-full">
        <defs>
          <linearGradient id="runFill" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stopColor={GREEN} stopOpacity="0.35" /><stop offset="65%" stopColor={AMBER} stopOpacity="0.25" /><stop offset="100%" stopColor={ROSE} stopOpacity="0.28" /></linearGradient>
          <linearGradient id="runLine" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stopColor={GREEN} /><stop offset="70%" stopColor={AMBER} /><stop offset="100%" stopColor={ROSE} /></linearGradient>
        </defs>
        <line x1="30" y1="150" x2="340" y2="150" stroke={LINE_2} strokeWidth="1" />
        <polygon points={`30,150 ${line} 340,150`} fill="url(#runFill)" />
        <polyline points={line} fill="none" stroke="url(#runLine)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="340" cy="150" r="3.5" fill={ROSE} />
      </svg>
      <div className="mt-2 grid grid-cols-3 gap-2 text-center">{[["Cash", "$1.24M"], ["Net burn", "$89k/mo"], ["Runway", "14 mo"]].map(([a, b]) => <div key={a}><div className="text-[10px] uppercase tracking-wider" style={{ color: TXT_3 }}>{a}</div><div className="text-sm font-bold tabular-nums" style={{ color: TXT }}>{b}</div></div>)}</div>
    </div>
  )
}
function BreakEvenChart() {
  const beX = 244, beY = 92
  return (
    <div className="rounded-2xl p-5" style={{ background: SURFACE, border: `1px solid ${LINE}` }}>
      <div className="flex items-center justify-between"><span className="text-sm font-semibold" style={{ color: TXT }}>Break-even analysis</span><span className="inline-flex items-center gap-1.5 text-xs font-semibold" style={{ color: TXT_3 }}><TrendingUp size={13} /> safety 22%</span></div>
      <svg viewBox="0 0 360 168" className="mt-3 w-full">
        <polygon points={`${beX},${beY} 330,40 330,72`} fill={GREEN} opacity="0.18" />
        <polygon points={`40,150 ${beX},${beY} 40,108`} fill={ROSE} opacity="0.14" />
        <line x1="40" y1="150" x2="330" y2="150" stroke={LINE_2} strokeWidth="1" /><line x1="40" y1="24" x2="40" y2="150" stroke={LINE_2} strokeWidth="1" />
        <line x1="40" y1="108" x2="330" y2="72" stroke={AMBER} strokeWidth="2.5" strokeLinecap="round" />
        <line x1="40" y1="150" x2="330" y2="40" stroke={GREEN} strokeWidth="2.5" strokeLinecap="round" />
        <line x1={beX} y1={beY} x2={beX} y2="150" stroke={ROSE} strokeWidth="1" strokeDasharray="3 3" />
        <circle cx={beX} cy={beY} r="4" fill={ROSE} stroke={SURFACE} strokeWidth="1.5" />
        <text x={beX} y={beY - 8} textAnchor="middle" fontSize="9" fontWeight="700" fill={TXT}>Break-even</text>
      </svg>
      <div className="mt-1 flex items-center gap-4 text-[11px]" style={{ color: TXT_3 }}><span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: GREEN }} /> Revenue</span><span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: AMBER }} /> Total cost</span></div>
    </div>
  )
}
function AICard() {
  return (
    <div className="rounded-2xl overflow-hidden" style={{ background: SURFACE, border: `1px solid ${LINE}` }}>
      <div className="flex items-center justify-between px-5 py-3" style={{ borderBottom: `1px solid ${LINE}` }}>
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full" style={{ background: "rgba(84,185,138,0.14)", color: GREEN }}><Sparkles size={12} strokeWidth={2} /> AI commentary</span>
        <span className="text-xs tabular-nums" style={{ color: TXT_3 }}>March 2026</span>
      </div>
      <div className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div><div className="text-sm font-bold" style={{ color: TXT }}>6400 · Marketing &amp; Advertising</div><div className="text-xs mt-0.5" style={{ color: TXT_3 }}>Flux vs. February</div></div>
          <div className="text-right shrink-0"><div className="text-lg font-bold tabular-nums" style={{ color: ROSE }}>+$14,200</div><div className="text-xs tabular-nums" style={{ color: TXT_3 }}>+38%</div></div>
        </div>
        <p className="mt-4 text-sm leading-relaxed" style={{ color: TXT_2 }}>Spend rose <span className="font-semibold" style={{ color: TXT }}>$14,200 (+38%)</span> over February across three Q1 campaign launches. All invoices match their POs; nothing unposted above threshold. Operational, not an error.</p>
        <div className="mt-4 space-y-2">{["Ties to the general ledger", "Top 3 driving transactions reviewed", "No items over threshold"].map((c) => <div key={c} className="flex items-center gap-2 text-[13px]" style={{ color: TXT_2 }}><CheckCircle2 size={15} strokeWidth={2} style={{ color: GREEN }} /> {c}</div>)}</div>
        <div className="mt-5 pt-4 flex items-center justify-between" style={{ borderTop: `1px solid ${LINE}` }}><span className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full" style={{ background: "rgba(84,185,138,0.14)", color: GREEN }}>Confidence: High</span><span className="text-xs" style={{ color: TXT_3 }}>3 transactions cited</span></div>
      </div>
    </div>
  )
}
function ExecReport() {
  return (
    <div className="rounded-2xl p-6" style={{ background: SURFACE, border: `1px solid ${LINE}` }}>
      <div className="flex items-start justify-between">
        <div><div className="text-[11px] uppercase tracking-[0.2em]" style={{ color: TXT_3 }}>Executive report</div><div className="mt-1 text-lg font-bold" style={{ color: TXT }}>Helio Logistics, Inc.</div><div className="text-xs" style={{ color: TXT_3 }}>Period ending March 31, 2026</div></div>
        <span className="text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded" style={{ color: GREEN, border: `1px solid rgba(84,185,138,0.45)` }}>AI-narrated</span>
      </div>
      <div className="mt-5 space-y-1.5"><div className="h-2 rounded-full w-full" style={{ background: SURFACE2 }} /><div className="h-2 rounded-full w-[90%]" style={{ background: SURFACE2 }} /><div className="h-2 rounded-full w-[76%]" style={{ background: SURFACE2 }} /></div>
      <div className="mt-5 flex items-end gap-2 h-20">{[40, 62, 52, 78, 70, 94].map((h, i) => <div key={i} className="flex-1 rounded-t-md" style={{ height: `${h}%`, background: i === 5 ? GREEN : "rgba(84,185,138,0.22)" }} />)}</div>
      <div className="mt-4 flex items-center gap-2 text-xs" style={{ color: TXT_2 }}><FileCheck size={14} strokeWidth={2} style={{ color: GREEN }} /> Cover · summary · IS / BS / CF · charts · risks &amp; outlook</div>
    </div>
  )
}
function MiniPanel({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <div className="rounded-2xl overflow-hidden" style={{ background: SURFACE, border: `1px solid ${LINE}` }}>
      <div className="px-5 py-3 text-sm font-semibold" style={{ color: TXT, borderBottom: `1px solid ${LINE}` }}>{title}</div>
      <div className="p-2">
        {rows.map(([a, b]) => (
          <div key={a} className="flex items-center justify-between px-3 py-2.5 text-sm" style={{ borderTop: `1px solid ${LINE}` }}>
            <span style={{ color: TXT_2 }}>{a}</span>
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold tabular-nums" style={{ color: GREEN }}><CheckCircle2 size={13} strokeWidth={2} /> {b}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Notion-style colored feature cards (product mockup anchored at bottom) ──
// Solid, calm-but-present color blocks (dusty honey / clay / sage / slate /
// lavender / sand) with a white product mockup peeking up from the bottom edge.
const CARDS: { tag: string; title: string; color: string; wide?: boolean; visual: ReactNode }[] = [
  { tag: "Reconciliations", title: "Tie out every account — AI prepares the whole set.", color: "#E9C97C", wide: true, visual: <ReconPaper /> },
  { tag: "Flux analysis", title: "Every variance, explained.", color: "#DD9E86", visual: <AICard /> },
  { tag: "Insights", title: "Cash runway & break-even, watched.", color: "#95C0A4", visual: <CashRunwayChart /> },
  { tag: "Financial package", title: "A board-ready package, written by AI.", color: "#9EBAD3", visual: <ExecReport /> },
  { tag: "Intercompany", title: "Consolidate across entities.", color: "#B5ABCE", visual: <MiniPanel title="Intercompany pairs · matched" rows={[["Due from Sub A ↔ Due to Parent", "$120,000"], ["Mgmt fee receivable ↔ payable", "$45,000"], ["IC loan ↔ IC borrowing", "$300,000"]]} /> },
  { tag: "Schedules", title: "Amortize on autopilot.", color: "#E2CCA6", visual: <MiniPanel title="Amortization · this period" rows={[["Prepaid insurance — 12 mo", "$2,000"], ["Software prepaid — 24 mo", "$1,250"], ["Office lease — ROU amort.", "$8,400"]]} /> },
]

function FeatureCard({ tag, title, color, wide, visual }: (typeof CARDS)[number]) {
  return (
    <div className={`relative overflow-hidden rounded-3xl flex flex-col ${wide ? "md:col-span-2" : ""}`}
      style={{ background: color, height: 452, boxShadow: "0 1px 2px rgba(14,17,18,0.05)" }}>
      <div className="p-7 md:p-9 pb-3 shrink-0">
        <div className="text-[11.5px] font-bold uppercase tracking-[0.14em]" style={{ color: "rgba(20,24,26,0.52)" }}>{tag}</div>
        <div className="mt-2 flex items-start justify-between gap-4">
          <h3 className="text-[21px] md:text-[25px] font-bold tracking-tight leading-[1.14]" style={{ color: "#14181A", maxWidth: wide ? 360 : 300 }}>{title}</h3>
          <span className="shrink-0 h-9 w-9 rounded-full inline-flex items-center justify-center transition-transform hover:scale-105" style={{ background: "#14181A", color: "#fff" }}><ArrowRight size={16} strokeWidth={2.2} /></span>
        </div>
      </div>
      {wide ? (
        <div className="mt-auto px-7 md:px-10 grid md:grid-cols-5 gap-6 items-end">
          <div className="hidden md:block md:col-span-2" />
          <div className="md:col-span-3 translate-y-5 rounded-2xl" style={{ boxShadow: "0 18px 44px -22px rgba(14,17,18,0.32)" }}>{visual}</div>
        </div>
      ) : (
        <div className="mt-auto px-6 md:px-7">
          <div className="translate-y-5 rounded-2xl" style={{ boxShadow: "0 18px 44px -22px rgba(14,17,18,0.32)" }}>{visual}</div>
        </div>
      )}
    </div>
  )
}

function FeatureShowcase() {
  return (
    <section style={{ background: INK }}>
      <div className="max-w-6xl mx-auto px-6 py-24 md:py-28">
        <Reveal>
          <div className="max-w-2xl mb-12 md:mb-16">
            <span className="text-xs font-bold uppercase tracking-[0.18em]" style={{ color: GREEN_D }}>See it in action</span>
            <h2 className="mt-3 text-3xl md:text-[40px] font-bold tracking-tight leading-[1.08]" style={{ color: TXT }}>Real output, not slideware.</h2>
            <p className="mt-4 text-base md:text-lg leading-relaxed" style={{ color: TXT_2 }}>Each card is the actual artifact a module produces from your live QuickBooks data.</p>
          </div>
        </Reveal>
        <Reveal>
          <div className="grid md:grid-cols-2 gap-5 md:gap-6">
            {CARDS.map((c) => <FeatureCard key={c.tag} {...c} />)}
          </div>
        </Reveal>
      </div>
    </section>
  )
}

function CalmBanner() {
  return (
    <div style={{ background: INK }}>
      <div className="max-w-5xl mx-auto px-6 pt-8 md:pt-10">
        <Reveal>
          <div className="rounded-2xl px-6 py-5 md:px-8 md:py-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-center sm:text-left"
            style={{ background: "linear-gradient(120deg, #1E4736 0%, #2F7B57 100%)", boxShadow: "0 16px 40px -22px rgba(31,70,54,0.55)" }}>
            <div className="flex items-center gap-3 min-w-0">
              <span className="shrink-0 inline-flex items-center justify-center h-9 w-9 rounded-xl" style={{ background: "rgba(255,255,255,0.14)" }}>
                <Sparkles size={17} strokeWidth={2} className="text-white" />
              </span>
              <div className="min-w-0">
                <p className="text-[15px] md:text-base font-semibold text-white leading-snug">Nordavix is in private beta — built by a CPA, for CPAs.</p>
                <p className="text-[12.5px] mt-0.5" style={{ color: "rgba(255,255,255,0.72)" }}>Limited spots, with a direct line to the founders.</p>
              </div>
            </div>
            <Link to="/sign-up" className="shrink-0 inline-flex items-center gap-1.5 rounded-full px-5 py-2.5 text-sm font-bold whitespace-nowrap transition-transform hover:scale-[1.03]" style={{ background: "#FFFFFF", color: "#1E4736" }}>
              Request early access <ArrowRight size={15} strokeWidth={2.3} />
            </Link>
          </div>
        </Reveal>
      </div>
    </div>
  )
}

// ─── Product explorer (cream section · dark card · interactive tabs) ─────────
const MODULES = [
  { key: "recon", name: "Reconciliations", tagline: "Tie out every account — on paper.", desc: "Reconcile each balance-sheet account to its subledger, then export an audit-ready working paper. Agentic Mode prepares the whole set in one click.", bullets: ["GL ⇄ subledger build-up with roll-forward openings", "One-click AI auto-prepare", "Evidence OCR matches your statement", "Maker-checker approval"], visual: <ReconPaper /> },
  { key: "flux", name: "Flux analysis", tagline: "Explain every variance.", desc: "Compare any period to the prior and let AI write the narrative — grounded in the real transactions that moved the number, with a confidence score.", bullets: ["Period-over-period across P&L and balance sheet", "Commentary cites the driving transactions", "Confidence score on every explanation", "Sign-off gate before review"], visual: <AICard /> },
  { key: "insights", name: "Insights", tagline: "Cash runway & break-even, watched for you.", desc: "A living analytics layer on the close — know how long the cash lasts and the volume you need to break even, refreshed every period.", bullets: ["Cash, net burn, and runway in months", "Break-even with margin of safety", "Liquidity, DSO/DPO, and aging", "Month-over-month expense movers"], visual: <div className="space-y-4"><CashRunwayChart /><BreakEvenChart /></div> },
  { key: "financials", name: "Financial package", tagline: "A board-ready package, written by AI.", desc: "Income statement, balance sheet, and cash flow on screen and as a PDF — plus a multi-page executive report your AI drafts in seconds.", bullets: ["IS / BS / CF rendered live and exportable", "AI-narrated executive report", "Built from your synced ledger", "Hand it to a board as-is"], visual: <ExecReport /> },
  { key: "intercompany", name: "Intercompany", tagline: "Consolidate across entities.", desc: "Auto-detects intercompany accounts, suggests counterparty pairs, and produces eliminations and a consolidated trial balance.", bullets: ["Auto-detect IC accounts", "Suggested counterparty pairs", "Eliminations entries", "Consolidated trial balance"], visual: <MiniPanel title="Intercompany pairs · matched" rows={[["Due from Sub A ↔ Due to Parent", "$120,000"], ["Mgmt fee receivable ↔ payable", "$45,000"], ["IC loan ↔ IC borrowing", "$300,000"]]} /> },
  { key: "schedules", name: "Schedules", tagline: "Amortize on autopilot.", desc: "Prepaids, accruals, fixed assets, leases, and loans — amortized on schedule and auto-flowed into the right reconciliation.", bullets: ["Prepaids, accruals, FA, leases, loans", "Auto-amortization each period", "Auto-flow into reconciliations", "Renewal & reversal alerts"], visual: <MiniPanel title="Amortization · this period" rows={[["Prepaid insurance — 12 mo", "$2,000"], ["Software prepaid — 24 mo", "$1,250"], ["Office lease — ROU amort.", "$8,400"]]} /> },
]
function ProductExplorer() {
  const [i, setI] = useState(0)
  const m = MODULES[i]
  return (
    <section id="explore" style={{ background: TINT_SAGE }}>
      <div className="max-w-6xl mx-auto px-6 py-24 md:py-28">
        <Reveal className="max-w-2xl mb-10">
          <Eyebrow color={GREEN_D}>The product</Eyebrow>
          <h2 className="mt-4 text-3xl md:text-5xl font-bold tracking-tight" style={{ color: ON_CREAM }}>Six tools. One source of truth.</h2>
          <p className="mt-4 text-lg" style={{ color: ON_CREAM_2 }}>Pick a module — see the real output it generates from your live QuickBooks data.</p>
        </Reveal>
        <Reveal y={28}>
          <div className="rounded-3xl overflow-hidden" style={{ background: SURFACE, border: `1px solid ${LINE}`, boxShadow: "0 24px 60px -40px rgba(14,17,18,0.18)" }}>
            <div className="grid md:grid-cols-[230px_1fr]">
              {/* left tabs (horizontal on mobile) */}
              <div className="flex md:flex-col gap-1 p-3 overflow-x-auto md:overflow-visible" style={{ borderBottom: `1px solid ${LINE}`, borderRight: "none" }}>
                {MODULES.map((mod, idx) => {
                  const on = idx === i
                  return (
                    <button key={mod.key} onClick={() => setI(idx)}
                      className="text-left whitespace-nowrap rounded-xl px-4 py-3 text-sm font-semibold transition-colors shrink-0"
                      style={{ background: on ? "rgba(84,185,138,0.14)" : "transparent", color: on ? TXT : TXT_2, border: `1px solid ${on ? "rgba(84,185,138,0.30)" : "transparent"}` }}>
                      {mod.name}
                    </button>
                  )
                })}
              </div>
              {/* right content */}
              <div className="p-6 md:p-8" style={{ borderLeft: `1px solid ${LINE}` }}>
                <AnimatePresence mode="wait">
                  <motion.div key={m.key}
                    initial={{ opacity: 0, x: 14 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -14 }} transition={{ duration: 0.35, ease: EASE }}
                    className="grid lg:grid-cols-2 gap-8 items-center">
                    <div>
                      <div className="text-[11px] font-bold uppercase tracking-[0.16em]" style={{ color: GREEN }}>{m.name}</div>
                      <h3 className="mt-2 text-2xl md:text-3xl font-bold tracking-tight" style={{ color: TXT }}>{m.tagline}</h3>
                      <p className="mt-3 text-[15px] leading-relaxed" style={{ color: TXT_2 }}>{m.desc}</p>
                      <ul className="mt-5 space-y-2.5">{m.bullets.map((b) => <li key={b} className="flex items-start gap-2.5 text-sm" style={{ color: TXT_2 }}><CheckCircle2 size={16} strokeWidth={2} className="mt-0.5 shrink-0" style={{ color: GREEN }} /> {b}</li>)}</ul>
                    </div>
                    <div>{m.visual}</div>
                  </motion.div>
                </AnimatePresence>
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  )
}

// ─── Agentic spotlight ───────────────────────────────────────────────────────
function AgenticSpotlight() {
  const steps = [{ n: "01", t: "Pulls from QuickBooks", d: "Live balances and the transactions behind them." }, { n: "02", t: "Ties out the account", d: "Rolls the opening, matches items, finds the gap." }, { n: "03", t: "Writes the commentary", d: "A grounded narrative, risk flags, a confidence score." }, { n: "04", t: "Hands it to you", d: "Suggest-only. You review and approve — always." }]
  // FloQast-style deep-green statement band — white text on brand green.
  return (
    <section className="relative overflow-hidden" style={{ background: "linear-gradient(165deg, #15342A 0%, #1E4736 55%, #245540 100%)" }}>
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute -top-24 right-0 h-[440px] w-[560px] rounded-full" style={{ background: "radial-gradient(closest-side, #54B98A, transparent)", opacity: 0.16, filter: "blur(60px)" }} />
        <div className="absolute bottom-[-30%] left-[-10%] h-[440px] w-[560px] rounded-full" style={{ background: "radial-gradient(closest-side, #EAC97C, transparent)", opacity: 0.10, filter: "blur(70px)" }} />
        <div className="absolute inset-0" style={{ backgroundImage: "linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)", backgroundSize: "56px 56px", maskImage: "radial-gradient(120% 90% at 50% 0%, black, transparent 70%)", WebkitMaskImage: "radial-gradient(120% 90% at 50% 0%, black, transparent 70%)", opacity: 0.6 }} />
      </div>
      <div className="relative max-w-6xl mx-auto px-6 py-24 md:py-32">
        <Reveal className="max-w-2xl">
          <span className="inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold" style={{ background: "rgba(255,255,255,0.12)", color: "#FFFFFF" }}><Sparkles size={13} strokeWidth={2} /> Agentic Mode</span>
          <h2 className="mt-5 text-3xl md:text-5xl font-bold tracking-tight text-white">Meet your AI staff accountant.</h2>
          <p className="mt-4 text-lg leading-relaxed" style={{ color: "rgba(255,255,255,0.78)" }}>Click once and Nordavix runs the first pass across every open account — pulling, tying out, and writing the working paper. It never approves anything. You keep the judgment; it removes the grind.</p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link to="/sign-up" className="inline-flex items-center gap-2 rounded-full px-6 py-3 text-sm font-bold transition-transform hover:scale-[1.03]" style={{ background: "#FFFFFF", color: "#1E4736" }}>Start free <ArrowRight size={15} strokeWidth={2.3} /></Link>
            <a href="#explore" className="inline-flex items-center gap-2 rounded-full px-6 py-3 text-sm font-semibold transition-colors" style={{ color: "#FFFFFF", background: "rgba(255,255,255,0.10)", border: "1px solid rgba(255,255,255,0.25)" }}>See it work</a>
          </div>
        </Reveal>
        <div className="mt-14 grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {steps.map(({ n, t, d }, idx) => (
            <Reveal key={n} delay={idx * 0.08}>
              <div className="h-full rounded-2xl p-6" style={{ background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.14)" }}><div className="text-sm font-bold tabular-nums" style={{ color: "#7BD7AC" }}>{n}</div><h3 className="mt-3 text-base font-bold text-white">{t}</h3><p className="mt-1.5 text-sm leading-relaxed" style={{ color: "rgba(255,255,255,0.72)" }}>{d}</p></div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}

// ─── Control grid ────────────────────────────────────────────────────────────
function ControlGrid() {
  const items = [{ Icon: UserCheck, t: "Maker-checker enforced", d: "The person who enters a value can never approve it. Enforced server-side." }, { Icon: Workflow, t: "Sequential close gate", d: "You can't close March until February is locked. No skipping, no back-dating." }, { Icon: ScrollText, t: "Every action audited", d: "A complete, attributed trail of who did what, when — replayable for review." }, { Icon: Lock, t: "QuickBooks read-only", d: "Read-only OAuth scope. Nordavix never writes back to your books." }]
  return (
    <section style={{ background: TINT_SLATE }}>
      <div className="max-w-6xl mx-auto px-6 py-24 md:py-28">
        <Reveal className="max-w-2xl mx-auto text-center mb-14"><Eyebrow>Trust &amp; control</Eyebrow><h2 className="mt-4 text-3xl md:text-5xl font-bold tracking-tight" style={{ color: TXT }}>Control you can prove.</h2><p className="mt-4 text-lg" style={{ color: TXT_2 }}>The governance auditors ask for — built in, not bolted on.</p></Reveal>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {items.map(({ Icon, t, d }, idx) => <Reveal key={t} delay={idx * 0.06}><div className="h-full rounded-2xl p-6" style={{ background: SURFACE, border: `1px solid ${LINE}` }}><Icon size={22} strokeWidth={1.8} style={{ color: GREEN }} /><h3 className="mt-4 text-base font-bold" style={{ color: TXT }}>{t}</h3><p className="mt-1.5 text-sm leading-relaxed" style={{ color: TXT_2 }}>{d}</p></div></Reveal>)}
        </div>
      </div>
    </section>
  )
}

// ─── Personas ────────────────────────────────────────────────────────────────
function Personas() {
  const cards = [{ Icon: ShieldCheck, role: "Controllers", pitch: "Run a tighter close.", bullets: ["Weeks down to days", "Every account reconciled & approved", "A defensible audit trail by default"] }, { Icon: TrendingUp, role: "Fractional CFOs", pitch: "More clients, same calendar.", bullets: ["One clean workspace per client", "AI handles the first pass", "Board-ready reporting in a click"] }, { Icon: Building2, role: "CPA firms", pitch: "Standardize every engagement.", bullets: ["Maker-checker on every file", "Consistent working papers", "Review faster across the book"] }]
  return (
    <section style={{ background: INK }}>
      <div className="max-w-6xl mx-auto px-6 py-24 md:py-28">
        <Reveal className="max-w-2xl mx-auto text-center mb-14"><Eyebrow>Who it&apos;s for</Eyebrow><h2 className="mt-4 text-3xl md:text-5xl font-bold tracking-tight" style={{ color: TXT }}>Built for the people who own the close.</h2></Reveal>
        <div className="grid md:grid-cols-3 gap-6">
          {cards.map(({ Icon, role, pitch, bullets }, idx) => (
            <Reveal key={role} delay={idx * 0.08}>
              <div className="h-full rounded-2xl p-7" style={{ background: SURFACE, border: `1px solid ${LINE}` }}>
                <div className="flex items-center gap-3"><div className="h-10 w-10 rounded-xl flex items-center justify-center" style={{ background: "rgba(84,185,138,0.14)", color: GREEN }}><Icon size={19} strokeWidth={1.9} /></div><span className="text-sm font-semibold" style={{ color: TXT_3 }}>{role}</span></div>
                <h3 className="mt-5 text-xl font-bold" style={{ color: TXT }}>{pitch}</h3>
                <ul className="mt-4 space-y-2.5">{bullets.map((b) => <li key={b} className="flex items-start gap-2.5 text-sm" style={{ color: TXT_2 }}><CheckCircle2 size={16} strokeWidth={2} className="mt-0.5 shrink-0" style={{ color: GREEN }} /> {b}</li>)}</ul>
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
    <section style={{ background: TINT_SAND }}>
      <div className="max-w-4xl mx-auto px-6 py-24 md:py-28">
        <Reveal>
          <figure className="rounded-3xl p-8 md:p-12" style={{ background: SURFACE, border: `1px solid ${LINE}`, borderLeft: `4px solid ${ROSE}` }}>
            <blockquote className="text-xl md:text-2xl font-medium leading-relaxed" style={{ color: TXT }}>“I&apos;m a CPA. I&apos;ve lived the month-end grind — the 11&nbsp;pm tie-outs, the variance emails, the audit scramble. Nordavix is the tool I wished I had: AI does the first pass, you keep the judgment, and the close finally feels <GradWord>calm</GradWord>.”</blockquote>
            <figcaption className="mt-6 text-sm font-semibold" style={{ color: TXT_3 }}>— The founding CPA</figcaption>
          </figure>
        </Reveal>
      </div>
    </section>
  )
}

// ─── Early access ────────────────────────────────────────────────────────────
function EarlyAccess() {
  return (
    <section id="beta" style={{ background: INK }}>
      <div className="max-w-4xl mx-auto px-6 py-24 md:py-28 text-center">
        <Reveal>
          <Eyebrow>Pricing</Eyebrow>
          <h2 className="mt-4 text-3xl md:text-5xl font-bold tracking-tight" style={{ color: TXT }}>Pricing is on the way. Early access is open.</h2>
          <p className="mt-4 mx-auto max-w-xl text-lg" style={{ color: TXT_2 }}>We&apos;re onboarding design partners now — the full feature set, no credit card, and a direct line to the founders.</p>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-3">{["Full feature set", "No credit card", "Direct line to the founders"].map((p) => <span key={p} className="inline-flex items-center gap-1.5 text-sm font-medium px-3.5 py-1.5 rounded-full" style={{ background: SURFACE, border: `1px solid ${LINE}`, color: TXT_2 }}><CheckCircle2 size={14} strokeWidth={2} style={{ color: GREEN }} /> {p}</span>)}</div>
          <div className="mt-9 flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link to="/sign-up" className="inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-full text-sm font-semibold transition-all hover:-translate-y-0.5" style={{ color: "#06140D", background: GREEN, boxShadow: `0 14px 34px -10px ${GREEN}` }}>Request beta access <ArrowRight size={16} /></Link>
            <Link to="/solutions" className="inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-full text-sm font-semibold" style={{ color: TXT, background: "rgba(14,17,18,0.04)", border: `1px solid ${LINE_2}` }}>Explore the product</Link>
          </div>
        </Reveal>
      </div>
    </section>
  )
}

// ─── FAQ ─────────────────────────────────────────────────────────────────────
export const FAQ_QUESTIONS = [
  { q: "How does Nordavix actually pull data from QuickBooks?", a: "When you connect your QBO account via OAuth (read-only scope), we make live calls to QBO's reporting APIs — TrialBalance, GeneralLedger, ProfitAndLoss, AgedReceivables, AgedPayables. We never write back. Data is pulled on demand per period, so what you see is always current." },
  { q: "Where is the AI commentary actually generated?", a: "We send a structured prompt containing the relevant account, period balances, and (when you've pulled them) the top transactions driving the variance to Anthropic's Claude API over an encrypted connection. Our agreement with Anthropic prohibits training on your data. The full data flow is documented in our Privacy Policy." },
  { q: "Can my preparers and reviewers have different access levels?", a: "Yes. Three built-in roles: admin (full access including period close), reviewer (can approve work), preparer (can enter data but can't approve own work). Maker/checker is enforced — a preparer can't approve their own reconciliation." },
  { q: "Is my data isolated from other customers?", a: "Every row in our database is tagged with a tenant_id and access is enforced by a session-level filter at the ORM layer. Cross-tenant reads are physically blocked, not just hidden. We're working toward formal SOC 2 attestation." },
  { q: "What happens to my data if I cancel?", a: "We retain your data for 30 days after cancellation so you can export it, then delete from active systems within 90 days. Backups purge on our standard rotation (no more than 180 days). Full detail in the Privacy Policy." },
  { q: "Can I close my books with Nordavix?", a: "Yes — admins can lock a period once all accounts are approved. Once locked, reviewers and preparers can view but not edit anything for that period. We also enforce a sequential close gate: you can't close March until February's closed." },
]
function FAQ() {
  const [openIdx, setOpenIdx] = useState<number | null>(0)
  return (
    <section id="faq" style={{ background: INK }}>
      <div className="max-w-3xl mx-auto px-6 py-24 md:py-28">
        <Reveal className="text-center mb-12"><Eyebrow>FAQ</Eyebrow><h2 className="mt-4 text-3xl md:text-5xl font-bold tracking-tight" style={{ color: TXT }}>Questions, answered.</h2></Reveal>
        <div className="space-y-3">
          {FAQ_QUESTIONS.map((item, idx) => {
            const isOpen = openIdx === idx
            return (
              <Reveal key={item.q} delay={idx * 0.04}>
                <div className="rounded-2xl overflow-hidden" style={{ background: SURFACE, border: `1px solid ${isOpen ? LINE_2 : LINE}` }}>
                  <button onClick={() => setOpenIdx(isOpen ? null : idx)} className="w-full flex items-center justify-between gap-4 text-left px-5 py-4" aria-expanded={isOpen}>
                    <span className="text-[15px] font-semibold" style={{ color: TXT }}>{item.q}</span>
                    <span className="shrink-0 h-7 w-7 rounded-full flex items-center justify-center" style={{ background: isOpen ? "rgba(84,185,138,0.14)" : SURFACE2, color: isOpen ? GREEN : TXT_3 }}>{isOpen ? <Minus size={15} strokeWidth={2.2} /> : <Plus size={15} strokeWidth={2.2} />}</span>
                  </button>
                  <AnimatePresence initial={false}>
                    {isOpen && <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.28, ease: EASE }} className="overflow-hidden"><p className="px-5 pb-5 text-[15px] leading-relaxed" style={{ color: TXT_2 }}>{item.a}</p></motion.div>}
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
    <section style={{ background: INK }}>
      <div className="max-w-5xl mx-auto px-6 pb-28">
        <Reveal>
          <div className="relative overflow-hidden rounded-[2rem] px-8 py-16 md:py-20 text-center" style={{ background: `linear-gradient(160deg, ${TINT_SAGE} 0%, ${SURFACE} 62%)`, border: `1px solid ${LINE}`, boxShadow: "0 24px 60px -44px rgba(14,17,18,0.20)" }}>
            <div aria-hidden className="pointer-events-none absolute inset-0">
              <div className="absolute -top-24 left-1/4 h-72 w-[460px] rounded-full" style={{ background: `radial-gradient(closest-side, ${GLOW_SAGE}, transparent)`, opacity: 0.20, filter: "blur(46px)" }} />
              <div className="absolute -bottom-24 right-1/4 h-72 w-[460px] rounded-full" style={{ background: `radial-gradient(closest-side, ${GLOW_WARM}, transparent)`, opacity: 0.15, filter: "blur(56px)" }} />
            </div>
            <div className="relative">
              <h2 className="text-3xl md:text-5xl font-bold tracking-tight" style={{ color: TXT }}>Your next close, but <GradWord>calm</GradWord>.</h2>
              <p className="mt-4 mx-auto max-w-xl text-lg" style={{ color: TXT_2 }}>Connect QuickBooks in a minute. Run your first AI reconciliation in five.</p>
              <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
                <Link to={isSignedIn ? "/app" : "/sign-up"} className="inline-flex items-center justify-center gap-2 px-7 py-3.5 rounded-full text-sm font-semibold transition-all hover:-translate-y-0.5" style={{ color: "#06140D", background: GREEN, boxShadow: `0 14px 34px -10px ${GREEN}` }}>{isSignedIn ? "Open dashboard" : "Start free"} <ArrowRight size={16} /></Link>
                <Link to="/solutions" className="inline-flex items-center justify-center gap-1.5 px-7 py-3.5 rounded-full text-sm font-semibold" style={{ color: TXT, background: "rgba(14,17,18,0.04)", border: `1px solid ${LINE_2}` }}>See the product <ChevronRight size={16} /></Link>
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
  useEffect(() => {
    // Marketing homepage is a light brand page — force the shared Navbar/Footer
    // (which follow the theme tokens) to render light to match, then restore.
    const html = document.documentElement
    const had = html.classList.contains("dark")
    html.classList.remove("dark")
    return () => { if (had) html.classList.add("dark") }
  }, [])
  return (
    <div className="min-h-screen" style={{ background: INK, color: TXT }}>
      <SEO
        title="Nordavix — AI month-end close software for CPAs and controllers"
        description="Close your books in days, not weeks. AI-prepared reconciliations, flux analysis, cash-runway and break-even insights, intercompany consolidation, and an executive financial package — all on top of QuickBooks Online."
        path="/" bareTitle jsonLd={[faqSchemaObj, crumbs]} />
      <Navbar />
      <Hero />
      <CalmBanner />
      <FeatureShowcase />
      <TrustStrip />
      <Bento />
      <ProductExplorer />
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
