/**
 * TrialBalanceCheckCard — the "Sync verification" accordion at the top
 * of the reconciliations dashboard. Extracted from the parent page so
 * the 4000-line file gets smaller and this card can be re-rendered
 * independently when the dashboard's other state changes.
 *
 * Renders the Assets − Liabilities − Equity = Net Income equation in
 * an expandable card. Click the header to open; the body shows the
 * three category KPIs, the equation, and a plain-English verdict.
 *
 * Behavior is unchanged from the original inline version — it takes the
 * same `check` + `breakdown` props and produces the same DOM. Nothing
 * in the parent page needs to know it moved; the import path is the
 * only thing that changed.
 */
import { useState } from "react"
import { AnimatePresence, motion } from "framer-motion"
import { ChevronDown } from "lucide-react"
import { formatDate } from "@/core/lib/dates"
import type { TbCheck } from "@/modules/recons/api"

// Local money formatter — matches the one in the parent dashboard.
// (When the shared core/lib/money helper lands in Bundle B, swap this
// out and the import resolves automatically — no behavior change.)
function fmtMoney(s: string | number, withSign = false): string {
  const n = typeof s === "string" ? parseFloat(s) : s
  if (!Number.isFinite(n)) return "$0"
  const abs = `$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
  if (n < 0) return `(${abs})`
  return withSign && n > 0 ? `+${abs}` : abs
}

interface Props {
  check:     TbCheck
  /** Asset / Liabilities / Equity totals from the same per-account
   *  sync the page renders elsewhere. Rendered as KPI cards INSIDE the
   *  expanded body so the equation below has visual anchors. */
  breakdown: { assets: number; liabilities: number; equity: number }
}

export function TrialBalanceCheckCard({ check, breakdown }: Props) {
  const [expanded, setExpanded] = useState(false)
  const hasActual = check.actual_net_income !== null
  const balanced = check.balanced === true

  const assets    = parseFloat(check.total_assets)
  const liab      = parseFloat(check.total_liabilities)
  const equity    = parseFloat(check.total_equity)
  const impliedNi = parseFloat(check.implied_net_income)
  const actualNi  = check.actual_net_income !== null ? parseFloat(check.actual_net_income) : null
  const diff      = check.difference !== null ? parseFloat(check.difference) : null

  const tone = !hasActual
    ? { bg: "var(--surface)",            border: "var(--border)",           fg: "var(--text-muted)", icon: "?" }
    : balanced
      ? { bg: "var(--green-subtle)",     border: "var(--green)",            fg: "var(--green)",      icon: "✓" }
      : { bg: "rgba(220, 38, 38, 0.06)", border: "rgba(220, 38, 38, 0.40)", fg: "#b91c1c",           icon: "!" }

  let ytdStartLabel = check.ytd_start
  let periodEndLabel = check.period_end
  try {
    ytdStartLabel  = formatDate(check.ytd_start)
    periodEndLabel = formatDate(check.period_end)
  } catch { /* fallthrough */ }

  return (
    <div className="rounded-xl overflow-hidden"
      style={{ background: tone.bg, border: `1px solid ${tone.border}`, boxShadow: "var(--card-shadow)" }}>

      {/* Header — always visible, click anywhere to toggle. */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="w-full px-4 py-3 flex items-center justify-between flex-wrap gap-2 text-left transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.03]"
        style={{ borderBottom: expanded ? `1px solid ${tone.border}` : "none" }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold"
            style={{ background: tone.fg, color: "white" }}>
            {tone.icon}
          </span>
          <h2 className="text-sm font-semibold text-theme">Sync verification</h2>
          <span className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold"
            style={{ background: "var(--surface-2)", color: tone.fg, border: `1px solid ${tone.border}` }}>
            {!hasActual ? "P&L unavailable" : balanced ? "Math ties out" : "Math doesn't match"}
          </span>
          {!expanded && !balanced && diff !== null && hasActual && (
            <span className="text-[10px] tabular-nums font-semibold ml-1" style={{ color: tone.fg }}>
              off by {fmtMoney(Math.abs(diff))}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] hidden sm:inline" style={{ color: "var(--text-muted)" }}>
            BS @ {periodEndLabel} · YTD P&L from {ytdStartLabel}
          </span>
          <ChevronDown
            size={16} strokeWidth={2}
            className="transition-transform"
            style={{
              color: "var(--text-muted)",
              transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
            }}
          />
        </div>
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="tb-check-body"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            style={{ overflow: "hidden" }}
          >
            <div className="px-4 pt-3 text-xs" style={{ color: "var(--text-muted)" }}>
              A balanced GL means: <span className="font-mono font-semibold text-theme">Assets − Liabilities − Equity = Net Income</span>.
              If the implied NI from the synced balance sheet matches QuickBooks&apos; reported NI on the P&L,
              the math ties out and the sync pulled correct figures.
            </div>

            <div className="px-4 pt-3 grid grid-cols-2 lg:grid-cols-4 gap-3">
              <MiniKpi
                label="Total assets"
                value={fmtMoney(breakdown.assets)}
                sub="Bank, AR, Fixed Assets, Other"
              />
              <MiniKpi
                label="Total liabilities"
                value={fmtMoney(breakdown.liabilities)}
                sub="AP, Credit Card, Liabilities"
              />
              <MiniKpi
                label="Total equity"
                value={fmtMoney(breakdown.equity)}
                sub="excludes current-year P&L"
              />
              <MiniKpi
                label="Implied net income"
                value={fmtMoney(impliedNi)}
                valueColor={impliedNi < 0 ? "#dc2626" : "var(--text)"}
                sub="Assets − Liab − Equity"
                highlight
              />
            </div>

            <div className="px-4 py-3 text-sm space-y-1.5">
              <EquationRow
                label="Total Assets"
                sub="Bank, AR, Fixed Assets, Other"
                value={fmtMoney(assets)}
                valueColor="var(--text)"
              />
              <Operator op="−" />
              <EquationRow
                label="Total Liabilities"
                sub="AP, Credit Card, Liabilities"
                value={fmtMoney(liab)}
                valueColor="var(--text)"
              />
              <Operator op="−" />
              <EquationRow
                label="Total Equity"
                sub="excludes current-year P&L net income"
                value={fmtMoney(equity)}
                valueColor="var(--text)"
              />
              <Operator op="=" />
              <EquationRow
                label="Implied Net Income (from sync)"
                value={fmtMoney(impliedNi)}
                valueColor={impliedNi < 0 ? "#dc2626" : "var(--text)"}
                bold
              />

              <div style={{ borderTop: "1px dashed var(--border)" }} className="!my-3" />

              {hasActual ? (
                <>
                  <EquationRow
                    label="Actual Net Income (from QuickBooks P&L)"
                    sub={`YTD ${ytdStartLabel} → ${periodEndLabel}`}
                    value={fmtMoney(actualNi!)}
                    valueColor={actualNi! < 0 ? "#dc2626" : "var(--text)"}
                    bold
                  />
                  <EquationRow
                    label="Difference (implied − actual)"
                    value={fmtMoney(diff!, true)}
                    valueColor={tone.fg}
                    bold
                  />
                </>
              ) : (
                <p className="text-xs italic py-1" style={{ color: "var(--text-muted)" }}>
                  Couldn&apos;t pull the YTD ProfitAndLoss report from QuickBooks{check.pl_error ? ` (${check.pl_error})` : ""}.
                  Compare the implied NI above to your own P&L for {ytdStartLabel} → {periodEndLabel}.
                </p>
              )}
            </div>

            <div className="px-4 py-2.5 text-[11px] flex items-start gap-2"
              style={{ borderTop: `1px solid ${tone.border}`, background: "var(--surface-2)", color: "var(--text-2)" }}>
              <span style={{ color: tone.fg, fontWeight: 700 }}>{tone.icon}</span>
              <span className="flex-1">
                {!hasActual ? (
                  <>
                    The P&L pull failed — we can&apos;t auto-verify against QuickBooks. Re-sync to retry,
                    or compare the implied NI manually against your own P&L for the YTD window.
                  </>
                ) : balanced ? (
                  <>
                    The implied Net Income from the synced balance sheet matches QuickBooks&apos; P&L
                    exactly. The sync is correct and the math is consistent — safe to start reconciling.
                  </>
                ) : (
                  <>
                    The implied Net Income doesn&apos;t match QuickBooks&apos; P&L by
                    {" "}<span className="font-semibold">{fmtMoney(Math.abs(diff!))}</span>.
                    Most common causes: an account was renamed/recategorized in QBO,
                    a non-Jan-1 fiscal year (the P&L pull spans Jan 1 → period-end),
                    or an unposted journal entry. Click <b>Sync</b> to pull fresh data; if the gap
                    persists, look for an account that&apos;s missing or sitting under the wrong
                    category in QuickBooks.
                  </>
                )}
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function EquationRow({ label, sub, value, valueColor, bold }:
  { label: string; sub?: string; value: string; valueColor: string; bold?: boolean }
) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <div className="min-w-0">
        <span className="text-xs" style={{ color: "var(--text-2)" }}>{label}</span>
        {sub && (
          <span className="text-[10px] ml-2" style={{ color: "var(--text-muted)" }}>{sub}</span>
        )}
      </div>
      <span className={`tabular-nums ${bold ? "text-base font-bold" : "font-semibold"}`}
        style={{ color: valueColor }}>{value}</span>
    </div>
  )
}

function MiniKpi({ label, value, sub, valueColor, highlight }:
  { label: string; value: string; sub?: string; valueColor?: string; highlight?: boolean }
) {
  return (
    <div className="rounded-lg p-3"
      style={{
        background: highlight ? "var(--green-subtle)" : "var(--surface)",
        border: `1px solid ${highlight ? "var(--green)" : "var(--border)"}`,
      }}>
      <p className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>{label}</p>
      <p className="text-lg font-bold tabular-nums mt-0.5"
        style={{ color: valueColor ?? "var(--text)" }}>{value}</p>
      {sub && <p className="text-[10px] mt-0.5" style={{ color: "var(--text-muted)" }}>{sub}</p>}
    </div>
  )
}

function Operator({ op }: { op: string }) {
  return (
    <div className="flex justify-center">
      <span className="text-base font-bold leading-none" style={{ color: "var(--text-muted)" }}>{op}</span>
    </div>
  )
}
