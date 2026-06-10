/**
 * FeedbackDialog — modal feedback intake.
 *
 * Triggered from the LeftNav "Feedback" button. Five categories
 * (bug / feature / improvement / praise / other) as pill-style
 * selectors, then a free-text message with a 4000-char ceiling.
 * Submits to POST /api/feedback. Auto-fills page_path + user_agent
 * so the team has context when triaging.
 *
 * Design notes:
 *   • Single AnimatePresence wrapper for backdrop + dialog so they
 *     animate in/out together (no z-index gymnastics).
 *   • Backdrop click + Escape both close (without submitting).
 *   • Categories rendered as colour-coded pills so the user feels
 *     they're picking the right shape of feedback, not just filling
 *     a form.
 *   • Submit button shows three states: idle / sending / sent ✓.
 *     After a successful send the form clears + dialog stays open
 *     for ~1.5s showing the "sent" confirmation, then auto-closes.
 *   • Errors land inline at the bottom of the dialog with the real
 *     server detail string.
 */
import { useEffect, useState } from "react"
import { AnimatePresence, motion } from "framer-motion"
import { useMutation } from "@tanstack/react-query"
import {
  MessageSquare,
  Bug,
  Lightbulb,
  Sparkles,
  Heart,
  HelpCircle,
  X,
  Check,
  Send,
  AlertCircle,
} from "lucide-react"
import { apiClient } from "@/core/api/client"

interface Props {
  open:    boolean
  onClose: () => void
}

type Category = "bug" | "feature" | "improvement" | "praise" | "other"

interface CategoryMeta {
  key:        Category
  label:      string
  icon:       typeof Bug
  fg:         string
  bg:         string
  helper:     string
}

const CATEGORIES: CategoryMeta[] = [
  { key: "bug",         label: "Bug",         icon: Bug,         fg: "#9b3d37", bg: "rgba(155, 61, 55, 0.10)",
    helper: "Something's broken — describe what you did, what you expected, what happened." },
  { key: "feature",     label: "Feature",     icon: Lightbulb,   fg: "#3c5a76", bg: "rgba(60, 90, 118, 0.10)",
    helper: "An idea for something new — what problem would it solve?" },
  { key: "improvement", label: "Improvement", icon: Sparkles,    fg: "#8a6326", bg: "rgba(180, 83, 9, 0.10)",
    helper: "A tweak to something that already works — what would make it better?" },
  { key: "praise",      label: "Praise",      icon: Heart,       fg: "#3E8F66", bg: "rgba(62, 143, 102, 0.12)",
    helper: "What's working well? We genuinely read these." },
  { key: "other",       label: "Other",       icon: HelpCircle,  fg: "#6b7280", bg: "rgba(107, 114, 128, 0.10)",
    helper: "Anything else on your mind." },
]


