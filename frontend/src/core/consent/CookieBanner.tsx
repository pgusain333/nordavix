/**
 * CookieBanner + CookiePreferencesDialog — the visible side of the
 * cookie-consent system. Mounted once at the App root.
 *
 * UX choices that matter for compliance:
 *   - "Accept all" and "Reject all" are SAME visual weight (both
 *     solid buttons, just different colours). No "Reject buried two
 *     menus deep" dark pattern.
 *   - "Strictly necessary" cookies are clearly labeled and the toggle
 *     is disabled — they're required for login to work at all.
 *   - User decision persists per `useCookieConsent` and the banner
 *     never re-appears unless they click "Cookie preferences" from
 *     the footer or the policy version is bumped.
 *
 * Visual choices:
 *   - Bottom-left card on desktop (not full-width — much less
 *     intrusive); slides up from below on mobile so it sits above
 *     the on-screen keyboard cleanly.
 *   - Slim cookie icon, brand-green accents, theme-aware.
 *   - Slide-in / slide-out via framer-motion with a 600ms delay on
 *     first mount so it doesn't compete with above-the-fold content
 *     for the user's attention the instant the page paints.
 */
import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { AnimatePresence, motion } from "framer-motion"
import { Cookie, X, Settings, ShieldCheck, Check } from "lucide-react"
import {
  type CookiePreferences,
  onCookiePreferencesRequested,
  useCookieConsent,
} from "./useCookieConsent"

// ── Banner ──────────────────────────────────────────────────────────────────

export function CookieBanner() {
  const { needsDecision, acceptAll, rejectAll } = useCookieConsent()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [bannerVisible, setBannerVisible] = useState(false)

  // Listen for the global "open preferences" event — fired by Footer
  // links and the Privacy page so the user can revisit their choices.
  useEffect(() => {
    return onCookiePreferencesRequested(() => setDialogOpen(true))
  }, [])

  // Stagger banner appearance — 600ms after mount so the page settles
  // first and the banner doesn't immediately steal the user's attention.
  useEffect(() => {
    if (!needsDecision) {
      setBannerVisible(false)
      return
    }
    const t = setTimeout(() => setBannerVisible(true), 600)
    return () => clearTimeout(t)
  }, [needsDecision])

  return (
    <>
      <AnimatePresence>
        {needsDecision && bannerVisible && !dialogOpen && (
          <motion.div
            key="cookie-banner"
            initial={{ opacity: 0, y: 110 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{    opacity: 0, y: 110 }}
            transition={{ type: "spring", stiffness: 300, damping: 26 }}
            role="dialog"
            aria-label="Cookie preferences"
            aria-describedby="cookie-banner-body"
            className="fixed z-[80] bottom-4 left-4 right-4 sm:right-auto sm:max-w-[400px] print:hidden"
          >
            <div className="rounded-2xl overflow-hidden"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                boxShadow: "0 24px 56px -12px rgba(0,0,0,0.20), 0 8px 24px -8px rgba(0,0,0,0.12)",
              }}>
              <div className="p-5 sm:p-6">
                {/* Header: icon + title + close */}
                <div className="flex items-start gap-3 mb-3">
                  <div className="h-9 w-9 rounded-xl flex items-center justify-center shrink-0"
                    style={{
                      background: "var(--green-subtle)",
                      color: "var(--green)",
                    }}>
                    <Cookie size={18} strokeWidth={1.8} />
                  </div>
                  <div className="flex-1 min-w-0 pt-0.5">
                    <h2 className="text-sm font-bold text-theme leading-tight">
                      Cookies on Nordavix
                    </h2>
                  </div>
                  <button
                    type="button"
                    onClick={rejectAll}
                    className="h-7 w-7 -mr-1 -mt-1 flex items-center justify-center rounded-md transition-colors"
                    style={{ color: "var(--text-muted)" }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text)")}
                    onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}
                    aria-label="Reject non-essential cookies and close">
                    <X size={16} strokeWidth={1.8} />
                  </button>
                </div>

                {/* Body */}
                <p id="cookie-banner-body"
                  className="text-[13px] leading-relaxed mb-4"
                  style={{ color: "var(--text-2)" }}>
                  We use a minimal set of cookies to keep you signed in and remember
                  your preferences. Read more in our{" "}
                  <Link to="/privacy#cookies" className="font-medium underline underline-offset-2"
                    style={{ color: "var(--green)" }}>
                    Privacy Policy
                  </Link>.
                </p>

                {/* Actions — equal prominence for Accept and Reject. */}
                <div className="flex flex-col gap-2">
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={rejectAll}
                      className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-semibold transition-all"
                      style={{
                        background: "var(--surface-2)",
                        color: "var(--text)",
                        border: "1px solid var(--border-strong)",
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg)")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "var(--surface-2)")}>
                      Reject non-essential
                    </button>
                    <button
                      type="button"
                      onClick={acceptAll}
                      className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-semibold transition-all hover:opacity-90"
                      style={{
                        background: "var(--green)",
                        color: "white",
                        boxShadow: "0 2px 8px rgba(16, 185, 129, 0.25)",
                      }}>
                      Accept all
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => setDialogOpen(true)}
                    className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors"
                    style={{ color: "var(--text-muted)" }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-2)")}
                    onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}>
                    <Settings size={11} strokeWidth={1.8} /> Customize
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <CookiePreferencesDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
      />
    </>
  )
}

