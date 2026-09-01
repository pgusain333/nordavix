/**
 * "With and without" — the financial statements as they are, and as these
 * adjustments will leave them.
 *
 * The point of an adjustment is to change the statements. The queue showed a
 * dozen journal entries and never the thing they add up to, so the first
 * question any reviewer asks of an approved batch — what does this do to net
 * income? — could only be answered by leaving the module.
 *
 * Three things it will not do, because a rail that flatters is worse than no
 * rail at all:
 *
 *   It labels the P&L as YEAR TO DATE, because that is what the GL snapshot
 *   holds — the trial balance behind it starts at 1 January. A monthly heading
 *   over a YTD number is the entire class of bug this module keeps producing.
 *
 *   It will not add an entry that QuickBooks already contains, and when it
 *   cannot tell — an entry confirmed posted after the snapshot was taken — it
 *   says the baseline is stale rather than picking between two wrong numbers.
 *
 *   It reports lines it could not classify instead of quietly dropping them.
 *
 * The passed block is the part with no equivalent anywhere else: each item was
 * immaterial on its own, which is why it was passed, so the only way to know
 * whether they matter is to total them against the threshold.
 */
import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { AnimatePresence, motion, useReducedMotion } from "framer-motion"
import { AlertCircle, RefreshCw } from "lucide-react"

import { MOTION, EASE } from "@/core/motion"
import { adjustmentsApi, EFFECT_LINES, type EffectLine } from "../api"

/** Materiality for evaluating what was passed. A firm-level setting one day;
 *  stated here so the number on screen has a visible basis. */
const THRESHOLD_PCT = 0.05

const LABEL: Record<EffectLine, string> = {
  revenue:            "Revenue",
  cogs:               "Cost of revenue",
  gross_profit:       "Gross profit",
  opex:               "Operating expenses",
  net_income:         "Net income",
  assets:             "Total assets",
  liabilities_equity: "Liabilities & equity",
}
const SUBTOTAL: EffectLine[] = ["gross_profit"]
const TOTAL: EffectLine[] = ["net_income"]
/** Where the income statement ends and the balance sheet begins. */
const BALANCE_SHEET_FROM: EffectLine = "assets"

const n = (s: string | undefined) => Number.parseFloat(s ?? "0") || 0
const money = (v: number) =>
  Math.round(Math.abs(v)).toLocaleString(undefined, { maximumFractionDigits: 0 })
const signed = (v: number) =>
  Math.round(v) === 0 ? "—" : `${v > 0 ? "+" : "−"}${money(v)}`

