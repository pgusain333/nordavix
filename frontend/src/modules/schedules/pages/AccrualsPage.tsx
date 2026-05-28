/**
 * Accrued Expenses schedule detail page. See PrepaidsPage for pattern docs.
 */
import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { motion, AnimatePresence } from "framer-motion"
import { ClipboardList, FileText, Pencil, Trash2, X, CheckCircle2 } from "lucide-react"

import { Button, Spinner } from "@/core/ui/components"
import { DatePicker } from "@/core/ui/DatePicker"
import { SchedulePageHeader } from "@/modules/schedules/components/SchedulePageHeader"
import { AccountPicker } from "@/modules/schedules/components/AccountPicker"
import { RollForwardCard } from "@/modules/schedules/components/RollForwardCard"
import { AccrualReversalDrawer } from "@/modules/schedules/components/AccrualReversalDrawer"
import { GlAccountCell } from "@/modules/schedules/components/GlAccountCell"
import { useSelectedPeriodDefault } from "@/core/hooks/useSelectedPeriod"
import { schedulesApi } from "@/modules/schedules/api"
import type { AccrualItem } from "@/modules/schedules/types"
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

export function AccrualsPage() {
  const qc = useQueryClient()
  const [periodEnd, setPeriodEnd] = useState<string>(useSelectedPeriodDefault(defaultPeriodEnd()))
  const [filterAccount, setFilterAccount] = useState<string>("")
  const [dialog, setDialog] = useState<{ open: boolean; item?: AccrualItem }>({ open: false })
  /** Which accrual's lifecycle drawer is open (null = closed). */
  const [drawerItem, setDrawerItem] = useState<AccrualItem | null>(null)

  const { data: itemsResp, isLoading: itemsLoading } = useQuery({
    queryKey: ["schedules", "accrual", "items", filterAccount],
    queryFn:  () => schedulesApi.listItems("accrual", { qbo_account_id: filterAccount || undefined }),
  })
  const items = itemsResp?.items ?? []

  const { data: snapshot, isLoading: snapshotLoading } = useQuery({
    queryKey: ["schedules", "accrual", "snapshot", filterAccount, periodEnd],
    queryFn:  () => schedulesApi.previewSnapshot("accrual", filterAccount, periodEnd),
    enabled:  !!filterAccount,
  })

  const commitMut = useMutation({
    mutationFn: () => schedulesApi.commitSnapshot("accrual", filterAccount, periodEnd),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["schedules"] }),
  })
  const deleteMut = useMutation({
    mutationFn: (id: string) => schedulesApi.deleteItem("accrual", id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["schedules"] }),
  })

  const totals = useMemo(() => {
    const total = items.filter((i) => i.is_active && !i.is_reversed)
      .reduce((s, i) => s + (parseFloat(i.amount) || 0), 0)
    return { total, active: items.filter((i) => i.is_active).length }
  }, [items])

  return (
    <div className="flex flex-col h-full overflow-y-auto" style={{ background: "var(--bg)" }}>
      <SchedulePageHeader
        type="accrual"
        icon={<ClipboardList size={20} strokeWidth={1.6} />}
        accent={{ fg: "#b45309", bg: "rgba(245, 158, 11, 0.12)" }}
        periodEnd={periodEnd}
        onPeriod={setPeriodEnd}
        onAddItem={() => setDialog({ open: true })}
        addLabel="Add accrual"
      />

      <div className="flex-1 px-4 sm:px-8 py-5 max-w-6xl w-full mx-auto space-y-5">
        <div className="rounded-xl p-4 flex items-end gap-4 flex-wrap"
          style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
          <AccountPicker value={filterAccount} onChange={setFilterAccount} mode="filter" label="GL account" />
          <Kpi label="Active accruals" value={fmt(totals.total.toString())} />
          <Kpi label="Items tracked" value={totals.active.toString()} />
        </div>

        <RollForwardCard
          snapshot={snapshot} isLoading={snapshotLoading} hasAccount={!!filterAccount}
          expenseLabel="(no expense)" paymentLabel="Reversed"
          onCommit={() => commitMut.mutate()}
          committing={commitMut.isPending}
          alreadyCommitted={!!snapshot?.committed}
        />

        <div className="rounded-xl overflow-hidden"
          style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
          <div className="px-5 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
            <p className="text-sm font-semibold text-theme">Accrued items</p>
            <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
              Each accrual stays on the BS until you mark it reversed (typically when paid).
            </p>
          </div>
          {itemsLoading ? (
            <div className="py-12 flex justify-center"><Spinner className="h-5 w-5" /></div>
          ) : items.length === 0 ? (
            <Empty onAdd={() => setDialog({ open: true })} verb="accrual" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ background: "var(--surface-2)" }}>
                    <Th>Description</Th><Th>GL account</Th><Th>Vendor</Th><Th right>Amount</Th>
                    <Th>Accrued</Th><Th>Reverses</Th><Th>Status</Th><Th />
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
                      <Td>{it.vendor || "—"}</Td>
                      <Td right tabular>{fmt(it.amount)}</Td>
                      <Td><span className="text-[11px]" style={{ color: "var(--text-2)" }}>{it.accrual_date}</span></Td>
                      <Td><span className="text-[11px]" style={{ color: "var(--text-2)" }}>{it.reverses_on ?? "—"}</span></Td>
                      <Td>
                        {it.is_reversed ? (
                          <span className="inline-flex items-center gap-1 text-[10px] font-semibold"
                            style={{ color: "var(--text-muted)" }}>
                            <CheckCircle2 size={10} strokeWidth={2.4} />Reversed
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[10px] font-semibold"
                            style={{ color: "#b45309" }}>Active</span>
                        )}
                      </Td>
                      <Td>
                        <div className="inline-flex items-center gap-1.5 justify-end w-full">
                          <button
                            onClick={() => setDrawerItem(it)}
                            className="p-1 rounded hover:bg-[var(--surface-2)]"
                            title="View lifecycle: accrual JE + reversal JE">
                            <FileText size={13} strokeWidth={1.8} style={{ color: "#b45309" }} />
                          </button>
                          <RowActions onEdit={() => setDialog({ open: true, item: it })}
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
          <AccrualDialog existing={dialog.item} initialAccount={filterAccount}
            onClose={() => setDialog({ open: false })} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {drawerItem && (
          <AccrualReversalDrawer
            item={drawerItem}
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
      <p className="text-xs mb-4" style={{ color: "var(--text-muted)" }}>
        Add your first {verb} to start tracking.
      </p>
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

function AccrualDialog({ existing, onClose, initialAccount }: {
  existing?: AccrualItem; onClose: () => void; initialAccount: string
}) {
  const qc = useQueryClient()
  const [account, setAccount] = useState(existing?.qbo_account_id ?? initialAccount)
  const [description, setDescription] = useState(existing?.description ?? "")
  const [vendor, setVendor] = useState(existing?.vendor ?? "")
  const [reference, setReference] = useState(existing?.reference ?? "")
  const [accrualDate, setAccrualDate] = useState(existing?.accrual_date ?? "")
  const [amount, setAmount] = useState(existing?.amount ?? "")
  const [reversesOn, setReversesOn] = useState(existing?.reverses_on ?? "")
  const [isReversed, setIsReversed] = useState(existing?.is_reversed ?? false)
  const [notes, setNotes] = useState(existing?.notes ?? "")
  const [error, setError] = useState<string | null>(null)

  const mut = useMutation({
    mutationFn: (body: Partial<AccrualItem>) => existing
      ? schedulesApi.updateItem("accrual", existing.id, body)
      : schedulesApi.createItem("accrual", body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["schedules"] }); onClose() },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { detail?: string } } }).response?.data?.detail
      setError(msg ?? "Could not save.")
    },
  })

  function submit() {
    setError(null)
    if (!account || !description.trim() || !amount || !accrualDate) {
      setError("Account, description, amount, accrual date are all required.")
      return
    }
    mut.mutate({
      qbo_account_id: account, description: description.trim(),
      vendor: vendor.trim() || null, reference: reference.trim() || null,
      accrual_date: accrualDate, amount,
      reverses_on: reversesOn || null, is_reversed: isReversed,
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
        className="rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto"
        style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
        <div className="px-6 py-4 flex items-center justify-between"
          style={{ borderBottom: "1px solid var(--border)" }}>
          <h3 className="text-base font-semibold text-theme">{existing ? "Edit accrual" : "New accrual"}</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--surface-2)]">
            <X size={16} strokeWidth={1.8} style={{ color: "var(--text-muted)" }} />
          </button>
        </div>
        <div className="px-6 py-5 space-y-4">
          <AccountPicker mode="form" label="GL account" value={account} onChange={setAccount} />
          <Field label="Description *">
            <input value={description} onChange={(e) => setDescription(e.target.value)}
              placeholder="Q4 bonus accrual" className={inputCls} style={inputStyle} />
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Vendor / payee">
              <input value={vendor} onChange={(e) => setVendor(e.target.value)}
                className={inputCls} style={inputStyle} />
            </Field>
            <Field label="Reference">
              <input value={reference} onChange={(e) => setReference(e.target.value)}
                className={inputCls} style={inputStyle} />
            </Field>
            <Field label="Accrual date *">
              <DatePicker value={accrualDate || ""} onChange={setAccrualDate}
                triggerClassName="w-full rounded-lg px-3 py-2 text-sm border outline-none" />
            </Field>
            <Field label="Amount *">
              <input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)}
                placeholder="5000.00" className={`${inputCls} text-right tabular-nums`} style={inputStyle} />
            </Field>
            <Field label="Reverses on (typically when paid)">
              <DatePicker value={reversesOn || ""} onChange={setReversesOn}
                triggerClassName="w-full rounded-lg px-3 py-2 text-sm border outline-none" />
            </Field>
            <Field label="Marked reversed?">
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={isReversed} onChange={(e) => setIsReversed(e.target.checked)}
                  className="h-4 w-4" style={{ accentColor: "var(--green)" }} />
                <span className="text-sm text-theme">Yes, this accrual has been paid / reversed</span>
              </label>
            </Field>
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
            {existing ? "Save changes" : "Add accrual"}
          </Button>
        </div>
      </motion.div>
    </motion.div>
  )
}
