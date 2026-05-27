/**
 * In-app Help page at /app/help.
 *
 * Renders the shared HelpContent inside the standard three-pane layout.
 * Identical content to /help (public) — the only difference is the
 * page chrome (here: scrollable area inside the app shell; there: full
 * marketing header + footer).
 */
import { useNavigate } from "react-router-dom"
import { motion } from "framer-motion"
import { ArrowLeft, BookOpen, ExternalLink } from "lucide-react"

import { HelpContent } from "@/modules/help/HelpContent"

export function HelpPage() {
  const navigate = useNavigate()
  return (
    <div className="flex flex-col h-full overflow-y-auto" style={{ background: "var(--bg)" }}>
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}
        className="px-4 sm:px-8 pt-6 pb-4"
        style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
        <button onClick={() => navigate("/app")}
          className="inline-flex items-center gap-1 text-[11px] font-medium mb-2 transition-opacity hover:opacity-70"
          style={{ color: "var(--text-muted)" }}>
          <ArrowLeft size={12} strokeWidth={2} /> Back to dashboard
        </button>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <BookOpen size={20} strokeWidth={1.8} style={{ color: "var(--green)" }} />
              <h1 style={{
                fontSize: "clamp(20px, 4vw, 24px)", fontWeight: 700,
                letterSpacing: "-0.01em", color: "var(--text)", margin: 0,
              }}>
                Help
              </h1>
            </div>
            <p className="text-xs sm:text-sm" style={{ color: "var(--text-muted)" }}>
              Step-by-step guide to the Nordavix close platform — every workflow,
              every screen, in order. Reference it anytime; share section links
              with teammates.
            </p>
          </div>
          {/* Open public version in new tab — useful when the user
              wants to share a section with someone who isn't logged in. */}
          <a href="/help" target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-semibold transition-opacity hover:opacity-80"
            style={{ color: "var(--green)" }}
            title="Open the public version in a new tab — shareable with anyone, no login needed">
            Public version
            <ExternalLink size={11} strokeWidth={2} />
          </a>
        </div>
      </motion.div>

      {/* Body */}
      <HelpContent />
    </div>
  )
}
