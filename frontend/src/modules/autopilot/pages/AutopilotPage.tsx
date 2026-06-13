/**
 * Close Autopilot — first-class page.
 *
 * Promotes the flagship "run my whole close on its own" feature out of the
 * Settings drawer into its own left-nav destination. The page is a thin shell:
 * AutopilotSection already renders the full experience (live hero, one-time
 * setup, run history), so here we just give it the app-shell chrome and a
 * comfortable reading column. Wrapped in an ErrorBoundary so a render fault in
 * the section never blanks the whole app.
 */
import { ErrorBoundary } from "@/core/ui/ErrorBoundary"
import { AutopilotSection } from "@/modules/autopilot/AutopilotSection"

export function AutopilotPage() {
  return (
    <div className="flex flex-col h-full overflow-y-auto" style={{ background: "var(--bg)" }}>
      <div className="px-4 sm:px-8 py-5 max-w-5xl w-full mx-auto">
        <ErrorBoundary label="Close Autopilot">
          <AutopilotSection />
        </ErrorBoundary>
      </div>
    </div>
  )
}
