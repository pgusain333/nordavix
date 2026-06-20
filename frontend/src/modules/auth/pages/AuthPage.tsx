/**
 * AuthPage — Nordavix-branded sign-in / sign-up surface.
 *
 * Replaces Clerk's hosted page with a split-layout: a fixed-pine
 * editorial brand panel on the left (same visual language as the
 * marketing homepage — Fraunces serif, JetBrains Mono kickers, sage
 * accents on deep pine) and the form on the right. The actual auth is
 * still Clerk's <SignIn> / <SignUp> component — we just style it to
 * match the rest of the app and wrap it in the Nordavix shell.
 *
 * The left panel is intentionally NOT theme-aware: it is always deep
 * pine, exactly like the marketing hero, so the brand moment reads the
 * same whether the app theme is light or dark. The right column uses
 * app tokens and adapts.
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
import { ShieldCheck, ArrowLeft } from "lucide-react"

type Mode = "sign-in" | "sign-up"

interface Props {
  mode: Mode
}

/* ── Brand constants (mirrors marketing HomePage) ───────────────── */
const PINE   = "#0C2620"
const CREAM  = "#F4F1E9"
const SAGE   = "#9CC4AD"
const SERIF  = '"Fraunces", Georgia, serif'
const MONO   = '"JetBrains Mono", ui-monospace, monospace'

const CREAM_70 = "rgba(244,241,233,0.70)"
const CREAM_45 = "rgba(244,241,233,0.45)"
const HAIRLINE = "rgba(244,241,233,0.14)"

const VALUE_PROPS = [
  {
    n:     "01",
    title: "Flux analysis",
    blurb: "AI commentary on every material variance — the why, not just the number.",
  },
  {
    n:     "02",
    title: "Reconciliations",
    blurb: "An agentic preparer ties subledgers to GL. You review and approve.",
  },
  {
    n:     "03",
    title: "Insights",
    blurb: "Liquidity, runway, AR/AP risk — surfaced before they cost you.",
  },
]

