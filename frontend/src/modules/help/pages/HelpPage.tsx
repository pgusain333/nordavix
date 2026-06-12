/**
 * In-app Help page at /app/help.
 *
 * Renders the shared HelpContent inside the standard three-pane layout.
 * Identical content to /help (public) — the only difference is the
 * page chrome (here: scrollable area inside the app shell; there: full
 * marketing header + footer).
 */
import { ExternalLink } from "lucide-react"
import { PageHeader } from "@/core/ui/PageHeader"

import { HelpContent } from "@/modules/help/HelpContent"

export function HelpPage() {
  return (
    <div className="flex flex-col h-full overflow-y-auto" style={{ background: "var(--bg)" }}>
      {/* Header — compact single-row PageHeader (was a ~140px three-deck) */}
      <PageHeader
        title="Help"
        hideTitleOnDesktop
        subtitle="Step-by-step guide to the Nordavix close platform — every workflow, every screen, in order. Reference it anytime; share section links with teammates."
        actions={
          /* Open public version in new tab — useful when the user
             wants to share a section with someone who isn't logged in. */
          <a href="/help" target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-semibold transition-opacity hover:opacity-80"
            style={{ color: "var(--green)" }}
            title="Open the public version in a new tab — shareable with anyone, no login needed">
            Public version
            <ExternalLink size={11} strokeWidth={2} />
          </a>
        }
      />

      {/* Body */}
      <HelpContent />
    </div>
  )
}
