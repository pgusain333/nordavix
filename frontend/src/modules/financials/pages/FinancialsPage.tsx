/**
 * Financial Package — Income Statement / Balance Sheet / Cash Flow.
 *
 * Layout:
 *   [Header]   Title + period selector + Comparative toggle + Export
 *   [Tabs]     Income Statement / Balance Sheet / Cash Flow
 *   [Statement] Big-4 styled table with section headers, indented
 *               rows, italic subtotals, bolded grand-total footer
 *
 * Export PDF is enabled only when the books for the selected period
 * are closed (reconciliations Close Period). The PDF is rendered
 * server-side via reportlab in a Big-4 audit style — cover page,
 * navy accent, Helvetica, proper number formatting.
 */
import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { useMutation, useQuery } from "@tanstack/react-query"
import { motion } from "framer-motion"
import {
  ArrowLeft,
  Download,
  FileText,
  Lock,
  AlertCircle,
} from "lucide-react"
import { Button, Spinner } from "@/core/ui/components"
import { financialsApi, type Statement, type StatementKind } from "@/modules/financials/api"
import { useQboConnection } from "@/modules/flux/hooks"

type Tab = "is" | "bs" | "cf"

function defaultPeriodEnd(): string {
  const d = new Date(); d.setDate(0)
  return d.toISOString().slice(0, 10)
}