export function AuthPage({ mode }: Props) {
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
      colorPrimary:   "#2E7A55",  // brand --green
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
        "h-11 border border-[var(--border-strong)] bg-[var(--surface)] hover:bg-[var(--surface-2)] text-[var(--text)] font-medium text-sm rounded-lg",
      dividerLine:             "bg-[var(--border)]",
      dividerText:             "text-[var(--text-muted)] text-xs",
      // Refined micro-label: smaller, controlled tracking (the old text-xs +
      // tracking-wider read cramped), and a real gap below so the field's
      // rounded corner can never sit under the label text.
      formFieldLabel:          "text-[var(--text-2)] text-[11px] font-semibold uppercase tracking-[0.1em] mb-2",
      // Taller, roomier input (px-3.5 py-2.5 ≈ 44px). The right padding leaves
      // space for the show-password eye so typed text never runs under it.
      formFieldInput:
        "bg-[var(--surface-2)] border border-[var(--border-strong)] text-[var(--text)] text-sm rounded-lg px-3.5 py-2.5 focus:border-[var(--green)] focus:ring-0",
      formButtonPrimary:
        "h-11 bg-[var(--green)] hover:opacity-90 text-white font-semibold text-sm rounded-lg shadow-none normal-case",
      footer:                  "hidden",
      footerAction:            "hidden",
      identityPreviewText:     "text-[var(--text)]",
      identityPreviewEditButtonIcon: "text-[var(--text-muted)]",
      formFieldErrorText:      "text-[#9b3d37] text-xs",
      otpCodeFieldInput:
        "bg-[var(--surface-2)] border border-[var(--border-strong)] text-[var(--text)]",
      alertText:               "text-[var(--text)] text-sm",
      formFieldAction:         "text-[var(--green)] text-xs hover:underline",
    },
  }), [])

  const isSignIn = mode === "sign-in"

  return (
    <div className="min-h-screen flex flex-col lg:flex-row" style={{ background: "var(--bg)" }}>
      {/* ────── LEFT: pine editorial brand panel ──────
          sticky + h-screen pins the panel to exactly the viewport: if the
          form column grows taller (Clerk steps, dev banner), only the right
          side scrolls and the quote/trust footer stays on screen. */}
      <aside className="relative lg:flex-1 lg:basis-1/2 overflow-hidden hidden lg:flex lg:sticky lg:top-0 lg:h-screen lg:min-h-[780px]"
        style={{ background: PINE }}>
        {/* Soft sage / green glows on pine */}
        <div className="absolute inset-0 pointer-events-none" aria-hidden>
          <div className="absolute -top-40 -left-40 w-[560px] h-[560px] rounded-full blur-3xl"
            style={{ background: "radial-gradient(circle, rgba(156,196,173,0.16), transparent 70%)" }} />
          <div className="absolute -bottom-44 -right-44 w-[640px] h-[640px] rounded-full blur-3xl"
            style={{ background: "radial-gradient(circle, rgba(46,122,85,0.30), transparent 70%)" }} />
        </div>

        {/* Faint cream grid */}
        <div className="absolute inset-0 pointer-events-none opacity-[0.04]" aria-hidden
          style={{
            backgroundImage:
              `linear-gradient(${CREAM} 1px, transparent 1px), linear-gradient(90deg, ${CREAM} 1px, transparent 1px)`,
            backgroundSize: "36px 36px",
          }} />

        {/* Oversized watermark mark, bleeding off the corner */}
        <img src="/logo-mark-white.svg" alt="" aria-hidden
          className="absolute -bottom-20 -right-20 w-[380px] opacity-[0.05] pointer-events-none select-none" />

        {/* Content stack.
            Animations on this side dropped entirely. /sign-in/* and
            /sign-up/* are separate React Router routes, so toggling
            between them unmounts + remounts the whole AuthPage, which
            replayed every motion.div on every toggle and made the
            page feel "jumpy." Static brand panel is calmer + faster. */}
        <div className="relative z-10 flex flex-col w-full p-12 xl:p-16">
          {/* Header: logo + wordmark. The panel is always pine, so the
              white mark is used unconditionally — no dark: toggling. */}
          <Link to="/" className="inline-flex items-center gap-3">
            <img src="/logo-mark-white.svg" alt="" className="h-10 w-10" />
            <span className="font-bold text-[26px] tracking-tight leading-none" style={{ color: CREAM }}>
              nordavix<span style={{ color: SAGE }}>.</span>
            </span>
          </Link>

          {/* Kicker + headline */}
          <div className="mt-14 xl:mt-16 max-w-lg">
            <p className="text-[11px] uppercase"
              style={{ fontFamily: MONO, color: SAGE, letterSpacing: "0.22em" }}>
              AI-native month-end close
            </p>
            <h1 className="mt-4 text-[38px] xl:text-[44px] leading-[1.06]"
              style={{ fontFamily: SERIF, fontWeight: 550, color: CREAM, letterSpacing: "-0.01em" }}>
              Close the books in{" "}
              <em style={{ fontStyle: "italic", fontWeight: 450, color: SAGE }}>days</em>,
              not weeks.
            </h1>
            <p className="mt-5 text-[15px] xl:text-base leading-relaxed max-w-md" style={{ color: CREAM_70 }}>
              Built by CPAs. Flux, reconciliations, and insights on top of
              QuickBooks — without the swivel-chair.
            </p>
          </div>

          {/* Numbered value rows — editorial index, not cards */}
          <div className="mt-10 max-w-md" style={{ borderTop: `1px solid ${HAIRLINE}` }}>
            {VALUE_PROPS.map((v) => (
              <div key={v.n} className="py-3.5 flex items-baseline gap-4"
                style={{ borderBottom: `1px solid ${HAIRLINE}` }}>
                <span className="text-[11px] shrink-0" style={{ fontFamily: MONO, color: SAGE }}>
                  {v.n}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-[15px]" style={{ fontFamily: SERIF, fontWeight: 550, color: CREAM }}>
                    {v.title}
                  </p>
                  <p className="text-[12.5px] mt-1 leading-relaxed" style={{ color: CREAM_45 }}>
                    {v.blurb}
                  </p>
                </div>
              </div>
            ))}
          </div>

          {/* Footer: founder quote + trust line */}
          <div className="mt-auto pt-10 max-w-md">
            <blockquote className="pl-4" style={{ borderLeft: `2px solid ${SAGE}` }}>
              <p className="text-[14.5px] leading-relaxed"
                style={{ fontFamily: SERIF, fontStyle: "italic", fontWeight: 450, color: CREAM_70 }}>
                "I built Nordavix after living through 100+ month-end closes — it's
                the close I always wished I'd had: faster, with an audit trail
                cleaner than any spreadsheet."
              </p>
              <footer className="mt-2.5 text-[10.5px] uppercase"
                style={{ fontFamily: MONO, color: CREAM_45, letterSpacing: "0.14em" }}>
                The Nordavix founder · CPA
              </footer>
            </blockquote>

            <div className="mt-7 flex items-center gap-2 text-[10.5px] uppercase"
              style={{ fontFamily: MONO, color: CREAM_45, letterSpacing: "0.1em" }}>
              <ShieldCheck size={12} strokeWidth={1.8} style={{ color: SAGE }} />
              Encrypted at rest · Read-only QuickBooks
            </div>
          </div>
        </div>
      </aside>

      {/* ────── RIGHT: form ────── */}
      <section className="flex-1 lg:basis-1/2 flex flex-col">
        {/* Top nav — back to marketing + mode pill */}
        <div className="px-6 py-5 flex items-center justify-between"
          style={{ borderBottom: "1px solid var(--border)" }}>
          {/* "Back to home" only on desktop — on mobile the logo (rendered
              next to this) already provides a back-to-marketing tap target,
              so showing both is visual clutter on a narrow viewport. */}
          <Link to="/" className="hidden lg:inline-flex items-center gap-1.5 text-xs hover:underline"
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
          <span className="text-[10px] uppercase px-2.5 py-1 rounded-full"
            style={{
              fontFamily: MONO, letterSpacing: "0.12em",
              background: "var(--green-subtle)", color: "var(--green)",
            }}>
            {isSignIn ? "Sign in" : "Sign up"}
          </span>
        </div>

        {/* Form column.
            Layout rationale (this was the real bug):
              - Old approach used `min-h-full flex items-center`. When
                the form grew taller than the viewport (Clerk's email →
                verify → password steps, or any field error adding
                height), `items-center` re-centered the WHOLE form
                vertically every render. Combined with the browser's
                auto-scroll-to-focused-input, this clipped labels at
                the top of the visible area (the "PASSWORD" with the
                "P" cut off).
              - New approach: natural top-aligned scrolling. The form
                always starts at the top of the column with a stable
                top padding. If content exceeds height, it scrolls
                normally — no auto-recentering on height change.
              - `scrollPaddingTop` reserves space at the top so when
                the browser scrolls a focused input into view, it
                leaves enough room for the input's label above it. */}
        <div
          className="flex-1 overflow-y-auto px-4 sm:px-8 pt-8 sm:pt-14 pb-10"
          style={{ scrollPaddingTop: 96 }}
        >
          <div className="w-full max-w-md mx-auto">
            {/* Our own header — serif display to match the brand panel */}
            <h2 className="text-[28px] sm:text-[32px] leading-tight"
              style={{ fontFamily: SERIF, fontWeight: 550, color: "var(--text)", letterSpacing: "-0.01em" }}>
              {isSignIn ? "Welcome back" : "Create your account"}
            </h2>
            <p className="text-sm mt-2" style={{ color: "var(--text-muted)" }}>
              {isSignIn
                ? "Sign in to keep closing your books with AI."
                : "Free during early access. No credit card needed."}
            </p>

            {/* Clerk form, styled to match.
                Stable min-height prevents the visible "flash" when
                Clerk transitions between steps (email → verification
                → password). Without it, the column visually shrinks
                during the swap and the page content below jumps up,
                then settles when the new step renders. min-h holds
                the frame steady so only the inner form content
                changes — the layout around it stays still. */}
            <div className="mt-7" style={{ minHeight: 380 }}>
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
          </div>
        </div>
      </section>
    </div>
  )
}
