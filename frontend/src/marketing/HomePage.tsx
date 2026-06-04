/**
 * HomePage — the Nordavix marketing landing page.
 *
 * Art direction: a DARK, cinematic, premium page (its own art direction —
 * always dark regardless of the app theme toggle). Deep ink base with a
 * burgundy / green / rose aurora-gradient mesh, glowing accents, and REAL
 * product mockups (a reconciliation working-paper "PDF", a break-even chart,
 * a cash-runway chart, the AI commentary card, the executive report). The
 * hero pairs a big confident headline with a rotating capability list that
 * an arrow points to, cycling on a timer.
 *
 * Sections:
 *   1.  Navbar (transparent → frosted-dark on scroll)
 *   2.  Hero (aurora bg · headline + CTAs · rotating arrow list)
 *   3.  Trust strip
 *   4.  Reconcile · Explain · Close triad
 *   5.  Showcase — alternating feature blocks, each with a real mockup:
 *         Reconciliations (recon PDF) · Insights (runway + break-even) ·
 *         Flux (AI commentary) · Financial package (executive report)
 *   6.  Intercompany + Schedules
 *   7.  Agentic spotlight
 *   8.  Control grid · Personas · Founder note · Early access · FAQ · CTA
 *   9.  Footer
 *
 * Colors are hardcoded (dark) so the page never depends on the theme tokens;
 * we also force the `.dark` class while mounted so the shared footer /
 * launchpad render dark too. Charts/mockups are SVG + styled divs — no
 * external libraries, no stock imagery.
 */
import { useEffect, useState, type ReactNode, type MouseEvent as ReactMouseEvent } from "react"
import { Link } from "react-router-dom"
import { useUser } from "@clerk/clerk-react"
import { motion } from "framer-motion"
import { MarketingFooter } from "@/marketing/MarketingFooter"
import { LoggedInLaunchpad } from "@/marketing/LoggedInLaunchpad"
import { SEO, faqSchema, breadcrumbSchema } from "@/marketing/seo/SEO"
import {
  Sparkles, ArrowRight, CheckCircle2, Menu, X, ShieldCheck,
  GitCompareArrows, Brain, Workflow, Plug, Scale, FileCheck,
  Building2, UserCheck, Lock, Plus, Minus, ScrollText, TrendingUp,
  Layers, ChevronRight,
} from "lucide-react"

// ─── Dark palette (hardcoded — this page has its own art direction) ─────────
const INK      = "#0B0E0F"   // deepest base
const INK_2    = "#0F1416"   // alt section
const SURFACE  = "#141A1C"   // cards
const SURFACE2 = "#1A2123"   // raised
const LINE     = "rgba(255,255,255,0.09)"
const LINE_2   = "rgba(255,255,255,0.16)"
const TXT      = "#F3F1EC"   // primary
const TXT_2    = "#AEB4B3"   // secondary
const TXT_3    = "#727978"   // muted
const GREEN    = "#54B98A"   // brand green, lifted for dark
const GREEN_D  = "#3E8F66"
const BURGUNDY = "#8B1538"   // deep brand (used in gradient shades)
const ROSE     = "#E76B93"   // bright accent / arrow (the "color shade")
const AMBER    = "#E0A45C"

const EASE = [0.22, 1, 0.36, 1] as const

// ─── Motion helpers ──────────────────────────────────────────────────────────
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

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.18em]"
      style={{ color: GREEN }}>
      <span className="h-px w-6" style={{ background: GREEN }} />
      {children}
    </span>
  )
}

function GradWord({ children }: { children: ReactNode }) {
  return (
    <span style={{
      background: `linear-gradient(100deg, ${ROSE}, ${GREEN})`,
      WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent",
    }}>{children}</span>
  )
}

