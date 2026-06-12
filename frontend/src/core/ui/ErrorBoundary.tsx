/**
 * ErrorBoundary — contains a render-time exception to a subtree instead
 * of letting it white-screen the whole app.
 *
 * React has no hook form of this (boundaries must be class components),
 * so this is the one place we use a class. Wrap any non-trivial widget
 * that a user is actively working inside — a thrown error in one panel
 * should never blank a CPA's reconciliation mid-close.
 */
import { Component, type ReactNode } from "react"

interface Props {
  children: ReactNode
  /** Shown when the subtree throws. Defaults to a quiet inline notice. */
  fallback?: ReactNode
  /** Optional label for the default fallback copy ("… in {label}"). */
  label?: string
}

export class ErrorBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }

  componentDidCatch(error: unknown) {
    // Surfaced in the console + (in prod) Sentry's global handler; we
    // intentionally don't rethrow so the rest of the page keeps working.
    // eslint-disable-next-line no-console
    console.error(`[ErrorBoundary${this.props.label ? ` · ${this.props.label}` : ""}]`, error)
  }

  render() {
    if (!this.state.failed) return this.props.children
    if (this.props.fallback !== undefined) return this.props.fallback
    return (
      <div className="rounded-lg p-4 text-sm"
        style={{ background: "#f7eeec", border: "1px solid #ecd7d3", color: "#86332e" }}>
        Something on this panel hit an error{this.props.label ? ` (${this.props.label})` : ""}.
        The rest of your work is safe — reload the page to retry.
      </div>
    )
  }
}
