/**
 * Leases schedule detail page. See PrepaidsPage for pattern docs.
 *
 * Two modes per lease:
 *  - Cash-basis: just track monthly payment + term. No BS liability.
 *  - ASC 842:    fill discount_rate + initial_rou_asset + initial_liability
 *                and Nordavix rolls forward the liability month-by-month.
 *
 * The qbo_account_id on a lease points to the LIABILITY account. ROU asset
 * is tracked separately via rou_qbo_account_id (commit on the lease page
 * pushes the liability snapshot; ROU snapshot is computed similarly via
 * the same item — future PR can split into its own page).
 */
import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { motion, AnimatePresence } from "framer-motion"
import { Home, FileText, Pencil, Trash2, X } from "lucide-react"

import { Button, Spinner } from "@/core/ui/components"
import { DatePicker } from "@/core/ui/DatePicker"
import { useScheduleOptimistic } from "@/modules/schedules/optimistic"
import { SchedulePageHeader } from "@/modules/schedules/components/SchedulePageHeader"
import { AccountPicker } from "@/modules/schedules/components/AccountPicker"
import { RollForwardCard } from "@/modules/schedules/components/RollForwardCard"
import { ScheduleItemDrawer } from "@/modules/schedules/components/ScheduleItemDrawer"
import { GlAccountCell } from "@/modules/schedules/components/GlAccountCell"
import { useSelectedPeriodDefault } from "@/core/hooks/useSelectedPeriod"
import { schedulesApi } from "@/modules/schedules/api"
import type { LeaseItem } from "@/modules/schedules/types"
import { Field, inputCls, inputStyle } from "@/modules/schedules/pages/PrepaidsPage"

function defaultPeriodEnd(): string {
  const now = new Date()
  const last = new Date(now.getFullYear(), now.getMonth(), 0)
  return last.toISOString().slice(0, 10)
}
function fmt(s: string | null | undefined): string {
  const n = parseFloat(s ?? "0") || 0
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/**
 * PV of the payment annuity — ASC 842's "initial measurement" of the
 * lease liability. ROU asset = liability for the simple case (no IDC /
 * prepayments / incentives), so we use the same number for both.
 *
 *   r = rate_annual / 100 / 12               (monthly periodic rate)
 *   N = inclusive month count(start, end)
 *   PV(arrears) = pmt × (1 − (1 + r)^−N) / r
 *   PV(advance) = PV(arrears) × (1 + r)      (first payment is "today")
 *
 * Returns null if any input is missing or unparseable — callers treat
 * that as "can't compute yet" rather than guessing.
 */
export function computeLeasePv(
  monthly: string,
  discountRate: string,
  leaseStart: string,
  leaseEnd: string,
  timing: "arrears" | "advance",
): { pv: number; months: number } | null {
  const pmt = parseFloat(monthly) || 0
  const rateAnnual = parseFloat(discountRate) || 0
  if (!pmt || !leaseStart || !leaseEnd) return null
  const start = new Date(leaseStart + "T00:00:00")
  const end   = new Date(leaseEnd   + "T00:00:00")
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end < start) return null
  const months = Math.max(
    1,
    (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()) + 1,
  )
  const r = rateAnnual / 100 / 12
  let pv: number
  if (r === 0) {
    pv = pmt * months
  } else {
    pv = (pmt * (1 - Math.pow(1 + r, -months))) / r
    if (timing === "advance") pv = pv * (1 + r)
  }
  return { pv: Math.round(pv * 100) / 100, months }
}

