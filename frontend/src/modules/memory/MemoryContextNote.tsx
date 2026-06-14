/**
 * "What Nordavix knows" — a read-only note surfacing the CONFIRMED Client Memory
 * conventions that concern one account, shown wherever that account appears
 * (flux variance drawer, recon detail drawer). This is the visible compounding:
 * a fact confirmed once follows the account everywhere.
 *
 * Strictly additive context — it never changes a computed figure or pre-explains
 * a variance. Renders nothing when memory has learned nothing about the account.
 */
import { useQuery } from "@tanstack/react-query"
import { Brain } from "lucide-react"
import { memoryApi } from "@/modules/memory/api"

export function MemoryContextNote({ qboAccountId, accountNumber }: {
  qboAccountId?: string | null
  accountNumber?: string | null
}) {
  const enabled = !!(qboAccountId || accountNumber)
  const { data } = useQuery({
    queryKey: ["memory", "account-context", qboAccountId ?? "", accountNumber ?? ""],
    queryFn:  () => memoryApi.getAccountContext(qboAccountId, accountNumber),
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
      <ul className="space-y-1">
        {notes.map((n) => (
          <li key={n.fact_id} className="text-[12px] flex items-start gap-1.5" style={{ color: "var(--text)" }}>
            <span aria-hidden className="mt-[2px] shrink-0" style={{ color: "var(--text-muted)" }}>•</span>
            <span>{n.text}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
