/**
 * Insights — decision-grade dashboard, not a vanity chart wall.
 *
 * UX notes:
 *  • No auto-fetch. The user picks a period (month or custom range)
 *    and clicks Generate. Re-clicking Generate refreshes.
 *  • Sticky sub-nav: scrolls anchor the visible section via
 *    IntersectionObserver so the user knows where they are; clicking
 *    a pill smooth-scrolls there.
 *  • Sparklines are interactive — hover for tooltip with exact
 *    value + date; click a point to refocus the whole page on that
 *    month (re-fetches automatically).
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { motion, AnimatePresence } from "framer-motion"
import {
  TrendingUp, TrendingDown, Wallet, ReceiptText, ArrowDownToLine,
  ArrowUpFromLine, LineChart as LineIcon, Sparkles, AlertTriangle,
  Play, Info, Lightbulb, MousePointerClick,
  Target, Eye, ShieldCheck, CheckCircle2,
  CalendarClock, Scale, Gauge, RefreshCw,
} from "lucide-react"
import { Spinner } from "@/core/ui/components"
import { DatePicker } from "@/core/ui/DatePicker"
import {
  insightsApi, type InsightsOverview, type KpiRow, type RiskLevel, type HistoryPoint,
  type Advisory,
} from "@/modules/insights/api"

// ── Period helpers ───────────────────────────────────────────────────────────

function lastDayOfMonth(year: number, monthIdx: number): string {
  const last = new Date(year, monthIdx + 1, 0)
  return last.toISOString().slice(0, 10)
}
function firstDayOfMonth(year: number, monthIdx: number): string {
  return new Date(year, monthIdx, 1).toISOString().slice(0, 10)
}
function defaultPeriodEnd(): string {
  const now = new Date()
  return lastDayOfMonth(now.getFullYear(), now.getMonth() - 1)
}
function defaultPeriodStart(periodEnd: string): string {
  const d = new Date(periodEnd)
  return firstDayOfMonth(d.getFullYear(), d.getMonth())
}
function monthOptions(): { value: string; label: string }[] {
  const now = new Date()
  const out: { value: string; label: string }[] = []
  for (let i = 1; i <= 24; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    out.push({
      value: lastDayOfMonth(d.getFullYear(), d.getMonth()),
      label: d.toLocaleString("en-US", { month: "long", year: "numeric" }),
    })
  }
  return out
}
/** "Synced {time}" label — compact local timestamp of the cached compute. */
function fmtSyncedAt(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  })
}

// Section anchor registry
const SECTIONS = [
  { id: "recommendations", label: "Risks",         icon: AlertTriangle },
  { id: "liquidity",       label: "Liquidity",     icon: Wallet },
  { id: "cash_forecast",   label: "Forecast",      icon: CalendarClock },
  { id: "balance_sheet",   label: "Balance sheet", icon: Scale },
  { id: "profitability",   label: "P&L",           icon: LineIcon },
  { id: "growth",          label: "Growth",        icon: TrendingUp },
  { id: "breakeven",       label: "Break-even",    icon: Gauge },
  { id: "receivables",     label: "AR",            icon: ArrowDownToLine },
  { id: "payables",        label: "AP",            icon: ArrowUpFromLine },
  { id: "expenses",        label: "Expenses",      icon: ReceiptText },
] as const

type SectionId = typeof SECTIONS[number]["id"]

// ── Main page ────────────────────────────────────────────────────────────────

type DateMode = "month" | "custom"

interface PendingPeriod {
  mode:         DateMode
  periodEnd:    string
  periodStart?: string  // present when mode === "custom"
}