// ── Preferences dialog ──────────────────────────────────────────────────────

interface DialogProps {
  open:    boolean
  onClose: () => void
}

function CookiePreferencesDialog({ open, onClose }: DialogProps) {
  const { preferences, acceptAll, rejectAll, savePreferences } = useCookieConsent()
  /** Local draft state while the dialog is open — applied only when the
   *  user clicks Save. Re-seeded from the persisted preferences each time
   *  the dialog opens so cancelling discards in-flight toggles. */
  const [draft, setDraft] = useState<Pick<CookiePreferences, "functional" | "analytics">>({
    functional: preferences.functional,
    analytics:  preferences.analytics,
  })
  useEffect(() => {
    if (open) {
      setDraft({ functional: preferences.functional, analytics: preferences.analytics })
    }
  }, [open, preferences.functional, preferences.analytics])

  // Lock body scroll while open + Esc to close
  useEffect(() => {
    if (!open) return
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    window.addEventListener("keydown", onKey)
    return () => {
      document.body.style.overflow = prevOverflow
      window.removeEventListener("keydown", onKey)
    }
  }, [open, onClose])

  function handleSave() {
    savePreferences(draft)
    onClose()
  }

  function handleAcceptAll() { acceptAll(); onClose() }
  function handleRejectAll() { rejectAll(); onClose() }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="cookie-dialog-root"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="fixed inset-0 z-[90] flex items-end sm:items-center justify-center p-0 sm:p-6 print:hidden"
          style={{ background: "rgba(0,0,0,0.45)", backdropFilter: "blur(2px)" }}
          onClick={onClose}>
          <motion.div
            initial={{ y: "8%", opacity: 0, scale: 0.98 }}
            animate={{ y: 0,    opacity: 1, scale: 1 }}
            exit={{    y: "6%", opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="cookie-dialog-title"
            onClick={(e) => e.stopPropagation()}
            className="w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl overflow-hidden"
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              boxShadow: "0 32px 64px -16px rgba(0,0,0,0.25)",
              maxHeight: "90vh",
              display: "flex",
              flexDirection: "column",
            }}>
            {/* Header */}
            <div className="flex items-start gap-3 p-5 sm:p-6 border-b"
              style={{ borderColor: "var(--border)" }}>
              <div className="h-10 w-10 rounded-xl flex items-center justify-center shrink-0"
                style={{
                  background: "var(--green-subtle)",
                  color: "var(--green)",
                }}>
                <ShieldCheck size={18} strokeWidth={1.8} />
              </div>
              <div className="flex-1 min-w-0">
                <h2 id="cookie-dialog-title"
                  className="text-base sm:text-lg font-bold text-theme leading-tight">
                  Cookie preferences
                </h2>
                <p className="text-[12px] mt-0.5" style={{ color: "var(--text-muted)" }}>
                  Choose which categories of cookies Nordavix can use.
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="h-8 w-8 -mr-1 flex items-center justify-center rounded-lg transition-colors"
                style={{
                  background: "var(--surface-2)",
                  color: "var(--text-muted)",
                }}
                aria-label="Close cookie preferences">
                <X size={16} strokeWidth={1.8} />
              </button>
            </div>

            {/* Categories — scrollable body */}
            <div className="flex-1 overflow-y-auto p-5 sm:p-6 space-y-3">
              <Category
                title="Strictly necessary"
                badge="Always on"
                description="Required for the platform to work — keep you signed in, prevent cross-site request forgery, and remember your active workspace. Without these, login and the app are completely broken."
                checked
                disabled
              />
              <Category
                title="Functional"
                description="Remember your interface preferences across visits: theme (light/dark), sidebar collapsed state, the last analysis you were viewing. Turning this off means you'll re-set these every visit."
                checked={draft.functional}
                onChange={(v) => setDraft((d) => ({ ...d, functional: v }))}
              />
              <Category
                title="Analytics"
                description="Aggregate usage measurement so we can see which features get used and where users get stuck. Currently we do not run any third-party analytics SDK. This toggle is here so that if we ever add one, your choice is already on record."
                checked={draft.analytics}
                onChange={(v) => setDraft((d) => ({ ...d, analytics: v }))}
              />

              <p className="text-[11px] leading-relaxed pt-1"
                style={{ color: "var(--text-muted)" }}>
                We don't sell or share your data and we don't use any advertising
                trackers. Full detail is in our{" "}
                <Link to="/privacy#cookies" onClick={onClose}
                  className="underline underline-offset-2"
                  style={{ color: "var(--green)" }}>
                  Privacy Policy
                </Link>.
              </p>
            </div>

            {/* Footer actions */}
            <div className="p-4 sm:p-5 border-t flex flex-col-reverse sm:flex-row sm:items-center gap-2 sm:gap-3"
              style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}>
              <button
                type="button"
                onClick={handleRejectAll}
                className="flex-1 sm:flex-none px-4 py-2 rounded-lg text-[13px] font-medium transition-colors"
                style={{
                  color: "var(--text-2)",
                  background: "transparent",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text)")}
                onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-2)")}>
                Reject all
              </button>
              <button
                type="button"
                onClick={handleAcceptAll}
                className="flex-1 sm:flex-none px-4 py-2 rounded-lg text-[13px] font-semibold transition-colors"
                style={{
                  background: "var(--surface)",
                  color: "var(--text)",
                  border: "1px solid var(--border-strong)",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "var(--surface)")}>
                Accept all
              </button>
              <button
                type="button"
                onClick={handleSave}
                className="flex-1 sm:flex-none inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-semibold transition-opacity hover:opacity-90"
                style={{
                  background: "var(--green)",
                  color: "white",
                  boxShadow: "0 2px 8px rgba(16, 185, 129, 0.25)",
                }}>
                <Check size={13} strokeWidth={2.2} /> Save preferences
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// ── Category row ────────────────────────────────────────────────────────────

