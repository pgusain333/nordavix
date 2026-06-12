/**
 * HomePage — the Nordavix marketing landing page.
 *
 * Art direction: "finance editorial" — the confident big-SaaS look (Ramp /
 * Mercury / Linear lineage), deliberately NOT the generic AI-gradient site.
 *   · Deep pine ink (#0C2620) as the dominant dark, warm cream (#F4F1E9)
 *     for the product sections — a two-world rhythm: dark statement bands,
 *     light "show the work" bands.
 *   · ONE loud accent: electric lime (#D4F361). Everything else is quiet.
 *   · Type system: Fraunces (editorial serif) for display headlines,
 *     Plus Jakarta Sans for body, JetBrains Mono for eyebrows / metrics /
 *     figures — the mono-label discipline big SaaS sites use.
 *   · The hero centerpiece is a browser-framed product shot built in pure
 *     CSS/SVG (no images): the recon dashboard with the Nordavix-vs-
 *     QuickBooks subledger match card floating beside it.
 *
 * Sections: Topbar → Navbar → Hero (+AppShot) → MetricsBar → Platform
 * (3 deep feature rows) → Bento ("the rest of the close") → AI band →
 * Workflow ribbon → Security → Founder letter → Beta → FAQ → Final CTA →
 * shared MarketingFooter.
 */
import { useEffect, useState, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { useUser } from "@clerk/clerk-react"
import { motion, AnimatePresence } from "framer-motion"
import { MarketingFooter } from "@/marketing/MarketingFooter"
import { SEO, faqSchema, breadcrumbSchema } from "@/marketing/seo/SEO"
import {
  Sparkles, ArrowRight, CheckCircle2, Menu, X, ShieldCheck, Lock,
  ScrollText, UserCheck, Plug, Layers, TrendingUp, Scale, FileText,
  GitCompareArrows, Plus, Minus, ChevronRight, AlertTriangle, Landmark,
  RefreshCw, Receipt, BookCheck,
} from "lucide-react"

// ─── Palette ─────────────────────────────────────────────────────────────────
const PINE    = "#0C2620"   // page dark — deep pine ink
const PINE_2  = "#103028"   // raised dark surface
const PINE_3  = "#163D33"   // dark hover / strong hairline
const D_LINE  = "rgba(244,241,233,0.10)"  // hairline on dark
const D_LINE2 = "rgba(244,241,233,0.16)"
const D_TXT   = "#F4F1E9"   // text on dark — warm cream-white
const D_TXT2  = "rgba(244,241,233,0.66)"
const D_TXT3  = "rgba(244,241,233,0.42)"
const LIME    = "#D4F361"   // THE accent
const LIME_D  = "#0E2A14"   // text on lime
const SAGE    = "#7FB89B"   // quiet support on dark
const CREAM   = "#F4F1E9"   // light section base
const PAPER   = "#FCFBF7"   // cards on cream
const L_LINE  = "rgba(12,38,32,0.10)"     // hairline on light
const L_LINE2 = "rgba(12,38,32,0.16)"
const L_TXT   = "#11271F"   // text on light — pine
const L_TXT2  = "#46584F"
const L_TXT3  = "#7C8A82"
const GREEN   = "#2E7A55"   // semantic ok (on light)
const AMBER   = "#B07F3C"   // semantic pending (on light)
const RED     = "#A8544A"   // semantic gap (on light)

const SERIF = '"Fraunces", Georgia, "Times New Roman", serif'
const MONO  = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace'
const EASE  = [0.22, 1, 0.36, 1] as const

// ─── Helpers ─────────────────────────────────────────────────────────────────
function Reveal({ children, delay = 0, y = 22, className = "" }:
  { children: ReactNode; delay?: number; y?: number; className?: string }) {
  return (
    <motion.div className={className}
      initial={{ opacity: 0, y }} whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-70px" }}
      transition={{ duration: 0.65, ease: EASE, delay }}>
      {children}
    </motion.div>
  )
}
/** Mono uppercase eyebrow — the section label discipline. */
function Kicker({ children, dark = false }: { children: ReactNode; dark?: boolean }) {
  return (
    <div className="flex items-center gap-2.5 text-[11px] font-medium tracking-[0.22em] uppercase"
      style={{ fontFamily: MONO, color: dark ? SAGE : GREEN }}>
      <span className="h-[5px] w-[5px] rounded-[1px]" style={{ background: LIME }} />
      {children}
    </div>
  )
}
/** Display headline — Fraunces serif. */
function Display({ children, dark = false, size = "clamp(2rem, 4.2vw, 3.4rem)", className = "" }:
  { children: ReactNode; dark?: boolean; size?: string; className?: string }) {
  return (
    <h2 className={`tracking-[-0.01em] ${className}`}
      style={{ fontFamily: SERIF, fontWeight: 550, lineHeight: 1.06, fontSize: size, color: dark ? D_TXT : L_TXT }}>
      {children}
    </h2>
  )
}
function LimeBtn({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to}
      className="inline-flex items-center justify-center gap-2 rounded-full px-6 py-3.5 text-sm font-bold transition-transform hover:-translate-y-0.5"
      style={{ background: LIME, color: LIME_D, boxShadow: "0 16px 40px -14px rgba(212,243,97,0.45)" }}>
      {children}
    </Link>
  )
}

