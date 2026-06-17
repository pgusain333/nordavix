/**
 * SolutionsPage — the marketing site's "what we've built" page.
 *
 * Anchored by a unique creative element: "The Nordavix Close Loop", a
 * circular SVG diagram showing the 6 stages of a month-end with a
 * glowing orb travelling continuously around the perimeter. Each node
 * is clickable and scrolls to the corresponding app deep-dive below.
 *
 * Sections (top → bottom):
 *   1. Hero with a stat-strip ticker
 *   2. The Close Loop (the unique visual)
 *   3. Six app deep-dives, alternating layout, each with a stylized
 *      "mock UI preview" so the reader sees what they'll get
 *   4. "Built for every role" persona cards
 *   5. AI-everywhere capability showcase
 *   6. By-the-numbers stat strip
 *   7. Final CTA
 *
 * Theme-aware throughout; matches the marketing-page typography +
 * spacing (max-w-6xl, the same animation classes from index.css).
 */
import { useEffect, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { useUser } from "@clerk/clerk-react"
import { motion } from "framer-motion"
import { SEO, breadcrumbSchema } from "@/marketing/seo/SEO"
import {
  Menu, X, ArrowRight, Sparkles, Scale, BarChart3, Lightbulb,
  ArrowLeftRight, BookOpen, Plug, Lock, CheckCircle2, LayoutDashboard,
  CheckSquare, Users, Workflow, Brain, FileText, ShieldCheck, Zap,
  TrendingUp, ChevronRight,
} from "lucide-react"
import { MarketingFooter } from "@/marketing/MarketingFooter"

// ── Close Loop node registry ─────────────────────────────────────────────────

interface LoopNode {
  id:     string
  label:  string
  icon:   React.ElementType
  blurb:  string  // micro-copy shown in the center on hover
  jumpTo: string  // anchor id of the section to scroll to on click
}

const LOOP_NODES: LoopNode[] = [
  { id: "connect",   label: "Connect",   icon: Plug,         blurb: "One-click QuickBooks integration. Read-only scope.",     jumpTo: "connect" },
  { id: "sync",      label: "Sync",      icon: LayoutDashboard, blurb: "Pull TB, AR/AP aging, P&L — snapshot per period.",     jumpTo: "dashboard" },
  { id: "reconcile", label: "Reconcile", icon: Scale,        blurb: "GL ↔ Subledger, auto roll-forward, Agentic Mode.",       jumpTo: "reconciliations" },
  { id: "analyze",   label: "Analyze",   icon: BarChart3,    blurb: "Flux variances with AI commentary — material first.",    jumpTo: "flux" },
  { id: "insights",  label: "Decide",    icon: Lightbulb,    blurb: "Liquidity, AR/AP risk, recommendations.",                 jumpTo: "insights" },
  { id: "close",     label: "Close",     icon: Lock,         blurb: "Lock the period, publish the financial package.",         jumpTo: "financials" },
]

// ── Navbar (slim variant of the marketing one) ───────────────────────────────

function Navbar() {
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
      <nav className={`fixed top-0 inset-x-0 z-50 transition-all duration-300 ${
        scrolled
          ? "border-b shadow-sm py-3"
          : "backdrop-blur-sm py-5"
      }`}
        // Solid burgundy header when scrolled — matches the HomePage
        // pattern + the FounderQuote brand color (#0C2620). Switches
        // logo/text to white for contrast.
        style={{
          background: scrolled ? "#0C2620" : "transparent",
          borderColor: scrolled ? "rgba(255,255,255,0.10)" : "transparent",
        }}
      >
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
            <Link to="/" className="text-sm transition-colors"
              style={{ color: scrolled ? "rgba(255,255,255,0.85)" : "var(--text-2)" }}
              onMouseEnter={e => (e.currentTarget.style.color = scrolled ? "#FFFFFF" : "var(--text)")}
              onMouseLeave={e => (e.currentTarget.style.color = scrolled ? "rgba(255,255,255,0.85)" : "var(--text-2)")}>
              Home
            </Link>
            <Link to="/solutions" className="text-sm font-semibold"
              style={{ color: scrolled ? "#FFFFFF" : "var(--green)" }}>
              Solutions
            </Link>
            <a href="/#pricing" className="text-sm transition-colors"
              style={{ color: scrolled ? "rgba(255,255,255,0.85)" : "var(--text-2)" }}
              onMouseEnter={e => (e.currentTarget.style.color = scrolled ? "#FFFFFF" : "var(--text)")}
              onMouseLeave={e => (e.currentTarget.style.color = scrolled ? "rgba(255,255,255,0.85)" : "var(--text-2)")}>
              Pricing
            </a>
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
                    onMouseEnter={e => (e.currentTarget.style.color = scrolled ? "#FFFFFF" : "var(--text)")}
                    onMouseLeave={e => (e.currentTarget.style.color = scrolled ? "rgba(255,255,255,0.85)" : "var(--text-2)")}>
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
          <div className="px-6 py-4 space-y-3">
            <Link to="/" onClick={() => setMobileOpen(false)} className="block py-2.5 text-base text-theme">Home</Link>
            <Link to="/solutions" onClick={() => setMobileOpen(false)} className="block py-2.5 text-base font-semibold" style={{ color: "var(--green)" }}>Solutions</Link>
            <a href="/#pricing" onClick={() => setMobileOpen(false)} className="block py-2.5 text-base text-theme">Pricing</a>
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

// ── The Close Loop — the page's unique creative element ──────────────────────

function CloseLoop() {
  const [hovered, setHovered] = useState<string | null>(null)
  const R = 180  // radius
  const center = 240
  const nodeR = 38

  function nodePos(i: number) {
    // Start at top (12 o'clock), go clockwise
    const angle = (i / LOOP_NODES.length) * Math.PI * 2 - Math.PI / 2
    return {
      x: center + R * Math.cos(angle),
      y: center + R * Math.sin(angle),
    }
  }

  function scrollTo(id: string) {
    const el = document.getElementById(id)
    el?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  const activeNode = LOOP_NODES.find((n) => n.id === hovered)

  return (
    <section className="relative px-6 py-20 sm:py-28">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-12 sm:mb-16">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium mb-4"
            style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
            <Workflow size={12} strokeWidth={2} />
            The Nordavix Close Loop
          </div>
          <h2 className="text-3xl sm:text-5xl font-bold text-theme mb-4 leading-tight">
            One workflow, six stages,<br />zero swivel-chair.
          </h2>
          <p className="text-base sm:text-lg max-w-2xl mx-auto" style={{ color: "var(--text-2)" }}>
            Click any stage to jump to the apps that power it. The whole loop is built
            to compress your close from days to hours — without losing the audit trail.
          </p>
        </div>

        {/* The SVG */}
        <div className="relative flex justify-center">
          <svg viewBox="0 0 480 480" className="w-full max-w-[480px]" role="img" aria-label="Nordavix close loop diagram">
            <defs>
              <linearGradient id="loop-gradient" x1="0" x2="1" y1="0" y2="1">
                <stop offset="0%"   stopColor="var(--green)" stopOpacity="0.6" />
                <stop offset="100%" stopColor="#6366f1"      stopOpacity="0.6" />
              </linearGradient>
              <radialGradient id="orb-glow" cx="50%" cy="50%">
                <stop offset="0%"   stopColor="var(--green)" stopOpacity="0.9" />
                <stop offset="100%" stopColor="var(--green)" stopOpacity="0"   />
              </radialGradient>
              <filter id="orb-shadow" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="3" />
              </filter>
            </defs>

            {/* Outer ring (dashed) */}
            <circle cx={center} cy={center} r={R} fill="none"
              stroke="url(#loop-gradient)" strokeWidth="1.5" strokeDasharray="4 6"
              opacity="0.55" />

            {/* Travelling orb */}
            <g>
              <circle r="18" fill="url(#orb-glow)" filter="url(#orb-shadow)">
                <animateMotion dur="14s" repeatCount="indefinite" path={`M ${center + R},${center}
                  A ${R},${R} 0 1,1 ${center - R},${center}
                  A ${R},${R} 0 1,1 ${center + R},${center}`} />
              </circle>
              <circle r="5" fill="var(--green)">
                <animateMotion dur="14s" repeatCount="indefinite" path={`M ${center + R},${center}
                  A ${R},${R} 0 1,1 ${center - R},${center}
                  A ${R},${R} 0 1,1 ${center + R},${center}`} />
              </circle>
            </g>

            {/* Connector arcs between adjacent nodes */}
            {LOOP_NODES.map((_, i) => {
              const a = nodePos(i)
              const b = nodePos((i + 1) % LOOP_NODES.length)
              return (
                <path key={i}
                  d={`M ${a.x},${a.y} A ${R},${R} 0 0,1 ${b.x},${b.y}`}
                  fill="none" stroke="var(--border-strong)" strokeWidth="1" opacity="0.4"
                />
              )
            })}

            {/* Nodes */}
            {LOOP_NODES.map((n, i) => {
              const { x, y } = nodePos(i)
              const isHover = hovered === n.id
              const Icon = n.icon
              return (
                <g key={n.id}
                  onMouseEnter={() => setHovered(n.id)}
                  onMouseLeave={() => setHovered(null)}
                  onClick={() => scrollTo(n.jumpTo)}
                  style={{ cursor: "pointer" }}
                >
                  {/* Bigger invisible hit-target so it's easy to click on touch */}
                  <circle cx={x} cy={y} r={nodeR + 12} fill="transparent" />
                  {/* Highlight ring */}
                  <circle cx={x} cy={y} r={nodeR + 4}
                    fill="none" stroke="var(--green)" strokeWidth="2"
                    opacity={isHover ? 1 : 0} style={{ transition: "opacity 0.2s" }} />
                  {/* Node body */}
                  <circle cx={x} cy={y} r={nodeR}
                    fill="var(--surface)" stroke="var(--border-strong)" strokeWidth="1" />
                  {/* Icon */}
                  <foreignObject x={x - 16} y={y - 22} width="32" height="32">
                    <div style={{ color: isHover ? "var(--green)" : "var(--text)", transition: "color 0.2s" }}>
                      <Icon size={20} strokeWidth={1.8} />
                    </div>
                  </foreignObject>
                  {/* Label */}
                  <text x={x} y={y + 14} textAnchor="middle"
                    style={{ fill: "var(--text)", fontSize: "10px", fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase" }}>
                    {n.label}
                  </text>
                </g>
              )
            })}

            {/* Center label */}
            <foreignObject x={center - 100} y={center - 50} width="200" height="100">
              <div className="h-full flex flex-col items-center justify-center text-center">
                {activeNode ? (
                  <motion.div
                    key={activeNode.id}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="px-2"
                  >
                    <p className="text-xs font-bold uppercase tracking-wider mb-1" style={{ color: "var(--green)" }}>
                      {activeNode.label}
                    </p>
                    <p className="text-[11px] leading-relaxed" style={{ color: "var(--text-2)" }}>
                      {activeNode.blurb}
                    </p>
                  </motion.div>
                ) : (
                  <>
                    <img src="/logo-mark-dark.svg"  alt="" className="h-8 w-8 mb-1 dark:hidden" loading="lazy" />
                    <img src="/logo-mark-light.svg" alt="" className="h-8 w-8 mb-1 hidden dark:block" loading="lazy" />
                    <p className="text-[10px] font-bold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
                      Hover a stage
                    </p>
                  </>
                )}
              </div>
            </foreignObject>
          </svg>
        </div>
      </div>
    </section>
  )
}

// ── App deep-dive section helper ─────────────────────────────────────────────

interface DeepDiveProps {
  id:        string
  eyebrow:   string
  title:     string
  blurb:     string
  bullets:   string[]
  stat?:     { value: string; label: string }
  flip?:     boolean
  preview:   React.ReactNode
}

function DeepDive({ id, eyebrow, title, blurb, bullets, stat, flip, preview }: DeepDiveProps) {
  return (
    <section id={id} className="relative px-6 py-20 sm:py-24" style={{ scrollMarginTop: "80px" }}>
      <div className="max-w-6xl mx-auto">
        <div className={`grid grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-16 items-center ${flip ? "lg:[&>*:first-child]:order-2" : ""}`}>
          {/* Copy column */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 0.4, ease: "easeOut" }}
          >
            <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold uppercase tracking-wider mb-4"
              style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
              {eyebrow}
            </div>
            <h2 className="text-3xl sm:text-4xl font-bold leading-tight mb-4" style={{ color: "var(--text)" }}>
              {title}
            </h2>
            <p className="text-base sm:text-lg mb-6 leading-relaxed" style={{ color: "var(--text-2)" }}>
              {blurb}
            </p>
            <ul className="space-y-2.5 mb-7">
              {bullets.map((b, i) => (
                <li key={i} className="flex items-start gap-2.5">
                  <span className="h-5 w-5 rounded-full flex items-center justify-center shrink-0 mt-0.5"
                    style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
                    <CheckCircle2 size={12} strokeWidth={2.4} />
                  </span>
                  <span className="text-sm" style={{ color: "var(--text)" }}>{b}</span>
                </li>
              ))}
            </ul>
            {stat && (
              <div className="inline-flex items-baseline gap-2 rounded-lg px-4 py-2.5"
                style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
                <span className="text-2xl font-bold" style={{ color: "var(--green)" }}>{stat.value}</span>
                <span className="text-xs" style={{ color: "var(--text-2)" }}>{stat.label}</span>
              </div>
            )}
          </motion.div>

          {/* Preview column */}
          <motion.div
            initial={{ opacity: 0, scale: 0.96 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 0.5, ease: "easeOut", delay: 0.1 }}
          >
            {preview}
          </motion.div>
        </div>
      </div>
    </section>
  )
}

// ── Stylized mock previews per app ───────────────────────────────────────────

function MockShell({ title, badge, children }: { title: string; badge?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl overflow-hidden"
      style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "0 20px 60px rgba(0,0,0,0.08)" }}>
      <div className="px-4 py-3 flex items-center justify-between"
        style={{ borderBottom: "1px solid var(--border)", background: "var(--surface-2)" }}>
        <div className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: "#ef4444" }} />
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: "#f59e0b" }} />
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: "var(--green)" }} />
        </div>
        <span className="text-[11px] font-semibold" style={{ color: "var(--text-muted)" }}>
          {title}
        </span>
        {badge ? (
          <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
            style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
            {badge}
          </span>
        ) : <span className="w-10" />}
      </div>
      <div className="p-4 sm:p-5">{children}</div>
    </div>
  )
}