export function LeasesPage() {
  const qc = useQueryClient()
  const [periodEnd, setPeriodEnd] = useState<string>(useSelectedPeriodDefault(defaultPeriodEnd()))
  const [filterAccount, setFilterAccount] = useState<string>("")
  const [dialog, setDialog] = useState<{ open: boolean; item?: LeaseItem }>({ open: false })
  const [drawerItem, setDrawerItem] = useState<LeaseItem | null>(null)

  const { data: itemsResp, isLoading: itemsLoading } = useQuery({
    queryKey: ["schedules", "lease", "items", filterAccount],
    queryFn:  () => schedulesApi.listItems("lease", { qbo_account_id: filterAccount || undefined }),
  })
  const items = itemsResp?.items ?? []
  const { data: snapshot, isLoading: snapshotLoading } = useQuery({
    queryKey: ["schedules", "lease", "snapshot", filterAccount, periodEnd],
    queryFn:  () => schedulesApi.previewSnapshot("lease", filterAccount, periodEnd),
    enabled:  !!filterAccount,
  })

  const commitMut = useMutation({
    mutationFn: () => schedulesApi.commitSnapshot("lease", filterAccount, periodEnd),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["schedules"] }),
  })
  const optimistic = useScheduleOptimistic("lease")
  const deleteMut = useMutation({
    mutationFn: (id: string) => schedulesApi.deleteItem("lease", id),
    onMutate:   (id)         => optimistic.beginDelete(id),
    onError:    (_e, _v, c)  => optimistic.rollback(c),
    onSettled:  ()           => optimistic.settle(),
  })

  const exportMut = useMutation({
    mutationFn: () => schedulesApi.downloadScheduleExcel("lease", periodEnd),
  })

  const totals = useMemo(() => {
    const monthly = items.filter((i) => i.is_active)
      .reduce((s, i) => s + (parseFloat(i.monthly_payment) || 0), 0)
    const liability = items.filter((i) => i.is_active && i.initial_liability)
      .reduce((s, i) => s + (parseFloat(i.initial_liability ?? "0") || 0), 0)
    return { monthly, liability, active: items.filter((i) => i.is_active).length }
  }, [items])

  return (
    <div className="flex flex-col h-full overflow-y-auto" style={{ background: "var(--bg)" }}>
      <SchedulePageHeader
        type="lease"
        icon={<Home size={20} strokeWidth={1.6} />}
        accent={{ fg: "#7c3aed", bg: "rgba(124, 58, 237, 0.10)" }}
        periodEnd={periodEnd} onPeriod={setPeriodEnd}
        onAddItem={() => setDialog({ open: true })} addLabel="Add lease"
        onExport={() => exportMut.mutate()}
        exporting={exportMut.isPending}
      />

      <div className="flex-1 px-4 sm:px-8 py-5 max-w-6xl w-full mx-auto space-y-5">
        <div className="rounded-xl p-4 flex items-end gap-4 flex-wrap"
          style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
          <AccountPicker value={filterAccount} onChange={setFilterAccount} mode="filter" label="Lease liability GL account" />
          <Kpi label="Monthly payments" value={fmt(totals.monthly.toString())} />
          <Kpi label="Initial liability (ASC 842)" value={fmt(totals.liability.toString())} />
          <Kpi label="Active leases" value={totals.active.toString()} />
        </div>

        <RollForwardCard
          snapshot={snapshot} isLoading={snapshotLoading} hasAccount={!!filterAccount}
          expenseLabel="Interest accretion" paymentLabel="Cash paid"
          onCommit={() => commitMut.mutate()} committing={commitMut.isPending}
          alreadyCommitted={!!snapshot?.committed}
          stale={!!snapshot?.stale}
        />

        <div className="rounded-xl overflow-hidden"
          style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
          <div className="px-5 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
            <p className="text-sm font-semibold text-theme">Leases</p>
            <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
              Fill in discount rate + initial ROU + initial liability to enable ASC 842
              roll-forward. Otherwise the lease is tracked cash-basis (payments only).
            </p>
          </div>
          {itemsLoading ? (
            <div className="py-12 flex justify-center"><Spinner className="h-5 w-5" /></div>
          ) : items.length === 0 ? (
            <Empty onAdd={() => setDialog({ open: true })} verb="lease" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ background: "var(--surface-2)" }}>
                    <Th>Lease</Th><Th>GL account</Th><Th>Lessor</Th><Th>Term</Th>
                    <Th right>Monthly</Th><Th right>Initial liability</Th><Th>Mode</Th><Th />
                  </tr>
                </thead>
                <tbody>
                  {items.map((it) => (
                    <tr key={it.id} style={{ borderTop: "1px solid var(--border)", opacity: it.is_active ? 1 : 0.5 }}>
                      <Td>
                        <div className="text-theme">{it.description}</div>
                        {it.reference && (
                          <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>Ref: {it.reference}</div>
                        )}
                      </Td>
                      <Td><GlAccountCell qboAccountId={it.qbo_account_id} /></Td>
                      <Td>{it.lessor || "—"}</Td>
                      <Td><span className="text-[11px]" style={{ color: "var(--text-2)" }}>{it.lease_start} → {it.lease_end}</span></Td>
                      <Td right tabular>{fmt(it.monthly_payment)}</Td>
                      <Td right tabular>{it.initial_liability ? fmt(it.initial_liability) : "—"}</Td>
                      <Td>
                        <span className="text-[10px] font-semibold uppercase tracking-wider"
                          style={{ color: it.initial_liability ? "#7c3aed" : "var(--text-muted)" }}>
                          {it.initial_liability ? "ASC 842" : "Cash-basis"}
                        </span>
                      </Td>
                      <Td>
                        <div className="inline-flex items-center gap-1.5 justify-end w-full">
                          <button
                            onClick={() => setDrawerItem(it)}
                            className="p-1 rounded hover:bg-[var(--surface-2)]"
                            title="View lease amortization + JE">
                            <FileText size={13} strokeWidth={1.8} style={{ color: "#7c3aed" }} />
                          </button>
                          <RowActions
                            onEdit={() => setDialog({ open: true, item: it })}
                            onDelete={() => { if (window.confirm(`Delete "${it.description}"?`)) deleteMut.mutate(it.id) }} />
                        </div>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <AnimatePresence>
        {dialog.open && (
          <LeaseDialog existing={dialog.item} initialAccount={filterAccount}
            onClose={() => setDialog({ open: false })} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {drawerItem && (
          <ScheduleItemDrawer
            variant={{ kind: "lease", item: drawerItem }}
            onClose={() => setDrawerItem(null)}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider"
        style={{ color: "var(--text-muted)" }}>{label}</p>
      <p className="text-base font-bold tabular-nums mt-0.5 text-theme">{value}</p>
    </div>
  )
}
function Th({ children, right }: { children?: React.ReactNode; right?: boolean }) {
  return <th className={`px-3 py-2 text-[10px] font-semibold uppercase tracking-wide ${right ? "text-right" : "text-left"}`} style={{ color: "var(--text-muted)" }}>{children}</th>
}
function Td({ children, right, tabular }: { children?: React.ReactNode; right?: boolean; tabular?: boolean }) {
  return <td className={`px-3 py-2 ${right ? "text-right" : ""} ${tabular ? "tabular-nums" : ""}`}>{children}</td>
}
function Empty({ onAdd, verb }: { onAdd: () => void; verb: string }) {
  return (
    <div className="py-12 px-6 text-center">
      <p className="text-sm font-semibold text-theme mb-1">No {verb}s yet</p>
      <p className="text-xs mb-4" style={{ color: "var(--text-muted)" }}>Add your first {verb} to get started.</p>
      <Button size="sm" onClick={onAdd}>Add {verb}</Button>
    </div>
  )
}
function RowActions({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) {
  return (
    <div className="inline-flex items-center gap-1.5 justify-end w-full">
      <button onClick={onEdit} className="p-1 rounded hover:bg-[var(--surface-2)]" title="Edit">
        <Pencil size={13} strokeWidth={1.8} style={{ color: "var(--text-muted)" }} />
      </button>
      <button onClick={onDelete} className="p-1 rounded hover:bg-[var(--surface-2)]" title="Delete">
        <Trash2 size={13} strokeWidth={1.8} style={{ color: "#b91c1c" }} />
      </button>
    </div>
  )
}

function LeaseDialog({ existing, onClose, initialAccount }: {
  existing?: LeaseItem; onClose: () => void; initialAccount: string
}) {
  const [account, setAccount] = useState(existing?.qbo_account_id ?? initialAccount)
  const [rouAccount, setRouAccount] = useState(existing?.rou_qbo_account_id ?? "")
  const [description, setDescription] = useState(existing?.description ?? "")
  const [lessor, setLessor] = useState(existing?.lessor ?? "")
  const [reference, setReference] = useState(existing?.reference ?? "")
  const [leaseStart, setLeaseStart] = useState(existing?.lease_start ?? "")
  const [leaseEnd, setLeaseEnd] = useState(existing?.lease_end ?? "")
  const [monthly, setMonthly] = useState(existing?.monthly_payment ?? "")
  const [useAsc842, setUseAsc842] = useState(!!existing?.initial_liability)
  // ASC 842 doesn't change the PV calculation itself — finance vs
  // operating only differ in subsequent JE presentation. Captured for
  // clarity + future use; doesn't affect what hits the DB today. Default
  // = operating (the more common case for SMBs).
  const [leaseClass, setLeaseClass] = useState<"operating" | "finance">("operating")
  // Payment timing — arrears (end of period) is the standard assumption;
  // advance (start of period) inflates the PV by (1 + r) since the
  // first payment is made immediately.
  const [paymentTiming, setPaymentTiming] = useState<"arrears" | "advance">("arrears")
  const [discountRate, setDiscountRate] = useState(existing?.discount_rate_pct ?? "")
  const [notes, setNotes] = useState(existing?.notes ?? "")
  // Offset (lease/interest expense) account for the proposed JE.
  const [offsetAccount, setOffsetAccount] = useState(existing?.offset_qbo_account_id ?? "")
  const [error, setError] = useState<string | null>(null)

  // Live PV preview — recomputed whenever any input changes so the user
  // sees the exact number that will be persisted as Initial ROU Asset
  // and Initial Liability on save. NO manual fields, NO button — the
  // math runs automatically (per user request: "calculate on your own").
  const pvPreview = useAsc842
    ? computeLeasePv(monthly, discountRate, leaseStart, leaseEnd, paymentTiming)
    : null

  const optimistic = useScheduleOptimistic("lease")
  const mut = useMutation({
    mutationFn: (body: Partial<LeaseItem>) => existing
      ? schedulesApi.updateItem("lease", existing.id, body)
      : schedulesApi.createItem("lease", body),
    onMutate: (body) => {
      if (existing) {
        return optimistic.beginUpdate(existing.id, body as Record<string, unknown>)
      }
      const tempId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      return optimistic.beginCreate({ id: tempId, ...(body as Record<string, unknown>) })
    },
    onSuccess: () => { onClose() },
    onError: (e: unknown, _vars, ctx) => {
      optimistic.rollback(ctx)
      const msg = (e as { response?: { data?: { detail?: string } } }).response?.data?.detail
      setError(msg ?? "Could not save.")
    },
    onSettled: () => optimistic.settle(),
  })

  function submit() {
    setError(null)
    if (!account || !description.trim() || !leaseStart || !leaseEnd || !monthly) {
      setError("Account, description, term, and monthly payment are required.")
      return
    }

    // ASC 842 path: compute PV inline and persist as BOTH initial ROU
    // and initial liability. Pre-validate the inputs PV needs so the
    // save never silently degrades to cash-basis (the previous bug).
    let initialRouAsset: string | null = null
    let initialLiability: string | null = null
    if (useAsc842) {
      if (!rouAccount) {
        setError("Pick a Right-of-use asset GL account for ASC 842 mode.")
        return
      }
      if (!discountRate || !parseFloat(discountRate)) {
        setError("Discount rate % is required for ASC 842 mode (e.g. 5.25 for the IBR you applied).")
        return
      }
      const calc = computeLeasePv(monthly, discountRate, leaseStart, leaseEnd, paymentTiming)
      if (!calc) {
        setError("Could not compute PV — check that monthly payment, discount rate, and term are all valid.")
        return
      }
      initialRouAsset = calc.pv.toFixed(2)
      initialLiability = calc.pv.toFixed(2)
    }

    mut.mutate({
      qbo_account_id:     account,
      rou_qbo_account_id: useAsc842 ? rouAccount : null,
      description:        description.trim(),
      lessor:             lessor.trim() || null,
      reference:          reference.trim() || null,
      lease_start:        leaseStart,
      lease_end:          leaseEnd,
      monthly_payment:    monthly,
      discount_rate_pct:  useAsc842 ? discountRate : null,
      initial_rou_asset:  initialRouAsset,
      initial_liability:  initialLiability,
      offset_qbo_account_id: offsetAccount || null,
      notes:              notes.trim() || null,
      is_active:          true,
    })
  }

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.6)" }} onClick={onClose}>
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
        className="rounded-2xl max-w-3xl w-full max-h-[90vh] overflow-y-auto"
        style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
        <div className="px-6 py-4 flex items-center justify-between"
          style={{ borderBottom: "1px solid var(--border)" }}>
          <h3 className="text-base font-semibold text-theme">{existing ? "Edit lease" : "New lease"}</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--surface-2)]">
            <X size={16} strokeWidth={1.8} style={{ color: "var(--text-muted)" }} />
          </button>
        </div>
        <div className="px-6 py-5 space-y-4">
          <AccountPicker mode="form" label="Lease liability GL account" value={account} onChange={setAccount} />
          <AccountPicker mode="form" kind="expense" label="Lease / interest expense account" value={offsetAccount} onChange={setOffsetAccount} />
          <Field label="Description *">
            <input value={description} onChange={(e) => setDescription(e.target.value)}
              placeholder="Office HQ — 5 year operating lease" className={inputCls} style={inputStyle} />
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Lessor">
              <input value={lessor} onChange={(e) => setLessor(e.target.value)} className={inputCls} style={inputStyle} />
            </Field>
            <Field label="Reference / contract no.">
              <input value={reference} onChange={(e) => setReference(e.target.value)} className={inputCls} style={inputStyle} />
            </Field>
            <Field label="Lease start *">
              <DatePicker value={leaseStart || ""} onChange={setLeaseStart}
                triggerClassName="w-full rounded-lg px-3 py-2 text-sm border outline-none" />
            </Field>
            <Field label="Lease end *">
              <DatePicker value={leaseEnd || ""} onChange={setLeaseEnd}
                triggerClassName="w-full rounded-lg px-3 py-2 text-sm border outline-none" />
            </Field>
            <Field label="Monthly payment *">
              <input type="number" step="0.01" value={monthly} onChange={(e) => setMonthly(e.target.value)}
                placeholder="3500.00" className={`${inputCls} text-right tabular-nums`} style={inputStyle} />
            </Field>
          </div>

          {/* ASC 842 toggle */}
          <div className="rounded-lg p-3"
            style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={useAsc842} onChange={(e) => setUseAsc842(e.target.checked)}
                className="h-4 w-4" style={{ accentColor: "var(--green)" }} />
              <span className="text-sm font-medium text-theme">Recognize on balance sheet (ASC 842)</span>
            </label>
            <p className="text-[11px] mt-1" style={{ color: "var(--text-muted)" }}>
              Required for GAAP-compliant private companies. Posts ROU asset + lease
              liability with monthly interest accretion.
            </p>
            {useAsc842 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-3">
                <Field label="Lease classification">
                  <select value={leaseClass} onChange={(e) => setLeaseClass(e.target.value as "operating" | "finance")}
                    className={inputCls} style={inputStyle}>
                    <option value="operating">Operating lease</option>
                    <option value="finance">Finance lease (capital)</option>
                  </select>
                </Field>
                <Field label="Payment timing">
                  <select value={paymentTiming} onChange={(e) => setPaymentTiming(e.target.value as "arrears" | "advance")}
                    className={inputCls} style={inputStyle}>
                    <option value="arrears">Arrears (end of month — standard)</option>
                    <option value="advance">Advance (start of month)</option>
                  </select>
                </Field>
                <AccountPicker mode="form" label="Right-of-use asset GL account *"
                  value={rouAccount} onChange={setRouAccount} />
                <Field label="Discount rate % (annual, e.g. 5.25) *">
                  <input type="number" step="0.0001" value={discountRate}
                    onChange={(e) => setDiscountRate(e.target.value)}
                    placeholder="5.25" className={`${inputCls} text-right tabular-nums`} style={inputStyle} />
                </Field>

                {/* Auto-calculated PV preview — replaces the old manual
                    ROU + Liability fields and the Calculate button. The
                    same value (ROU = Liability in the simple case) gets
                    persisted on save. */}
                <div className="sm:col-span-2 rounded-lg p-3"
                  style={{
                    background: pvPreview ? "var(--green-subtle)" : "var(--surface)",
                    border: `1px solid ${pvPreview ? "var(--green)" : "var(--border)"}`,
                  }}>
                  <p className="text-[10px] font-semibold uppercase tracking-wider mb-1"
                    style={{ color: pvPreview ? "var(--green)" : "var(--text-muted)" }}>
                    Initial ROU asset &amp; Initial liability (auto-calculated)
                  </p>
                  {pvPreview ? (
                    <>
                      <p className="text-base font-bold tabular-nums" style={{ color: "var(--green)" }}>
                        {fmt(pvPreview.pv.toString())}
                      </p>
                      <p className="text-[11px] mt-1" style={{ color: "var(--text-2)" }}>
                        PV of {pvPreview.months} payments of {fmt(monthly)} at {parseFloat(discountRate)}%{" "}
                        ({paymentTiming}). Saved as BOTH Initial ROU Asset and Initial Liability —
                        ASC 842 initial measurement is equal in the simple case (no IDC, prepayments,
                        or incentives).
                      </p>
                    </>
                  ) : (
                    <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                      Fill Monthly payment, Discount rate, Lease start &amp; end above — the PV will
                      compute automatically here and persist on save. No manual entry needed.
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>

          <Field label="Notes">
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
              className={inputCls} style={inputStyle} />
          </Field>
          {error && <p className="text-xs" style={{ color: "#b91c1c" }}>{error}</p>}
        </div>
        <div className="px-6 py-3 flex items-center justify-end gap-2"
          style={{ borderTop: "1px solid var(--border)", background: "var(--surface-2)" }}>
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" loading={mut.isPending} onClick={submit}>
            {existing ? "Save changes" : "Add lease"}
          </Button>
        </div>
      </motion.div>
    </motion.div>
  )
}
