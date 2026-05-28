/**
 * Prepaid Expenses schedule detail page.
 *
 * Pattern shared by all five schedule pages:
 *   1. Shared <SchedulePageHeader />
 *   2. Account filter + commit-snapshot section (RollForwardCard)
 *   3. Items table (type-specific columns)
 *   4. Add/Edit dialog (type-specific fields)
 *
 * The dialog is inline (not a separate file) because its fields are
 * tightly coupled to this type. Other types follow the same structure.
 */
import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { motion, AnimatePresence } from "framer-motion"
import { Calendar, Pencil, Trash2, X } from "lucide-react"

import { Button, Spinner } from "@/core/ui/components"
import { DatePicker } from "@/core/ui/DatePicker"
import { SchedulePageHeader } from "@/modules/schedules/components/SchedulePageHeader"
import { AccountPicker } from "@/modules/schedules/components/AccountPicker"
import { RollForwardCard } from "@/modules/schedules/components/RollForwardCard"
import { schedulesApi } from "@/modules/schedules/api"
import type { PrepaidItem } from "@/modules/schedules/types"

function defaultPeriodEnd(): string {
  const now = new Date()
  const last = new Date(now.getFullYear(), now.getMonth(), 0)
  return last.toISOString().slice(0, 10)
}

function fmt(s: string | null | undefined): string {
  const n = parseFloat(s ?? "0") || 0
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function monthlyAmount(total: string, start: string, end: string): string {
  const t = parseFloat(total) || 0
  const s = start ? new Date(start) : null
  const e = end ? new Date(end) : null
  if (!s || !e || isNaN(s.getTime()) || isNaN(e.getTime())) return "$0.00"
  const months = Math.max(
    1,
    (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth()) + 1,
  )
  return `$${(t / months).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function PrepaidsPage() {
  const qc = useQueryClient()
  const [periodEnd, setPeriodEnd] = useState<string>(defaultPeriodEnd())
  const [filterAccount, setFilterAccount] = useState<string>("")
  const [dialogState, setDialogState] = useState<{ open: boolean; item?: PrepaidItem }>({ open: false })

  const { data: itemsResp, isLoading: itemsLoading } = useQuery({
    queryKey: ["schedules", "prepaid", "items", filterAccount],
    queryFn:  () => schedulesApi.listItems("prepaid", { qbo_account_id: filterAccount || undefined }),
  })
  const items = itemsResp?.items ?? []

  const { data: snapshot, isLoading: snapshotLoading } = useQuery({
    queryKey: ["schedules", "prepaid", "snapshot", filterAccount, periodEnd],
    queryFn:  () => schedulesApi.previewSnapshot("prepaid", filterAccount, periodEnd),
    enabled:  !!filterAccount,
  })

  const commitMut = useMutation({
    mutationFn: () => schedulesApi.commitSnapshot("prepaid", filterAccount, periodEnd),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["schedules"] }),
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => schedulesApi.deleteItem("prepaid", id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["schedules"] }),
  })

  const totals = useMemo(() => {
    const total = items.reduce((s, i) => s + (parseFloat(i.total_amount) || 0), 0)
    const active = items.filter((i) => i.is_active).length
    return { total, active }
  }, [items])

  return (
    <div className="flex flex-col h-full overflow-y-auto" style={{ background: "var(--bg)" }}>
      <SchedulePageHeader
        type="prepaid"
        icon={<Calendar size={20} strokeWidth={1.6} />}
        accent={{ fg: "#1d4ed8", bg: "rgba(29, 78, 216, 0.10)" }}
        periodEnd={periodEnd}
        onPeriod={setPeriodEnd}
        onAddItem={() => setDialogState({ open: true })}
        addLabel="Add prepaid"
      />

      <div className="flex-1 px-4 sm:px-8 py-5 max-w-6xl w-full mx-auto space-y-5">
        {/* Filter + KPIs */}
        <div className="rounded-xl p-4 flex items-end gap-4 flex-wrap"
          style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
          <AccountPicker
            value={filterAccount}
            onChange={setFilterAccount}
            mode="filter"
            label="GL account"
          />
          <Kpi label="Total prepaid" value={fmt(totals.total.toString())} />
          <Kpi label="Active items" value={totals.active.toString()} />
          {filterAccount && snapshot && (
            <Kpi label="Amortization this period" value={fmt(snapshot.period_expense)} amber />
          )}
        </div>

        {/* Roll-forward */}
        <RollForwardCard
          snapshot={snapshot}
          isLoading={snapshotLoading}
          hasAccount={!!filterAccount}
          expenseLabel="Amortization"
          paymentLabel="Payments"
          onCommit={() => commitMut.mutate()}
          committing={commitMut.isPending}
          alreadyCommitted={!!snapshot?.committed}
        />

        {/* Items table */}
        <div className="rounded-xl overflow-hidden"
          style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
          <div className="px-5 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
            <p className="text-sm font-semibold text-theme">Prepaid items</p>
            <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
              Each item is amortized straight-line over its [start → end] window.
            </p>
          </div>
          {itemsLoading ? (
            <div className="py-12 flex justify-center"><Spinner className="h-5 w-5" /></div>
          ) : items.length === 0 ? (
            <div className="py-12 px-6 text-center">
              <p className="text-sm font-semibold text-theme mb-1">No prepaid items yet</p>
              <p className="text-xs mb-4" style={{ color: "var(--text-muted)" }}>
                Add your first prepaid invoice — Nordavix will compute the monthly amortization automatically.
              </p>
              <Button size="sm" onClick={() => setDialogState({ open: true })}>Add prepaid</Button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ background: "var(--surface-2)" }}>
                    <Th>Description</Th>
                    <Th>Vendor</Th>
                    <Th right>Total</Th>
                    <Th>Window</Th>
                    <Th right>Monthly</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {items.map((it) => (
                    <tr key={it.id} style={{ borderTop: "1px solid var(--border)", opacity: it.is_active ? 1 : 0.5 }}>
                      <Td>
                        <div className="text-theme">{it.description}</div>
                        {it.reference && (
                          <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                            Ref: {it.reference}
                          </div>
                        )}
                      </Td>
                      <Td>{it.vendor || "—"}</Td>
                      <Td right tabular>{fmt(it.total_amount)}</Td>
                      <Td>
                        <span className="text-[11px]" style={{ color: "var(--text-2)" }}>
                          {it.start_date} → {it.end_date}
                        </span>
                      </Td>
                      <Td right tabular>{monthlyAmount(it.total_amount, it.start_date, it.end_date)}</Td>
                      <Td>
                        <div className="inline-flex items-center gap-1.5 justify-end w-full">
                          <button
                            onClick={() => setDialogState({ open: true, item: it })}
                            className="p-1 rounded hover:bg-[var(--surface-2)]"
                            title="Edit">
                            <Pencil size={13} strokeWidth={1.8} style={{ color: "var(--text-muted)" }} />
                          </button>
                          <button
                            onClick={() => { if (window.confirm(`Delete "${it.description}"?`)) deleteMut.mutate(it.id) }}
                            className="p-1 rounded hover:bg-[var(--surface-2)]"
                            title="Delete">
                            <Trash2 size={13} strokeWidth={1.8} style={{ color: "#b91c1c" }} />
                          </button>
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
        {dialogState.open && (
          <PrepaidDialog
            existing={dialogState.item}
            onClose={() => setDialogState({ open: false })}
            initialAccount={filterAccount}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

// ── Inline KPI / table helpers ──────────────────────────────────────────

function Kpi({ label, value, amber }: { label: string; value: string; amber?: boolean }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider"
        style={{ color: "var(--text-muted)" }}>{label}</p>
      <p className="text-base font-bold tabular-nums mt-0.5"
        style={{ color: amber ? "#b45309" : "var(--text)" }}>{value}</p>
    </div>
  )
}

function Th({ children, right }: { children?: React.ReactNode; right?: boolean }) {
  return (
    <th className={`px-3 py-2 text-[10px] font-semibold uppercase tracking-wide ${right ? "text-right" : "text-left"}`}
      style={{ color: "var(--text-muted)" }}>
      {children}
    </th>
  )
}

function Td({ children, right, tabular }: { children?: React.ReactNode; right?: boolean; tabular?: boolean }) {
  return (
    <td className={`px-3 py-2 ${right ? "text-right" : ""} ${tabular ? "tabular-nums" : ""}`}>
      {children}
    </td>
  )
}

// ── Dialog ──────────────────────────────────────────────────────────────

function PrepaidDialog({ existing, onClose, initialAccount }: {
  existing?:       PrepaidItem
  onClose:         () => void
  initialAccount:  string
}) {
  const qc = useQueryClient()
  const [account,   setAccount]   = useState(existing?.qbo_account_id ?? initialAccount)
  const [description, setDescription] = useState(existing?.description ?? "")
  const [vendor,    setVendor]    = useState(existing?.vendor ?? "")
  const [reference, setReference] = useState(existing?.reference ?? "")
  const [invoiceDate, setInvoiceDate] = useState(existing?.invoice_date ?? "")
  const [totalAmount, setTotalAmount] = useState(existing?.total_amount ?? "")
  const [startDate, setStartDate] = useState(existing?.start_date ?? "")
  const [endDate,   setEndDate]   = useState(existing?.end_date ?? "")
  const [notes,     setNotes]     = useState(existing?.notes ?? "")
  const [error,     setError]     = useState<string | null>(null)

  const mut = useMutation({
    mutationFn: (body: Partial<PrepaidItem>) => existing
      ? schedulesApi.updateItem("prepaid", existing.id, body)
      : schedulesApi.createItem("prepaid", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["schedules"] })
      onClose()
    },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { detail?: string } } }).response?.data?.detail
      setError(msg ?? "Could not save the prepaid item.")
    },
  })

  function submit() {
    setError(null)
    if (!account) { setError("Pick an account."); return }
    if (!description.trim()) { setError("Description is required."); return }
    if (!totalAmount || !startDate || !endDate) {
      setError("Total amount, start date, and end date are all required.")
      return
    }
    mut.mutate({
      qbo_account_id: account,
      description:    description.trim(),
      vendor:         vendor.trim() || null,
      reference:      reference.trim() || null,
      invoice_date:   invoiceDate || null,
      total_amount:   totalAmount,
      start_date:     startDate,
      end_date:       endDate,
      notes:          notes.trim() || null,
      is_active:      true,
    })
  }

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.6)" }}
      onClick={onClose}>
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
        className="rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto"
        style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
        <div className="px-6 py-4 flex items-center justify-between"
          style={{ borderBottom: "1px solid var(--border)" }}>
          <h3 className="text-base font-semibold text-theme">
            {existing ? "Edit prepaid item" : "New prepaid item"}
          </h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--surface-2)]">
            <X size={16} strokeWidth={1.8} style={{ color: "var(--text-muted)" }} />
          </button>
        </div>
        <div className="px-6 py-5 space-y-4">
          <AccountPicker mode="form" label="GL account" value={account} onChange={setAccount} />
          <Field label="Description *">
            <input value={description} onChange={(e) => setDescription(e.target.value)}
              placeholder="GL Insurance — Annual" className={inputCls} style={inputStyle} />
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Vendor">
              <input value={vendor} onChange={(e) => setVendor(e.target.value)} className={inputCls} style={inputStyle} />
            </Field>
            <Field label="Invoice / Ref">
              <input value={reference} onChange={(e) => setReference(e.target.value)} className={inputCls} style={inputStyle} />
            </Field>
            <Field label="Invoice date">
              <DatePicker value={invoiceDate || ""} onChange={setInvoiceDate}
                triggerClassName="w-full rounded-lg px-3 py-2 text-sm border outline-none" />
            </Field>
            <Field label="Total amount *">
              <input type="number" step="0.01" value={totalAmount}
                onChange={(e) => setTotalAmount(e.target.value)}
                placeholder="12000.00" className={`${inputCls} text-right tabular-nums`} style={inputStyle} />
            </Field>
            <Field label="Start date * (amortization begins)">
              <DatePicker value={startDate || ""} onChange={setStartDate}
                triggerClassName="w-full rounded-lg px-3 py-2 text-sm border outline-none" />
            </Field>
            <Field label="End date * (amortization ends)">
              <DatePicker value={endDate || ""} onChange={setEndDate}
                triggerClassName="w-full rounded-lg px-3 py-2 text-sm border outline-none" />
            </Field>
          </div>
          {/* Live calc */}
          {totalAmount && startDate && endDate && (
            <div className="rounded-lg p-3 text-xs"
              style={{ background: "var(--green-subtle)", color: "var(--green)", border: "1px solid var(--green)" }}>
              Monthly amortization will be <span className="font-bold">{monthlyAmount(totalAmount, startDate, endDate)}</span>.
            </div>
          )}
          <Field label="Notes">
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={inputCls} style={inputStyle} />
          </Field>
          {error && <p className="text-xs" style={{ color: "#b91c1c" }}>{error}</p>}
        </div>
        <div className="px-6 py-3 flex items-center justify-end gap-2"
          style={{ borderTop: "1px solid var(--border)", background: "var(--surface-2)" }}>
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" loading={mut.isPending} onClick={submit}>
            {existing ? "Save changes" : "Add prepaid"}
          </Button>
        </div>
      </motion.div>
    </motion.div>
  )
}

export const inputCls = "w-full rounded-lg px-3 py-2 text-sm outline-none"
export const inputStyle: React.CSSProperties = {
  background: "var(--surface-2)",
  border: "1px solid var(--border-strong)",
  color: "var(--text)",
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[10px] font-semibold uppercase tracking-wide block mb-1"
        style={{ color: "var(--text-muted)" }}>{label}</span>
      {children}
    </label>
  )
}
