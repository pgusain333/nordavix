import { useEffect, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { useUser } from "@clerk/clerk-react"
import {
  Zap, Shield, FileSpreadsheet, CheckCircle2, ArrowRight,
  BarChart3, Clock, Lock, ChevronRight, Star, TrendingUp,
  Brain, Download, Upload, Eye, Sparkles,
} from "lucide-react"
import { ThemeToggle } from "@/core/theme/ThemeToggle"

// ── Scroll-reveal hook ────────────────────────────────────────────────────────
function useInView(threshold = 0.15) {
  const ref = useRef<HTMLDivElement>(null)
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

// ── Animated counter ──────────────────────────────────────────────────────────
function Counter({ to, suffix = "" }: { to: number; suffix?: string }) {
  const [count, setCount] = useState(0)
  const { ref, inView } = useInView(0.3)
  useEffect(() => {
    if (!inView) return
    let start = 0
    const step = Math.ceil(to / 40)
    const timer = setInterval(() => {
      start += step
      if (start >= to) { setCount(to); clearInterval(timer) }
      else setCount(start)
    }, 30)
    return () => clearInterval(timer)
  }, [inView, to])
  return <span ref={ref}>{count}{suffix}</span>
}

// ── Flow arrow (light version for light hero) ────────────────────────────────
function FlowArrow() {
  return (
    <div className="flex items-center flex-shrink-0 w-12 md:w-20">
      <svg viewBox="0 0 80 20" className="w-full h-5 overflow-visible">
        <defs>
          <linearGradient id="arrowGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#3b82f6" stopOpacity="0" />
            <stop offset="50%" stopColor="#2563eb" stopOpacity="0.8" />
            <stop offset="100%" stopColor="#7c3aed" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d="M 0 10 H 70" stroke="#cbd5e1" strokeWidth="1.5" strokeDasharray="4 4" fill="none" />
        <path
          d="M 0 10 H 70"
          stroke="url(#arrowGrad)"
          strokeWidth="2"
          strokeDasharray="30 90"
          fill="none"
          style={{ animation: "flow-dash 1.8s linear infinite" }}
        />
        <polygon points="70,6 80,10 70,14" fill="#3b82f6" opacity="0.7" />
      </svg>
    </div>
  )
}

// ── Hero flow diagram (light cards) ──────────────────────────────────────────
function HeroFlow() {
  const [typed, setTyped] = useState("")
  const narrative = "Revenue increased $256K (+12%) vs prior period, driven by strong Q4 seasonal demand in the enterprise segment."
  useEffect(() => {
    let i = 0
    const t = setInterval(() => {
      i++
      setTyped(narrative.slice(0, i))
      if (i >= narrative.length) { clearInterval(t); setTimeout(() => setTyped(""), 3000) }
    }, 38)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    if (typed === "") {
      let i = 0
      const t = setInterval(() => {
        i++
        setTyped(narrative.slice(0, i))
        if (i >= narrative.length) clearInterval(t)
      }, 38)
      return () => clearInterval(t)
    }
  }, [typed])

  return (
    <div className="relative flex flex-col md:flex-row items-center justify-center gap-2 md:gap-0 mt-12 md:mt-16 px-4">
      {/* ── Card 1: Trial Balance ── */}
      <div
        className="bg-white border border-slate-200 shadow-xl rounded-2xl p-4 w-56 flex-shrink-0 animate-float-up z-10"
        style={{ animationDelay: "0s" }}
      >
        <div className="flex items-center gap-2 mb-3">
          <FileSpreadsheet className="w-4 h-4 text-blue-600" />
          <span className="text-xs font-semibold text-slate-800">Trial Balance</span>
        </div>
        <div className="text-[10px] text-slate-400 mb-2">Dec 2024 vs Nov 2024</div>
        {[
          { name: "Revenue", cur: "$2,456K", var: "+12%", fav: true },
          { name: "COGS", cur: "$1,124K", var: "+9%", fav: false },
          { name: "OpEx", cur: "$820K", var: "+13%", fav: false },
          { name: "Net Income", cur: "$512K", var: "+17%", fav: true },
        ].map((row) => (
          <div key={row.name} className="flex items-center justify-between py-1 border-b border-slate-100 last:border-0">
            <span className="text-[10px] text-slate-600">{row.name}</span>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-mono text-slate-800">{row.cur}</span>
              <span className={`text-[9px] font-mono px-1 rounded ${row.fav ? "text-fav bg-fav/10" : "text-unfav bg-unfav/10"}`}>
                {row.var}
              </span>
            </div>
          </div>
        ))}
      </div>

      <FlowArrow />

      {/* ── Card 2: AI Engine ── */}
      <div className="bg-white border border-blue-100 shadow-xl rounded-2xl p-5 w-44 flex-shrink-0 z-10">
        <div className="flex flex-col items-center gap-3">
          <div className="relative">
            <div className="w-12 h-12 rounded-full bg-blue-50 border border-blue-100 flex items-center justify-center animate-glow-pulse">
              <Brain className="w-6 h-6 text-blue-600" />
            </div>
            <div className="absolute -top-1 -right-1 w-4 h-4 bg-purple-500 rounded-full flex items-center justify-center">
              <Sparkles className="w-2.5 h-2.5 text-white" />
            </div>
          </div>
          <div className="text-center">
            <div className="text-xs font-semibold text-slate-800 mb-0.5">AI Analysis</div>
            <div className="text-[10px] text-slate-400">claude-sonnet-4-6</div>
          </div>
          <div className="w-full">
            <div className="flex justify-between text-[9px] text-slate-400 mb-1">
              <span>Processing</span>
              <span className="text-blue-600">247 accounts</span>
            </div>
            <div className="w-full h-1 bg-slate-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-blue-500 to-purple-500 rounded-full"
                style={{ animation: "processing-bar 2.5s ease-in-out infinite alternate", width: "85%" }}
              />
            </div>
          </div>
          <div className="flex gap-1">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="w-1.5 h-1.5 rounded-full bg-blue-500"
                style={{ animation: `bounce 0.8s ease-in-out ${i * 0.15}s infinite alternate` }}
              />
            ))}
          </div>
        </div>
      </div>

      <FlowArrow />

      {/* ── Card 3: Flux Commentary ── */}
      <div
        className="bg-white border border-slate-200 shadow-xl rounded-2xl p-4 w-56 flex-shrink-0 animate-float-down z-10"
        style={{ animationDelay: "2s" }}
      >
        <div className="flex items-center gap-2 mb-3">
          <TrendingUp className="w-4 h-4 text-fav" />
          <span className="text-xs font-semibold text-slate-800">Flux Commentary</span>
          <span className="ml-auto text-[9px] bg-fav/10 text-fav px-1.5 py-0.5 rounded-full font-medium">+12%</span>
        </div>
        <div className="text-[10px] text-slate-500 mb-2 font-medium">Revenue · Material Variance</div>
        <div className="text-[10px] text-slate-700 leading-relaxed min-h-[60px]">
          {typed}
          <span className="inline-block w-0.5 h-3 bg-blue-500 ml-0.5 animate-type-cursor align-middle" />
        </div>
        <div className="mt-3 flex items-center gap-1.5">
          <div className="w-1.5 h-1.5 rounded-full bg-fav animate-pulse" />
          <span className="text-[9px] text-slate-400">AI confidence: High</span>
        </div>
      </div>
    </div>
  )
}

