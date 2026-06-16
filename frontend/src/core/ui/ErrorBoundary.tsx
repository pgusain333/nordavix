/**
 * ErrorBoundary — contains a render-time exception to a subtree instead
 * of letting it white-screen the whole app.
 *
 * React has no hook form of this (boundaries must be class components),
 * so this is the one place we use a class. Wrap any non-trivial widget
 * that a user is actively working inside — a thrown error in one panel
 * should never blank a CPA's reconciliation mid-close.
 *
 * The default fallback shows the actual error message. During beta that's
 * a feature: a screenshot of the fallback is enough to pinpoint the bug
 * without needing the browser console.
 */
import { Component, type ReactNode } from "react"

interface Props {
  children: ReactNode
  /** Shown when the subtree throws. Defaults to a notice that includes the
   *  error message (useful for diagnosing without the console). */
  fallback?: ReactNode
  /** Optional label for the default fallback copy ("… in {label}"). */
  label?: string
}

function errMsg(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  try { return String(error) } catch { return "Unknown error" }
}

export class ErrorBoundary extends Component<Props, { error: unknown }> {
  state: { error: unknown } = { error: null }
  static getDerivedStateFromError(error: unknown) { return { error } }

  componentDidCatch(error: unknown) {
    // Surfaced in the console + (in prod) Sentry's global handler; we
    // intentionally don't rethrow so the rest of the page keeps working.
    // eslint-disable-next-line no-console
    console.error(`[ErrorBoundary${this.props.label ? ` · ${this.props.label}` : ""}]`, error)
  }

  render() {
    if (!this.state.error) return this.props.children
    if (this.props.fallback !== undefined) return this.props.fallback
    return (
      <div className="rounded-lg p-4 text-sm"
        style={{ background: "var(--danger-subtle)", border: "1px solid var(--danger-border)", color: "var(--danger)" }}>
        <p className="font-semibold">
          Something on this panel hit an error{this.props.label ? ` (${this.props.label})` : ""}.
        </p>
        <p className="mt-1 text-[13px]">The rest of your work is safe — reload the page to retry.</p>
        <p className="mt-2 font-mono text-[11px] leading-relaxed rounded px-2 py-1.5"
          style={{ background: "var(--surface)", border: "1px solid var(--danger-border)", color: "var(--danger)", wordBreak: "break-word" }}>
          {errMsg(this.state.error)}
        </p>
      </div>
    )
  }
}