function PreviewDashboard() {
  return (
    <MockShell title="Dashboard" badge="LIVE">
      <p className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: "var(--text-muted)" }}>
        April 2026 · Close progress
      </p>
      <div className="grid grid-cols-2 gap-2 mb-3">
        {[
          { label: "Recons",    val: "18/22", color: "var(--green)" },
          { label: "Variance",  val: "$0",    color: "var(--green)" },
          { label: "Flux runs", val: "3",     color: "var(--text)" },
          { label: "Open tasks", val: "5",    color: "#f59e0b" },
        ].map((k) => (
          <div key={k.label} className="rounded-lg p-2.5" style={{ background: "var(--surface-2)" }}>
            <p className="text-[9px] uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>{k.label}</p>
            <p className="text-base font-bold tabular-nums mt-0.5" style={{ color: k.color }}>{k.val}</p>
          </div>
        ))}
      </div>
      <div className="rounded-lg p-3" style={{ background: "var(--surface-2)" }}>
        <p className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: "var(--text-muted)" }}>Month timeline</p>
        <div className="grid grid-cols-12 gap-1">
          {Array.from({ length: 12 }, (_, i) => (
            <div key={i} className="h-6 rounded"
              style={{ background: i < 4 ? "var(--green)" : i === 4 ? "#f59e0b" : "var(--border)" }} />
          ))}
        </div>
        <div className="flex items-center justify-between mt-2 text-[10px]" style={{ color: "var(--text-muted)" }}>
          <span>Jan</span><span>Closed thru Apr</span><span>Dec</span>
        </div>
      </div>
    </MockShell>
  )
}

