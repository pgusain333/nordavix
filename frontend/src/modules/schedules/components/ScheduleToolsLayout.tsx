import type { ReactNode } from "react"

/**
 * Schedule body layout.
 *
 * This used to be a two-column split with the import / AI-detect cards in a
 * sticky 320px right rail. That rail cost the items table a fifth of the page
 * permanently, for work that happens once at setup and occasionally after —
 * and it left the table 876px inside a 1280px container, less than any of the
 * five schedules needs, so every page scrolled horizontally all the time.
 *
 * The tools moved into a slide-over reached from the header (see
 * ScheduleTools.tsx), so this is now a single full-width column. The component
 * is kept rather than deleted because all five pages compose through it and a
 * future layout change should have one place to happen.
 */
export function ScheduleToolsLayout({ children }: { tools?: ReactNode; children: ReactNode }) {
  return <div className="space-y-5">{children}</div>
}
