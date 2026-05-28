/**
 * Loans schedule detail page. See PrepaidsPage for pattern docs.
 *
 * payment_type controls amortization:
 *   - amortizing    — fixed monthly P+I, principal paydown computed
 *   - interest_only — interest each month; full principal at maturity
 *   - balloon       — (v1: treated as amortizing)
 */
import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { motion, AnimatePresence } from "framer-motion"
import { Banknote, Pencil, Trash2, X } from "lucide-react"

import { Button, Spinner } from "@/core/ui/components"
import { DatePicker } from "@/core/ui/DatePicker"
import { SchedulePageHeader } from "@/modules/schedules/components/SchedulePageHeader"
import { AccountPicker } from "@/modules/schedules/components/AccountPicker"
import { RollForwardCard } from "@/modules/schedules/components/RollForwardCard"
import { schedulesApi } from "@/modules/schedules/api"
import type { LoanItem } from "@/modules/schedules/types"
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
/** Standard mortgage formula: P × r / (1 − (1 + r)^−n). */
function computePMT(principal: string, ratePct: string, term: string): string {
  const p = parseFloat(principal) || 0
  const r = (parseFloat(ratePct) || 0) / 100 / 12
  const n = parseInt(term, 10) || 0
  if (p <= 0 || n <= 0) return ""
  if (r === 0) return (p / n).toFixed(2)
  const pmt = (p * r) / (1 - Math.pow(1 + r, -n))
  return pmt.toFixed(2)
}