function PreviewReconciliations() {
  return (
    <MockShell title="Reconciliations" badge="AGENTIC">
      <div className="flex items-center gap-2 mb-3 text-[10px] font-bold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
        <span>Account</span>
        <span className="ml-auto">GL</span>
        <span className="w-12 text-right">SL</span>
        <span className="w-10 text-right">Var</span>
      </div>
      {[
        { name: "11000 · Operating Cash", gl: "$124.5K", sl: "$124.5K", var_: "$0",    status: "approved" },
        { name: "12000 · AR — Trade",     gl: "$48.2K",  sl: "$48.2K",  var_: "$0",    status: "approved" },
        { name: "20000 · AP — Trade",     gl: "$(61.0K)", sl: "$(61.0K)", var_: "$0",   status: "reviewed" },
        { name: "13500 · Prepaid Insurance", gl: "$8.4K",  sl: "$8.4K",   var_: "$0",   status: "approved" },
      ].map((r, i) => (
        <div key={i} className="flex items-center gap-2 py-2 text-[11px]" style={{ borderTop: i ? "1px solid var(--border)" : "none" }}>
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: r.status === "approved" ? "var(--green)" : "#f59e0b" }} />
          <span className="truncate flex-1" style={{ color: "var(--text)" }}>{r.name}</span>
          <span className="tabular-nums" style={{ color: "var(--text-2)" }}>{r.gl}</span>
          <span className="w-12 text-right tabular-nums" style={{ color: "var(--text-2)" }}>{r.sl}</span>
          <span className="w-10 text-right tabular-nums font-semibold" style={{ color: "var(--green)" }}>{r.var_}</span>
        </div>
      ))}
      <div className="mt-3 rounded-lg p-2.5 flex items-center gap-2 text-[11px]"
        style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
        <Sparkles size={11} strokeWidth={2} />
        <span className="font-semibold">Agentic Mode prepared 14 of 18 in 11 seconds</span>
      </div>
    </MockShell>
  )
}

