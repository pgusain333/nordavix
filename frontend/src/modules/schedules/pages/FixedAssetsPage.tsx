/**
 * Fixed Assets schedule detail page. See PrepaidsPage for pattern docs.
 *
 * Roll-forward shows cost beginning + additions − disposals = ending,
 * with period depreciation as the "expense" line. Accumulated depreciation
 * is a separate GL account (contra-asset), tracked via the
 * accumulated_dep_qbo_account_id field on each item.
 */
import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { motion, AnimatePresence } from "framer-motion"
import { Building2, FileText, Pencil, Trash2, X } from "lucide-react"

import { Button, Spinner } from "@/core/ui/components"
import { DatePicker } from "@/core/ui/DatePicker"
import { useScheduleOptimistic } from "@/modules/schedules/optimistic"
import { SchedulePageHeader } from "@/modules/schedules/components/SchedulePageHeader"
import { AccountPicker } from "@/modules/schedules/components/AccountPicker"
import { LearnedDefaultChip } from "@/modules/schedules/components/LearnedDefaultChip"
import { RollForwardCard } from "@/modules/schedules/components/RollForwardCard"
import { ScheduleItemDrawer } from "@/modules/schedules/components/ScheduleItemDrawer"
import { GlAccountCell } from "@/modules/schedules/components/GlAccountCell"
import { AiDetectFixedAssetBanner } from "@/modules/schedules/components/AiDetectFixedAssetBanner"
import { ImportScheduleFromQboBanner, ImportTh, importMoneyFmt } from "@/modules/schedules/components/ImportScheduleFromQboBanner"
import type { FixedAssetImportPreview } from "@/modules/schedules/api"
import { useSelectedPeriodDefault } from "@/core/hooks/useSelectedPeriod"
import { schedulesApi } from "@/modules/schedules/api"
import { formatDate } from "@/core/lib/dates"
import type { FixedAssetCandidate, FixedAssetItem } from "@/modules/schedules/types"
import { Field, inputCls, inputStyle } from "@/modules/schedules/pages/PrepaidsPage"

/**
 * Pre-fill payload for the FADialog when the user is capitalizing an
 * AI-detected candidate. All fields are optional — the dialog falls
 * back to its blank defaults for anything not provided.
 */
