/**
 * AccountsPanel — map every expense account to a cost pool.
 *
 * The screen a preparer spends real time in, so the template does the first
 * pass and they review exceptions. Unmapped accounts carry a suggestion with a
 * confidence flag; the low-confidence ones are exactly what needs human eyes.
 *
 * Bulk accept covers only HIGH-confidence suggestions. The template never rates
 * a "direct production" suggestion high — anything fully inventoriable is
 * mapped one account at a time, on purpose, because that's the aggressive
 * direction under §280E.
 */
import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertCircle, CheckCheck, ListTree } from "lucide-react"
import { Button, Select, Spinner } from "@/core/ui"
import { allocationApi, money, type AccountRow } from "../api"

interface Props {
  periodStart: string
  periodEnd: string
}

const CONFIDENCE_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  high:   { bg: "var(--green-subtle)", fg: "var(--green)",  label: "high" },
  medium: { bg: "var(--info-subtle)",  fg: "var(--info)",   label: "review" },
  low:    { bg: "var(--warn-subtle)",  fg: "var(--warn)",   label: "check" },
}

export function AccountsPanel({ periodStart, periodEnd }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const qc = useQueryClient()

  const { data, isLoading, isError } = useQuery({
    queryKey: ["allocation", "accounts", periodStart, periodEnd],
    queryFn:  () => allocationApi.listAccounts(periodStart, periodEnd),
    retry: false,
  })

  const poolIdByName = useMemo(() => {
    const m = new Map<string, string>()
    for (const p of data?.pools ?? []) m.set(p.name, p.id)
    return m
  }, [data?.pools])

  const highConfidence = useMemo(
    () => (data?.accounts ?? []).filter(
      (a) => !a.pool_id && a.confidence === "high" && a.suggested_pool
        && poolIdByName.has(a.suggested_pool),
    ),
    [data?.accounts, poolIdByName],
  )

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["allocation", "accounts"] })
    qc.invalidateQueries({ queryKey: ["allocation", "readiness"] })
  }

  const mapOne = useMutation({
    mutationFn: (v: { row: AccountRow; poolId: string }) =>
      allocationApi.mapAccount(v.row.qbo_account_id, {
        pool_id: v.poolId,
        account_number: v.row.account_number,
        account_name: v.row.account_name,
      }),
    onSuccess: invalidate,
    onError: (e: unknown) => {
      const ex = e as { response?: { data?: { detail?: string } }; message?: string }
      setError(ex.response?.data?.detail ?? ex.message ?? "Could not save the mapping.")
    },
  })

  async function acceptHighConfidence() {
    setBusy(true); setError(null)
    try {
      for (const row of highConfidence) {
        const poolId = poolIdByName.get(row.suggested_pool!)
        if (poolId) await allocationApi.mapAccount(row.qbo_account_id, {
          pool_id: poolId, account_number: row.account_number, account_name: row.account_name,
        })
      }
      invalidate()
    } catch (e) {
      const ex = e as { response?: { data?: { detail?: string } }; message?: string }
      setError(ex.response?.data?.detail ?? ex.message ?? "Some mappings didn't save.")
    } finally {
      setBusy(false)
    }
  }

  if (isLoading) return <div className="flex justify-center py-10"><Spinner className="h-5 w-5" /></div>

  if (isError || !data) {
    return (
      <div className="rounded-xl px-5 py-8 text-center"
        style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
        <AlertCircle size={18} strokeWidth={1.8} style={{ color: "var(--warn)" }} className="mx-auto mb-2" />
        <p className="text-sm font-medium text-theme">Couldn&rsquo;t load accounts</p>
        <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
          This reads the expense accounts from QuickBooks for the selected month.
          Check the connection, then try again.
        </p>
      </div>
    )
  }

  if (data.pools.length === 0) {
    return (
      <div className="rounded-xl px-6 py-12 text-center"
        style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
        <ListTree size={20} strokeWidth={1.7} style={{ color: "var(--text-muted)" }} className="mx-auto mb-2" />
        <p className="text-sm font-medium text-theme">Create the pools first</p>
        <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
          Accounts are mapped to pools, so there has to be something to map them to.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          {data.accounts.length - data.unmapped_count} of {data.accounts.length} mapped
          {data.unmapped_count > 0 && ` · ${data.unmapped_count} to review`}
        </p>
        {highConfidence.length > 0 && (
          <Button variant="secondary" onClick={acceptHighConfidence} loading={busy}
            icon={<CheckCheck size={14} strokeWidth={1.8} />}>
            Accept {highConfidence.length} high-confidence
          </Button>
        )}
      </div>

      {error && <p className="text-xs" style={{ color: "var(--danger)" }}>{error}</p>}

      <div className="rounded-xl overflow-hidden"
        style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
        <div className="grid grid-cols-[minmax(0,2fr)_1fr_minmax(0,1.6fr)] gap-3 px-4 py-2.5 text-[11px]"
          style={{ color: "var(--text-muted)", borderBottom: "1px solid var(--border)" }}>
          <span>Account</span>
          <span className="text-right">This month</span>
          <span>Pool</span>
        </div>

        {data.accounts.map((a, i) => {
          const conf = a.confidence ? CONFIDENCE_STYLE[a.confidence] : null
          return (
            <div key={a.qbo_account_id}
              className="grid grid-cols-[minmax(0,2fr)_1fr_minmax(0,1.6fr)] gap-3 items-center px-4 py-2.5"
              style={{ borderTop: i === 0 ? undefined : "1px solid var(--border)" }}>
              <div className="min-w-0">
                <div className="text-[13px] text-theme truncate">
                  {a.account_name || a.qbo_account_id}
                  {a.account_number && (
                    <span className="ml-1.5 text-[11px]" style={{ color: "var(--text-muted)" }}>
                      {a.account_number}
                    </span>
                  )}
                </div>
                {!a.pool_id && a.reason && (
                  <div className="text-[10.5px] mt-0.5 truncate" style={{ color: "var(--text-muted)" }}>
                    {a.reason}
                  </div>
                )}
              </div>

              <span className="text-right text-[13px] tabular-nums" style={{ color: "var(--text-2)" }}>
                {money(a.period_amount)}
              </span>

              <div className="flex items-center gap-1.5 min-w-0">
                <Select
                  value={a.pool_id ?? ""}
                  disabled={mapOne.isPending || busy}
                  onChange={(e) => {
                    if (!e.target.value) return
                    setError(null)
                    mapOne.mutate({ row: a, poolId: e.target.value })
                  }}
                >
                  <option value="" disabled>
                    {a.suggested_pool ? `Suggested: ${a.suggested_pool}` : "Choose a pool…"}
                  </option>
                  {data.pools.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </Select>
                {!a.pool_id && conf && (
                  <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                    style={{ background: conf.bg, color: conf.fg }}>
                    {conf.label}
                  </span>
                )}
              </div>
            </div>
          )
        })}

        {data.accounts.length === 0 && (
          <div className="px-6 py-10 text-center">
            <p className="text-sm font-medium text-theme">No expense activity this month</p>
            <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
              Pick a month with activity, or check the QuickBooks connection.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