function PreviewFlux() {
  return (
    <MockShell title="Flux Analysis" badge="AI">
      <div className="grid grid-cols-3 gap-2 mb-3 text-[10px] font-bold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
        <div>Account</div><div className="text-right">Apr 2026</div><div className="text-right">vs Mar</div>
      </div>
      {[
        { name: "Salaries & Wages",  cur: "$184.5K", chg: "+12.4%", red: true },
        { name: "AWS Hosting",       cur: "$24.8K",  chg: "+38.0%", red: true },
        { name: "Travel",            cur: "$6.1K",   chg: "−14.2%", red: false },
      ].map((r, i) => (
        <div key={i} className="grid grid-cols-3 gap-2 py-2 text-[11px] items-center"
          style={{ borderTop: i ? "1px solid var(--border)" : "none" }}>
          <span style={{ color: "var(--text)" }}>{r.name}</span>
          <span className="text-right tabular-nums" style={{ color: "var(--text-2)" }}>{r.cur}</span>
          <span className="text-right font-semibold tabular-nums"
            style={{ color: r.red ? "#dc2626" : "var(--green)" }}>{r.chg}</span>
        </div>
      ))}
      <div className="mt-3 rounded-lg p-3"
        style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
        <div className="flex items-center gap-1.5 mb-1">
          <Sparkles size={10} strokeWidth={2} style={{ color: "var(--green)" }} />
          <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: "var(--green)" }}>AI commentary</span>
        </div>
        <p className="text-[11px] leading-relaxed" style={{ color: "var(--text)" }}>
          <strong>AWS spike</strong> driven by 3 new EKS clusters + Q1 reserved-instance true-up.
          Includes 2 one-time charges totaling $4.2K. Normalized run-rate: $20.6K.
        </p>
      </div>
    </MockShell>
  )
}

