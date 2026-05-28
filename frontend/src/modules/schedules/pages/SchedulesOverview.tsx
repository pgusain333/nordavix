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
import { useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
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

const ACCENTS: Record<ScheduleType, { fg: string; bg: string }> = {
  prepaid:     { fg: "#1d4ed8", bg: "rgba(29, 78, 216, 0.10)" },   // blue
  accrual:     { fg: "#b45309", bg: "rgba(245, 158, 11, 0.12)" }, // amber
  fixed_asset: { fg: "#15803d", bg: "rgba(21, 128, 61, 0.10)" },  // green
  lease:       { fg: "#7c3aed", bg: "rgba(124, 58, 237, 0.10)" }, // violet
  loan:        { fg: "#be123c", bg: "rgba(190, 18, 60, 0.10)" },  // rose
}

function fmtMoney(s: string): string {
  const n = parseFloat(s) || 0
  const abs = `$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
  return n < 0 ? `(${abs})` : abs
}

export function SchedulesOverview() {
  const navigate = useNavigate()
  const [periodEnd, setPeriodEnd] = useState<string>(useSelectedPeriodDefault(defaultPeriodEnd()))
  /** Don't auto-compute roll-forwards on mount — the user picks the
   * period first and clicks Load. Once loaded, period changes auto-
   * refetch as normal (TanStack Query's queryKey-based caching). */
  const [hasLoaded, setHasLoaded] = useState(false)

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
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}
        className="px-4 sm:px-8 pt-6 pb-5"
        style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <BookOpen size={20} strokeWidth={1.8} style={{ color: "var(--green)" }} />
              <h1 className="text-2xl font-bold text-theme" style={{ letterSpacing: "-0.01em" }}>
                Schedules
              </h1>
            </div>
            <p className="text-xs sm:text-sm max-w-2xl" style={{ color: "var(--text-muted)" }}>
              Workpapers behind every balance-sheet account. Each schedule's ending
              balance auto-populates the subledger on its GL account's reconciliation,
              so you enter the data once and the recon stays in sync forever after.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] font-semibold uppercase tracking-wide"
              style={{ color: "var(--text-muted)" }}>
              Period end
            </span>
            <DatePicker value={periodEnd} onChange={setPeriodEnd} />
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
        {/* Sum across types */}
        {data && (
          <div className="mt-4 inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs"
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
        )}
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
