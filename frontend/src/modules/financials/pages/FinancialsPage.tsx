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
import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { useMutation, useQuery } from "@tanstack/react-query"
import { motion, AnimatePresence } from "framer-motion"
import {
  ArrowLeft,
  Download,
  FileText,
  Lock,
  AlertCircle,
} from "lucide-react"
import { Button, Spinner } from "@/core/ui/components"
import { financialsApi, type Statement, type FinancialRow } from "@/modules/financials/api"
import { useQboConnection } from "@/modules/flux/hooks"

type Tab = "is" | "bs" | "cf"

function defaultPeriodEnd(): string {
  const d = new Date(); d.setDate(0)
  return d.toISOString().slice(0, 10)
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

export function FinancialsPage() {
  const navigate = useNavigate()
  const [tab, setTab]                 = useState<Tab>("is")
  const [periodEnd, setPeriodEnd]     = useState<string>(defaultPeriodEnd())
  const [comparative, setComparative] = useState<boolean>(true)
  const [exportError, setExportError] = useState<string | null>(null)

  const { data: qbo } = useQboConnection()
  const { data: stmt, isLoading, error } = useQuery({
    queryKey: ["financial-statement", tab, periodEnd, comparative],
    queryFn:  () => {
      if (tab === "is") return financialsApi.getIncomeStatement(periodEnd, comparative)
      if (tab === "bs") return financialsApi.getBalanceSheet(periodEnd, comparative)
      return financialsApi.getCashFlow(periodEnd, comparative)
    },
    enabled:  !!qbo,
    staleTime: 60_000,
  })

  const exportMut = useMutation({
    mutationFn: ({ kind, draft }: { kind: "is" | "bs" | "cf" | "full"; draft: boolean }) =>
      financialsApi.exportPdf(kind, periodEnd, comparative, draft),
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
              Big-4 styled Income Statement, Balance Sheet, and Statement of Cash Flows —
              pulled live from QuickBooks and translated to US GAAP labels.
              {" "}Export a final PDF once the period is closed, or a DRAFT for preview.
            </p>
          </div>
          <div className="flex items-end gap-2 flex-wrap">
            <label className="flex flex-col">
              <span className="text-[10px] font-semibold uppercase tracking-wide mb-1" style={{ color: "var(--text-muted)" }}>
                As of
              </span>
              <input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)}
                className="rounded-lg px-3 py-1.5 text-sm outline-none"
                style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }} />
            </label>
            <label className="flex items-center gap-1.5 text-xs cursor-pointer select-none mb-1.5"
              style={{ color: "var(--text-2)" }}>
              <input type="checkbox" checked={comparative} onChange={(e) => setComparative(e.target.checked)} />
              Show prior year
            </label>
            <ExportButton
              isClosed={stmt?.is_closed ?? false}
              onExport={(kind, draft) => exportMut.mutate({ kind, draft })}
              loading={exportMut.isPending}
            />
          </div>
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

        {/* Tabs */}
        <div className="flex items-center gap-1 flex-wrap rounded-lg p-1 w-fit"
          style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
          {(Object.entries(TAB_LABEL) as [Tab, string][]).map(([key, label]) => {
            const active = tab === key
            return (
              <button key={key} onClick={() => setTab(key)}
                className="rounded-md px-3 py-1 text-xs font-medium transition-all"
                style={{
                  background: active ? "var(--surface)" : "transparent",
                  color:      active ? "var(--text)"    : "var(--text-muted)",
                  border:     active ? "1px solid var(--border-strong)" : "1px solid transparent",
                }}>
                {label}
              </button>
            )
          })}
        </div>

        {/* Closed pill */}
        {stmt?.is_closed && (
          <div className="inline-flex items-center gap-2 rounded-full px-3 py-1 text-[11px] font-semibold"
            style={{ background: "var(--green-subtle)", color: "var(--green)", border: "1px solid var(--green)" }}>
            <Lock size={11} strokeWidth={2} />
            Books closed for {periodEnd} — final PDF export available
          </div>
        )}

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

      {/* Big-4 style masthead — BIG company name + statement title + subtitle */}
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
 * stamp a $ on the value. Big-4 convention: only first row of a section
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
  return (
    <div className="relative">
      <Button size="sm" onClick={() => setOpen(!open)}
        icon={<Download size={14} strokeWidth={1.8} />}
        loading={loading}>
        Export PDF
      </Button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-20 rounded-md p-1 min-w-[260px] shadow-lg"
          style={{ background: "var(--surface)", border: "1px solid var(--border-strong)" }}>
          <div className="px-3 py-2 text-[10px] font-bold uppercase tracking-wide"
            style={{ color: "var(--text-muted)", borderBottom: "1px solid var(--border)" }}>
            {isClosed ? "Final (books closed)" : "DRAFT — books not yet closed"}
          </div>
          {[
            { key: "full", label: "Full package (IS + BS + CF)" },
            { key: "is",   label: "Income Statement only" },
            { key: "bs",   label: "Balance Sheet only" },
            { key: "cf",   label: "Cash Flow Statement only" },
          ].map((opt) => (
            <button key={opt.key}
              onClick={() => { onExport(opt.key as "is" | "bs" | "cf" | "full", !isClosed); setOpen(false) }}
              className="w-full text-left px-3 py-2 text-xs rounded transition-colors hover:bg-[var(--surface-2)] inline-flex items-center gap-2"
              style={{ color: "var(--text)" }}>
              <FileText size={12} strokeWidth={1.8} style={{ color: "var(--text-muted)" }} />
              {opt.label}
            </button>
          ))}
          {!isClosed && (
            <p className="px-3 py-2 text-[10px] italic"
              style={{ color: "var(--text-muted)", borderTop: "1px solid var(--border)" }}>
              DRAFT PDFs carry a 45° watermark. Close the period in Reconciliations
              to remove it.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