function PreviewInsights() {
  return (
    <MockShell title="Insights" badge="DECIDE">
      <div className="grid grid-cols-2 gap-2 mb-3">
        {[
          { label: "Cash",     val: "$1.24M", sub: "+$120K MoM", color: "var(--text)" },
          { label: "Runway",   val: "14.2 mo", sub: "at burn $87K", color: "var(--green)" },
          { label: "DSO",      val: "42 days", sub: "watch", color: "#f59e0b" },
          { label: "Gross %",  val: "62.4%",  sub: "+1.2 pts",   color: "var(--green)" },
        ].map((k) => (
          <div key={k.label} className="rounded-lg p-2.5" style={{ background: "var(--surface-2)" }}>
            <p className="text-[9px] uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>{k.label}</p>
            <p className="text-base font-bold tabular-nums" style={{ color: k.color }}>{k.val}</p>
            <p className="text-[10px]" style={{ color: "var(--text-muted)" }}>{k.sub}</p>
          </div>
        ))}
      </div>
      <div className="rounded-lg p-3 flex items-start gap-2"
        style={{ background: "#fef2f2", border: "1px solid #fecaca" }}>
        <Lightbulb size={12} strokeWidth={2} style={{ color: "#dc2626" }} className="mt-0.5 shrink-0" />
        <div>
          <p className="text-[11px] font-bold" style={{ color: "#991b1b" }}>27% of AR is over 60 days old</p>
          <p className="text-[10px] mt-0.5" style={{ color: "#991b1b" }}>Concentration in 61–90 → escalate top 5.</p>
        </div>
      </div>
    </MockShell>
  )
}

function PreviewIntercompany() {
  return (
    <MockShell title="Intercompany" badge="AUTO">
      <p className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: "var(--text-muted)" }}>
        Suggested pairs · 2 matched
      </p>
      {[
        { left: "Nordavix US · 14000 IC Due From UK", right: "Nordavix UK · 21000 IC Due To US", amt: "$184.5K", match: true },
        { left: "Nordavix US · 14001 IC Due From CA", right: "Nordavix CA · 21001 IC Due To US", amt: "$62.0K",  match: true },
        { left: "Nordavix US · 14002 IC Due From IE", right: "—",                                amt: "$11.2K",  match: false },
      ].map((p, i) => (
        <div key={i} className="py-2.5" style={{ borderTop: i ? "1px solid var(--border)" : "none" }}>
          <div className="flex items-center gap-2 text-[11px] mb-1">
            <span className="flex-1 truncate" style={{ color: "var(--text)" }}>{p.left}</span>
            <ArrowLeftRight size={11} strokeWidth={2} style={{ color: p.match ? "var(--green)" : "#f59e0b" }} />
            <span className="flex-1 truncate text-right" style={{ color: p.match ? "var(--text)" : "var(--text-muted)" }}>{p.right}</span>
          </div>
          <div className="flex items-center justify-between text-[10px]">
            <span style={{ color: "var(--text-muted)" }}>Δ {p.match ? "$0" : "open"}</span>
            <span className="font-semibold tabular-nums" style={{ color: p.match ? "var(--green)" : "#f59e0b" }}>
              {p.match ? "✓ in balance" : "needs pair"}
            </span>
          </div>
        </div>
      ))}
    </MockShell>
  )
}

function PreviewFinancials() {
  return (
    <MockShell title="Financial Statements" badge="PDF">
      <p className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: "var(--text-muted)" }}>
        Income Statement · April 2026
      </p>
      <div className="space-y-1.5 text-[11px]">
        <div className="flex justify-between"><span style={{ color: "var(--text)" }}>Revenue</span><span className="tabular-nums" style={{ color: "var(--text)" }}>$842,150</span></div>
        <div className="flex justify-between pl-3"><span style={{ color: "var(--text-2)" }}>Cost of revenue</span><span className="tabular-nums" style={{ color: "var(--text-2)" }}>$(316,420)</span></div>
        <div className="flex justify-between font-bold pt-1" style={{ borderTop: "1px solid var(--border)" }}>
          <span style={{ color: "var(--text)" }}>Gross profit</span><span className="tabular-nums" style={{ color: "var(--green)" }}>$525,730</span>
        </div>
        <div className="flex justify-between pl-3"><span style={{ color: "var(--text-2)" }}>Operating expenses</span><span className="tabular-nums" style={{ color: "var(--text-2)" }}>$(298,440)</span></div>
        <div className="flex justify-between font-bold pt-1" style={{ borderTop: "1px solid var(--border)" }}>
          <span style={{ color: "var(--text)" }}>Operating income</span><span className="tabular-nums" style={{ color: "var(--green)" }}>$227,290</span>
        </div>
        <div className="flex justify-between font-bold pt-2" style={{ borderTop: "2px solid var(--border-strong)" }}>
          <span style={{ color: "var(--text)" }}>Net income</span><span className="tabular-nums" style={{ color: "var(--green)" }}>$181,832</span>
        </div>
      </div>
      <div className="mt-3 inline-flex items-center gap-1 text-[10px]" style={{ color: "var(--text-muted)" }}>
        <FileText size={10} strokeWidth={2} /> Big-4 style export ready
      </div>
    </MockShell>
  )
}

// ── Persona cards ────────────────────────────────────────────────────────────

