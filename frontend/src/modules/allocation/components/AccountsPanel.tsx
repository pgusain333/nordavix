/**
 * AccountsPanel — decide what each expense account becomes.
 *
 * This is the heart of the product: every QuickBooks expense account is routed
 * either into COGS (inventoriable, reduces gross receipts) or left disallowed
 * under §280E — or into a pool that splits it by a driver. The screen therefore
 * shows the OUTCOME of each mapping, not just the pool name, because "Facility
 * overhead" doesn't tell a preparer what happens to the money.
 *
 * The whole expense chart is listed, not only accounts with activity this
 * month: an account idle in March still needs a pool before April's run.
 *
 * Bulk accept covers only HIGH-confidence suggestions. The template never rates
 * a "direct production" suggestion high — anything fully inventoriable is
 * mapped one account at a time, on purpose, because that's the aggressive
 * direction under §280E.
 */
import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertCircle, CheckCheck, ListTree, Receipt, Search, X } from "lucide-react"
import { TransactionDrawer } from "./TransactionDrawer"
import { Button, Input, Select, Spinner } from "@/core/ui"
import { allocationApi, money, type AccountRow, type Pool, type Treatment } from "../api"

interface Props {
  periodStart: string
  periodEnd: string
}

/** What a treatment MEANS, in the terms a preparer thinks in. */
const OUTCOME: Record<Treatment, { label: string; tone: string; bg: string }> = {
  direct:    { label: "COGS",        tone: "var(--green)",      bg: "var(--green-subtle)" },
  allocated: { label: "Split",       tone: "var(--info)",       bg: "var(--info-subtle)" },
  excluded:  { label: "§280E",       tone: "var(--danger)",     bg: "var(--danger-subtle, var(--surface-2))" },
}

const CONFIDENCE_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  high:   { bg: "var(--green-subtle)", fg: "var(--green)", label: "high" },
  medium: { bg: "var(--info-subtle)",  fg: "var(--info)",  label: "review" },
  low:    { bg: "var(--warn-subtle)",  fg: "var(--warn)",  label: "check" },
}

/** A pool's driver rate as a fraction 0–1, for display only.
 *  Blended and factor-driven pools can't be resolved client-side (the factors
 *  live server-side), so those show 0 until the run computes them — the drawer
 *  labels it as the fallback rather than implying precision it doesn't have. */
function driverFraction(pool: Pool): number {
  if (pool.driver === "fixed" && pool.fixed_pct) return Number(pool.fixed_pct) / 100
  return 0
}