interface FixedAssetPrefill {
  qbo_account_id?:     string
  description?:        string
  category?:           string
  vendor?:             string
  reference?:          string
  in_service_date?:    string
  cost?:               string
  salvage_value?:      string
  useful_life_months?: number
  notes?:              string
  source?:             "ai-detect"
  sourceLabel?:        string
  /** When set, the dialog fires schedulesApi.acceptFixedAssetCandidate
   * on save so the banner stops re-surfacing the source GL txn. */
  candidateId?:        string
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
function monthlyDep(cost: string, salvage: string, life: number): string {
  const c = parseFloat(cost) || 0, s = parseFloat(salvage) || 0
  if (life < 1) return "$0.00"
  return `$${((c - s) / life).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function FixedAssetsPage() {
  const qc = useQueryClient()
  const [periodEnd, setPeriodEnd] = useState<string>(useSelectedPeriodDefault(defaultPeriodEnd()))
  const [filterAccount, setFilterAccount] = useState<string>("")
  const [dialog, setDialog] = useState<{
    open:    boolean
    item?:   FixedAssetItem
    prefill?: FixedAssetPrefill
  }>({ open: false })
  const [drawerItem, setDrawerItem] = useState<FixedAssetItem | null>(null)

  /**
   * "Capitalize" click from AiDetectFixedAssetBanner. Opens the FADialog
   * pre-filled with the candidate's data — including AI-suggested
   * category (Computer Hardware / Office Furniture / etc.) and useful
   * life. On save, the dialog ALSO fires the accept API (via
   * prefill.candidateId → mutation onSuccess) so the banner stops
   * re-surfacing this txn.
   *
   * Account selection intentionally left blank — the candidate's
   * gl_account_id points to the EXPENSE account where the txn was
   * mis-booked. The user picks the correct Asset GL account (e.g.
   * "Computer Hardware — Cost") when saving.
   */
  function handleAcceptCandidate(c: FixedAssetCandidate) {
    const description = c.ai_description
      || (c.ai_vendor ? `${c.ai_vendor} — ${c.ai_category ?? "fixed asset"}` : null)
      || c.gl_memo
      || `Capitalized from ${c.gl_account_name}`
    const inServiceDate = c.ai_in_service_date || c.gl_txn_date
    const cost = c.ai_cost ?? c.gl_amount

    setDialog({
      open: true,
      prefill: {
        qbo_account_id:     undefined,  // user picks the Asset GL account
        description,
        category:           c.ai_category ?? undefined,
        vendor:             c.ai_vendor || c.gl_vendor || undefined,
        in_service_date:    inServiceDate,
        cost,
        salvage_value:      c.ai_salvage_value ?? "0",
        useful_life_months: c.ai_useful_life_months ?? undefined,
        notes: (
          `Detected by AI from GL entry on ${formatDate(c.gl_txn_date)}: ` +
          `$${parseFloat(c.gl_amount).toLocaleString()} to ${c.gl_account_name}.` +
          (c.ai_reasoning ? `\n\nAI reasoning: ${c.ai_reasoning}` : "")
        ),
        source:      "ai-detect",
        sourceLabel: `AI-detected from ${c.gl_account_name} ($${parseFloat(c.gl_amount).toLocaleString()})`,
        candidateId: c.id,
      },
    })
  }

  const { data: itemsResp, isLoading: itemsLoading } = useQuery({
    queryKey: ["schedules", "fixed_asset", "items", filterAccount],
    queryFn:  () => schedulesApi.listItems("fixed_asset", { qbo_account_id: filterAccount || undefined }),
  })
  const items = itemsResp?.items ?? []

  const { data: snapshot, isLoading: snapshotLoading } = useQuery({
    queryKey: ["schedules", "fixed_asset", "snapshot", filterAccount, periodEnd],
    queryFn:  () => schedulesApi.previewSnapshot("fixed_asset", filterAccount, periodEnd),
    enabled:  !!filterAccount,
  })

  const commitMut = useMutation({
    mutationFn: () => schedulesApi.commitSnapshot("fixed_asset", filterAccount, periodEnd),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["schedules"] }),
  })
  const optimistic = useScheduleOptimistic("fixed_asset")
  const deleteMut = useMutation({
    mutationFn: (id: string) => schedulesApi.deleteItem("fixed_asset", id),
    onMutate:   (id)         => optimistic.beginDelete(id),
    onError:    (_e, _v, c)  => optimistic.rollback(c),
    onSettled:  ()           => optimistic.settle(),
  })

  const exportMut = useMutation({
    mutationFn: () => schedulesApi.downloadScheduleExcel("fixed_asset", periodEnd),
  })

  const totals = useMemo(() => {
    const cost = items.filter((i) => i.is_active && !i.disposed_on)
      .reduce((s, i) => s + (parseFloat(i.cost) || 0), 0)
    return { cost, active: items.filter((i) => i.is_active).length }
  }, [items])

  return (
    <div className="flex flex-col h-full overflow-y-auto" style={{ background: "var(--bg)" }}>
      <SchedulePageHeader
        type="fixed_asset"
        icon={<Building2 size={20} strokeWidth={1.6} />}
        accent={{ fg: "#2e7a55", bg: "rgba(46, 122, 85, 0.10)" }}
        periodEnd={periodEnd} onPeriod={setPeriodEnd}
        onAddItem={() => setDialog({ open: true })} addLabel="Add asset"
        onExport={() => exportMut.mutate()}
        exporting={exportMut.isPending}
      />

      <div className="flex-1 px-4 sm:px-8 py-5 max-w-6xl w-full mx-auto space-y-5">
        {/* AI capitalization-miss detection — scans expense GL for items
            that should have been capitalized rather than expensed. */}
        <AiDetectFixedAssetBanner
          periodEnd={periodEnd}
          onAccept={handleAcceptCandidate}
        />

        {/* First-month onboarding — pull existing capitalized assets from
            the cost account. Each debit becomes a Nordavix fixed asset
            with sensible SL-60mo defaults the user can edit. */}
        <ImportScheduleFromQboBanner
          qboAccountId={filterAccount}
          existingItemCount={items.length}
          config={{
            noun:        "fixed asset",
            nounPlural:  "fixed assets",
            defaultLookback: 24,
            lookbackChoices: [12, 24, 36, 60],
            blurb:       "Pulls every debit posted to this cost account in the last {lookback} months and creates a Nordavix fixed asset for each — vendor, cost, and in-service date pre-filled from the QBO transaction. Default useful life 60 months (5 years), straight-line, no salvage. Edit any row to refine.",
            defaultsHint: "Defaults: 60-month straight-line depreciation, $0 salvage. Edit individual rows after import to set per-asset terms.",
            queryKey:    ["schedules", "fixed_asset"],
            preview:     (id, mo) => schedulesApi.previewImportFixedAssetsFromQbo(id, mo, 60),
            doImport:    (id, mo) => schedulesApi.importFixedAssetsFromQbo(id, mo, 60),
            wouldCreate: (p) => (p as FixedAssetImportPreview).would_create,
            skipped:     (p) => (p as FixedAssetImportPreview).skipped,
            itemCount:   (p) => (p as FixedAssetImportPreview).items.length,
            renderTable: (p) => {
              const preview = p as FixedAssetImportPreview
              return (
                <table className="w-full text-xs">
                  <thead className="sticky top-0" style={{ background: "var(--surface-2)" }}>
                    <tr>
                      <ImportTh>Description</ImportTh>
                      <ImportTh>Vendor</ImportTh>
                      <ImportTh>In service</ImportTh>
                      <ImportTh right>Cost</ImportTh>
                      <ImportTh>Useful life</ImportTh>
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
                        <td className="px-3 py-2" style={{ color: "var(--text-2)" }}>{formatDate(it.in_service_date)}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-semibold text-theme">{importMoneyFmt(it.cost)}</td>
                        <td className="px-3 py-2 text-[11px]" style={{ color: "var(--text-2)" }}>{it.useful_life_months} mo · SL</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            },
          }}
        />

        <div className="rounded-xl p-4 flex items-end gap-4 flex-wrap"
          style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
          <AccountPicker value={filterAccount} onChange={setFilterAccount} mode="filter" label="Cost (asset) GL account" />
          <Kpi label="Total cost (active)" value={fmt(totals.cost.toString())} />
          <Kpi label="Active assets" value={totals.active.toString()} />
        </div>

        <RollForwardCard
          snapshot={snapshot} isLoading={snapshotLoading} hasAccount={!!filterAccount}
          expenseLabel="Depreciation" paymentLabel="Disposals"
          onCommit={() => commitMut.mutate()} committing={commitMut.isPending}
          alreadyCommitted={!!snapshot?.committed}
          stale={!!snapshot?.stale}
        />

        <div className="rounded-xl overflow-hidden"
          style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
          <div className="px-5 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
            <p className="text-sm font-semibold text-theme">Fixed assets</p>
            <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
              Straight-line depreciation: (cost − salvage) ÷ useful life in months.
            </p>
          </div>
          {itemsLoading ? (
            <div className="py-12 flex justify-center"><Spinner className="h-5 w-5" /></div>
          ) : items.length === 0 ? (
            <Empty onAdd={() => setDialog({ open: true })} verb="asset" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ background: "var(--surface-2)" }}>
                    <Th>Asset</Th><Th>GL account</Th><Th>Category</Th><Th>In service</Th>
                    <Th right>Cost</Th><Th right>Salvage</Th><Th>Life</Th><Th right>Monthly dep.</Th><Th />
                  </tr>
                </thead>
                <tbody>
                  {items.map((it) => (
                    <tr key={it.id} style={{ borderTop: "1px solid var(--border)", opacity: it.is_active ? 1 : 0.5 }}>
                      <Td>
                        <div className="text-theme">{it.description}</div>
                        {it.reference && (
                          <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>Tag: {it.reference}</div>
                        )}
                        {it.disposed_on && (
                          <div className="text-[10px] font-semibold" style={{ color: "#9b3d37" }}>
                            Disposed {it.disposed_on}
                          </div>
                        )}
                      </Td>
                      <Td><GlAccountCell qboAccountId={it.qbo_account_id} /></Td>
                      <Td>{it.category || "—"}</Td>
                      <Td><span className="text-[11px]" style={{ color: "var(--text-2)" }}>{it.in_service_date}</span></Td>
                      <Td right tabular>{fmt(it.cost)}</Td>
                      <Td right tabular>{fmt(it.salvage_value)}</Td>
                      <Td><span className="text-[11px]" style={{ color: "var(--text-2)" }}>{it.useful_life_months} mo</span></Td>
                      <Td right tabular>{monthlyDep(it.cost, it.salvage_value, it.useful_life_months)}</Td>
                      <Td>
                        <div className="inline-flex items-center gap-1.5 justify-end w-full">
                          <button
                            onClick={() => setDrawerItem(it)}
                            className="p-1 rounded hover:bg-[var(--surface-2)]"
                            title="View depreciation schedule + JE">
                            <FileText size={13} strokeWidth={1.8} style={{ color: "#2e7a55" }} />
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
          <FADialog
            existing={dialog.item}
            prefill={dialog.prefill}
            initialAccount={filterAccount}
            onClose={() => setDialog({ open: false })}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {drawerItem && (
          <ScheduleItemDrawer
            variant={{ kind: "fixed_asset", item: drawerItem }}
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
      <p className="text-xs mb-4" style={{ color: "var(--text-muted)" }}>Add your first {verb} to start the depreciation roll-forward.</p>
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

function FADialog({ existing, prefill, onClose, initialAccount }: {
  existing?:       FixedAssetItem
  prefill?:        FixedAssetPrefill
  onClose:         () => void
  initialAccount:  string
}) {
  const qc = useQueryClient()
  // Pre-fill rules:
  //   - existing wins (we're editing, not creating)
  //   - prefill provides values for a new item (AI candidate)
  //   - blank/filter-account is the final fallback for a manual add
  const [account, setAccount] = useState(existing?.qbo_account_id ?? prefill?.qbo_account_id ?? initialAccount)
  const [accumAccount, setAccumAccount] = useState(existing?.accumulated_dep_qbo_account_id ?? "")
  const [description, setDescription] = useState(existing?.description ?? prefill?.description ?? "")
  const [category, setCategory] = useState(existing?.category ?? prefill?.category ?? "")
  const [vendor, setVendor] = useState(existing?.vendor ?? prefill?.vendor ?? "")
  const [reference, setReference] = useState(existing?.reference ?? prefill?.reference ?? "")
  const [inService, setInService] = useState(existing?.in_service_date ?? prefill?.in_service_date ?? "")
  const [cost, setCost] = useState(existing?.cost ?? prefill?.cost ?? "")
  const [salvage, setSalvage] = useState(existing?.salvage_value ?? prefill?.salvage_value ?? "0")
  const [life, setLife] = useState(
    existing?.useful_life_months?.toString()
    ?? prefill?.useful_life_months?.toString()
    ?? "60",
  )
  const [disposedOn, setDisposedOn] = useState(existing?.disposed_on ?? "")
  const [disposalProceeds, setDisposalProceeds] = useState(existing?.disposal_proceeds ?? "")
  const [notes, setNotes] = useState(existing?.notes ?? prefill?.notes ?? "")
  // Offset (depreciation expense) account — drives the proposed depreciation JE.
  const [offsetAccount, setOffsetAccount] = useState(existing?.offset_qbo_account_id ?? "")
  const [error, setError] = useState<string | null>(null)

  // Expense accounts (shares AccountPicker's cached query) — resolves the
  // offset (depreciation expense) account NAME so it's stored and learned.
  const { data: expenseAccts } = useQuery({
    queryKey: ["schedules", "accounts", "expense"],
    queryFn:  () => schedulesApi.listAccounts("expense"),
    staleTime: 5 * 60_000,
  })
  const offsetName = (id: string) => (expenseAccts ?? []).find((a) => a.qbo_account_id === id)?.name || null

  const optimistic = useScheduleOptimistic("fixed_asset")
  const mut = useMutation({
    mutationFn: (body: Partial<FixedAssetItem>) => existing
      ? schedulesApi.updateItem("fixed_asset", existing.id, body)
      : schedulesApi.createItem("fixed_asset", body),
    onMutate: (body) => {
      if (existing) {
        return optimistic.beginUpdate(existing.id, body as Record<string, unknown>)
      }
      const tempId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      return optimistic.beginCreate({ id: tempId, ...(body as Record<string, unknown>) })
    },
    onSuccess: async (created) => {
      // If this create came from an AI-detected capitalization candidate,
      // link the new asset back to the candidate so re-scans skip the
      // source GL txn. Fire-and-forget — a failure here doesn't block
      // the create (the asset is already saved).
      if (!existing && prefill?.candidateId && (created as FixedAssetItem)?.id) {
        try {
          await schedulesApi.acceptFixedAssetCandidate(
            prefill.candidateId,
            (created as FixedAssetItem).id,
          )
          qc.invalidateQueries({ queryKey: ["schedules", "fixed_asset", "ai-candidates"] })
        } catch {
          // Non-fatal — the asset exists. Worst case the banner re-
          // suggests on the next scan; the user can dismiss.
        }
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
    if (!account || !description.trim() || !cost || !inService || !life) {
      setError("Account, description, cost, in-service date, useful life are required.")
      return
    }
    mut.mutate({
      qbo_account_id: account,
      accumulated_dep_qbo_account_id: accumAccount || null,
      description: description.trim(), category: category.trim() || null,
      vendor: vendor.trim() || null, reference: reference.trim() || null,
      in_service_date: inService, cost, salvage_value: salvage || "0",
      useful_life_months: parseInt(life, 10),
      depreciation_method: "straight_line",
      disposed_on: disposedOn || null,
      disposal_proceeds: disposalProceeds || null,
      offset_qbo_account_id: offsetAccount || null,
      offset_account_name: offsetAccount ? offsetName(offsetAccount) : null,
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
          <div className="flex items-center gap-2 min-w-0">
            <h3 className="text-base font-semibold text-theme">{existing ? "Edit asset" : "New fixed asset"}</h3>
            {!existing && prefill?.source === "ai-detect" && (
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
                {" "}Pick the correct Asset GL account, review the category and useful life,
                then save.
              </span>
            </div>
          )}
          <LearnedDefaultChip
            scheduleType="fixed_asset" party={vendor} existing={!!existing}
            onApply={(d) => {
              if (d.offset_qbo_account_id) setOffsetAccount(String(d.offset_qbo_account_id))
              if (d.accumulated_dep_qbo_account_id) setAccumAccount(String(d.accumulated_dep_qbo_account_id))
              if (d.category) setCategory(String(d.category))
              if (d.useful_life_months) setLife(String(d.useful_life_months))
              if (!account && d.qbo_account_id) setAccount(String(d.qbo_account_id))
            }}
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <AccountPicker mode="form" label="Cost (asset) GL account" value={account} onChange={setAccount} />
            <AccountPicker mode="form" label="Accumulated depreciation GL account" value={accumAccount} onChange={setAccumAccount} />
            <AccountPicker mode="form" kind="expense" label="Depreciation expense account" value={offsetAccount} onChange={setOffsetAccount} />
          </div>
          <Field label="Description *">
            <input value={description} onChange={(e) => setDescription(e.target.value)}
              placeholder="Conference table — Office HQ" className={inputCls} style={inputStyle} />
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Category">
              <input value={category} onChange={(e) => setCategory(e.target.value)}
                placeholder="Furniture & Fixtures" className={inputCls} style={inputStyle} />
            </Field>
            <Field label="Vendor">
              <input value={vendor} onChange={(e) => setVendor(e.target.value)}
                className={inputCls} style={inputStyle} />
            </Field>
            <Field label="Asset tag / reference">
              <input value={reference} onChange={(e) => setReference(e.target.value)}
                placeholder="FA-001" className={inputCls} style={inputStyle} />
            </Field>
            <Field label="In-service date *">
              <DatePicker value={inService || ""} onChange={setInService}
                triggerClassName="w-full rounded-lg px-3 py-2 text-sm border outline-none" />
            </Field>
            <Field label="Cost *">
              <input type="number" step="0.01" value={cost} onChange={(e) => setCost(e.target.value)}
                placeholder="5000.00" className={`${inputCls} text-right tabular-nums`} style={inputStyle} />
            </Field>
            <Field label="Salvage value">
              <input type="number" step="0.01" value={salvage} onChange={(e) => setSalvage(e.target.value)}
                className={`${inputCls} text-right tabular-nums`} style={inputStyle} />
            </Field>
            <Field label="Useful life (months) *">
              <input type="number" step="1" value={life} onChange={(e) => setLife(e.target.value)}
                placeholder="60" className={`${inputCls} text-right tabular-nums`} style={inputStyle} />
            </Field>
            <Field label="Disposed on">
              <DatePicker value={disposedOn || ""} onChange={setDisposedOn}
                triggerClassName="w-full rounded-lg px-3 py-2 text-sm border outline-none" />
            </Field>
            <Field label="Disposal proceeds">
              <input type="number" step="0.01" value={disposalProceeds}
                onChange={(e) => setDisposalProceeds(e.target.value)}
                className={`${inputCls} text-right tabular-nums`} style={inputStyle} />
            </Field>
          </div>
          {cost && life && (
            <div className="rounded-lg p-3 text-xs"
              style={{ background: "var(--green-subtle)", color: "var(--green)", border: "1px solid var(--green)" }}>
              Monthly depreciation: <span className="font-bold">{monthlyDep(cost, salvage || "0", parseInt(life, 10) || 1)}</span>{" "}
              (straight-line).
            </div>
          )}
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
            {existing ? "Save changes" : "Add asset"}
          </Button>
        </div>
      </motion.div>
    </motion.div>
  )
}
