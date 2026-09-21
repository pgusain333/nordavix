/**
 * HomePage — the Nordavix marketing landing page.
 *
 * Art direction: "finance editorial" — the confident big-SaaS look (Ramp /
 * Mercury / Linear lineage), deliberately NOT the generic AI-gradient site.
 *   · Deep pine ink (#0C2620) as the dominant dark, a pine-neutral ground
 *     (#F4F7F5) for the product sections — a two-world rhythm: dark statement
 *     bands, light "show the work" bands. Cream survives as the TEXT on the
 *     dark bands, which is the job it was always best at.
 *   · ONE loud accent: electric lime (#D4F361). Everything else is quiet.
 *   · Type system: Fraunces (editorial serif) for display headlines,
 *     Plus Jakarta Sans for body, JetBrains Mono for eyebrows / metrics /
 *     figures — the mono-label discipline big SaaS sites use.
 *   · The hero centerpiece is a browser-framed product shot built in pure
 *     CSS/SVG (no images): the recon dashboard with the Nordavix-vs-
 *     QuickBooks subledger match card floating beside it.
 *
 * Sections: Topbar → Navbar → Hero (+AppShot) → MetricsBar → Platform
 * (3 deep feature rows) → Bento ("the rest of the close") → NDVX Copilot
 * showcase (a scripted conversation on a loop) → AI band →
 * Workflow ribbon → Security → Founder letter → Beta → FAQ → Final CTA →
 * shared MarketingFooter.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { useUser } from "@clerk/clerk-react"
import { motion, AnimatePresence, useInView, useReducedMotion } from "framer-motion"
import { MarketingFooter } from "@/marketing/MarketingFooter"
import { CopilotMark } from "@/modules/assistant/CopilotMark"
import { SEO, faqSchema, breadcrumbSchema } from "@/marketing/seo/SEO"
import {
  Sparkles, ArrowRight, CheckCircle2, Menu, X, ShieldCheck, Lock,
  ScrollText, UserCheck, Plug, Layers, TrendingUp, Scale, FileText,
  GitCompareArrows, Plus, Minus, ChevronRight, AlertTriangle, Landmark,
  RefreshCw, Receipt, BookCheck, ArrowUp, Check,
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
const LIME    = "#9CC4AD"   // THE accent — soft sage (electric lime retired: too loud for a finance brand)
const SAGE    = "#7FB89B"   // quiet support on dark
// Cream did two jobs here and only one of them moved. As TEXT on pine (D_TXT
// above, and the rail in the app) it is warm paper on dark ink and still the
// best thing on the page. As the light section GROUND it was #F4F1E9, which
// left the marketing site warm while the app went pine-neutral. Only the
// ground and the ink on it change; every dark band is untouched.
const CREAM   = "#F4F7F5"   // light section base — pine neutral, matches the app
const PAPER   = "#FFFFFF"   // cards on the light ground
const L_LINE  = "rgba(12,38,32,0.10)"     // hairline on light
const L_LINE2 = "rgba(12,38,32,0.16)"
const L_TXT   = "#0E1613"   // text on light — pine
const L_TXT2  = "#40514A"
const L_TXT3  = "#6E7F77"
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
      style={{ background: D_TXT, color: PINE, boxShadow: "0 16px 40px -16px rgba(0,0,0,0.55)" }}>
      {children}
    </Link>
  )
}

// ─── Topbar + Navbar ─────────────────────────────────────────────────────────
const NAV = [
  { label: "Platform", to: "#platform", anchor: true },
  { label: "Workflow", to: "#workflow", anchor: true },
  { label: "Security", to: "/security", anchor: false },
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
      {/* announcement microbar — near-black pine, quiet mono; the only color is
          the soft-sage link. (The electric-lime bar was the loudest element on
          the site — retired for the calm, premium read.) */}
      <div className="relative z-50 text-center px-4 py-2 text-[11px] tracking-[0.08em]"
        style={{ fontFamily: MONO, background: "#081914", color: "rgba(244,241,233,0.72)" }}>
        PRIVATE BETA IS OPEN — FOUNDING FIRMS GET THE FULL PLATFORM FREE{" "}
        <Link to="/sign-up" className="font-bold underline underline-offset-2" style={{ color: LIME }}>CLAIM A SPOT →</Link>
      </div>
      <nav className="sticky top-0 inset-x-0 z-50 transition-all duration-300"
        style={{
          background: scrolled ? "rgba(12,38,32,0.86)" : "transparent",
          backdropFilter: scrolled ? "saturate(150%) blur(14px)" : "none",
          WebkitBackdropFilter: scrolled ? "saturate(150%) blur(14px)" : "none",
          borderBottom: `1px solid ${scrolled ? D_LINE : "transparent"}`,
        }}>
        <div className="max-w-6xl mx-auto px-6 h-[64px] flex items-center justify-between gap-4">
          <Link to="/" className="flex items-center gap-2.5 shrink-0 group">
            {/* Real brand mark — white variant for the pine navbar (same asset
                the app's LeftNav rail uses). */}
            <img src="/logo-mark-white.svg" alt="Nordavix" className="h-7 w-7 transition-transform group-hover:scale-105" />
            <span className="font-bold text-[17px] tracking-tight" style={{ color: D_TXT }}>nordavix<span style={{ color: LIME }}>.</span></span>
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
                  style={{ background: D_TXT, color: PINE }}>Open dashboard <ArrowRight size={13} strokeWidth={2.4} /></Link>
              ) : (
                <>
                  <Link to="/sign-in" className="text-[13.5px] font-medium px-2.5 py-2 transition-colors hover:text-white" style={{ color: D_TXT2 }}>Sign in</Link>
                  <Link to="/sign-up" className="inline-flex items-center gap-1.5 text-[13px] font-bold rounded-full px-4 py-2 transition-transform hover:-translate-y-0.5"
                    style={{ background: D_TXT, color: PINE }}>Start free <ArrowRight size={13} strokeWidth={2.4} /></Link>
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
            <span className="flex items-center gap-2.5">
              <img src="/logo-mark-white.svg" alt="Nordavix" className="h-7 w-7" />
              <span className="font-bold text-[17px]" style={{ color: D_TXT }}>nordavix<span style={{ color: LIME }}>.</span></span>
            </span>
            <button onClick={() => setOpen(false)} className="h-9 w-9 grid place-items-center rounded-lg"
              style={{ background: PINE_2, color: D_TXT2 }} aria-label="Close menu"><X size={17} /></button>
          </div>
          <div className="px-6 py-2">
            {NAV.map((it) => it.anchor
              ? <a key={it.label} href={it.to} onClick={() => setOpen(false)} className="block py-3.5 text-base font-medium" style={{ color: D_TXT, borderBottom: `1px solid ${D_LINE}` }}>{it.label}</a>
              : <Link key={it.label} to={it.to} onClick={() => setOpen(false)} className="block py-3.5 text-base font-medium" style={{ color: D_TXT, borderBottom: `1px solid ${D_LINE}` }}>{it.label}</Link>)}
            <div className="pt-7 space-y-3">
              <Link to="/sign-up" onClick={() => setOpen(false)} className="flex items-center justify-center gap-2 w-full py-3.5 rounded-full text-sm font-bold" style={{ background: D_TXT, color: PINE }}>Start free <ArrowRight size={14} /></Link>
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
        style={{ background: `radial-gradient(58% 56% at 50% 38%, rgba(156,196,173,0.13), transparent 70%), radial-gradient(40% 40% at 78% 70%, rgba(127,184,155,0.12), transparent 70%)` }} />
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
                style={{ background: i === 1 ? "rgba(156,196,173,0.16)" : "transparent", color: i === 1 ? LIME : "rgba(244,241,233,0.4)" }}>
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
          style={{ background: D_TXT, color: PINE, boxShadow: "0 30px 70px -26px rgba(0,0,0,0.6)" }}>
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
          style={{ background: "radial-gradient(closest-side, rgba(156,196,173,0.10), transparent)", filter: "blur(50px)" }} />
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
              <h3 className="mt-3 text-[16px] font-bold" style={{ color: L_TXT }}>Financial statements</h3>
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

// ─── NDVX Copilot showcase ───────────────────────────────────────────────────
//
// The Copilot shown doing the job rather than described. A scripted
// conversation types itself into a real-looking Copilot window, works, and
// answers — three scenes on a loop, one for each kind of question a controller
// actually asks: why doesn't this tie, where are we heading, is this entry
// right.
//
// Figures are illustrative but internally consistent, because the people this
// page is for will add them up: 720,132 + 23,488 − 9,120 = 734,500, and the
// split entry balances at 12,000 on both sides.
//
// Plays only while on screen and never under prefers-reduced-motion. At rest —
// before it scrolls into view, in a link preview, with motion reduced — it
// shows the finished first scene, so the section always says something.

type CpTone = "warn" | "ok" | "lime"
interface CopilotScene {
  tab: string
  looking: string
  q: string
  steps: string[]
  trace: string
  footing?: { text: string; tone: "warn" | "ok" }
  knew: { k: string; lines: string[] }
  note: { k: string; v: string; tone: CpTone }
  render: (still: boolean) => ReactNode
}

const COPILOT_SCENES: CopilotScene[] = [
  {
    tab: "Reconciliation",
    looking: "1200 · Accounts Receivable · Jun 2026",
    q: "Why is A/R out by $14,368 in June?",
    steps: ["Reading the reconciliation", "Checking the A/R aging", "Tracing June 30 invoices"],
    trace: "Reconciliation · A/R aging · 3 invoices",
    footing: { text: "Books aren’t closed — 4 of 19 reconciled", tone: "warn" },
    knew: { k: "Already knew", lines: ["1200 · Accounts Receivable", "GL 734,500 · aging 720,132", "No lookups to find it"] },
    note: { k: "Footing", v: "Books not closed · 4 of 19 reconciled", tone: "warn" },
    render: (still) => <CpAnswerRecon still={still} />,
  },
  {
    tab: "Forecast",
    looking: "Workspace · Jun 2026",
    q: "How long is our runway — and what would extend it?",
    steps: ["Reading six months of cash", "Projecting the burn", "Ranking your cost lines"],
    trace: "6 months of cash · 3 cost lines",
    footing: { text: "June is closed — figures are final", tone: "ok" },
    knew: { k: "Read", lines: ["Six months of cash", "Burn ≈ $68k a month", "Your three largest cost lines"] },
    note: { k: "Confidence", v: "Medium · shown as a band, not a point", tone: "ok" },
    render: (still) => <CpAnswerForecast still={still} />,
  },
  {
    tab: "Review",
    looking: "AJE-117 · awaiting review",
    q: "Is this entry right?",
    steps: ["Reading the entry", "Checking both sides"],
    trace: "AJE-117 · 2 lines · the memo",
    knew: { k: "Already knew", lines: ["AJE-117 · both lines", "Memo: annual policy", "June is 1 of 12 months"] },
    note: { k: "Guarantee", v: "Never approves · never posts", tone: "lime" },
    render: (still) => <CpAnswerReview still={still} />,
  },
]

// The timeline. A person types in bursts — a beat after each word, a longer
// one at punctuation — and a steady character rate reads as a machine.
const CP_TYPE_START = 950
const CP_CHAR       = 30
const CP_SEND_GAP   = 520
const CP_TO_STEPS   = 750
const CP_STEP       = 640
const CP_TO_ANSWER  = 300
const CP_BUILD      = 1900
const CP_HOLD       = 5200

function cpCharDelay(ch: string): number {
  if (ch === " ") return CP_CHAR + 34
  if (",.?—".includes(ch)) return CP_CHAR + 110
  return CP_CHAR
}

/** Every moment of one scene, computed once — so the progress bar on the tab
 *  and the timers that drive the window cannot disagree about how long it is. */
function cpSchedule(s: CopilotScene) {
  let t = CP_TYPE_START
  const chars: number[] = []
  for (const ch of s.q) { t += cpCharDelay(ch); chars.push(t) }
  const sent = t + CP_SEND_GAP
  const steps: number[] = []
  let u = sent + CP_TO_STEPS
  for (let i = 0; i < s.steps.length; i++) { steps.push(u); u += CP_STEP }
  const answer = u + CP_TO_ANSWER
  return { chars, sent, steps, answer, end: answer + CP_BUILD + CP_HOLD }
}

/** One line of an answer arriving: rises, sharpens out of a soft blur, in
 *  sequence. The blur is what makes it read as appearing rather than sliding. */
function CpLine({ i, still, children }: { i: number; still: boolean; children: ReactNode }) {
  return (
    <motion.div
      initial={still ? false : { opacity: 0, y: 8, filter: "blur(4px)" }}
      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      transition={{ duration: 0.55, ease: EASE, delay: still ? 0 : i * 0.32 }}>
      {children}
    </motion.div>
  )
}

function CpChip({ primary = false, children }: { primary?: boolean; children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full px-3 py-1.5 text-[12px] font-semibold"
      style={primary
        ? { background: GREEN, color: "#fff" }
        : { background: PAPER, color: L_TXT, border: `1px solid ${L_LINE2}` }}>
      {children}
    </span>
  )
}

/** Why a reconciliation doesn't tie — as a bridge that adds up on the page. */
function CpAnswerRecon({ still }: { still: boolean }) {
  const rows: { l: string; v: string; k: "base" | "up" | "down" | "total"; w?: number }[] = [
    { l: "A/R aging (subledger)", v: "720,132", k: "base" },
    { l: "Jun 30 invoices, after the aging pull", v: "+23,488", k: "up", w: 1 },
    { l: "Unapplied credits in the aging", v: "−9,120", k: "down", w: 9120 / 23488 },
    { l: "GL balance", v: "734,500", k: "total" },
  ]
  return (
    <div className="space-y-2.5">
      <CpLine i={0} still={still}>
        <p className="text-[14px] leading-relaxed" style={{ color: L_TXT }}>
          Two timing items — and they nearly cancel.
        </p>
      </CpLine>
      <CpLine i={1} still={still}>
        <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${L_LINE}` }}>
          {rows.map((r, i) => (
            <div key={r.l} className="grid grid-cols-[1fr_auto] sm:grid-cols-[1fr_110px_84px] items-center gap-3 px-3.5 py-1.5"
              style={{ background: r.k === "total" ? CREAM : PAPER, borderTop: i ? `1px solid ${L_LINE}` : "none" }}>
              <span className="text-[12.5px]"
                style={{ color: r.k === "up" || r.k === "down" ? L_TXT2 : L_TXT, fontWeight: r.k === "total" ? 700 : 500 }}>
                {r.l}
              </span>
              <span className="hidden sm:block h-[6px] rounded-full overflow-hidden"
                style={{ background: r.w ? "rgba(12,38,32,0.06)" : "transparent" }}>
                {r.w ? (
                  <motion.span className="block h-full rounded-full"
                    style={{ background: r.k === "up" ? GREEN : RED, originX: 0 }}
                    initial={still ? false : { scaleX: 0 }}
                    animate={{ scaleX: r.w }}
                    transition={{ duration: 0.9, ease: EASE, delay: still ? 0 : 0.62 + i * 0.14 }} />
                ) : null}
              </span>
              <span className="text-[12.5px] tabular-nums text-right"
                style={{ fontFamily: MONO, fontWeight: r.k === "total" ? 700 : 500,
                         color: r.k === "up" ? GREEN : r.k === "down" ? RED : L_TXT }}>
                {r.v}
              </span>
            </div>
          ))}
        </div>
      </CpLine>
      <CpLine i={2} still={still}>
        <p className="text-[14px] leading-relaxed" style={{ color: L_TXT2 }}>
          Net <b style={{ color: L_TXT, fontFamily: MONO }}>+14,368</b>, fully explained — the aging was
          pulled before day-end. Neither is an error; re-pull it and this clears.
        </p>
      </CpLine>
      <CpLine i={3} still={still}>
        <div className="flex flex-wrap gap-2">
          <CpChip primary>Re-pull aging</CpChip>
          <CpChip>Save as the note</CpChip>
        </div>
      </CpLine>
    </div>
  )
}

/** Runway — the forecast as a band that widens with distance, never a point. */
function CpAnswerForecast({ still }: { still: boolean }) {
  const W = 560, H = 120, L = 12, R = 12, T = 12, B = 22, N = 15
  const x = (i: number) => L + (i * (W - L - R)) / (N - 1)
  const y = (v: number) => T + (1 - v / 1000) * (H - T - B)
  const cash = [952, 884, 816, 748, 680, 612]                  // Jan → Jun, $k
  const proj = Array.from({ length: 10 }, (_, k) => Math.max(0, 612 - 68 * k))
  const hi   = Array.from({ length: 10 }, (_, k) => Math.max(0, 612 - 61.2 * k))
  const lo   = Array.from({ length: 10 }, (_, k) => Math.max(0, 612 - 76.5 * k))
  const pts  = (vals: number[], from: number) => vals.map((v, k) => `${x(from + k)},${y(v)}`)
  const actualD = "M" + pts(cash, 0).join(" L")
  const projD   = "M" + pts(proj, 5).join(" L")
  const bandD   = "M" + [...pts(hi, 5), ...pts(lo, 5).reverse()].join(" L") + " Z"
  const d0 = still ? 0 : 0.45
  return (
    <div className="space-y-2.5">
      <CpLine i={0} still={still}>
        <p className="text-[14px] leading-relaxed" style={{ color: L_TXT }}>
          About <b>9 months</b> at today’s burn — call it <b>8 to 10</b>.
        </p>
      </CpLine>
      <CpLine i={1} still={still}>
        <div className="rounded-xl p-3" style={{ border: `1px solid ${L_LINE}`, background: PAPER }}>
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block" role="img"
            aria-label="Cash falling from $952k in January to $612k in June, projected to reach zero around March 2027 with a band from February to April.">
            <defs>
              <clipPath id="cp-proj-wipe">
                <motion.rect x={x(5)} y={0} height={H}
                  initial={still ? false : { width: 0 }}
                  animate={{ width: W - x(5) }}
                  transition={{ duration: 1.1, ease: EASE, delay: d0 + 0.85 }} />
              </clipPath>
            </defs>
            <line x1={L} x2={W - R} y1={y(0)} y2={y(0)} stroke={L_LINE2} strokeWidth={1} />
            <line x1={x(5)} x2={x(5)} y1={T} y2={y(0)} stroke={L_LINE} strokeWidth={1} strokeDasharray="2 3" />
            <g clipPath="url(#cp-proj-wipe)">
              <path d={bandD} fill="rgba(46,122,85,0.12)" />
              <path d={projD} fill="none" stroke={GREEN} strokeWidth={2} strokeDasharray="5 4" strokeLinecap="round" />
            </g>
            <motion.path d={actualD} fill="none" stroke={L_TXT} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"
              initial={still ? false : { pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: 0.85, ease: EASE, delay: d0 }} />
            <motion.g initial={still ? false : { opacity: 0 }} animate={{ opacity: 1 }}
              transition={{ duration: 0.4, delay: d0 + 0.7 }}>
              <circle cx={x(5)} cy={y(612)} r={4} fill={L_TXT} />
              <text className="hidden sm:inline" x={x(5) + 8} y={y(612) - 8} fontSize={11} fontFamily={MONO} fill={L_TXT}>$612k today</text>
            </motion.g>
            <motion.g initial={still ? false : { opacity: 0 }} animate={{ opacity: 1 }}
              transition={{ duration: 0.4, delay: d0 + 1.75 }}>
              <circle cx={x(14)} cy={y(0)} r={4} fill={GREEN} />
              {/* Above the band, clear of the dashed line — and saying what the
                  point MEANS, since the axis tick directly below already names
                  the month. It sat on the line and repeated the date. */}
              <text className="hidden sm:inline" x={x(14) - 10} y={y(0) - 30} fontSize={11} fontFamily={MONO} fill={GREEN} textAnchor="end">cash runs out</text>
            </motion.g>
            {[["Jan", 0], ["Jun", 5], ["Mar ’27", 14]].map(([m, i]) => (
              <text className="hidden sm:inline" key={m as string} x={x(i as number)} y={H - 5} fontSize={10} fontFamily={MONO} fill={L_TXT3}
                textAnchor={i === 0 ? "start" : i === 14 ? "end" : "middle"}>{m}</text>
            ))}
          </svg>
        </div>
      </CpLine>
      <CpLine i={2} still={still}>
        <div className="space-y-1.5">
          {[
            { t: "Trim contractors 15%", s: "$6.8k a month", v: "+1 month", good: true },
            { t: "Rent", s: "$28k a month", v: "structural — not a lever this quarter", good: false },
          ].map((r) => (
            // The figure sits on its own line under the name, and the outcome
            // never breaks: on a phone they used to wrap into each other, with
            // "+1 month" split across two lines.
            <div key={r.t} className="flex items-start justify-between gap-4 text-[13px]">
              {/* Stacked on a phone, inline from `sm` up — stacking everywhere
                  cost the desktop thread the height it needed and clipped the
                  last lever under the composer. */}
              <div className="min-w-0 sm:flex sm:items-baseline sm:gap-2">
                <div className="font-bold" style={{ color: L_TXT }}>{r.t}</div>
                <div className="whitespace-nowrap" style={{ color: L_TXT3, fontFamily: MONO, fontSize: 11.5 }}>{r.s}</div>
              </div>
              <span className={`text-right ${r.good ? "whitespace-nowrap" : "max-w-[58%]"}`}
                style={{ color: r.good ? GREEN : L_TXT3, fontWeight: r.good ? 700 : 500,
                         fontFamily: r.good ? MONO : undefined }}>{r.v}</span>
            </div>
          ))}
        </div>
      </CpLine>
    </div>
  )
}

/** Reviewing an entry — and watching the correction happen to the entry itself. */
function CpAnswerReview({ still }: { still: boolean }) {
  const [split, setSplit] = useState(still)
  useEffect(() => {
    if (still) { setSplit(true); return }
    setSplit(false)
    const t = window.setTimeout(() => setSplit(true), 1500)
    return () => window.clearTimeout(t)
  }, [still])
  const cell = "tabular-nums text-right"
  // Narrower number columns and a notch smaller on a phone — the three-column
  // entry has to fit ~280px there, and it overflowed at the desktop widths.
  const grid = "grid grid-cols-[1fr_66px_66px] sm:grid-cols-[1fr_82px_82px] gap-2 px-3 sm:px-3.5 items-center"
  return (
    <div className="space-y-2.5">
      <CpLine i={0} still={still}>
        <p className="text-[14px] leading-relaxed" style={{ color: L_TXT }}>
          It balances — but it expenses a <b>12-month</b> policy in one month.
        </p>
      </CpLine>
      <CpLine i={1} still={still}>
        <div className="rounded-xl overflow-hidden text-[12.5px]" style={{ border: `1px solid ${L_LINE}`, background: PAPER }}>
          <div className="flex items-center justify-between px-3.5 py-1.5"
            style={{ background: CREAM, borderBottom: `1px solid ${L_LINE}` }}>
            <span style={{ fontFamily: MONO, fontSize: 11, color: L_TXT2 }}>AJE-117<span className="hidden sm:inline"> · Record annual insurance</span></span>
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span key={split ? "fixed" : "orig"}
                initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.3, ease: EASE }}
                style={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.12em", color: split ? GREEN : AMBER }}>
                {split ? "SUGGESTED SPLIT" : "AS POSTED"}
              </motion.span>
            </AnimatePresence>
          </div>
          <div className={`${grid} py-1.5`}
            style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: "0.1em", color: L_TXT3 }}>
            <span>ACCOUNT</span><span className="text-right">DEBIT</span><span className="text-right">CREDIT</span>
          </div>
          <div className={`${grid} py-1.5`}
            style={{ borderTop: `1px solid ${L_LINE}` }}>
            <span style={{ color: L_TXT }}>6300 · Insurance Expense</span>
            <span className={cell} style={{ fontFamily: MONO }}>
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span key={split ? "a" : "b"} className="inline-block"
                  initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.35, ease: EASE }}
                  style={{ color: split ? L_TXT : AMBER, fontWeight: split ? 500 : 700 }}>
                  {split ? "1,000.00" : "12,000.00"}
                </motion.span>
              </AnimatePresence>
            </span>
            <span className={cell} style={{ fontFamily: MONO, color: L_TXT3 }}>—</span>
          </div>
          <AnimatePresence initial={false}>
            {split && (
              <motion.div key="prepaid"
                initial={still ? false : { height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                transition={{ duration: 0.55, ease: EASE, delay: still ? 0 : 0.15 }}
                style={{ overflow: "hidden" }}>
                <div className={`${grid} py-1.5`}
                  style={{ borderTop: `1px solid ${L_LINE}`, background: "rgba(46,122,85,0.07)" }}>
                  <span style={{ color: GREEN, fontWeight: 600 }}>1400 · Prepaid Expenses</span>
                  <span className={cell} style={{ fontFamily: MONO, color: GREEN, fontWeight: 700 }}>11,000.00</span>
                  <span className={cell} style={{ fontFamily: MONO, color: L_TXT3 }}>—</span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          <div className={`${grid} py-1.5`}
            style={{ borderTop: `1px solid ${L_LINE}` }}>
            <span style={{ color: L_TXT }}>1000 · Operating Cash</span>
            <span className={cell} style={{ fontFamily: MONO, color: L_TXT3 }}>—</span>
            <span className={cell} style={{ fontFamily: MONO }}>12,000.00</span>
          </div>
          <div className={`${grid} py-1.5`}
            style={{ borderTop: `1px solid ${L_LINE2}`, background: CREAM }}>
            <span className="inline-flex items-center gap-1.5 font-semibold" style={{ color: GREEN }}>
              <CheckCircle2 size={13} strokeWidth={2.4} /> Balanced
            </span>
            <span className={cell} style={{ fontFamily: MONO, fontWeight: 700 }}>12,000.00</span>
            <span className={cell} style={{ fontFamily: MONO, fontWeight: 700 }}>12,000.00</span>
          </div>
        </div>
      </CpLine>
      <CpLine i={2} still={still}>
        <p className="text-[14px] leading-relaxed" style={{ color: L_TXT2 }}>
          Only June’s <b style={{ color: L_TXT, fontFamily: MONO }}>1,000</b> is expense; the other{" "}
          <b style={{ color: L_TXT, fontFamily: MONO }}>11,000</b> is a prepaid. I’ve drafted the split for a
          reviewer — Nordavix never writes to QuickBooks.
        </p>
      </CpLine>
    </div>
  )
}

/** Three dots breathing in turn — "working", where a spinner would say "blocked". */
function CpDots() {
  return (
    <span className="inline-flex items-center gap-[3px]">
      {[0, 1, 2].map((i) => (
        <motion.span key={i} className="h-[4px] w-[4px] rounded-full" style={{ background: GREEN }}
          animate={{ opacity: [0.25, 1, 0.25] }}
          transition={{ duration: 1.1, repeat: Infinity, ease: "easeInOut", delay: i * 0.16 }} />
      ))}
    </span>
  )
}

/** A callout floating beside the window — the machinery the answer rests on,
 *  drawn the way a motion-graphics piece labels what it wants you to notice.
 *  Placement and the gentle float live on SEPARATE elements: a transform set on
 *  a motion element is overwritten the moment it animates. */
function CpCallout({ side, k, children, active, delay }:
  { side: "left" | "right"; k: string; children: ReactNode; active: boolean; delay: number }) {
  return (
    <motion.div
      initial={active ? { opacity: 0, x: side === "left" ? -18 : 18 } : false}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: side === "left" ? -10 : 10, transition: { duration: 0.25 } }}
      transition={{ duration: 0.65, ease: EASE, delay: active ? delay : 0 }}
      className={`hidden xl:block absolute w-[184px] ${side === "left" ? "-left-[210px] top-[22%]" : "-right-[210px] top-[52%]"}`}>
      <motion.div
        animate={active ? { y: [0, -5, 0] } : undefined}
        transition={active ? { duration: 6, repeat: Infinity, ease: "easeInOut" } : undefined}>
        <div className="relative rounded-xl p-3.5"
          style={{ background: PINE_2, border: `1px solid ${D_LINE2}`, boxShadow: "0 24px 50px -24px rgba(0,0,0,0.7)" }}>
          <div className="text-[9.5px] tracking-[0.2em] uppercase" style={{ fontFamily: MONO, color: SAGE }}>{k}</div>
          <div className="mt-2">{children}</div>
          {/* connector to the window's edge */}
          <span aria-hidden className={`absolute top-1/2 h-px w-[26px] ${side === "left" ? "-right-[26px]" : "-left-[26px]"}`}
            style={{ background: D_LINE2 }} />
          <span aria-hidden className={`absolute top-1/2 -mt-[3px] h-[6px] w-[6px] rounded-full ${side === "left" ? "-right-[29px]" : "-left-[29px]"}`}
            style={{ background: LIME }} />
        </div>
      </motion.div>
    </motion.div>
  )
}

// The flight between the empty state and the conversation. Long enough to be
// watched — it is the move the section exists to show — and on the page's own
// expo-out, so it lands the way everything else on the page lands.
const CP_FLY = { duration: 0.72, ease: EASE }
const CP_WORD = { fontWeight: 600, letterSpacing: "-0.015em", lineHeight: 1.15, color: L_TXT }

/** The ask field — ONE element that lives in the centre of the empty window
 *  and docks at the bottom once a question is sent, flown between the two by a
 *  shared layoutId exactly as the Copilot page moves it.
 *
 *  Its children carry `layout` so framer corrects the parent's scale on them:
 *  the field widens by half again in flight, and without the correction the
 *  text and the send button stretch with it. The radii live in `style` for the
 *  same reason — framer can only correct a radius it can read. */
function CpComposer({ text, placeholder, live, caret }:
  { text: string; placeholder: string; live: boolean; caret: boolean }) {
  return (
    <motion.div layoutId="cp-composer" transition={CP_FLY}
      className="flex items-center gap-3 px-4 py-2.5 w-full"
      style={{
        borderRadius: 16, background: CREAM,
        border: `1px solid ${live ? GREEN : L_LINE}`,
        boxShadow: live ? "0 0 0 4px rgba(46,122,85,0.10)" : "0 1px 2px rgba(12,38,32,0.05)",
      }}>
      <motion.span layout="position" className="flex-1 min-w-0 text-left text-[14px] leading-snug"
        style={{ color: text ? L_TXT : L_TXT3 }}>
        {text || placeholder}
        {caret && (
          <motion.span className="inline-block w-[2px] h-[1.05em] ml-[1px] rounded-full"
            style={{ background: GREEN, verticalAlign: "-0.17em" }}
            animate={{ opacity: [1, 1, 0, 0] }}
            transition={{ duration: 1, repeat: Infinity, times: [0, 0.5, 0.5, 1] }} />
        )}
      </motion.span>
      <motion.span layout className="shrink-0 h-8 w-8 grid place-items-center"
        style={{ borderRadius: 11, background: live ? GREEN : "rgba(12,38,32,0.14)", color: "#fff" }}>
        <ArrowUp size={15} strokeWidth={2.6} />
      </motion.span>
    </motion.div>
  )
}

function CopilotShowcase() {
  const reduce = useReducedMotion()
  const stageRef = useRef<HTMLDivElement>(null)
  const inView = useInView(stageRef, { amount: 0.35 })
  const active = inView && !reduce

  const [scene, setScene] = useState(0)
  const [phase, setPhase] = useState<"typing" | "sent" | "steps" | "answer">("answer")
  const [typed, setTyped] = useState(0)
  const [stepN, setStepN] = useState(COPILOT_SCENES[0].steps.length)
  const [run, setRun]     = useState(0)   // bumped by a tab click: restart this scene
  const [epoch, setEpoch] = useState(0)   // bumped whenever the timeline starts: keys the progress bar

  const s = COPILOT_SCENES[scene]
  const sched = useMemo(() => cpSchedule(s), [s])

  useEffect(() => {
    if (!active) {
      // At rest: the finished scene, fully readable, nothing moving.
      setPhase("answer")
      setStepN(s.steps.length)
      return
    }
    const timers: number[] = []
    const at = (ms: number, fn: () => void) => { timers.push(window.setTimeout(fn, ms)) }
    setEpoch((e) => e + 1)
    setPhase("typing"); setTyped(0); setStepN(0)
    sched.chars.forEach((ms, i) => at(ms, () => setTyped(i + 1)))
    at(sched.sent, () => setPhase("sent"))
    sched.steps.forEach((ms, i) => at(ms, () => { setPhase("steps"); setStepN(i + 1) }))
    at(sched.answer, () => setPhase("answer"))
    at(sched.end, () => setScene((n) => (n + 1) % COPILOT_SCENES.length))
    return () => timers.forEach((id) => window.clearTimeout(id))
  }, [active, scene, run, sched, s.steps.length])

  const typing  = phase === "typing"
  const working = phase === "steps" || phase === "answer"
  const still   = !active
  const noteTone = { warn: "#D6B26C", ok: SAGE, lime: LIME }[s.note.tone]

  return (
    <section id="copilot" className="relative overflow-hidden"
      style={{ background: PINE, borderBottom: `1px solid ${D_LINE}` }}>
      {/* Stage lighting: the hero's grid, masked to pool around the window, and
          two glows that breathe — the only ambient motion on the section. */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0" style={{
          backgroundImage: `linear-gradient(${D_LINE} 1px, transparent 1px), linear-gradient(90deg, ${D_LINE} 1px, transparent 1px)`,
          backgroundSize: "64px 64px", opacity: 0.45,
          maskImage: "radial-gradient(60% 50% at 50% 62%, black, transparent 80%)",
          WebkitMaskImage: "radial-gradient(60% 50% at 50% 62%, black, transparent 80%)",
        }} />
        <motion.div className="absolute left-1/2 top-[44%] h-[560px] w-[960px] rounded-full"
          style={{ x: "-50%", background: "radial-gradient(closest-side, rgba(156,196,173,0.13), transparent)", filter: "blur(60px)" }}
          animate={reduce ? undefined : { scale: [1, 1.07, 1], opacity: [0.85, 1, 0.85] }}
          transition={reduce ? undefined : { duration: 9, repeat: Infinity, ease: "easeInOut" }} />
        <motion.div className="absolute right-[6%] top-[70%] h-[260px] w-[380px] rounded-full"
          style={{ background: "radial-gradient(closest-side, rgba(127,184,155,0.10), transparent)", filter: "blur(50px)" }}
          animate={reduce ? undefined : { x: [0, -40, 0], y: [0, -24, 0] }}
          transition={reduce ? undefined : { duration: 14, repeat: Infinity, ease: "easeInOut" }} />
      </div>

      <div className="relative max-w-6xl mx-auto px-6 py-20 md:py-28">
        <div className="max-w-3xl mx-auto text-center">
          <Reveal><div className="flex justify-center"><Kicker dark>NDVX Copilot</Kicker></div></Reveal>
          <Reveal delay={0.06}>
            <Display dark className="mt-6" size="clamp(2.4rem, 5.6vw, 4.4rem)">
              Ask your books.
              <br />
              <em style={{ fontStyle: "italic", color: LIME }}>Get a controller’s answer.</em>
            </Display>
          </Reveal>
          <Reveal delay={0.12}>
            <p className="mt-6 mx-auto max-w-xl text-[15.5px] md:text-[17px] leading-relaxed" style={{ color: D_TXT2 }}>
              Open an account, highlight a number, or just ask. NDVX Copilot already knows what
              you’re looking at — so it skips the twenty questions and gets to the part that matters.
            </p>
          </Reveal>
        </div>

        {/* Scene switcher — a pill that glides between tabs, and a progress line
            that fills over the scene so the loop never feels like it's stalled. */}
        <Reveal delay={0.16} className="mt-10 flex justify-center">
          <div className="inline-flex gap-1 p-1 rounded-full" role="tablist" aria-label="Copilot examples"
            style={{ background: "rgba(244,241,233,0.04)", border: `1px solid ${D_LINE}` }}>
            {COPILOT_SCENES.map((c, i) => (
              <button key={c.tab} role="tab" aria-selected={i === scene}
                onClick={() => { setScene(i); setRun((r) => r + 1) }}
                className="relative overflow-hidden rounded-full px-4 sm:px-5 py-2 text-[12.5px] font-semibold transition-colors"
                style={{ color: i === scene ? D_TXT : D_TXT3 }}>
                {i === scene && (
                  <motion.span layoutId="cp-tab" className="absolute inset-0 rounded-full"
                    style={{ background: PINE_3, border: `1px solid ${D_LINE2}` }}
                    transition={{ duration: 0.45, ease: EASE }} />
                )}
                <span className="relative">{c.tab}</span>
                {active && i === scene && (
                  <motion.span key={epoch} aria-hidden className="absolute left-3 right-3 bottom-[5px] h-[2px] rounded-full"
                    style={{ background: LIME, originX: 0 }}
                    initial={{ scaleX: 0 }} animate={{ scaleX: 1 }}
                    transition={{ duration: sched.end / 1000, ease: "linear" }} />
                )}
              </button>
            ))}
          </div>
        </Reveal>

        <Reveal delay={0.2} y={36}>
          <div ref={stageRef} className="relative mt-8 mx-auto max-w-[840px]">
            <p className="sr-only">
              An example of NDVX Copilot answering three questions: why accounts receivable is out by
              $14,368, how long the company’s runway is, and whether an insurance entry is recorded correctly.
            </p>

            {/* the light pooling under the window */}
            <div aria-hidden className="pointer-events-none absolute -inset-x-20 -bottom-20 h-40"
              style={{ background: "radial-gradient(closest-side, rgba(156,196,173,0.20), transparent)", filter: "blur(28px)" }} />

            <AnimatePresence>
              {!typing && (
                <CpCallout key={`knew-${scene}`} side="left" k={s.knew.k} active={active} delay={0.1}>
                  <div className="space-y-1">
                    {s.knew.lines.map((l) => (
                      <div key={l} className="text-[12px] leading-snug" style={{ color: D_TXT2 }}>{l}</div>
                    ))}
                  </div>
                </CpCallout>
              )}
              {working && (
                <CpCallout key={`note-${scene}`} side="right" k={s.note.k} active={active} delay={0.2}>
                  <div className="text-[12.5px] font-semibold leading-snug" style={{ color: noteTone }}>{s.note.v}</div>
                </CpCallout>
              )}
            </AnimatePresence>

            {/* The window. aria-hidden: it replays on a loop, and a region that
                re-types itself every thirty seconds is noise to a screen reader.
                The sr-only line above says what it shows. */}
            {/* `color: L_TXT` is load-bearing. The page root sets cream text for
                the dark bands, so any cell in this light window without its own
                colour inherited cream-on-white — the entry's credit column and
                its "Balanced" totals were all but invisible. Set once here, so
                nothing added later can fall into the same hole. */}
            <div aria-hidden className="relative rounded-[20px] overflow-hidden"
              style={{ color: L_TXT, background: PAPER, border: `1px solid rgba(244,241,233,0.14)`,
                       boxShadow: "0 70px 140px -50px rgba(0,0,0,0.75), 0 0 0 1px rgba(156,196,173,0.06)" }}>
              {/* header */}
              <div className="flex items-center gap-3 px-5 h-[50px]" style={{ borderBottom: `1px solid ${L_LINE}` }}>
                {/* The brand's resting place. Fixed width, so when the lockup
                    flies up from the centre nothing beside it shifts to make
                    room — the chip is already where it will stay. */}
                <div className="w-[128px] shrink-0 h-full flex items-center gap-2.5">
                  {!typing && (
                    <>
                      <motion.span layoutId="cp-mark" transition={CP_FLY} className="inline-flex">
                        <CopilotMark size={22} />
                      </motion.span>
                      <motion.span layoutId="cp-word" transition={CP_FLY} className="text-[14px] whitespace-nowrap" style={CP_WORD}>
                        NDVX <span style={{ color: GREEN }}>Copilot</span>
                      </motion.span>
                    </>
                  )}
                </div>
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.span key={s.looking}
                    initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }}
                    transition={{ duration: 0.35, ease: EASE }}
                    className="hidden sm:inline-flex items-center gap-2 rounded-md px-2 py-1 text-[10.5px] truncate"
                    style={{ fontFamily: MONO, background: CREAM, border: `1px solid ${L_LINE}`, color: L_TXT2 }}>
                    <span style={{ color: L_TXT3, letterSpacing: "0.12em" }}>LOOKING AT</span>{s.looking}
                  </motion.span>
                </AnimatePresence>
                <span className="ml-auto inline-flex items-center gap-1.5 text-[10px] font-bold tracking-[0.14em] shrink-0"
                  style={{ fontFamily: MONO, color: GREEN }}>
                  <Lock size={11} strokeWidth={2.4} /> READ-ONLY
                </span>
              </div>

              {/* Body — one fixed height for every state, so the move between
                  the empty screen and the conversation never shifts the page. It
                  does NOT clip: the brand flies in and out through its top edge,
                  and a clipping box here would cut it off mid-flight. Only the
                  thread below clips. */}
              {/* Measured, not guessed: the tightest scene (the runway forecast,
                  with its chart) clears the dock by 18px here. At 450 it cleared
                  by 8, which is inside the margin a different font fallback on
                  someone else's machine could eat. */}
              <div className="relative h-[560px] sm:h-[460px]" style={{ background: PAPER }}>
                <AnimatePresence>
                  {typing && (
                    <motion.div key="glow" aria-hidden
                      className="pointer-events-none absolute left-1/2 top-[40%] h-56 w-56 rounded-full"
                      style={{ x: "-50%", y: "-50%", background: "#DEEDE4", filter: "blur(48px)" }}
                      initial={{ opacity: 0 }} animate={{ opacity: 0.75 }} exit={{ opacity: 0 }}
                      transition={{ duration: 0.6, ease: EASE }} />
                  )}
                </AnimatePresence>

                {/* The thread. Reserves the dock's height at the bottom so an
                    answer can never run under the composer. */}
                <div className="absolute inset-x-0 top-0 bottom-[70px] overflow-hidden">
                  <AnimatePresence initial={false}>
                    <motion.div key={`${scene}-${epoch}`} className="absolute inset-0 px-5 sm:px-8 pt-5"
                      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                      transition={{ duration: 0.4, ease: EASE }}>
                      {!typing && (
                        <motion.div
                          initial={still ? false : { opacity: 0, y: 18, scale: 0.97 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          transition={{ duration: 0.55, ease: EASE, delay: still ? 0 : 0.22 }}
                          className="ml-auto w-fit max-w-[82%] rounded-2xl rounded-br-md px-4 py-2 text-[14px] leading-snug"
                          style={{ background: PINE, color: D_TXT }}>
                          {s.q}
                        </motion.div>
                      )}

                      {working && (
                        <motion.div className="mt-4 flex gap-3"
                          initial={still ? false : { opacity: 0 }} animate={{ opacity: 1 }}
                          transition={{ duration: 0.3 }}>
                          {/* The avatar gives way on a phone: 38px back to the answer
                              is the difference between the entry's credit column
                              fitting and being clipped off the edge. */}
                          <span className="hidden sm:block shrink-0"><CopilotMark size={24} className="mt-0.5" /></span>
                          <div className="flex-1 min-w-0 space-y-2.5">
                            {phase === "steps" ? (
                              <div className="space-y-1.5 pt-1">
                                {s.steps.slice(0, stepN).map((st, i) => {
                                  const current = i === stepN - 1
                                  return (
                                    <motion.div key={st} className="flex items-center gap-2.5 text-[13px]"
                                      initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
                                      transition={{ duration: 0.35, ease: EASE }}
                                      style={{ color: current ? L_TXT2 : L_TXT3 }}>
                                      {current ? <CpDots /> : <Check size={13} strokeWidth={2.6} style={{ color: GREEN }} />}
                                      {st}{current ? "…" : ""}
                                    </motion.div>
                                  )
                                })}
                              </div>
                            ) : (
                              <>
                                <div className="flex flex-wrap items-center gap-2 pt-0.5">
                                  <span className="inline-flex items-center gap-1.5 text-[11.5px]" style={{ color: L_TXT3 }}>
                                    <Check size={12} strokeWidth={2.6} style={{ color: GREEN }} /> {s.trace}
                                  </span>
                                  {s.footing && (
                                    <motion.span
                                      initial={still ? false : { opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }}
                                      transition={{ duration: 0.4, ease: EASE }}
                                      className="inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold"
                                      style={s.footing.tone === "warn"
                                        ? { background: "#F7EEDC", color: "#8E6620", border: "1px solid #E7D6B2" }
                                        : { background: "#DEEDE4", color: "#2A7050", border: "1px solid #BFD8C8" }}>
                                      {s.footing.text}
                                    </motion.span>
                                  )}
                                </div>
                                {s.render(still)}
                              </>
                            )}
                          </div>
                        </motion.div>
                      )}
                    </motion.div>
                  </AnimatePresence>
                </div>

                {/* The empty state — the Copilot page's own: the mark, the name,
                    a line, and the ask field right beneath them. Rendered
                    without AnimatePresence on purpose. The mark, the name and the
                    field are each ONE element that exists in exactly one place at
                    a time, and swapping them in the same render is what lets a
                    shared layoutId fly them into the header and the dock instead
                    of fading one copy out while another fades in. */}
                {typing && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center px-5 sm:px-12 text-center">
                    <motion.span layoutId="cp-mark" transition={CP_FLY} className="inline-flex">
                      <CopilotMark size={44} />
                    </motion.span>
                    <motion.span layoutId="cp-word" transition={CP_FLY}
                      className="mt-4 text-[26px] sm:text-[30px] whitespace-nowrap" style={CP_WORD}>
                      NDVX <span style={{ color: GREEN }}>Copilot</span>
                    </motion.span>
                    {/* Fades on its own clock: in once the brand has landed, out
                        as the question finishes, so it is already gone when the
                        rest of the screen flies apart on send. */}
                    <motion.p className="mt-2 max-w-sm text-[13.5px] leading-relaxed" style={{ color: L_TXT3 }}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: typed >= s.q.length ? 0 : 1 }}
                      transition={{ duration: 0.35, delay: typed === 0 ? 0.5 : 0 }}>
                      Ask anything about the books you’re looking at.
                    </motion.p>
                    <div className="mt-6 w-full max-w-[500px]">
                      <CpComposer text={s.q.slice(0, typed)} placeholder="Ask NDVX Copilot…"
                        live={typed > 0} caret />
                    </div>
                  </div>
                )}

                {/* The dock — where the field lands once a question is sent. */}
                {!typing && (
                  <div className="absolute inset-x-0 bottom-0 px-5 sm:px-8 pb-4 pt-2.5">
                    <CpComposer text="" placeholder="Ask a follow-up…" live={false} caret={false} />
                  </div>
                )}
              </div>
            </div>
          </div>
        </Reveal>

        {/* What it is, in the page's own step-ribbon style. */}
        <div className="mt-14 grid md:grid-cols-3 gap-x-8 gap-y-10 max-w-5xl mx-auto">
          {[
            { k: "IN PLACE", t: "On every account, variance and entry.", d: "Ask without leaving the screen — highlight any number to ask about it." },
            { k: "FOOTING FIRST", t: "Says what the answer stands on.", d: "Tells you whether the books can carry a figure before it quotes one." },
            { k: "HANDS OFF THE LEDGER", t: "Drafts. Never posts.", d: "Entries go to a reviewer. Nordavix never approves, and never writes to QuickBooks." },
          ].map((p, i) => (
            <Reveal key={p.k} delay={i * 0.06}>
              <div className="pt-5" style={{ borderTop: `2px solid ${i === 0 ? LIME : D_LINE2}` }}>
                <div className="text-[10px] tracking-[0.2em]" style={{ fontFamily: MONO, color: i === 0 ? LIME : D_TXT3 }}>{p.k}</div>
                <div className="mt-3 text-[15px] font-bold" style={{ color: D_TXT }}>{p.t}</div>
                <p className="mt-1 text-[13px] leading-relaxed" style={{ color: D_TXT2 }}>{p.d}</p>
              </div>
            </Reveal>
          ))}
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
        <div className="absolute -top-32 right-[-10%] h-[400px] w-[560px] rounded-full" style={{ background: "radial-gradient(closest-side, rgba(156,196,173,0.10), transparent)", filter: "blur(56px)" }} />
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
                    <span className="shrink-0 h-10 w-10 rounded-xl grid place-items-center" style={{ background: "rgba(156,196,173,0.12)", color: LIME }}><Icon size={17} strokeWidth={2} /></span>
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
              <img src="/logo-mark-dark.svg" alt="Nordavix" className="h-9 w-9" loading="lazy" />
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
  { q: "Is my data isolated from other customers?", a: "Every row in our database is tagged with a tenant_id and access is enforced by a session-level filter at the ORM layer. Cross-tenant reads are physically blocked, not just hidden. We are not SOC 2 certified yet — formal attestation is on our roadmap." },
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
          style={{ background: "radial-gradient(closest-side, rgba(156,196,173,0.12), transparent)", filter: "blur(56px)" }} />
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
        title="Nordavix — AI month-end close software for CPAs"
        description="Close your books in days, not weeks. AI-prepared reconciliations, flux analysis, cash-runway and break-even insights, intercompany consolidation, and an executive financial package — all on top of QuickBooks Online."
        path="/" bareTitle jsonLd={[faqSchemaObj, crumbs]} />
      <Navbar />
      <Hero />
      <MetricsBar />
      <Platform />
      <Bento />
      <CopilotShowcase />
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
