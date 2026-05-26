/**
 * Insights — decision-grade dashboard, not a vanity chart wall.
 *
 * Each section leads with a KPI table (KPI / Value / Risk / Insight),
 * supported by a small chart only when the chart tells a story the
 * table doesn't. Designed to answer "what should I do this month?"
 * not "where can I find this number?".
 */
import { useMemo, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { motion, AnimatePresence } from "framer-motion"
import {
  TrendingUp, TrendingDown, Wallet, ReceiptText, ArrowDownToLine,
  ArrowUpFromLine, LineChart as LineIcon, Sparkles, AlertTriangle,
  Calendar, RefreshCw, Info, Lightbulb,
} from "lucide-react"
import { Spinner } from "@/core/ui/components"
import { insightsApi, type InsightsOverview, type KpiRow, type RiskLevel, type HistoryPoint } from "@/modules/insights/api"

// ── Period helpers ───────────────────────────────────────────────────────────

function lastDayOfMonth(year: number, monthIdx: number): string {
  const last = new Date(year, monthIdx + 1, 0)
  return last.toISOString().slice(0, 10)
}

function defaultPeriodEnd(): string {
  const now = new Date()
  // Default to the prior fully-closed month
  return lastDayOfMonth(now.getFullYear(), now.getMonth() - 1)
}

function monthOptions(): { value: string; label: string }[] {
  const now = new Date()
  const out: { value: string; label: string }[] = []
  for (let i = 1; i <= 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    out.push({
      value: lastDayOfMonth(d.getFullYear(), d.getMonth()),
      label: d.toLocaleString("en-US", { month: "long", year: "numeric" }),
    })
  }
  return out
}

// ── Main page ────────────────────────────────────────────────────────────────

export function InsightsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [period, setPeriod] = useState<string>(searchParams.get("period") || defaultPeriodEnd())

  function setPeriodAndUrl(p: string) {
    setPeriod(p)
    const next = new URLSearchParams(searchParams)
    next.set("period", p)
    setSearchParams(next, { replace: true })
  }

  const { data, isLoading, isFetching, refetch, error } = useQuery<InsightsOverview, Error>({
    queryKey: ["insights-overview", period],
    queryFn:  () => insightsApi.getOverview(period),
    staleTime: 60_000,
  })

  return (
    <div className="flex flex-col h-full overflow-y-auto" style={{ background: "var(--bg)" }}>
      {/* Header */}
      <div className="px-4 sm:px-8 py-5 sm:py-6 shrink-0"
        style={{ borderBottom: "1px solid var(--border)", background: "var(--surface)" }}>
        <div className="max-w-7xl mx-auto flex items-start gap-3 flex-wrap">
          <div className="h-9 w-9 rounded-lg flex items-center justify-center shrink-0"
            style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
            <Lightbulb size={18} strokeWidth={1.8} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-lg sm:text-xl font-bold text-theme leading-tight">Insights</h1>
              {data && (
                <span className="text-[11px] font-medium px-2 py-0.5 rounded-full"
                  style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}>
                  {data.period_label}
                </span>
              )}
            </div>
            <p className="text-xs sm:text-sm mt-1" style={{ color: "var(--text-muted)" }}>
              Decisions, risks, recommendations — synthesised from your books for the period.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Calendar size={14} strokeWidth={1.8} style={{ color: "var(--text-muted)" }} />
            <select
              value={period}
              onChange={(e) => setPeriodAndUrl(e.target.value)}
              className="rounded-lg px-3 py-1.5 text-sm font-medium outline-none"
              style={{
                background: "var(--surface-2)",
                border: "1px solid var(--border-strong)",
                color: "var(--text)",
              }}
            >
              {monthOptions().map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
            <button
              onClick={() => refetch()}
              disabled={isFetching}
              title="Refresh"
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-opacity hover:opacity-90 disabled:opacity-50"
              style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }}
            >
              <RefreshCw size={12} strokeWidth={2} className={isFetching ? "animate-spin" : ""} />
              Refresh
            </button>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 px-4 sm:px-8 py-6 max-w-7xl w-full mx-auto">
        {isLoading && (
          <div className="h-64 flex items-center justify-center">
            <Spinner className="h-6 w-6" />
          </div>
        )}
        {error && !isLoading && (
          <div className="rounded-lg p-4 flex items-start gap-3"
            style={{ background: "#fef2f2", border: "1px solid #fecaca" }}>
            <AlertTriangle size={16} className="shrink-0 mt-0.5" style={{ color: "#dc2626" }} />
            <div>
              <p className="text-sm font-semibold" style={{ color: "#991b1b" }}>Could not load insights</p>
              <p className="text-xs mt-1" style={{ color: "#991b1b" }}>{error.message}</p>
            </div>
          </div>
        )}

        {data && (
          <AnimatePresence mode="wait">
            <motion.div
              key={period}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.22, ease: "easeOut" }}
              className="space-y-6"
            >
              <HeroKpis data={data} />
              <Recommendations data={data} />
              <LiquiditySection data={data} />
              <ProfitabilitySection data={data} />
              <ReceivablesSection data={data} />
              <PayablesSection data={data} />
              <ExpensesSection data={data} />
            </motion.div>
          </AnimatePresence>
        )}
      </div>
    </div>
  )
}

