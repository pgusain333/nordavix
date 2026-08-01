/**
 * TransactionDrawer — read the ledger, allocate line by line.
 *
 * The pool driver is an estimate applied to a whole account. This is where a
 * preparer can do better: look at the actual GL entries and say which specific
 * charges were production. §471(c) is a books-and-records method, so specific
 * evidence beats a defensible estimate every time.
 *
 * Only reviewed transactions are overridden; whatever is left still falls to
 * the driver. The header shows both halves and the resulting effective rate as
 * you work, so the consequence of a review is visible immediately rather than
 * discovered in the run.
 */
import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Search, X } from "lucide-react"
import { Button, Input, Spinner } from "@/core/ui"
import { allocationApi, money, type AccountTxn } from "../api"

interface Props {
  qboAccountId: string
  accountName: string
  /** The pool's rate, as a fraction 0–1 — what unreviewed amounts fall back to. */
  driverPct: number
  periodStart: string
  periodEnd: string
  onClose: () => void
}

const QUICK = [0, 50, 100]

export function TransactionDrawer({
  qboAccountId, accountName, driverPct, periodStart, periodEnd, onClose,
}: Props) {
  const [search, setSearch] = useState("")
  const [savingId, setSavingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const qc = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ["allocation", "txns", qboAccountId, periodStart, periodEnd],
    queryFn:  () => allocationApi.listAccountTransactions(qboAccountId, periodStart, periodEnd),
    staleTime: 60_000,
  })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["allocation", "txns", qboAccountId] })
    qc.invalidateQueries({ queryKey: ["allocation", "accounts"] })
  }

  const setPct = useMutation({
    mutationFn: (v: { t: AccountTxn; pct: number | null }) =>
      v.pct === null
        ? allocationApi.clearTransactionAllocation(qboAccountId, v.t.qbo_txn_id, periodEnd)
        : allocationApi.setTransactionAllocation(qboAccountId, v.t.qbo_txn_id, periodEnd, {
            production_pct: v.pct,
            amount: Number(v.t.amount),
            txn_date: v.t.txn_date,
            txn_type: v.t.txn_type,
            txn_number: v.t.txn_number,
            memo: v.t.memo,
            entity_name: v.t.entity_name,
          }),
    onMutate: (v) => { setSavingId(v.t.qbo_txn_id); setError(null) },
    onSettled: () => setSavingId(null),
    onSuccess: invalidate,
    onError: (e: unknown) => {
      const ex = e as { response?: { data?: { detail?: string } }; message?: string }
      setError(ex.response?.data?.detail ?? ex.message ?? "Couldn't save that split.")
    },
  })

  const txns = data?.transactions ?? []

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return txns
    return txns.filter((t) =>
      (t.memo ?? "").toLowerCase().includes(q) ||
      (t.entity_name ?? "").toLowerCase().includes(q) ||
      (t.txn_number ?? "").toLowerCase().includes(q) ||
      (t.txn_type ?? "").toLowerCase().includes(q),
    )
  }, [txns, search])

  // The effective rate this account will actually get, live as you review.
  const effective = useMemo(() => {
    if (!data) return null
    const gross = Number(data.gross)
    if (!gross) return null
    const reviewedCap = Number(data.reviewed_capitalized)
    const unreviewed = Number(data.unreviewed_amount)
    return ((reviewedCap + unreviewed * driverPct) / gross) * 100
  }, [data, driverPct])

  return (
    <div className="rounded-xl overflow-hidden ndvx-fade-in"
      style={{ background: "var(--surface)", border: "1px solid var(--green)" }}>

      <div className="px-4 py-3 flex items-start justify-between gap-3 flex-wrap"
        style={{ borderBottom: "1px solid var(--border)" }}>
        <div className="min-w-0">
          <p className="text-sm font-medium text-theme truncate">{accountName}</p>
          <p className="text-[11px] mt-0.5" style={{ color: "var(--text-muted)" }}>
            Allocate individual entries — anything you don&rsquo;t touch stays on the
            pool driver at {(driverPct * 100).toFixed(2)}%
          </p>
        </div>
        <button onClick={onClose} aria-label="Close"
          className="p-1 rounded-md" style={{ color: "var(--text-muted)" }}>
          <X size={16} strokeWidth={1.8} />
        </button>
      </div>

      {data && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-px" style={{ background: "var(--border)" }}>
          {[
            { label: "Account total", value: money(data.gross) },
            { label: `Reviewed (${data.reviewed_count})`, value: money(data.reviewed_amount) },
            { label: "Left on the driver", value: money(data.unreviewed_amount) },
            {
              label: "Effective rate",
              value: effective === null ? "—" : `${effective.toFixed(2)}%`,
              tone: "var(--green)",
            },
          ].map((k) => (
            <div key={k.label} className="px-4 py-2.5" style={{ background: "var(--surface)" }}>
              <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>{k.label}</div>
              <div className="text-[15px] font-semibold tabular-nums mt-0.5"
                style={{ color: k.tone ?? "var(--text)" }}>{k.value}</div>
            </div>
          ))}
        </div>
      )}

      <div className="px-4 py-2.5 flex items-center gap-2"
        style={{ borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)" }}>
        <div className="relative flex-1 min-w-[160px]">
          <Search size={14} strokeWidth={1.8}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
            style={{ color: "var(--text-muted)" }} />
          <Input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search memo, vendor, document…" style={{ paddingLeft: 30 }} />
        </div>
        <span className="text-[11px] whitespace-nowrap" style={{ color: "var(--text-muted)" }}>
          {filtered.length} of {txns.length}
        </span>
      </div>

      {error && <p className="px-4 pt-2 text-xs" style={{ color: "var(--danger)" }}>{error}</p>}

      {isLoading ? (
        <div className="px-4 py-10 flex flex-col items-center gap-2">
          <Spinner className="h-5 w-5" />
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>
            Pulling the general ledger…
          </span>
        </div>
      ) : txns.length === 0 ? (
        <div className="px-6 py-10 text-center">
          <p className="text-sm font-medium text-theme">No transactions this period</p>
          <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
            Nothing posted to this account in the selected month.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-[90px_minmax(0,1.6fr)_minmax(0,1fr)_110px_minmax(0,1.1fr)] gap-3 px-4 py-2 text-[11px]"
            style={{ color: "var(--text-muted)", borderBottom: "1px solid var(--border)" }}>
            <span>Date</span><span>Detail</span>
            <span className="text-right">Amount</span>
            <span className="text-right">Production %</span>
            <span>Quick set</span>
          </div>

          <div className="max-h-[460px] overflow-y-auto">
            {filtered.map((t, i) => {
              const reviewed = t.production_pct !== null
              return (
                <div key={t.qbo_txn_id}
                  className="grid grid-cols-[90px_minmax(0,1.6fr)_minmax(0,1fr)_110px_minmax(0,1.1fr)] gap-3 items-center px-4 py-2 text-[13px] transition-opacity"
                  style={{
                    borderTop: i === 0 ? undefined : "1px solid var(--border)",
                    background: reviewed ? "var(--green-subtle)" : undefined,
                    opacity: savingId === t.qbo_txn_id ? 0.55 : 1,
                  }}>
                  <span className="text-[11.5px]" style={{ color: "var(--text-2)" }}>
                    {t.txn_date
                      ? new Date(t.txn_date + "T00:00:00").toLocaleDateString("en-US",
                          { month: "short", day: "numeric" })
                      : "—"}
                  </span>

                  <div className="min-w-0">
                    <div className="truncate text-theme">
                      {t.entity_name || t.memo || t.txn_type || "Entry"}
                    </div>
                    <div className="truncate text-[10.5px]" style={{ color: "var(--text-muted)" }}>
                      {[t.txn_type, t.txn_number, t.entity_name && t.memo ? t.memo : null]
                        .filter(Boolean).join(" · ")}
                    </div>
                  </div>

                  <span className="text-right tabular-nums" style={{ color: "var(--text-2)" }}>
                    {money(t.amount)}
                  </span>

                  <Input type="number" min="0" max="100"
                    disabled={savingId === t.qbo_txn_id}
                    defaultValue={t.production_pct ?? ""}
                    placeholder={`${(driverPct * 100).toFixed(0)} (driver)`}
                    style={{ textAlign: "right" }}
                    onBlur={(e) => {
                      const raw = e.target.value.trim()
                      if (raw === "") {
                        if (reviewed) setPct.mutate({ t, pct: null })
                        return
                      }
                      const v = Number(raw)
                      if (v >= 0 && v <= 100 && String(v) !== String(t.production_pct)) {
                        setPct.mutate({ t, pct: v })
                      }
                    }} />

                  <div className="flex items-center gap-1">
                    {QUICK.map((q) => (
                      <button key={q} disabled={savingId === t.qbo_txn_id}
                        onClick={() => setPct.mutate({ t, pct: q })}
                        className="rounded-md px-1.5 py-0.5 text-[10.5px] font-medium transition-colors"
                        style={Number(t.production_pct) === q && reviewed
                          ? { background: "var(--green)", color: "#fff" }
                          : { background: "var(--surface-2)", color: "var(--text-2)" }}>
                        {q}%
                      </button>
                    ))}
                    {reviewed && (
                      <button onClick={() => setPct.mutate({ t, pct: null })}
                        className="rounded-md px-1.5 py-0.5 text-[10.5px]"
                        style={{ color: "var(--text-muted)" }}>
                        clear
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}

      <div className="px-4 py-2.5 flex items-center justify-between gap-3"
        style={{ borderTop: "1px solid var(--border)" }}>
        <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
          Reviews apply to this period only — the same cost can be production one
          month and not the next.
        </p>
        <Button variant="outline" onClick={onClose}>Done</Button>
      </div>
    </div>
  )
}
