/**
 * Schedules — split-view hub at /app/schedules.
 *
 * Left rail: an "Overview" landing + one row per schedule type (Prepaids,
 * Accruals, Fixed Assets, Leases, Loans) with its ending balance + a
 * committed/draft status dot + an "AI suggestions" entry. Right pane:
 * visualize-first detail for the selection.
 *
 * This page is a STATUS + NAVIGATION hub — it deliberately does NOT
 * re-implement the editors. Every type's full workpaper (line items, the
 * month-by-month amortization / loan / depreciation / lease schedules in the
 * existing drawers, AI scan + accept, QBO import, renewal alerts, roll-forward
 * card, and commit → push-to-recon) still lives on its dedicated page and is
 * reached via "Open full workpaper". Nothing was removed; the landing just
 * went from a flat card grid to a split view.
 *
 * Period selector drives the single getOverview snapshot for all five types.
 * hasLoaded is persisted per-org in sessionStorage so drilling in/out keeps
 * the dashboard loaded (no re-click of Load).
 */
import { useEffect, useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { useOrganization } from "@clerk/clerk-react"
import { motion, AnimatePresence } from "framer-motion"
import {
  Calendar, ClipboardList, Building2, Home, Banknote,
  ArrowRight, CheckCircle2, Sparkles, RefreshCw, LayoutGrid,
  Download, ExternalLink, FileSpreadsheet, ArrowLeftRight,
} from "lucide-react"

import { Button, Spinner } from "@/core/ui/components"
import { DatePicker } from "@/core/ui/DatePicker"
import { PageHeader } from "@/core/ui/PageHeader"
import { toISODate } from "@/core/lib/dates"
import { useSelectedPeriodDefault } from "@/core/hooks/useSelectedPeriod"
import { schedulesApi } from "@/modules/schedules/api"
import {
  SCHEDULE_BLURB, SCHEDULE_HUMAN, SCHEDULE_ROUTE,
  SCHEDULE_TYPES, type OverviewType, type ScheduleType,
} from "@/modules/schedules/types"

type RailKey = "overview" | ScheduleType | "ai"

/** Persistence for hasLoaded across navigation (per org, session-scoped). */
function schedulesLoadedKey(orgId: string | undefined): string {
  return `nordavix:schedules:loaded:${orgId ?? "anon"}`
}

/** Default to last day of the previous full month — LOCAL components, not
 *  toISOString (which would roll back a day in any UTC+ timezone). */
function defaultPeriodEnd(): string {
  const now = new Date()
  return toISODate(new Date(now.getFullYear(), now.getMonth(), 0))
}

const ICONS: Record<ScheduleType, React.ReactNode> = {
  prepaid:     <Calendar      size={16} strokeWidth={1.8} />,
  accrual:     <ClipboardList size={16} strokeWidth={1.8} />,
  fixed_asset: <Building2     size={16} strokeWidth={1.8} />,
  lease:       <Home          size={16} strokeWidth={1.8} />,
  loan:        <Banknote      size={16} strokeWidth={1.8} />,
}

function fmtMoney(s: string | number): string {
  const n = typeof s === "number" ? s : parseFloat(s) || 0
  const abs = `$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
  return n < 0 ? `(${abs})` : abs
}

/** committed | draft | empty — drives the rail status dot. */
function statusOf(t: OverviewType): "committed" | "draft" | "empty" {
  if (t.active_count === 0) return "empty"
  return t.any_committed_for_period ? "committed" : "draft"
}
function statusColor(s: "committed" | "draft" | "empty"): string {
  if (s === "committed") return "var(--green)"
  if (s === "draft")     return "#c79a52"
  return "var(--text-muted)"
}

export function SchedulesOverview() {
  const navigate = useNavigate()
  const { organization } = useOrganization()
  const [periodEnd, setPeriodEnd] = useState<string>(useSelectedPeriodDefault(defaultPeriodEnd()))
  const [active, setActive] = useState<RailKey>("overview")

  const orgKey = schedulesLoadedKey(organization?.id)
  const [hasLoaded, setHasLoaded] = useState<boolean>(() => {
    try { return typeof window !== "undefined" && sessionStorage.getItem(orgKey) === "1" }
    catch { return false }
  })
  useEffect(() => {
    try { setHasLoaded(sessionStorage.getItem(orgKey) === "1") } catch { /* ignore */ }
  }, [orgKey])
  useEffect(() => {
    if (!hasLoaded) return
    try { sessionStorage.setItem(orgKey, "1") } catch { /* ignore */ }
  }, [hasLoaded, orgKey])

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["schedules", "overview", periodEnd],
    queryFn:  () => schedulesApi.getOverview(periodEnd),
    enabled:  hasLoaded,
  })

  const byType = useMemo(() => {
    const m = new Map<ScheduleType, OverviewType>()
    data?.types.forEach((t) => m.set(t.type, t))
    return m
  }, [data])

  const totalAcrossTypes = useMemo(
    () => data?.types.reduce((s, t) => s + (parseFloat(t.ending_balance) || 0), 0) ?? 0,
    [data],
  )
  const totalItems = useMemo(
    () => data?.types.reduce((s, t) => s + t.active_count, 0) ?? 0,
    [data],
  )

  return (
    <div className="flex flex-col h-full overflow-y-auto" style={{ background: "var(--bg)" }}>
      <PageHeader
        title="Schedules"
        subtitle="Workpapers behind every balance-sheet account · each schedule's ending balance auto-feeds its reconciliation."
        backTo="/app"
        actions={
          <>
            <DatePicker value={periodEnd} onChange={setPeriodEnd} />
            <Button
              size="sm"
              onClick={() => { setHasLoaded(true); if (hasLoaded) refetch() }}
              loading={isFetching}
              icon={<RefreshCw size={14} strokeWidth={1.8} />}
            >
              {hasLoaded ? "Refresh" : "Load schedules"}
            </Button>
          </>
        }
      />

      <div className="flex-1 px-4 sm:px-6 py-5 w-full max-w-7xl mx-auto space-y-4">
        {!hasLoaded ? (
          <div className="rounded-2xl p-10 text-center max-w-2xl mx-auto"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
            <div className="h-14 w-14 mx-auto rounded-xl flex items-center justify-center mb-4"
              style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
              <LayoutGrid size={26} strokeWidth={1.6} />
            </div>
            <p className="text-base font-semibold text-theme mb-1">Choose a period to load</p>
            <p className="text-sm max-w-md mx-auto mb-5" style={{ color: "var(--text-muted)" }}>
              Pick the period end above and click <b>Load schedules</b> to compute the
              roll-forward snapshot across all five schedule types.
            </p>
            <Button size="sm" onClick={() => setHasLoaded(true)} icon={<RefreshCw size={14} strokeWidth={1.8} />}>
              Load schedules
            </Button>
          </div>
        ) : isLoading || !data ? (
          <div className="py-20 flex flex-col items-center justify-center gap-2">
            <Spinner className="h-6 w-6" />
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>Computing roll-forwards…</p>
          </div>
        ) : (
          <div className="flex flex-col md:flex-row gap-4 lg:gap-6">
            <SchedulesRail
              active={active}
              onSelect={setActive}
              types={data.types}
              total={totalAcrossTypes}
              totalItems={totalItems}
            />
            <div className="flex-1 min-w-0">
              <AnimatePresence mode="wait">
                <motion.div
                  key={active}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.18, ease: "easeOut" }}
                  className="space-y-4"
                >
                  {active === "overview" ? (
                    <OverviewDetail
                      types={data.types} total={totalAcrossTypes} totalItems={totalItems}
                      periodEnd={periodEnd} onOpenType={(t) => setActive(t)}
                    />
                  ) : active === "ai" ? (
                    <AiDetail onOpen={(t) => navigate(SCHEDULE_ROUTE[t])} />
                  ) : (
                    <TypeDetail
                      t={byType.get(active)!}
                      total={totalAcrossTypes}
                      periodEnd={periodEnd}
                      onOpenWorkpaper={() => navigate(SCHEDULE_ROUTE[active])}
                    />
                  )}
                </motion.div>
              </AnimatePresence>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Rail ─────────────────────────────────────────────────────────────────────

function SchedulesRail({ active, onSelect, types, total, totalItems }: {
  active: RailKey
  onSelect: (k: RailKey) => void
  types: OverviewType[]
  total: number
  totalItems: number
}) {
  const byType = new Map(types.map((t) => [t.type, t]))
  const chips: { k: RailKey; label: string; icon: React.ReactNode }[] = [
    { k: "overview", label: "Overview", icon: <LayoutGrid size={12} strokeWidth={2} /> },
    ...SCHEDULE_TYPES.map((type): { k: RailKey; label: string; icon: React.ReactNode } => (
      { k: type, label: SCHEDULE_HUMAN[type], icon: ICONS[type] }
    )),
    { k: "ai", label: "AI", icon: <Sparkles size={12} strokeWidth={2} /> },
  ]
  return (
    <>
      {/* Desktop: vertical sticky rail */}
      <nav className="hidden md:flex md:flex-col gap-1 w-60 lg:w-72 shrink-0 md:sticky md:top-2 md:self-start"
        aria-label="Schedule types">
        <div className="px-2 pb-1">
          <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
            {fmtMoney(total)} · {totalItems} items
          </span>
        </div>

        <RailItemSched
          icon={<LayoutGrid size={16} strokeWidth={1.8} />} label="Overview"
          sub="Coverage & readiness" active={active === "overview"} onSelect={() => onSelect("overview")}
        />

        {SCHEDULE_TYPES.map((type) => {
          const t = byType.get(type)
          if (!t) return null
          const st = statusOf(t)
          return (
            <RailItemSched
              key={type}
              icon={ICONS[type]}
              label={SCHEDULE_HUMAN[type]}
              sub={`${fmtMoney(t.ending_balance)} · ${t.active_count} of ${t.total_count}`}
              active={active === type}
              onSelect={() => onSelect(type)}
              dot={st === "empty" ? undefined : statusColor(st)}
            />
          )
        })}

        <div className="h-px my-1.5 mx-2" style={{ background: "var(--border)" }} />
        <RailItemSched
          icon={<Sparkles size={16} strokeWidth={1.8} />} label="AI suggestions"
          sub="Review GL detections" active={active === "ai"} onSelect={() => onSelect("ai")} accent
        />
      </nav>

      {/* Mobile: horizontal chip strip */}
      <div className="md:hidden -mx-4 px-4 overflow-x-auto" style={{ scrollbarWidth: "none" }}>
        <div className="flex gap-2 pb-1">
          {chips.map((c) => {
            const isActive = active === c.k
            return (
              <button key={c.k} onClick={() => onSelect(c.k)}
                className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition-all shrink-0"
                style={{
                  background: isActive ? "var(--green-subtle)" : "var(--surface)",
                  color:      isActive ? "var(--green)"        : "var(--text-2)",
                  border:     `1px solid ${isActive ? "var(--green)" : "var(--border)"}`,
                }}>
                {c.icon}{c.label}
              </button>
            )
          })}
        </div>
      </div>
    </>
  )
}

function RailItemSched({ icon, label, sub, active, onSelect, dot, accent }: {
  icon: React.ReactNode
  label: string
  sub: string
  active: boolean
  onSelect: () => void
  dot?: string
  accent?: boolean
}) {
  return (
    <button onClick={onSelect}
      aria-current={active ? "page" : undefined}
      className="group w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors"
      style={{
        background: active ? "var(--green-subtle)" : "transparent",
        border: `1px solid ${active ? "color-mix(in oklab, var(--green) 35%, transparent)" : "transparent"}`,
      }}
      onMouseEnter={(e) => { if (!active) (e.currentTarget as HTMLElement).style.background = "var(--surface-2)" }}
      onMouseLeave={(e) => { if (!active) (e.currentTarget as HTMLElement).style.background = "transparent" }}
    >
      <span className="h-8 w-8 rounded-lg flex items-center justify-center shrink-0 transition-colors"
        style={{
          background: active ? "var(--green)" : accent ? "var(--green-subtle)" : "var(--surface-2)",
          color:      active ? "#fff"         : accent ? "var(--green)"        : "var(--text-2)",
        }}>
        {icon}
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-[13px] font-semibold truncate"
          style={{ color: active ? "var(--green)" : "var(--text)" }}>{label}</span>
        <span className="block text-[11px] truncate tabular-nums" style={{ color: "var(--text-muted)" }}>{sub}</span>
      </span>
      {dot && <span className="h-2 w-2 rounded-full shrink-0" style={{ background: dot }} />}
    </button>
  )
}

// ── Overview detail ────────────────────────────────────────────────────────

function OverviewDetail({ types, total, totalItems, periodEnd, onOpenType }: {
  types: OverviewType[]
  total: number
  totalItems: number
  periodEnd: string
  onOpenType: (t: ScheduleType) => void
}) {
  const max = Math.max(...types.map((t) => parseFloat(t.ending_balance) || 0), 1)
  const committed = types.filter((t) => t.active_count > 0 && t.any_committed_for_period).length
  const withItems = types.filter((t) => t.active_count > 0).length
  return (
    <>
      <Card>
        <div className="px-5 py-4" style={{ borderBottom: "1px solid var(--border)" }}>
          <p className="text-[11px] font-bold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
            Total schedule coverage · {periodEnd}
          </p>
          <p className="text-3xl font-bold tabular-nums mt-1" style={{ color: "var(--text)" }}>{fmtMoney(total)}</p>
          <p className="text-[12px] mt-0.5" style={{ color: "var(--text-muted)" }}>
            across {totalItems} active line items · {committed} of {withItems} schedules committed for this period
          </p>
        </div>
        <div className="p-5 space-y-2.5">
          <p className="text-[10px] font-bold uppercase tracking-wider mb-1" style={{ color: "var(--text-muted)" }}>
            Ending balance by type
          </p>
          {types.map((t) => {
            const bal = parseFloat(t.ending_balance) || 0
            const st = statusOf(t)
            return (
              <button key={t.type} onClick={() => onOpenType(t.type)}
                className="w-full flex items-center gap-3 group text-left">
                <span className="text-[12px] font-medium w-28 shrink-0 truncate inline-flex items-center gap-1.5"
                  style={{ color: "var(--text-2)" }}>
                  <span style={{ color: "var(--text-muted)" }}>{ICONS[t.type]}</span>
                  {SCHEDULE_HUMAN[t.type]}
                </span>
                <span className="flex-1 h-5 rounded-md overflow-hidden relative" style={{ background: "var(--surface-2)" }}>
                  <motion.span className="block h-full"
                    initial={{ width: 0 }} animate={{ width: `${(bal / max) * 100}%` }}
                    transition={{ duration: 0.5, ease: "easeOut" }}
                    style={{ background: "var(--green)" }} />
                </span>
                <span className="text-[12px] font-semibold w-16 text-right tabular-nums shrink-0" style={{ color: "var(--text)" }}>
                  {fmtMoney(t.ending_balance)}
                </span>
                {st !== "empty" && (
                  <span className="h-2 w-2 rounded-full shrink-0" style={{ background: statusColor(st) }} />
                )}
              </button>
            )
          })}
        </div>
      </Card>

      <Card>
        <div className="px-5 py-4">
          <h2 className="text-sm font-bold text-theme mb-2 inline-flex items-center gap-2">
            <Sparkles size={14} strokeWidth={1.8} style={{ color: "var(--green)" }} />
            Why every close needs these schedules
          </h2>
          <ul className="text-xs space-y-1.5" style={{ color: "var(--text-2)" }}>
            <li><span className="font-semibold text-theme">Enter once, reconcile forever.</span>{" "}
              Each schedule's ending balance auto-feeds its reconciliation as the subledger — no re-keying.</li>
            <li><span className="font-semibold text-theme">Defensible math.</span>{" "}
              Straight-line amortization, depreciation, and loan tables are computed by Nordavix — no formula bugs.</li>
            <li><span className="font-semibold text-theme">Variances mean something.</span>{" "}
              When GL and the schedule disagree, the recon flags a real anomaly — not a spreadsheet typo.</li>
          </ul>
        </div>
      </Card>
    </>
  )
}

// ── Per-type detail ──────────────────────────────────────────────────────────

function TypeDetail({ t, total, periodEnd, onOpenWorkpaper }: {
  t: OverviewType
  total: number
  periodEnd: string
  onOpenWorkpaper: () => void
}) {
  const [exporting, setExporting] = useState(false)
  const [exportErr, setExportErr] = useState<string | null>(null)
  const st = statusOf(t)
  const sharePct = total > 0 ? ((parseFloat(t.ending_balance) || 0) / total) * 100 : 0

  async function exportXlsx() {
    setExporting(true); setExportErr(null)
    try { await schedulesApi.downloadScheduleExcel(t.type, periodEnd) }
    catch (e) { setExportErr(e instanceof Error ? e.message : "Export failed") }
    finally { setExporting(false) }
  }

  const inside: string[] = {
    prepaid:     ["Line items with start/end + amortization method", "Month-by-month straight-line amortization schedule", "AI prepaid detection from your GL", "Renewal alerts for expiring items", "Proposed JEs + commit → feeds the recon"],
    accrual:     ["Accrual line items with reversal dates", "Accrue / reverse lifecycle per period", "AI missed-accrual + unreversed detection", "Proposed JEs + commit → feeds the recon"],
    fixed_asset: ["Asset register with cost + useful life", "Month-by-month depreciation & net book value schedule", "AI capitalization detection from your GL", "Disposals + proposed JEs + commit → feeds the recon"],
    lease:       ["Lease register with term + payment", "Payment schedule (optional ASC 842 ROU + liability)", "Proposed JEs + commit → feeds the recon"],
    loan:        ["Loan register with rate + term", "Month-by-month principal / interest amortization schedule", "Proposed JEs (principal + interest) + commit → feeds the recon"],
  }[t.type]

  return (
    <Card>
      <div className="px-5 py-4 flex items-start gap-3" style={{ borderBottom: "1px solid var(--border)" }}>
        <span className="h-9 w-9 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
          {ICONS[t.type]}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-base font-bold text-theme">{SCHEDULE_HUMAN[t.type]}</h2>
            {st === "committed" ? (
              <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full"
                style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
                <CheckCircle2 size={10} strokeWidth={2.4} /> Committed
              </span>
            ) : st === "draft" ? (
              <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full"
                style={{ background: "#f4eddf", color: "#8a6326" }}>Draft</span>
            ) : null}
          </div>
          <p className="text-[12px] mt-0.5" style={{ color: "var(--text-muted)" }}>{SCHEDULE_BLURB[t.type]}</p>
        </div>
      </div>

      <div className="p-5 space-y-4">
        {/* KPI tiles — server-computed, from the period snapshot */}
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          <Kpi label="Ending balance" value={fmtMoney(t.ending_balance)} />
          <Kpi label="This period" value={fmtMoney(t.period_expense)} sub="expense / movement" />
          <Kpi label="Active items" value={`${t.active_count}`} sub={`of ${t.total_count}`} />
        </div>

        {/* Share of total coverage — honest, real-data context bar */}
        <div className="rounded-xl p-3" style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] font-semibold" style={{ color: "var(--text-2)" }}>Share of total schedule coverage</span>
            <span className="text-[11px] font-bold tabular-nums" style={{ color: "var(--text)" }}>{sharePct.toFixed(0)}%</span>
          </div>
          <div className="h-2.5 rounded-full overflow-hidden" style={{ background: "var(--surface)" }}>
            <motion.div className="h-full" initial={{ width: 0 }} animate={{ width: `${sharePct}%` }}
              transition={{ duration: 0.5, ease: "easeOut" }} style={{ background: "var(--green)" }} />
          </div>
        </div>

        {/* Recon interlink — the reason schedules exist */}
        <div className="rounded-xl p-3 flex items-start gap-2" style={{ background: "var(--green-subtle)", border: "1px solid var(--green)" }}>
          <ArrowLeftRight size={14} strokeWidth={1.9} className="shrink-0 mt-0.5" style={{ color: "var(--green)" }} />
          <p className="text-[12px]" style={{ color: "var(--green)" }}>
            {st === "committed"
              ? <>This schedule's <strong>{fmtMoney(t.ending_balance)}</strong> ending balance is committed and feeds the {SCHEDULE_HUMAN[t.type]} reconciliation as the subledger.</>
              : <>Commit this period's snapshot in the workpaper to feed the {SCHEDULE_HUMAN[t.type]} reconciliation with <strong>{fmtMoney(t.ending_balance)}</strong>.</>}
          </p>
        </div>

        {/* What's inside the full workpaper */}
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: "var(--text-muted)" }}>
            Inside this workpaper
          </p>
          <ul className="space-y-1.5">
            {inside.map((line, i) => (
              <li key={i} className="text-[12px] leading-snug flex items-start gap-2" style={{ color: "var(--text-2)" }}>
                <span className="mt-1.5 h-1 w-1 rounded-full shrink-0" style={{ background: "var(--green)" }} />
                {line}
              </li>
            ))}
          </ul>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 flex-wrap pt-1">
          <button onClick={onOpenWorkpaper}
            className="inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-semibold text-white hover:opacity-90 transition-opacity"
            style={{ background: "var(--green)" }}>
            Open full workpaper
            <ArrowRight size={14} strokeWidth={2.2} />
          </button>
          <button onClick={exportXlsx} disabled={exporting}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold disabled:opacity-60 transition-opacity"
            style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }}>
            {exporting ? <Spinner className="h-3.5 w-3.5" /> : <Download size={13} strokeWidth={1.9} />}
            Export .xlsx
          </button>
        </div>
        {exportErr && <p className="text-[11px]" style={{ color: "#9b3d37" }}>{exportErr}</p>}
      </div>
    </Card>
  )
}

// ── AI suggestions detail ────────────────────────────────────────────────────

function AiDetail({ onOpen }: { onOpen: (t: ScheduleType) => void }) {
  const tools: { type: ScheduleType; icon: React.ReactNode; title: string; desc: string }[] = [
    { type: "prepaid",     icon: ICONS.prepaid,     title: "Prepaid detection",        desc: "Scans expense GL for payments that should be capitalized as prepaids and amortized." },
    { type: "fixed_asset", icon: ICONS.fixed_asset, title: "Capitalization detection", desc: "Flags large expensed purchases that likely belong on the fixed-asset register." },
    { type: "accrual",     icon: ICONS.accrual,     title: "Missed & unreversed accruals", desc: "Finds period-end expenses that should have been accrued, and accruals due to reverse." },
  ]
  return (
    <Card>
      <div className="px-5 py-4 flex items-start gap-3" style={{ borderBottom: "1px solid var(--border)" }}>
        <span className="h-9 w-9 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
          <Sparkles size={17} strokeWidth={1.8} />
        </span>
        <div className="flex-1 min-w-0">
          <h2 className="text-base font-bold text-theme">AI suggestions</h2>
          <p className="text-[12px] mt-0.5" style={{ color: "var(--text-muted)" }}>
            Nordavix scans your general ledger for schedule items you may have missed. Run a scan and review each
            candidate inside the relevant workpaper.
          </p>
        </div>
      </div>
      <div className="p-5 grid grid-cols-1 sm:grid-cols-3 gap-3">
        {tools.map((tool) => (
          <div key={tool.title} className="rounded-xl p-4 flex flex-col"
            style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
            <span className="h-8 w-8 rounded-lg flex items-center justify-center mb-2"
              style={{ background: "var(--surface)", color: "var(--text-2)" }}>{tool.icon}</span>
            <p className="text-sm font-semibold text-theme">{tool.title}</p>
            <p className="text-[11px] mt-1 flex-1" style={{ color: "var(--text-muted)" }}>{tool.desc}</p>
            <button onClick={() => onOpen(tool.type)}
              className="mt-3 inline-flex items-center gap-1 text-[12px] font-semibold self-start"
              style={{ color: "var(--green)" }}>
              Open workpaper <ExternalLink size={12} strokeWidth={2} />
            </button>
          </div>
        ))}
      </div>
      <div className="px-5 pb-5 -mt-1">
        <p className="text-[11px] flex items-center gap-1.5" style={{ color: "var(--text-muted)" }}>
          <FileSpreadsheet size={12} strokeWidth={1.8} />
          Accepted suggestions become real schedule items and flow into the roll-forward + proposed JEs automatically.
        </p>
      </div>
    </Card>
  )
}

// ── Small shared bits ────────────────────────────────────────────────────────

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl overflow-hidden"
      style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
      {children}
    </div>
  )
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl p-3.5" style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
      <p className="text-[10px] font-bold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>{label}</p>
      <p className="text-xl font-bold tabular-nums mt-1" style={{ color: "var(--text)" }}>{value}</p>
      {sub && <p className="text-[11px] mt-0.5" style={{ color: "var(--text-muted)" }}>{sub}</p>}
    </div>
  )
}