function fmtMoney(s: string | null | undefined): string {
  if (s === null || s === undefined || s === "") return ""
  const n = parseFloat(s)
  if (!Number.isFinite(n)) return ""
  if (n === 0) return "—"
  const abs = `$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
  return n < 0 ? `(${abs})` : abs
}

const TAB_META: Record<Tab, { kind: StatementKind; label: string }> = {
  is: { kind: "income_statement", label: "Income Statement" },
  bs: { kind: "balance_sheet",    label: "Balance Sheet"    },
  cf: { kind: "cash_flow",        label: "Cash Flow"        },
}

export function FinancialsPage() {
  const navigate = useNavigate()
  const [tab, setTab]               = useState<Tab>("is")
  const [periodEnd, setPeriodEnd]   = useState<string>(defaultPeriodEnd())
  const [comparative, setComparative] = useState<boolean>(true)

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
    mutationFn: (stmtKey: "is" | "bs" | "cf" | "full") =>
      financialsApi.exportPdf(stmtKey, periodEnd, comparative),
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
              Income Statement, Balance Sheet, and Cash Flow Statement pulled live
              from QuickBooks. Export a Big-4 styled PDF once the period is closed.
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
              periodEnd={periodEnd}
              isClosed={stmt?.is_closed ?? false}
              onExport={(kind) => exportMut.mutate(kind)}
              loading={exportMut.isPending}
            />
          </div>
        </div>
      </motion.div>

      <div className="flex-1 px-4 sm:px-8 py-5 max-w-6xl w-full mx-auto space-y-4">

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
          {(Object.entries(TAB_META) as [Tab, typeof TAB_META[Tab]][]).map(([key, m]) => {
            const active = tab === key
            return (
              <button key={key} onClick={() => setTab(key)}
                className="inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-all"
                style={{
                  background: active ? "var(--surface)" : "transparent",
                  color:      active ? "var(--text)"    : "var(--text-muted)",
                  border:     active ? "1px solid var(--border-strong)" : "1px solid transparent",
                }}>
                {m.label}
              </button>
            )
          })}
        </div>

        {/* Closed banner — visual indicator that the user is looking at a frozen snapshot */}
        {stmt?.is_closed && (
          <div className="inline-flex items-center gap-2 rounded-full px-3 py-1 text-[11px] font-semibold"
            style={{ background: "var(--green-subtle)", color: "var(--green)", border: "1px solid var(--green)" }}>
            <Lock size={11} strokeWidth={2} />
            Books closed for {periodEnd} — PDF export is available
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

      {/* Statement masthead */}
      <div className="px-6 py-4 text-center"
        style={{ borderBottom: "2px solid #1f3a5f", background: "var(--surface-2)" }}>
        <p className="text-[10px] font-bold uppercase tracking-wider" style={{ color: "#1f3a5f" }}>
          {stmt.company}
        </p>
        <h2 className="text-lg sm:text-xl font-bold mt-1 text-theme">{stmt.title}</h2>
        <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
          {stmt.period_label}
          {stmt.comparative_label && <> · with {stmt.comparative_label} comparative</>}
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
                {stmt.period_label.replace("YTD ", "").replace("As of ", "")}
              </th>
              {hasComparative && (
                <th className="text-right px-6 py-3 text-[10px] font-bold uppercase tracking-wide"
                  style={{ color: "#1f3a5f", width: 150 }}>
                  {stmt.comparative_label?.replace("YTD ", "").replace("As of ", "")}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {stmt.sections.map((section) => (
              <SectionBlock key={section.name} section={section} hasComparative={hasComparative} />
            ))}
            {stmt.footer && (
              <tr style={{
                borderTop: "1px solid #1f3a5f",
                borderBottom: "3px double #1f3a5f",
                background: "rgba(31, 58, 95, 0.04)",
              }}>
                <td className="px-6 py-3 text-sm font-bold" style={{ color: "#1f3a5f" }}>
                  {stmt.footer.label}
                </td>
                <td className="px-6 py-3 text-right text-sm font-bold tabular-nums" style={{ color: "#1f3a5f" }}>
                  {fmtMoney(stmt.footer.current)}
                </td>
                {hasComparative && (
                  <td className="px-6 py-3 text-right text-sm font-bold tabular-nums" style={{ color: "#1f3a5f" }}>
                    {fmtMoney(stmt.footer.prior)}
                  </td>
                )}
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function SectionBlock({ section, hasComparative }:
  { section: Statement["sections"][number]; hasComparative: boolean }
) {
  return (
    <>
      {/* Section header */}
      <tr style={{ background: "var(--surface-2)" }}>
        <td colSpan={hasComparative ? 3 : 2}
          className="px-6 pt-4 pb-1 text-[10px] font-bold uppercase tracking-widest"
          style={{ color: "#1f3a5f" }}>
          {section.name}
        </td>
      </tr>
      {section.rows.map((r, i) => (
        <tr key={i}>
          <td className="px-6 py-1.5 text-sm" style={{
            color: "var(--text-2)",
            paddingLeft: `${24 + r.level * 16}px`,
            fontWeight: r.is_total ? 600 : 400,
          }}>
            {r.label}
          </td>
          <td className="px-6 py-1.5 text-right tabular-nums" style={{
            color: r.current && parseFloat(r.current) < 0 ? "#dc2626" : "var(--text)",
            fontWeight: r.is_total ? 600 : 400,
            borderTop: r.is_total ? "1px solid var(--border-strong)" : undefined,
          }}>
            {fmtMoney(r.current)}
          </td>
          {hasComparative && (
            <td className="px-6 py-1.5 text-right tabular-nums" style={{
              color: r.prior && parseFloat(r.prior) < 0 ? "#dc2626" : "var(--text-2)",
              fontWeight: r.is_total ? 600 : 400,
              borderTop: r.is_total ? "1px solid var(--border-strong)" : undefined,
            }}>
              {fmtMoney(r.prior)}
            </td>
          )}
        </tr>
      ))}
      {section.total && (
        <tr style={{ background: "var(--surface)" }}>
          <td className="px-6 py-2 text-sm font-bold" style={{
            color: "var(--text)",
            paddingLeft: 24,
            borderTop: "1px solid var(--border-strong)",
          }}>
            {section.total.label}
          </td>
          <td className="px-6 py-2 text-right tabular-nums text-sm font-bold" style={{
            color: section.total.current && parseFloat(section.total.current) < 0 ? "#dc2626" : "var(--text)",
            borderTop: "1px solid var(--border-strong)",
          }}>
            {fmtMoney(section.total.current)}
          </td>
          {hasComparative && (
            <td className="px-6 py-2 text-right tabular-nums text-sm font-bold" style={{
              color: section.total.prior && parseFloat(section.total.prior) < 0 ? "#dc2626" : "var(--text)",
              borderTop: "1px solid var(--border-strong)",
            }}>
              {fmtMoney(section.total.prior)}
            </td>
          )}
        </tr>
      )}
    </>
  )
}

// ── ExportButton ──────────────────────────────────────────────────────────

function ExportButton({ periodEnd, isClosed, onExport, loading }: {
  periodEnd: string; isClosed: boolean
  onExport: (kind: "is" | "bs" | "cf" | "full") => void
  loading: boolean
}) {
  const [open, setOpen] = useState(false)
  if (!isClosed) {
    return (
      <Button size="sm" variant="outline" disabled
        icon={<Lock size={14} strokeWidth={1.8} />}
        title={`Books for ${periodEnd} must be closed first (in Reconciliations) to export the PDF.`}>
        <span className="hidden sm:inline">Books not closed</span>
      </Button>
    )
  }
  return (
    <div className="relative">
      <Button size="sm" onClick={() => setOpen(!open)}
        icon={<Download size={14} strokeWidth={1.8} />}
        loading={loading}>
        Export PDF
      </Button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-20 rounded-md p-1 min-w-[220px] shadow-lg"
          style={{ background: "var(--surface)", border: "1px solid var(--border-strong)" }}>
          {[
            { key: "full", label: "Full package (IS + BS + CF)", Icon: FileText },
            { key: "is",   label: "Income Statement only",       Icon: FileText },
            { key: "bs",   label: "Balance Sheet only",          Icon: FileText },
            { key: "cf",   label: "Cash Flow only",              Icon: FileText },
          ].map((opt) => (
            <button key={opt.key}
              onClick={() => { onExport(opt.key as "is" | "bs" | "cf" | "full"); setOpen(false) }}
              className="w-full text-left px-3 py-2 text-xs rounded transition-colors hover:bg-[var(--surface-2)] inline-flex items-center gap-2"
              style={{ color: "var(--text)" }}>
              <opt.Icon size={12} strokeWidth={1.8} style={{ color: "var(--text-muted)" }} />
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