export function InsightsPage() {
  const [searchParams, setSearchParams] = useSearchParams()

  // ── Form state (what's in the picker, not necessarily what's loaded) ──
  const initialEnd = searchParams.get("period_end") || searchParams.get("period") || defaultPeriodEnd()
  const initialStart = searchParams.get("period_start") || undefined
  const initialMode: DateMode = initialStart ? "custom" : "month"

  const [mode, setMode] = useState<DateMode>(initialMode)
  const [periodEnd, setPeriodEnd] = useState<string>(initialEnd)
  const [periodStart, setPeriodStart] = useState<string>(initialStart ?? defaultPeriodStart(initialEnd))

  // ── What's actually been requested (gates the query) ──
  const [pending, setPending] = useState<PendingPeriod | null>(() => {
    // Only auto-load if the URL had explicit params (i.e. a shared link)
    if (searchParams.get("period_end") || searchParams.get("period")) {
      return initialStart
        ? { mode: "custom", periodEnd: initialEnd, periodStart: initialStart }
        : { mode: "month",  periodEnd: initialEnd }
    }
    return null
  })

  const queryKey = useMemo(
    () => ["insights-overview", pending?.periodEnd ?? null, pending?.periodStart ?? null] as const,
    [pending],
  )

  const { data, isFetching, error } = useQuery<InsightsOverview, Error>({
    queryKey,
    queryFn:  () => insightsApi.getOverview(pending!.periodEnd, pending?.periodStart ?? null),
    enabled:  pending !== null,
    // Insights are persisted server-side now, so a plain load returns the saved
    // snapshot instantly. Keep it effectively fresh until the user hits Sync.
    staleTime: Infinity,
  })

  // ── Sync: recompute the loaded period (refresh=1) and overwrite the cache ──
  const qc = useQueryClient()
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)

  async function sync() {
    if (!pending) return
    setSyncing(true)
    setSyncError(null)
    try {
      const fresh = await insightsApi.getOverview(pending.periodEnd, pending.periodStart ?? null, true)
      qc.setQueryData(queryKey, fresh)
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : "Sync failed")
    } finally {
      setSyncing(false)
    }
  }

  function generate() {
    // Month mode used to send only period_end and let the backend compute
    // monthly P&L via snapshot YTD diffs — which silently broke whenever a
    // prior-month snapshot was missing or stale. Always send period_start
    // too (1st of the chosen calendar month when in Month mode) so the
    // backend runs the same live QBO P&L call as Custom range. One path,
    // one source of truth.
    const effectiveStart = mode === "custom" ? periodStart : defaultPeriodStart(periodEnd)
    const payload: PendingPeriod = { mode, periodEnd, periodStart: effectiveStart }
    setPending(payload)
    const next = new URLSearchParams(searchParams)
    next.set("period_end", payload.periodEnd)
    next.set("period_start", effectiveStart)
    next.delete("period")  // legacy key
    setSearchParams(next, { replace: true })
  }

  function jumpToMonth(periodEndISO: string) {
    const start = defaultPeriodStart(periodEndISO)
    setMode("month")
    setPeriodEnd(periodEndISO)
    setPeriodStart(start)
    const payload: PendingPeriod = { mode: "month", periodEnd: periodEndISO, periodStart: start }
    setPending(payload)
    const next = new URLSearchParams(searchParams)
    next.set("period_end", payload.periodEnd)
    next.set("period_start", start)
    next.delete("period")
    setSearchParams(next, { replace: true })
  }

  // ── Layout ─────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full overflow-y-auto" style={{ background: "var(--bg)" }}>
      <Header
        mode={mode} setMode={setMode}
        periodEnd={periodEnd} setPeriodEnd={setPeriodEnd}
        periodStart={periodStart} setPeriodStart={setPeriodStart}
        onGenerate={generate}
        isFetching={isFetching}
        loadedLabel={data?.period_label}
        savedAt={data?.saved_at}
        onSync={sync}
        isSyncing={syncing}
        syncError={syncError}
      />

      {pending && data && <JumpNav data={data} />}

      <div className="flex-1 px-4 sm:px-8 py-6 max-w-7xl w-full mx-auto">
        {/* Empty state — never auto-loaded */}
        {!pending && (
          <EmptyState onGenerate={generate} />
        )}

        {pending && !data && isFetching && (
          <div className="h-64 flex flex-col items-center justify-center gap-3">
            <Spinner className="h-6 w-6" />
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>
              Crunching the numbers…
            </p>
          </div>
        )}

        {pending && error && !isFetching && (
          <div className="rounded-lg p-4 flex items-start gap-3"
            style={{ background: "#fef2f2", border: "1px solid #fecaca" }}>
            <AlertTriangle size={16} className="shrink-0 mt-0.5" style={{ color: "#dc2626" }} />
            <div>
              <p className="text-sm font-semibold" style={{ color: "#991b1b" }}>Could not load insights</p>
              <p className="text-xs mt-1" style={{ color: "#991b1b" }}>{error.message}</p>
            </div>
          </div>
        )}

        {pending && data && (
          <AnimatePresence mode="wait">
            <motion.div
              key={`${data.period_end}-${data.period_start ?? ""}`}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.22, ease: "easeOut" }}
              className="space-y-6"
            >
              {data.custom_range && data.custom_pl_error && (
                <div className="rounded-lg p-3 flex items-start gap-2"
                  style={{ background: "#fef3c7", border: "1px solid #f59e0b" }}>
                  <Info size={14} className="shrink-0 mt-0.5" style={{ color: "#92400e" }} />
                  <p className="text-[12px]" style={{ color: "#92400e" }}>
                    Custom-range P&L call failed: <em>{data.custom_pl_error}</em> — showing
                    snapshot-based monthly figures instead.
                  </p>
                </div>
              )}

              <HeroKpis data={data} />
              <ManagementSummary data={data} />
              <Section id="recommendations" title="Risks & recommendations" icon={Sparkles}
                description="Heuristic-flagged action items for the selected period.">
                <Recommendations data={data} />
              </Section>
              <Section id="liquidity" title="Liquidity" icon={Wallet}
                description="Cash position, operating burn, runway, ratios, and cash conversion.">
                <KpiTable rows={data.liquidity.kpis} />
                <AdvisoryBlock advisory={data.liquidity.advisory} />
                <SectionDivider label="Cash & operating cash flow — last 7 months" />
                <DualSparkline history={data.liquidity.history}
                  leftKey="cash" rightKey="ocf"
                  leftLabel="Cash balance" rightLabel="Monthly OCF"
                  onPointClick={jumpToMonth} />
              </Section>
              <Section id="cash_forecast" title="Cash flow forecast" icon={CalendarClock}
                description="Where cash lands over the next 6 months at the current operating burn — and when to act.">
                <KpiTable rows={data.cash_forecast.kpis} />
                <AdvisoryBlock advisory={data.cash_forecast.advisory} />
                {data.cash_forecast.points.length > 0 && (
                  <>
                    <SectionDivider label="Projected cash balance — next 6 months" />
                    <ForecastChart points={data.cash_forecast.points}
                      outOfCashDate={data.cash_forecast.out_of_cash_date} />
                  </>
                )}
              </Section>
              <Section id="balance_sheet" title="Balance sheet & solvency" icon={Scale}
                description="What you own vs. owe, how leveraged you are, and how net worth is trending.">
                <KpiTable rows={data.balance_sheet.kpis} />
                <AdvisoryBlock advisory={data.balance_sheet.advisory} />
                {data.balance_sheet.equity_history.length > 0 && (
                  <>
                    <SectionDivider label="Net worth (equity) — last 7 months" />
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <SparklineCard label="Equity / net worth"
                        points={data.balance_sheet.equity_history.map((h) => ({ x: h.label, y: h.equity, period: h.period }))}
                        color="var(--green)" onPointClick={jumpToMonth} />
                    </div>
                  </>
                )}
              </Section>
              <Section id="profitability" title="Revenue & profitability" icon={LineIcon}
                description="Top-line trends and margin compression.">
                <KpiTable rows={data.profitability.kpis} />
                <AdvisoryBlock advisory={data.profitability.advisory} />
                <SectionDivider label="Revenue, GP, and net income — last 7 months" />
                <TripleSparkline history={data.profitability.history}
                  keys={["revenue", "gp", "ni"]}
                  labels={["Revenue", "Gross profit", "Net income"]}
                  onPointClick={jumpToMonth} />
              </Section>
              <Section id="growth" title="Growth & momentum" icon={TrendingUp}
                description="Revenue trajectory, annualized run-rate, and whether costs scale slower than revenue.">
                <KpiTable rows={data.growth.kpis} />
                <AdvisoryBlock advisory={data.growth.advisory} />
                {data.growth.history.length > 0 && (
                  <>
                    <SectionDivider label="Revenue — last 7 months" />
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <SparklineCard label="Revenue"
                        points={data.growth.history.map((h) => ({ x: h.label, y: Number(h.revenue ?? 0), period: h.period }))}
                        color="var(--green)" onPointClick={jumpToMonth} />
                    </div>
                  </>
                )}
              </Section>
              <Section id="breakeven" title="Break-even & margin of safety" icon={Gauge}
                description="The revenue needed to cover all costs, and how much cushion you have above it.">
                <KpiTable rows={data.breakeven.kpis} />
                <AdvisoryBlock advisory={data.breakeven.advisory} />
                {data.breakeven.break_even_revenue !== null && (
                  <>
                    <SectionDivider label="Current revenue vs. break-even" />
                    <BreakevenBar current={data.breakeven.current_revenue}
                      breakEven={data.breakeven.break_even_revenue} />
                  </>
                )}
              </Section>
              <Section id="receivables" title="Receivables (AR)" icon={ArrowDownToLine}
                description="How quickly customers pay, where risk concentrates, largest overdue accounts.">
                <KpiTable rows={data.receivables.kpis} />
                <AdvisoryBlock advisory={data.receivables.advisory} />
                {data.receivables.aging.length > 0 ? (
                  <>
                    <SectionDivider label="Aging concentration" />
                    <AgingBars buckets={data.receivables.aging} />
                  </>
                ) : data.receivables.qbo_error && <InlineHint text={data.receivables.qbo_error} />}
                {data.receivables.top_customers.length > 0 && (
                  <>
                    <SectionDivider label="Top 5 overdue customers" />
                    <EntityTable rows={data.receivables.top_customers} entityLabel="Customer" />
                  </>
                )}
              </Section>
              <Section id="payables" title="Payables (AP)" icon={ArrowUpFromLine}
                description="How quickly you're paying suppliers. Stretched payables damage relationships.">
                <KpiTable rows={data.payables.kpis} />
                <AdvisoryBlock advisory={data.payables.advisory} />
                {data.payables.aging.length > 0 ? (
                  <>
                    <SectionDivider label="Aging concentration" />
                    <AgingBars buckets={data.payables.aging} />
                  </>
                ) : data.payables.qbo_error && <InlineHint text={data.payables.qbo_error} />}
                {data.payables.top_vendors.length > 0 && (
                  <>
                    <SectionDivider label="Top 5 owed vendors" />
                    <EntityTable rows={data.payables.top_vendors} entityLabel="Vendor" />
                  </>
                )}
              </Section>
              <Section id="expenses" title="Expense monitoring" icon={ReceiptText}
                description="Where the money went + month-over-month movers for anomaly detection.">
                <KpiTable rows={data.expenses.kpis} />
                <AdvisoryBlock advisory={data.expenses.advisory} />
                {data.expenses.top_categories.length > 0 && (
                  <>
                    <SectionDivider label="Largest categories (by spend this period)" />
                    <CategoryBars rows={data.expenses.top_categories} />
                  </>
                )}
                {data.expenses.top_movers.length > 0 && (
                  <>
                    <SectionDivider label="Biggest month-over-month movers" />
                    <MoversTable rows={data.expenses.top_movers} />
                  </>
                )}
              </Section>
            </motion.div>
          </AnimatePresence>
        )}
      </div>
    </div>
  )
}

