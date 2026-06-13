/**
 * Schedules overview — the landing page at /app/schedules.
 *
 * Renders one card per schedule type with the current-period active
 * count + ending balance + commit status. Clicking a card opens that
 * type's detail page. A period selector at the top drives all five
 * computations together so the user gets a single point-in-time view.
 *
 * Below the grid: a small "What are schedules?" callout that explains
 * the recon-interlink magic so first-time users understand why they
 * should fill these out.
 */
import { useEffect, useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { useOrganization } from "@clerk/clerk-react"
import { motion } from "framer-motion"
import {
  Calendar, ClipboardList, Building2, Home, Banknote,
  ArrowRight, CheckCircle2, Sparkles, BookOpen, RefreshCw,
} from "lucide-react"

import { Button, Spinner } from "@/core/ui/components"
import { DatePicker } from "@/core/ui/DatePicker"
import { useSelectedPeriodDefault } from "@/core/hooks/useSelectedPeriod"
import { schedulesApi } from "@/modules/schedules/api"
import {
  SCHEDULE_BLURB, SCHEDULE_HUMAN, SCHEDULE_ROUTE,
  type OverviewType, type ScheduleType,
} from "@/modules/schedules/types"

/**
 * Persistence for hasLoaded across navigation. Without this, drilling
 * into a schedule type and clicking back wipes the dashboard back to
 * the blank-cards empty state because `hasLoaded` is component-local
 * state. We persist a per-org flag in sessionStorage so the overview
 * auto-loads on remount within the same browser session.
 *
 * Why sessionStorage, not localStorage: the flag should reset on a
 * fresh tab so a returning user sees "click Load" intentionality —
 * but within a session, drilling in/out should feel seamless.
 */
function schedulesLoadedKey(orgId: string | undefined): string {
  return `nordavix:schedules:loaded:${orgId ?? "anon"}`
}

/** Default to last day of the previous full month. */
function defaultPeriodEnd(): string {
  const now = new Date()
  const last = new Date(now.getFullYear(), now.getMonth(), 0)
  return last.toISOString().slice(0, 10)
}

const ICONS: Record<ScheduleType, React.ReactNode> = {
  prepaid:     <Calendar      size={20} strokeWidth={1.6} />,
  accrual:     <ClipboardList size={20} strokeWidth={1.6} />,
  fixed_asset: <Building2     size={20} strokeWidth={1.6} />,
  lease:       <Home          size={20} strokeWidth={1.6} />,
  loan:        <Banknote      size={20} strokeWidth={1.6} />,
}

// Neutral, uniform chips — the icon (Calendar / ClipboardList / Building2 /
// Home / Banknote) carries the type, not color. Keeps the overview calm.
const NEUTRAL_ACCENT = { fg: "var(--text-2)", bg: "var(--surface-2)" }
const ACCENTS: Record<ScheduleType, { fg: string; bg: string }> = {
  prepaid:     NEUTRAL_ACCENT,
  accrual:     NEUTRAL_ACCENT,
  fixed_asset: NEUTRAL_ACCENT,
  lease:       NEUTRAL_ACCENT,
  loan:        NEUTRAL_ACCENT,
}

function fmtMoney(s: string): string {
  const n = parseFloat(s) || 0
  const abs = `$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
  return n < 0 ? `(${abs})` : abs
}

export function SchedulesOverview() {
  const navigate = useNavigate()
  const { organization } = useOrganization()
  const [periodEnd, setPeriodEnd] = useState<string>(useSelectedPeriodDefault(defaultPeriodEnd()))
  /** Don't auto-compute roll-forwards on mount — the user picks the
   * period first and clicks Load. Once loaded, period changes auto-
   * refetch as normal (TanStack Query's queryKey-based caching).
   *
   * We restore hasLoaded from sessionStorage on mount so back-nav
   * from a schedule detail page doesn't wipe the dashboard back to
   * the blank-cards state. The React Query cache survives the unmount
   * (default 5-min gcTime), so flipping hasLoaded on rehydrates the
   * data immediately without a refetch. */
  const orgKey = schedulesLoadedKey(organization?.id)
  const [hasLoaded, setHasLoaded] = useState<boolean>(() => {
    try { return typeof window !== "undefined" && sessionStorage.getItem(orgKey) === "1" }
    catch { return false }
  })

  // If the org changes mid-session (workspace switcher), re-read the
  // flag for the new org. Without this, switching orgs would carry the
  // previous org's loaded state into the new workspace.
  useEffect(() => {
    try { setHasLoaded(sessionStorage.getItem(orgKey) === "1") } catch { /* ignore */ }
  }, [orgKey])

  // Persist whenever the flag flips on. We never write false — the only
  // way to "reset" is opening a new tab (a fresh session).
  useEffect(() => {
    if (!hasLoaded) return
    try { sessionStorage.setItem(orgKey, "1") } catch { /* ignore */ }
  }, [hasLoaded, orgKey])

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["schedules", "overview", periodEnd],
    queryFn:  () => schedulesApi.getOverview(periodEnd),
    enabled:  hasLoaded,
  })

  const totalAcrossTypes = useMemo(() => {
    if (!data) return 0
    return data.types.reduce((sum, t) => sum + (parseFloat(t.ending_balance) || 0), 0)
  }, [data])

  return (
    <div className="flex flex-col h-full overflow-y-auto" style={{ background: "var(--bg)" }}>
      {/* Header — compact, sized to match the recon / flux close-workflow
          pages (single-line blurb, h-[26px] date picker). */}
      <motion.div
        initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}
        className="px-4 sm:px-8 pt-3 sm:pt-4 pb-3"
        style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-0.5 lg:hidden">
              <BookOpen size={18} strokeWidth={1.8} style={{ color: "var(--green)" }} />
              <h1 style={{ fontSize: "clamp(16px, 3vw, 20px)", fontWeight: 700, lineHeight: 1.15, letterSpacing: "-0.01em", color: "var(--text)", margin: 0 }}>
                Schedules
              </h1>
            </div>
            <p className="text-[11px] mt-0.5 truncate max-w-2xl" style={{ color: "var(--text-muted)" }}>
              Workpapers behind every balance-sheet account · each schedule's ending balance auto-feeds its reconciliation.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap w-full sm:w-auto">
            <DatePicker
              value={periodEnd}
              onChange={setPeriodEnd}
              className="inline-block"
              triggerClassName="inline-flex items-center gap-1.5 h-[26px] px-2.5 text-xs rounded-md outline-none transition-colors hover:bg-[var(--surface)]"
            />
            <Button
              size="sm"
              onClick={() => { setHasLoaded(true); if (hasLoaded) refetch() }}
              loading={isFetching}
              icon={<RefreshCw size={14} strokeWidth={1.8} />}
            >
              {hasLoaded ? "Refresh" : "Load schedules"}
            </Button>
          </div>
        </div>
      </motion.div>

      {/* Grid */}
      <div className="flex-1 px-4 sm:px-8 py-6 max-w-6xl w-full mx-auto">
        {!hasLoaded ? (
          // Pre-load: render the 5 cards skeletonised with blank numbers
          // so the layout's stable, just no real data yet. Subtle hint
          // below tells the user to click Load above.
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {(["prepaid", "accrual", "fixed_asset", "lease", "loan"] as const).map((t, idx) => (
                <ScheduleCard
                  key={t}
                  t={{
                    type: t,
                    human_name: SCHEDULE_HUMAN[t],
                    active_count: 0,
                    total_count: 0,
                    ending_balance: "0",
                    period_expense: "0",
                    any_committed_for_period: false,
                  }}
                  delay={idx * 0.04}
                  blank
                  onOpen={() => navigate(SCHEDULE_ROUTE[t])}
                />
              ))}
            </div>
            <p className="text-[11px] text-center mt-6"
              style={{ color: "var(--text-muted)" }}>
              Pick a period end above and click{" "}
              <span className="font-semibold text-theme">Load schedules</span> to
              compute the snapshot for all five types.
            </p>
          </>
        ) : isLoading || !data ? (
          <div className="py-20 flex flex-col items-center justify-center gap-2">
            <Spinner className="h-6 w-6" />
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              Computing roll-forwards…
            </p>
          </div>
        ) : (
          <>
            {/* Sum across types — moved out of the header so the top bar
                stays the same height as the other modules. */}
            <div className="mb-4 inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs"
              style={{
                background: "var(--green-subtle)",
                border: "1px solid var(--green)",
                color: "var(--green)",
              }}>
              <Sparkles size={12} strokeWidth={2} />
              <span>
                Schedules cover{" "}
                <span className="font-bold tabular-nums">
                  {fmtMoney(totalAcrossTypes.toString())}
                </span>{" "}
                across {data.types.reduce((s, t) => s + t.active_count, 0)} line items at{" "}
                {periodEnd}.
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {data.types.map((t, idx) => (
                <ScheduleCard
                  key={t.type}
                  t={t}
                  delay={idx * 0.04}
                  onOpen={() => navigate(SCHEDULE_ROUTE[t.type])}
                />
              ))}
            </div>

            {/* Why these schedules */}
            <motion.div
              initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, delay: 0.25 }}
              className="mt-8 rounded-xl p-5"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                boxShadow: "var(--card-shadow)",
              }}>
              <h2 className="text-sm font-semibold text-theme mb-2 inline-flex items-center gap-2">
                <Sparkles size={14} strokeWidth={1.8} style={{ color: "var(--green)" }} />
                Why every close needs these schedules
              </h2>
              <ul className="text-xs space-y-1.5" style={{ color: "var(--text-2)" }}>
                <li>
                  <span className="font-semibold text-theme">Enter once, reconcile forever.</span>{" "}
                  Add a prepaid invoice or a fixed asset once. Every future month's
                  reconciliation pulls the schedule's ending balance automatically as the
                  subledger — no re-keying, no spreadsheets.
                </li>
                <li>
                  <span className="font-semibold text-theme">Defensible math.</span>{" "}
                  Straight-line amortization, depreciation, and amortization tables are
                  computed by Nordavix — no formula bugs, no rounding drift.
                </li>
                <li>
                  <span className="font-semibold text-theme">Variances mean something.</span>{" "}
                  When GL and the schedule disagree, the recon flags a real anomaly — not a
                  spreadsheet typo. That's the difference between busywork and real close
                  review.
                </li>
              </ul>
            </motion.div>
          </>
        )}
      </div>
    </div>
  )
}

// ── Card ─────────────────────────────────────────────────────────────────

function ScheduleCard({ t, delay, onOpen, blank }: {
  t:       OverviewType
  delay:   number
  onOpen:  () => void
  /** When true, render placeholder dashes instead of the (likely zero)
   * numeric values — communicates "not loaded yet" without hiding the
   * card layout. */
  blank?:  boolean
}) {
  const accent = ACCENTS[t.type]
  return (
    <motion.button
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay }}
      onClick={onOpen}
      className="text-left rounded-xl p-5 transition-all group"
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        boxShadow: "var(--card-shadow)",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = accent.fg
        e.currentTarget.style.transform = "translateY(-2px)"
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "var(--border)"
        e.currentTarget.style.transform = "translateY(0)"
      }}
    >
      <div className="flex items-start justify-between mb-3">
        <div className="h-10 w-10 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: accent.bg, color: accent.fg }}>
          {ICONS[t.type]}
        </div>
        <ArrowRight size={14} strokeWidth={1.8}
          style={{ color: "var(--text-muted)" }}
          className="opacity-0 group-hover:opacity-100 transition-opacity mt-1" />
      </div>
      <p className="text-sm font-semibold text-theme mb-0.5">{SCHEDULE_HUMAN[t.type]}</p>
      <p className="text-[11px] mb-3 line-clamp-2" style={{ color: "var(--text-muted)" }}>
        {SCHEDULE_BLURB[t.type]}
      </p>
      <div className="flex items-end justify-between gap-2">
        <div>
          <p className="text-[10px] uppercase tracking-wider font-semibold"
            style={{ color: "var(--text-muted)" }}>
            Ending balance
          </p>
          <p className="text-lg font-bold tabular-nums mt-0.5"
            style={{ color: blank ? "var(--text-muted)" : "var(--text)" }}>
            {blank ? "—" : fmtMoney(t.ending_balance)}
          </p>
        </div>
        <div className="text-right">
          <p className="text-[10px] uppercase tracking-wider font-semibold"
            style={{ color: "var(--text-muted)" }}>
            Active
          </p>
          <p className="text-sm font-semibold mt-0.5 tabular-nums"
            style={{ color: blank ? "var(--text-muted)" : "var(--text)" }}>
            {blank ? "—" : (
              <>
                {t.active_count}
                <span className="text-[10px] font-normal ml-1" style={{ color: "var(--text-muted)" }}>
                  of {t.total_count}
                </span>
              </>
            )}
          </p>
        </div>
      </div>
      <div className="mt-3 pt-3 flex items-center justify-between text-[10px]"
        style={{ borderTop: "1px solid var(--border)" }}>
        <span style={{ color: "var(--text-muted)" }}>This period</span>
        {blank ? (
          <span className="font-semibold" style={{ color: "var(--text-muted)" }}>—</span>
        ) : t.any_committed_for_period ? (
          <span className="inline-flex items-center gap-1 font-semibold"
            style={{ color: "var(--green)" }}>
            <CheckCircle2 size={10} strokeWidth={2.4} />
            Snapshot committed
          </span>
        ) : (
          <span className="font-semibold" style={{ color: "var(--text-muted)" }}>
            Draft
          </span>
        )}
      </div>
    </motion.button>
  )
}
