/**
 * AuthPage — Nordavix-branded sign-in / sign-up surface.
 *
 * Replaces Clerk's hosted page with a split-layout that puts brand on
 * the left and form on the right. The actual auth is still Clerk's
 * <SignIn> / <SignUp> component — we just style it to match the rest
 * of the app and wrap it in the Nordavix visual language.
 *
 * Mode is driven by the route: /sign-in/* → sign-in, /sign-up/* →
 * sign-up. The trailing /* is required so Clerk can handle its own
 * sub-routes (verification, MFA, OAuth callback, etc.).
 *
 * The form's `routing` prop is set to "path" + `signInUrl/signUpUrl`
 * point at these routes so the toggle button at the bottom just
 * navigates between paths — no extra config needed in Clerk.
 */
import { useMemo } from "react"
import { Link, useLocation } from "react-router-dom"
import { SignIn, SignUp } from "@clerk/clerk-react"
import { motion } from "framer-motion"
import {
  Sparkles, Scale, Lightbulb, Quote, ShieldCheck, ArrowLeft,
} from "lucide-react"
import { useTheme } from "@/core/theme/ThemeProvider"

type Mode = "sign-in" | "sign-up"

interface Props {
  mode: Mode
}

const VALUE_PROPS = [
  {
    icon:    Sparkles,
    title:   "Flux Analysis",
    blurb:   "AI commentary on every material variance — the why, not just the number.",
  },
  {
    icon:    Scale,
    title:   "Reconciliations",
    blurb:   "Agentic preparer auto-ties subledgers to GL; you approve.",
  },
  {
    icon:    Lightbulb,
    title:   "Insights",
    blurb:   "Liquidity, AR/AP, expense risks — surfaced before they cost you.",
  },
]

