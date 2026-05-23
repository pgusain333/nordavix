import { ReactNode } from "react"
import { LeftNav } from "./LeftNav"
import { ClerkApiWirer } from "@/core/auth/ClerkProvider"

interface ThreePaneLayoutProps {
  children: ReactNode
  rightPane?: ReactNode
  rightPaneTitle?: string
}

/**
 * Root layout for all authenticated pages.
 *
 * ┌─────────────┬──────────────────────────────┬──────────────┐
 * │  Left Nav   │       Center Workspace        │  Right Pane  │
 * │   (240px)   │         (flex-1)              │   (320px)    │
 * │  white, fx  │  scrollable, main content     │  context,    │
 * │             │                               │  collapsible │
 * └─────────────┴──────────────────────────────┴──────────────┘
 *
 * The right pane is optional — only rendered when `rightPane` is provided.
 */
export function ThreePaneLayout({ children, rightPane, rightPaneTitle }: ThreePaneLayoutProps) {
  return (
    <div className="flex h-screen overflow-hidden bg-theme">
      {/* Wire Clerk tokens into the API client on mount */}
      <ClerkApiWirer />

      <LeftNav />

      <main className="flex flex-1 flex-col overflow-hidden min-w-0">
        {children}
      </main>

      {rightPane && (
        <aside className="flex h-screen w-80 shrink-0 flex-col border-theme"
          style={{ background: "var(--surface)", borderLeft: "1px solid var(--border)" }}>
          {rightPaneTitle && (
            <div className="flex items-center px-4 py-3 border-theme"
              style={{ borderBottom: "1px solid var(--border)" }}>
              <h2 className="text-sm font-semibold text-theme">{rightPaneTitle}</h2>
            </div>
          )}
          <div className="flex-1 overflow-y-auto p-4">{rightPane}</div>
        </aside>
      )}
    </div>
  )
}