// ── Header ───────────────────────────────────────────────────────────────────

function Header({
  mode, setMode, periodEnd, setPeriodEnd, periodStart, setPeriodStart,
  onGenerate, isFetching, loadedLabel,
  savedAt, onSync, isSyncing, syncError,
}: {
  mode: DateMode; setMode: (m: DateMode) => void
  periodEnd: string; setPeriodEnd: (s: string) => void
  periodStart: string; setPeriodStart: (s: string) => void
  onGenerate: () => void
  isFetching: boolean
  loadedLabel?: string
  savedAt?: string
  onSync?: () => void
  isSyncing?: boolean
  syncError?: string | null
}) {
  const valid = mode === "month"
    ? !!periodEnd
    : !!periodStart && !!periodEnd && periodStart <= periodEnd

  return (
    <div className="px-4 sm:px-8 py-5 sm:py-6 shrink-0"
      style={{ borderBottom: "1px solid var(--border)", background: "var(--surface)" }}>
      <div className="max-w-7xl mx-auto">
        <div className="flex items-start gap-3 flex-wrap">
          <div className="h-9 w-9 rounded-lg flex items-center justify-center shrink-0"
            style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
            <Lightbulb size={18} strokeWidth={1.8} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-lg sm:text-xl font-bold text-theme leading-tight lg:hidden">Insights</h1>
              {loadedLabel && (
                <span className="text-[11px] font-medium px-2 py-0.5 rounded-full"
                  style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}>
                  {loadedLabel}
                </span>
              )}
            </div>
            <p className="text-xs sm:text-sm mt-1" style={{ color: "var(--text-muted)" }}>
              Pick a period, click <em>Generate</em>, and Nordavix synthesises risks
              and recommendations from your books.
            </p>
          </div>

          {/* Saved-snapshot status + Sync (recompute). Insights persist once
              generated, so a revisit is instant; Sync refreshes from the books. */}
          {savedAt && onSync && (
            <div className="flex flex-col items-end gap-1 ml-auto shrink-0">
              <button
                onClick={onSync}
                disabled={isSyncing}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-60 transition-opacity"
                style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }}
              >
                <RefreshCw size={12} strokeWidth={2.2} className={isSyncing ? "animate-spin" : ""} />
                {isSyncing ? "Syncing…" : "Sync"}
              </button>
              {syncError ? (
                <span className="text-[10px] font-medium" style={{ color: "#dc2626" }}>Sync failed — retry</span>
              ) : (
                <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>Synced {fmtSyncedAt(savedAt)}</span>
              )}
            </div>
          )}
        </div>

        {/* Period picker row */}
        <div className="mt-4 flex items-end gap-2 flex-wrap">
          {/* Mode tabs */}
          <div className="inline-flex rounded-lg p-0.5"
            style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
            <button
              onClick={() => setMode("month")}
              className="px-3 py-1.5 text-xs font-semibold rounded-md transition-all"
              style={{
                background: mode === "month" ? "var(--surface)" : "transparent",
                color:      mode === "month" ? "var(--text)"    : "var(--text-muted)",
              }}
            >Month</button>
            <button
              onClick={() => setMode("custom")}
              className="px-3 py-1.5 text-xs font-semibold rounded-md transition-all"
              style={{
                background: mode === "custom" ? "var(--surface)" : "transparent",
                color:      mode === "custom" ? "var(--text)"    : "var(--text-muted)",
              }}
            >Custom range</button>
          </div>

          {mode === "month" ? (
            <FieldShell label="Period">
              <select
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
                className="rounded-lg px-3 py-1.5 text-sm font-medium outline-none"
                style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }}
              >
                {monthOptions().map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </FieldShell>
          ) : (
            <>
              <FieldShell label="From">
                <DatePicker value={periodStart} onChange={setPeriodStart} max={periodEnd} />
              </FieldShell>
              <FieldShell label="To">
                <DatePicker value={periodEnd} onChange={setPeriodEnd} min={periodStart} />
              </FieldShell>
              <PresetButtons
                onPick={(s, e) => { setPeriodStart(s); setPeriodEnd(e) }}
              />
            </>
          )}

          <button
            onClick={onGenerate}
            disabled={!valid || isFetching}
            className="inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
            style={{ background: "var(--green)" }}
          >
            {isFetching
              ? <><Spinner className="h-3.5 w-3.5" /> Generating…</>
              : <><Play size={12} strokeWidth={2.4} /> Generate insights</>}
          </button>
        </div>

        {mode === "custom" && (
          <p className="text-[11px] mt-2" style={{ color: "var(--text-muted)" }}>
            For custom ranges we call QuickBooks ProfitAndLoss live for the exact
            window — slightly slower than monthly snapshots, but accurate to the day.
          </p>
        )}
      </div>
    </div>
  )
}

function FieldShell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider mb-0.5" style={{ color: "var(--text-muted)" }}>
        {label}
      </p>
      {children}
    </div>
  )
}