export function AuthPage({ mode }: Props) {
  const { resolved } = useTheme()
  void resolved  // reserved for future per-theme tweaks (e.g. Clerk baseTheme)
  const location = useLocation()
  const otherPath = mode === "sign-in" ? "/sign-up" : "/sign-in"

  // Preserve any ?redirect_url=... so post-auth lands where the user
  // came from instead of always /app.
  const searchSuffix = location.search || ""

  // Clerk appearance — themed to match Nordavix tokens. We hide the
  // card chrome, header, and footer (we own those) and just keep the
  // form controls + social buttons.
  const appearance = useMemo(() => ({
    variables: {
      colorPrimary:   "#16a34a",  // var(--green) hex equivalent
      colorBackground: "transparent",
      borderRadius:    "8px",
      fontFamily:      "inherit",
      fontSize:        "14px",
    },
    elements: {
      rootBox:                 "w-full",
      card:                    "shadow-none bg-transparent p-0 border-0",
      cardBox:                 "shadow-none bg-transparent p-0 border-0 w-full",
      header:                  "hidden",
      headerTitle:             "hidden",
      headerSubtitle:          "hidden",
      socialButtonsBlockButton:
        "border border-[var(--border-strong)] bg-[var(--surface)] hover:bg-[var(--surface-2)] text-[var(--text)] font-medium text-sm rounded-lg",
      dividerLine:             "bg-[var(--border)]",
      dividerText:             "text-[var(--text-muted)] text-xs",
      formFieldLabel:          "text-[var(--text-2)] text-xs font-semibold uppercase tracking-wider mb-1",
      formFieldInput:
        "bg-[var(--surface-2)] border border-[var(--border-strong)] text-[var(--text)] text-sm rounded-lg focus:border-[var(--green)] focus:ring-0",
      formButtonPrimary:
        "bg-[var(--green)] hover:opacity-90 text-white font-semibold text-sm rounded-lg shadow-none normal-case",
      footer:                  "hidden",
      footerAction:            "hidden",
      identityPreviewText:     "text-[var(--text)]",
      identityPreviewEditButtonIcon: "text-[var(--text-muted)]",
      formFieldErrorText:      "text-[#dc2626] text-xs",
      otpCodeFieldInput:
        "bg-[var(--surface-2)] border border-[var(--border-strong)] text-[var(--text)]",
      alertText:               "text-[var(--text)] text-sm",
      formFieldAction:         "text-[var(--green)] text-xs hover:underline",
    },
  }), [])

  const isSignIn = mode === "sign-in"

  return (
    <div className="min-h-screen flex flex-col lg:flex-row" style={{ background: "var(--bg)" }}>
      {/* ────── LEFT: brand showcase ────── */}
      <aside className="relative lg:flex-1 lg:basis-1/2 overflow-hidden hidden lg:flex"
        style={{ background: "var(--surface-2)" }}>
        {/* Mesh gradient backdrop */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute -top-32 -left-32 w-[500px] h-[500px] rounded-full opacity-50 blur-3xl"
            style={{ background: "radial-gradient(circle, var(--green-subtle), transparent 70%)" }} />
          <div className="absolute -bottom-32 -right-32 w-[600px] h-[600px] rounded-full opacity-40 blur-3xl"
            style={{ background: "radial-gradient(circle, #6366f150, transparent 70%)" }} />
          <div className="absolute top-1/3 left-1/4 w-[300px] h-[300px] rounded-full opacity-30 blur-3xl"
            style={{ background: "radial-gradient(circle, #f59e0b40, transparent 70%)" }} />
        </div>

        {/* Faint grid pattern */}
        <div className="absolute inset-0 pointer-events-none opacity-[0.03]"
          style={{
            backgroundImage:
              "linear-gradient(var(--text) 1px, transparent 1px), linear-gradient(90deg, var(--text) 1px, transparent 1px)",
            backgroundSize: "32px 32px",
          }} />

        {/* Content stack */}
        <div className="relative z-10 flex flex-col w-full p-12 xl:p-16">
          {/* Header: logo + wordmark */}
          <Link to="/" className="inline-flex items-center gap-2.5 group/logo">
            <img src="/logo-mark-dark.svg" alt="" className="h-9 w-9 dark:hidden" />
            <img src="/logo-mark-light.svg" alt="" className="h-9 w-9 hidden dark:block" />
            <span className="font-bold text-2xl tracking-tight" style={{ color: "var(--text)" }}>
              nordavix<span style={{ color: "var(--green)" }}>.</span>
            </span>
          </Link>

          {/* Tagline + sub */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: "easeOut" }}
            className="mt-16 max-w-md"
          >
            <h1 className="text-4xl xl:text-5xl font-bold leading-tight" style={{ color: "var(--text)" }}>
              Close the month in <span style={{ color: "var(--green)" }}>hours</span>,
              not weeks.
            </h1>
            <p className="mt-4 text-base xl:text-lg leading-relaxed" style={{ color: "var(--text-2)" }}>
              An AI-powered month-end close platform built by CPAs.
              Flux, reconciliations, and insights — without the swivel-chair.
            </p>
          </motion.div>

          {/* Value-prop cards */}
          <div className="mt-12 space-y-3 max-w-md">
            {VALUE_PROPS.map((v, i) => {
              const Icon = v.icon
              return (
                <motion.div
                  key={v.title}
                  initial={{ opacity: 0, x: -12 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.35, delay: 0.15 + i * 0.08, ease: "easeOut" }}
                  className="rounded-xl p-4 flex items-start gap-3 backdrop-blur"
                  style={{
                    background: "color-mix(in oklab, var(--surface) 75%, transparent)",
                    border:     "1px solid var(--border)",
                    boxShadow:  "0 4px 12px rgba(0,0,0,0.04)",
                  }}
                >
                  <span className="h-9 w-9 rounded-lg flex items-center justify-center shrink-0"
                    style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
                    <Icon size={17} strokeWidth={1.8} />
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold" style={{ color: "var(--text)" }}>{v.title}</p>
                    <p className="text-[12px] mt-0.5 leading-relaxed" style={{ color: "var(--text-muted)" }}>
                      {v.blurb}
                    </p>
                  </div>
                </motion.div>
              )
            })}
          </div>

          {/* Footer: quote + trust marker */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.4, delay: 0.6 }}
            className="mt-auto pt-12"
          >
            <div className="flex items-start gap-3 mb-6">
              <Quote size={20} strokeWidth={1.8} style={{ color: "var(--green)" }} className="shrink-0 mt-0.5" />
              <div>
                <p className="text-sm italic leading-relaxed max-w-md" style={{ color: "var(--text-2)" }}>
                  "I used to spend nine days on month-end. With Nordavix I'm down to two,
                  and the audit trail is cleaner than anything I had in Excel."
                </p>
                <p className="text-[11px] mt-2 font-semibold" style={{ color: "var(--text-muted)" }}>
                  Senior Accountant, mid-market SaaS
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
              <ShieldCheck size={12} strokeWidth={1.8} style={{ color: "var(--green)" }} />
              Bank-grade encryption · SOC 2 (in progress) · Read-only QuickBooks scope
            </div>
          </motion.div>
        </div>
      </aside>

      {/* ────── RIGHT: form ────── */}
      <section className="flex-1 lg:basis-1/2 flex flex-col">
        {/* Top nav — back to marketing + theme-aware mode pill */}
        <div className="px-6 py-5 flex items-center justify-between"
          style={{ borderBottom: "1px solid var(--border)" }}>
          <Link to="/" className="inline-flex items-center gap-1.5 text-xs hover:underline"
            style={{ color: "var(--text-muted)" }}>
            <ArrowLeft size={12} strokeWidth={2} />
            Back to home
          </Link>
          {/* Mobile-only logo */}
          <Link to="/" className="lg:hidden inline-flex items-center gap-1.5">
            <img src="/logo-mark-dark.svg" alt="" className="h-6 w-6 dark:hidden" />
            <img src="/logo-mark-light.svg" alt="" className="h-6 w-6 hidden dark:block" />
            <span className="font-bold text-sm tracking-tight" style={{ color: "var(--text)" }}>
              nordavix<span style={{ color: "var(--green)" }}>.</span>
            </span>
          </Link>
          <span className="text-[11px] font-medium px-2 py-1 rounded-full"
            style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
            {isSignIn ? "Sign in" : "Sign up"}
          </span>
        </div>

        {/* Form column — centered */}
        <div className="flex-1 flex items-center justify-center px-4 sm:px-8 py-12">
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.32, ease: "easeOut" }}
            className="w-full max-w-md"
          >
            {/* Our own header */}
            <h2 className="text-2xl sm:text-3xl font-bold leading-tight" style={{ color: "var(--text)" }}>
              {isSignIn ? "Welcome back" : "Create your account"}
            </h2>
            <p className="text-sm mt-1.5" style={{ color: "var(--text-muted)" }}>
              {isSignIn
                ? "Sign in to keep closing your books with AI."
                : "Free during early access. No credit card needed."}
            </p>

            {/* Clerk form, styled to match */}
            <div className="mt-7">
              {isSignIn ? (
                <SignIn
                  appearance={appearance}
                  routing="path"
                  path="/sign-in"
                  signUpUrl={`/sign-up${searchSuffix}`}
                  fallbackRedirectUrl="/app"
                />
              ) : (
                <SignUp
                  appearance={appearance}
                  routing="path"
                  path="/sign-up"
                  signInUrl={`/sign-in${searchSuffix}`}
                  fallbackRedirectUrl="/app"
                />
              )}
            </div>

            {/* Our own mode toggle — Clerk's footer is hidden */}
            <p className="mt-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>
              {isSignIn ? "New to Nordavix? " : "Already have an account? "}
              <Link to={`${otherPath}${searchSuffix}`}
                className="font-semibold hover:underline"
                style={{ color: "var(--green)" }}>
                {isSignIn ? "Create an account" : "Sign in"}
              </Link>
            </p>

            <p className="mt-8 text-center text-[11px]" style={{ color: "var(--text-muted)" }}>
              By {isSignIn ? "signing in" : "creating an account"} you agree to our
              {" "}<a href="/terms" className="hover:underline" style={{ color: "var(--text-2)" }}>Terms</a>{" "}
              and{" "}
              <a href="/privacy" className="hover:underline" style={{ color: "var(--text-2)" }}>Privacy Policy</a>.
            </p>
          </motion.div>
        </div>
      </section>
    </div>
  )
}