export function AccountsPanel({ periodStart, periodEnd }: Props) {
  const [busy, setBusy] = useState(false)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [only, setOnly] = useState<"all" | "unmapped" | "mapped">("all")
  // Which account's ledger is open for line-by-line review.
  const [openTxns, setOpenTxns] = useState<string | null>(null)
  const qc = useQueryClient()

  const { data, isLoading, isError } = useQuery({
    queryKey: ["allocation", "accounts", periodStart, periodEnd],
    queryFn:  () => allocationApi.listAccounts(periodStart, periodEnd),
    retry: false,
    staleTime: 60_000,   // a QBO pull — don't refetch on every tab return
  })

  const poolById = useMemo(() => {
    const m = new Map<string, Pool>()
    for (const p of data?.pools ?? []) m.set(p.id, p)
    return m
  }, [data?.pools])

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

  // What this month's expense currently becomes — the point of the whole screen.
  const split = useMemo(() => {
    let cogs = 0, disallowed = 0, unmapped = 0
    for (const a of data?.accounts ?? []) {
      const amt = Number(a.period_amount) || 0
      if (!a.pool_id) { unmapped += amt; continue }
      const t = poolById.get(a.pool_id)?.treatment
      if (t === "direct") cogs += amt
      else if (t === "excluded") disallowed += amt
      // `allocated` depends on the driver, which isn't known until the run.
    }
    return { cogs, disallowed, unmapped }
  }, [data?.accounts, poolById])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (data?.accounts ?? []).filter((a) => {
      if (only === "unmapped" && a.pool_id) return false
      if (only === "mapped" && !a.pool_id) return false
      if (!q) return true
      return (
        (a.account_name ?? "").toLowerCase().includes(q) ||
        (a.account_number ?? "").toLowerCase().includes(q) ||
        (a.pool_name ?? "").toLowerCase().includes(q)
      )
    })
  }, [data?.accounts, search, only])

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
        // Date a CHANGE into the period on screen so the new pool applies
        // there. A first-time mapping is backdated server-side regardless.
        effective_from: periodStart,
      }),
    onMutate: (v) => { setSavingId(v.row.qbo_account_id); setError(null) },
    onSettled: () => setSavingId(null),
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
          pool_id: poolId, account_number: row.account_number,
          account_name: row.account_name, effective_from: periodStart,
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

  if (isLoading) {
    return (
      <div className="rounded-xl px-4 py-12 flex flex-col items-center gap-2"
        style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
        <Spinner className="h-5 w-5" />
        <span className="text-xs" style={{ color: "var(--text-muted)" }}>
          Reading the chart of accounts from QuickBooks…
        </span>
      </div>
    )
  }

  if (isError || !data) {
    return (
      <div className="rounded-xl px-5 py-8 text-center"
        style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
        <AlertCircle size={18} strokeWidth={1.8} style={{ color: "var(--warn)" }} className="mx-auto mb-2" />
        <p className="text-sm font-medium text-theme">Couldn&rsquo;t load accounts</p>
        <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
          This reads the expense accounts from QuickBooks. Check the connection,
          then try again.
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
          Accounts are routed to COGS or §280E through pools, so there has to be
          something to map them to.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3 ndvx-fade-in">
      {/* Where this month's expense currently lands */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
        {[
          { label: "Straight to COGS", value: money(String(split.cogs)), tone: "var(--green)" },
          { label: "Disallowed (§280E)", value: money(String(split.disallowed)), tone: "var(--danger)" },
          { label: "Split by driver", value: "at run time", tone: "var(--text-2)" },
          {
            label: "Not yet mapped",
            value: data.unmapped_count === 0 ? "None" : money(String(split.unmapped)),
            tone: data.unmapped_count === 0 ? "var(--positive)" : "var(--warn)",
          },
        ].map((k) => (
          <div key={k.label} className="rounded-lg px-3.5 py-3"
            style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
            <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>{k.label}</div>
            <div className="text-base font-semibold tabular-nums mt-0.5" style={{ color: k.tone }}>
              {k.value}
            </div>
          </div>
        ))}
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px]">
          <Search size={14} strokeWidth={1.8}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
            style={{ color: "var(--text-muted)" }} />
          <Input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search accounts…" style={{ paddingLeft: 30 }} />
        </div>
        <Select value={only} onChange={(e) => setOnly(e.target.value as typeof only)}
          style={{ width: "auto", minWidth: 150 }}>
          <option value="all">All accounts</option>
          <option value="unmapped">Needs a decision</option>
          <option value="mapped">Already mapped</option>
        </Select>
        {(search || only !== "all") && (
          <button onClick={() => { setSearch(""); setOnly("all") }}
            className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[12px]"
            style={{ color: "var(--text-2)", border: "1px solid var(--border)" }}>
            <X size={12} strokeWidth={2} /> Clear
          </button>
        )}
        {highConfidence.length > 0 && (
          <Button variant="outline" onClick={acceptHighConfidence} loading={busy}
            icon={<CheckCheck size={14} strokeWidth={1.8} />}>
            Accept {highConfidence.length} high-confidence
          </Button>
        )}
      </div>

      <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
        Showing {filtered.length} of {data.accounts.length} ·{" "}
        {data.accounts.length - data.unmapped_count} mapped
        {data.unmapped_count > 0 && (
          <span style={{ color: "var(--warn)" }}> · {data.unmapped_count} to review</span>
        )}
      </p>

      {error && <p className="text-xs" style={{ color: "var(--danger)" }}>{error}</p>}

      <div className="rounded-xl overflow-hidden"
        style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
        <div className="grid grid-cols-[minmax(0,2fr)_1fr_minmax(0,1.5fr)_auto] gap-3 px-4 py-2.5 text-[11px] sticky top-0 z-10"
          style={{ color: "var(--text-muted)", background: "var(--surface-2)",
                   borderBottom: "1px solid var(--border)" }}>
          <span>Account</span>
          <span className="text-right">This month</span>
          <span>Pool</span>
          <span className="text-right">Becomes</span>
        </div>

        {filtered.length === 0 ? (
          <div className="px-6 py-10 text-center">
            <p className="text-sm font-medium text-theme">Nothing matches</p>
            <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
              Adjust the search or filter.
            </p>
          </div>
        ) : filtered.map((a, i) => {
          const conf = a.confidence ? CONFIDENCE_STYLE[a.confidence] : null
          const pool = a.pool_id ? poolById.get(a.pool_id) : undefined
          const outcome = pool ? OUTCOME[pool.treatment] : null
          return (
            <div key={a.qbo_account_id}
              style={{ borderTop: i === 0 ? undefined : "1px solid var(--border)" }}>
            <div
              className="grid grid-cols-[minmax(0,2fr)_1fr_minmax(0,1.5fr)_auto] gap-3 items-center px-4 py-2.5 transition-opacity"
              style={{ opacity: savingId === a.qbo_account_id ? 0.55 : 1 }}>
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

              <span className="text-right text-[13px] tabular-nums"
                style={{ color: Number(a.period_amount) ? "var(--text-2)" : "var(--text-muted)" }}>
                {Number(a.period_amount) ? money(a.period_amount) : "—"}
              </span>

              <div className="flex items-center gap-1.5 min-w-0">
                <Select
                  value={a.pool_id ?? ""}
                  disabled={savingId === a.qbo_account_id || busy}
                  onChange={(e) => {
                    if (!e.target.value) return
                    mapOne.mutate({ row: a, poolId: e.target.value })
                  }}
                >
                  <option value="" disabled>
                    {a.suggested_pool ? `Suggested: ${a.suggested_pool}` : "Choose a pool…"}
                  </option>
                  {data.pools.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — {OUTCOME[p.treatment].label}
                    </option>
                  ))}
                </Select>
                {!a.pool_id && conf && (
                  <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                    style={{ background: conf.bg, color: conf.fg }}>
                    {conf.label}
                  </span>
                )}
              </div>

              <span className="justify-self-end flex items-center gap-1.5">
                {/* Only an ALLOCATED account has an estimate worth improving on:
                    direct is already 100% and excluded is already 0%. */}
                {pool?.treatment === "allocated" && (
                  <button
                    onClick={() => setOpenTxns(
                      openTxns === a.qbo_account_id ? null : a.qbo_account_id,
                    )}
                    title="Review the GL entries and allocate line by line"
                    className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] font-medium transition-colors"
                    style={openTxns === a.qbo_account_id
                      ? { background: "var(--green)", color: "#fff" }
                      : { background: "var(--surface-2)", color: "var(--text-2)" }}>
                    <Receipt size={11} strokeWidth={2} /> GL
                  </button>
                )}
                {outcome ? (
                  <span className="rounded-full px-2 py-0.5 text-[10.5px] font-medium whitespace-nowrap"
                    style={{ background: outcome.bg, color: outcome.tone }}>
                    {outcome.label}
                  </span>
                ) : (
                  <span className="text-[10.5px]" style={{ color: "var(--text-muted)" }}>—</span>
                )}
              </span>
            </div>

            {openTxns === a.qbo_account_id && pool && (
              <div className="px-3 pb-3" style={{ background: "var(--surface-2)" }}>
                <TransactionDrawer
                  qboAccountId={a.qbo_account_id}
                  accountName={a.account_name || a.qbo_account_id}
                  driverPct={driverFraction(pool)}
                  periodStart={periodStart}
                  periodEnd={periodEnd}
                  onClose={() => setOpenTxns(null)}
                />
              </div>
            )}
          </div>
          )
        })}
      </div>
    </div>
  )
}