const PERSONAS = [
  {
    role:   "Preparer",
    color:  "var(--green)",
    bg:     "var(--green-subtle)",
    wins:   [
      "Agentic Mode ties out routine accounts in seconds.",
      "Roll-forward chain inherits last month's opening automatically.",
      "Each row tells you the next action — no Excel context-switching.",
    ],
    closes: "8 days → 2 days",
  },
  {
    role:   "Reviewer",
    color:  "#6366f1",
    bg:     "#6366f120",
    wins:   [
      "Maker/checker enforced — you never approve your own work.",
      "AI commentary explains every material variance.",
      "Per-account PDFs ready to drop into the audit binder.",
    ],
    closes: "Same-day review",
  },
  {
    role:   "Controller / CPA",
    color:  "#f59e0b",
    bg:     "#fef3c7",
    wins:   [
      "Insights surfaces risks before the board call.",
      "Lock the period when ready — full audit trail attached.",
      "Multi-entity workspaces with role-based access.",
    ],
    closes: "Boardroom-ready",
  },
]

// ── AI capabilities ─────────────────────────────────────────────────────────

const AI_FEATURES = [
  {
    icon:  Sparkles,
    title: "Agentic Mode",
    blurb: "AI plays preparer — ties out subledger-to-GL, drafts notes for the gaps, hands you a Prepared row to approve.",
  },
  {
    icon:  Brain,
    title: "Flux Commentary",
    blurb: "Claude reads the GL detail behind each variance and explains the why — drivers, one-offs, mix shifts. With citations.",
  },
  {
    icon:  TrendingUp,
    title: "Insight Recommendations",
    blurb: "Heuristic-tuned risk scoring flags low runway, DSO drift, AR concentration, and expense spikes before they bite.",
  },
  {
    icon:  Zap,
    title: "Source verification",
    blurb: "Every AI claim is re-checked against a fresh QuickBooks pull so commentary doesn't drift on back-dated entries.",
  },
]

// ── Main page ────────────────────────────────────────────────────────────────

