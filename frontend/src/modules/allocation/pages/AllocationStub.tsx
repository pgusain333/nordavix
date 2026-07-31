/**
 * AllocationStub — honest placeholder for the Allocate sections whose backend
 * hasn't shipped yet.
 *
 * S0 wires the product shell and routing; Runs / Setup / Settings get their
 * real screens in S3–S4 once the engine (S2) and the run + roster endpoints
 * exist. Rendering a labelled stub beats either a dead nav link or a screen of
 * invented data.
 */
import type { LucideIcon } from "lucide-react"

interface Props {
  title:   string
  icon:    LucideIcon
  summary: string
  /** What has to land before this screen becomes real. */
  pending: string[]
}

export function AllocationStub({ title, icon: Icon, summary, pending }: Props) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-5 py-6">
        <h1 className="text-lg font-semibold text-theme tracking-tight">{title}</h1>
        <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>{summary}</p>

        <div
          className="mt-5 rounded-xl px-5 py-5"
          style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
        >
          <div className="flex items-start gap-3">
            <div
              className="h-9 w-9 rounded-lg flex items-center justify-center shrink-0"
              style={{ background: "var(--green-subtle)" }}
            >
              <Icon size={17} strokeWidth={1.7} style={{ color: "var(--green)" }} />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-theme">Not built yet</p>
              <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
                This section needs the following to land first:
              </p>
              <ul className="mt-2.5 space-y-1.5">
                {pending.map((p) => (
                  <li key={p} className="flex items-start gap-2 text-xs" style={{ color: "var(--text-2)" }}>
                    <span
                      className="mt-[6px] h-1 w-1 rounded-full shrink-0"
                      style={{ background: "var(--text-muted)" }}
                    />
                    {p}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