export function LoansPage() {
  const qc = useQueryClient()
  const [periodEnd, setPeriodEnd] = useState<string>(defaultPeriodEnd())
  const [filterAccount, setFilterAccount] = useState<string>("")
  const [dialog, setDialog] = useState<{ open: boolean; item?: LoanItem }>({ open: false })

  const { data: itemsResp, isLoading: itemsLoading } = useQuery({
    queryKey: ["schedules", "loan", "items", filterAccount],
    queryFn:  () => schedulesApi.listItems("loan", { qbo_account_id: filterAccount || undefined }),
  })
  const items = itemsResp?.items ?? []
  const { data: snapshot, isLoading: snapshotLoading } = useQuery({
    queryKey: ["schedules", "loan", "snapshot", filterAccount, periodEnd],
    queryFn:  () => schedulesApi.previewSnapshot("loan", filterAccount, periodEnd),
    enabled:  !!filterAccount,
  })

  const commitMut = useMutation({
    mutationFn: () => schedulesApi.commitSnapshot("loan", filterAccount, periodEnd),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["schedules"] }),
  })
  const deleteMut = useMutation({
    mutationFn: (id: string) => schedulesApi.deleteItem("loan", id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["schedules"] }),
  })

  const totals = useMemo(() => {
    const principal = items.filter((i) => i.is_active)
      .reduce((s, i) => s + (parseFloat(i.original_principal) || 0), 0)
    return { principal, active: items.filter((i) => i.is_active).length }
  }, [items])

  return (
    <div className="flex flex-col h-full overflow-y-auto" style={{ background: "var(--bg)" }}>
      <SchedulePageHeader
        type="loan"
        icon={<Banknote size={20} strokeWidth={1.6} />}
        accent={{ fg: "#be123c", bg: "rgba(190, 18, 60, 0.10)" }}
        periodEnd={periodEnd} onPeriod={setPeriodEnd}
        onAddItem={() => setDialog({ open: true })} addLabel="Add loan"
      />

      <div className="flex-1 px-4 sm:px-8 py-5 max-w-6xl w-full mx-auto space-y-5">
        <div className="rounded-xl p-4 flex items-end gap-4 flex-wrap"
          style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
          <AccountPicker value={filterAccount} onChange={setFilterAccount} mode="filter" label="Loan liability GL account" />
          <Kpi label="Original principal" value={fmt(totals.principal.toString())} />
          <Kpi label="Active loans" value={totals.active.toString()} />
        </div>

        <RollForwardCard
          snapshot={snapshot} isLoading={snapshotLoading} hasAccount={!!filterAccount}
          expenseLabel="Interest" paymentLabel="Principal paid"
          onCommit={() => commitMut.mutate()} committing={commitMut.isPending}
          alreadyCommitted={!!snapshot?.committed}
        />

        <div className="rounded-xl overflow-hidden"
          style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
          <div className="px-5 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
            <p className="text-sm font-semibold text-theme">Loans</p>
            <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
              Amortization runs from loan_date. Interest expense and principal paydown
              are computed per period — no manual amortization tables needed.
            </p>
          </div>
          {itemsLoading ? (
            <div className="py-12 flex justify-center"><Spinner className="h-5 w-5" /></div>
          ) : items.length === 0 ? (
            <Empty onAdd={() => setDialog({ open: true })} verb="loan" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ background: "var(--surface-2)" }}>
                    <Th>Loan</Th><Th>Lender</Th><Th>Origination</Th>
                    <Th right>Principal</Th><Th right>Rate</Th><Th>Term</Th>
                    <Th right>Monthly</Th><Th>Type</Th><Th />
                  </tr>
                </thead>
                <tbody>
                  {items.map((it) => (
                    <tr key={it.id} style={{ borderTop: "1px solid var(--border)", opacity: it.is_active ? 1 : 0.5 }}>
                      <Td>
                        <div className="text-theme">{it.description}</div>
                        {it.reference && (
                          <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>Loan #: {it.reference}</div>
                        )}
                      </Td>
                      <Td>{it.lender || "—"}</Td>
                      <Td><span className="text-[11px]" style={{ color: "var(--text-2)" }}>{it.loan_date}</span></Td>
                      <Td right tabular>{fmt(it.original_principal)}</Td>
                      <Td right tabular>{it.interest_rate_pct}%</Td>
                      <Td><span className="text-[11px]" style={{ color: "var(--text-2)" }}>{it.term_months} mo</span></Td>
                      <Td right tabular>{it.monthly_payment ? fmt(it.monthly_payment) : "—"}</Td>
                      <Td>
                        <span className="text-[10px] font-semibold uppercase tracking-wider"
                          style={{ color: "var(--text-muted)" }}>
                          {it.payment_type === "interest_only" ? "I/O"
                            : it.payment_type === "balloon" ? "Balloon"
                            : "Amortizing"}
                        </span>
                      </Td>
                      <Td><RowActions
                        onEdit={() => setDialog({ open: true, item: it })}
                        onDelete={() => { if (window.confirm(`Delete "${it.description}"?`)) deleteMut.mutate(it.id) }} /></Td>
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
          <LoanDialog existing={dialog.item} initialAccount={filterAccount}
            onClose={() => setDialog({ open: false })} />
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
      <p className="text-xs mb-4" style={{ color: "var(--text-muted)" }}>Add your first {verb} to compute the amortization.</p>
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

function LoanDialog({ existing, onClose, initialAccount }: {
  existing?: LoanItem; onClose: () => void; initialAccount: string
}) {
  const qc = useQueryClient()
  const [account, setAccount] = useState(existing?.qbo_account_id ?? initialAccount)
  const [description, setDescription] = useState(existing?.description ?? "")
  const [lender, setLender] = useState(existing?.lender ?? "")
  const [reference, setReference] = useState(existing?.reference ?? "")
  const [loanDate, setLoanDate] = useState(existing?.loan_date ?? "")
  const [principal, setPrincipal] = useState(existing?.original_principal ?? "")
  const [ratePct, setRatePct] = useState(existing?.interest_rate_pct ?? "")
  const [term, setTerm] = useState(existing?.term_months?.toString() ?? "")
  const [paymentType, setPaymentType] = useState(existing?.payment_type ?? "amortizing")
  const [monthly, setMonthly] = useState(existing?.monthly_payment ?? "")
  const [notes, setNotes] = useState(existing?.notes ?? "")
  const [error, setError] = useState<string | null>(null)

  const computedPmt = useMemo(
    () => paymentType === "amortizing" ? computePMT(principal, ratePct, term) : "",
    [principal, ratePct, term, paymentType],
  )

  const mut = useMutation({
    mutationFn: (body: Partial<LoanItem>) => existing
      ? schedulesApi.updateItem("loan", existing.id, body)
      : schedulesApi.createItem("loan", body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["schedules"] }); onClose() },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { detail?: string } } }).response?.data?.detail
      setError(msg ?? "Could not save.")
    },
  })

  function submit() {
    setError(null)
    if (!account || !description.trim() || !loanDate || !principal || !ratePct || !term) {
      setError("Account, description, loan date, principal, rate, and term are required.")
      return
    }
    mut.mutate({
      qbo_account_id: account, description: description.trim(),
      lender: lender.trim() || null, reference: reference.trim() || null,
      loan_date: loanDate, original_principal: principal,
      interest_rate_pct: ratePct, term_months: parseInt(term, 10),
      payment_type: paymentType,
      monthly_payment: (monthly || computedPmt) || null,
      notes: notes.trim() || null, is_active: true,
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
          <h3 className="text-base font-semibold text-theme">{existing ? "Edit loan" : "New loan"}</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--surface-2)]">
            <X size={16} strokeWidth={1.8} style={{ color: "var(--text-muted)" }} />
          </button>
        </div>
        <div className="px-6 py-5 space-y-4">
          <AccountPicker mode="form" label="Loan liability GL account" value={account} onChange={setAccount} />
          <Field label="Description *">
            <input value={description} onChange={(e) => setDescription(e.target.value)}
              placeholder="SBA Term Loan #12345" className={inputCls} style={inputStyle} />
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Lender">
              <input value={lender} onChange={(e) => setLender(e.target.value)} className={inputCls} style={inputStyle} />
            </Field>
            <Field label="Loan number / reference">
              <input value={reference} onChange={(e) => setReference(e.target.value)} className={inputCls} style={inputStyle} />
            </Field>
            <Field label="Loan date *">
              <DatePicker value={loanDate || ""} onChange={setLoanDate}
                triggerClassName="w-full rounded-lg px-3 py-2 text-sm border outline-none" />
            </Field>
            <Field label="Original principal *">
              <input type="number" step="0.01" value={principal} onChange={(e) => setPrincipal(e.target.value)}
                placeholder="100000.00" className={`${inputCls} text-right tabular-nums`} style={inputStyle} />
            </Field>
            <Field label="Interest rate % (annual) *">
              <input type="number" step="0.0001" value={ratePct} onChange={(e) => setRatePct(e.target.value)}
                placeholder="6.5" className={`${inputCls} text-right tabular-nums`} style={inputStyle} />
            </Field>
            <Field label="Term (months) *">
              <input type="number" step="1" value={term} onChange={(e) => setTerm(e.target.value)}
                placeholder="60" className={`${inputCls} text-right tabular-nums`} style={inputStyle} />
            </Field>
            <Field label="Payment type">
              <select value={paymentType} onChange={(e) => setPaymentType(e.target.value)}
                className={inputCls} style={inputStyle}>
                <option value="amortizing">Amortizing (fixed P+I)</option>
                <option value="interest_only">Interest-only (principal at maturity)</option>
                <option value="balloon">Balloon</option>
              </select>
            </Field>
            <Field label="Monthly payment (optional override)">
              <input type="number" step="0.01" value={monthly} onChange={(e) => setMonthly(e.target.value)}
                placeholder={computedPmt || "auto-computed"}
                className={`${inputCls} text-right tabular-nums`} style={inputStyle} />
            </Field>
          </div>
          {paymentType === "amortizing" && computedPmt && (
            <div className="rounded-lg p-3 text-xs"
              style={{ background: "var(--green-subtle)", color: "var(--green)", border: "1px solid var(--green)" }}>
              Computed monthly payment (P+I): <span className="font-bold">${parseFloat(computedPmt).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            </div>
          )}
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
            {existing ? "Save changes" : "Add loan"}
          </Button>
        </div>
      </motion.div>
    </motion.div>
  )
}