export function SolutionsPage() {
  // Scroll to top on mount (otherwise React Router preserves the previous
  // scroll position from the homepage which is jarring on a new page).
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [])

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "var(--bg)" }}>
      <SEO
        title="Solutions — the month-end close on one platform"
        description="Reconciliations, flux analysis, schedules, intercompany consolidation, financial package, and AI commentary. Tour every Nordavix app and how they connect into the close loop."
        path="/solutions"
        jsonLd={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Solutions", path: "/solutions" },
        ])}
      />
      <Navbar />

      {/* ── HERO ────────────────────────────────────────────────────── */}
      <header className="relative pt-32 sm:pt-40 pb-12 sm:pb-16 px-6 overflow-hidden">
        {/* Backdrop */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-0 left-1/4 w-[500px] h-[500px] rounded-full opacity-50 blur-3xl"
            style={{ background: "radial-gradient(circle, var(--green-subtle), transparent 70%)" }} />
          <div className="absolute top-1/2 right-1/4 w-[400px] h-[400px] rounded-full opacity-40 blur-3xl"
            style={{ background: "radial-gradient(circle, #6366f140, transparent 70%)" }} />
        </div>

        <div className="relative z-10 max-w-5xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium mb-6"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text-2)" }}>
            <Sparkles size={12} strokeWidth={2} style={{ color: "var(--green)" }} />
            Built for the modern controller
            <ChevronRight size={12} />
          </div>
          <h1 className="text-4xl sm:text-6xl lg:text-7xl font-bold leading-[1.05] tracking-tight mb-6" style={{ color: "var(--text)" }}>
            One platform.<br />
            <span style={{ color: "var(--green)" }}>The whole close.</span>
          </h1>
          <p className="text-base sm:text-lg lg:text-xl max-w-2xl mx-auto leading-relaxed mb-8" style={{ color: "var(--text-2)" }}>
            Reconciliations, flux, intercompany, financials, insights — every step of
            month-end in one tool, with AI doing the mechanical work so accountants can do the judgment work.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link to="/sign-up"
              className="inline-flex items-center gap-2 text-white font-semibold px-6 py-3 rounded-xl shadow-lg hover:opacity-90 transition-opacity"
              style={{ background: "var(--green)" }}>
              Start for free <ArrowRight size={14} strokeWidth={2} />
            </Link>
            <a href="#close-loop"
              className="inline-flex items-center gap-2 font-medium px-6 py-3 rounded-xl"
              style={{ background: "var(--surface)", border: "1px solid var(--border-strong)", color: "var(--text-2)" }}>
              See the workflow
            </a>
          </div>
        </div>
      </header>

      {/* ── THE CLOSE LOOP (creative element) ───────────────────────── */}
      <div id="close-loop">
        <CloseLoop />
      </div>

      {/* ── DEEP DIVES ──────────────────────────────────────────────── */}

      <DeepDive
        id="dashboard"
        eyebrow="Dashboard"
        title="The month-end command center"
        blurb="Sequential close gate, period tracker, open-task badge, recent activity — your whole team sees the same source of truth, scoped to the month they're closing."
        bullets={[
          "Sequential close: can't jump past an unfinished month.",
          "Live KPI tiles: open recons, variances, flux count, team load.",
          "Recent activity feed pulls from the audit log automatically.",
        ]}
        stat={{ value: "60 min", label: "saved per close on standups" }}
        preview={<PreviewDashboard />}
      />

      <DeepDive
        id="reconciliations"
        eyebrow="Reconciliations"
        title="Every balance sheet account, reconciled with proof"
        blurb="GL → Subledger for every reconcilable account type. AR/AP aging pulled live. Maker/checker enforced. Per-account PDFs auto-generated."
        flip
        bullets={[
          "Agentic Mode auto-ties subledger to GL where the math works.",
          "Roll-forward chain inherits prior-month opening balances.",
          "Per-account PDF: tabular working paper, no manual formatting.",
          "Period close locks the books with full audit trail.",
        ]}
        stat={{ value: "11s", label: "to prepare 14 routine accounts" }}
        preview={<PreviewReconciliations />}
      />

      <DeepDive
        id="flux"
        eyebrow="Flux Analysis"
        title="Variance commentary written for you"
        blurb="Claude reads the GL detail behind each material variance and writes the explanation a controller would — drivers, one-offs, mix shifts, normalized run-rate."
        bullets={[
          "Material variances surface first; trivial ones stay quiet.",
          "AI explains the WHY with transaction-level evidence.",
          "Custom date ranges (month, quarter, YTD, last 30, last 90).",
          "Approver workflow + memo capture per analysis.",
        ]}
        stat={{ value: "6 hours", label: "saved per flux deck" }}
        preview={<PreviewFlux />}
      />

      <DeepDive
        id="insights"
        eyebrow="Insights"
        title="Decisions, not dashboards"
        blurb="Liquidity, AR/AP, profitability, expense monitoring — each KPI comes with a Value, Risk grade, and Insight so you know what to do, not just what happened."
        flip
        bullets={[
          "Risk-graded KPIs: runway, DSO, DPO, margins, aging concentration.",
          "Heuristic recommendations: 'tighten collections', 'investigate spike'.",
          "Interactive sparklines — click a point to time-travel.",
          "Custom date ranges go live to QuickBooks ProfitAndLoss.",
        ]}
        stat={{ value: "0 dashboards", label: "to build manually" }}
        preview={<PreviewInsights />}
      />

      <DeepDive
        id="intercompany"
        eyebrow="Intercompany"
        title="IC pairs detected. Imbalances flagged."
        blurb="Auto-classifies intercompany accounts by name + chart-of-accounts convention, then suggests counterparty pairs across entities. Mismatches surface before close."
        bullets={[
          "Counterparty inference from account name (Due From / Due To).",
          "Pair-balance check — flags any side that doesn't tie.",
          "Empty-state for non-IC companies (one entity, no clutter).",
        ]}
        stat={{ value: "Multi-entity", label: "ready out of the box" }}
        preview={<PreviewIntercompany />}
      />

      <DeepDive
        id="financials"
        eyebrow="Financial Statements"
        title="GAAP-clean IS & BS — instant"
        blurb="Built from your synced GL snapshot. On-screen review with proper subtotals. One-click Big-4-style PDF export with cover page, footnotes, and signatures block."
        flip
        bullets={[
          "Income Statement with GAAP subtotals (GP, OI, NI).",
          "Balance Sheet with assets/liab/equity sections + cross-check.",
          "Internal source (Nordavix synced) vs. live QBO source — toggle.",
          "Branded PDF — your company name, your period, your footer.",
        ]}
        stat={{ value: "1 click", label: "to a board-ready package" }}
        preview={<PreviewFinancials />}
      />

      {/* ── CONNECT — small section, no preview (covered above) ─────── */}
      <section id="connect" className="px-6 py-16">
        <div className="max-w-6xl mx-auto rounded-2xl p-8 sm:p-12 text-center"
          style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold uppercase tracking-wider mb-3"
            style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
            Connect
          </span>
          <h2 className="text-2xl sm:text-3xl font-bold mb-3" style={{ color: "var(--text)" }}>
            QuickBooks in 30 seconds. Read-only.
          </h2>
          <p className="text-base max-w-2xl mx-auto" style={{ color: "var(--text-2)" }}>
            OAuth flow you've done before. We never write to your books — every action
            in Nordavix lives in our database, never pushed back to QBO unless you explicitly choose to.
          </p>
        </div>
      </section>

      {/* ── PERSONAS ────────────────────────────────────────────────── */}
      <section className="px-6 py-20 sm:py-24" style={{ background: "var(--surface-2)" }}>
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-12">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium mb-4"
              style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text-2)" }}>
              <Users size={12} strokeWidth={2} />
              Built for every role at close
            </div>
            <h2 className="text-3xl sm:text-5xl font-bold leading-tight" style={{ color: "var(--text)" }}>
              Whoever you are at month-end,<br />
              <span style={{ color: "var(--green)" }}>Nordavix has your back.</span>
            </h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {PERSONAS.map((p) => (
              <motion.div key={p.role}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.4 }}
                className="rounded-2xl p-6"
                style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
                <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold uppercase tracking-wider mb-4"
                  style={{ background: p.bg, color: p.color }}>
                  {p.role}
                </div>
                <ul className="space-y-3 mb-5">
                  {p.wins.map((w, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm" style={{ color: "var(--text)" }}>
                      <CheckCircle2 size={14} strokeWidth={2} className="shrink-0 mt-0.5" style={{ color: p.color }} />
                      {w}
                    </li>
                  ))}
                </ul>
                <div className="pt-4 flex items-center justify-between" style={{ borderTop: "1px solid var(--border)" }}>
                  <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
                    Typical close
                  </span>
                  <span className="text-sm font-bold" style={{ color: p.color }}>{p.closes}</span>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ── AI EVERYWHERE ───────────────────────────────────────────── */}
      <section className="px-6 py-20 sm:py-24">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-12">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium mb-4"
              style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
              <Sparkles size={12} strokeWidth={2} />
              AI runs through the whole stack
            </div>
            <h2 className="text-3xl sm:text-5xl font-bold leading-tight mb-4" style={{ color: "var(--text)" }}>
              Not a chatbot bolted on the side.
            </h2>
            <p className="text-base sm:text-lg max-w-2xl mx-auto" style={{ color: "var(--text-2)" }}>
              AI is wired into reconciliations, flux, and insights — automating the mechanical work
              and surfacing the judgment calls only humans can make.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {AI_FEATURES.map((f, i) => {
              const Icon = f.icon
              return (
                <motion.div key={f.title}
                  initial={{ opacity: 0, x: i % 2 === 0 ? -12 : 12 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.4, delay: i * 0.05 }}
                  className="rounded-xl p-5 flex items-start gap-4"
                  style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
                  <span className="h-10 w-10 rounded-lg flex items-center justify-center shrink-0"
                    style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
                    <Icon size={18} strokeWidth={1.8} />
                  </span>
                  <div className="flex-1">
                    <h3 className="text-base font-bold mb-1" style={{ color: "var(--text)" }}>{f.title}</h3>
                    <p className="text-sm leading-relaxed" style={{ color: "var(--text-2)" }}>{f.blurb}</p>
                  </div>
                </motion.div>
              )
            })}
          </div>
        </div>
      </section>

      {/* ── STATS ───────────────────────────────────────────────────── */}
      <section className="px-6 py-20" style={{ background: "var(--surface-2)" }}>
        <div className="max-w-6xl mx-auto grid grid-cols-2 md:grid-cols-4 gap-6 text-center">
          {[
            { val: "8 days → 2",     label: "average close compression" },
            { val: "100%",            label: "audit-trailed" },
            { val: "<60s",            label: "from sync to dashboard" },
            { val: "9 apps",          label: "in one workflow" },
          ].map((s, i) => (
            <motion.div key={i}
              initial={{ opacity: 0, y: 8 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.3, delay: i * 0.05 }}
            >
              <p className="text-3xl sm:text-5xl font-bold mb-1" style={{ color: "var(--green)" }}>{s.val}</p>
              <p className="text-xs sm:text-sm" style={{ color: "var(--text-2)" }}>{s.label}</p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* ── FINAL CTA ───────────────────────────────────────────────── */}
      <section className="px-6 py-24">
        <div className="max-w-4xl mx-auto rounded-3xl p-10 sm:p-14 text-center relative overflow-hidden"
          style={{ background: "var(--green)" }}>
          <div className="absolute inset-0 pointer-events-none opacity-30"
            style={{
              backgroundImage:
                "radial-gradient(circle at 20% 20%, rgba(255,255,255,0.4), transparent 50%), radial-gradient(circle at 80% 80%, rgba(255,255,255,0.3), transparent 50%)",
            }} />
          <div className="relative z-10">
            <h2 className="text-3xl sm:text-5xl font-bold text-white leading-tight mb-4">
              Stop firefighting close.<br />
              Start closing in hours.
            </h2>
            <p className="text-base sm:text-lg text-white/90 max-w-2xl mx-auto mb-7">
              Free during early access. No credit card. Connect QuickBooks and see your
              April close run in under five minutes.
            </p>
            <div className="flex flex-col sm:flex-row justify-center gap-3">
              <Link to="/sign-up"
                className="inline-flex items-center justify-center gap-2 bg-white font-semibold px-7 py-3 rounded-xl shadow-xl hover:opacity-95 transition-opacity"
                style={{ color: "var(--green)" }}>
                Get started free <ArrowRight size={14} />
              </Link>
              <Link to="/"
                className="inline-flex items-center justify-center gap-2 font-medium px-7 py-3 rounded-xl text-white"
                style={{ background: "rgba(255,255,255,0.15)", border: "1px solid rgba(255,255,255,0.3)" }}>
                Back to home
              </Link>
            </div>
            <div className="mt-7 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-[11px] text-white/80">
              <span className="inline-flex items-center gap-1"><ShieldCheck size={11} /> Read-only QBO scope</span>
              <span className="inline-flex items-center gap-1"><BookOpen size={11} /> SOC 2 (planned)</span>
              <span className="inline-flex items-center gap-1"><CheckSquare size={11} /> Audit-log on every action</span>
            </div>
          </div>
        </div>
      </section>

      <MarketingFooter />
    </div>
  )
}
