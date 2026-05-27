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
import { useMutation, useQuery } from "@tanstack/react-query"
import { motion, AnimatePresence } from "framer-motion"
import {
  ArrowLeft,
  Download,
  FileText,
  Lock,
  AlertCircle,
  BarChart3,
  Scale,
  TrendingUp,
  Layers,
  Calendar,
} from "lucide-react"
import { Button, Spinner } from "@/core/ui/components"
import { DatePicker } from "@/core/ui/DatePicker"
import { financialsApi, type Statement, type FinancialRow, type FinancialSource } from "@/modules/financials/api"
import { useQboConnection } from "@/modules/flux/hooks"

type Tab = "is" | "bs" | "cf"

function defaultPeriodEnd(): string {
  const d = new Date(); d.setDate(0)
  return d.toISOString().slice(0, 10)
}

/** Last-day-of-month helper for the quick-period chips. */
function lastDayOfMonth(year: number, month: number): string {
  // month is 1-12; new Date(y, m, 0) returns day 0 of next month = last of current
  const d = new Date(year, month, 0)
  return d.toISOString().slice(0, 10)
}

/** Quick-period options driven off "today" — match the period selector
 *  to the most common accounting cuts. */
function quickPeriods(): { key: string; label: string; period: string }[] {
  const today = new Date()
  const y = today.getFullYear()
  const m = today.getMonth() + 1  // 1-12
  // Last completed month
  const lastMonth = m === 1
    ? { y: y - 1, m: 12 }
    : { y, m: m - 1 }
  // Last completed quarter
  const quarterEndMonth = (Math.floor((m - 1) / 3)) * 3   // 0, 3, 6, 9
  const lastQuarter = quarterEndMonth === 0
    ? { y: y - 1, m: 12 }
    : { y, m: quarterEndMonth }
  // YTD = end of last completed month within the current fiscal year
  // (treat calendar year for simplicity — most SMBs run on calendar)
  return [
    { key: "lm",  label: "Last month",   period: lastDayOfMonth(lastMonth.y, lastMonth.m) },
    { key: "lq",  label: "Last quarter", period: lastDayOfMonth(lastQuarter.y, lastQuarter.m) },
    { key: "ytd", label: "YTD",          period: lastDayOfMonth(lastMonth.y, lastMonth.m) },
    { key: "ly",  label: "Last year",    period: lastDayOfMonth(y - 1, 12) },
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

export function FinancialsPage() {
  const navigate = useNavigate()
  const [tab, setTab]                 = useState<Tab>("is")
  const [periodEnd, setPeriodEnd]     = useState<string>(defaultPeriodEnd())
  const [comparative, setComparative] = useState<boolean>(true)
  // Default to Nordavix synced data — works offline + respects the
  // user's manual reconciliation overrides. Users can flip back to
  // Live QuickBooks if they want to verify against QBO's own reports.
  const [source, setSource]           = useState<FinancialSource>("nordavix")
  const [exportError, setExportError] = useState<string | null>(null)
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

  const { data: stmt, isLoading, error, refetch } = useQuery({
    queryKey: ["financial-statement", tab, periodEnd, comparative, effectiveSource],
    queryFn:  () => {
      if (tab === "is") return financialsApi.getIncomeStatement(periodEnd, comparative, effectiveSource)
      if (tab === "bs") return financialsApi.getBalanceSheet(periodEnd, comparative, effectiveSource)
      return financialsApi.getCashFlow(periodEnd, comparative, effectiveSource)
    },
    // Nordavix mode reads from our DB so QBO connection isn't strictly
    // required (snapshot may exist from past syncs even after disconnect).
    // CF always needs QBO regardless of source selection.
    enabled:  hasLoaded && (effectiveSource === "nordavix" || !!qbo),
    staleTime: 60_000,
  })

  const exportMut = useMutation({
    mutationFn: ({ kind, draft }: { kind: "is" | "bs" | "cf" | "full"; draft: boolean }) =>
      financialsApi.exportPdf(kind, periodEnd, comparative, draft, source),
    onMutate: () => setExportError(null),
    onError: (e: Error) => setExportError(e.message),
  })

  return (
    <div className="flex flex-col h-full overflow-y-auto" style={{ background: "var(--bg)" }}>
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}
        className="px-4 sm:px-8 pt-6 pb-4"
        style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <button onClick={() => navigate("/app")}
              className="inline-flex items-center gap-1 text-[11px] font-medium mb-2 transition-opacity hover:opacity-70"
              style={{ color: "var(--text-muted)" }}>
              <ArrowLeft size={12} strokeWidth={2} /> Back to dashboard
            </button>
            <h1 style={{
              fontSize: "clamp(20px, 4vw, 24px)", fontWeight: 700,
              letterSpacing: "-0.01em", color: "var(--text)", margin: 0,
            }}>
              Financial Package
            </h1>
            <p className="text-xs sm:text-sm mt-1.5" style={{ color: "var(--text-muted)" }}>
              Audit-ready Income Statement, Balance Sheet, and Statement of Cash Flows.
              {" "}<b>Nordavix synced</b> source builds from GL snapshots captured during
              reconciliation work — works offline, respects manual overrides.
              {" "}<b>QuickBooks live</b> calls QBO reports directly. Cash Flow always uses QBO.
            </p>
          </div>
          <div className="flex items-end gap-2 flex-wrap">
            <div className="flex flex-col">
              <span className="text-[10px] font-semibold uppercase tracking-wide mb-1" style={{ color: "var(--text-muted)" }}>
                As of
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
              Show prior year
            </label>
            {hasLoaded ? (
              <Button size="sm" variant="outline" onClick={() => refetch()}
                loading={isLoading}>
                Reload
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
        </div>

        {/* Quick-period chips — one-click presets so the user doesn't
            have to click into the date picker for the most common
            cuts (last month / quarter / YTD / last year). Period
            highlights when it matches the selected date. */}
        <div className="mt-3 flex items-center gap-1.5 flex-wrap">
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide mr-1"
            style={{ color: "var(--text-muted)" }}>
            <Calendar size={10} strokeWidth={1.8} />
            Quick
          </span>
          {quickPeriods().map((q) => {
            const active = q.period === periodEnd
            return (
              <button
                key={q.key}
                onClick={() => setPeriodEnd(q.period)}
                className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors"
                style={{
                  background: active ? "var(--green-subtle)" : "var(--surface-2)",
                  color:      active ? "var(--green)"        : "var(--text-2)",
                  border:     `1px solid ${active ? "var(--green)" : "var(--border)"}`,
                }}
                title={`Set period to ${q.period}`}
              >
                {q.label}
              </button>
            )
          })}
        </div>
      </motion.div>

      <div className="flex-1 px-4 sm:px-8 py-5 max-w-5xl w-full mx-auto space-y-4">

        {/* Export error */}
        <AnimatePresence>
          {exportError && (
            <motion.div
              initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
              className="rounded-lg px-4 py-3 flex items-start gap-2"
              style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", overflow: "hidden" }}>
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
            style={{ background: "#fef3c7", border: "1px solid #f59e0b" }}>
            <AlertCircle size={18} style={{ color: "#92400e" }} className="shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-semibold" style={{ color: "#92400e" }}>QuickBooks isn&apos;t connected</p>
              <p className="text-xs mt-0.5" style={{ color: "#92400e" }}>
                Financial statements are pulled live from QuickBooks reports.
              </p>
            </div>
            <Button size="sm" onClick={() => navigate("/app/connections")}>Connect</Button>
          </div>
        )}

        {/* Initial gate — explicit Load before any QBO pull */}
        {!hasLoaded ? (
          <div className="rounded-xl p-10 text-center"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
            <div className="h-14 w-14 mx-auto rounded-full flex items-center justify-center mb-4"
              style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
              <FileText size={26} strokeWidth={1.6} />
            </div>
            <p className="text-base font-semibold text-theme mb-1">Choose a period to load</p>
            <p className="text-sm max-w-md mx-auto mb-5" style={{ color: "var(--text-muted)" }}>
              Pick the period-end date above (and whether to include a prior-year
              comparative). Click <b>Load financials</b> to pull the statements live
              from QuickBooks.
            </p>
            <Button size="sm" onClick={() => setHasLoaded(true)} disabled={!qbo}>
              Load financials
            </Button>
          </div>
        ) : (
          <>
            {/* Sticky statement switcher — sits at the top of the
                scroll area so the user always sees which statement is
                active + can flip between IS/BS/CF without scrolling
                back. Bigger touch targets than the previous pill tabs,
                each with a subtitle that previews the contents. */}
            <div className="sticky top-0 z-20 -mx-4 sm:-mx-8 px-4 sm:px-8 pt-1 pb-3"
              style={{ background: "var(--bg)" }}>
              <div className="rounded-xl overflow-hidden grid grid-cols-3"
                style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
                {(Object.entries(TAB_LABEL) as [Tab, string][]).map(([key, label]) => {
                  const active = tab === key
                  const Icon = TAB_ICON[key]
                  return (
                    <button key={key} onClick={() => setTab(key)}
                      className="px-4 py-3 text-left transition-all relative"
                      style={{
                        background: active ? "var(--green-subtle)" : "var(--surface)",
                        borderRight: key !== "cf" ? "1px solid var(--border)" : undefined,
                        cursor: "pointer",
                      }}
                      onMouseEnter={(e) => { if (!active) (e.currentTarget as HTMLElement).style.background = "var(--surface-2)" }}
                      onMouseLeave={(e) => { if (!active) (e.currentTarget as HTMLElement).style.background = "var(--surface)" }}
                    >
                      <div className="flex items-center gap-2">
                        <Icon size={14} strokeWidth={1.8}
                          style={{ color: active ? "var(--green)" : "var(--text-muted)" }} />
                        <span className="text-sm font-semibold"
                          style={{ color: active ? "var(--green)" : "var(--text)" }}>
                          {label}
                        </span>
                      </div>
                      <p className="text-[10px] mt-0.5 hidden sm:block"
                        style={{ color: "var(--text-muted)" }}>
                        {TAB_SUB[key]}
                      </p>
                      {/* Active underline */}
                      {active && (
                        <span className="absolute left-0 right-0 bottom-0 h-0.5"
                          style={{ background: "var(--green)" }} />
                      )}
                    </button>
                  )
                })}
              </div>

              {/* Closed pill — relocated under the tabs so it stays
                  visible with them while scrolling. */}
              {stmt?.is_closed && (
                <div className="mt-2 inline-flex items-center gap-2 rounded-full px-3 py-1 text-[11px] font-semibold"
                  style={{ background: "var(--green-subtle)", color: "var(--green)", border: "1px solid var(--green)" }}>
                  <Lock size={11} strokeWidth={2} />
                  Books closed for {periodEnd} — final PDF export available
                </div>
              )}
            </div>

            {/* Statement body */}
            {isLoading ? (
              <div className="py-16 flex items-center justify-center"><Spinner /></div>
            ) : error ? (
              <div className="rounded-xl p-10 text-center"
                style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
                <AlertCircle size={28} strokeWidth={1.6} className="mx-auto mb-3" style={{ color: "#dc2626" }} />
                <p className="text-sm font-semibold text-theme mb-1">Could not pull statement from QuickBooks</p>
                <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                  {((error as { message?: string })?.message) ?? "Try a different period or re-sync."}
                </p>
              </div>
            ) : stmt ? (
              <StatementView stmt={stmt} />
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}

// ── StatementView ─────────────────────────────────────────────────────────

function StatementView({ stmt }: { stmt: Statement }) {
  const hasComparative = stmt.comparative_label !== null
  return (
    <div className="rounded-xl overflow-hidden"
      style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>

      {/* audit style masthead — BIG company name + statement title + subtitle */}
      <div className="px-8 py-6 text-center"
        style={{ borderBottom: "2px solid #1f3a5f", background: "var(--surface-2)" }}>
        <h2 style={{
          fontSize: "clamp(22px, 4vw, 28px)", fontWeight: 700,
          letterSpacing: "-0.01em", color: "#1f3a5f", margin: 0, lineHeight: 1.2,
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

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border-strong)" }}>
              <th className="text-left px-6 py-3 text-[10px] font-bold uppercase tracking-wide"
                style={{ color: "#1f3a5f" }}>
                Account
              </th>
              <th className="text-right px-6 py-3 text-[10px] font-bold uppercase tracking-wide"
                style={{ color: "#1f3a5f", width: 150 }}>
                {stmt.period_label}
              </th>
              {hasComparative && (
                <th className="text-right px-6 py-3 text-[10px] font-bold uppercase tracking-wide"
                  style={{ color: "#1f3a5f", width: 150 }}>
                  {stmt.comparative_label}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {stmt.rows.map((r, i) => (
              <Row key={i} row={r} hasComparative={hasComparative} firstDataInSection={isFirstDataInSection(stmt.rows, i)} />
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
 * "First data row after a section header" — used to decide whether to
 * stamp a $ on the value. audit convention: only first row of a section
 * + totals carry the $ symbol.
 */
function isFirstDataInSection(rows: FinancialRow[], idx: number): boolean {
  if (rows[idx].kind !== "data") return false
  for (let i = idx - 1; i >= 0; i--) {
    const k = rows[i].kind
    if (k === "data") return false
    if (k === "section_header" || k === "total" || k === "subtotal" || k === "computed" || k === "grand_total") return true
  }
  return true
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
          style={{ color: "#1f3a5f" }}>
          {row.label}
        </td>
      </tr>
    )
  }

  // grand_total — Net Income / Total Assets / Total L+E etc.
  if (row.kind === "grand_total") {
    return (
      <tr style={{
        borderTop: "1px solid #1f3a5f",
        borderBottom: "3px double #1f3a5f",
        background: "rgba(31, 58, 95, 0.04)",
      }}>
        <td className="px-6 py-3 text-sm font-bold" style={{ color: "#1f3a5f" }}>
          {row.label}
        </td>
        <td className="px-6 py-3 text-right text-sm font-bold tabular-nums" style={{ color: "#1f3a5f" }}>
          {fmtMoney(row.current, true)}
        </td>
        {hasComparative && (
          <td className="px-6 py-3 text-right text-sm font-bold tabular-nums" style={{ color: "#1f3a5f" }}>
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
          color: row.current && parseFloat(row.current) < 0 ? "#dc2626" : "var(--text)",
          borderTop: "1px solid var(--border-strong)",
        }}>
          {fmtMoney(row.current, true)}
        </td>
        {hasComparative && (
          <td className="px-6 py-2 text-right tabular-nums text-sm font-bold" style={{
            color: row.prior && parseFloat(row.prior) < 0 ? "#dc2626" : "var(--text)",
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
        color: row.current && parseFloat(row.current) < 0 ? "#dc2626" : "var(--text)",
      }}>
        {fmtMoney(row.current, firstDataInSection)}
      </td>
      {hasComparative && (
        <td className="px-6 py-1.5 text-right tabular-nums" style={{
          color: row.prior && parseFloat(row.prior) < 0 ? "#dc2626" : "var(--text-2)",
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
  const stampColor = isClosed ? "var(--green)" : "#b45309"
  const stampBg    = isClosed ? "var(--green-subtle)" : "rgba(245, 158, 11, 0.12)"

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
            className="absolute right-0 top-full mt-1.5 z-20 rounded-xl overflow-hidden min-w-[280px] origin-top-right"
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
                <p className="text-sm font-semibold text-theme">Full financial package</p>
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
