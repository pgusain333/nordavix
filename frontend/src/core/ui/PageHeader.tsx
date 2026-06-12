/**
 * PageHeader — the compact, single-row module header.
 *
 * Replaces the old three-deck header (back link / big h1 / two-line
 * subtitle) that every module page stacked under the global TopBar —
 * ~140px of chrome before any content. This collapses the same
 * information into one ~48px row:
 *
 *   [←]  Title  │ subtitle, one line, truncated …        [actions]
 *
 * Design decisions:
 *  - Back is an icon-only button (tooltip carries the label). The text
 *    label was redundant — the arrow + position is a universal pattern.
 *  - Subtitle truncates to one line with the full text on hover
 *    (title attr). It's an explainer, not content — it shouldn't cost
 *    two lines on every visit. Hidden on small screens entirely.
 *  - No entrance animation: the header is chrome, and chrome that
 *    fades in on every navigation reads as latency, not polish.
 *  - `hideTitleOnDesktop` keeps the existing behavior of pages whose
 *    name already appears in the global TopBar on lg+ (Tasks,
 *    Intercompany, Financial Package) — no double title.
 */
import type { ReactNode } from "react"
import { useNavigate } from "react-router-dom"
import { ArrowLeft } from "lucide-react"

interface PageHeaderProps {
  title: string
  subtitle?: string
  /** Where the back button goes. Defaults to the workspace dashboard. */
  backTo?: string
  /** Right-aligned controls (buttons, pickers). */
  actions?: ReactNode
  /** Extra classes on the outer bar (e.g. "relative z-30" for pages
   *  with dropdowns that must stack above sticky siblings). */
  className?: string
  /** Optional second row inside the bar (e.g. quick-period chips). */
  children?: ReactNode
}

export function PageHeader({
  title,
  subtitle,
  backTo = "/app",
  actions,
  className = "",
  children,
}: PageHeaderProps) {
  const navigate = useNavigate()
  return (
    <div
      className={`px-4 sm:px-6 py-2 ${className}`}
      style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}
    >
      <div className="flex items-center gap-2.5 flex-wrap min-h-[34px]">
        <button
          onClick={() => navigate(backTo)}
          aria-label="Back to dashboard"
          title="Back to dashboard"
          className="h-7 w-7 rounded-md inline-flex items-center justify-center shrink-0 transition-colors hover:bg-[var(--surface-2)]"
          style={{ color: "var(--text-muted)", border: "1px solid var(--border)" }}
        >
          <ArrowLeft size={13} strokeWidth={2} />
        </button>

        {/* Module name is ALWAYS visible — it anchors which app you're in
            no matter how the page was reached. */}
        <h1
          className="shrink-0"
          style={{
            fontSize: 15, fontWeight: 700, lineHeight: 1.2,
            letterSpacing: "-0.01em", color: "var(--text)", margin: 0,
          }}
        >
          {title}
        </h1>

        {subtitle && (
          <p
            className="hidden md:block text-xs truncate min-w-0 flex-1 pl-2.5"
            style={{ color: "var(--text-muted)", borderLeft: "1px solid var(--border)" }}
            title={subtitle}
          >
            {subtitle}
          </p>
        )}

        <div className="ml-auto flex items-center gap-2 flex-wrap shrink-0">
          {actions}
        </div>
      </div>
      {children}
    </div>
  )
}
