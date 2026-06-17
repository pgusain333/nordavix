import type { ReactNode } from "react"

/**
 * Two-column schedule body. The main content (filters, roll-forward and the
 * items table) sits on the left; the "tools" — the Import-from-QBO and
 * AI-detect cards — move into a STICKY right rail so they stay reachable while
 * the table scrolls, instead of pushing the table down the page.
 *
 * Responsive: on mobile it stacks with the tools ON TOP (the same order they
 * used to appear in); on lg+ the rail sits to the right and sticks. We use
 * `flex-row-reverse` so the tools can stay first in the DOM (= top on mobile)
 * yet render on the right on desktop.
 *
 * When `tools` is falsy (closed period, or a schedule type with no import/AI
 * cards) the main content simply renders full-width with no rail.
 */
export function ScheduleToolsLayout({
  tools,
  children,
}: {
  tools?: ReactNode
  children: ReactNode
}) {
  if (!tools) return <div className="space-y-5">{children}</div>
  return (
    <div className="flex flex-col lg:flex-row-reverse lg:items-start gap-5">
      <aside className="lg:w-80 lg:shrink-0 lg:sticky lg:top-4 space-y-4">{tools}</aside>
      <div className="flex-1 min-w-0 space-y-5">{children}</div>
    </div>
  )
}
