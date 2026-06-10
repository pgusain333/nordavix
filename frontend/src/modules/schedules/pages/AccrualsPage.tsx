/**
 * Accrued Expenses schedule detail page. See PrepaidsPage for pattern docs.
 */
import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { motion, AnimatePresence } from "framer-motion"
import { ClipboardList, FileText, Pencil, Trash2, X, CheckCircle2 } from "lucide-react"

import { Button, Spinner } from "@/core/ui/components"
import { DatePicker } from "@/core/ui/DatePicker"
import { useScheduleOptimistic } from "@/modules/schedules/optimistic"
import { SchedulePageHeader } from "@/modules/schedules/components/SchedulePageHeader"
import { AccountPicker } from "@/modules/schedules/components/AccountPicker"
import { RollForwardCard } from "@/modules/schedules/components/RollForwardCard"
import { AccrualReversalDrawer } from "@/modules/schedules/components/AccrualReversalDrawer"
import { GlAccountCell } from "@/modules/schedules/components/GlAccountCell"
import { AiDetectMissedAccrualsBanner } from "@/modules/schedules/components/AiDetectMissedAccrualsBanner"
import { UnreversedAccrualsBanner } from "@/modules/schedules/components/UnreversedAccrualsBanner"
import { ImportScheduleFromQboBanner, ImportTh, importMoneyFmt } from "@/modules/schedules/components/ImportScheduleFromQboBanner"
import type { AccrualImportPreview } from "@/modules/schedules/api"
import { useSelectedPeriodDefault } from "@/core/hooks/useSelectedPeriod"
import { schedulesApi } from "@/modules/schedules/api"
import { formatDate } from "@/core/lib/dates"
import type { AccrualItem, MissedAccrualCandidate } from "@/modules/schedules/types"
import { Field, inputCls, inputStyle } from "@/modules/schedules/pages/PrepaidsPage"

/**
 * Pre-fill payload for the New Accrual dialog when the user is creating
 * from a missed-accrual AI candidate (or future renewal-style flows).
 * Same shape philosophy as PrepaidPrefill in PrepaidsPage.tsx — loose
 * optional fields; the dialog falls back to blank for anything missing.
 */