function PresetButtons({ onPick }: { onPick: (start: string, end: string) => void }) {
  const today = new Date()
  const todayISO = today.toISOString().slice(0, 10)

  const lastDayOfPriorMonth = (() => {
    const d = new Date(today.getFullYear(), today.getMonth(), 0)
    return d.toISOString().slice(0, 10)
  })()

  const presets: { label: string; start: string; end: string }[] = useMemo(() => {
    const ytdStart = `${today.getFullYear()}-01-01`
    const last30Start = new Date(today.getTime() - 30 * 86400_000).toISOString().slice(0, 10)
    const last90Start = new Date(today.getTime() - 90 * 86400_000).toISOString().slice(0, 10)
    const q1Start = `${today.getFullYear()}-01-01`,  q1End = `${today.getFullYear()}-03-31`
    const q2Start = `${today.getFullYear()}-04-01`,  q2End = `${today.getFullYear()}-06-30`
    return [
      { label: "MTD",     start: `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`, end: todayISO },
      { label: "Last 30", start: last30Start, end: todayISO },
      { label: "Last 90", start: last90Start, end: todayISO },
      { label: "QTD",     start: today.getMonth() < 3 ? q1Start : today.getMonth() < 6 ? q2Start : today.getMonth() < 9 ? `${today.getFullYear()}-07-01` : `${today.getFullYear()}-10-01`, end: todayISO },
      { label: "Q1",      start: q1Start, end: q1End },
      { label: "Q2",      start: q2Start, end: q2End },
      { label: "YTD",     start: ytdStart, end: lastDayOfPriorMonth > ytdStart ? lastDayOfPriorMonth : todayISO },
    ]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {presets.map((p) => (
        <button key={p.label}
          onClick={() => onPick(p.start, p.end)}
          className="text-[11px] font-semibold px-2 py-1 rounded-md transition-colors"
          style={{ background: "var(--surface-2)", border: "1px solid var(--border)", color: "var(--text-2)" }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--green)" }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--border)" }}
        >
          {p.label}
        </button>
      ))}
    </div>
  )
}

// ── Empty state ──────────────────────────────────────────────────────────────

function EmptyState({ onGenerate }: { onGenerate: () => void }) {
  return (
    <div className="rounded-2xl p-10 text-center"
      style={{ background: "var(--surface)", border: "1px dashed var(--border-strong)" }}>
      <div className="h-14 w-14 mx-auto rounded-xl flex items-center justify-center mb-4"
        style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
        <Lightbulb size={26} strokeWidth={1.6} />
      </div>
      <h2 className="text-lg font-bold text-theme mb-1.5">Ready when you are</h2>
      <p className="text-sm mb-5 max-w-md mx-auto" style={{ color: "var(--text-muted)" }}>
        Pick a period from the header — a calendar month or any custom date range —
        then click <strong style={{ color: "var(--text)" }}>Generate insights</strong>.
        Nothing fires until you ask.
      </p>
      <button onClick={onGenerate}
        className="inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90"
        style={{ background: "var(--green)" }}>
        <Play size={14} strokeWidth={2.4} />
        Generate for the default period
      </button>
    </div>
  )
}

// ── Sticky jump-to-section nav ───────────────────────────────────────────────

