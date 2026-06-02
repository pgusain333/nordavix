/**
 * OnboardingChecklist — dashboard card that drives a new workspace through
 * first-run setup. Backend-derived (no manual ticking): each step's done-state
 * comes from real data (QBO connection, books start, first sync/recon/flux,
 * team). Auto-hides once every essential step is done; the user can also
 * dismiss it early (remembered per browser).
 */
import { useState } from "react"
import { Link } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { CheckCircle2, ArrowRight, Sparkles, X, Eye } from "lucide-react"
import { onboardingApi } from "@/modules/onboarding/api"
import { useDemoMode } from "@/core/demo/DemoModeProvider"

const DISMISS_KEY = "nordavix_onboarding_dismissed"

export function OnboardingChecklist() {
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(DISMISS_KEY) === "1" } catch { return false }
  })

  const { enterDemo } = useDemoMode()

  const { data } = useQuery({
    queryKey:  ["onboarding-status"],
    queryFn:   onboardingApi.getStatus,
    staleTime: 60_000,
  })

  // Hide when we have nothing to show, when setup is complete, or dismissed.
  if (!data || data.complete || dismissed) return null

  const required = data.steps.filter((s) => !s.optional)
  const reqDone  = required.filter((s) => s.done).length
  const pct      = required.length ? Math.round((reqDone / required.length) * 100) : 0

  function dismiss() {
    try { localStorage.setItem(DISMISS_KEY, "1") } catch { /* ignore */ }
    setDismissed(true)
  }

  return (
    <div className="rounded-xl overflow-hidden"
      style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
      {/* Header + progress count + dismiss */}
      <div className="px-4 py-3 flex items-center gap-3" style={{ borderBottom: "1px solid var(--border)" }}>
        <div className="h-8 w-8 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
          <Sparkles size={16} strokeWidth={1.8} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-theme">Finish setting up your workspace</h2>
          <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
            {reqDone} of {required.length} essentials done
          </p>
        </div>
        <button onClick={dismiss}
          className="shrink-0 h-7 w-7 inline-flex items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-2)]"
          style={{ color: "var(--text-muted)" }} title="Dismiss" aria-label="Dismiss setup checklist">
          <X size={14} strokeWidth={2} />
        </button>
      </div>

      {/* Progress bar */}
      <div className="h-1" style={{ background: "var(--surface-2)" }}>
        <div className="h-full" style={{ width: `${pct}%`, background: "var(--green)", transition: "width 0.3s ease" }} />
      </div>

      {/* Steps */}
      <ol className="p-3 space-y-1.5">
        {data.steps.map((s) => (
          <li key={s.key}
            className="flex items-center gap-3 px-3 py-2 rounded-lg"
            style={{ background: s.done ? "var(--green-subtle)" : "var(--surface-2)" }}>
            {s.done
              ? <CheckCircle2 size={16} strokeWidth={2} style={{ color: "var(--green)" }} className="shrink-0" />
              : <span className="h-4 w-4 rounded-full shrink-0" style={{ border: "2px solid var(--text-muted)" }} />}
            <div className="min-w-0 flex-1">
              <p className="text-sm"
                style={{ color: s.done ? "var(--green)" : "var(--text)", textDecoration: s.done ? "line-through" : "none" }}>
                {s.label}{s.optional && !s.done ? " · optional" : ""}
              </p>
              {!s.done && (
                <p className="text-[11px] leading-snug" style={{ color: "var(--text-muted)" }}>{s.description}</p>
              )}
            </div>
            {!s.done && (
              <Link to={s.cta}
                className="shrink-0 inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors"
                style={{ background: "var(--surface)", border: "1px solid var(--border-strong)", color: "var(--text)" }}>
                Do it <ArrowRight size={11} strokeWidth={2} />
              </Link>
            )}
          </li>
        ))}
      </ol>

      {/* Escape hatch — see the product working on a sample company without
          connecting QuickBooks first. */}
      <div className="px-3 pb-3 -mt-1">
        <button onClick={enterDemo}
          className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors"
          style={{ background: "transparent", border: "1px dashed var(--border-strong)", color: "var(--text-2)" }}>
          <Eye size={13} strokeWidth={1.8} /> Just exploring? Open a sample company
        </button>
      </div>
    </div>
  )
}
