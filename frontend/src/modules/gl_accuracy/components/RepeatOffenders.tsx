/**
 * The same thing going wrong every month is a different problem.
 *
 * Risk Radar reports instances. Every scan starts from the transactions in
 * front of it, so a vendor miscoded four months running is reported four times
 * as though it were new — and each time someone re-codes it and the cause
 * survives untouched.
 *
 * A pattern is one problem: a bank-feed rule pointing at the wrong account, a
 * default on the vendor record, a habit in whoever enters the bills. Fixing it
 * once stops the finding recurring forever, which is the difference between a
 * product that catches things and one that solves them.
 */
import { useQuery } from "@tanstack/react-query"
import { Repeat } from "lucide-react"

import { apiClient } from "@/core/api/client"

interface RepeatPattern {
  vendor: string
  posted_account_name: string | null
  suggested_account_name: string | null
  period_count: number
  occurrence_count: number
  unresolved_count: number
  first_seen: string
  last_seen: string
  total_amount: string
}

const money = (s: string) => {
  const n = Number.parseFloat(s) || 0
  return `$${Math.round(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
}

const monthOf = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", year: "numeric" })

export function RepeatOffenders() {
  const { data } = useQuery({
    queryKey: ["gl-accuracy", "repeats"],
    queryFn: async () => {
      const res = await apiClient.get<{
        items: RepeatPattern[]; summary: string | null; min_periods: number
      }>("/api/gl-accuracy/repeats")
      return res.data
    },
    staleTime: 5 * 60_000,
  })

  // Nothing recurring is a good month, not an empty state worth a card.
  if (!data || data.items.length === 0) return null

  return (
    <div className="rounded-xl overflow-hidden mb-4"
      style={{ background: "var(--surface)", border: "1px solid var(--border)",
               boxShadow: "var(--card-shadow)" }}>
      <div className="px-3.5 pt-3 pb-2 flex items-start gap-2.5">
        <span className="h-8 w-8 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: "rgba(160,80,63,.10)", color: "#A0503F" }}>
          <Repeat size={15} strokeWidth={1.9} />
        </span>
        <span className="min-w-0">
          <span className="block text-[13px] font-semibold text-theme">
            Keeps coming back
          </span>
          <span className="block text-[11px] mt-0.5" style={{ color: "var(--text-muted)" }}>
            {/* The count alone is a number. How long the worst one has run is a
                reason to go and look at the cause. */}
            {data.summary ?? `Patterns seen in ${data.min_periods}+ months`}
          </span>
        </span>
      </div>

      <div>
        {data.items.map((p) => (
          <div key={`${p.vendor}-${p.posted_account_name}`}
            className="px-3.5 py-2.5" style={{ borderTop: "1px solid var(--border)" }}>
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="text-[12.5px] font-semibold text-theme">{p.vendor}</span>
              <span className="text-[11.5px]" style={{ color: "var(--text-2)" }}>
                → {p.posted_account_name || "the same account"}
              </span>
              <span className="ml-auto text-[11.5px] font-bold tabular-nums"
                style={{ color: "#A0503F" }}>
                {p.period_count} months
              </span>
            </div>
            <div className="mt-1 flex items-center gap-2.5 flex-wrap text-[10.5px]"
              style={{ color: "var(--text-muted)" }}>
              <span>{monthOf(p.first_seen)} – {monthOf(p.last_seen)}</span>
              <span>{p.occurrence_count} transaction{p.occurrence_count === 1 ? "" : "s"}</span>
              <span>{money(p.total_amount)} total</span>
              {p.unresolved_count > 0 && (
                <span style={{ color: "#8a6326" }}>
                  {p.unresolved_count} still open
                </span>
              )}
            </div>
            {p.suggested_account_name && (
              <p className="text-[11px] mt-1" style={{ color: "var(--text-2)" }}>
                Usually belongs in <b>{p.suggested_account_name}</b> — worth fixing the
                rule or the vendor default rather than re-coding it again next month.
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
