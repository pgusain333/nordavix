/**
 * Does Nordavix's picture match QuickBooks' own?
 *
 * Nordavix builds its statements from the GL snapshot and reasons over them
 * locally. That is an INDEPENDENT calculation, and an independent calculation
 * nobody checks against the source is a second opinion nobody asked for.
 *
 * The existing validation checks internal consistency — assets equal
 * liabilities plus equity plus net income. It cannot catch a snapshot that
 * missed an account or a classification the two systems disagree about,
 * because in both cases the figures are internally perfect and externally
 * wrong.
 *
 * So this shows the other answer, and shows it either way. "Ties to QuickBooks
 * exactly" is the strongest sentence an accounting product can put on a screen
 * — which is exactly why the failure to check must never be dressed up as
 * agreement. A run that compared nothing says so.
 */
import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { AlertTriangle, CheckCircle2, HelpCircle, RefreshCw } from "lucide-react"

import { apiClient } from "@/core/api/client"

interface TieOutLine {
  key: string
  label: string
  source: "bs" | "pl"
  nordavix: string | null
  quickbooks: string | null
  difference: string | null
  status: "ties" | "differs" | "unavailable"
}

interface TieOut {
  period_end: string
  checked_at?: string
  basis?: string
  ties: boolean | null
  lines: TieOutLine[]
  comparable: number
  differing: number
  largest_difference: string | null
  tolerance?: string
  error: string | null
}

const money = (s: string | null) => {
  if (s === null) return "—"
  const n = Number.parseFloat(s)
  if (Number.isNaN(n)) return "—"
  return `${n < 0 ? "−" : ""}${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
}

export function TieOutCard({ periodEnd }: { periodEnd: string }) {
  const [run, setRun] = useState(false)

  const { data, isFetching, refetch } = useQuery({
    queryKey: ["financials", "tie-out", periodEnd],
    queryFn: async () => {
      const res = await apiClient.get<TieOut>("/api/financials/tie-out",
        { params: { period_end: periodEnd } })
      return res.data
    },
    // Reads QuickBooks live, so it runs when asked rather than on page load.
    enabled: run,
    staleTime: 5 * 60_000,
  })

  const verdict = data?.ties
  const tone = verdict === true ? "var(--green)"
    : verdict === false ? "#A0503F" : "#8a6326"

  return (
    <div className="rounded-xl overflow-hidden"
      style={{ background: "var(--surface)", border: "1px solid var(--border)",
               boxShadow: "var(--card-shadow)" }}>
      <div className="px-3.5 pt-3 pb-2.5 flex items-start gap-2">
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-semibold text-theme">
            Tie out to QuickBooks
          </span>
          <span className="block text-[10.5px] mt-0.5" style={{ color: "var(--text-muted)" }}>
            Compare what Nordavix computed against QuickBooks&apos; own statements.
          </span>
        </span>
        <button type="button"
          onClick={() => { setRun(true); if (run) refetch() }}
          disabled={isFetching}
          className="shrink-0 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-bold disabled:opacity-50"
          style={{ background: "var(--green)", color: "white" }}>
          <RefreshCw size={12} strokeWidth={2.2} className={isFetching ? "animate-spin" : ""} />
          {isFetching ? "Checking…" : run ? "Check again" : "Check"}
        </button>
      </div>

      {data && (
        <>
          <div className="px-3.5 pb-2 flex items-start gap-1.5"
            style={{ color: tone }}>
            {verdict === true ? <CheckCircle2 size={14} strokeWidth={2.2} className="mt-0.5 shrink-0" />
              : verdict === false ? <AlertTriangle size={14} strokeWidth={2.2} className="mt-0.5 shrink-0" />
              : <HelpCircle size={14} strokeWidth={2.2} className="mt-0.5 shrink-0" />}
            <span className="text-[12px] font-semibold">
              {verdict === true
                ? `Every line ties to QuickBooks${data.tolerance ? ` (within $${data.tolerance})` : ""}.`
                : verdict === false
                  ? `${data.differing} line${data.differing === 1 ? "" : "s"} don't match — largest gap ${money(data.largest_difference)}.`
                  /* Not "everything ties". Zero comparisons is the most
                     confident wrong answer available. */
                  : "Couldn't compare — nothing to check against."}
            </span>
          </div>

          {data.error && (
            <p className="px-3.5 pb-2 text-[11px]" style={{ color: "#8a6326" }}>
              {data.error}
            </p>
          )}

          {data.lines.length > 0 && (
            <div className="overflow-x-auto px-1.5 pb-1.5">
              <table className="w-full text-[11.5px]" style={{ borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    {["", "Nordavix", "QuickBooks", "Difference"].map((h, i) => (
                      <th key={h || i} scope="col"
                        className="text-[9px] font-bold uppercase tracking-wider px-2 py-1.5 whitespace-nowrap"
                        style={{ color: "var(--text-muted)",
                                 textAlign: i === 0 ? "left" : "right",
                                 borderBottom: "1px solid var(--border)" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.lines.map((line) => (
                    <tr key={line.key}>
                      <td className="px-2 py-1 whitespace-nowrap text-theme">{line.label}</td>
                      <td className="px-2 py-1 text-right tabular-nums whitespace-nowrap"
                        style={{ color: "var(--text-2)" }}>{money(line.nordavix)}</td>
                      <td className="px-2 py-1 text-right tabular-nums whitespace-nowrap"
                        style={{ color: "var(--text-2)" }}>{money(line.quickbooks)}</td>
                      <td className="px-2 py-1 text-right tabular-nums whitespace-nowrap font-semibold"
                        style={{
                          color: line.status === "differs" ? "#A0503F"
                            : line.status === "unavailable" ? "var(--text-muted)"
                            : "var(--green)",
                        }}>
                        {line.status === "unavailable" ? "not compared"
                          : line.status === "ties" ? "ties" : money(line.difference)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="text-[10px] px-3.5 py-2"
            style={{ color: "var(--text-muted)", background: "var(--surface-2)",
                     borderTop: "1px solid var(--border)" }}>
            Both sides year to date through {periodEnd}. A difference is a thing to
            investigate, not a thing to correct here — Nordavix never writes to
            QuickBooks.
          </p>
        </>
      )}

      {!data && !isFetching && (
        <p className="px-3.5 pb-3 text-[11px]" style={{ color: "var(--text-muted)" }}>
          Reads two reports from QuickBooks, so it runs when you ask.
        </p>
      )}
    </div>
  )
}