interface AccrualPrefill {
  qbo_account_id?: string
  vendor?:         string
  description?:    string
  reference?:      string
  accrual_date?:   string
  reverses_on?:    string
  amount?:         string
  notes?:          string
  /** UI flag — shows an "AI-detected" chip in the dialog header. */
  source?:         "ai-missed" | "manual"
  sourceLabel?:    string
  /** When the prefill is from an AI candidate, the dialog calls
   * acceptMissedAccrualCandidate on save to silence the source txn. */
  candidateId?:    string
}

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
  const [dialog, setDialog] = useState<{
    open: boolean
    item?: AccrualItem
    prefill?: AccrualPrefill
  }>({ open: false })
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
  const optimistic = useScheduleOptimistic("accrual")
  const deleteMut = useMutation({
    mutationFn: (id: string) => schedulesApi.deleteItem("accrual", id),
    onMutate:   (id)         => optimistic.beginDelete(id),
    onError:    (_e, _v, c)  => optimistic.rollback(c),
    onSettled:  ()           => optimistic.settle(),
  })

  const exportMut = useMutation({
    mutationFn: () => schedulesApi.downloadScheduleExcel("accrual", periodEnd),
  })

  const totals = useMemo(() => {
    const total = items.filter((i) => i.is_active && !i.is_reversed)
      .reduce((s, i) => s + (parseFloat(i.amount) || 0), 0)
    return { total, active: items.filter((i) => i.is_active).length }
  }, [items])

  /**
   * "Add accrual" click from the AI missed-accrual banner. The dialog
   * opens pre-filled with the candidate's data; on save the dialog
   * ALSO fires the accept API (via prefill.candidateId → mutation
   * onSuccess) so the banner stops re-surfacing this txn.
   *
   * Default dates:
   *   accrual_date = ai_service_period_end (typically the viewed
   *                  period_end — "you should have accrued at 03-31")
   *   reverses_on  = first of next month after accrual_date — the
   *                  conventional "reverse at start of next period"
   *                  so the actual payment offsets cleanly
   */
  function handleAcceptMissedCandidate(c: MissedAccrualCandidate) {
    const accrualDate = c.ai_service_period_end || c.period_end
    // Compute first-of-next-month for reverses_on
    const ad = new Date(accrualDate + "T00:00:00")
    const reverses = new Date(ad.getFullYear(), ad.getMonth() + 1, 1)
    const reversesIso = reverses.toISOString().slice(0, 10)

    const amount = c.ai_suggested_amount || c.gl_amount
    const vendor = c.ai_vendor || c.gl_vendor || ""
    const description = vendor
      ? `${vendor} — accrued for ${formatDate(accrualDate)} services`
      : (c.gl_memo || `Missed accrual from ${c.gl_account_name}`)

    setDialog({
      open: true,
      prefill: {
        // qbo_account_id left blank — gl_account_id is the EXPENSE
        // account where the payment hit. The new accrual should go
        // to an Accrued Liability account; user picks it.
        qbo_account_id: c.ai_target_account_id || undefined,
        vendor,
        description,
        amount,
        accrual_date: accrualDate,
        reverses_on: reversesIso,
        notes: (
          `Detected by AI — payment of $${parseFloat(c.gl_amount).toLocaleString()} ` +
          `on ${formatDate(c.gl_txn_date)} to ${c.gl_account_name} looks like work ` +
          `performed in or before ${formatDate(accrualDate)}.` +
          (c.ai_reasoning ? `\n\nAI reasoning: ${c.ai_reasoning}` : "")
        ),
        source: "ai-missed",
        sourceLabel: `AI-detected missed accrual from ${c.gl_account_name} ($${parseFloat(c.gl_amount).toLocaleString()})`,
        candidateId: c.id,
      },
    })
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto" style={{ background: "var(--bg)" }}>
      <SchedulePageHeader
        type="accrual"
        icon={<ClipboardList size={20} strokeWidth={1.6} />}
        accent={{ fg: "#8a6326", bg: "rgba(199, 154, 82, 0.12)" }}
        periodEnd={periodEnd}
        onPeriod={setPeriodEnd}
        onAddItem={() => setDialog({ open: true })}
        addLabel="Add accrual"
        onExport={() => exportMut.mutate()}
        exporting={exportMut.isPending}
      />

      <div className="flex-1 px-4 sm:px-8 py-5 max-w-6xl w-full mx-auto space-y-5">
        {/* First-month onboarding — pull existing accruals from QBO and
            bulk-create them as Nordavix schedule items. Only visible
            when an account is selected and there's a reason to show it. */}
        <ImportScheduleFromQboBanner
          qboAccountId={filterAccount}
          existingItemCount={items.length}
          config={{
            noun:        "accrual",
            nounPlural:  "accruals",
            defaultLookback: 12,
            lookbackChoices: [6, 12, 18, 24],
            blurb:       "Pulls every credit posted to this account in the last {lookback} months and creates a Nordavix accrual item for each — vendor, amount, and accrual date pre-filled from the QBO transaction. Default reverses on the 1st of next month; edit each row to refine.",
            defaultsHint: "Defaults: reverses on 1st of next month. Edit individual rows after import to set a different reversal date.",
            queryKey:    ["schedules", "accrual"],
            preview:     schedulesApi.previewImportAccrualsFromQbo,
            doImport:    schedulesApi.importAccrualsFromQbo,
            wouldCreate: (p) => (p as AccrualImportPreview).would_create,
            skipped:     (p) => (p as AccrualImportPreview).skipped,
            itemCount:   (p) => (p as AccrualImportPreview).items.length,
            renderTable: (p) => {
              const preview = p as AccrualImportPreview
              return (
                <table className="w-full text-xs">
                  <thead className="sticky top-0" style={{ background: "var(--surface-2)" }}>
                    <tr>
                      <ImportTh>Description</ImportTh>
                      <ImportTh>Vendor</ImportTh>
                      <ImportTh>Accrual date</ImportTh>
                      <ImportTh right>Amount</ImportTh>
                      <ImportTh>Reverses on</ImportTh>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.items.map((it, i) => (
                      <tr key={i} style={{ borderTop: "1px solid var(--border)" }}>
                        <td className="px-3 py-2 text-theme">
                          <div className="font-medium">{it.description}</div>
                          {it.reference && (
                            <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>Ref: {it.reference}</div>
                          )}
                        </td>
                        <td className="px-3 py-2" style={{ color: "var(--text-2)" }}>{it.vendor ?? "—"}</td>
                        <td className="px-3 py-2" style={{ color: "var(--text-2)" }}>{formatDate(it.accrual_date)}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-semibold text-theme">{importMoneyFmt(it.amount)}</td>
                        <td className="px-3 py-2 text-[11px]" style={{ color: "var(--text-2)" }}>{it.reverses_on ? formatDate(it.reverses_on) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            },
          }}
        />

        {/* AI: detect missed accruals (feature a) */}
        <AiDetectMissedAccrualsBanner
          periodEnd={periodEnd}
          onAccept={handleAcceptMissedCandidate}
        />

        {/* AI: unreversed accrual checker (feature d) */}
        <UnreversedAccrualsBanner periodEnd={periodEnd} />

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
          stale={!!snapshot?.stale}
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
                            style={{ color: "#8a6326" }}>Active</span>
                        )}
                      </Td>
                      <Td>
                        <div className="inline-flex items-center gap-1.5 justify-end w-full">
                          <button
                            onClick={() => setDrawerItem(it)}
                            className="p-1 rounded hover:bg-[var(--surface-2)]"
                            title="View lifecycle: accrual JE + reversal JE">
                            <FileText size={13} strokeWidth={1.8} style={{ color: "#8a6326" }} />
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
          <AccrualDialog
            existing={dialog.item}
            prefill={dialog.prefill}
            initialAccount={filterAccount}
            onClose={() => setDialog({ open: false })}
          />
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
        <Trash2 size={13} strokeWidth={1.8} style={{ color: "#9b3d37" }} />
      </button>
    </div>
  )
}

function AccrualDialog({ existing, prefill, onClose, initialAccount }: {
  existing?:      AccrualItem
  prefill?:       AccrualPrefill
  onClose:        () => void
  initialAccount: string
}) {
  const qc = useQueryClient()
  // Pre-fill: existing (edit) wins; prefill (AI / future) provides a
  // pre-populated new item; blank/filter-account is the manual fallback.
  const [account, setAccount] = useState(existing?.qbo_account_id ?? prefill?.qbo_account_id ?? initialAccount)
  const [description, setDescription] = useState(existing?.description ?? prefill?.description ?? "")
  const [vendor, setVendor] = useState(existing?.vendor ?? prefill?.vendor ?? "")
  const [reference, setReference] = useState(existing?.reference ?? prefill?.reference ?? "")
  const [accrualDate, setAccrualDate] = useState(existing?.accrual_date ?? prefill?.accrual_date ?? "")
  const [amount, setAmount] = useState(existing?.amount ?? prefill?.amount ?? "")
  const [reversesOn, setReversesOn] = useState(existing?.reverses_on ?? prefill?.reverses_on ?? "")
  const [isReversed, setIsReversed] = useState(existing?.is_reversed ?? false)
  const [notes, setNotes] = useState(existing?.notes ?? prefill?.notes ?? "")
  // Offset (expense) account — the P&L account this accrual books to.
  const [offsetAccount, setOffsetAccount] = useState(existing?.offset_qbo_account_id ?? "")
  const [error, setError] = useState<string | null>(null)

  const optimistic = useScheduleOptimistic("accrual")
  const mut = useMutation({
    mutationFn: (body: Partial<AccrualItem>) => existing
      ? schedulesApi.updateItem("accrual", existing.id, body)
      : schedulesApi.createItem("accrual", body),
    onMutate: (body) => {
      if (existing) {
        return optimistic.beginUpdate(existing.id, body as Record<string, unknown>)
      }
      const tempId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      return optimistic.beginCreate({ id: tempId, ...(body as Record<string, unknown>) })
    },
    onSuccess: async (created) => {
      // If this came from an AI missed-accrual candidate, silence
      // the source GL txn so re-scans skip it. Fire-and-forget —
      // a failure here doesn't block the create.
      if (!existing && prefill?.candidateId && (created as AccrualItem)?.id) {
        try {
          await schedulesApi.acceptMissedAccrualCandidate(
            prefill.candidateId,
            (created as AccrualItem).id,
          )
          qc.invalidateQueries({ queryKey: ["schedules", "accrual", "ai-missed"] })
        } catch { /* harmless — accrual is saved */ }
      }
      onClose()
    },
    onError: (e: unknown, _vars, ctx) => {
      optimistic.rollback(ctx)
      const msg = (e as { response?: { data?: { detail?: string } } }).response?.data?.detail
      setError(msg ?? "Could not save.")
    },
    onSettled: () => optimistic.settle(),
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
      offset_qbo_account_id: offsetAccount || null,
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
          <div className="flex items-center gap-2 min-w-0">
            <h3 className="text-base font-semibold text-theme">{existing ? "Edit accrual" : "New accrual"}</h3>
            {!existing && prefill?.source === "ai-missed" && (
              <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
                style={{ background: "rgba(84, 88, 138, 0.12)", color: "#54588a" }}>
                ✨ AI-detected
              </span>
            )}
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--surface-2)]">
            <X size={16} strokeWidth={1.8} style={{ color: "var(--text-muted)" }} />
          </button>
        </div>
        <div className="px-6 py-5 space-y-4">
          {!existing && prefill?.sourceLabel && (
            <div className="rounded-lg px-3 py-2 text-[11px] flex items-start gap-2"
              style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
              <span className="shrink-0 mt-px">✨</span>
              <span>
                Pre-filled from <span className="font-semibold">{prefill.sourceLabel}</span>.
                {" "}Adjust any field — your edits override the suggestion. Pick the correct{" "}
                <span className="font-semibold">Accrued Liability</span> GL account below.
              </span>
            </div>
          )}
          <AccountPicker mode="form" label="GL account (accrued liability)" value={account} onChange={setAccount} />
          <div>
            <AccountPicker mode="form" kind="expense" label="Expense account (accrues to)" value={offsetAccount} onChange={setOffsetAccount} />
            <p className="text-[10px] mt-1" style={{ color: "var(--text-muted)" }}>
              The P&amp;L account this accrual books to. Used to draft the proposed adjusting entries
              (Dr Expense / Cr Accrued liability). Optional.
            </p>
          </div>
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
          {error && <p className="text-xs" style={{ color: "#9b3d37" }}>{error}</p>}
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