function JumpNav({ data }: { data: InsightsOverview }) {
  void data
  const [active, setActive] = useState<SectionId>("recommendations")

  // Watch which section is in view
  useEffect(() => {
    const els = SECTIONS
      .map((s) => document.getElementById(`insights-section-${s.id}`))
      .filter((e): e is HTMLElement => !!e)
    if (els.length === 0) return

    const obs = new IntersectionObserver((entries) => {
      // Pick the entry whose top is closest to the top of the viewport but
      // still visible — feels more natural than "first intersecting".
      const visible = entries.filter((e) => e.isIntersecting)
      if (visible.length === 0) return
      visible.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
      const top = visible[0]
      const id = top.target.id.replace("insights-section-", "") as SectionId
      setActive(id)
    }, { rootMargin: "-100px 0px -60% 0px", threshold: [0, 0.1, 0.5, 1] })

    els.forEach((el) => obs.observe(el))
    return () => obs.disconnect()
  }, [])

  function scrollTo(id: SectionId) {
    const el = document.getElementById(`insights-section-${id}`)
    if (!el) return
    el.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  return (
    <div className="sticky top-0 z-10 px-4 sm:px-8 py-2 backdrop-blur"
      style={{
        background: "color-mix(in oklab, var(--bg) 92%, transparent)",
        borderBottom: "1px solid var(--border)",
      }}>
      <div className="max-w-7xl mx-auto flex items-center gap-1.5 overflow-x-auto"
        style={{ scrollbarWidth: "none" }}>
        {SECTIONS.map((s) => {
          const Icon = s.icon
          const isActive = active === s.id
          return (
            <button key={s.id}
              onClick={() => scrollTo(s.id)}
              className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition-all"
              style={{
                background: isActive ? "var(--green-subtle)" : "transparent",
                color:      isActive ? "var(--green)"        : "var(--text-2)",
                border:     `1px solid ${isActive ? "var(--green)" : "var(--border)"}`,
              }}
            >
              <Icon size={11} strokeWidth={2} />
              {s.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── Section wrapper with anchor ──────────────────────────────────────────────

function Section({
  id, title, icon: Icon, description, children,
}: {
  id: SectionId; title: string; icon: React.ElementType; description: string; children: React.ReactNode;
}) {
  return (
    <section id={`insights-section-${id}`} className="rounded-2xl scroll-mt-20"
      style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
      <div className="px-5 py-4" style={{ borderBottom: "1px solid var(--border)" }}>
        <div className="flex items-start gap-3">
          <span className="h-8 w-8 rounded-md flex items-center justify-center shrink-0"
            style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
            <Icon size={15} strokeWidth={1.8} />
          </span>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-bold text-theme">{title}</h2>
            <p className="text-[11px] mt-0.5" style={{ color: "var(--text-muted)" }}>{description}</p>
          </div>
        </div>
      </div>
      <div className="p-5 space-y-5">{children}</div>
    </section>
  )
}

// ── Hero KPIs ────────────────────────────────────────────────────────────────

function HeroKpis({ data }: { data: InsightsOverview }) {
  const tiles = [
    {
      label:  "Cash balance",
      value:  fmtMoney(data.liquidity.cash_balance),
      change: data.liquidity.cash_change_str,
      changeUp: (data.liquidity.cash_change_str ?? "").startsWith("+"),
      sub:    "Bank + cash accounts",
    },
    {
      label:  "Runway",
      value:  data.liquidity.runway_months !== null
        ? `${data.liquidity.runway_months.toFixed(1)} mo` : "Cash-gen.",
      change: null, changeUp: false,
      sub:    data.liquidity.runway_months !== null ? "at operating burn" : "operations fund themselves",
      risk:   riskColor(runwayRisk(data.liquidity.runway_months)),
    },
    {
      label:  "Revenue",
      value:  fmtMoney(data.profitability.revenue),
      change: data.profitability.revenue_change_str,
      changeUp: (data.profitability.revenue_change_str ?? "").startsWith("+"),
      sub:    data.custom_range ? "for selected window" : "this month",
    },
    {
      label:  "Net margin",
      value:  data.profitability.net_margin_pct !== null
        ? `${data.profitability.net_margin_pct.toFixed(1)}%` : "—",
      change: null, changeUp: false,
      sub:    "net income / revenue",
      risk:   data.profitability.net_margin_pct !== null
        ? (data.profitability.net_margin_pct >= 15 ? "green"
          : data.profitability.net_margin_pct >= 0 ? "amber" : "red")
        : "neutral",
    },
  ]

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {tiles.map((t, i) => (
        <div key={i} className="rounded-2xl p-4"
          style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>{t.label}</span>
            {"risk" in t && t.risk && t.risk !== "neutral" && (
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: t.risk }} />
            )}
          </div>
          <div className="flex items-baseline gap-2 flex-wrap">
            <p className="text-2xl font-bold leading-tight" style={{ color: "var(--text)" }}>{t.value}</p>
            {t.change && (
              <span className="text-[11px] font-semibold inline-flex items-center gap-0.5"
                style={{ color: t.changeUp ? "var(--green)" : "#dc2626" }}>
                {t.changeUp ? <TrendingUp size={10} strokeWidth={2.4} /> : <TrendingDown size={10} strokeWidth={2.4} />}
                {t.change}
              </span>
            )}
          </div>
          <p className="text-[11px] mt-1" style={{ color: "var(--text-muted)" }}>{t.sub}</p>
        </div>
      ))}
    </div>
  )
}

// ── Recommendations ─────────────────────────────────────────────────────────

function Recommendations({ data }: { data: InsightsOverview }) {
  if (!data.recommendations || data.recommendations.length === 0) return null
  return (
    <ul className="divide-y -mx-5 -my-5" style={{ borderColor: "var(--border)" }}>
      {data.recommendations.map((r, i) => (
        <li key={i} className="px-5 py-4 flex items-start gap-3">
          <span className="h-7 w-7 rounded-md flex items-center justify-center shrink-0"
            style={{ background: priorityBg(r.priority), color: priorityFg(r.priority) }}>
            {r.priority === "high" ? <AlertTriangle size={13} strokeWidth={1.8} />
              : r.priority === "medium" ? <Info size={13} strokeWidth={1.8} />
              : <Lightbulb size={13} strokeWidth={1.8} />}
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-sm font-semibold" style={{ color: "var(--text)" }}>{r.title}</p>
              <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
                style={{ background: priorityBg(r.priority), color: priorityFg(r.priority) }}>
                {r.priority}
              </span>
            </div>
            <p className="text-[12px] mt-1" style={{ color: "var(--text-muted)" }}>{r.detail}</p>
          </div>
        </li>
      ))}
    </ul>
  )
}

// ── Management summary ───────────────────────────────────────────────────────

function ManagementSummary({ data }: { data: InsightsOverview }) {
  const ms = data.management_summary
  if (!ms) return null
  const tone =
    ms.health === "strong" ? { bg: "#dcfce7", fg: "#16a34a", label: "Strong",  Icon: ShieldCheck }
    : ms.health === "watch" ? { bg: "#fef3c7", fg: "#b45309", label: "Watch",   Icon: Eye }
    :                          { bg: "#fef2f2", fg: "#dc2626", label: "At risk", Icon: AlertTriangle }
  const Icon = tone.Icon
  return (
    <div className="rounded-2xl overflow-hidden"
      style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
      <div className="px-5 py-4 flex items-start gap-3" style={{ borderBottom: "1px solid var(--border)" }}>
        <span className="h-9 w-9 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: tone.bg, color: tone.fg }}>
          <Icon size={18} strokeWidth={1.9} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-sm font-bold text-theme">Management summary</h2>
            <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full"
              style={{ background: tone.bg, color: tone.fg }}>
              {tone.label} · {ms.score}/100
            </span>
          </div>
          <p className="text-[13px] mt-1 font-medium" style={{ color: "var(--text)" }}>{ms.headline}</p>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x"
        style={{ borderColor: "var(--border)" }}>
        <SummaryCol title="Do this first" Icon={Target}      items={ms.priorities}  fg="#dc2626" />
        <SummaryCol title="Strengths"     Icon={CheckCircle2} items={ms.strengths}   fg="#16a34a" />
        <SummaryCol title="Keep watching" Icon={Eye}         items={ms.watch_items} fg="#b45309" />
      </div>
    </div>
  )
}

function SummaryCol({ title, Icon, items, fg }: { title: string; Icon: React.ElementType; items: string[]; fg: string }) {
  return (
    <div className="px-5 py-4" style={{ borderColor: "var(--border)" }}>
      <div className="flex items-center gap-1.5 mb-2">
        <Icon size={13} strokeWidth={2} style={{ color: fg }} />
        <p className="text-[10px] font-bold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>{title}</p>
      </div>
      <ul className="space-y-1.5">
        {items.map((it, i) => (
          <li key={i} className="text-[12px] leading-snug flex items-start gap-1.5" style={{ color: "var(--text-2)" }}>
            <span className="mt-1.5 h-1 w-1 rounded-full shrink-0" style={{ background: fg }} />
            {it}
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── Per-section advisory (implications / actions / watch / risks) ────────────

function AdvisoryBlock({ advisory }: { advisory?: Advisory }) {
  if (!advisory) return null
  return (
    <div className="rounded-xl p-4" style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
      <p className="text-[13px] leading-relaxed mb-3" style={{ color: "var(--text)" }}>
        {advisory.implications}
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <AdvisoryList title="What to do"  Icon={Target}        items={advisory.actions} fg="var(--green)" />
        <AdvisoryList title="Watch"       Icon={Eye}           items={advisory.watch}   fg="#6366f1" />
        <AdvisoryList title="Risk areas"  Icon={AlertTriangle} items={advisory.risks}   fg="#dc2626" />
      </div>
    </div>
  )
}

function AdvisoryList({ title, Icon, items, fg }: { title: string; Icon: React.ElementType; items: string[]; fg: string }) {
  if (!items || items.length === 0) return null
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1.5">
        <Icon size={12} strokeWidth={2} style={{ color: fg }} />
        <p className="text-[10px] font-bold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>{title}</p>
      </div>
      <ul className="space-y-1">
        {items.map((it, i) => (
          <li key={i} className="text-[12px] leading-snug flex items-start gap-1.5" style={{ color: "var(--text-2)" }}>
            <span className="mt-1.5 h-1 w-1 rounded-full shrink-0" style={{ background: fg }} />
            {it}
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── KPI Table ────────────────────────────────────────────────────────────────

function KpiTable({ rows }: { rows: KpiRow[] }) {
  return (
    <div className="overflow-x-auto -mx-1 px-1">
      <table className="w-full text-sm">
        <thead>
          <tr style={{ borderBottom: "1px solid var(--border)" }}>
            <th className="text-left text-[10px] font-bold uppercase tracking-wider pb-2 pr-3" style={{ color: "var(--text-muted)" }}>KPI</th>
            <th className="text-left text-[10px] font-bold uppercase tracking-wider pb-2 pr-3" style={{ color: "var(--text-muted)" }}>Value</th>
            <th className="text-left text-[10px] font-bold uppercase tracking-wider pb-2 pr-3" style={{ color: "var(--text-muted)" }}>Risk</th>
            <th className="text-left text-[10px] font-bold uppercase tracking-wider pb-2"      style={{ color: "var(--text-muted)" }}>Insight</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ borderBottom: i < rows.length - 1 ? "1px solid var(--border)" : "none" }}>
              <td className="py-3 pr-3 text-[13px] font-medium align-top" style={{ color: "var(--text)" }}>{r.kpi}</td>
              <td className="py-3 pr-3 text-[13px] font-bold align-top whitespace-nowrap" style={{ color: "var(--text)" }}>{r.value}</td>
              <td className="py-3 pr-3 align-top"><RiskPill level={r.risk} /></td>
              <td className="py-3 text-[12px] leading-snug align-top" style={{ color: "var(--text-muted)" }}>{r.insight}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function RiskPill({ level }: { level: RiskLevel }) {
  if (level === "neutral") return <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>—</span>
  const { bg, fg, label } = riskStyle(level)
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
      style={{ background: bg, color: fg }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: fg }} />
      {label}
    </span>
  )
}

// ── Interactive sparklines ───────────────────────────────────────────────────

function DualSparkline({ history, leftKey, rightKey, leftLabel, rightLabel, onPointClick }: {
  history: HistoryPoint[]; leftKey: keyof HistoryPoint; rightKey: keyof HistoryPoint;
  leftLabel: string; rightLabel: string; onPointClick: (periodEnd: string) => void;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <SparklineCard label={leftLabel}  points={history.map((h) => ({ x: h.label, y: Number(h[leftKey] ?? 0),  period: h.period }))} color="var(--green)" onPointClick={onPointClick} />
      <SparklineCard label={rightLabel} points={history.map((h) => ({ x: h.label, y: Number(h[rightKey] ?? 0), period: h.period }))} color="#6366f1"       onPointClick={onPointClick} />
    </div>
  )
}

function TripleSparkline({ history, keys, labels, onPointClick }: {
  history: HistoryPoint[]; keys: (keyof HistoryPoint)[]; labels: string[];
  onPointClick: (periodEnd: string) => void;
}) {
  const colors = ["var(--green)", "#6366f1", "#f59e0b"]
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      {keys.map((k, i) => (
        <SparklineCard key={String(k)} label={labels[i]}
          points={history.map((h) => ({ x: h.label, y: Number(h[k] ?? 0), period: h.period }))}
          color={colors[i]} onPointClick={onPointClick} />
      ))}
    </div>
  )
}

interface SparkPoint { x: string; y: number; period: string }

function SparklineCard({ label, points, color, onPointClick }: {
  label: string; points: SparkPoint[]; color: string; onPointClick: (periodEnd: string) => void;
}) {
  const W = 220, H = 60, PAD = 4
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const ref = useRef<SVGSVGElement | null>(null)

  if (!points || points.length === 0) return null
  const ys = points.map((p) => p.y)
  const min = Math.min(...ys, 0)
  const max = Math.max(...ys, 0)
  const span = max - min || 1
  const dx = (W - PAD * 2) / Math.max(1, points.length - 1)
  const toY = (v: number) => H - PAD - ((v - min) / span) * (H - PAD * 2)
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"} ${PAD + i * dx} ${toY(p.y)}`).join(" ")
  const area = `${path} L ${PAD + (points.length - 1) * dx} ${H - PAD} L ${PAD} ${H - PAD} Z`
  const gradId = `sg-${label.replace(/[^a-z0-9]/gi, "")}`

  const last = points[points.length - 1].y
  const prev = points.length > 1 ? points[points.length - 2].y : last
  const change = prev !== 0 ? ((last - prev) / Math.abs(prev)) * 100 : null

  const displayed = hoverIdx !== null ? points[hoverIdx] : points[points.length - 1]

  function handlePointer(e: React.PointerEvent<SVGSVGElement>) {
    if (!ref.current) return
    const rect = ref.current.getBoundingClientRect()
    const xInSvg = ((e.clientX - rect.left) / rect.width) * W
    const idx = Math.max(0, Math.min(points.length - 1, Math.round((xInSvg - PAD) / dx)))
    setHoverIdx(idx)
  }
  function handleLeave() { setHoverIdx(null) }
  function handleClick() {
    if (hoverIdx !== null) onPointClick(points[hoverIdx].period)
  }

  return (
    <div className="rounded-lg p-3 group/spark"
      style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
      <div className="flex items-center justify-between mb-1">
        <p className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
          {label}
        </p>
        {change !== null && hoverIdx === null && (
          <span className="text-[10px] font-bold"
            style={{ color: change >= 0 ? "var(--green)" : "#dc2626" }}>
            {change >= 0 ? "+" : ""}{change.toFixed(1)}%
          </span>
        )}
        {hoverIdx !== null && (
          <span className="text-[10px] font-bold" style={{ color: "var(--text-2)" }}>
            {displayed.x}
          </span>
        )}
      </div>
      <p className="text-base font-bold mb-1 tabular-nums" style={{ color: "var(--text)" }}>
        {fmtMoney(displayed.y)}
      </p>
      <div className="relative">
        <svg ref={ref}
          width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
          className="overflow-visible cursor-pointer touch-none"
          onPointerMove={handlePointer}
          onPointerLeave={handleLeave}
          onClick={handleClick}
          role="button"
          tabIndex={0}
        >
          <defs>
            <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%"  stopColor={color} stopOpacity="0.22" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#${gradId})`} />
          <path d={path} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
          {/* Hover crosshair */}
          {hoverIdx !== null && (
            <line
              x1={PAD + hoverIdx * dx} y1={PAD}
              x2={PAD + hoverIdx * dx} y2={H - PAD}
              stroke="var(--text-muted)" strokeWidth="0.5" strokeDasharray="2 2" opacity="0.6"
            />
          )}
          {points.map((p, i) => {
            const isHover = hoverIdx === i
            const isLast  = i === points.length - 1
            return (
              <circle key={i}
                cx={PAD + i * dx}
                cy={toY(p.y)}
                r={isHover ? 3.5 : isLast ? 2.6 : 1.6}
                fill={isHover ? color : (isLast ? color : "var(--surface)")}
                stroke={color}
                strokeWidth={isHover ? 1.4 : 1}
              />
            )
          })}
        </svg>
      </div>
      <div className="flex justify-between mt-1">
        {points.map((p, i) => (
          <span key={i} className="text-[9px]" style={{ color: hoverIdx === i ? "var(--text)" : "var(--text-muted)" }}>
            {i === 0 || i === points.length - 1 || i % 2 === 0 ? p.x : ""}
          </span>
        ))}
      </div>
      <p className="text-[9px] mt-1 flex items-center gap-1 opacity-0 group-hover/spark:opacity-100 transition-opacity"
        style={{ color: "var(--text-muted)" }}>
        <MousePointerClick size={9} strokeWidth={2} />
        Click a point to focus that month
      </p>
    </div>
  )
}

// ── Cash-flow forecast chart (projected balance, marks the zero line) ────────

function ForecastChart({ points, outOfCashDate }: {
  points: { month: string; projected_cash: number }[]; outOfCashDate: string | null;
}) {
  const W = 600, H = 120, PAD = 8
  if (!points.length) return null
  const ys = points.map((p) => p.projected_cash)
  const min = Math.min(...ys, 0)
  const max = Math.max(...ys, 0)
  const span = max - min || 1
  const dx = (W - PAD * 2) / Math.max(1, points.length - 1)
  const toY = (v: number) => H - PAD - ((v - min) / span) * (H - PAD * 2)
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"} ${PAD + i * dx} ${toY(p.projected_cash)}`).join(" ")
  const zeroY = toY(0)
  return (
    <div className="rounded-lg p-3" style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="overflow-visible">
        <line x1={PAD} y1={zeroY} x2={W - PAD} y2={zeroY} stroke="#dc2626" strokeWidth="1" strokeDasharray="3 3" opacity="0.6" />
        <path d={path} fill="none" stroke="var(--green)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {points.map((p, i) => (
          <circle key={i} cx={PAD + i * dx} cy={toY(p.projected_cash)} r={2.6}
            fill={p.projected_cash <= 0 ? "#dc2626" : "var(--green)"} stroke="var(--surface)" strokeWidth="0.5" />
        ))}
      </svg>
      <div className="flex justify-between mt-1">
        {points.map((p, i) => (
          <span key={i} className="text-[9px] tabular-nums"
            style={{ color: p.projected_cash <= 0 ? "#dc2626" : "var(--text-muted)" }}>
            {p.month.split(" ")[0]}
          </span>
        ))}
      </div>
      {outOfCashDate && (
        <p className="text-[11px] mt-2 flex items-center gap-1.5" style={{ color: "#b45309" }}>
          <AlertTriangle size={11} strokeWidth={2} />
          Projected to reach $0 around <strong>{outOfCashDate}</strong> at the current operating burn.
        </p>
      )}
    </div>
  )
}

// ── Break-even bar (current revenue vs. the break-even threshold) ────────────

function BreakevenBar({ current, breakEven }: { current: number; breakEven: number }) {
  const max = Math.max(current, breakEven) * 1.15 || 1
  const curPct = Math.max(0, Math.min(100, (current / max) * 100))
  const bePct = Math.max(0, Math.min(100, (breakEven / max) * 100))
  const above = current >= breakEven
  return (
    <div className="space-y-2">
      <div className="relative h-9 rounded-md overflow-hidden" style={{ background: "var(--surface-2)" }}>
        <div className="h-full transition-all" style={{ width: `${curPct}%`, background: above ? "var(--green)" : "#f59e0b" }} />
        <div className="absolute top-0 bottom-0" style={{ left: `${bePct}%`, width: 2, background: "#dc2626" }} />
        <span className="absolute text-[9px] font-bold uppercase tracking-wider"
          style={{ left: `calc(${bePct}% + 4px)`, top: 3, color: "#dc2626" }}>
          Break-even
        </span>
      </div>
      <div className="flex justify-between text-[11px]">
        <span style={{ color: "var(--text-2)" }}>Current revenue: <strong style={{ color: "var(--text)" }}>{fmtMoney(current)}</strong></span>
        <span style={{ color: "var(--text-2)" }}>Break-even: <strong style={{ color: "var(--text)" }}>{fmtMoney(breakEven)}</strong></span>
      </div>
    </div>
  )
}

// ── Aging bars (interactive on hover) ────────────────────────────────────────

function AgingBars({ buckets }: { buckets: { bucket: string; amount: number; pct: number }[] }) {
  const colors = ["#10b981", "#84cc16", "#f59e0b", "#f97316", "#ef4444"]
  const total = buckets.reduce((s, b) => s + b.amount, 0)
  return (
    <div className="space-y-2">
      {buckets.map((b, i) => (
        <div key={i} className="flex items-center gap-3 group/bar"
          title={`${b.bucket}: ${fmtMoney(b.amount)} (${b.pct.toFixed(1)}% of ${fmtMoney(total)})`}>
          <span className="text-[11px] font-semibold w-16 text-right shrink-0" style={{ color: "var(--text-2)" }}>
            {b.bucket}
          </span>
          <div className="flex-1 h-5 rounded-md overflow-hidden relative" style={{ background: "var(--surface-2)" }}>
            <motion.div
              className="h-full"
              initial={{ width: 0 }}
              animate={{ width: `${Math.min(100, b.pct)}%` }}
              transition={{ duration: 0.6, delay: i * 0.08, ease: "easeOut" }}
              style={{ background: colors[i] || colors[colors.length - 1] }}
            />
          </div>
          <span className="text-[11px] font-semibold w-14 text-right shrink-0" style={{ color: "var(--text)" }}>
            {b.pct.toFixed(0)}%
          </span>
          <span className="text-[11px] w-20 text-right shrink-0 tabular-nums" style={{ color: "var(--text-muted)" }}>
            {fmtMoney(b.amount)}
          </span>
        </div>
      ))}
    </div>
  )
}

// ── Category bars + movers table ─────────────────────────────────────────────

function CategoryBars({ rows }: { rows: { category: string; amount: number; change_pct: number | null }[] }) {
  if (!rows.length) return null
  const max = Math.max(...rows.map((r) => Math.abs(r.amount))) || 1
  return (
    <div className="space-y-1.5">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-3"
          title={`${r.category}: ${fmtMoney(r.amount)}${r.change_pct !== null ? ` (${r.change_pct >= 0 ? "+" : ""}${r.change_pct.toFixed(1)}% MoM)` : ""}`}>
          <span className="text-[11px] font-medium w-44 shrink-0 truncate" style={{ color: "var(--text-2)" }}>{r.category}</span>
          <div className="flex-1 h-4 rounded-md overflow-hidden" style={{ background: "var(--surface-2)" }}>
            <motion.div
              className="h-full"
              initial={{ width: 0 }}
              animate={{ width: `${(Math.abs(r.amount) / max) * 100}%` }}
              transition={{ duration: 0.5, delay: i * 0.04, ease: "easeOut" }}
              style={{ background: "var(--green)" }}
            />
          </div>
          <span className="text-[11px] font-semibold w-20 text-right tabular-nums shrink-0" style={{ color: "var(--text)" }}>
            {fmtMoney(r.amount)}
          </span>
          {r.change_pct !== null && (
            <span className="text-[10px] font-semibold w-12 text-right shrink-0"
              style={{ color: r.change_pct >= 0 ? (r.change_pct > 25 ? "#dc2626" : "var(--text-2)") : "var(--green)" }}>
              {r.change_pct >= 0 ? "+" : ""}{r.change_pct.toFixed(0)}%
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

function MoversTable({ rows }: { rows: { category: string; amount: number; prior_amount: number; change_pct: number | null }[] }) {
  return (
    <div className="overflow-x-auto -mx-1 px-1">
      <table className="w-full text-sm">
        <thead>
          <tr style={{ borderBottom: "1px solid var(--border)" }}>
            <th className="text-left text-[10px] font-bold uppercase tracking-wider pb-2 pr-3" style={{ color: "var(--text-muted)" }}>Category</th>
            <th className="text-right text-[10px] font-bold uppercase tracking-wider pb-2 pr-3" style={{ color: "var(--text-muted)" }}>Prior</th>
            <th className="text-right text-[10px] font-bold uppercase tracking-wider pb-2 pr-3" style={{ color: "var(--text-muted)" }}>This month</th>
            <th className="text-right text-[10px] font-bold uppercase tracking-wider pb-2"      style={{ color: "var(--text-muted)" }}>Change</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ borderBottom: i < rows.length - 1 ? "1px solid var(--border)" : "none" }}>
              <td className="py-2.5 pr-3 text-[13px]" style={{ color: "var(--text)" }}>{r.category}</td>
              <td className="py-2.5 pr-3 text-[12px] text-right tabular-nums" style={{ color: "var(--text-muted)" }}>{fmtMoney(r.prior_amount)}</td>
              <td className="py-2.5 pr-3 text-[12px] text-right tabular-nums" style={{ color: "var(--text)" }}>{fmtMoney(r.amount)}</td>
              <td className="py-2.5 text-[12px] text-right font-bold tabular-nums"
                style={{ color: r.change_pct !== null && r.change_pct > 25 ? "#dc2626" : r.change_pct !== null && r.change_pct < -10 ? "var(--green)" : "var(--text-2)" }}>
                {r.change_pct !== null ? `${r.change_pct >= 0 ? "+" : ""}${r.change_pct.toFixed(0)}%` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function EntityTable({ rows, entityLabel }: { rows: { name: string; total: number; over_90: number; "61_90": number; "31_60": number; "1_30": number; current: number }[]; entityLabel: string }) {
  return (
    <div className="overflow-x-auto -mx-1 px-1">
      <table className="w-full text-sm">
        <thead>
          <tr style={{ borderBottom: "1px solid var(--border)" }}>
            <th className="text-left  text-[10px] font-bold uppercase tracking-wider pb-2 pr-3" style={{ color: "var(--text-muted)" }}>{entityLabel}</th>
            <th className="text-right text-[10px] font-bold uppercase tracking-wider pb-2 pr-2" style={{ color: "var(--text-muted)" }}>Current</th>
            <th className="text-right text-[10px] font-bold uppercase tracking-wider pb-2 pr-2" style={{ color: "var(--text-muted)" }}>1–30</th>
            <th className="text-right text-[10px] font-bold uppercase tracking-wider pb-2 pr-2" style={{ color: "var(--text-muted)" }}>31–60</th>
            <th className="text-right text-[10px] font-bold uppercase tracking-wider pb-2 pr-2" style={{ color: "var(--text-muted)" }}>61–90</th>
            <th className="text-right text-[10px] font-bold uppercase tracking-wider pb-2 pr-2" style={{ color: "#dc2626" }}>&gt;90</th>
            <th className="text-right text-[10px] font-bold uppercase tracking-wider pb-2"      style={{ color: "var(--text-muted)" }}>Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ borderBottom: i < rows.length - 1 ? "1px solid var(--border)" : "none" }}>
              <td className="py-2.5 pr-3 text-[13px] font-medium truncate max-w-[200px]" style={{ color: "var(--text)" }} title={r.name}>{r.name}</td>
              <td className="py-2.5 pr-2 text-[12px] text-right tabular-nums" style={{ color: "var(--text-muted)" }}>{fmtMoney(r.current)}</td>
              <td className="py-2.5 pr-2 text-[12px] text-right tabular-nums" style={{ color: "var(--text-muted)" }}>{fmtMoney(r["1_30"])}</td>
              <td className="py-2.5 pr-2 text-[12px] text-right tabular-nums" style={{ color: "var(--text-muted)" }}>{fmtMoney(r["31_60"])}</td>
              <td className="py-2.5 pr-2 text-[12px] text-right tabular-nums" style={{ color: "var(--text-muted)" }}>{fmtMoney(r["61_90"])}</td>
              <td className="py-2.5 pr-2 text-[12px] text-right tabular-nums font-semibold" style={{ color: r.over_90 > 0 ? "#dc2626" : "var(--text-muted)" }}>{fmtMoney(r.over_90)}</td>
              <td className="py-2.5 text-[12px] text-right tabular-nums font-bold" style={{ color: "var(--text)" }}>{fmtMoney(r.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SectionDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 pt-1">
      <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>{label}</span>
      <span className="flex-1 h-px" style={{ background: "var(--border)" }} />
    </div>
  )
}

function InlineHint({ text }: { text: string }) {
  return (
    <div className="text-[12px] flex items-center gap-2 rounded-lg p-3"
      style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}>
      <Info size={12} strokeWidth={1.8} />
      {text}
    </div>
  )
}

// ── Utils ────────────────────────────────────────────────────────────────────

function fmtMoney(n: number): string {
  const abs = Math.abs(n)
  const sign = n < 0 ? "-" : ""
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000)     return `${sign}$${(abs / 1_000).toFixed(1)}K`
  return `${sign}$${abs.toFixed(0)}`
}

function riskStyle(level: RiskLevel): { bg: string; fg: string; label: string } {
  if (level === "red")   return { bg: "#fef2f2", fg: "#dc2626", label: "High"  }
  if (level === "amber") return { bg: "#fef3c7", fg: "#b45309", label: "Watch" }
  if (level === "green") return { bg: "#dcfce7", fg: "#16a34a", label: "Good"  }
  return { bg: "var(--surface-2)", fg: "var(--text-muted)", label: "—" }
}

function riskColor(level: RiskLevel | undefined): string {
  if (!level || level === "neutral") return "var(--text-muted)"
  if (level === "red")   return "#dc2626"
  if (level === "amber") return "#f59e0b"
  return "var(--green)"
}

function runwayRisk(months: number | null): RiskLevel {
  if (months === null) return "green"
  if (months >= 12) return "green"
  if (months >= 6)  return "amber"
  return "red"
}

function priorityBg(p: "high" | "medium" | "low"): string {
  if (p === "high")   return "#fef2f2"
  if (p === "medium") return "#fef3c7"
  return "#dcfce7"
}
function priorityFg(p: "high" | "medium" | "low"): string {
  if (p === "high")   return "#dc2626"
  if (p === "medium") return "#b45309"
  return "#16a34a"
}

