/**
 * What the firm's advice has been worth.
 *
 * The argument for an advisory fee, assembled from the client's own numbers
 * instead of asserted. Every accounting firm is being told to move into
 * advisory and none of them can show what their advice did; this is that,
 * generated as a byproduct of tracking it.
 *
 * Two things it deliberately does not do:
 *
 * It counts ungradable advice in the open. A scorecard that quietly drops the
 * rows it can't measure flatters itself, and the number a partner would show a
 * client has to survive the client asking how it was worked out.
 *
 * It calls the money "in motion", not "delivered". These are the impacts the
 * firm ESTIMATED when it advised, on the items that are moving — an
 * expectation being met, not a measured saving. Labelling an estimate as a
 * result would be the one lie that discredits the whole page.
 */
import { useQuery } from "@tanstack/react-query"

import { advisoryApi, type Grade } from "../api"

const ORDER: { key: Grade; label: string; fg: string }[] = [
  { key: "achieved",  label: "Target met",      fg: "var(--green)" },
  { key: "working",   label: "Working",         fg: "var(--green)" },
  { key: "flat",      label: "No change yet",   fg: "var(--text-muted)" },
  { key: "worsening", label: "Going backwards", fg: "#A0503F" },
]

const money = (v: number) =>
  `$${Math.round(Math.abs(v)).toLocaleString(undefined, { maximumFractionDigits: 0 })}`

export function AdvisoryScorecard({ periodEnd }: { periodEnd: string }) {
  const { data } = useQuery({
    queryKey: ["advisory", "scorecard", periodEnd],
    queryFn:  () => advisoryApi.getScorecard(periodEnd),
    staleTime: 60_000,
  })
  if (!data || data.total === 0) return null

  const maxCount = Math.max(1, ...ORDER.map((o) => data.by_grade[o.key] ?? 0))

  return (
    <div className="rounded-xl overflow-hidden"
      style={{ background: "var(--surface)", border: "1px solid var(--border)",
               boxShadow: "var(--card-shadow)" }}>
      <div className="px-3.5 pt-3 pb-2">
        <h3 className="text-[13px] font-semibold text-theme">What our advice was worth</h3>
        <p className="text-[10.5px] mt-0.5" style={{ color: "var(--text-muted)" }}>
          Across {data.total} recommendation{data.total === 1 ? "" : "s"}
        </p>
      </div>

      <div className="px-3.5 pb-3 flex gap-4">
        <span>
          <span className="block text-[19px] font-bold tabular-nums text-theme leading-none">
            {data.acted_on}
          </span>
          <span className="block text-[10px] mt-1" style={{ color: "var(--text-muted)" }}>
            acted on
          </span>
        </span>
        <span>
          <span className="block text-[19px] font-bold tabular-nums leading-none"
            style={{ color: "var(--green)" }}>
            {(data.by_grade.achieved ?? 0) + (data.by_grade.working ?? 0)}
          </span>
          <span className="block text-[10px] mt-1" style={{ color: "var(--text-muted)" }}>
            moving the metric
          </span>
        </span>
        {data.impact_in_motion > 0 && (
          <span className="ml-auto text-right">
            <span className="block text-[19px] font-bold tabular-nums text-theme leading-none">
              {money(data.impact_in_motion)}
            </span>
            <span className="block text-[10px] mt-1" style={{ color: "var(--text-muted)" }}>
              estimated, in motion
            </span>
          </span>
        )}
      </div>

      <div className="px-3.5 pb-2.5 space-y-1.5" style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
        {ORDER.map((o) => {
          const c = data.by_grade[o.key] ?? 0
          return (
            <div key={o.key} className="flex items-center gap-2 text-[11px]">
              <span className="w-[104px] shrink-0" style={{ color: "var(--text-muted)" }}>{o.label}</span>
              <span className="flex-1 h-[6px] rounded-full overflow-hidden"
                style={{ background: "var(--surface-2)" }}>
                <span className="block h-full rounded-full"
                  style={{ width: `${(c / maxCount) * 100}%`, background: o.fg,
                           opacity: c === 0 ? 0 : 1 }} />
              </span>
              <span className="w-4 text-right tabular-nums font-semibold"
                style={{ color: c === 0 ? "var(--text-muted)" : "var(--text)" }}>{c}</span>
            </div>
          )
        })}
      </div>

      {data.unlinked > 0 && (
        <p className="px-3.5 pb-3 text-[10.5px]" style={{ color: "#8a6326" }}>
          {data.unlinked} {data.unlinked === 1 ? "recommendation isn't" : "recommendations aren't"} tied
          to a metric, so {data.unlinked === 1 ? "it can't" : "they can't"} be graded. Link one to start
          tracking {data.unlinked === 1 ? "it" : "them"}.
        </p>
      )}
    </div>
  )
}