// ── Navbar ────────────────────────────────────────────────────────────────────
function Navbar() {
  const [scrolled, setScrolled] = useState(false)
  const { isSignedIn } = useUser()

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20)
    window.addEventListener("scroll", onScroll)
    return () => window.removeEventListener("scroll", onScroll)
  }, [])

  return (
    <nav className={`fixed top-0 inset-x-0 z-50 transition-all duration-300 ${
      scrolled
        ? "backdrop-blur-md border-b border-slate-100 dark:border-slate-800 shadow-sm py-3"
        : "backdrop-blur-sm py-5"
    }`}
      style={{ background: scrolled ? "var(--surface)" : "transparent" }}
    >
      <div className="max-w-6xl mx-auto px-6 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <img src="/logo-mark-light.svg" alt="Nordavix" className="h-8 w-8 dark:hidden" />
          <img src="/logo-mark-dark.svg"  alt="Nordavix" className="h-8 w-8 hidden dark:block" />
          <span className="font-bold text-lg tracking-tight text-theme">nordavix<span style={{ color: "var(--green)" }}>.</span></span>
        </div>
        <div className="hidden md:flex items-center gap-8">
          {[
            { label: "Features", href: "#features" },
            { label: "How it works", href: "#how-it-works" },
            { label: "Pricing", href: "#pricing" },
          ].map((item) => (
            <a key={item.label} href={item.href}
              className="text-sm transition-colors"
              style={{ color: "var(--text-2)" }}
              onMouseEnter={e => (e.currentTarget.style.color = "var(--text)")}
              onMouseLeave={e => (e.currentTarget.style.color = "var(--text-2)")}
            >
              {item.label}
            </a>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <ThemeToggle />
          {isSignedIn ? (
            <Link
              to="/app"
              className="text-sm font-semibold text-white px-4 py-2 rounded-lg transition-opacity hover:opacity-90"
              style={{ background: "var(--green)" }}
            >
              Dashboard →
            </Link>
          ) : (
            <>
              <Link to="/app"
                className="hidden md:block text-sm transition-colors px-4 py-2"
                style={{ color: "var(--text-2)" }}
                onMouseEnter={e => (e.currentTarget.style.color = "var(--text)")}
                onMouseLeave={e => (e.currentTarget.style.color = "var(--text-2)")}
              >
                Sign in
              </Link>
              <Link
                to="/app"
                className="text-sm font-semibold text-white px-4 py-2 rounded-lg transition-opacity hover:opacity-90"
                style={{ background: "var(--green)" }}
              >
                Get started free
              </Link>
            </>
          )}
        </div>
      </div>
    </nav>
  )
}

// ── Hero (light gradient) ─────────────────────────────────────────────────────
function HeroSection() {
  return (
    <section className="relative min-h-screen flex flex-col items-center justify-center overflow-hidden pt-20 pb-12 px-6 bg-gradient-to-b from-blue-50/70 via-white to-white">
      {/* Soft background orbs */}
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-blue-100/80 rounded-full blur-[120px] animate-blob pointer-events-none" />
      <div className="absolute bottom-1/4 right-1/4 w-80 h-80 bg-purple-100/70 rounded-full blur-[100px] animate-blob-delay pointer-events-none" />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-64 h-64 bg-blue-50 rounded-full blur-[80px] animate-blob pointer-events-none" style={{ animationDelay: "8s" }} />

      {/* Content */}
      <div className="relative z-10 text-center max-w-4xl mx-auto">
        <div className="inline-flex items-center gap-2 bg-blue-50 border border-blue-100 px-4 py-1.5 rounded-full text-xs font-medium text-blue-700 mb-6 animate-fade-in-up">
          <Sparkles className="w-3 h-3" />
          AI-native month-end close platform
          <ChevronRight className="w-3 h-3" />
        </div>

        <h1 className="text-5xl md:text-7xl font-bold text-slate-900 leading-[1.05] tracking-tight mb-6 animate-fade-in-up animation-delay-200">
          Month-end close,{" "}
          <span className="text-gradient">automated.</span>
        </h1>

        <p className="text-lg md:text-xl text-slate-600 max-w-2xl mx-auto leading-relaxed mb-8 animate-fade-in-up animation-delay-400">
          Nordavix generates AI-powered flux commentary from your trial balance in minutes.
          Built for controllers who want their lives back at close.
        </p>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-4 animate-fade-in-up animation-delay-700">
          <Link
            to="/app"
            className="group flex items-center gap-2 text-white font-semibold px-8 py-3.5 rounded-xl transition-opacity hover:opacity-90 shadow-lg text-base"
            style={{ background: "var(--green)" }}
          >
            Start for free
            <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
          </Link>
          <a
            href="#how-it-works"
            className="flex items-center gap-2 font-medium px-8 py-3.5 rounded-xl transition-all duration-200 shadow-sm text-base"
            style={{ background: "var(--surface)", border: "1px solid var(--border-strong)", color: "var(--text-2)" }}
            onMouseEnter={e => (e.currentTarget.style.color = "var(--text)")}
            onMouseLeave={e => (e.currentTarget.style.color = "var(--text-2)")}
          >
            See how it works
          </a>
        </div>

        <p className="text-xs text-slate-400 animate-fade-in-up animation-delay-1000">
          No credit card required · SOC 2 compliant · Free trial
        </p>
      </div>

      <div className="relative z-10 w-full max-w-3xl mx-auto animate-fade-in-up animation-delay-700">
        <HeroFlow />
      </div>

      <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 text-slate-400 animate-bounce">
        <div className="w-5 h-8 border border-slate-300 rounded-full flex items-start justify-center pt-1.5">
          <div className="w-1 h-2 bg-slate-400 rounded-full animate-bounce animation-delay-200" />
        </div>
      </div>
    </section>
  )
}

// ── Stats bar (solid blue strip) ──────────────────────────────────────────────
function StatsBar() {
  const { ref, inView } = useInView()
  return (
    <section ref={ref} className="py-12 px-6" style={{ background: "var(--green)" }}>
      <div className="max-w-5xl mx-auto grid grid-cols-2 md:grid-cols-4 gap-8">
        {[
          { value: 90, suffix: "%", label: "Time saved on flux commentary" },
          { value: 100, suffix: "%", label: "Account coverage, no exceptions" },
          { value: 5, suffix: " min", label: "Average processing time" },
          { value: 0, suffix: " leaks", label: "Client data exposed to AI" },
        ].map((stat) => (
          <div key={stat.label} className="text-center">
            <div
              className={`text-3xl font-bold text-white mb-1 transition-all duration-700 ${inView ? "opacity-100" : "opacity-0 translate-y-4"}`}
            >
              {inView ? <Counter to={stat.value} suffix={stat.suffix} /> : `0${stat.suffix}`}
            </div>
            <div className="text-xs leading-snug" style={{ color: "rgba(255,255,255,0.75)" }}>{stat.label}</div>
          </div>
        ))}
      </div>
    </section>
  )
}

// ── Features (white, light cards) ────────────────────────────────────────────
const FEATURES = [
  {
    icon: Zap,
    title: "Instant flux analysis",
    description: "Upload your trial balance and receive AI-generated variance narratives for every material account within minutes. No templates. No manual work.",
    iconColor: "text-yellow-500",
    iconBg: "bg-yellow-50 border border-yellow-100",
  },
  {
    icon: Brain,
    title: "Accounting-grade AI",
    description: "Built on Claude claude-sonnet-4-6. The model is prompted like a senior accountant — concise, accurate, using standard close language controllers actually use.",
    iconColor: "text-blue-600",
    iconBg: "bg-blue-50 border border-blue-100",
  },
  {
    icon: Eye,
    title: "Smart anomaly detection",
    description: "Automatically flags new accounts, dormant accounts reactivated, sign flips, and large percentage changes. Never miss a surprise at close again.",
    iconColor: "text-purple-600",
    iconBg: "bg-purple-50 border border-purple-100",
  },
  {
    icon: Shield,
    title: "Privacy by design",
    description: "Client data never leaves your tenant. Anthropic API calls strip identifying information before transmission. Audit log for every action — SOC 2 ready from day one.",
    iconColor: "text-green-600",
    iconBg: "bg-green-50 border border-green-100",
  },
  {
    icon: CheckCircle2,
    title: "Review & approve workflow",
    description: "Built-in variance review table with inline editing, batch approvals, and per-account audit trail. Review in the app, not in your inbox.",
    iconColor: "text-cyan-600",
    iconBg: "bg-cyan-50 border border-cyan-100",
  },
  {
    icon: Download,
    title: "Production-grade Excel export",
    description: "Download a formatted close package — parentheses for negatives, tabular numbers, freeze panes, conditional materiality formatting. Looks like a controller built it.",
    iconColor: "text-orange-500",
    iconBg: "bg-orange-50 border border-orange-100",
  },
]

function FeaturesSection() {
  const { ref, inView } = useInView(0.1)
  return (
    <section id="features" className="py-24 px-6 bg-white">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-16">
          <div className="inline-flex items-center gap-2 text-blue-600 text-xs font-semibold uppercase tracking-widest mb-4">
            <div className="w-4 h-px bg-blue-600" />
            Features
            <div className="w-4 h-px bg-blue-600" />
          </div>
          <h2 className="text-3xl md:text-5xl font-bold text-slate-900 mb-4 tracking-tight">
            Everything you need to{" "}
            <span className="text-gradient">close faster</span>
          </h2>
          <p className="text-slate-500 max-w-xl mx-auto">
            Nordavix handles the analysis so your team can focus on decisions, not documentation.
          </p>
        </div>

        <div ref={ref} className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {FEATURES.map((f, i) => {
            const Icon = f.icon
            return (
              <div
                key={f.title}
                className={`bg-white border border-slate-100 rounded-2xl p-6 shadow-sm hover:shadow-md hover:border-slate-200 transition-all duration-500 group ${inView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"}`}
                style={{ transitionDelay: `${i * 80}ms` }}
              >
                <div className={`w-10 h-10 rounded-xl ${f.iconBg} flex items-center justify-center mb-4 group-hover:scale-110 transition-transform`}>
                  <Icon className={`w-5 h-5 ${f.iconColor}`} />
                </div>
                <h3 className="font-semibold text-slate-900 mb-2">{f.title}</h3>
                <p className="text-sm text-slate-500 leading-relaxed">{f.description}</p>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

// ── How it works (light gray) ─────────────────────────────────────────────────
const STEPS = [
  {
    num: "01",
    icon: Upload,
    title: "Upload your trial balance",
    description: "Drop in your Excel or CSV. We handle any column format with a configurable mapping screen — no reformatting required.",
    color: "from-blue-600 to-blue-400",
    shadow: "shadow-blue-100",
  },
  {
    num: "02",
    icon: BarChart3,
    title: "AI calculates every variance",
    description: "Dollar and percentage variances calculated instantly. Material accounts identified against your threshold. Anomalies flagged automatically.",
    color: "from-purple-600 to-purple-400",
    shadow: "shadow-purple-100",
  },
  {
    num: "03",
    icon: Eye,
    title: "Review AI narratives",
    description: "Open the variance review table. Approve AI commentary as-is, edit inline, or regenerate. Full audit trail on every change.",
    color: "from-cyan-600 to-cyan-400",
    shadow: "shadow-cyan-100",
  },
  {
    num: "04",
    icon: Download,
    title: "Export your close package",
    description: "Download a formatted Excel file with your narratives, anomaly flags, and materiality summary — ready to drop into your close deck.",
    color: "from-green-600 to-green-400",
    shadow: "shadow-green-100",
  },
]

function HowItWorksSection() {
  const { ref, inView } = useInView(0.1)
  return (
    <section id="how-it-works" className="py-24 px-6 bg-slate-50">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-16">
          <div className="inline-flex items-center gap-2 text-purple-600 text-xs font-semibold uppercase tracking-widest mb-4">
            <div className="w-4 h-px bg-purple-600" />
            How it works
            <div className="w-4 h-px bg-purple-600" />
          </div>
          <h2 className="text-3xl md:text-5xl font-bold text-slate-900 mb-4 tracking-tight">
            From upload to report{" "}
            <span className="text-gradient">in four steps</span>
          </h2>
          <p className="text-slate-500 max-w-xl mx-auto">
            A workflow designed around how controllers actually work — not around how software engineers think they work.
          </p>
        </div>

        <div ref={ref} className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 relative">
          <div className="hidden lg:block absolute top-10 left-[12.5%] right-[12.5%] h-px bg-gradient-to-r from-slate-200/0 via-slate-200 to-slate-200/0" />

          {STEPS.map((step, i) => {
            const Icon = step.icon
            return (
              <div
                key={step.num}
                className={`relative flex flex-col items-center text-center transition-all duration-700 ${inView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-10"}`}
                style={{ transitionDelay: `${i * 150}ms` }}
              >
                <div className={`relative w-20 h-20 rounded-2xl bg-gradient-to-br ${step.color} flex items-center justify-center mb-5 shadow-lg ${step.shadow} z-10`}>
                  <Icon className="w-8 h-8 text-white" />
                  <div className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-white border border-slate-200 shadow-sm flex items-center justify-center text-[10px] font-bold text-slate-500">
                    {step.num.slice(-1)}
                  </div>
                </div>
                <h3 className="font-semibold text-slate-900 mb-2 text-sm">{step.title}</h3>
                <p className="text-xs text-slate-500 leading-relaxed">{step.description}</p>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

// ── Product preview (DARK — makes product UI pop) ─────────────────────────────
function ProductPreviewSection() {
  const { ref, inView } = useInView(0.1)
  return (
    <section className="py-24 px-6 bg-slate-900">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-12">
          <h2 className="text-3xl md:text-5xl font-bold text-white mb-4 tracking-tight">
            The variance table{" "}
            <span className="text-gradient">is the product</span>
          </h2>
          <p className="text-slate-400 max-w-xl mx-auto">
            Built on accounting visual conventions — parentheses for negatives, tabular numbers, red/green for variances. It looks like a controller built it.
          </p>
        </div>

        <div
          ref={ref}
          className={`glass rounded-2xl overflow-hidden glow-blue transition-all duration-1000 ${inView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-12"}`}
        >
          <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-800/80 bg-slate-900/60">
            <div className="w-3 h-3 rounded-full bg-red-500/60" />
            <div className="w-3 h-3 rounded-full bg-yellow-500/60" />
            <div className="w-3 h-3 rounded-full bg-green-500/60" />
            <span className="ml-3 text-xs text-slate-500 font-mono">Nordavix · Flux Analysis · Dec 2024</span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-800/60 bg-slate-900/40">
                  {["Account", "Current", "Prior", "$ Variance", "% Var", "Status", "AI Narrative"].map((h) => (
                    <th key={h} className="text-left text-slate-500 font-medium px-4 py-3 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  { acc: "5100 · Revenue", cur: "2,456,000", pri: "2,200,000", dvar: "256,000", pvar: "11.6%", status: "Approved", statusColor: "text-fav bg-fav/10", fav: true, narr: "Revenue increased $256K (+12%) vs prior period, driven by strong Q4 seasonal demand in the enterprise segment..." },
                  { acc: "6100 · COGS", cur: "1,124,000", pri: "1,032,000", dvar: "(92,000)", pvar: "(8.9%)", status: "Pending", statusColor: "text-yellow-400 bg-yellow-400/10", fav: false, narr: "COGS increased $92K (+9%) consistent with revenue growth. Gross margin remained stable at 54.2%..." },
                  { acc: "7200 · Salaries", cur: "542,000", pri: "510,000", dvar: "(32,000)", pvar: "(6.3%)", status: "Edited", statusColor: "text-blue-400 bg-blue-400/10", fav: false, narr: "Salaries increased $32K due to Q4 bonus accruals and two new hires in the engineering team..." },
                  { acc: "5200 · Other Revenue", cur: "12,400", pri: "0", dvar: "12,400", pvar: "N/M", status: "Flagged", statusColor: "text-orange-400 bg-orange-400/10", fav: true, narr: "New account — no prior period balance. One-time consulting revenue. Review with FP&A." },
                ].map((row, i) => (
                  <tr key={i} className="border-b border-slate-800/40 hover:bg-slate-800/30 transition-colors">
                    <td className="px-4 py-3 text-slate-300 whitespace-nowrap font-mono">{row.acc}</td>
                    <td className="px-4 py-3 text-slate-300 font-mono text-right whitespace-nowrap tabular-nums">{row.cur}</td>
                    <td className="px-4 py-3 text-slate-500 font-mono text-right whitespace-nowrap tabular-nums">{row.pri}</td>
                    <td className={`px-4 py-3 font-mono text-right whitespace-nowrap tabular-nums ${row.fav ? "text-fav" : "text-unfav"}`}>{row.dvar}</td>
                    <td className={`px-4 py-3 font-mono text-right whitespace-nowrap ${row.fav ? "text-fav" : "text-unfav"}`}>{row.pvar}</td>
                    <td className="px-4 py-3">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${row.statusColor}`}>{row.status}</span>
                    </td>
                    <td className="px-4 py-3 text-slate-400 max-w-xs truncate">{row.narr}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between px-4 py-2 border-t border-slate-800/60 bg-slate-900/40">
            <span className="text-[10px] text-slate-600">4 material variances · 2 anomalies detected · 1 awaiting review</span>
            <button className="text-[10px] text-white px-3 py-1 rounded-md transition-opacity hover:opacity-90"
              style={{ background: "var(--green)" }}>
              Export Excel
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}

// ── Comparison (white, light table) ──────────────────────────────────────────
function ComparisonSection() {
  const { ref, inView } = useInView(0.1)
  const rows = [
    { feature: "Automated variance calculation", manual: false, checklist: true, nordavix: true },
    { feature: "AI-generated narratives", manual: false, checklist: false, nordavix: true },
    { feature: "Anomaly detection", manual: false, checklist: false, nordavix: true },
    { feature: "100% account coverage", manual: false, checklist: true, nordavix: true },
    { feature: "Inline narrative editing", manual: true, checklist: false, nordavix: true },
    { feature: "Audit trail per change", manual: false, checklist: true, nordavix: true },
    { feature: "Export-ready Excel", manual: true, checklist: true, nordavix: true },
    { feature: "Built for accountants", manual: true, checklist: true, nordavix: true },
  ]
  return (
    <section className="py-24 px-6 bg-white">
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-12">
          <h2 className="text-3xl md:text-4xl font-bold text-slate-900 mb-4 tracking-tight">
            Why Nordavix vs the alternatives
          </h2>
          <p className="text-slate-500">
            Checklist tools help you track. Nordavix actually does the work.
          </p>
        </div>

        <div
          ref={ref}
          className={`bg-white border border-slate-100 rounded-2xl overflow-hidden shadow-sm transition-all duration-700 ${inView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"}`}
        >
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50">
                <th className="text-left px-6 py-4 text-slate-500 font-medium w-1/2">Capability</th>
                <th className="text-center px-4 py-4 text-slate-500 font-medium">Manual</th>
                <th className="text-center px-4 py-4 text-slate-500 font-medium">Checklist tools</th>
                <th className="text-center px-4 py-4 font-semibold">
                  <span className="text-gradient">Nordavix</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.feature} className="border-b border-slate-50 hover:bg-slate-50/50 transition-colors">
                  <td className="px-6 py-3 text-slate-700">{row.feature}</td>
                  {[row.manual, row.checklist, row.nordavix].map((val, j) => (
                    <td key={j} className="text-center px-4 py-3">
                      {val
                        ? <CheckCircle2 className={`w-4 h-4 mx-auto ${j === 2 ? "text-[var(--green)]" : "text-slate-300"}`} />
                        : <div className="w-4 h-px bg-slate-200 mx-auto" />
                      }
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  )
}

// ── CTA section ───────────────────────────────────────────────────────────────
function CTASection() {
  const { ref, inView } = useInView(0.2)
  return (
    <section id="pricing" className="py-24 px-6"
      style={{ background: "linear-gradient(135deg, #2d6a4f 0%, var(--green) 40%, #1a3a2a 100%)" }}>
      <div
        ref={ref}
        className={`max-w-3xl mx-auto text-center transition-all duration-700 ${inView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"}`}
      >
        <div className="inline-flex items-center gap-1.5 text-xs font-medium text-yellow-300 bg-yellow-400/10 border border-yellow-400/20 px-3 py-1 rounded-full mb-6">
          <Star className="w-3 h-3 fill-yellow-300" />
          Early access — free while in beta
        </div>
        <h2 className="text-3xl md:text-5xl font-bold text-white mb-4 tracking-tight">
          Start automating your close today
        </h2>
        <p className="mb-8 max-w-lg mx-auto" style={{ color: "rgba(255,255,255,0.8)" }}>
          Join accounting teams already saving hours every close. No credit card. No commitment. Cancel any time.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Link
            to="/app"
            className="group flex items-center justify-center gap-2 bg-white font-semibold px-10 py-4 rounded-xl transition-all duration-200 shadow-xl text-base hover:opacity-90"
            style={{ color: "var(--green)" }}
          >
            Get started free
            <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
          </Link>
        </div>
        <div className="flex items-center justify-center gap-6 mt-8">
          {[
            { icon: Shield, text: "SOC 2 compliant" },
            { icon: Lock, text: "Data never shared" },
            { icon: Clock, text: "5-min setup" },
          ].map(({ icon: Icon, text }) => (
            <div key={text} className="flex items-center gap-1.5 text-xs" style={{ color: "rgba(255,255,255,0.7)" }}>
              <Icon className="w-3 h-3" />
              {text}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

// ── Footer (dark) ─────────────────────────────────────────────────────────────
function Footer() {
  return (
    <footer className="bg-slate-900 py-12 px-6">
      <div className="max-w-6xl mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8 mb-8">
          <div className="md:col-span-2">
            <div className="flex items-center gap-2 mb-3">
              <img src="/logo-mark-dark.svg" alt="Nordavix" className="h-7 w-7" />
              <span className="font-bold text-white">nordavix<span style={{ color: "var(--green)" }}>.</span></span>
            </div>
            <p className="text-sm text-slate-500 leading-relaxed max-w-xs">
              AI-powered month-end close automation for controllers and accounting teams.
            </p>
          </div>
          <div>
            <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Product</h4>
            <ul className="space-y-2 text-sm text-slate-500">
              {["Flux Analysis", "Reconciliations (soon)", "Workpapers (soon)", "Audit (soon)"].map((item) => (
                <li key={item}><a href="#" className="hover:text-slate-300 transition-colors">{item}</a></li>
              ))}
            </ul>
          </div>
          <div>
            <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Company</h4>
            <ul className="space-y-2 text-sm text-slate-500">
              {["About", "Privacy Policy", "Terms of Service", "Security"].map((item) => (
                <li key={item}><a href="#" className="hover:text-slate-300 transition-colors">{item}</a></li>
              ))}
            </ul>
          </div>
        </div>
        <div className="border-t border-slate-800 pt-8 flex flex-col md:flex-row items-center justify-between gap-4">
          <p className="text-xs text-slate-600">© 2025 Nordavix. All rights reserved.</p>
          <p className="text-xs text-slate-700">Built for accountants, by accountants.</p>
        </div>
      </div>
    </footer>
  )
}

// ── Main export ───────────────────────────────────────────────────────────────
export function HomePage() {
  return (
    <div className="min-h-screen bg-white text-slate-900">
      <Navbar />
      <HeroSection />
      <StatsBar />
      <FeaturesSection />
      <HowItWorksSection />
      <ProductPreviewSection />
      <ComparisonSection />
      <CTASection />
      <Footer />
    </div>
  )
}