interface CategoryProps {
  title:       string
  description: string
  badge?:      string
  checked:     boolean
  disabled?:   boolean
  onChange?:   (next: boolean) => void
}

function Category({ title, description, badge, checked, disabled, onChange }: CategoryProps) {
  const interactive = !disabled && !!onChange
  return (
    <div
      className="rounded-xl p-4 transition-colors"
      style={{
        background: "var(--surface-2)",
        border: "1px solid var(--border)",
      }}>
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <h3 className="text-[13px] font-semibold text-theme">{title}</h3>
            {badge && (
              <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
                style={{
                  background: "var(--green-subtle)",
                  color: "var(--green)",
                }}>
                {badge}
              </span>
            )}
          </div>
          <p className="text-[12px] leading-relaxed" style={{ color: "var(--text-2)" }}>
            {description}
          </p>
        </div>

        {/* Toggle */}
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-label={`Toggle ${title} cookies`}
          disabled={disabled}
          onClick={() => interactive && onChange?.(!checked)}
          className="relative inline-flex items-center h-6 w-11 rounded-full transition-colors shrink-0 mt-0.5"
          style={{
            background: checked ? "var(--green)" : "var(--border-strong)",
            opacity: disabled ? 0.55 : 1,
            cursor: disabled ? "not-allowed" : "pointer",
          }}>
          <motion.span
            initial={false}
            animate={{ x: checked ? 22 : 2 }}
            transition={{ type: "spring", stiffness: 500, damping: 35 }}
            className="inline-block h-5 w-5 rounded-full"
            style={{
              background: "white",
              boxShadow: "0 1px 3px rgba(0,0,0,0.25)",
            }} />
        </button>
      </div>
    </div>
  )
}
