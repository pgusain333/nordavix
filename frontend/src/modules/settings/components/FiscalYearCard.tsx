/**
 * The client's fiscal year end.
 *
 * Every date derivation in the close app assumed a calendar year: year-to-date
 * pulled from 1 January, "the first month of the year" meant January, and a
 * window spanning 31 December was refused as crossing a year boundary. For a
 * client on a June year end all three are wrong — and wrong quietly, producing
 * a plausible figure rather than an error.
 *
 * Changing this changes what YEAR TO DATE MEANS for the workspace, so the card
 * says so at the point of the change rather than leaving someone to discover
 * that last month's figures were computed on a different basis.
 */
import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CalendarRange } from "lucide-react"

import { apiClient } from "@/core/api/client"

/** Month ends, because a fiscal year ends on one. Offering arbitrary days
 *  would invite "06-15", which no accounting system anywhere would accept. */
const MONTHS: [string, string][] = [
  ["12-31", "31 December — calendar year"],
  ["01-31", "31 January"], ["02-28", "28 February"], ["03-31", "31 March"],
  ["04-30", "30 April"], ["05-31", "31 May"], ["06-30", "30 June"],
  ["07-31", "31 July"], ["08-31", "31 August"], ["09-30", "30 September"],
  ["10-31", "31 October"], ["11-30", "30 November"],
]

export function FiscalYearCard({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState<string | null>(null)
  const [resync, setResync] = useState(false)

  const { data } = useQuery({
    queryKey: ["workspace", "fiscal-year"],
    queryFn: async () => {
      const res = await apiClient.get<{ fiscal_year_end: string | null }>(
        "/api/workspace/fiscal-year")
      return res.data
    },
    staleTime: 10 * 60_000,
  })

  const save = useMutation({
    mutationFn: async (fye: string) => {
      const res = await apiClient.put<{ fiscal_year_end: string | null; resync_recommended: boolean }>(
        "/api/workspace/fiscal-year",
        { fiscal_year_end: fye === "12-31" ? null : fye })
      return res.data
    },
    onSuccess: (r) => {
      setResync(r.resync_recommended)
      setDraft(null)
      qc.invalidateQueries({ queryKey: ["workspace", "fiscal-year"] })
      // Every derived figure downstream reads this. Drop the caches that hold
      // year-to-date rather than let a page keep showing the old basis.
      qc.invalidateQueries({ queryKey: ["insights-overview"] })
      qc.invalidateQueries({ queryKey: ["adjustments"] })
    },
  })

  if (!data) return null
  const saved = data.fiscal_year_end ?? "12-31"
  const value = draft ?? saved
  const dirty = value !== saved

  return (
    <div className="rounded-xl p-4"
      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <div className="flex items-start gap-2.5">
        <span className="h-8 w-8 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
          <CalendarRange size={15} strokeWidth={1.9} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[13.5px] font-semibold text-theme">Fiscal year end</h3>
          <p className="text-[11.5px] mt-0.5" style={{ color: "var(--text-muted)" }}>
            When this client&apos;s year closes. Year-to-date figures, the first month
            of the year, and every period comparison are measured from it.
          </p>

          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <select value={value} disabled={!canEdit}
              onChange={(e) => setDraft(e.target.value)}
              className="rounded-lg px-2.5 py-1.5 text-[12.5px] outline-none disabled:opacity-60"
              style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)",
                       color: "var(--text)" }}>
              {MONTHS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
            {canEdit && dirty && (
              <>
                <button type="button" onClick={() => save.mutate(value)}
                  disabled={save.isPending}
                  className="rounded-lg px-3 py-1.5 text-[11.5px] font-bold disabled:opacity-40"
                  style={{ background: "var(--green)", color: "white" }}>
                  {save.isPending ? "Saving…" : "Save"}
                </button>
                <button type="button" onClick={() => setDraft(null)}
                  className="rounded-lg px-2 py-1.5 text-[11.5px] font-semibold"
                  style={{ color: "var(--text-muted)" }}>
                  Cancel
                </button>
              </>
            )}
          </div>

          {/* Said before it's saved, not after. Changing this re-bases every
              year-to-date figure in the workspace, and finding that out from a
              number that moved is the worst way to learn it. */}
          {dirty && (
            <p className="text-[11px] mt-2" style={{ color: "#8a6326" }}>
              This changes what year-to-date means here. Periods already synced were
              captured on the old basis — re-sync them so their figures match.
            </p>
          )}
          {resync && !dirty && (
            <p className="text-[11px] mt-2" style={{ color: "#8a6326" }}>
              Saved. Re-sync your periods so their year-to-date figures are rebuilt
              on the new year end.
            </p>
          )}
          {save.isError && (
            <p className="text-[11px] mt-2" style={{ color: "var(--danger)" }}>
              Couldn&apos;t save that. Try again?
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
