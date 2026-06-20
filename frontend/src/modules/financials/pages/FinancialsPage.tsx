/**
 * Financial Package — Income Statement / Balance Sheet / Cash Flow.
 *
 * Top of every statement: BIG company name in navy + statement
 * title + period subtitle (centered, like a real audit deliverable).
 *
 * Rows are rendered from the backend's flat list. Styling is driven
 * by kind:
 *   section_header → uppercase navy, no values, no top border
 *   data           → indented, plain
 *   subtotal/total → bold + top rule (within-section + section totals)
 *   computed       → bold + top rule (Gross Profit, Operating Income)
 *   grand_total    → bold navy + DOUBLE rule (Net Income, Total Assets)
 *
 * Export PDF lives in the header. When books are closed, downloads
 * a clean final version. When NOT closed, offers a "draft" export
 * that returns a DRAFT-watermarked PDF — better UX than disabling
 * the button entirely (users want to preview the format).
 *
 * Any export error is surfaced as a clear inline banner instead of
 * failing silently.
 */
import { useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useOrganization } from "@clerk/clerk-react"
import { motion, AnimatePresence } from "framer-motion"
import {
  Download,
  FileText,
  Lock,
  AlertCircle,
  BarChart3,
  Scale,
  TrendingUp,
  TrendingDown,
  Layers,
  Calendar,
  Sparkles,
  CheckCircle2,
  Briefcase,
  Table2,
  Send,
  RefreshCw,
} from "lucide-react"
import { Button, Spinner } from "@/core/ui/components"
import { DatePicker } from "@/core/ui/DatePicker"
import { PageHeader } from "@/core/ui/PageHeader"
import { toISODate, formatDate } from "@/core/lib/dates"
import {
  financialsApi, FINANCIAL_SCHEDULES, SCHEDULE_GROUPS,
  type Statement, type FinancialRow, type FinancialSource, type ComparativeBasis,
} from "@/modules/financials/api"
import { useQboConnection } from "@/modules/flux/hooks"
import { reconsApi } from "@/modules/recons/api"

type Tab = "is" | "bs" | "cf"

function defaultPeriodEnd(): string {
  const d = new Date(); d.setDate(0)   // last day of the prior month (local)
  return toISODate(d)
}

/** Last-day-of-month helper for the quick-period chips. */
function lastDayOfMonth(year: number, month: number): string {
  // month is 1-12; new Date(y, m, 0) returns day 0 of next month = last of current.
  // toISODate (local components) — NOT toISOString, which would roll the date back
  // a day in any UTC+ timezone and desync period_end from the month-end snapshot.
  return toISODate(new Date(year, month, 0))
}

/** Quick-period options driven off "today" — match the period selector
 *  to the most common accounting cuts. Each preset returns BOTH a
 *  period_end AND a mode/start, so clicking "Last month" puts the page
 *  in a state where the Income Statement shows just that one month
 *  (not the full YTD ending in that month). */
function quickPeriods(): { key: string; label: string; periodEnd: string; mode: "ytd" | "custom"; periodStart?: string }[] {
  const today = new Date()
  const y = today.getFullYear()
  const m = today.getMonth() + 1  // 1-12
  // Last completed month
  const lastMonth = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 }
  // Last completed quarter
  const quarterEndMonth = (Math.floor((m - 1) / 3)) * 3   // 0, 3, 6, 9
  const lastQuarter = quarterEndMonth === 0 ? { y: y - 1, m: 12 } : { y, m: quarterEndMonth }
  const quarterStartMonth = lastQuarter.m - 2
  return [
    {
      key: "lm", label: "Last month",
      periodEnd: lastDayOfMonth(lastMonth.y, lastMonth.m),
      mode: "custom",
      periodStart: toISODate(new Date(lastMonth.y, lastMonth.m - 1, 1)),
    },
    {
      key: "lq", label: "Last quarter",
      periodEnd: lastDayOfMonth(lastQuarter.y, lastQuarter.m),
      mode: "custom",
      periodStart: toISODate(new Date(lastQuarter.y, quarterStartMonth - 1, 1)),
    },
    {
      key: "ytd", label: "YTD",
      periodEnd: lastDayOfMonth(lastMonth.y, lastMonth.m),
      mode: "ytd",
    },
    {
      key: "ly", label: "Last year",
      periodEnd: lastDayOfMonth(y - 1, 12),
      mode: "custom",
      periodStart: toISODate(new Date(y - 1, 0, 1)),
    },
  ]
}