// ─── Topbar + Navbar ─────────────────────────────────────────────────────────
const NAV = [
  { label: "Platform", to: "#platform", anchor: true },
  { label: "Workflow", to: "#workflow", anchor: true },
  { label: "Security", to: "#security", anchor: true },
  { label: "Blog", to: "/blog", anchor: false },
  { label: "FAQ", to: "#faq", anchor: true },
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
  return (
    <>
      {/* announcement microbar */}
      <div className="relative z-50 text-center px-4 py-2 text-[11px] tracking-[0.08em]"
        style={{ fontFamily: MONO, background: LIME, color: LIME_D }}>
        PRIVATE BETA IS OPEN — FOUNDING FIRMS GET THE FULL PLATFORM FREE{" "}
        <Link to="/sign-up" className="font-bold underline underline-offset-2">CLAIM A SPOT →</Link>
      </div>
      <nav className="sticky top-0 inset-x-0 z-50 transition-all duration-300"
        style={{
          background: scrolled ? "rgba(12,38,32,0.86)" : "transparent",
          backdropFilter: scrolled ? "saturate(150%) blur(14px)" : "none",
          WebkitBackdropFilter: scrolled ? "saturate(150%) blur(14px)" : "none",
          borderBottom: `1px solid ${scrolled ? D_LINE : "transparent"}`,
        }}>
        <div className="max-w-6xl mx-auto px-6 h-[64px] flex items-center justify-between gap-4">
          <Link to="/" className="flex items-center gap-2 shrink-0 group">
            <span className="h-[22px] w-[22px] rounded-[6px] grid place-items-center text-[13px] font-extrabold transition-transform group-hover:rotate-[-6deg]"
              style={{ background: LIME, color: LIME_D, fontFamily: MONO }}>n</span>
            <span className="font-bold text-[17px] tracking-tight" style={{ color: D_TXT }}>nordavix</span>
          </Link>
          <div className="hidden md:flex items-center gap-7">
            {NAV.map((it) => it.anchor
              ? <a key={it.label} href={it.to} className="text-[13.5px] font-medium transition-colors hover:text-white" style={{ color: D_TXT2 }}>{it.label}</a>
              : <Link key={it.label} to={it.to} className="text-[13.5px] font-medium transition-colors hover:text-white" style={{ color: D_TXT2 }}>{it.label}</Link>)}
          </div>
          <div className="flex items-center gap-2.5">
            <div className="hidden md:flex items-center gap-2.5">
              {isSignedIn ? (
                <Link to="/app" className="inline-flex items-center gap-1.5 text-[13px] font-bold rounded-full px-4 py-2 transition-transform hover:-translate-y-0.5"
                  style={{ background: LIME, color: LIME_D }}>Open dashboard <ArrowRight size={13} strokeWidth={2.4} /></Link>
              ) : (
                <>
                  <Link to="/sign-in" className="text-[13.5px] font-medium px-2.5 py-2 transition-colors hover:text-white" style={{ color: D_TXT2 }}>Sign in</Link>
                  <Link to="/sign-up" className="inline-flex items-center gap-1.5 text-[13px] font-bold rounded-full px-4 py-2 transition-transform hover:-translate-y-0.5"
                    style={{ background: LIME, color: LIME_D }}>Start free <ArrowRight size={13} strokeWidth={2.4} /></Link>
                </>
              )}
            </div>
            <button onClick={() => setOpen(true)} className="md:hidden h-9 w-9 grid place-items-center rounded-lg"
              style={{ color: D_TXT, border: `1px solid ${D_LINE2}` }} aria-label="Open menu"><Menu size={17} /></button>
          </div>
        </div>
      </nav>
      {open && (
        <div className="fixed inset-0 z-[60] md:hidden" style={{ background: PINE }}>
          <div className="flex items-center justify-between px-6 h-[64px]">
            <span className="font-bold text-[17px]" style={{ color: D_TXT }}>nordavix</span>
            <button onClick={() => setOpen(false)} className="h-9 w-9 grid place-items-center rounded-lg"
              style={{ background: PINE_2, color: D_TXT2 }} aria-label="Close menu"><X size={17} /></button>
          </div>
          <div className="px-6 py-2">
            {NAV.map((it) => it.anchor
              ? <a key={it.label} href={it.to} onClick={() => setOpen(false)} className="block py-3.5 text-base font-medium" style={{ color: D_TXT, borderBottom: `1px solid ${D_LINE}` }}>{it.label}</a>
              : <Link key={it.label} to={it.to} onClick={() => setOpen(false)} className="block py-3.5 text-base font-medium" style={{ color: D_TXT, borderBottom: `1px solid ${D_LINE}` }}>{it.label}</Link>)}
            <div className="pt-7 space-y-3">
              <Link to="/sign-up" onClick={() => setOpen(false)} className="flex items-center justify-center gap-2 w-full py-3.5 rounded-full text-sm font-bold" style={{ background: LIME, color: LIME_D }}>Start free <ArrowRight size={14} /></Link>
              <Link to="/sign-in" onClick={() => setOpen(false)} className="flex items-center justify-center w-full py-3 rounded-full text-sm font-medium" style={{ color: D_TXT2, border: `1px solid ${D_LINE2}` }}>Sign in</Link>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// ─── The AppShot — browser-framed product mockup (pure CSS/SVG) ──────────────
function StatusPill({ kind }: { kind: "ok" | "prep" | "open" }) {
  const map = {
    ok:   { t: "Approved", bg: "rgba(46,122,85,0.12)", fg: GREEN },
    prep: { t: "Prepared", bg: "rgba(60,90,118,0.12)", fg: "#3C5A76" },
    open: { t: "Open",     bg: "rgba(176,127,60,0.14)", fg: AMBER },
  }[kind]
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-[3px] text-[9.5px] font-bold uppercase tracking-wide whitespace-nowrap"
      style={{ background: map.bg, color: map.fg }}>
      <span className="h-1 w-1 rounded-full" style={{ background: map.fg }} />{map.t}
    </span>
  )
}
const SHOT_ROWS: { name: string; num: string; gl: string; sl: string; v: string; s: "ok" | "prep" | "open" }[] = [
  { name: "Operating cash",      num: "1100", gl: "2,847,392",  sl: "2,847,392",  v: "0.00", s: "ok" },
  { name: "Accounts receivable", num: "1200", gl: "1,204,118",  sl: "1,204,118",  v: "0.00", s: "ok" },
  { name: "Prepaid expenses",    num: "1400", gl: "33,000",     sl: "33,000",     v: "0.00", s: "prep" },
  { name: "Fixed assets",        num: "1600", gl: "486,200",    sl: "486,200",    v: "0.00", s: "ok" },
  { name: "Bank loan",           num: "2700", gl: "(100,000)",  sl: "(100,000)",  v: "0.00", s: "prep" },
  { name: "Accrued liabilities", num: "2300", gl: "(86,420)",   sl: "(82,100)",   v: "(4,320)", s: "open" },
]
function AppShot() {
  return (
    <div className="relative">
      {/* glow */}
      <div aria-hidden className="pointer-events-none absolute -inset-x-10 -top-16 -bottom-10"
        style={{ background: `radial-gradient(58% 56% at 50% 38%, rgba(212,243,97,0.13), transparent 70%), radial-gradient(40% 40% at 78% 70%, rgba(127,184,155,0.12), transparent 70%)` }} />
      {/* browser frame */}
      <div className="relative rounded-2xl overflow-hidden"
        style={{ border: `1px solid ${D_LINE2}`, background: "#0E2B23", boxShadow: "0 60px 140px -50px rgba(0,0,0,0.65), 0 24px 60px -30px rgba(0,0,0,0.5)" }}>
        <div className="flex items-center gap-3 px-4 py-2.5" style={{ borderBottom: `1px solid ${D_LINE}` }}>
          <div className="flex gap-1.5">{[0, 1, 2].map((i) => <span key={i} className="h-2.5 w-2.5 rounded-full" style={{ background: "rgba(244,241,233,0.16)" }} />)}</div>
          <div className="mx-auto flex items-center gap-1.5 rounded-md px-3 py-1 text-[10.5px]"
            style={{ fontFamily: MONO, background: "rgba(244,241,233,0.07)", color: D_TXT3 }}>
            <Lock size={9} strokeWidth={2.4} /> app.nordavix.com/reconciliations
          </div>
          <div className="w-12" />
        </div>
        {/* app body */}
        <div className="grid grid-cols-[44px_1fr] sm:grid-cols-[52px_1fr]" style={{ background: "#F1EEE5" }}>
          {/* mini sidebar */}
          <div className="flex flex-col items-center gap-1.5 py-3" style={{ background: PINE }}>
            {[BookCheck, GitCompareArrows, Layers, Receipt, TrendingUp, FileText].map((Ic, i) => (
              <span key={i} className="h-8 w-8 grid place-items-center rounded-lg"
                style={{ background: i === 1 ? "rgba(212,243,97,0.16)" : "transparent", color: i === 1 ? LIME : "rgba(244,241,233,0.4)" }}>
                <Ic size={14.5} strokeWidth={1.9} />
              </span>
            ))}
          </div>
          {/* main */}
          <div className="p-3.5 sm:p-5">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <div className="text-[13.5px] sm:text-[15px] font-bold" style={{ color: L_TXT }}>Reconciliations · March 2026</div>
                <div className="text-[10px] mt-0.5" style={{ fontFamily: MONO, color: L_TXT3 }}>SYNCED 2 MIN AGO · QUICKBOOKS ONLINE</div>
              </div>
              <span className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold"
                style={{ background: PINE, color: LIME }}><Sparkles size={11} strokeWidth={2.2} /> Run Agentic Mode</span>
            </div>
            {/* KPIs */}
            <div className="mt-3.5 grid grid-cols-2 lg:grid-cols-4 gap-2">
              {[["GL BALANCE", "$4,384,290", L_TXT], ["SUBLEDGER", "$4,388,610", L_TXT], ["VARIANCE", "$(4,320)", RED], ["APPROVED", "11 / 14", GREEN]].map(([k, v, c]) => (
                <div key={k as string} className="rounded-lg px-3 py-2.5" style={{ background: PAPER, border: `1px solid ${L_LINE}` }}>
                  <div className="text-[8.5px] tracking-[0.14em]" style={{ fontFamily: MONO, color: L_TXT3 }}>{k}</div>
                  <div className="text-[13px] sm:text-[15px] font-bold tabular-nums mt-0.5" style={{ color: c as string }}>{v}</div>
                </div>
              ))}
            </div>
            {/* table */}
            <div className="mt-3.5 rounded-lg overflow-hidden" style={{ background: PAPER, border: `1px solid ${L_LINE}` }}>
              <div className="grid grid-cols-[1.5fr_auto] md:grid-cols-[1.5fr_0.9fr_0.9fr_0.7fr_auto] gap-2 px-3.5 py-2 text-[8.5px] tracking-[0.14em]"
                style={{ fontFamily: MONO, color: L_TXT3, borderBottom: `1px solid ${L_LINE}` }}>
                <span>ACCOUNT</span><span className="hidden md:block text-right">GL</span>
                <span className="hidden md:block text-right">SUBLEDGER</span>
                <span className="hidden md:block text-right">VARIANCE</span><span className="text-right">STATUS</span>
              </div>
              {SHOT_ROWS.map((r) => (
                <div key={r.num} className="grid grid-cols-[1.5fr_auto] md:grid-cols-[1.5fr_0.9fr_0.9fr_0.7fr_auto] gap-2 items-center px-3.5 py-[7px] text-[11.5px]"
                  style={{ borderBottom: `1px solid ${L_LINE}` }}>
                  <span className="truncate font-medium" style={{ color: L_TXT }}>
                    {r.name} <span style={{ fontFamily: MONO, fontSize: 9.5, color: L_TXT3 }}>{r.num}</span>
                  </span>
                  <span className="hidden md:block text-right tabular-nums" style={{ color: L_TXT2 }}>{r.gl}</span>
                  <span className="hidden md:block text-right tabular-nums" style={{ color: L_TXT2 }}>{r.sl}</span>
                  <span className="hidden md:block text-right tabular-nums font-semibold" style={{ color: r.v === "0.00" ? GREEN : RED }}>{r.v}</span>
                  <span className="justify-self-end"><StatusPill kind={r.s} /></span>
                </div>
              ))}
              <div className="px-3.5 py-2 text-[10px]" style={{ fontFamily: MONO, color: L_TXT3 }}>14 ACCOUNTS · 1 OPEN · CLOSE GATE LOCKED UNTIL ZERO</div>
            </div>
          </div>
        </div>
      </div>

      {/* floating: subledger match card (the real feature) */}
      <div className="hidden lg:block absolute -right-8 top-16 w-[300px] rotate-[1.2deg]">
        <div className="rounded-xl overflow-hidden" style={{ background: PAPER, border: `1px solid ${L_LINE2}`, boxShadow: "0 36px 80px -30px rgba(0,0,0,0.55)" }}>
          <div className="px-4 py-2.5 text-[9px] tracking-[0.16em] flex items-center justify-between"
            style={{ fontFamily: MONO, color: L_TXT3, borderBottom: `1px solid ${L_LINE}` }}>
            <span>SUBLEDGER MATCH · 1400</span><GitCompareArrows size={11} style={{ color: GREEN }} />
          </div>
          <div className="grid grid-cols-2 text-[10.5px]">
            <div className="p-3" style={{ borderRight: `1px solid ${L_LINE}` }}>
              <div className="text-[8.5px] tracking-[0.14em] mb-1.5" style={{ fontFamily: MONO, color: GREEN }}>PER NORDAVIX</div>
              {[["Insurance 24-mo", "12,000"], ["Rent deposit", "8,000"], ["Software", "13,000"]].map(([a, b]) => (
                <div key={a} className="flex justify-between py-[3px]"><span style={{ color: L_TXT2 }}>{a}</span><span className="tabular-nums font-semibold" style={{ color: L_TXT }}>{b}</span></div>
              ))}
            </div>
            <div className="p-3">
              <div className="text-[8.5px] tracking-[0.14em] mb-1.5" style={{ fontFamily: MONO, color: "#3C5A76" }}>PER QUICKBOOKS</div>
              {[["JE 1042", "12,000"], ["JE 1043", "8,000"], ["JE 1051", "13,000"]].map(([a, b]) => (
                <div key={a} className="flex justify-between py-[3px]"><span style={{ color: L_TXT2 }}>{a}</span><span className="tabular-nums font-semibold" style={{ color: L_TXT }}>{b}</span></div>
              ))}
            </div>
          </div>
          <div className="px-4 py-2 flex items-center gap-1.5 text-[10.5px] font-bold"
            style={{ background: "rgba(46,122,85,0.10)", color: GREEN, borderTop: `1px solid ${L_LINE}` }}>
            <CheckCircle2 size={12} strokeWidth={2.4} /> Schedule ties to GL — $33,000
          </div>
        </div>
      </div>

      {/* floating: agentic chip */}
      <div className="hidden md:block absolute -left-6 -bottom-7 -rotate-[1.5deg]">
        <div className="flex items-center gap-3 rounded-xl px-4 py-3"
          style={{ background: LIME, color: LIME_D, boxShadow: "0 30px 70px -24px rgba(212,243,97,0.55)" }}>
          <Sparkles size={16} strokeWidth={2.2} />
          <div>
            <div className="text-[12px] font-extrabold leading-none">Agentic Mode</div>
            <div className="text-[10px] mt-1" style={{ fontFamily: MONO }}>12/14 PREPARED · YOU APPROVE</div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Hero ────────────────────────────────────────────────────────────────────
function Hero() {
  const { isSignedIn } = useUser()
  return (
    <header className="relative overflow-hidden" style={{ background: PINE }}>
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0" style={{
          backgroundImage: `linear-gradient(${D_LINE} 1px, transparent 1px), linear-gradient(90deg, ${D_LINE} 1px, transparent 1px)`,
          backgroundSize: "64px 64px", opacity: 0.5,
          maskImage: "radial-gradient(120% 70% at 50% 0%, black, transparent 78%)",
          WebkitMaskImage: "radial-gradient(120% 70% at 50% 0%, black, transparent 78%)",
        }} />
        <div className="absolute -top-40 left-1/2 -translate-x-1/2 h-[480px] w-[820px] rounded-full"
          style={{ background: "radial-gradient(closest-side, rgba(212,243,97,0.10), transparent)", filter: "blur(50px)" }} />
      </div>
      <div className="relative max-w-6xl mx-auto px-6 pt-16 md:pt-24 pb-16 md:pb-24">
        <div className="max-w-3xl mx-auto text-center">
          <Reveal>
            <div className="flex justify-center"><Kicker dark>The AI close platform for QuickBooks</Kicker></div>
          </Reveal>
          <Reveal delay={0.06}>
            <h1 className="mt-6 tracking-[-0.015em]"
              style={{ fontFamily: SERIF, fontWeight: 550, lineHeight: 1.02, fontSize: "clamp(2.7rem, 6.4vw, 5rem)", color: D_TXT }}>
              A Fortune&nbsp;500 close.
              <br />
              <em style={{ fontStyle: "italic", color: LIME }}>On QuickBooks.</em>
            </h1>
          </Reveal>
          <Reveal delay={0.12}>
            <p className="mt-6 mx-auto max-w-xl text-[15.5px] md:text-[17px] leading-relaxed" style={{ color: D_TXT2 }}>
              Nordavix reconciles every balance-sheet account, explains every variance,
              and drafts the adjusting entries — your team reviews and signs off.
              Controls a Big&nbsp;4 auditor would recognize, at QuickBooks scale.
            </p>
          </Reveal>
          <Reveal delay={0.18}>
            <div className="mt-9 flex flex-col sm:flex-row items-center justify-center gap-3">
              <LimeBtn to={isSignedIn ? "/app" : "/sign-up"}>{isSignedIn ? "Open dashboard" : "Start free in beta"} <ArrowRight size={15} strokeWidth={2.4} /></LimeBtn>
              <a href="#platform" className="inline-flex items-center justify-center gap-2 rounded-full px-6 py-3.5 text-sm font-semibold transition-colors"
                style={{ color: D_TXT, border: `1px solid ${D_LINE2}` }}>See the platform</a>
            </div>
          </Reveal>
          <Reveal delay={0.24}>
            <p className="mt-7 text-[10.5px] tracking-[0.16em]" style={{ fontFamily: MONO, color: D_TXT3 }}>
              READ-ONLY QUICKBOOKS CONNECTION · NO CARD · MAKER-CHECKER BUILT IN
            </p>
          </Reveal>
        </div>
        <Reveal delay={0.2} y={36} className="mt-14 md:mt-20">
          <AppShot />
        </Reveal>
      </div>
    </header>
  )
}

// ─── Metrics bar ─────────────────────────────────────────────────────────────
function MetricsBar() {
  const items = [["31", "balance-sheet account types"], ["5", "schedule engines"], ["2-step", "maker · checker control"], ["100%", "of actions audit-logged"]]
  return (
    <section style={{ background: PINE, borderTop: `1px solid ${D_LINE}` }}>
      <div className="max-w-6xl mx-auto px-6 py-10 grid grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-8">
        {items.map(([n, l], i) => (
          <Reveal key={l} delay={i * 0.05}>
            <div className="text-center lg:text-left">
              <div className="text-3xl md:text-4xl" style={{ fontFamily: SERIF, fontWeight: 550, color: LIME }}>{n}</div>
              <div className="mt-1.5 text-[10px] tracking-[0.18em] uppercase" style={{ fontFamily: MONO, color: D_TXT3 }}>{l}</div>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  )
}

// ─── Platform — three deep feature rows (cream) ──────────────────────────────
function WindowCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl overflow-hidden" style={{ background: PAPER, border: `1px solid ${L_LINE2}`, boxShadow: "0 40px 90px -40px rgba(12,38,32,0.35)" }}>
      <div className="flex items-center gap-2 px-4 py-2.5" style={{ borderBottom: `1px solid ${L_LINE}` }}>
        <div className="flex gap-1.5">{[0, 1, 2].map((i) => <span key={i} className="h-2 w-2 rounded-full" style={{ background: L_LINE2 }} />)}</div>
        <span className="ml-1 text-[9px] tracking-[0.16em]" style={{ fontFamily: MONO, color: L_TXT3 }}>{title}</span>
      </div>
      {children}
    </div>
  )
}
function ReconMock() {
  return (
    <WindowCard title="PREPAID INSURANCE · 1400 · MARCH 2026">
      <div className="grid grid-cols-2 text-[11px]">
        <div className="p-4" style={{ borderRight: `1px solid ${L_LINE}` }}>
          <div className="text-[8.5px] tracking-[0.16em] mb-2" style={{ fontFamily: MONO, color: GREEN }}>PER NORDAVIX SCHEDULE</div>
          {[["D&O insurance 24-mo", "12,000", true], ["Office rent deposit", "8,000", true], ["Software licence", "13,000", false]].map(([a, b, ok]) => (
            <div key={a as string} className="flex items-center justify-between py-1.5">
              <span className="flex items-center gap-1.5" style={{ color: L_TXT2 }}>
                {ok ? <CheckCircle2 size={11} strokeWidth={2.4} style={{ color: GREEN }} /> : <AlertTriangle size={11} strokeWidth={2.2} style={{ color: AMBER }} />}
                {a}
              </span>
              <span className="tabular-nums font-semibold" style={{ color: L_TXT }}>{b}</span>
            </div>
          ))}
          <div className="flex justify-between pt-2 mt-1 font-bold" style={{ borderTop: `1px solid ${L_LINE2}`, color: L_TXT }}>
            <span>Subledger</span><span className="tabular-nums">33,000</span>
          </div>
        </div>
        <div className="p-4">
          <div className="text-[8.5px] tracking-[0.16em] mb-2" style={{ fontFamily: MONO, color: "#3C5A76" }}>PER QUICKBOOKS GL</div>
          {[["Opening balance", "—"], ["JE 1042 · Insurance", "12,000"], ["JE 1043 · Rent", "8,000"]].map(([a, b]) => (
            <div key={a} className="flex items-center justify-between py-1.5">
              <span style={{ color: L_TXT2 }}>{a}</span>
              <span className="tabular-nums font-semibold" style={{ color: L_TXT }}>{b}</span>
            </div>
          ))}
          <div className="flex justify-between pt-2 mt-1 font-bold" style={{ borderTop: `1px solid ${L_LINE2}`, color: L_TXT }}>
            <span>GL balance</span><span className="tabular-nums">20,000</span>
          </div>
        </div>
      </div>
      <div className="px-4 py-2.5 text-[10.5px] flex items-center gap-2"
        style={{ background: "rgba(176,127,60,0.10)", color: "#7A5622", borderTop: `1px solid ${L_LINE}` }}>
        <AlertTriangle size={12} strokeWidth={2.2} />
        <span><b>Timing item:</b> Software licence $13,000 pending in QuickBooks — clears itself on re-sync.</span>
      </div>
    </WindowCard>
  )
}
function FluxMock() {
  return (
    <WindowCard title="FLUX ANALYSIS · 6400 MARKETING · MAR VS FEB">
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[13px] font-bold" style={{ color: L_TXT }}>Marketing &amp; Advertising</div>
            <div className="text-[10px] mt-0.5" style={{ fontFamily: MONO, color: L_TXT3 }}>CONFIDENCE: HIGH · 3 TXNS CITED</div>
          </div>
          <div className="text-right">
            <div className="text-[17px] font-bold tabular-nums" style={{ color: RED }}>+$14,200</div>
            <div className="text-[10px] tabular-nums" style={{ fontFamily: MONO, color: L_TXT3 }}>+38% MoM</div>
          </div>
        </div>
        <p className="mt-3 text-[12px] leading-relaxed" style={{ color: L_TXT2 }}>
          Spend rose <b style={{ color: L_TXT }}>$14,200</b> on three Q2 campaign launches. Each invoice
          matches its PO; nothing unposted above threshold. <b style={{ color: GREEN }}>Operational — not an error.</b>
        </p>
        <div className="mt-3 rounded-lg overflow-hidden" style={{ border: `1px solid ${L_LINE}` }}>
          {[["03/04", "Meta Platforms", "6,400"], ["03/11", "LinkedIn Ads", "4,300"], ["03/19", "Webflow Conf", "3,500"]].map(([d, v, amt]) => (
            <div key={v} className="flex items-center justify-between px-3 py-[7px] text-[11px]" style={{ borderBottom: `1px solid ${L_LINE}` }}>
              <span style={{ fontFamily: MONO, color: L_TXT3 }}>{d}</span>
              <span className="flex-1 px-3 truncate" style={{ color: L_TXT2 }}>{v}</span>
              <span className="tabular-nums font-semibold" style={{ color: L_TXT }}>{amt}</span>
            </div>
          ))}
          <div className="px-3 py-[7px] text-[9.5px]" style={{ fontFamily: MONO, color: L_TXT3 }}>EVIDENCE PULLED LIVE FROM THE GENERAL LEDGER</div>
        </div>
      </div>
    </WindowCard>
  )
}
function AdjustMock() {
  return (
    <WindowCard title="PROPOSED ADJUSTING ENTRY · AJE-2026-03-114">
      <div className="p-4">
        <div className="flex items-center justify-between">
          <div className="text-[13px] font-bold" style={{ color: L_TXT }}>Record March insurance amortization</div>
          <span className="inline-flex items-center gap-1 rounded-full px-2 py-[3px] text-[9.5px] font-bold"
            style={{ background: "rgba(46,122,85,0.12)", color: GREEN }}><CheckCircle2 size={10} strokeWidth={2.6} /> BALANCED</span>
        </div>
        <div className="mt-3 rounded-lg overflow-hidden text-[11.5px]" style={{ border: `1px solid ${L_LINE}` }}>
          <div className="grid grid-cols-[1fr_auto_auto] gap-4 px-3 py-1.5 text-[8.5px] tracking-[0.14em]"
            style={{ fontFamily: MONO, color: L_TXT3, borderBottom: `1px solid ${L_LINE}` }}>
            <span>ACCOUNT</span><span className="text-right w-16">DEBIT</span><span className="text-right w-16">CREDIT</span>
          </div>
          {[["6450 · Insurance expense", "2,000", ""], ["1400 · Prepaid expenses", "", "2,000"]].map(([a, d, c]) => (
            <div key={a} className="grid grid-cols-[1fr_auto_auto] gap-4 px-3 py-2" style={{ borderBottom: `1px solid ${L_LINE}` }}>
              <span style={{ color: L_TXT2 }}>{a}</span>
              <span className="text-right w-16 tabular-nums font-semibold" style={{ color: L_TXT }}>{d}</span>
              <span className="text-right w-16 tabular-nums font-semibold" style={{ color: L_TXT }}>{c}</span>
            </div>
          ))}
        </div>
        <div className="mt-3.5 flex items-center gap-2">
          <span className="rounded-full px-4 py-2 text-[11.5px] font-bold" style={{ background: PINE, color: LIME }}>Approve</span>
          <span className="rounded-full px-4 py-2 text-[11.5px] font-semibold" style={{ color: L_TXT2, border: `1px solid ${L_LINE2}` }}>Export for QBO</span>
          <span className="ml-auto text-[9px] tracking-[0.12em]" style={{ fontFamily: MONO, color: L_TXT3 }}>BATCH: 6 ENTRIES</span>
        </div>
      </div>
    </WindowCard>
  )
}
const PLATFORM_ROWS = [
  {
    kicker: "Reconciliations",
    title: <>Every account, tied out to <em style={{ fontStyle: "italic" }}>its own evidence</em>.</>,
    body: "Each balance-sheet account reconciles against an independent subledger — bank statements, AR/AP aging, or a Nordavix schedule. Side-by-side Nordavix-vs-QuickBooks matching shows exactly what's posted, what's pending, and what needs an entry.",
    bullets: ["Schedule-backed subledgers auto-pull their balance", "Timing items surface — and clear themselves on re-sync", "Variance gate: nothing gets approved out of balance", "One-click Agentic Mode prepares the whole set"],
    mock: <ReconMock />,
  },
  {
    kicker: "Flux analysis",
    title: <>Variances explained with <em style={{ fontStyle: "italic" }}>receipts</em>, not vibes.</>,
    body: "Period-over-period movement across the P&L and balance sheet, narrated by AI that cites the actual transactions driving each number — with a confidence score and a sign-off workflow on every line.",
    bullets: ["Commentary grounded in real GL transactions", "Confidence scoring on every explanation", "Open → Prepared → Approved review flow", "Bulk Agentic Mode across the whole variance table"],
    mock: <FluxMock />,
  },
  {
    kicker: "Adjustments",
    title: <>From “found it” to <em style={{ fontStyle: "italic" }}>posted</em> in one motion.</>,
    body: "When AI explains a difference, it also drafts the balanced journal entry that fixes it — mapped to your real chart of accounts. Review, approve, export for QuickBooks. Nordavix never writes to your books; your human posts the entry.",
    bullets: ["Balanced server-side — an unbalanced JE can't exist", "Batch approval queue with QBO-ready CSV export", "Posting check: marks entries once they appear in the GL", "Every accept / dismiss / post is audit-logged"],
    mock: <AdjustMock />,
  },
]
function Platform() {
  return (
    <section id="platform" style={{ background: CREAM }}>
      <div className="max-w-6xl mx-auto px-6 py-24 md:py-32">
        <Reveal className="max-w-2xl">
          <Kicker>The platform</Kicker>
          <Display className="mt-5" size="clamp(2.1rem, 4.6vw, 3.6rem)">
            Everything between <em style={{ fontStyle: "italic" }}>“the books are a mess”</em> and “the books are closed.”
          </Display>
        </Reveal>
        <div className="mt-16 md:mt-20 space-y-20 md:space-y-28">
          {PLATFORM_ROWS.map((row, i) => (
            <div key={row.kicker} className={`grid lg:grid-cols-2 gap-10 lg:gap-16 items-center`}>
              <Reveal className={i % 2 === 1 ? "lg:order-2" : ""}>
                <Kicker>{row.kicker}</Kicker>
                <Display className="mt-4" size="clamp(1.7rem, 3vw, 2.4rem)">{row.title}</Display>
                <p className="mt-4 text-[15px] leading-relaxed" style={{ color: L_TXT2 }}>{row.body}</p>
                <ul className="mt-6 space-y-2.5">
                  {row.bullets.map((b) => (
                    <li key={b} className="flex items-start gap-2.5 text-[13.5px]" style={{ color: L_TXT2 }}>
                      <CheckCircle2 size={15} strokeWidth={2.2} className="mt-0.5 shrink-0" style={{ color: GREEN }} /> {b}
                    </li>
                  ))}
                </ul>
              </Reveal>
              <Reveal delay={0.08} y={30} className={i % 2 === 1 ? "lg:order-1" : ""}>{row.mock}</Reveal>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

// ─── Bento — the rest of the close ───────────────────────────────────────────
function Ring() {
  const r = 26, c = 2 * Math.PI * r
  return (
    <svg viewBox="0 0 64 64" className="h-16 w-16">
      <circle cx="32" cy="32" r={r} fill="none" stroke={L_LINE2} strokeWidth="6" />
      <circle cx="32" cy="32" r={r} fill="none" stroke={GREEN} strokeWidth="6" strokeLinecap="round"
        strokeDasharray={`${c * 0.86} ${c}`} transform="rotate(-90 32 32)" />
      <text x="32" y="36" textAnchor="middle" fontSize="13" fontWeight="800" fill={L_TXT}>86%</text>
    </svg>
  )
}
function Spark() {
  return (
    <svg viewBox="0 0 180 56" className="w-full h-12">
      <polyline points="4,14 28,18 52,24 76,28 100,35 124,40 148,46 176,50" fill="none" stroke={GREEN} strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="176" cy="50" r="3" fill={AMBER} />
    </svg>
  )
}
function Bento() {
  return (
    <section style={{ background: CREAM }}>
      <div className="max-w-6xl mx-auto px-6 pb-24 md:pb-32">
        <Reveal className="max-w-2xl mb-12">
          <Kicker>And the rest of the close</Kicker>
          <Display className="mt-4">One subscription. The whole month-end.</Display>
        </Reveal>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {/* Schedules */}
          <Reveal>
            <div className="h-full rounded-2xl p-6" style={{ background: PAPER, border: `1px solid ${L_LINE}` }}>
              <Layers size={18} strokeWidth={1.9} style={{ color: GREEN }} />
              <h3 className="mt-3 text-[16px] font-bold" style={{ color: L_TXT }}>Schedules</h3>
              <p className="mt-1 text-[12.5px] leading-relaxed" style={{ color: L_TXT2 }}>Prepaids, accruals, fixed assets, leases, loans — computed monthly, flowed into the right recon.</p>
              <div className="mt-4 space-y-2">
                {[["PREPAIDS", 64], ["FA DEPRECIATION", 41], ["LOAN PRINCIPAL", 78]].map(([l, w]) => (
                  <div key={l as string}>
                    <div className="flex justify-between text-[8.5px] tracking-[0.14em]" style={{ fontFamily: MONO, color: L_TXT3 }}><span>{l}</span><span>{w as number}%</span></div>
                    <div className="mt-1 h-1.5 rounded-full" style={{ background: L_LINE }}><div className="h-full rounded-full" style={{ width: `${w}%`, background: GREEN }} /></div>
                  </div>
                ))}
              </div>
            </div>
          </Reveal>
          {/* Financial package */}
          <Reveal delay={0.05}>
            <div className="h-full rounded-2xl p-6" style={{ background: PAPER, border: `1px solid ${L_LINE}` }}>
              <FileText size={18} strokeWidth={1.9} style={{ color: GREEN }} />
              <h3 className="mt-3 text-[16px] font-bold" style={{ color: L_TXT }}>Financial package</h3>
              <p className="mt-1 text-[12.5px] leading-relaxed" style={{ color: L_TXT2 }}>IS / BS / CF on screen and as a monochrome PDF — plus an AI-narrated executive report.</p>
              <div className="mt-4 flex items-center gap-2">
                {["IS", "BS", "CF", "EXEC"].map((d) => (
                  <span key={d} className="rounded-md px-2.5 py-1.5 text-[9.5px] font-bold" style={{ fontFamily: MONO, background: "rgba(12,38,32,0.06)", color: L_TXT2, border: `1px solid ${L_LINE}` }}>{d}.PDF</span>
                ))}
              </div>
            </div>
          </Reveal>
          {/* Insights */}
          <Reveal delay={0.1}>
            <div className="h-full rounded-2xl p-6" style={{ background: PAPER, border: `1px solid ${L_LINE}` }}>
              <TrendingUp size={18} strokeWidth={1.9} style={{ color: GREEN }} />
              <h3 className="mt-3 text-[16px] font-bold" style={{ color: L_TXT }}>Insights</h3>
              <p className="mt-1 text-[12.5px] leading-relaxed" style={{ color: L_TXT2 }}>Runway, burn, break-even, liquidity — refreshed from the same synced ledger.</p>
              <div className="mt-3"><Spark /></div>
              <div className="text-[9px] tracking-[0.14em]" style={{ fontFamily: MONO, color: L_TXT3 }}>RUNWAY 14 MO · BURN $89K/MO</div>
            </div>
          </Reveal>
          {/* Intercompany */}
          <Reveal delay={0.05}>
            <div className="h-full rounded-2xl p-6" style={{ background: PAPER, border: `1px solid ${L_LINE}` }}>
              <Scale size={18} strokeWidth={1.9} style={{ color: GREEN }} />
              <h3 className="mt-3 text-[16px] font-bold" style={{ color: L_TXT }}>Intercompany</h3>
              <p className="mt-1 text-[12.5px] leading-relaxed" style={{ color: L_TXT2 }}>Auto-paired IC accounts, eliminations, and a consolidated trial balance across entities.</p>
              <div className="mt-4 space-y-1.5 text-[11px]">
                {[["Due from Sub A ⇄ Due to Parent", "120,000"], ["IC loan ⇄ IC borrowing", "300,000"]].map(([a, b]) => (
                  <div key={a} className="flex justify-between rounded-md px-2.5 py-2" style={{ background: "rgba(12,38,32,0.04)" }}>
                    <span className="truncate pr-2" style={{ color: L_TXT2 }}>{a}</span><span className="tabular-nums font-semibold shrink-0" style={{ color: GREEN }}>{b} ✓</span>
                  </div>
                ))}
              </div>
            </div>
          </Reveal>
          {/* Close tracker */}
          <Reveal delay={0.1}>
            <div className="h-full rounded-2xl p-6 flex items-start gap-4" style={{ background: PAPER, border: `1px solid ${L_LINE}` }}>
              <div className="flex-1">
                <BookCheck size={18} strokeWidth={1.9} style={{ color: GREEN }} />
                <h3 className="mt-3 text-[16px] font-bold" style={{ color: L_TXT }}>Close tracker</h3>
                <p className="mt-1 text-[12.5px] leading-relaxed" style={{ color: L_TXT2 }}>Sequential period locks — March can't close before February. Reopen is role-gated.</p>
              </div>
              <div className="shrink-0 mt-2"><Ring /></div>
            </div>
          </Reveal>
          {/* Audit log */}
          <Reveal delay={0.15}>
            <div className="h-full rounded-2xl p-6" style={{ background: PINE, border: `1px solid ${L_LINE}` }}>
              <ScrollText size={18} strokeWidth={1.9} style={{ color: LIME }} />
              <h3 className="mt-3 text-[16px] font-bold" style={{ color: D_TXT }}>Audit log</h3>
              <p className="mt-1 text-[12.5px] leading-relaxed" style={{ color: D_TXT2 }}>Every action, attributed and timestamped.</p>
              <div className="mt-4 space-y-1.5 text-[9.5px]" style={{ fontFamily: MONO, color: D_TXT3 }}>
                <div>09:14 <span style={{ color: SAGE }}>recon.approve</span> · 1100 · s.chen</div>
                <div>09:12 <span style={{ color: SAGE }}>adjustment.post</span> · AJE-114 · m.ruiz</div>
                <div>09:02 <span style={{ color: SAGE }}>period.lock</span> · FEB-2026 · admin</div>
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  )
}

// ─── AI band ─────────────────────────────────────────────────────────────────
function AIBand() {
  const principles = [
    { Icon: UserCheck, t: "Suggest-only, always", d: "AI prepares, explains, and drafts. It cannot approve, post, or close anything — those clicks are human, by design." },
    { Icon: ScrollText, t: "Shows its work", d: "Every explanation cites the actual ledger transactions behind it, with a confidence score you can challenge." },
    { Icon: Lock, t: "Read-only on your books", d: "The QuickBooks connection is read-only OAuth. Nordavix physically cannot write to your GL." },
  ]
  return (
    <section className="relative overflow-hidden" style={{ background: PINE }}>
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute -top-32 right-[-10%] h-[400px] w-[560px] rounded-full" style={{ background: "radial-gradient(closest-side, rgba(212,243,97,0.10), transparent)", filter: "blur(56px)" }} />
      </div>
      <div className="relative max-w-6xl mx-auto px-6 py-24 md:py-32">
        <div className="grid lg:grid-cols-[1.05fr_0.95fr] gap-12 lg:gap-16 items-center">
          <div>
            <Reveal><Kicker dark>The AI stance</Kicker></Reveal>
            <Reveal delay={0.05}>
              <Display dark className="mt-5" size="clamp(2.1rem, 4.4vw, 3.4rem)">
                AI with <em style={{ fontStyle: "italic", color: LIME }}>audit-grade</em> manners.
              </Display>
            </Reveal>
            <Reveal delay={0.1}>
              <p className="mt-5 max-w-lg text-[15px] leading-relaxed" style={{ color: D_TXT2 }}>
                Most AI accounting tools ask you to trust a black box. Nordavix is built the way
                an auditor thinks: every number traced, every claim evidenced, every action attributed.
              </p>
            </Reveal>
            <div className="mt-9 space-y-6">
              {principles.map(({ Icon, t, d }, i) => (
                <Reveal key={t} delay={0.12 + i * 0.06}>
                  <div className="flex items-start gap-4">
                    <span className="shrink-0 h-10 w-10 rounded-xl grid place-items-center" style={{ background: "rgba(212,243,97,0.12)", color: LIME }}><Icon size={17} strokeWidth={2} /></span>
                    <div>
                      <div className="text-[15px] font-bold" style={{ color: D_TXT }}>{t}</div>
                      <p className="mt-1 text-[13.5px] leading-relaxed" style={{ color: D_TXT2 }}>{d}</p>
                    </div>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
          <Reveal delay={0.1} y={30}>
            {/* evidence terminal */}
            <div className="rounded-2xl overflow-hidden" style={{ background: PINE_2, border: `1px solid ${D_LINE2}`, boxShadow: "0 50px 110px -40px rgba(0,0,0,0.6)" }}>
              <div className="flex items-center justify-between px-4 py-2.5" style={{ borderBottom: `1px solid ${D_LINE}` }}>
                <span className="text-[9px] tracking-[0.18em]" style={{ fontFamily: MONO, color: D_TXT3 }}>AGENTIC RUN · MARCH 2026</span>
                <span className="inline-flex items-center gap-1.5 text-[9px] font-bold tracking-[0.14em]" style={{ fontFamily: MONO, color: LIME }}><Sparkles size={10} /> LIVE</span>
              </div>
              <div className="p-5 space-y-2.5 text-[11px] leading-relaxed" style={{ fontFamily: MONO }}>
                {[
                  ["→ pull", "trial balance + GL · 14 accounts", D_TXT2],
                  ["→ tie", "1100 operating cash ⇄ bank stmt", D_TXT2],
                  ["  ok", "variance $0.00 · 2 timing items cleared", SAGE],
                  ["→ tie", "1400 prepaids ⇄ amortization schedule", D_TXT2],
                  ["  ok", "schedule ties to GL · $33,000", SAGE],
                  ["→ flux", "6400 marketing +38% · citing 3 txns", D_TXT2],
                  ["→ draft", "AJE-114 · Dr 6450 / Cr 1400 · $2,000", D_TXT2],
                  ["  halt", "awaiting human approval — 14 items ready", LIME],
                ].map(([a, b, c], i) => (
                  <div key={i} className="flex gap-3">
                    <span className="w-14 shrink-0" style={{ color: c as string }}>{a}</span>
                    <span style={{ color: c as string }}>{b}</span>
                  </div>
                ))}
              </div>
              <div className="px-5 py-3 text-[10px] tracking-[0.14em]" style={{ fontFamily: MONO, color: D_TXT3, borderTop: `1px solid ${D_LINE}` }}>
                0 WRITES TO QUICKBOOKS · 22 ACTIONS LOGGED · 1 HUMAN REQUIRED
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  )
}

// ─── Workflow ribbon ─────────────────────────────────────────────────────────
const STEPS = [
  { n: "01", Icon: Plug, t: "Sync", d: "Read-only QuickBooks pull — TB, GL, aging." },
  { n: "02", Icon: GitCompareArrows, t: "Reconcile", d: "Every account vs its independent subledger." },
  { n: "03", Icon: Sparkles, t: "Explain", d: "AI narrates variances with cited evidence." },
  { n: "04", Icon: Receipt, t: "Adjust", d: "Balanced JEs drafted, approved, exported." },
  { n: "05", Icon: UserCheck, t: "Review", d: "Maker-checker sign-off on every account." },
  { n: "06", Icon: Lock, t: "Lock", d: "Sequential close — then the package ships." },
]
function Workflow() {
  return (
    <section id="workflow" style={{ background: PINE, borderTop: `1px solid ${D_LINE}` }}>
      <div className="max-w-6xl mx-auto px-6 py-24 md:py-28">
        <Reveal className="max-w-2xl mb-14">
          <Kicker dark>The workflow</Kicker>
          <Display dark className="mt-4">Six steps. The same six, every month.</Display>
        </Reveal>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-x-6 gap-y-10">
          {STEPS.map(({ n, Icon, t, d }, i) => (
            <Reveal key={n} delay={i * 0.05}>
              <div className="pt-5" style={{ borderTop: `2px solid ${i === 0 ? LIME : D_LINE2}` }}>
                <div className="text-[10px] tracking-[0.2em]" style={{ fontFamily: MONO, color: i === 0 ? LIME : D_TXT3 }}>{n}</div>
                <Icon size={18} strokeWidth={1.9} className="mt-3" style={{ color: SAGE }} />
                <div className="mt-2.5 text-[15px] font-bold" style={{ color: D_TXT }}>{t}</div>
                <p className="mt-1 text-[12px] leading-relaxed" style={{ color: D_TXT2 }}>{d}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}

// ─── Security ────────────────────────────────────────────────────────────────
function Security() {
  const items = [
    { Icon: Plug, t: "Read-only OAuth", d: "The QuickBooks scope can read reports — never write, never post, never delete." },
    { Icon: Landmark, t: "Hard tenant isolation", d: "Every row is tenant-tagged and filtered at the ORM session layer. Cross-tenant reads are physically blocked." },
    { Icon: UserCheck, t: "Maker-checker, server-side", d: "Whoever enters a number can't approve it. Enforced in the API, not just hidden in the UI." },
    { Icon: ScrollText, t: "Total audit trail", d: "Sync, tick, approve, adjust, lock — every action attributed, timestamped, and replayable." },
  ]
  return (
    <section id="security" style={{ background: CREAM }}>
      <div className="max-w-6xl mx-auto px-6 py-24 md:py-28">
        <Reveal className="flex flex-wrap items-end justify-between gap-6 mb-12">
          <div className="max-w-xl">
            <Kicker>Security &amp; control</Kicker>
            <Display className="mt-4">Built like the auditors are already here.</Display>
          </div>
          <Link to="/security" className="inline-flex items-center gap-1.5 text-[13px] font-bold rounded-full px-5 py-2.5"
            style={{ color: L_TXT, border: `1px solid ${L_LINE2}` }}>Security details <ChevronRight size={14} /></Link>
        </Reveal>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {items.map(({ Icon, t, d }, i) => (
            <Reveal key={t} delay={i * 0.05}>
              <div className="h-full rounded-2xl p-6" style={{ background: PAPER, border: `1px solid ${L_LINE}` }}>
                <span className="inline-grid h-10 w-10 place-items-center rounded-xl" style={{ background: "rgba(46,122,85,0.10)", color: GREEN }}><Icon size={17} strokeWidth={2} /></span>
                <h3 className="mt-4 text-[15px] font-bold" style={{ color: L_TXT }}>{t}</h3>
                <p className="mt-1.5 text-[12.5px] leading-relaxed" style={{ color: L_TXT2 }}>{d}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}

// ─── Founder letter ──────────────────────────────────────────────────────────
function FounderLetter() {
  return (
    <section style={{ background: CREAM }}>
      <div className="max-w-3xl mx-auto px-6 pb-24 md:pb-32">
        <Reveal>
          <div className="rounded-3xl p-9 md:p-14" style={{ background: PAPER, border: `1px solid ${L_LINE}`, boxShadow: "0 30px 80px -50px rgba(12,38,32,0.3)" }}>
            <div className="text-[10px] tracking-[0.2em]" style={{ fontFamily: MONO, color: L_TXT3 }}>A NOTE FROM THE FOUNDER</div>
            <p className="mt-6 text-[19px] md:text-[23px] leading-[1.5]" style={{ fontFamily: SERIF, fontWeight: 460, color: L_TXT }}>
              I'm a CPA. I've lived the 11&nbsp;pm tie-outs, the variance emails, the audit
              scramble. Big companies survive month-end because they have controls and
              headcount. Small teams just have the headcount problem.
              <em style={{ fontStyle: "italic" }}> Nordavix is the controls, with the grind handled by AI</em> —
              and the judgment kept exactly where it belongs: with you.
            </p>
            <div className="mt-8 flex items-center gap-3">
              <span className="h-9 w-9 rounded-full grid place-items-center text-[13px] font-extrabold" style={{ background: PINE, color: LIME, fontFamily: MONO }}>n</span>
              <div>
                <div className="text-[13px] font-bold" style={{ color: L_TXT }}>The founding CPA</div>
                <div className="text-[11px]" style={{ color: L_TXT3 }}>Nordavix</div>
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  )
}

// ─── Beta ────────────────────────────────────────────────────────────────────
function Beta() {
  return (
    <section id="beta" style={{ background: PINE }}>
      <div className="max-w-6xl mx-auto px-6 py-24 md:py-28">
        <div className="rounded-3xl overflow-hidden grid lg:grid-cols-2" style={{ border: `1px solid ${D_LINE2}` }}>
          <div className="p-9 md:p-14" style={{ background: PINE_2 }}>
            <Reveal>
              <Kicker dark>Founding firms program</Kicker>
              <Display dark className="mt-5" size="clamp(1.9rem, 3.6vw, 2.9rem)">
                Free in beta. <em style={{ fontStyle: "italic", color: LIME }}>Priced like software,</em> never like headcount.
              </Display>
              <p className="mt-5 text-[14.5px] leading-relaxed max-w-md" style={{ color: D_TXT2 }}>
                We're onboarding a limited set of design-partner firms. Full platform,
                no credit card, and a direct line to the founding team while we shape v1 together.
              </p>
              <div className="mt-8"><LimeBtn to="/sign-up">Request access <ArrowRight size={15} strokeWidth={2.4} /></LimeBtn></div>
            </Reveal>
          </div>
          <div className="p-9 md:p-14" style={{ background: PINE_3 }}>
            <Reveal delay={0.08}>
              <div className="text-[10px] tracking-[0.2em] mb-6" style={{ fontFamily: MONO, color: D_TXT3 }}>WHAT FOUNDING FIRMS GET</div>
              <ul className="space-y-4">
                {["Every module — recons, flux, schedules, adjustments, reporting", "Unlimited companies and team seats during beta", "White-glove onboarding of your chart of accounts", "Roadmap influence — your close shapes the product", "Founding pricing locked when plans launch"].map((b) => (
                  <li key={b} className="flex items-start gap-3 text-[14px]" style={{ color: D_TXT }}>
                    <CheckCircle2 size={16} strokeWidth={2.2} className="mt-0.5 shrink-0" style={{ color: LIME }} /> {b}
                  </li>
                ))}
              </ul>
            </Reveal>
          </div>
        </div>
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
    <section id="faq" style={{ background: CREAM }}>
      <div className="max-w-3xl mx-auto px-6 py-24 md:py-28">
        <Reveal className="mb-12">
          <Kicker>FAQ</Kicker>
          <Display className="mt-4">The questions controllers ask.</Display>
        </Reveal>
        <div style={{ borderTop: `1px solid ${L_LINE2}` }}>
          {FAQ_QUESTIONS.map((item, idx) => {
            const isOpen = openIdx === idx
            return (
              <div key={item.q} style={{ borderBottom: `1px solid ${L_LINE2}` }}>
                <button onClick={() => setOpenIdx(isOpen ? null : idx)} aria-expanded={isOpen}
                  className="w-full flex items-center justify-between gap-5 text-left py-5">
                  <span className="text-[15.5px] font-semibold" style={{ color: L_TXT }}>{item.q}</span>
                  <span className="shrink-0 h-7 w-7 rounded-full grid place-items-center"
                    style={{ background: isOpen ? PINE : "transparent", color: isOpen ? LIME : L_TXT3, border: `1px solid ${isOpen ? PINE : L_LINE2}` }}>
                    {isOpen ? <Minus size={14} strokeWidth={2.4} /> : <Plus size={14} strokeWidth={2.4} />}
                  </span>
                </button>
                <AnimatePresence initial={false}>
                  {isOpen && (
                    <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.28, ease: EASE }} className="overflow-hidden">
                      <p className="pb-6 pr-12 text-[14px] leading-relaxed" style={{ color: L_TXT2 }}>{item.a}</p>
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

// ─── Final CTA ───────────────────────────────────────────────────────────────
function FinalCTA() {
  const { isSignedIn } = useUser()
  return (
    <section className="relative overflow-hidden" style={{ background: PINE }}>
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0" style={{
          backgroundImage: `linear-gradient(${D_LINE} 1px, transparent 1px), linear-gradient(90deg, ${D_LINE} 1px, transparent 1px)`,
          backgroundSize: "64px 64px", opacity: 0.45,
          maskImage: "radial-gradient(100% 80% at 50% 100%, black, transparent 75%)",
          WebkitMaskImage: "radial-gradient(100% 80% at 50% 100%, black, transparent 75%)",
        }} />
        <div className="absolute -bottom-44 left-1/2 -translate-x-1/2 h-[420px] w-[760px] rounded-full"
          style={{ background: "radial-gradient(closest-side, rgba(212,243,97,0.12), transparent)", filter: "blur(56px)" }} />
      </div>
      <div className="relative max-w-4xl mx-auto px-6 py-28 md:py-36 text-center">
        <Reveal>
          <Display dark size="clamp(2.4rem, 5.6vw, 4.2rem)">
            Close like the company<br />you're <em style={{ fontStyle: "italic", color: LIME }}>about to become</em>.
          </Display>
        </Reveal>
        <Reveal delay={0.08}>
          <p className="mt-6 mx-auto max-w-md text-[15px] leading-relaxed" style={{ color: D_TXT2 }}>
            Connect QuickBooks in two minutes. Run your first agentic reconciliation in five.
          </p>
        </Reveal>
        <Reveal delay={0.14}>
          <div className="mt-9 flex flex-col sm:flex-row items-center justify-center gap-3">
            <LimeBtn to={isSignedIn ? "/app" : "/sign-up"}>{isSignedIn ? "Open dashboard" : "Start free in beta"} <ArrowRight size={15} strokeWidth={2.4} /></LimeBtn>
            <Link to="/solutions" className="inline-flex items-center justify-center gap-1.5 rounded-full px-6 py-3.5 text-sm font-semibold"
              style={{ color: D_TXT, border: `1px solid ${D_LINE2}` }}>Explore solutions <ChevronRight size={15} /></Link>
          </div>
        </Reveal>
        <Reveal delay={0.2}>
          <p className="mt-8 text-[10.5px] tracking-[0.16em] inline-flex items-center gap-2" style={{ fontFamily: MONO, color: D_TXT3 }}>
            <ShieldCheck size={12} /> READ-ONLY QBO · MAKER-CHECKER · FULL AUDIT TRAIL
            <RefreshCw size={12} className="hidden sm:block" /> <span className="hidden sm:inline">SYNC ANYTIME</span>
          </p>
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
    // The landing page paints its own fixed palette; force the shared
    // theme-token components (MarketingFooter) to render light so the page
    // reads identically for every visitor, then restore the user's theme.
    const html = document.documentElement
    const had = html.classList.contains("dark")
    html.classList.remove("dark")
    return () => { if (had) html.classList.add("dark") }
  }, [])
  return (
    <div className="min-h-screen" style={{ background: PINE, color: D_TXT, scrollBehavior: "smooth" }}>
      <SEO
        title="Nordavix — AI month-end close software for CPAs and controllers"
        description="Close your books in days, not weeks. AI-prepared reconciliations, flux analysis, cash-runway and break-even insights, intercompany consolidation, and an executive financial package — all on top of QuickBooks Online."
        path="/" bareTitle jsonLd={[faqSchemaObj, crumbs]} />
      <Navbar />
      <Hero />
      <MetricsBar />
      <Platform />
      <Bento />
      <AIBand />
      <Workflow />
      <Security />
      <FounderLetter />
      <Beta />
      <FAQ />
      <FinalCTA />
      <MarketingFooter />
    </div>
  )
}