// ── Hero KPI strip ───────────────────────────────────────────────────────────

function HeroKpis({ data }: { data: InsightsOverview }) {
  const tiles = useMemo(() => [
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
        ? `${data.liquidity.runway_months.toFixed(1)} mo`
        : "Indefinite",
      change: null,
      changeUp: false,
      sub:    data.liquidity.runway_months !== null ? "at current burn" : "cash-positive",
      risk:   riskColor(runwayRisk(data.liquidity.runway_months)),
    },
    {
      label:  "Revenue (mo)",
      value:  fmtMoney(data.profitability.revenue),
      change: data.profitability.revenue_change_str,
      changeUp: (data.profitability.revenue_change_str ?? "").startsWith("+"),
      sub:    "this period",
    },
    {
      label:  "Net margin",
      value:  data.profitability.net_margin_pct !== null
        ? `${data.profitability.net_margin_pct.toFixed(1)}%`
        : "—",
      change: null,
      changeUp: false,
      sub:    "net income / revenue",
      risk:   data.profitability.net_margin_pct !== null
        ? (data.profitability.net_margin_pct >= 15 ? "green"
          : data.profitability.net_margin_pct >= 0 ? "amber" : "red")
        : "neutral",
    },
  ], [data])

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {tiles.map((t, i) => (
        <div key={i} className="rounded-2xl p-4 transition-all"
          style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
              {t.label}
            </span>
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

// ── Recommendations ──────────────────────────────────────────────────────────

function Recommendations({ data }: { data: InsightsOverview }) {
  if (!data.recommendations || data.recommendations.length === 0) return null
  return (
    <section className="rounded-2xl overflow-hidden"
      style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
      <div className="px-5 py-4 flex items-center gap-2"
        style={{ borderBottom: "1px solid var(--border)" }}>
        <Sparkles size={15} strokeWidth={1.8} style={{ color: "var(--green)" }} />
        <h2 className="text-sm font-bold text-theme">Risks & recommendations</h2>
        <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
          ({data.recommendations.length})
        </span>
      </div>
      <ul className="divide-y" style={{ borderColor: "var(--border)" }}>
        {data.recommendations.map((r, i) => (
          <li key={i} className="px-5 py-4 flex items-start gap-3">
            <span className="h-7 w-7 rounded-md flex items-center justify-center shrink-0"
              style={{
                background: priorityBg(r.priority),
                color: priorityFg(r.priority),
              }}>
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
    </section>
  )
}

// ── Section wrappers ─────────────────────────────────────────────────────────

function Section({ title, icon: Icon, description, children }: {
  title: string; icon: React.ElementType; description: string; children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl"
      style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
      <div className="px-5 py-4"
        style={{ borderBottom: "1px solid var(--border)" }}>
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
      <div className="p-5 space-y-5">
        {children}
      </div>
    </section>
  )
}

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

// ── Liquidity ────────────────────────────────────────────────────────────────

function LiquiditySection({ data }: { data: InsightsOverview }) {
  return (
    <Section title="Liquidity" icon={Wallet}
      description="Cash position, burn rate, runway, and operating cash flow. The 'can we keep paying our bills' picture.">
      <KpiTable rows={data.liquidity.kpis} />
      <SectionDivider label="Cash & operating cash flow — last 7 months" />
      <DualSparkline
        history={data.liquidity.history}
        leftKey="cash"
        rightKey="ocf"
        leftLabel="Cash balance"
        rightLabel="Monthly OCF"
      />
    </Section>
  )
}

// ── Profitability ────────────────────────────────────────────────────────────

function ProfitabilitySection({ data }: { data: InsightsOverview }) {
  return (
    <Section title="Revenue & profitability" icon={LineIcon}
      description="Top-line trends and margin compression. Watch GP / OPEX dynamics for early signs of pricing or scaling issues.">
      <KpiTable rows={data.profitability.kpis} />
      <SectionDivider label="Revenue, GP, and net income — last 7 months" />
      <TripleSparkline
        history={data.profitability.history}
        keys={["revenue", "gp", "ni"]}
        labels={["Revenue", "Gross profit", "Net income"]}
      />
    </Section>
  )
}

// ── Receivables ──────────────────────────────────────────────────────────────

function ReceivablesSection({ data }: { data: InsightsOverview }) {
  return (
    <Section title="Receivables (AR)" icon={ArrowDownToLine}
      description="How quickly customers pay you, where the risk concentrates, and the largest overdue balances.">
      <KpiTable rows={data.receivables.kpis} />

      {data.receivables.aging.length > 0 ? (
        <>
          <SectionDivider label="Aging concentration" />
          <AgingBars buckets={data.receivables.aging} />
        </>
      ) : data.receivables.qbo_error && (
        <div className="text-[12px] flex items-center gap-2 rounded-lg p-3"
          style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}>
          <Info size={12} strokeWidth={1.8} />
          {data.receivables.qbo_error}
        </div>
      )}

      {data.receivables.top_customers.length > 0 && (
        <>
          <SectionDivider label="Top 5 overdue customers" />
          <EntityTable rows={data.receivables.top_customers} entityLabel="Customer" />
        </>
      )}
    </Section>
  )
}

// ── Payables ─────────────────────────────────────────────────────────────────

function PayablesSection({ data }: { data: InsightsOverview }) {
  return (
    <Section title="Payables (AP)" icon={ArrowUpFromLine}
      description="How quickly you're paying suppliers. Stretching too far damages relationships; paying too fast hurts working capital.">
      <KpiTable rows={data.payables.kpis} />

      {data.payables.aging.length > 0 ? (
        <>
          <SectionDivider label="Aging concentration" />
          <AgingBars buckets={data.payables.aging} />
        </>
      ) : data.payables.qbo_error && (
        <div className="text-[12px] flex items-center gap-2 rounded-lg p-3"
          style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}>
          <Info size={12} strokeWidth={1.8} />
          {data.payables.qbo_error}
        </div>
      )}

      {data.payables.top_vendors.length > 0 && (
        <>
          <SectionDivider label="Top 5 owed vendors" />
          <EntityTable rows={data.payables.top_vendors} entityLabel="Vendor" />
        </>
      )}
    </Section>
  )
}

// ── Expenses ─────────────────────────────────────────────────────────────────

function ExpensesSection({ data }: { data: InsightsOverview }) {
  return (
    <Section title="Expense monitoring" icon={ReceiptText}
      description="Where the money went this month + month-over-month movers. Quick anomaly detection for the close review.">
      <KpiTable rows={data.expenses.kpis} />

      {data.expenses.top_categories.length > 0 && (
        <>
          <SectionDivider label="Largest categories (by spend this month)" />
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
  )
}

// ── Mini-charts (SVG, no chart lib) ──────────────────────────────────────────

function DualSparkline({ history, leftKey, rightKey, leftLabel, rightLabel }: {
  history: HistoryPoint[]; leftKey: keyof HistoryPoint; rightKey: keyof HistoryPoint;
  leftLabel: string; rightLabel: string;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <SparklineCard label={leftLabel} points={history.map((h) => ({ x: h.label, y: Number(h[leftKey] ?? 0) }))} color="var(--green)" />
      <SparklineCard label={rightLabel} points={history.map((h) => ({ x: h.label, y: Number(h[rightKey] ?? 0) }))} color="#6366f1" />
    </div>
  )
}

function TripleSparkline({ history, keys, labels }: {
  history: HistoryPoint[]; keys: (keyof HistoryPoint)[]; labels: string[];
}) {
  const colors = ["var(--green)", "#6366f1", "#f59e0b"]
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      {keys.map((k, i) => (
        <SparklineCard
          key={String(k)}
          label={labels[i]}
          points={history.map((h) => ({ x: h.label, y: Number(h[k] ?? 0) }))}
          color={colors[i]}
        />
      ))}
    </div>
  )
}

function SparklineCard({ label, points, color }: { label: string; points: { x: string; y: number }[]; color: string }) {
  const W = 220, H = 60, PAD = 4
  if (!points || points.length === 0) return null
  const ys = points.map((p) => p.y)
  const min = Math.min(...ys, 0)
  const max = Math.max(...ys, 0)
  const span = max - min || 1
  const last = points[points.length - 1].y
  const prev = points.length > 1 ? points[points.length - 2].y : last
  const dx = (W - PAD * 2) / Math.max(1, points.length - 1)
  const toY = (v: number) => H - PAD - ((v - min) / span) * (H - PAD * 2)
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"} ${PAD + i * dx} ${toY(p.y)}`).join(" ")
  const area = `${path} L ${PAD + (points.length - 1) * dx} ${H - PAD} L ${PAD} ${H - PAD} Z`
  const change = prev !== 0 ? ((last - prev) / Math.abs(prev)) * 100 : null

  return (
    <div className="rounded-lg p-3"
      style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
      <div className="flex items-center justify-between mb-1">
        <p className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
          {label}
        </p>
        {change !== null && (
          <span className="text-[10px] font-bold"
            style={{ color: change >= 0 ? "var(--green)" : "#dc2626" }}>
            {change >= 0 ? "+" : ""}{change.toFixed(1)}%
          </span>
        )}
      </div>
      <p className="text-base font-bold mb-1" style={{ color: "var(--text)" }}>
        {fmtMoney(last)}
      </p>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="overflow-visible">
        <defs>
          <linearGradient id={`grad-${label.replace(/\s/g, "")}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%"  stopColor={color} stopOpacity="0.22" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#grad-${label.replace(/\s/g, "")})`} />
        <path d={path} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
        {points.map((p, i) => (
          <circle key={i}
            cx={PAD + i * dx}
            cy={toY(p.y)}
            r={i === points.length - 1 ? 2.6 : 1.6}
            fill={i === points.length - 1 ? color : "var(--surface)"}
            stroke={color}
            strokeWidth="1"
          />
        ))}
      </svg>
      <div className="flex justify-between mt-1">
        {points.map((p, i) => (
          <span key={i} className="text-[9px]" style={{ color: "var(--text-muted)" }}>
            {i === 0 || i === points.length - 1 || i % 2 === 0 ? p.x : ""}
          </span>
        ))}
      </div>
    </div>
  )
}

function AgingBars({ buckets }: { buckets: { bucket: string; amount: number; pct: number }[] }) {
  const colors = ["#10b981", "#84cc16", "#f59e0b", "#f97316", "#ef4444"]
  return (
    <div className="space-y-2">
      {buckets.map((b, i) => (
        <div key={i} className="flex items-center gap-3">
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

function CategoryBars({ rows }: { rows: { category: string; amount: number; change_pct: number | null }[] }) {
  if (!rows.length) return null
  const max = Math.max(...rows.map((r) => Math.abs(r.amount))) || 1
  return (
    <div className="space-y-1.5">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-3">
          <span className="text-[11px] font-medium w-44 shrink-0 truncate" style={{ color: "var(--text-2)" }} title={r.category}>
            {r.category}
          </span>
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
            <th className="text-left text-[10px] font-bold uppercase tracking-wider pb-2 pr-3" style={{ color: "var(--text-muted)" }}>{entityLabel}</th>
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

// ── Utilities ────────────────────────────────────────────────────────────────

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