// ─── Navbar ──────────────────────────────────────────────────────────────────
const NAV_LINKS = [
  { label: "Product", to: "#showcase", external: true },
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
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : ""
    return () => { document.body.style.overflow = "" }
  }, [open])

  return (
    <>
      <nav className="fixed top-0 inset-x-0 z-50 transition-all duration-300"
        style={{
          paddingTop: scrolled ? 12 : 18, paddingBottom: scrolled ? 12 : 18,
          background: scrolled ? "rgba(11,14,15,0.72)" : "transparent",
          backdropFilter: scrolled ? "saturate(160%) blur(14px)" : "none",
          WebkitBackdropFilter: scrolled ? "saturate(160%) blur(14px)" : "none",
          borderBottom: `1px solid ${scrolled ? LINE : "transparent"}`,
        }}>
        <div className="max-w-6xl mx-auto px-6 flex items-center justify-between gap-4">
          <Link to="/" className="flex items-center gap-2.5 group shrink-0">
            <img src="/logo-mark-light.svg" alt="Nordavix" className="h-8 w-8 transition-transform group-hover:scale-105" />
            <span className="font-bold text-lg tracking-tight" style={{ color: TXT }}>
              nordavix<span style={{ color: GREEN }}>.</span>
            </span>
          </Link>
          <div className="hidden md:flex items-center gap-8">
            {NAV_LINKS.map((it) => {
              const props = { className: "text-sm font-medium transition-colors", style: { color: TXT_2 },
                onMouseEnter: (e: ReactMouseEvent<HTMLElement>) => { e.currentTarget.style.color = TXT },
                onMouseLeave: (e: ReactMouseEvent<HTMLElement>) => { e.currentTarget.style.color = TXT_2 } } as const
              return it.external
                ? <a key={it.label} href={it.to} {...props}>{it.label}</a>
                : <Link key={it.label} to={it.to} {...props}>{it.label}</Link>
            })}
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden md:flex items-center gap-2">
              {isSignedIn ? (
                <Link to="/app" className="text-sm font-semibold px-4 py-2 rounded-full inline-flex items-center gap-1.5 transition-all hover:-translate-y-0.5"
                  style={{ color: "#06140D", background: GREEN, boxShadow: `0 8px 22px -8px ${GREEN}` }}>
                  Open dashboard <ArrowRight size={14} />
                </Link>
              ) : (
                <>
                  <Link to="/sign-in" className="text-sm font-medium px-3 py-2 transition-colors" style={{ color: TXT_2 }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = TXT)}
                    onMouseLeave={(e) => (e.currentTarget.style.color = TXT_2)}>Sign in</Link>
                  <Link to="/sign-up" className="text-sm font-semibold px-4 py-2 rounded-full transition-all hover:-translate-y-0.5"
                    style={{ color: "#06140D", background: GREEN, boxShadow: `0 8px 22px -8px ${GREEN}` }}>
                    Start free
                  </Link>
                </>
              )}
            </div>
            <button onClick={() => setOpen(true)} className="md:hidden h-9 w-9 flex items-center justify-center rounded-lg"
              style={{ color: TXT, border: `1px solid ${LINE_2}` }} aria-label="Open menu">
              <Menu size={18} strokeWidth={1.8} />
            </button>
          </div>
        </div>
      </nav>

      {open && (
        <div className="fixed inset-0 z-[60] md:hidden" style={{ background: INK }}>
          <div className="flex items-center justify-between px-6 py-5">
            <span className="font-bold text-lg" style={{ color: TXT }}>nordavix<span style={{ color: GREEN }}>.</span></span>
            <button onClick={() => setOpen(false)} className="h-9 w-9 flex items-center justify-center rounded-lg"
              style={{ background: SURFACE2, color: TXT_2 }} aria-label="Close menu"><X size={18} /></button>
          </div>
          <div className="px-6 py-4 space-y-1">
            {NAV_LINKS.map((item) => (
              item.external
                ? <a key={item.label} href={item.to} onClick={() => setOpen(false)} className="block py-3 text-base font-medium" style={{ color: TXT, borderBottom: `1px solid ${LINE}` }}>{item.label}</a>
                : <Link key={item.label} to={item.to} onClick={() => setOpen(false)} className="block py-3 text-base font-medium" style={{ color: TXT, borderBottom: `1px solid ${LINE}` }}>{item.label}</Link>
            ))}
            <div className="pt-6 space-y-3">
              <Link to="/sign-up" onClick={() => setOpen(false)} className="flex items-center justify-center gap-2 w-full py-3 rounded-full text-sm font-semibold" style={{ color: "#06140D", background: GREEN }}>Start free <ArrowRight size={14} /></Link>
              <Link to="/sign-in" onClick={() => setOpen(false)} className="flex items-center justify-center w-full py-2.5 rounded-full text-sm font-medium" style={{ color: TXT_2, border: `1px solid ${LINE_2}` }}>Sign in</Link>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// ─── Hero ────────────────────────────────────────────────────────────────────
const ROTATION = [
  "Reconcile every account",
  "Explain every variance",
  "Forecast your cash runway",
  "Pinpoint the break-even",
  "Build the financial package",
  "Write the executive report",
  "Lock the period — defensibly",
]

function Hero() {
  const { isSignedIn } = useUser()
  const [active, setActive] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setActive((p) => (p + 1) % ROTATION.length), 2400)
    return () => clearInterval(t)
  }, [])

  return (
    <header className="relative overflow-hidden" style={{ background: INK }}>
      {/* aurora gradient mesh — the "color shades" */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <motion.div className="absolute -top-40 -left-32 h-[560px] w-[560px] rounded-full"
          style={{ background: `radial-gradient(closest-side, ${BURGUNDY}, transparent)`, opacity: 0.55, filter: "blur(40px)" }}
          animate={{ scale: [1, 1.12, 1], opacity: [0.45, 0.6, 0.45] }} transition={{ duration: 11, repeat: Infinity, ease: "easeInOut" }} />
        <motion.div className="absolute top-10 right-[-10%] h-[620px] w-[620px] rounded-full"
          style={{ background: `radial-gradient(closest-side, ${ROSE}, transparent)`, opacity: 0.32, filter: "blur(50px)" }}
          animate={{ scale: [1, 1.08, 1], opacity: [0.28, 0.42, 0.28] }} transition={{ duration: 13, repeat: Infinity, ease: "easeInOut", delay: 1 }} />
        <motion.div className="absolute bottom-[-30%] left-1/3 h-[560px] w-[560px] rounded-full"
          style={{ background: `radial-gradient(closest-side, ${GREEN_D}, transparent)`, opacity: 0.3, filter: "blur(50px)" }}
          animate={{ scale: [1, 1.15, 1], opacity: [0.22, 0.4, 0.22] }} transition={{ duration: 15, repeat: Infinity, ease: "easeInOut", delay: 2 }} />
        {/* faint grid + top fade */}
        <div className="absolute inset-0" style={{
          backgroundImage: `linear-gradient(${LINE} 1px, transparent 1px), linear-gradient(90deg, ${LINE} 1px, transparent 1px)`,
          backgroundSize: "56px 56px", maskImage: "radial-gradient(120% 80% at 50% 0%, black, transparent 75%)",
          WebkitMaskImage: "radial-gradient(120% 80% at 50% 0%, black, transparent 75%)", opacity: 0.5,
        }} />
      </div>

      <div className="relative max-w-6xl mx-auto px-6 pt-36 md:pt-44 pb-20 md:pb-28">
        <div className="grid lg:grid-cols-[1.05fr_0.95fr] gap-12 lg:gap-10 items-center">
          {/* left — copy */}
          <div>
            <Reveal>
              <span className="inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-semibold"
                style={{ background: "rgba(255,255,255,0.06)", color: TXT, border: `1px solid ${LINE_2}` }}>
                <Sparkles size={13} strokeWidth={2} style={{ color: ROSE }} /> Built by a CPA · Agentic month-end close
              </span>
            </Reveal>
            <Reveal delay={0.05}>
              <h1 className="mt-6 text-[2.7rem] leading-[1.04] sm:text-6xl md:text-[4.2rem] font-bold tracking-tight" style={{ color: TXT }}>
                Close the books in <GradWord>days</GradWord>, not weeks.
              </h1>
            </Reveal>
            <Reveal delay={0.1}>
              <p className="mt-6 max-w-xl text-lg leading-relaxed" style={{ color: TXT_2 }}>
                Every account reconciled, every variance explained, every report written —
                AI-prepared, you approve. Right on top of QuickBooks Online.
              </p>
            </Reveal>
            <Reveal delay={0.15}>
              <div className="mt-9">
                {isSignedIn ? (
                  <div className="max-w-md"><LoggedInLaunchpad /></div>
                ) : (
                  <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
                    <Link to="/sign-up" className="inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-full text-sm font-semibold transition-all hover:-translate-y-0.5"
                      style={{ color: "#06140D", background: GREEN, boxShadow: `0 14px 34px -10px ${GREEN}` }}>
                      Start free <ArrowRight size={16} />
                    </Link>
                    <a href="#showcase" className="inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-full text-sm font-semibold transition-colors"
                      style={{ color: TXT, background: "rgba(255,255,255,0.06)", border: `1px solid ${LINE_2}` }}>
                      See it work
                    </a>
                  </div>
                )}
              </div>
            </Reveal>
            <Reveal delay={0.2}>
              <p className="mt-7 text-[13px]" style={{ color: TXT_3 }}>
                QuickBooks-native · Maker-checker enforced · Bank-grade security
              </p>
            </Reveal>
          </div>

          {/* right — rotating capability list with an arrow */}
          <Reveal delay={0.15} className="lg:pl-6">
            <div className="text-[11px] font-bold uppercase tracking-[0.18em] mb-4" style={{ color: TXT_3 }}>
              One workspace that can…
            </div>
            <div>
              {ROTATION.map((label, idx) => {
                const on = idx === active
                return (
                  <div key={label} className="flex items-center gap-3 py-2">
                    <span className="w-5 shrink-0 flex justify-center">
                      <motion.span animate={{ opacity: on ? 1 : 0, x: on ? 0 : -8 }} transition={{ duration: 0.35, ease: EASE }}>
                        <svg width="13" height="15" viewBox="0 0 13 15" aria-hidden>
                          <path d="M0 0 L13 7.5 L0 15 Z" fill={ROSE} />
                        </svg>
                      </motion.span>
                    </span>
                    <motion.span
                      className="text-2xl md:text-[1.9rem] font-bold tracking-tight"
                      animate={{ color: on ? TXT : "#565d5c", opacity: on ? 1 : 0.7 }}
                      transition={{ duration: 0.35, ease: EASE }}>
                      {label}
                    </motion.span>
                  </div>
                )
              })}
            </div>
          </Reveal>
        </div>
      </div>
    </header>
  )
}