export function StatementRail({ periodEnd, onTrace }: {
  periodEnd: string
  /** Entry ids behind the line the user clicked, so the queue can light them
   *  up. Empty array clears the selection. */
  onTrace?: (entryIds: string[]) => void
}) {
  const reduce = useReducedMotion()
  const [lit, setLit] = useState<EffectLine | null>(null)

  const { data } = useQuery({
    queryKey: ["adjustments", "net-effect", periodEnd],
    queryFn:  () => adjustmentsApi.netEffect(periodEnd),
    staleTime: 15_000,
  })

  if (!data) return null
  const { baseline, adjusted, applied, passed, contributors } = data
  if (data.booked.count === 0 && passed.count === 0) return null

  function pick(line: EffectLine) {
    const next = lit === line ? null : line
    setLit(next)
    onTrace?.(next ? (contributors?.[next] ?? []) : [])
  }

  const passedNi = n(passed.net_income)
  const adjustedNi = adjusted ? n(adjusted.net_income) : n(applied.net_income)
  const threshold = Math.abs(adjustedNi) * THRESHOLD_PCT
  const overThreshold = threshold > 0 && Math.abs(passedNi) > threshold
  const pctOfNi = Math.abs(adjustedNi) > 0
    ? (Math.abs(passedNi) / Math.abs(adjustedNi)) * 100
    : null

  return (
    <div className="space-y-2.5">
      <div className="rounded-xl overflow-hidden"
        style={{ background: "var(--surface)", border: "1px solid var(--border)",
                 boxShadow: "var(--card-shadow)" }}>
        <div className="px-3.5 pt-3 pb-2">
          <h3 className="text-[13px] font-semibold text-theme">With and without</h3>
          <p className="text-[10.5px] mt-0.5" style={{ color: "var(--text-muted)" }}>
            {baseline
              ? <>Profit &amp; loss is <b>year to date</b>; balance sheet is at {periodEnd}.</>
              : "This period hasn't been synced from QuickBooks yet."}
          </p>
        </div>

        {baseline && adjusted ? (
          <>
            <div className="overflow-x-auto px-1.5 pb-1.5">
              <table className="w-full text-[11.5px]" style={{ borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    {["", "Per QBO", "Adjusted", "Change"].map((h, i) => (
                      <th key={h || i} scope="col"
                        className="text-[9px] font-bold uppercase tracking-wider px-2 py-1.5 whitespace-nowrap"
                        style={{ color: "var(--text-muted)",
                                 textAlign: i === 0 ? "left" : "right",
                                 borderBottom: "1px solid var(--border)" }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {EFFECT_LINES.map((line) => {
                    const before = n(baseline[line])
                    const after = n(adjusted[line])
                    const delta = after - before
                    const isTotal = TOTAL.includes(line)
                    const isSub = SUBTOTAL.includes(line)
                    const movers = contributors?.[line] ?? []
                    return (
                      <tr key={line}>
                        <td className="px-2 py-1 whitespace-nowrap"
                          style={{
                            color: "var(--text)",
                            fontWeight: isTotal ? 800 : isSub ? 700 : 400,
                            paddingTop: line === BALANCE_SHEET_FROM ? 12 : undefined,
                            borderTop: isTotal
                              ? "2px solid var(--border-strong)"
                              : isSub ? "1px solid var(--border)" : undefined,
                          }}>
                          {LABEL[line]}
                        </td>
                        {[before, after].map((v, i) => (
                          <td key={i} className="px-2 py-1 text-right tabular-nums whitespace-nowrap"
                            style={{
                              color: isTotal ? "var(--text)" : "var(--text-2)",
                              fontWeight: isTotal ? 800 : isSub ? 700 : 400,
                              paddingTop: line === BALANCE_SHEET_FROM ? 12 : undefined,
                              borderTop: isTotal
                                ? "2px solid var(--border-strong)"
                                : isSub ? "1px solid var(--border)" : undefined,
                            }}>
                            {money(v)}
                          </td>
                        ))}
                        <td className="px-2 py-1 text-right tabular-nums whitespace-nowrap"
                          style={{
                            paddingTop: line === BALANCE_SHEET_FROM ? 12 : undefined,
                            borderTop: isTotal
                              ? "2px solid var(--border-strong)"
                              : isSub ? "1px solid var(--border)" : undefined,
                          }}>
                          <button
                            type="button"
                            onClick={() => movers.length && pick(line)}
                            disabled={!movers.length}
                            aria-pressed={lit === line}
                            title={movers.length
                              ? `Show the ${movers.length} ${movers.length === 1 ? "entry" : "entries"} behind this`
                              : undefined}
                            className="rounded px-1 -mx-1 disabled:cursor-default"
                            style={{
                              fontWeight: isTotal ? 800 : 600,
                              background: lit === line ? "var(--green-subtle)" : "transparent",
                              color: lit === line ? "var(--green)"
                                : Math.round(delta) === 0 ? "var(--text-muted)"
                                : delta > 0 ? "var(--green)" : "#A0503F",
                              transition: reduce ? "none" : "background .14s",
                            }}>
                            {signed(delta)}
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <p className="px-3.5 pb-2.5 text-[10px]" style={{ color: "var(--text-muted)" }}>
              {applied.count > 0
                ? "Click a change to see the entries behind it."
                : "Nothing to apply — every approved entry is already in QuickBooks."}
            </p>
          </>
        ) : (
          <p className="px-3.5 pb-3 text-[11px]" style={{ color: "var(--text-muted)" }}>
            Sync the period to see what these adjustments do to the statements.
          </p>
        )}

        {/* Anything the arithmetic couldn't stand behind, said out loud. */}
        <AnimatePresence initial={false}>
          {!applied.complete && (
            <motion.p key="partial"
              initial={reduce ? false : { height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
              transition={{ duration: MOTION.DEFAULT, ease: EASE.OUT }}
              className="text-[10.5px] px-3.5 pb-2.5 flex items-start gap-1.5"
              style={{ overflow: "hidden", color: "#8a6326" }}>
              <AlertCircle size={11} strokeWidth={2} className="shrink-0 mt-0.5" />
              {applied.unclassified_lines} line{applied.unclassified_lines === 1 ? "" : "s"} couldn't
              be matched to an account in this period's chart, so this is part of the movement,
              not all of it.
            </motion.p>
          )}
          {data.baseline_stale_count > 0 && (
            <motion.p key="stale"
              initial={reduce ? false : { height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
              transition={{ duration: MOTION.DEFAULT, ease: EASE.OUT }}
              className="text-[10.5px] px-3.5 pb-2.5 flex items-start gap-1.5"
              style={{ overflow: "hidden", color: "#8a6326" }}>
              <RefreshCw size={11} strokeWidth={2} className="shrink-0 mt-0.5" />
              {data.baseline_stale_count === 1
                ? "One entry was found in QuickBooks after this balance was read, so it's left out of both columns."
                : `${data.baseline_stale_count} entries were found in QuickBooks after this balance was read, so they're left out of both columns.`}
              {" "}Sync the period to include {data.baseline_stale_count === 1 ? "it" : "them"}.
            </motion.p>
          )}
        </AnimatePresence>

        {baseline?.captured_at && (
          <p className="text-[10px] px-3.5 py-2"
            style={{ color: "var(--text-muted)", background: "var(--surface-2)",
                     borderTop: "1px solid var(--border)" }}>
            <b style={{ color: "var(--text-2)" }}>Baseline</b> — QuickBooks as read{" "}
            {new Date(baseline.captured_at).toLocaleDateString(undefined, {
              day: "numeric", month: "short", hour: "numeric", minute: "2-digit",
            })}
            {data.already_in_baseline > 0 && <>
              {" · "}{data.already_in_baseline} posted{" "}
              {data.already_in_baseline === 1 ? "entry is" : "entries are"} already in it
            </>}
          </p>
        )}
      </div>

      {/* ── What wasn't booked, evaluated together ─────────────────────── */}
      {passed.count > 0 && (
        <div className="rounded-xl overflow-hidden"
          style={{ background: "var(--surface)", border: "1px solid var(--border)",
                   boxShadow: "var(--card-shadow)" }}>
          <div className="px-3.5 pt-3 pb-1">
            <h3 className="text-[13px] font-semibold text-theme">What you didn't book</h3>
            <p className="text-[10.5px] mt-0.5" style={{ color: "var(--text-muted)" }}>
              The uncorrected differences, evaluated together
            </p>
          </div>
          <div className="px-3.5 pt-2 flex items-baseline gap-2">
            <span className="text-[11.5px]" style={{ color: "var(--text-2)" }}>
              {passed.count} item{passed.count === 1 ? "" : "s"} passed
            </span>
            <span className="ml-auto text-[13px] font-bold tabular-nums"
              style={{ color: passedNi > 0 ? "var(--green)" : passedNi < 0 ? "#A0503F" : "var(--text-muted)" }}>
              {signed(passedNi)}
            </span>
          </div>

          {pctOfNi !== null && (
            <>
              <div className="px-3.5 pt-2">
                <div className="h-[5px] rounded-full overflow-hidden"
                  style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
                  <div className="h-full rounded-full"
                    style={{
                      width: `${Math.min(100, (pctOfNi / (THRESHOLD_PCT * 100)) * 100)}%`,
                      background: overThreshold ? "#8a6326" : "var(--green)",
                      transition: reduce ? "none" : "width .3s ease-out",
                    }} />
                </div>
              </div>
              <p className="px-3.5 py-2.5 text-[11px] leading-relaxed" style={{ color: "var(--text-2)" }}>
                Together they would move net income{" "}
                <b className="text-theme tabular-nums">{signed(passedNi)}</b> —{" "}
                <b className="text-theme">{pctOfNi.toFixed(1)}%</b> of the adjusted figure,
                against a threshold of {THRESHOLD_PCT * 100}% ({money(threshold)}).{" "}
                {overThreshold
                  ? <b style={{ color: "#8a6326" }}>Over the threshold — worth revisiting.</b>
                  : "Under the threshold."}
              </p>
            </>
          )}

          {passed.without_reason > 0 && (
            <p className="px-3.5 pb-3 text-[10.5px]" style={{ color: "#8a6326" }}>
              {passed.without_reason === 1
                ? "One of these has no recorded reason — it was passed before Nordavix asked for one."
                : `${passed.without_reason} of these have no recorded reason — they were passed before Nordavix asked for one.`}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
