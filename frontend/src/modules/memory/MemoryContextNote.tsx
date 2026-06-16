/**
 * "What Nordavix knows" — a read-only note surfacing the CONFIRMED Client Memory
 * conventions that concern one account, shown wherever that account appears
 * (flux variance drawer, recon detail drawer). This is the visible compounding:
 * a fact confirmed once follows the account everywhere.
 *
 * Strictly additive context — it never changes a computed figure or pre-explains
 * a variance. Renders nothing when memory has learned nothing about the account.
 *
 * When `periodEnd` + `actualBalance` (the account's booked balance this period)
 * are passed, a confirmed variance_expectation gains a live match chip — whether
 * this period lands within the confirmed band or deviates from it.
 */
import { useQuery } from "@tanstack/react-query"
import { AlertTriangle, Brain, Check } from "lucide-react"
import { memoryApi } from "@/modules/memory/api"

export function MemoryContextNote({ qboAccountId, accountNumber, periodEnd, actualBalance }: {
  qboAccountId?: string | null
  accountNumber?: string | null
  periodEnd?: string | null
  actualBalance?: string | number | null
}) {
  const enabled = !!(qboAccountId || accountNumber)
  const actualKey = actualBalance == null ? "" : String(actualBalance)
  const { data } = useQuery({
    queryKey: ["memory", "account-context", qboAccountId ?? "", accountNumber ?? "", periodEnd ?? "", actualKey],
    queryFn:  () => memoryApi.getAccountContext(qboAccountId, accountNumber, periodEnd, actualBalance),
    enabled,
    staleTime: 60_000,
  })

  const notes = data?.notes ?? []
  if (notes.length === 0) return null

  return (
    <div className="rounded-xl p-3"
      style={{ background: "var(--green-subtle)", border: "1px solid var(--border)" }}>
      <div className="flex items-center gap-1.5 mb-1.5">
        <Brain size={13} strokeWidth={2} style={{ color: "var(--green)" }} />
        <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--green)" }}>
          What Nordavix knows
        </p>
      </div>
      <ul className="space-y-1.5">
        {notes.map((n) => (
          <li key={n.fact_id} className="text-[12px]" style={{ color: "var(--text)" }}>
            <div className="flex items-start gap-1.5">
              <span aria-hidden className="mt-[2px] shrink-0" style={{ color: "var(--text-muted)" }}>•</span>
              <span>{n.text}</span>
            </div>
            {n.match && (
              <div className="mt-1 ml-3.5">
                <span
                  title={n.match.text}
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold"
                  style={n.match.status === "within"
                    ? { background: "var(--surface)", color: "var(--green)", border: "1px solid var(--border)" }
                    : { background: "var(--warn-subtle)", color: "var(--warn)", border: "1px solid var(--warn-border)" }}
                >
                  {n.match.status === "within"
                    ? <><Check size={10} strokeWidth={2.5} /> As expected this period</>
                    : <><AlertTriangle size={10} strokeWidth={2.5} /> Off expectation this period</>}
                </span>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