// ─── Trust strip ─────────────────────────────────────────────────────────────
function TrustStrip() {
  const items = [
    { Icon: Plug, label: "QuickBooks-native" },
    { Icon: Building2, label: "Built by a CPA" },
    { Icon: UserCheck, label: "Maker-checker enforced" },
    { Icon: ShieldCheck, label: "Bank-grade security" },
  ]
  return (
    <section style={{ background: INK }}>
      <div className="max-w-5xl mx-auto px-6 py-8" style={{ borderTop: `1px solid ${LINE}` }}>
        <Reveal>
          <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-4">
            {items.map(({ Icon, label }) => (
              <div key={label} className="inline-flex items-center gap-2 text-sm font-medium" style={{ color: TXT_3 }}>
                <Icon size={16} strokeWidth={1.8} /> {label}
              </div>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  )
}

// ─── Triad ───────────────────────────────────────────────────────────────────
function Triad() {
  const cols = [
    { Icon: GitCompareArrows, t: "Reconcile", d: "Tie every balance-sheet account to its subledger — roll-forward openings, ticked items, attached evidence." },
    { Icon: Brain, t: "Explain", d: "AI grounds every variance in the actual transactions that moved it, with a confidence score you can trust." },
    { Icon: Workflow, t: "Close", d: "Lock the period when every account is approved. Sequential, audited, defensible by design." },
  ]
  return (
    <section style={{ background: INK_2 }}>
      <div className="max-w-6xl mx-auto px-6 py-24 md:py-28">
        <Reveal className="max-w-2xl mx-auto text-center">
          <Eyebrow>One workspace</Eyebrow>
          <h2 className="mt-4 text-3xl md:text-5xl font-bold tracking-tight" style={{ color: TXT }}>
            The whole close, in three calm moves.
          </h2>
        </Reveal>
        <div className="mt-14 grid md:grid-cols-3 gap-6">
          {cols.map(({ Icon, t, d }, i) => (
            <Reveal key={t} delay={i * 0.08}>
              <div className="h-full rounded-2xl p-7" style={{ background: SURFACE, border: `1px solid ${LINE}` }}>
                <div className="h-11 w-11 rounded-xl flex items-center justify-center" style={{ background: "rgba(84,185,138,0.14)", color: GREEN }}>
                  <Icon size={20} strokeWidth={1.9} />
                </div>
                <h3 className="mt-5 text-xl font-bold" style={{ color: TXT }}>{t}</h3>
                <p className="mt-2 text-[15px] leading-relaxed" style={{ color: TXT_2 }}>{d}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}

// ─── Mockups ────────────────────────────────────────────────────────────────
// Reconciliation working paper — rendered as a real light "paper" on the dark page.
function ReconPaper() {
  return (
    <div className="rounded-2xl p-4 sm:p-6" style={{ background: "#FAFAF8", boxShadow: "0 30px 70px -30px rgba(0,0,0,0.7)", border: "1px solid rgba(0,0,0,0.06)" }}>
      <div className="flex items-center justify-between text-[10px] font-semibold tracking-wide" style={{ color: "#8A8F98" }}>
        <span>HELIO LOGISTICS, INC.</span>
        <span className="text-right">RECONCILIATION PACKET<br /><span style={{ color: "#B6BAC0" }}>REC-202603-1100</span></span>
      </div>
      <div className="mt-3 pt-3" style={{ borderTop: "1px solid #ECEAE5" }}>
        <div className="text-[10px] font-bold tracking-[0.16em]" style={{ color: GREEN_D }}>GENERAL LEDGER RECONCILIATION</div>
        <div className="mt-1 text-xl font-bold" style={{ color: "#14181A" }}>Operating cash · 1100</div>
        <div className="text-xs" style={{ color: "#8A8F98" }}>Q1 2026 · period close</div>
      </div>
      <div className="mt-4 grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        <div>
          <div className="text-[9px] uppercase tracking-wider" style={{ color: "#8A8F98" }}>Per general ledger</div>
          <div className="text-lg font-bold tabular-nums" style={{ color: "#14181A" }}>$2,847,392</div>
        </div>
        <div className="text-2xl font-light" style={{ color: GREEN_D }}>=</div>
        <div className="text-right">
          <div className="text-[9px] uppercase tracking-wider" style={{ color: "#8A8F98" }}>Per bank statement</div>
          <div className="text-lg font-bold tabular-nums" style={{ color: "#14181A" }}>$2,847,392</div>
        </div>
      </div>
      <div className="mt-4 space-y-1.5 text-xs" style={{ color: "#3C4146" }}>
        {[["Opening balance", "rolled fwd"], ["Deposits in transit", "+ 342,180"], ["Outstanding checks", "− 12,840"]].map(([a, b]) => (
          <div key={a} className="flex justify-between"><span>{a}</span><span className="tabular-nums" style={{ color: "#8A8F98" }}>{b}</span></div>
        ))}
        <div className="flex justify-between pt-1.5 font-bold" style={{ borderTop: "1px solid #14181A", color: "#14181A" }}>
          <span>Reconciled balance — matches source</span><span className="tabular-nums" style={{ color: GREEN_D }}>$2,847,392</span>
        </div>
      </div>
      <div className="mt-4 rounded-lg p-3 text-[11px] leading-relaxed" style={{ background: "#EAF4EE", borderLeft: `3px solid ${GREEN_D}`, color: "#3C4146" }}>
        <span className="font-bold" style={{ color: GREEN_D }}>AI summary · </span>
        Outstanding items are timing differences only; both checks cleared 03 Apr. Variance $0.00. Defensible in audit.
      </div>
    </div>
  )
}

// Cash runway — declining area chart.
function CashRunwayChart() {
  const pts = [[30,28],[56,38],[82,50],[108,58],[134,72],[160,84],[186,98],[212,110],[238,122],[264,132],[290,140],[316,146],[340,150]]
  const line = pts.map((p) => p.join(",")).join(" ")
  const area = `30,150 ${line} 340,150`
  return (
    <div className="rounded-2xl p-5" style={{ background: SURFACE, border: `1px solid ${LINE}` }}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold" style={{ color: TXT }}>Cash runway</span>
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold px-2 py-0.5 rounded-full" style={{ background: "rgba(84,185,138,0.14)", color: GREEN }}>14 months</span>
      </div>
      <svg viewBox="0 0 360 168" className="mt-3 w-full">
        <defs>
          <linearGradient id="runwayFill" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={GREEN} stopOpacity="0.35" /><stop offset="65%" stopColor={AMBER} stopOpacity="0.25" /><stop offset="100%" stopColor={ROSE} stopOpacity="0.28" />
          </linearGradient>
          <linearGradient id="runwayLine" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={GREEN} /><stop offset="70%" stopColor={AMBER} /><stop offset="100%" stopColor={ROSE} />
          </linearGradient>
        </defs>
        <line x1="30" y1="150" x2="340" y2="150" stroke={LINE_2} strokeWidth="1" />
        <polygon points={area} fill="url(#runwayFill)" />
        <polyline points={line} fill="none" stroke="url(#runwayLine)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="340" cy="150" r="3.5" fill={ROSE} />
      </svg>
      <div className="mt-2 grid grid-cols-3 gap-2 text-center">
        {[["Cash", "$1.24M"], ["Net burn", "$89k/mo"], ["Runway", "14 mo"]].map(([a, b]) => (
          <div key={a}><div className="text-[10px] uppercase tracking-wider" style={{ color: TXT_3 }}>{a}</div><div className="text-sm font-bold tabular-nums" style={{ color: TXT }}>{b}</div></div>
        ))}
      </div>
    </div>
  )
}

// Break-even — revenue vs total cost.
function BreakEvenChart() {
  // plot area x:40..330  y:24..150
  // revenue: (40,150)->(330,40) ; cost: (40,108)->(330,72)
  const beX = 244, beY = 92
  return (
    <div className="rounded-2xl p-5" style={{ background: SURFACE, border: `1px solid ${LINE}` }}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold" style={{ color: TXT }}>Break-even analysis</span>
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold" style={{ color: TXT_3 }}><TrendingUp size={13} /> margin of safety 22%</span>
      </div>
      <svg viewBox="0 0 360 168" className="mt-3 w-full">
        {/* profit fill right of break-even */}
        <polygon points={`${beX},${beY} 330,40 330,72`} fill={GREEN} opacity="0.18" />
        {/* loss fill left */}
        <polygon points={`40,150 ${beX},${beY} 40,108`} fill={ROSE} opacity="0.14" />
        <line x1="40" y1="150" x2="330" y2="150" stroke={LINE_2} strokeWidth="1" />
        <line x1="40" y1="24" x2="40" y2="150" stroke={LINE_2} strokeWidth="1" />
        {/* total cost */}
        <line x1="40" y1="108" x2="330" y2="72" stroke={AMBER} strokeWidth="2.5" strokeLinecap="round" />
        {/* revenue */}
        <line x1="40" y1="150" x2="330" y2="40" stroke={GREEN} strokeWidth="2.5" strokeLinecap="round" />
        {/* break-even marker */}
        <line x1={beX} y1={beY} x2={beX} y2="150" stroke={ROSE} strokeWidth="1" strokeDasharray="3 3" />
        <circle cx={beX} cy={beY} r="4" fill={ROSE} stroke={INK} strokeWidth="1.5" />
        <text x={beX} y={beY - 8} textAnchor="middle" fontSize="9" fontWeight="700" fill={TXT}>Break-even</text>
      </svg>
      <div className="mt-1 flex items-center gap-4 text-[11px]" style={{ color: TXT_3 }}>
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: GREEN }} /> Revenue</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: AMBER }} /> Total cost</span>
      </div>
    </div>
  )
}

// AI commentary card (dark).
function AICard() {
  return (
    <div className="rounded-2xl overflow-hidden" style={{ background: SURFACE, border: `1px solid ${LINE}`, boxShadow: "0 30px 70px -40px rgba(0,0,0,0.8)" }}>
      <div className="flex items-center justify-between px-5 py-3" style={{ borderBottom: `1px solid ${LINE}` }}>
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full" style={{ background: "rgba(84,185,138,0.14)", color: GREEN }}>
          <Sparkles size={12} strokeWidth={2} /> AI commentary
        </span>
        <span className="text-xs tabular-nums" style={{ color: TXT_3 }}>March 2026</span>
      </div>
      <div className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-sm font-bold" style={{ color: TXT }}>6400 · Marketing &amp; Advertising</div>
            <div className="text-xs mt-0.5" style={{ color: TXT_3 }}>Flux vs. February</div>
          </div>
          <div className="text-right shrink-0">
            <div className="text-lg font-bold tabular-nums" style={{ color: ROSE }}>+$14,200</div>
            <div className="text-xs tabular-nums" style={{ color: TXT_3 }}>+38%</div>
          </div>
        </div>
        <p className="mt-4 text-sm leading-relaxed" style={{ color: TXT_2 }}>
          Spend rose <span className="font-semibold" style={{ color: TXT }}>$14,200 (+38%)</span> over February, concentrated in three Q1
          campaign launches. All invoices match their POs; nothing unposted above threshold. Operational, not an error.
        </p>
        <div className="mt-4 space-y-2">
          {["Ties to the general ledger", "Top 3 driving transactions reviewed", "No items over threshold"].map((c) => (
            <div key={c} className="flex items-center gap-2 text-[13px]" style={{ color: TXT_2 }}>
              <CheckCircle2 size={15} strokeWidth={2} style={{ color: GREEN }} /> {c}
            </div>
          ))}
        </div>
        <div className="mt-5 pt-4 flex items-center justify-between" style={{ borderTop: `1px solid ${LINE}` }}>
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full" style={{ background: "rgba(84,185,138,0.14)", color: GREEN }}>Confidence: High</span>
          <span className="text-xs" style={{ color: TXT_3 }}>3 transactions cited</span>
        </div>
      </div>
    </div>
  )
}

// Executive report (dark document).
function ExecReport() {
  return (
    <div className="rounded-2xl p-6" style={{ background: SURFACE, border: `1px solid ${LINE}`, boxShadow: "0 30px 70px -40px rgba(0,0,0,0.8)" }}>
      <div className="flex items-start justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-[0.2em]" style={{ color: TXT_3 }}>Executive report</div>
          <div className="mt-1 text-lg font-bold" style={{ color: TXT }}>Helio Logistics, Inc.</div>
          <div className="text-xs" style={{ color: TXT_3 }}>Period ending March 31, 2026</div>
        </div>
        <span className="text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded" style={{ color: GREEN, border: `1px solid rgba(84,185,138,0.45)` }}>AI-narrated</span>
      </div>
      <div className="mt-5 space-y-1.5">
        <div className="h-2 rounded-full w-full" style={{ background: SURFACE2 }} />
        <div className="h-2 rounded-full w-[90%]" style={{ background: SURFACE2 }} />
        <div className="h-2 rounded-full w-[76%]" style={{ background: SURFACE2 }} />
      </div>
      <div className="mt-5 flex items-end gap-2 h-20">
        {[40, 62, 52, 78, 70, 94].map((h, i) => (
          <div key={i} className="flex-1 rounded-t-md" style={{ height: `${h}%`, background: i === 5 ? GREEN : "rgba(84,185,138,0.22)" }} />
        ))}
      </div>
      <div className="mt-4 flex items-center gap-2 text-xs" style={{ color: TXT_2 }}>
        <FileCheck size={14} strokeWidth={2} style={{ color: GREEN }} /> Cover · summary · IS / BS / CF · charts · risks &amp; outlook
      </div>
    </div>
  )
}

// ─── Showcase (alternating feature blocks) ──────────────────────────────────
interface BlockProps { eyebrow: string; title: string; body: string; bullets: string[]; visual: ReactNode; flip?: boolean }
function FeatureBlock({ eyebrow, title, body, bullets, visual, flip }: BlockProps) {
  return (
    <div className="grid lg:grid-cols-2 gap-10 lg:gap-16 items-center">
      <Reveal className={flip ? "lg:order-2" : ""}>
        <Eyebrow>{eyebrow}</Eyebrow>
        <h3 className="mt-4 text-3xl md:text-4xl font-bold tracking-tight" style={{ color: TXT }}>{title}</h3>
        <p className="mt-4 text-lg leading-relaxed" style={{ color: TXT_2 }}>{body}</p>
        <ul className="mt-6 space-y-3">
          {bullets.map((b) => (
            <li key={b} className="flex items-start gap-3 text-[15px]" style={{ color: TXT_2 }}>
              <CheckCircle2 size={18} strokeWidth={2} className="mt-0.5 shrink-0" style={{ color: GREEN }} /><span>{b}</span>
            </li>
          ))}
        </ul>
      </Reveal>
      <Reveal delay={0.1} y={32} className={flip ? "lg:order-1" : ""}>{visual}</Reveal>
    </div>
  )
}

function Showcase() {
  return (
    <section id="showcase" style={{ background: INK }}>
      <div className="max-w-6xl mx-auto px-6 py-24 md:py-32">
        <Reveal className="max-w-2xl mx-auto text-center mb-16 md:mb-20">
          <Eyebrow>The product</Eyebrow>
          <h2 className="mt-4 text-3xl md:text-5xl font-bold tracking-tight" style={{ color: TXT }}>
            See the actual <GradWord>output</GradWord>.
          </h2>
          <p className="mt-4 text-lg" style={{ color: TXT_2 }}>Real working papers, real charts — generated from your live QuickBooks data.</p>
        </Reveal>

        <div className="space-y-24 md:space-y-32">
          <FeatureBlock
            eyebrow="Reconciliations + Agentic"
            title="Every account, tied out — on paper."
            body="Reconcile each balance-sheet account to its subledger, then export an audit-ready working paper. Agentic Mode prepares the whole set in one click."
            bullets={[
              "GL ⇄ subledger build-up with roll-forward openings",
              "One-click AI auto-prepare across every open account",
              "Evidence OCR matches your uploaded statement",
              "Maker-checker: no one approves their own work",
            ]}
            visual={<ReconPaper />}
          />
          <FeatureBlock
            flip
            eyebrow="Insights"
            title="Cash runway and break-even, watched for you."
            body="A living analytics layer on the close — know exactly how long the cash lasts and the volume you need to break even, refreshed every period."
            bullets={[
              "Cash, net burn, and runway in months",
              "Break-even point with margin of safety",
              "Liquidity, DSO/DPO, and aging",
              "Month-over-month expense movers",
            ]}
            visual={<div className="space-y-5"><CashRunwayChart /><BreakEvenChart /></div>}
          />
          <FeatureBlock
            eyebrow="Flux analysis"
            title="Every variance, explained."
            body="Compare any period to the prior and let AI write the narrative — grounded in the real transactions that moved the number, with a confidence score."
            bullets={[
              "Period-over-period across P&L and balance sheet",
              "Commentary cites the actual driving transactions",
              "Confidence score on every explanation",
              "Sign-off gate before a variance is reviewed",
            ]}
            visual={<AICard />}
          />
          <FeatureBlock
            flip
            eyebrow="Financial package + executive report"
            title="A board-ready package — written by AI."
            body="Income statement, balance sheet, and cash flow on screen and as a PDF — plus a multi-page executive report your AI drafts in seconds."
            bullets={[
              "IS / BS / CF rendered live and exportable",
              "AI-narrated executive report: summary, charts, risks, outlook",
              "Built from your synced ledger — consistent monthly",
              "Hand it to a board or client as-is",
            ]}
            visual={<ExecReport />}
          />
        </div>

        <Reveal className="mt-24 md:mt-28">
          <div className="grid md:grid-cols-2 gap-6">
            {[
              { Icon: Scale, title: "Intercompany", body: "Auto-detects intercompany accounts, suggests counterparty pairs, and produces eliminations and a consolidated trial balance across entities." },
              { Icon: Layers, title: "Schedules", body: "Prepaids, accruals, fixed assets, leases, and loans — amortized on schedule and auto-flowed into the right reconciliation." },
            ].map(({ Icon, title, body }) => (
              <div key={title} className="rounded-2xl p-7" style={{ background: SURFACE, border: `1px solid ${LINE}` }}>
                <div className="h-11 w-11 rounded-xl flex items-center justify-center" style={{ background: "rgba(84,185,138,0.14)", color: GREEN }}><Icon size={20} strokeWidth={1.9} /></div>
                <h3 className="mt-5 text-xl font-bold" style={{ color: TXT }}>{title}</h3>
                <p className="mt-2 text-[15px] leading-relaxed" style={{ color: TXT_2 }}>{body}</p>
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
    { n: "03", t: "Writes the commentary", d: "A grounded narrative, risk flags, a confidence score." },
    { n: "04", t: "Hands it to you", d: "Suggest-only. You review and approve — always." },
  ]
  return (
    <section className="relative overflow-hidden" style={{ background: INK_2 }}>
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute -top-20 right-0 h-[420px] w-[520px] rounded-full" style={{ background: `radial-gradient(closest-side, ${BURGUNDY}, transparent)`, opacity: 0.4, filter: "blur(50px)" }} />
        <div className="absolute bottom-[-30%] left-[-10%] h-[420px] w-[520px] rounded-full" style={{ background: `radial-gradient(closest-side, ${ROSE}, transparent)`, opacity: 0.22, filter: "blur(60px)" }} />
      </div>
      <div className="relative max-w-6xl mx-auto px-6 py-24 md:py-32">
        <Reveal className="max-w-2xl">
          <span className="inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold" style={{ background: "rgba(231,107,147,0.14)", color: ROSE }}>
            <Sparkles size={13} strokeWidth={2} /> Agentic Mode
          </span>
          <h2 className="mt-5 text-3xl md:text-5xl font-bold tracking-tight" style={{ color: TXT }}>Meet your AI staff accountant.</h2>
          <p className="mt-4 text-lg leading-relaxed" style={{ color: TXT_2 }}>
            Click once and Nordavix runs the first pass across every open account — pulling, tying out, and writing the
            working paper. It never approves anything. You keep the judgment; it removes the grind.
          </p>
        </Reveal>
        <div className="mt-14 grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {steps.map(({ n, t, d }, i) => (
            <Reveal key={n} delay={i * 0.08}>
              <div className="h-full rounded-2xl p-6" style={{ background: SURFACE, border: `1px solid ${LINE}` }}>
                <div className="text-sm font-bold tabular-nums" style={{ color: ROSE }}>{n}</div>
                <h3 className="mt-3 text-base font-bold" style={{ color: TXT }}>{t}</h3>
                <p className="mt-1.5 text-sm leading-relaxed" style={{ color: TXT_2 }}>{d}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}

// ─── Control grid ────────────────────────────────────────────────────────────
function ControlGrid() {
  const items = [
    { Icon: UserCheck, t: "Maker-checker enforced", d: "The person who enters a value can never approve it. Enforced server-side." },
    { Icon: Workflow, t: "Sequential close gate", d: "You can't close March until February is locked. No skipping, no back-dating." },
    { Icon: ScrollText, t: "Every action audited", d: "A complete, attributed trail of who did what, when — replayable for review." },
    { Icon: Lock, t: "QuickBooks read-only", d: "Read-only OAuth scope. Nordavix never writes back to your books." },
  ]
  return (
    <section style={{ background: INK }}>
      <div className="max-w-6xl mx-auto px-6 py-24 md:py-28">
        <Reveal className="max-w-2xl mx-auto text-center mb-14">
          <Eyebrow>Trust &amp; control</Eyebrow>
          <h2 className="mt-4 text-3xl md:text-5xl font-bold tracking-tight" style={{ color: TXT }}>Control you can prove.</h2>
          <p className="mt-4 text-lg" style={{ color: TXT_2 }}>The governance auditors ask for — built in, not bolted on.</p>
        </Reveal>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {items.map(({ Icon, t, d }, i) => (
            <Reveal key={t} delay={i * 0.06}>
              <div className="h-full rounded-2xl p-6" style={{ background: SURFACE, border: `1px solid ${LINE}` }}>
                <Icon size={22} strokeWidth={1.8} style={{ color: GREEN }} />
                <h3 className="mt-4 text-base font-bold" style={{ color: TXT }}>{t}</h3>
                <p className="mt-1.5 text-sm leading-relaxed" style={{ color: TXT_2 }}>{d}</p>
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
    <section style={{ background: INK_2 }}>
      <div className="max-w-6xl mx-auto px-6 py-24 md:py-28">
        <Reveal className="max-w-2xl mx-auto text-center mb-14">
          <Eyebrow>Who it&apos;s for</Eyebrow>
          <h2 className="mt-4 text-3xl md:text-5xl font-bold tracking-tight" style={{ color: TXT }}>Built for the people who own the close.</h2>
        </Reveal>
        <div className="grid md:grid-cols-3 gap-6">
          {cards.map(({ Icon, role, pitch, bullets }, i) => (
            <Reveal key={role} delay={i * 0.08}>
              <div className="h-full rounded-2xl p-7" style={{ background: SURFACE, border: `1px solid ${LINE}` }}>
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-xl flex items-center justify-center" style={{ background: "rgba(84,185,138,0.14)", color: GREEN }}><Icon size={19} strokeWidth={1.9} /></div>
                  <span className="text-sm font-semibold" style={{ color: TXT_3 }}>{role}</span>
                </div>
                <h3 className="mt-5 text-xl font-bold" style={{ color: TXT }}>{pitch}</h3>
                <ul className="mt-4 space-y-2.5">
                  {bullets.map((b) => (
                    <li key={b} className="flex items-start gap-2.5 text-sm" style={{ color: TXT_2 }}>
                      <CheckCircle2 size={16} strokeWidth={2} className="mt-0.5 shrink-0" style={{ color: GREEN }} /> {b}
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
    <section style={{ background: INK }}>
      <div className="max-w-4xl mx-auto px-6 py-24 md:py-28">
        <Reveal>
          <figure className="rounded-3xl p-8 md:p-12" style={{ background: SURFACE, border: `1px solid ${LINE}`, borderLeft: `4px solid ${ROSE}` }}>
            <blockquote className="text-xl md:text-2xl font-medium leading-relaxed" style={{ color: TXT }}>
              “I&apos;m a CPA. I&apos;ve lived the month-end grind — the 11&nbsp;pm tie-outs, the variance emails, the audit
              scramble. Nordavix is the tool I wished I had: AI does the first pass, you keep the judgment, and the close
              finally feels <GradWord>calm</GradWord>.”
            </blockquote>
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
    <section id="beta" style={{ background: INK_2 }}>
      <div className="max-w-4xl mx-auto px-6 py-24 md:py-28 text-center">
        <Reveal>
          <Eyebrow>Pricing</Eyebrow>
          <h2 className="mt-4 text-3xl md:text-5xl font-bold tracking-tight" style={{ color: TXT }}>Pricing is on the way. Early access is open.</h2>
          <p className="mt-4 mx-auto max-w-xl text-lg" style={{ color: TXT_2 }}>
            We&apos;re onboarding design partners now — the full feature set, no credit card, and a direct line to the founders.
          </p>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
            {["Full feature set", "No credit card", "Direct line to the founders"].map((p) => (
              <span key={p} className="inline-flex items-center gap-1.5 text-sm font-medium px-3.5 py-1.5 rounded-full" style={{ background: SURFACE, border: `1px solid ${LINE}`, color: TXT_2 }}>
                <CheckCircle2 size={14} strokeWidth={2} style={{ color: GREEN }} /> {p}
              </span>
            ))}
          </div>
          <div className="mt-9 flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link to="/sign-up" className="inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-full text-sm font-semibold transition-all hover:-translate-y-0.5"
              style={{ color: "#06140D", background: GREEN, boxShadow: `0 14px 34px -10px ${GREEN}` }}>Request beta access <ArrowRight size={16} /></Link>
            <Link to="/solutions" className="inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-full text-sm font-semibold"
              style={{ color: TXT, background: "rgba(255,255,255,0.06)", border: `1px solid ${LINE_2}` }}>Explore the product</Link>
          </div>
        </Reveal>
      </div>
    </section>
  )
}

// ─── FAQ (questions also power the FAQPage JSON-LD) ──────────────────────────
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
        <Reveal className="text-center mb-12">
          <Eyebrow>FAQ</Eyebrow>
          <h2 className="mt-4 text-3xl md:text-5xl font-bold tracking-tight" style={{ color: TXT }}>Questions, answered.</h2>
        </Reveal>
        <div className="space-y-3">
          {FAQ_QUESTIONS.map((item, i) => {
            const isOpen = openIdx === i
            return (
              <Reveal key={item.q} delay={i * 0.04}>
                <div className="rounded-2xl overflow-hidden" style={{ background: SURFACE, border: `1px solid ${isOpen ? LINE_2 : LINE}` }}>
                  <button onClick={() => setOpenIdx(isOpen ? null : i)} className="w-full flex items-center justify-between gap-4 text-left px-5 py-4" aria-expanded={isOpen}>
                    <span className="text-[15px] font-semibold" style={{ color: TXT }}>{item.q}</span>
                    <span className="shrink-0 h-7 w-7 rounded-full flex items-center justify-center" style={{ background: isOpen ? "rgba(84,185,138,0.14)" : SURFACE2, color: isOpen ? GREEN : TXT_3 }}>
                      {isOpen ? <Minus size={15} strokeWidth={2.2} /> : <Plus size={15} strokeWidth={2.2} />}
                    </span>
                  </button>
                  {isOpen && (
                    <p className="px-5 pb-5 text-[15px] leading-relaxed" style={{ color: TXT_2 }}>{item.a}</p>
                  )}
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
          <div className="relative overflow-hidden rounded-[2rem] px-8 py-16 md:py-20 text-center" style={{ background: SURFACE, border: `1px solid ${LINE}` }}>
            <div aria-hidden className="pointer-events-none absolute inset-0">
              <div className="absolute -top-24 left-1/4 h-72 w-[460px] rounded-full" style={{ background: `radial-gradient(closest-side, ${GREEN_D}, transparent)`, opacity: 0.4, filter: "blur(40px)" }} />
              <div className="absolute -bottom-24 right-1/4 h-72 w-[460px] rounded-full" style={{ background: `radial-gradient(closest-side, ${ROSE}, transparent)`, opacity: 0.3, filter: "blur(50px)" }} />
            </div>
            <div className="relative">
              <h2 className="text-3xl md:text-5xl font-bold tracking-tight" style={{ color: TXT }}>Your next close, but <GradWord>calm</GradWord>.</h2>
              <p className="mt-4 mx-auto max-w-xl text-lg" style={{ color: TXT_2 }}>Connect QuickBooks in a minute. Run your first AI reconciliation in five.</p>
              <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
                <Link to={isSignedIn ? "/app" : "/sign-up"} className="inline-flex items-center justify-center gap-2 px-7 py-3.5 rounded-full text-sm font-semibold transition-all hover:-translate-y-0.5"
                  style={{ color: "#06140D", background: GREEN, boxShadow: `0 14px 34px -10px ${GREEN}` }}>
                  {isSignedIn ? "Open dashboard" : "Start free"} <ArrowRight size={16} />
                </Link>
                <Link to="/solutions" className="inline-flex items-center justify-center gap-1.5 px-7 py-3.5 rounded-full text-sm font-semibold"
                  style={{ color: TXT, background: "rgba(255,255,255,0.06)", border: `1px solid ${LINE_2}` }}>See the product <ChevronRight size={16} /></Link>
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

  // This page has its own dark art direction — force the `.dark` class while
  // mounted so the shared footer / signed-in launchpad render dark too,
  // then restore on unmount.
  useEffect(() => {
    const html = document.documentElement
    const had = html.classList.contains("dark")
    html.classList.add("dark")
    return () => { if (!had) html.classList.remove("dark") }
  }, [])

  return (
    <div className="min-h-screen" style={{ background: INK, color: TXT }}>
      <SEO
        title="Nordavix — AI month-end close software for CPAs and controllers"
        description="Close your books in days, not weeks. AI-prepared reconciliations, flux analysis, cash-runway and break-even insights, intercompany consolidation, and an executive financial package — all on top of QuickBooks Online."
        path="/"
        bareTitle
        jsonLd={[faqSchemaObj, crumbs]}
      />
      <Navbar />
      <Hero />
      <TrustStrip />
      <Triad />
      <Showcase />
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