function fmtMoney(s: string | null | undefined, withDollar = false): string {
  if (s === null || s === undefined || s === "") return ""
  const n = parseFloat(s)
  if (!Number.isFinite(n)) return ""
  if (n === 0) return "—"
  const abs = `${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
  const body = n < 0 ? `(${abs})` : abs
  return withDollar ? `$ ${body}` : body
}

const TAB_LABEL: Record<Tab, string> = {
  is: "Income Statement",
  bs: "Balance Sheet",
  cf: "Cash Flow",
}

const TAB_ICON: Record<Tab, typeof BarChart3> = {
  is: TrendingUp,
  bs: Scale,
  cf: BarChart3,
}

const TAB_SUB: Record<Tab, string> = {
  is: "Revenue · COGS · OpEx · Net Income",
  bs: "Assets · Liabilities · Equity",
  cf: "Operating · Investing · Financing",
}

/** First-day-of-month helper for the "Custom range" default. */
function firstDayOfMonth(periodEnd: string): string {
  try {
    const d = new Date(periodEnd + "T00:00:00")
    return toISODate(new Date(d.getFullYear(), d.getMonth(), 1))
  } catch {
    return periodEnd
  }
}

/** First-day-of-year (calendar-year YTD). */
function firstDayOfYear(periodEnd: string): string {
  try {
    const d = new Date(periodEnd + "T00:00:00")
    return toISODate(new Date(d.getFullYear(), 0, 1))
  } catch {
    return periodEnd
  }
}

type PeriodMode = "ytd" | "custom"

// Rail selection: the three statements plus the two side panels.
type RailKey = Tab | "exec" | "exports"

// ── "Keep loaded" persistence ─────────────────────────────────────────────────
// Remember the last financials view per workspace so returning lands already
// loaded (no re-pick + re-Load), keyed by Clerk org id so each company restores
// its own last view.
interface SavedView {
  tab:         Tab
  periodEnd:   string
  periodMode:  PeriodMode
  periodStart: string
  source:      FinancialSource
  comparative: boolean
}
const savedViewKey = (orgId: string) => `ndvx:financials:lastview:${orgId}`

function readSavedView(orgId: string): SavedView | null {
  try {
    const raw = localStorage.getItem(savedViewKey(orgId))
    if (!raw) return null
    const v = JSON.parse(raw) as SavedView
    if (v && typeof v.periodEnd === "string" && (v.tab === "is" || v.tab === "bs" || v.tab === "cf")) return v
  } catch { /* ignore corrupt / unavailable storage */ }
  return null
}

function writeSavedView(orgId: string, v: SavedView): void {
  try { localStorage.setItem(savedViewKey(orgId), JSON.stringify(v)) } catch { /* ignore */ }
}

/** Headline rows for the visualize-first KPI strip — the statement's own
 *  computed/grand totals (Gross profit, Net income, Total assets, …) so the
 *  numbers are exactly the audited totals, never a re-derivation. Falls back to
 *  section subtotals when a statement has few computed lines (e.g. cash flow). */
function pickHeadlineRows(rows: FinancialRow[]): FinancialRow[] {
  const hasVal = (r: FinancialRow) => r.current !== null && r.current !== "" && r.current !== undefined
  const strong = rows.filter((r) => (r.kind === "grand_total" || r.kind === "computed") && hasVal(r))
  let picked = strong
  if (picked.length < 3) {
    const totals = rows.filter((r) => (r.kind === "total" || r.kind === "subtotal") && hasVal(r))
    // de-dupe by label, keep strong first
    const seen = new Set(strong.map((r) => r.label))
    picked = [...strong, ...totals.filter((r) => !seen.has(r.label))]
  }
  return picked.slice(0, 4)
}

export function FinancialsPage() {
  const navigate = useNavigate()
  const { organization } = useOrganization()
  const orgId = organization?.id ?? null
  const [tab, setTab]                 = useState<Tab>("is")           // statement driving the query
  const [active, setActive]           = useState<RailKey>("is")       // rail selection (statements + panels)
  const [periodEnd, setPeriodEnd]     = useState<string>(defaultPeriodEnd())
  // Period type — "Custom" is the default: it exposes a Period Start picker
  // and defaults the range to the month being viewed (1st → period-end). YTD
  // calculates start as Jan 1 server-side. Only affects IS + CF; BS is
  // point-in-time and ignores it.
  const [periodMode, setPeriodMode]   = useState<PeriodMode>("custom")
  const [periodStart, setPeriodStart] = useState<string>(firstDayOfMonth(defaultPeriodEnd()))
  const [comparative, setComparative] = useState<boolean>(true)
  // Default to Nordavix synced data — works offline + respects the
  // user's manual reconciliation overrides. Users can flip back to
  // Live QuickBooks if they want to verify against QBO's own reports.
  const [source, setSource]           = useState<FinancialSource>("nordavix")
  const [exportError, setExportError] = useState<string | null>(null)
  const [execError, setExecError]     = useState<string | null>(null)
  // Don't auto-fetch on mount — financial-statement pulls are
  // expensive (multiple QBO API calls) and the user typically wants
  // to pick the period first. Once they click Load, subsequent tab
  // switches AND period changes auto-refresh (the user has opted in).
  const [hasLoaded, setHasLoaded] = useState(false)

  const { data: qbo } = useQboConnection()
  // Cash Flow always goes through QuickBooks even in Nordavix-synced
  // mode — building CF properly from internal data requires more
  // decomposition (non-cash adjustments etc) than the snapshot
  // currently carries. The selector still shows nordavix, but the
  // CF tab transparently uses QBO.
  const effectiveSource: FinancialSource = tab === "cf" ? "quickbooks" : source

  // Always send an explicit start for IS/CF so the comparative basis only governs
  // the COMPARATIVE column and never reshapes the current period: custom → the
  // chosen start; YTD → Jan 1 of the period-end's year. (With period_start
  // omitted, prior_month would collapse the current IS/CF period to a single
  // month — see financials/router.py.) BS is point-in-time and ignores it.
  const isPeriodBased = tab === "is" || tab === "cf"
  const effectivePeriodStart: string | undefined = isPeriodBased
    ? (periodMode === "custom" ? periodStart : firstDayOfYear(periodEnd))
    : undefined

  // Comparative is always the prior PERIOD — the immediately preceding month —
  // for IS, BS, and CF (month-over-month, not prior year). The backend maps
  // prior_month to the previous calendar month (range for IS/CF, month-end for BS).
  const comparativeBasis: ComparativeBasis = "prior_month"

  const queryClient = useQueryClient()

  const { data: stmt, isLoading, error, refetch } = useQuery({
    queryKey: ["financial-statement", tab, periodEnd, comparative, effectiveSource, effectivePeriodStart, comparativeBasis],
    queryFn:  () => {
      if (tab === "is") return financialsApi.getIncomeStatement(periodEnd, comparative, effectiveSource, effectivePeriodStart, comparativeBasis)
      if (tab === "bs") return financialsApi.getBalanceSheet(periodEnd, comparative, effectiveSource, comparativeBasis)
      return financialsApi.getCashFlow(periodEnd, comparative, effectiveSource, effectivePeriodStart, comparativeBasis)
    },
    // Nordavix mode reads from our DB so QBO connection isn't strictly
    // required (snapshot may exist from past syncs even after disconnect).
    // CF always needs QBO regardless of source selection.
    enabled:  hasLoaded && (effectiveSource === "nordavix" || !!qbo),
    // 5 min keeps the cache warm across quick tab switches / comparative
    // toggles so they don't trigger a refetch flicker (manual reload still works).
    staleTime: 5 * 60_000,
  })

  // Warm a sibling statement tab on hover so switching to it is instant — no
  // refetch flicker. Mirrors the main query's key + fn for the hovered tab
  // (CF always reads QuickBooks; period_start only applies to IS/CF in custom).
  function prefetchTab(key: Tab) {
    if (key === tab) return
    const ps = (key === "is" || key === "cf") ? (periodMode === "custom" ? periodStart : firstDayOfYear(periodEnd)) : undefined
    const src: FinancialSource = key === "cf" ? "quickbooks" : source
    if (!(hasLoaded && (src === "nordavix" || !!qbo))) return
    queryClient.prefetchQuery({
      queryKey: ["financial-statement", key, periodEnd, comparative, src, ps, comparativeBasis],
      queryFn: () => {
        if (key === "is") return financialsApi.getIncomeStatement(periodEnd, comparative, src, ps, comparativeBasis)
        if (key === "bs") return financialsApi.getBalanceSheet(periodEnd, comparative, src, comparativeBasis)
        return financialsApi.getCashFlow(periodEnd, comparative, src, ps, comparativeBasis)
      },
      staleTime: 5 * 60_000,
    })
  }

  const exportMut = useMutation({
    mutationFn: ({ kind, draft }: { kind: "is" | "bs" | "cf" | "full"; draft: boolean }) =>
      financialsApi.exportPdf(kind, periodEnd, comparative, draft, source, comparativeBasis),
    onMutate: () => setExportError(null),
    onError: (e: Error) => setExportError(e.message),
  })

  // Executive Report — single AI-narrated, multi-page board package.
  // Only callable when books are closed (server-enforced); UI shows
  // the card whenever the selected period_end maps to a closed
  // period (not just when stmt.is_closed) so it's visible BEFORE
  // the user clicks Load. The user had no way to find this — it
  // was buried inside the post-Load tab area.
  const execReportMut = useMutation({
    mutationFn: (audience: "internal" | "client") => financialsApi.exportExecutiveReport(periodEnd, audience),
    onMutate: () => setExecError(null),
    onError: (e: Error) => setExecError(e.message),
  })

  // Send the plain-language client edition to a client by email (PDF attached).
  const [recipientEmail, setRecipientEmail] = useState("")
  const [sendOk, setSendOk]       = useState<string | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const sendReportMut = useMutation({
    mutationFn: (email: string) => financialsApi.sendExecutiveReportToClient(periodEnd, email),
    onMutate: () => { setSendError(null); setSendOk(null) },
    onSuccess: (r) => { setSendOk(`Sent to ${r.recipient}`); setRecipientEmail("") },
    onError: (e: Error) => setSendError(e.message),
  })

  // Closed-periods feed — drives the Exec Report card visibility
  // pre-Load. Cached + cheap (it's a small DB scan), reused from the
  // recons API. period_end matches are exact strings (YYYY-MM-DD).
  const { data: closedPeriods = [] } = useQuery({
    queryKey: ["closed-periods"],
    queryFn:  reconsApi.listClosedPeriods,
    staleTime: 60_000,
  })
  const isPeriodClosed = closedPeriods.some((c) => c.period_end === periodEnd)

  // Rail selection — statements drive both the highlight AND the queried
  // statement; the side panels (exec / exports) only move the highlight.
  function selectRail(key: RailKey) {
    setActive(key)
    if (key === "is" || key === "bs" || key === "cf") setTab(key)
  }

  // ── Keep loaded after first run (per workspace) ──
  // The restore effect's setStates carry the PREVIOUS org's fields until the
  // re-render lands, so the persist effect must skip the one write triggered by
  // a restore (else a workspace switch would clobber the new org's saved view
  // with the old org's fields). skipNextPersist gates exactly that write.
  const skipNextPersist = useRef(false)
  useEffect(() => {
    if (!orgId) return
    skipNextPersist.current = true
    const v = readSavedView(orgId)
    if (v) {
      setTab(v.tab); setActive(v.tab)
      setPeriodEnd(v.periodEnd); setPeriodMode(v.periodMode)
      setPeriodStart(v.periodStart); setSource(v.source); setComparative(v.comparative)
      setHasLoaded(true)
    } else {
      setHasLoaded(false)   // a workspace with no prior view shows the Load gate
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId])

  useEffect(() => {
    const skip = skipNextPersist.current
    skipNextPersist.current = false
    if (skip || !orgId || !hasLoaded) return
    writeSavedView(orgId, { tab, periodEnd, periodMode, periodStart, source, comparative })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, hasLoaded, tab, periodEnd, periodMode, periodStart, source, comparative])

  return (
    <div className="flex flex-col h-full overflow-y-auto" style={{ background: "var(--bg)" }}>
      {/* Header — compact single-row PageHeader (was a ~140px three-deck).
          relative + z-30 so its stacking context floats above the sticky
          tab bar (z-20) and the StatementView card below. Without this,
          the Export PDF dropdown opens behind the income-statement card
          because the sibling tab bar's stacking context lands above it. */}
      <PageHeader
        title="Financial Statements"
        subtitle="Audit-ready Income Statement, Balance Sheet, and Statement of Cash Flows — from your synced books or QuickBooks live."
        className="relative z-30"
        actions={
          <div className="flex items-end gap-2 flex-wrap">
            {/* Period mode — controls whether IS / CF show YTD or a
                custom range. Hidden when on BS (point-in-time). */}
            {isPeriodBased && (
              <label className="flex flex-col">
                <span className="text-[10px] font-semibold uppercase tracking-wide mb-1" style={{ color: "var(--text-muted)" }}>
                  Period type
                </span>
                <select value={periodMode}
                  onChange={(e) => {
                    const next = e.target.value as PeriodMode
                    setPeriodMode(next)
                    // When flipping to Custom for the first time, seed
                    // the start date with the first-of-current-month so
                    // the most common case (single month P&L) is one
                    // click away from working.
                    if (next === "custom" && !periodStart) {
                      setPeriodStart(firstDayOfMonth(periodEnd))
                    }
                  }}
                  className="rounded-lg px-3 py-1.5 text-sm outline-none"
                  style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }}
                  title="YTD = calendar year-to-date through the end date. Custom = explicit from/to range."
                >
                  <option value="ytd">YTD</option>
                  <option value="custom">Custom range</option>
                </select>
              </label>
            )}

            {/* Period START — only shown when Custom mode + IS/CF tab.
                For BS this stays hidden because a balance sheet is
                as-of a single date, not a range. */}
            {isPeriodBased && periodMode === "custom" && (
              <div className="flex flex-col">
                <span className="text-[10px] font-semibold uppercase tracking-wide mb-1" style={{ color: "var(--text-muted)" }}>
                  From
                </span>
                <DatePicker value={periodStart} onChange={setPeriodStart} />
              </div>
            )}

            <div className="flex flex-col">
              <span className="text-[10px] font-semibold uppercase tracking-wide mb-1" style={{ color: "var(--text-muted)" }}>
                {tab === "bs"
                  ? "As of"
                  : (periodMode === "custom" ? "To" : "As of")}
              </span>
              <DatePicker value={periodEnd} onChange={setPeriodEnd} />
            </div>

            <label className="flex flex-col">
              <span className="text-[10px] font-semibold uppercase tracking-wide mb-1" style={{ color: "var(--text-muted)" }}>
                Source
              </span>
              <select value={source}
                onChange={(e) => setSource(e.target.value as FinancialSource)}
                className="rounded-lg px-3 py-1.5 text-sm outline-none"
                style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }}
                title="Nordavix synced data: builds from snapshots captured on every reconciliations sync. QuickBooks live: calls QBO reports each render.">
                <option value="nordavix">Nordavix synced</option>
                <option value="quickbooks">QuickBooks (live)</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-xs cursor-pointer select-none mb-1.5"
              style={{ color: "var(--text-2)" }}>
              <input type="checkbox" checked={comparative} onChange={(e) => setComparative(e.target.checked)} />
              Show prior period
            </label>
            {hasLoaded ? (
              <Button size="sm" variant="outline" onClick={() => refetch()}
                loading={isLoading} icon={<RefreshCw size={13} strokeWidth={2} />}>
                Refresh
              </Button>
            ) : (
              <Button size="sm" onClick={() => setHasLoaded(true)}
                disabled={!qbo}>
                Load financials
              </Button>
            )}
            {hasLoaded && (
              <ExportButton
                isClosed={stmt?.is_closed ?? false}
                onExport={(kind, draft) => exportMut.mutate({ kind, draft })}
                loading={exportMut.isPending}
              />
            )}
          </div>
        }
      >
        {/* Quick-period chips — one-click presets so the user doesn't
            have to click into the date pickers for the most common
            cuts (last month / quarter / YTD / last year). Each chip
            sets BOTH the period type AND the date(s), so "Last month"
            puts the Income Statement on that exact month, not on YTD
            ending in that month. */}
        <div className="mt-2 flex items-center gap-1.5 flex-wrap">
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide mr-1"
            style={{ color: "var(--text-muted)" }}>
            <Calendar size={10} strokeWidth={1.8} />
            Quick
          </span>
          {quickPeriods().map((q) => {
            const active =
              q.periodEnd === periodEnd &&
              q.mode === periodMode &&
              (q.mode === "ytd" || q.periodStart === periodStart)
            return (
              <button
                key={q.key}
                onClick={() => {
                  setPeriodEnd(q.periodEnd)
                  setPeriodMode(q.mode)
                  if (q.periodStart) setPeriodStart(q.periodStart)
                }}
                className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors"
                style={{
                  background: active ? "var(--green-subtle)" : "var(--surface-2)",
                  color:      active ? "var(--green)"        : "var(--text-2)",
                  border:     `1px solid ${active ? "var(--green)" : "var(--border)"}`,
                }}
                title={q.mode === "ytd"
                  ? `Set to YTD through ${q.periodEnd}`
                  : `Set range to ${q.periodStart} – ${q.periodEnd}`}
              >
                {q.label}
              </button>
            )
          })}
          {/* Quick "Jan 1 — period end" YTD start for explicit YTD start
              entry — useful when the user has Custom mode on but wants
              calendar-YTD. Hidden when YTD mode covers it. */}
          {isPeriodBased && periodMode === "custom" && periodStart !== firstDayOfYear(periodEnd) && (
            <button
              onClick={() => setPeriodStart(firstDayOfYear(periodEnd))}
              className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors"
              style={{
                background: "var(--surface-2)",
                color: "var(--text-2)",
                border: "1px dashed var(--border)",
              }}
              title="Set From to January 1 of the same year"
            >
              ← Jan 1
            </button>
          )}
        </div>
      </PageHeader>

      <div className="flex-1 px-4 sm:px-6 py-5 w-full space-y-4">

        {/* Export error */}
        <AnimatePresence>
          {exportError && (
            <motion.div
              initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
              className="rounded-lg px-4 py-3 flex items-start gap-2"
              style={{ background: "#f7eeec", border: "1px solid #ecd7d3", color: "#86332e", overflow: "hidden" }}>
              <AlertCircle size={14} strokeWidth={1.8} className="shrink-0 mt-0.5" />
              <div className="flex-1 text-xs">
                <p className="font-semibold mb-0.5">Couldn&apos;t export PDF</p>
                <p>{exportError}</p>
              </div>
              <button onClick={() => setExportError(null)}
                className="text-[11px] font-medium hover:underline">Dismiss</button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* QBO not connected */}
        {!qbo && (
          <div className="rounded-xl p-4 flex items-start gap-3"
            style={{ background: "#f4eddf", border: "1px solid #c79a52" }}>
            <AlertCircle size={18} style={{ color: "#7a5622" }} className="shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-semibold" style={{ color: "#7a5622" }}>QuickBooks isn&apos;t connected</p>
              <p className="text-xs mt-0.5" style={{ color: "#7a5622" }}>
                Financial statements are pulled live from QuickBooks reports.
              </p>
            </div>
            <Button size="sm" onClick={() => navigate("/app/connections")}>Connect</Button>
          </div>
        )}

        {/* Load gate (first visit) → split view (master rail + detail). After
            the first Load this workspace's view is remembered, so a return
            visit lands here already loaded — no re-pick, no re-Load. */}
        {!hasLoaded ? (
          <div className="rounded-xl p-10 text-center max-w-3xl mx-auto"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
            <div className="h-14 w-14 mx-auto rounded-full flex items-center justify-center mb-4"
              style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
              <FileText size={26} strokeWidth={1.6} />
            </div>
            <p className="text-base font-semibold text-theme mb-1">Choose a period to load</p>
            <p className="text-sm max-w-md mx-auto mb-5" style={{ color: "var(--text-muted)" }}>
              Pick the period-end date above (and whether to include a prior-period
              comparative), then click <b>Load financials</b>. We&apos;ll remember
              this view so you land back here next time.
            </p>
            <Button size="sm" onClick={() => setHasLoaded(true)} disabled={!qbo}>
              Load financials
            </Button>
          </div>
        ) : (
          <div className="flex flex-col md:flex-row gap-4 lg:gap-6">
            <FinancialsRail
              active={active}
              onSelect={selectRail}
              onHover={prefetchTab}
              isPeriodClosed={isPeriodClosed}
              periodEnd={periodEnd}
            />
            <div className="flex-1 min-w-0">
              <AnimatePresence mode="wait">
                <motion.div
                  key={active}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.18, ease: "easeOut" }}
                  className="max-w-5xl space-y-4"
                >
                  {active === "exec" ? (
                    isPeriodClosed ? (
                      <ExecutiveReportCard
                        periodLabel={(() => {
                          try { return new Date(periodEnd + "T00:00:00").toLocaleDateString(undefined, { month: "long", year: "numeric" }) }
                          catch { return periodEnd }
                        })()}
                        onGenerate={() => execReportMut.mutate("internal")}
                        onGenerateClient={() => execReportMut.mutate("client")}
                        loading={execReportMut.isPending}
                        error={execError}
                        onDismissError={() => setExecError(null)}
                        recipientEmail={recipientEmail}
                        onRecipientChange={setRecipientEmail}
                        onSend={() => sendReportMut.mutate(recipientEmail)}
                        sending={sendReportMut.isPending}
                        sendOk={sendOk}
                        sendError={sendError}
                      />
                    ) : (
                      <div className="rounded-2xl p-8 text-center"
                        style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
                        <Sparkles size={24} strokeWidth={1.6} className="mx-auto mb-2" style={{ color: "var(--text-muted)" }} />
                        <p className="text-sm font-semibold text-theme mb-1">Executive report is a closed-period deliverable</p>
                        <p className="text-xs max-w-sm mx-auto" style={{ color: "var(--text-muted)" }}>
                          Close the books for {periodEnd} to generate the AI-narrated board package.
                        </p>
                      </div>
                    )
                  ) : active === "exports" ? (
                    <SchedulesExportCard
                      periodEnd={periodEnd}
                      periodStart={periodMode === "custom" ? periodStart : firstDayOfYear(periodEnd)}
                      comparative={comparative}
                      source={source}
                      comparativeBasis={comparativeBasis}
                    />
                  ) : isLoading ? (
                    <div className="py-16 flex items-center justify-center"><Spinner /></div>
                  ) : error ? (
                    <div className="rounded-2xl p-10 text-center"
                      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
                      <AlertCircle size={28} strokeWidth={1.6} className="mx-auto mb-3" style={{ color: "#9b3d37" }} />
                      <p className="text-sm font-semibold text-theme mb-1">Could not pull statement from QuickBooks</p>
                      <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                        {((error as { message?: string })?.message) ?? "Try a different period or re-sync."}
                      </p>
                    </div>
                  ) : stmt ? (
                    <>
                      {stmt.is_closed && (
                        <div className="inline-flex items-center gap-2 rounded-full px-3 py-1 text-[11px] font-semibold"
                          style={{ background: "var(--green-subtle)", color: "var(--green)", border: "1px solid var(--green)" }}>
                          <Lock size={11} strokeWidth={2} />
                          Books closed for {periodEnd} — final PDF export available
                        </div>
                      )}
                      <KpiStrip stmt={stmt} />
                      <StatementView stmt={stmt} />
                    </>
                  ) : null}
                </motion.div>
              </AnimatePresence>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Master rail — statements + side panels ───────────────────────────────────

function FinancialsRail({ active, onSelect, onHover, isPeriodClosed, periodEnd }: {
  active: RailKey
  onSelect: (key: RailKey) => void
  onHover: (key: Tab) => void
  isPeriodClosed: boolean
  periodEnd: string
}) {
  const statements: { key: RailKey; label: string; icon: typeof BarChart3; sub: string }[] =
    (["is", "bs", "cf"] as Tab[]).map((k) => ({ key: k as RailKey, label: TAB_LABEL[k], icon: TAB_ICON[k], sub: TAB_SUB[k] }))
  const panels: { key: RailKey; label: string; icon: typeof BarChart3; sub: string }[] = [
    ...(isPeriodClosed ? [{ key: "exec" as RailKey, label: "Executive report", icon: Sparkles, sub: "AI-narrated board package" }] : []),
    { key: "exports", label: "Exports & schedules", icon: Table2, sub: "PDF + Excel workpapers" },
  ]
  const chips = [...statements, ...panels]
  return (
    <>
      {/* Desktop: vertical, sticky rail */}
      <nav className="hidden md:flex md:flex-col gap-1 w-60 lg:w-72 shrink-0 md:sticky md:top-2 md:self-start"
        aria-label="Statements and exports">
        <div className="px-2 pb-1 flex items-center justify-between gap-2">
          <span className="text-[10px] font-bold uppercase tracking-wider truncate" style={{ color: "var(--text-muted)" }}>
            As of {formatDate(periodEnd)}
          </span>
          {isPeriodClosed && (
            <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full"
              style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
              <Lock size={9} strokeWidth={2.4} /> Closed
            </span>
          )}
        </div>
        {statements.map((s) => (
          <RailItemFin key={s.key} item={s} active={active === s.key}
            onSelect={() => onSelect(s.key)}
            onHover={() => onHover(s.key as Tab)} />
        ))}
        <div className="h-px my-1.5 mx-2" style={{ background: "var(--border)" }} />
        {panels.map((s) => (
          <RailItemFin key={s.key} item={s} active={active === s.key}
            onSelect={() => onSelect(s.key)} />
        ))}
      </nav>

      {/* Mobile: horizontal scroll strip */}
      <div className="md:hidden -mx-4 px-4 overflow-x-auto" style={{ scrollbarWidth: "none" }}>
        <div className="flex gap-2 pb-1">
          {chips.map((s) => {
            const Icon = s.icon
            const isActive = active === s.key
            return (
              <button key={s.key} onClick={() => onSelect(s.key)}
                className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition-all shrink-0"
                style={{
                  background: isActive ? "var(--green-subtle)" : "var(--surface)",
                  color:      isActive ? "var(--green)"        : "var(--text-2)",
                  border:     `1px solid ${isActive ? "var(--green)" : "var(--border)"}`,
                }}>
                <Icon size={12} strokeWidth={2} />
                {s.label}
              </button>
            )
          })}
        </div>
      </div>
    </>
  )
}

function RailItemFin({ item, active, onSelect, onHover }: {
  item: { key: RailKey; label: string; icon: typeof BarChart3; sub: string }
  active: boolean
  onSelect: () => void
  onHover?: () => void
}) {
  const Icon = item.icon
  return (
    <button onClick={onSelect}
      onMouseEnter={(e) => {
        onHover?.()
        if (!active) (e.currentTarget as HTMLElement).style.background = "var(--surface-2)"
      }}
      onMouseLeave={(e) => { if (!active) (e.currentTarget as HTMLElement).style.background = "transparent" }}
      aria-current={active ? "page" : undefined}
      className="group w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors"
      style={{
        background: active ? "var(--green-subtle)" : "transparent",
        border: `1px solid ${active ? "color-mix(in oklab, var(--green) 35%, transparent)" : "transparent"}`,
      }}
    >
      <span className="h-8 w-8 rounded-lg flex items-center justify-center shrink-0 transition-colors"
        style={{ background: active ? "var(--green)" : "var(--surface-2)", color: active ? "#fff" : "var(--text-2)" }}>
        <Icon size={15} strokeWidth={1.9} />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-[13px] font-semibold truncate"
          style={{ color: active ? "var(--green)" : "var(--text)" }}>{item.label}</span>
        <span className="block text-[11px] truncate" style={{ color: "var(--text-muted)" }}>{item.sub}</span>
      </span>
    </button>
  )
}

// ── KPI strip — visualize-first headline figures for the active statement ─────

function KpiStrip({ stmt }: { stmt: Statement }) {
  const rows = pickHeadlineRows(stmt.rows)
  if (rows.length === 0) return null
  const hasComp = stmt.comparative_label !== null
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {rows.map((r, i) => {
        const cur = parseFloat(r.current ?? "")
        const pri = parseFloat(r.prior ?? "")
        const delta = hasComp && Number.isFinite(cur) && Number.isFinite(pri) && pri !== 0
          ? ((cur - pri) / Math.abs(pri)) * 100
          : null
        const up = delta !== null && delta >= 0
        return (
          <div key={i} className="rounded-2xl p-4"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
            <p className="text-[11px] font-bold uppercase tracking-wider truncate" style={{ color: "var(--text-muted)" }} title={r.label}>
              {r.label}
            </p>
            <p className="text-xl font-bold mt-1 tabular-nums" style={{ color: "var(--text)" }}>
              {fmtMoney(r.current, true)}
            </p>
            {delta !== null && (
              <span className="text-[11px] font-semibold inline-flex items-center gap-0.5 mt-1" style={{ color: "var(--text-muted)" }}>
                {up ? <TrendingUp size={10} strokeWidth={2.4} /> : <TrendingDown size={10} strokeWidth={2.4} />}
                {up ? "+" : ""}{delta.toFixed(1)}% vs {stmt.comparative_label}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── ExecutiveReportCard ──────────────────────────────────────────────────
//
// Prominent bottom-of-page CTA for the AI-narrated executive report.
// Only mounted when the period is closed. Two states: idle (big "Generate"
// button + explainer) and loading (spinner + reassuring copy). Surfaces
// errors inline with a dismiss action.

function ExecutiveReportCard({
  periodLabel, onGenerate, onGenerateClient, loading, error, onDismissError,
  recipientEmail, onRecipientChange, onSend, sending, sendOk, sendError,
}: {
  periodLabel: string
  onGenerate: () => void
  onGenerateClient: () => void
  loading: boolean
  error: string | null
  onDismissError: () => void
  recipientEmail: string
  onRecipientChange: (v: string) => void
  onSend: () => void
  sending: boolean
  sendOk: string | null
  sendError: string | null
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="rounded-2xl overflow-hidden mt-4"
      style={{
        background: "linear-gradient(135deg, rgba(62,143,102,0.10) 0%, var(--surface) 60%)",
        border: "1px solid var(--green)",
        boxShadow: "var(--card-shadow)",
      }}
    >
      <div className="px-5 sm:px-6 py-5 flex items-start gap-4 flex-wrap">
        <div className="h-12 w-12 rounded-xl flex items-center justify-center shrink-0"
          style={{ background: "var(--green)", color: "white" }}>
          <Sparkles size={20} strokeWidth={1.8} />
        </div>
        <div className="flex-1 min-w-[240px]">
          <p className="text-[10px] font-bold uppercase tracking-wider"
            style={{ color: "var(--green)" }}>
            Executive Report · AI-Narrated
          </p>
          <h3 className="text-lg sm:text-xl font-bold text-theme leading-tight mt-0.5">
            One PDF for the boardroom — {periodLabel}
          </h3>
          <p className="text-xs sm:text-sm mt-1.5 max-w-xl" style={{ color: "var(--text-2)" }}>
            A 10+ page close package: the full financial statements, key
            insights with charts, reconciliation summary, flux highlights,
            plus AI-written executive summary, risks, recommendations, and
            forward outlook. Designed to read at a board meeting without
            edits.
          </p>
          <div className="flex items-center gap-3 flex-wrap mt-3 text-[11px]" style={{ color: "var(--text-muted)" }}>
            <span className="inline-flex items-center gap-1">
              <Briefcase size={11} strokeWidth={1.8} /> Financials
            </span>
            <span>·</span>
            <span className="inline-flex items-center gap-1">
              <TrendingUp size={11} strokeWidth={1.8} /> Insights + charts
            </span>
            <span>·</span>
            <span className="inline-flex items-center gap-1">
              <Scale size={11} strokeWidth={1.8} /> Recon summary
            </span>
            <span>·</span>
            <span className="inline-flex items-center gap-1">
              <BarChart3 size={11} strokeWidth={1.8} /> Flux highlights
            </span>
            <span>·</span>
            <span className="inline-flex items-center gap-1">
              <Sparkles size={11} strokeWidth={1.8} style={{ color: "var(--green)" }} />
              AI narrative
            </span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5 ml-auto">
          <Button
            size="sm"
            icon={<Download size={14} strokeWidth={1.8} />}
            loading={loading}
            onClick={onGenerate}
            title="Generate the internal board package PDF — typically takes 10–30 seconds"
          >
            {loading ? "Generating…" : "Board report"}
          </Button>
          <button
            type="button"
            onClick={onGenerateClient}
            disabled={loading}
            className="inline-flex items-center gap-1 text-[11px] font-semibold disabled:opacity-50"
            style={{ color: "var(--green)" }}
            title="Plain-language client edition — drops the GAAP statement tables, keeps the story, charts, and advice"
          >
            <Download size={11} strokeWidth={1.8} /> Client edition
          </button>
          {loading && (
            <p className="text-[10px] italic max-w-[180px] text-right"
              style={{ color: "var(--text-muted)" }}>
              Pulling financials + insights + flux, then asking Claude for
              the narrative. About 10–30 seconds.
            </p>
          )}
        </div>
      </div>

      {/* Books-closed confirmation stamp */}
      <div className="px-5 sm:px-6 py-2 flex items-center gap-2 text-[11px] flex-wrap"
        style={{ borderTop: "1px solid var(--border)", background: "var(--surface-2)" }}>
        <CheckCircle2 size={12} strokeWidth={2} style={{ color: "var(--green)" }} />
        <span style={{ color: "var(--text-muted)" }}>
          Books are closed for {periodLabel} — final report available
          (executive reports are only generated for closed periods).
        </span>
      </div>

      {/* Send the plain-language client edition straight to the client. */}
      <div className="px-5 sm:px-6 py-3 flex items-center gap-2 flex-wrap"
        style={{ borderTop: "1px solid var(--border)" }}>
        <Send size={13} strokeWidth={1.8} style={{ color: "var(--green)" }} />
        <span className="text-[12px] font-medium shrink-0" style={{ color: "var(--text-2)" }}>
          Email the client edition:
        </span>
        <input
          type="email"
          value={recipientEmail}
          onChange={(e) => onRecipientChange(e.target.value)}
          placeholder="client@company.com"
          aria-label="Client email address"
          className="flex-1 min-w-[160px] rounded-md px-2.5 py-1.5 text-sm outline-none"
          style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }}
        />
        <button
          type="button"
          onClick={onSend}
          disabled={sending || !recipientEmail.trim()}
          className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
          style={{ background: "var(--green)" }}
        >
          {sending ? <Spinner className="h-3.5 w-3.5" /> : <Send size={12} strokeWidth={2} />}
          {sending ? "Sending…" : "Send"}
        </button>
        {sendOk && (
          <span className="text-[11px] inline-flex items-center gap-1 shrink-0" style={{ color: "var(--green)" }}>
            <CheckCircle2 size={12} strokeWidth={2.4} /> {sendOk}
          </span>
        )}
        {sendError && (
          <span className="text-[11px] shrink-0" style={{ color: "#9b3d37" }}>{sendError}</span>
        )}
      </div>

      {/* Error banner — sits inside the card so it's clearly tied to
          this action. Auto-cleared on next generate attempt. */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="px-5 sm:px-6 py-3 flex items-start gap-2"
            style={{
              background: "#f7eeec", borderTop: "1px solid #ecd7d3",
              color: "#86332e", overflow: "hidden",
            }}
          >
            <AlertCircle size={13} strokeWidth={1.8} className="shrink-0 mt-0.5" />
            <div className="flex-1 text-xs">
              <p className="font-semibold mb-0.5">Couldn&apos;t generate the report</p>
              <p>{error}</p>
            </div>
            <button onClick={onDismissError}
              className="text-[11px] font-medium hover:underline">
              Dismiss
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

// ── SchedulesExportCard ──────────────────────────────────────────────────
//
// The full GAAP workpaper set, exportable to Excel — one primary "full
// package" action + a grouped list where each schedule downloads on its own.
// Monochrome (neutral theme tokens), consistent with the no-color statements.

function SchedulesExportCard({
  periodEnd, periodStart, comparative, source, comparativeBasis,
}: {
  periodEnd: string
  periodStart: string | undefined
  comparative: boolean
  source: FinancialSource
  comparativeBasis: ComparativeBasis
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  async function run(slug: string) {
    setBusy(slug)
    setErr(null)
    try {
      if (slug === "__full__") {
        await financialsApi.exportFinancialsExcel(periodEnd, periodStart, comparative, source, comparativeBasis)
      } else {
        await financialsApi.exportScheduleExcel(slug, periodEnd, periodStart, comparative, source)
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Export failed")
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="rounded-xl overflow-hidden"
      style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
      {/* Header + full-package action */}
      <div className="px-5 sm:px-6 py-4 flex items-start justify-between gap-3 flex-wrap"
        style={{ borderBottom: "1px solid var(--border)", background: "var(--surface-2)" }}>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Table2 size={16} strokeWidth={1.8} style={{ color: "var(--text-2)" }} />
            <h3 className="text-sm font-bold text-theme">Financial statement schedules</h3>
          </div>
          <p className="text-[11px] mt-0.5" style={{ color: "var(--text-muted)" }}>
            Export to Excel — individually or as one workbook. Built from the selected period and source.
          </p>
        </div>
        <Button size="sm" icon={<Download size={14} strokeWidth={1.8} />}
          loading={busy === "__full__"} onClick={() => run("__full__")}>
          Export full package (.xlsx)
        </Button>
      </div>

      {/* Error stripe */}
      {err && (
        <div className="px-5 sm:px-6 py-2.5 flex items-start gap-2 text-xs"
          style={{ background: "var(--surface-2)", borderBottom: "1px solid var(--border)", color: "var(--text-2)" }}>
          <AlertCircle size={13} strokeWidth={1.8} className="shrink-0 mt-0.5" />
          <span className="flex-1">{err}</span>
          <button onClick={() => setErr(null)} className="font-medium hover:underline shrink-0">Dismiss</button>
        </div>
      )}

      {/* Grouped schedule list */}
      <div className="px-5 sm:px-6 py-4 space-y-4">
        {SCHEDULE_GROUPS.map((group) => {
          const items = FINANCIAL_SCHEDULES.filter((s) => s.group === group)
          if (!items.length) return null
          return (
            <div key={group}>
              <p className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: "var(--text-muted)" }}>
                {group}
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {items.map((s) => (
                  <div key={s.slug}
                    className="flex items-center justify-between gap-3 rounded-lg px-3 py-2"
                    style={{ border: "1px solid var(--border)", background: "var(--surface)" }}>
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-theme truncate">{s.label}</p>
                      <p className="text-[10px] leading-snug" style={{ color: "var(--text-muted)" }}>{s.description}</p>
                    </div>
                    <button onClick={() => run(s.slug)} disabled={busy !== null}
                      className="shrink-0 inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold transition-colors disabled:opacity-50"
                      style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }}
                      title={`Download ${s.label} (.xlsx)`}>
                      {busy === s.slug
                        ? <Spinner className="h-3 w-3" />
                        : <Download size={12} strokeWidth={1.8} />}
                      .xlsx
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── StatementView ─────────────────────────────────────────────────────────

function StatementView({ stmt }: { stmt: Statement }) {
  const hasComparative = stmt.comparative_label !== null
  // One pass up front instead of an O(n²) per-row backward walk (see helper).
  const firstDataFlags = computeFirstDataFlags(stmt.rows)
  return (
    <div className="rounded-xl overflow-hidden"
      style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>

      {/* audit style masthead — BIG company name + statement title + subtitle */}
      <div className="px-8 py-6 text-center"
        style={{ borderBottom: "2px solid var(--text)", background: "var(--surface-2)" }}>
        <h2 style={{
          fontSize: "clamp(22px, 4vw, 28px)", fontWeight: 700,
          letterSpacing: "-0.01em", color: "var(--text)", margin: 0, lineHeight: 1.2,
        }}>
          {stmt.company}
        </h2>
        <p className="mt-2" style={{ fontSize: 15, color: "var(--text)", fontWeight: 500 }}>
          {stmt.title}
        </p>
        <p className="mt-1 italic" style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {stmt.subtitle}
          {hasComparative && <> · with {stmt.comparative_label} comparative</>}
        </p>
      </div>

      {/* Integrity banner (Phase 2 trust sweep) — when the period's snapshot
          fails a statement-integrity check, warn loudly and mark the statement
          do-not-distribute. Exports are watermarked DRAFT until resolved. */}
      {stmt.validation && !stmt.validation.balanced && (
        <div className="px-8 py-3 text-xs"
          style={{ background: "#f7eeec", color: "#86332e", borderBottom: "1px solid #ecd7d3" }}>
          <p className="font-bold uppercase tracking-wide text-[11px]">
            Does not balance — do not distribute
          </p>
          {stmt.validation.messages.map((m, i) => (
            <p key={i} className="mt-1">{m}</p>
          ))}
          <p className="mt-1 italic">
            Exports are watermarked DRAFT until resolved — re-sync from QuickBooks to refresh the data.
          </p>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border-strong)" }}>
              <th className="text-left px-6 py-3 text-[10px] font-bold uppercase tracking-wide"
                style={{ color: "var(--text)" }}>
                Account
              </th>
              <th className="text-right px-6 py-3 text-[10px] font-bold uppercase tracking-wide"
                style={{ color: "var(--text)", width: 150 }}>
                {stmt.period_label}
              </th>
              {hasComparative && (
                <th className="text-right px-6 py-3 text-[10px] font-bold uppercase tracking-wide"
                  style={{ color: "var(--text)", width: 150 }}>
                  {stmt.comparative_label}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {stmt.rows.map((r, i) => (
              <Row key={i} row={r} hasComparative={hasComparative} firstDataInSection={firstDataFlags[i]} />
            ))}
          </tbody>
        </table>
      </div>

      {/* Notes footer */}
      {stmt.notes.length > 0 && (
        <div className="px-8 py-3 text-[11px] italic"
          style={{ borderTop: "1px solid var(--border)", color: "var(--text-muted)" }}>
          {stmt.notes.map((n, i) => <p key={i}>Note: {n}</p>)}
        </div>
      )}
    </div>
  )
}

/**
 * "First data row after a section header" flags for a whole statement, in a
 * single O(n) pass. Decides whether to stamp a $ on the value (audit
 * convention: only the first row of a section + totals carry the $). Computed
 * once per render instead of walking backwards for every row — the old per-row
 * lookup was O(n²) and caused a visible hang rendering 300–400-row statements.
 */
const SECTION_BOUNDARY = new Set(["section_header", "total", "subtotal", "computed", "grand_total"])
function computeFirstDataFlags(rows: FinancialRow[]): boolean[] {
  const flags = new Array<boolean>(rows.length).fill(false)
  let sawDataSinceBoundary = false
  for (let i = 0; i < rows.length; i++) {
    const k = rows[i].kind
    if (k === "data") {
      flags[i] = !sawDataSinceBoundary
      sawDataSinceBoundary = true
    } else if (SECTION_BOUNDARY.has(k)) {
      sawDataSinceBoundary = false
    }
    // other kinds (spacers/notes) are transparent — they don't reset the flag
  }
  return flags
}

function Row({ row, hasComparative, firstDataInSection }:
  { row: FinancialRow; hasComparative: boolean; firstDataInSection: boolean }
) {
  // section_header — uppercase navy, no values, breathing room
  if (row.kind === "section_header") {
    return (
      <tr style={{ background: "var(--surface-2)" }}>
        <td colSpan={hasComparative ? 3 : 2}
          className="px-6 pt-5 pb-1 text-[11px] font-bold uppercase tracking-widest"
          style={{ color: "var(--text)" }}>
          {row.label}
        </td>
      </tr>
    )
  }

  // grand_total — Net Income / Total Assets / Total L+E etc.
  if (row.kind === "grand_total") {
    return (
      <tr style={{
        borderTop: "1px solid var(--text)",
        borderBottom: "3px double var(--text)",
        background: "var(--surface-2)",
      }}>
        <td className="px-6 py-3 text-sm font-bold" style={{ color: "var(--text)" }}>
          {row.label}
        </td>
        <td className="px-6 py-3 text-right text-sm font-bold tabular-nums" style={{ color: "var(--text)" }}>
          {fmtMoney(row.current, true)}
        </td>
        {hasComparative && (
          <td className="px-6 py-3 text-right text-sm font-bold tabular-nums" style={{ color: "var(--text)" }}>
            {fmtMoney(row.prior, true)}
          </td>
        )}
      </tr>
    )
  }

  // total / subtotal / computed — bold + top rule
  if (row.kind === "total" || row.kind === "subtotal" || row.kind === "computed") {
    return (
      <tr>
        <td className="px-6 py-2 text-sm font-bold" style={{
          color: "var(--text)",
          paddingLeft: 24 + row.level * 16,
          borderTop: "1px solid var(--border-strong)",
        }}>
          {row.label}
        </td>
        <td className="px-6 py-2 text-right tabular-nums text-sm font-bold" style={{
          color: "var(--text)",
          borderTop: "1px solid var(--border-strong)",
        }}>
          {fmtMoney(row.current, true)}
        </td>
        {hasComparative && (
          <td className="px-6 py-2 text-right tabular-nums text-sm font-bold" style={{
            color: "var(--text)",
            borderTop: "1px solid var(--border-strong)",
          }}>
            {fmtMoney(row.prior, true)}
          </td>
        )}
      </tr>
    )
  }

  // data row — indented per level
  return (
    <tr>
      <td className="px-6 py-1.5 text-sm" style={{
        color: "var(--text-2)",
        paddingLeft: 24 + row.level * 16,
      }}>
        {row.label}
      </td>
      <td className="px-6 py-1.5 text-right tabular-nums" style={{
        color: "var(--text)",
      }}>
        {fmtMoney(row.current, firstDataInSection)}
      </td>
      {hasComparative && (
        <td className="px-6 py-1.5 text-right tabular-nums" style={{
          color: "var(--text-2)",
        }}>
          {fmtMoney(row.prior, firstDataInSection)}
        </td>
      )}
    </tr>
  )
}

// ── ExportButton ──────────────────────────────────────────────────────────

function ExportButton({ isClosed, onExport, loading }: {
  isClosed: boolean
  onExport: (kind: "is" | "bs" | "cf" | "full", draft: boolean) => void
  loading: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    function h(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener("mousedown", h)
    return () => document.removeEventListener("mousedown", h)
  }, [open])

  const stampLabel = isClosed ? "FINAL" : "DRAFT"
  const stampColor = isClosed ? "var(--green)" : "#8a6326"
  const stampBg    = isClosed ? "var(--green-subtle)" : "rgba(199, 154, 82, 0.12)"

  return (
    <div ref={ref} className="relative">
      <Button size="sm" onClick={() => setOpen(!open)}
        icon={<Download size={14} strokeWidth={1.8} />}
        loading={loading}>
        Export PDF
      </Button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.96 }}
            animate={{ opacity: 1, y: 0,  scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.96 }}
            transition={{ duration: 0.12, ease: "easeOut" }}
            className="absolute right-0 top-full mt-1.5 z-50 rounded-xl overflow-hidden min-w-[280px] origin-top-right"
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border-strong)",
              boxShadow: "0 12px 32px -8px rgba(0,0,0,0.30), 0 2px 6px -2px rgba(0,0,0,0.10)",
            }}>
            {/* Header — explicit Draft vs Final framing with a
                visible stamp so the user knows what they're about
                to download. */}
            <div className="px-4 py-2.5 flex items-center justify-between"
              style={{ borderBottom: "1px solid var(--border)", background: "var(--surface-2)" }}>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wider"
                  style={{ color: "var(--text-muted)" }}>
                  Download
                </p>
                <p className="text-xs font-semibold text-theme mt-0.5">
                  {isClosed ? "Audit-final PDF" : "Working draft PDF"}
                </p>
              </div>
              <span className="inline-flex items-center rounded px-2 py-0.5 text-[9px] font-bold tracking-widest"
                style={{ background: stampBg, color: stampColor }}>
                {stampLabel}
              </span>
            </div>

            {/* Primary action — full package, prominent */}
            <button
              onClick={() => { onExport("full", !isClosed); setOpen(false) }}
              className="w-full text-left px-4 py-3 transition-colors flex items-start gap-3"
              style={{ background: "transparent" }}
              onMouseEnter={(e) => (e.currentTarget as HTMLElement).style.background = "var(--green-subtle)"}
              onMouseLeave={(e) => (e.currentTarget as HTMLElement).style.background = "transparent"}
            >
              <span className="h-8 w-8 rounded-lg flex items-center justify-center shrink-0"
                style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
                <Layers size={15} strokeWidth={1.8} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-theme">Full financial statements</p>
                <p className="text-[11px] mt-0.5" style={{ color: "var(--text-muted)" }}>
                  All 3 statements bundled into one PDF
                </p>
              </div>
              <Download size={12} strokeWidth={1.8}
                style={{ color: "var(--text-muted)" }} className="shrink-0 mt-1.5" />
            </button>

            {/* Section divider */}
            <div className="px-4 py-1.5 text-[9px] font-bold uppercase tracking-wider"
              style={{ background: "var(--surface-2)", color: "var(--text-muted)", borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)" }}>
              Or download one statement
            </div>

            {/* Individual statements */}
            {([
              { key: "is", label: "Income Statement", sub: TAB_SUB.is, Icon: TrendingUp },
              { key: "bs", label: "Balance Sheet",    sub: TAB_SUB.bs, Icon: Scale },
              { key: "cf", label: "Cash Flow",        sub: TAB_SUB.cf, Icon: BarChart3 },
            ] as const).map((opt) => (
              <button key={opt.key}
                onClick={() => { onExport(opt.key, !isClosed); setOpen(false) }}
                className="w-full text-left px-4 py-2.5 transition-colors flex items-center gap-3"
                style={{ background: "transparent" }}
                onMouseEnter={(e) => (e.currentTarget as HTMLElement).style.background = "var(--surface-2)"}
                onMouseLeave={(e) => (e.currentTarget as HTMLElement).style.background = "transparent"}
              >
                <opt.Icon size={13} strokeWidth={1.8}
                  style={{ color: "var(--text-muted)" }} className="shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-theme">{opt.label}</p>
                  <p className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                    {opt.sub}
                  </p>
                </div>
              </button>
            ))}

            {/* Draft note */}
            {!isClosed && (
              <p className="px-4 py-2 text-[10px] italic"
                style={{ color: "var(--text-muted)", background: "var(--surface-2)", borderTop: "1px solid var(--border)" }}>
                Draft PDFs carry a DRAFT watermark. Close the books for this period to download finals.
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