export function FeedbackDialog({ open, onClose }: Props) {
  const [category, setCategory] = useState<Category>("bug")
  const [message,  setMessage]  = useState("")
  const [error,    setError]    = useState<string | null>(null)
  const [sentJustNow, setSentJustNow] = useState(false)

  // Reset form when dialog closes (so reopening starts fresh).
  useEffect(() => {
    if (open) return
    // Small delay so the user doesn't see the fields blank during exit animation
    const t = setTimeout(() => {
      setCategory("bug"); setMessage(""); setError(null); setSentJustNow(false)
    }, 250)
    return () => clearTimeout(t)
  }, [open])

  // Escape to close
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open, onClose])

  const submit = useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.post("/api/feedback", {
        category,
        message: message.trim(),
        page_path:  typeof window !== "undefined" ? window.location.pathname : null,
        user_agent: typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 500) : null,
      })
      return data
    },
    onSuccess: () => {
      setError(null)
      setSentJustNow(true)
      // Auto-close after the user sees the "sent" confirmation.
      setTimeout(() => onClose(), 1500)
    },
    onError: (e: unknown) => {
      const err = e as { response?: { data?: { detail?: string } }; message?: string }
      setError(err.response?.data?.detail ?? err.message ?? "Couldn't send feedback. Try again?")
    },
  })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (submit.isPending || sentJustNow) return
    const trimmed = message.trim()
    if (!trimmed) {
      setError("Please add a message.")
      return
    }
    setError(null)
    submit.mutate()
  }

  const meta = CATEGORIES.find((c) => c.key === category) ?? CATEGORIES[0]
  const chars = message.length
  const maxChars = 4000

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            key="fb-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={onClose}
            className="fixed inset-0 z-40"
            style={{ background: "rgba(0, 0, 0, 0.55)", backdropFilter: "blur(2px)" }}
          />

          {/* Dialog */}
          <motion.div
            key="fb-dialog"
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1,    y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 12 }}
            transition={{ duration: 0.22, ease: "easeOut" as const }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="feedback-dialog-title"
            className="fixed inset-0 z-50 flex items-center justify-center px-4 pointer-events-none"
          >
            <form
              onSubmit={handleSubmit}
              onClick={(e) => e.stopPropagation()}
              className="pointer-events-auto w-full max-w-lg rounded-2xl overflow-hidden flex flex-col"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border-strong)",
                boxShadow: "0 24px 60px -12px rgba(0,0,0,0.45), 0 8px 20px -6px rgba(0,0,0,0.2)",
                maxHeight: "calc(100vh - 2rem)",
              }}
            >
              {/* Header */}
              <div
                className="px-5 py-4 flex items-start gap-3"
                style={{
                  background: "linear-gradient(135deg, var(--green-subtle) 0%, var(--surface) 100%)",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                <div
                  className="h-9 w-9 shrink-0 rounded-xl flex items-center justify-center"
                  style={{ background: "var(--green)", color: "#fff" }}
                >
                  <MessageSquare size={18} strokeWidth={1.8} />
                </div>
                <div className="flex-1 min-w-0">
                  <h2 id="feedback-dialog-title" className="text-base font-semibold text-theme">
                    Send feedback
                  </h2>
                  <p className="text-xs mt-0.5" style={{ color: "var(--text-2)" }}>
                    Bug? Idea? Compliment? Anything in between — we read every message.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  className="h-7 w-7 rounded-md inline-flex items-center justify-center transition-colors hover:bg-[var(--surface-2)]"
                  style={{ color: "var(--text-muted)" }}
                  aria-label="Close feedback dialog"
                >
                  <X size={15} strokeWidth={1.8} />
                </button>
              </div>

              {/* Category pills */}
              <div className="px-5 pt-4 pb-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide mb-2"
                  style={{ color: "var(--text-muted)" }}>
                  What kind of feedback?
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {CATEGORIES.map((c) => {
                    const Icon = c.icon
                    const active = category === c.key
                    return (
                      <button
                        key={c.key}
                        type="button"
                        onClick={() => setCategory(c.key)}
                        className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition-all"
                        style={{
                          background: active ? c.bg : "var(--surface-2)",
                          color:      active ? c.fg : "var(--text-2)",
                          border:     `1.5px solid ${active ? c.fg : "var(--border-strong)"}`,
                        }}
                      >
                        <Icon size={12} strokeWidth={2} />
                        {c.label}
                      </button>
                    )
                  })}
                </div>
                <p className="text-[11px] italic mt-2.5" style={{ color: "var(--text-muted)" }}>
                  {meta.helper}
                </p>
              </div>

              {/* Message textarea */}
              <div className="px-5 pb-2 flex-1 min-h-0">
                <label className="block text-[11px] font-semibold uppercase tracking-wide mb-1.5"
                  style={{ color: "var(--text-muted)" }}>
                  Your feedback
                </label>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value.slice(0, maxChars))}
                  placeholder={
                    category === "bug"
                      ? "What did you do, what did you expect, what happened?"
                      : category === "feature"
                        ? "Tell us about the problem this would solve and how you'd use it."
                        : category === "praise"
                          ? "Tell us what's working well for you."
                          : "Type away…"
                  }
                  rows={7}
                  autoFocus
                  className="w-full rounded-lg px-3 py-2.5 text-sm outline-none resize-y leading-relaxed"
                  style={{
                    background: "var(--surface-2)",
                    border: "1px solid var(--border-strong)",
                    color: "var(--text)",
                    minHeight: "120px",
                    maxHeight: "260px",
                  }}
                  onFocus={(e) => (e.currentTarget.style.borderColor = "var(--green)")}
                  onBlur={(e) => (e.currentTarget.style.borderColor = "var(--border-strong)")}
                />
                <div className="flex items-center justify-between mt-1.5">
                  <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                    Page: <span className="font-mono">
                      {typeof window !== "undefined" ? window.location.pathname : "—"}
                    </span> · auto-attached
                  </span>
                  <span className="text-[10px] tabular-nums"
                    style={{ color: chars > maxChars * 0.9 ? "#8a6326" : "var(--text-muted)" }}>
                    {chars} / {maxChars}
                  </span>
                </div>
              </div>

              {/* Error banner */}
              {error && (
                <div
                  className="mx-5 mb-2 rounded-md px-3 py-2 flex items-start gap-2 text-[12px]"
                  style={{
                    background: "rgba(155, 61, 55, 0.08)",
                    border: "1px solid rgba(155, 61, 55, 0.30)",
                    color: "#9b3d37",
                  }}
                >
                  <AlertCircle size={13} strokeWidth={1.8} className="mt-0.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              {/* Footer / submit */}
              <div className="px-5 py-3 flex items-center justify-between gap-3"
                style={{ background: "var(--surface-2)", borderTop: "1px solid var(--border)" }}>
                <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                  Sent to the Nordavix team — usually replied within 1-2 business days.
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={onClose}
                    className="px-3 py-1.5 rounded-md text-xs font-medium transition-colors hover:bg-[var(--surface)]"
                    style={{ color: "var(--text-2)" }}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={submit.isPending || sentJustNow || !message.trim()}
                    className="inline-flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-xs font-semibold transition-all"
                    style={{
                      background: sentJustNow ? "var(--green)" : "var(--green)",
                      color: "#fff",
                      opacity: (submit.isPending || (!message.trim() && !sentJustNow)) ? 0.6 : 1,
                      cursor: (submit.isPending || (!message.trim() && !sentJustNow)) ? "not-allowed" : "pointer",
                      boxShadow: "0 1px 3px rgba(0,0,0,0.12)",
                    }}
                  >
                    {sentJustNow ? (
                      <>
                        <Check size={13} strokeWidth={2.2} />
                        Sent — thank you!
                      </>
                    ) : submit.isPending ? (
                      <>
                        <Send size={13} strokeWidth={1.8} className="animate-pulse" />
                        Sending…
                      </>
                    ) : (
                      <>
                        <Send size={13} strokeWidth={1.8} />
                        Send feedback
                      </>
                    )}
                  </button>
                </div>
              </div>
            </form>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
