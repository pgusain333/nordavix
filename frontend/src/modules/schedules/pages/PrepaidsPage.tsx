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
import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { motion, AnimatePresence } from "framer-motion"
import { Brain, Calendar, FileText, Pencil, Trash2, X } from "lucide-react"

import { Button } from "@/core/ui/components"
import { DataTable, type Column, type FilterDef } from "@/core/ui"
import { DatePicker } from "@/core/ui/DatePicker"
import { useScheduleOptimistic } from "@/modules/schedules/optimistic"
import { SchedulePageHeader } from "@/modules/schedules/components/SchedulePageHeader"
import { AccountPicker } from "@/modules/schedules/components/AccountPicker"
import { RollForwardCard } from "@/modules/schedules/components/RollForwardCard"
import { PrepaidAmortizationDrawer } from "@/modules/schedules/components/PrepaidAmortizationDrawer"
import { GlAccountCell } from "@/modules/schedules/components/GlAccountCell"
import { RenewalAlertsBanner } from "@/modules/schedules/components/RenewalAlertsBanner"
import { AiDetectBanner } from "@/modules/schedules/components/AiDetectBanner"
import { ImportPrepaidsFromQboBanner } from "@/modules/schedules/components/ImportPrepaidsFromQboBanner"
import { ScheduleToolsLayout } from "@/modules/schedules/components/ScheduleToolsLayout"
import { FindingsStrip, ToolsButton, ToolsDrawer } from "@/modules/schedules/components/ScheduleTools"
import { ClosedPeriodBanner } from "@/modules/schedules/components/ClosedPeriodBanner"
import { useSelectedPeriodDefault } from "@/core/hooks/useSelectedPeriod"
import { useIsPeriodClosed } from "@/core/hooks/useIsPeriodClosed"
import { schedulesApi } from "@/modules/schedules/api"
import { memoryApi } from "@/modules/memory/api"
import { formatDate, toISODate } from "@/core/lib/dates"
import type { PrepaidAlertItem, PrepaidAmortMethod, PrepaidCandidate, PrepaidItem } from "@/modules/schedules/types"

/**
 * Pre-fill payload for the New Prepaid dialog when the user is creating
 * a renewal of a prior item (from RenewalAlertsBanner). All fields are
 * optional — the dialog falls back to its blank defaults for anything
 * not provided. Keeping this loose so the same hook serves later AI
 * detection / invoice-parse pre-fills.
 */
interface PrepaidPrefill {
  qbo_account_id?: string
  vendor?:         string
  description?:    string
  reference?:      string
  invoice_date?:   string
  total_amount?:   string
  start_date?:     string
  end_date?:       string
  notes?:          string
  /** Pre-selected amortization method (Phase 3). AI candidates supply
   * this via candidate.ai_method; renewals carry the prior item's
   * method. User can override before saving. */
  amortization_method?: PrepaidAmortMethod
  /** Short justification shown next to the picker when AI suggested it. */
  methodReasoning?: string
  /** UI flag — shows a small "Renewal of …" banner inside the dialog. */
  source?:         "renewal" | "ai-detect" | "invoice" | "recon-suggest"
  sourceLabel?:    string
  /** When the prefill comes from an AI-detect candidate, the dialog
   * calls schedulesApi.acceptPrepaidCandidate on save so the banner
   * stops re-surfacing the source GL txn. */
  candidateId?:    string
}

function defaultPeriodEnd(): string {
  const now = new Date()
  const last = new Date(now.getFullYear(), now.getMonth(), 0)
  return toISODate(last)  // local components — see toISODate (no UTC off-by-one)
}

function fmt(s: string | null | undefined): string {
  const n = parseFloat(s ?? "0") || 0
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function monthlyAmount(total: string, start: string, end: string): string {
  const t = parseFloat(total) || 0
  // CRITICAL: append "T00:00:00" so the date-only string parses at LOCAL
  // midnight, not UTC midnight. Without it, `new Date("2026-01-01")` is
  // UTC midnight, and `.getFullYear()/.getMonth()` then read it in the
  // browser's local zone — for any negative-UTC offset (all of the US)
  // that shifts 2026-01-01 back to 2025-12-31, inflating the month span
  // by one (12 → 13) and showing $923.08 instead of $1,000 for a
  // 12-month / $12,000 prepaid. The sibling dailyRateLabel() already
  // guards this way; monthlyAmount() was missing it.
  const s = start ? new Date(start + "T00:00:00") : null
  const e = end ? new Date(end + "T00:00:00") : null
  if (!s || !e || isNaN(s.getTime()) || isNaN(e.getTime())) return "$0.00"
  const months = Math.max(
    1,
    (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth()) + 1,
  )
  return `$${(t / months).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function dailyRateLabel(total: string, start: string, end: string): string {
  const t = parseFloat(total) || 0
  const s = start ? new Date(start + "T00:00:00") : null
  const e = end ? new Date(end + "T00:00:00") : null
  if (!s || !e || isNaN(s.getTime()) || isNaN(e.getTime()) || e < s) return "$0.00/day"
  const days = Math.max(1, Math.round((e.getTime() - s.getTime()) / 86_400_000) + 1)
  const rate = t / days
  return `$${rate.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}/day`
}

/**
 * Per-row label for the "Monthly" column. Honors the item's saved
 * amortization_method so editing the method via the pencil icon visibly
 * updates the table without a refresh:
 *
 *   straight_line → "$X" (total / months, even monthly recognition)
 *   daily_rate    → "$Y/day" (months would vary by length; daily rate
 *                   is the truthful headline number — matches what the
 *                   drawer KPI strip shows for the same method)
 */
function rateLabelForMethod(item: PrepaidItem): string {
  if (item.amortization_method === "daily_rate") {
    return dailyRateLabel(item.total_amount, item.start_date, item.end_date)
  }
  return monthlyAmount(item.total_amount, item.start_date, item.end_date)
}

// ── Table definition ────────────────────────────────────────────────────
//
// Columns and filters live at module scope: they close over nothing from the
// component, so defining them here keeps them out of every render and makes
// the page body about the page rather than about the table.

/** Active / inactive used to be conveyed ONLY by 50% row opacity — invisible
 *  in a screenshot or a print, and impossible to filter on. It is a column. */
function StatusChip({ active }: { active: boolean }) {
  return (
    <span className="inline-flex items-center rounded px-1.5 py-px text-[10px] font-semibold"
      style={active
        ? { color: "var(--green)", background: "var(--green-subtle)" }
        : { color: "var(--text-muted)", background: "var(--surface-2)" }}>
      {active ? "Active" : "Inactive"}
    </span>
  )
}

const PREPAID_COLUMNS: Column<PrepaidItem>[] = [
  {
    key: "description", header: "Description", width: "auto", hideable: false,
    sortValue: (it) => it.description.toLowerCase(),
    text: (it) => it.description,
    // ONE line. The reference used to sit under the description as a second
    // line, which made rows with a reference 48px against 37px for those
    // without — measured — and a list whose row height depends on whether a
    // field happens to be filled is hard to scan. It is its own column now,
    // which also makes it sortable, searchable and exportable in its own right.
    cell: (it) => (
      <span className="text-theme text-[13px] truncate block">{it.description}</span>
    ),
  },
  {
    key: "reference", header: "Reference", width: "124px",
    sortValue: (it) => it.reference?.toLowerCase() ?? null,
    text: (it) => it.reference ?? "",
    cell: (it) => (
      <span className="text-[11.5px] truncate block" style={{ color: "var(--text-2)" }}>
        {it.reference || "—"}
      </span>
    ),
  },
  {
    key: "account", header: "GL account", width: "160px",
    // Not sortable: the cell resolves an account NAME asynchronously, so the
    // only value available here is the QBO id — ordering by it would look like
    // sorting and be meaningless.
    text: (it) => it.qbo_account_id,
    cell: (it) => <GlAccountCell qboAccountId={it.qbo_account_id} />,
  },
  {
    key: "vendor", header: "Vendor", width: "160px",
    sortValue: (it) => it.vendor?.toLowerCase() ?? null,
    text: (it) => it.vendor ?? "",
    cell: (it) => (
      <span className="text-[13px] truncate block">{it.vendor || "—"}</span>
    ),
  },
  {
    key: "total", header: "Total", width: "120px", align: "right",
    sortValue: (it) => parseFloat(it.total_amount) || 0,
    text: (it) => fmt(it.total_amount),
    cell: (it) => <span className="tabular-nums text-[13px]">{fmt(it.total_amount)}</span>,
  },
  {
    key: "window", header: "Window", width: "175px",
    // Sorted by END date: "what finishes amortizing next" is the question this
    // column answers, and start date almost never is.
    sortValue: (it) => it.end_date,
    text: (it) => `${it.start_date} → ${it.end_date}`,
    cell: (it) => (
      <span className="text-[11px]" style={{ color: "var(--text-2)" }}>
        {it.start_date} → {it.end_date}
      </span>
    ),
  },
  {
    key: "monthly", header: "Monthly", width: "125px", align: "right",
    // Deliberately NOT sortable. The column mixes a monthly amount with a daily
    // rate depending on each item's method, so one numeric ordering would be
    // comparing different units and quietly ranking them wrong.
    text: (it) => rateLabelForMethod(it),
    cell: (it) => (
      <span className="tabular-nums text-[13px]">{rateLabelForMethod(it)}</span>
    ),
  },
  {
    key: "status", header: "Status", width: "92px",
    sortValue: (it) => (it.is_active ? "active" : "inactive"),
    text: (it) => (it.is_active ? "Active" : "Inactive"),
    cell: (it) => <StatusChip active={it.is_active} />,
  },
]

/** Filters need the selected period, so they're built per render of the page
 *  rather than frozen at module scope like the columns. */
function prepaidFilters(periodEnd: string): FilterDef<PrepaidItem>[] {
  const end = new Date(`${periodEnd}T00:00:00`)
  const in3Months = new Date(end)
  in3Months.setMonth(in3Months.getMonth() + 3)
  const iso = (d: Date) => toISODate(d)

  return [
    {
      key: "status", label: "All statuses",
      options: [
        { value: "active",   label: "Active" },
        { value: "inactive", label: "Inactive" },
      ],
      test: (it, v) => (v === "active" ? it.is_active : !it.is_active),
    },
    {
      key: "window", label: "Any window",
      options: [
        { value: "ends_this_period", label: "Finishes this period" },
        { value: "ends_3mo",         label: "Finishes within 3 months" },
        { value: "ended",            label: "Already finished" },
        { value: "open",             label: "Still amortizing" },
      ],
      test: (it, v) => {
        switch (v) {
          case "ends_this_period":
            return it.end_date.slice(0, 7) === periodEnd.slice(0, 7)
          case "ends_3mo": return it.end_date >= periodEnd && it.end_date <= iso(in3Months)
          case "ended":    return it.end_date < periodEnd
          case "open":     return it.end_date >= periodEnd
          default:         return true
        }
      },
    },
  ]
}

export function PrepaidsPage() {
  const qc = useQueryClient()
  const [periodEnd, setPeriodEnd] = useState<string>(useSelectedPeriodDefault(defaultPeriodEnd()))
  const isClosed = useIsPeriodClosed(periodEnd)
  const [filterAccount, setFilterAccount] = useState<string>("")
  const [toolsOpen, setToolsOpen] = useState(false)

  // Drives the findings strip AND the header badge. This is the LIST endpoint,
  // which returns what a previous scan already stored — it never re-runs the
  // detector, so showing the strip costs nothing. Running a scan stays an
  // explicit click, which is the trigger model this feature was designed with.
  const { data: candidates } = useQuery({
    queryKey: ["schedules", "prepaid", "ai-candidates"],
    queryFn:  () => schedulesApi.listPrepaidCandidates("open"),
    staleTime: 30_000,
  })
  const candidateCount = candidates?.candidates?.length ?? 0
  const [dialogState, setDialogState] = useState<{
    open: boolean
    item?: PrepaidItem
    prefill?: PrepaidPrefill
  }>({ open: false })
  /** Which item's amortization-schedule drawer is open (null = closed). */
  const [amortizationItem, setAmortizationItem] = useState<PrepaidItem | null>(null)

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

  const optimistic = useScheduleOptimistic("prepaid")
  const deleteMut = useMutation({
    mutationFn: (id: string) => schedulesApi.deleteItem("prepaid", id),
    onMutate:   (id)         => optimistic.beginDelete(id),
    onError:    (_e, _v, c)  => optimistic.rollback(c),
    onSettled:  ()           => optimistic.settle(),
  })

  const exportMut = useMutation({
    mutationFn: () => schedulesApi.downloadScheduleExcel("prepaid", periodEnd),
  })

  /**
   * "Add renewal" click from RenewalAlertsBanner. Compute a sensible
   * default for the new term:
   *   - start_date = prior end_date + 1 day  (continuous coverage)
   *   - end_date   = start + (prior_end - prior_start)  (same duration)
   *   - amount     = prior amount (user adjusts if pricing changed)
   *   - vendor / account / description / notes carry over
   * Reference left blank — user types the new invoice ref.
   */
  /**
   * "Add to schedule" click from AiDetectBanner. The dialog opens
   * pre-filled with the candidate's data; on save, the dialog ALSO
   * fires the accept API (via prefill.candidateId → mutation onSuccess)
   * so the banner stops re-surfacing this txn.
   *
   * Date math:
   *   start = ai_service_start (Claude's suggestion) OR the txn date
   *   end   = start + ai_service_months months − 1 day  (so a 12-month
   *           policy starting Apr 1 ends Mar 31, not Apr 1)
   */
  function handleAcceptCandidate(c: PrepaidCandidate) {
    const start = c.ai_service_start || c.gl_txn_date
    let end = start
    if (c.ai_service_months && c.ai_service_months > 0) {
      const s = new Date(start + "T00:00:00")
      const e = new Date(s.getFullYear(), s.getMonth() + c.ai_service_months, s.getDate() - 1)
      end = toISODate(e)
    }
    const vendor = c.ai_vendor || c.gl_vendor || ""
    const description = vendor
      ? `${vendor} — ${c.ai_service_months ? `${c.ai_service_months}-month` : "prepaid"} coverage`
      : c.gl_memo || `Prepaid from ${c.gl_account_name}`

    // Map AI's suggested method to our enum. Defensive normalization —
    // anything other than the two valid values falls back to daily_rate.
    const aiMethod: PrepaidAmortMethod =
      c.ai_method === "straight_line" ? "straight_line" : "daily_rate"

    setDialogState({
      open: true,
      prefill: {
        // qbo_account_id intentionally left blank — the candidate's
        // gl_account_id is the EXPENSE account where the txn was
        // mis-booked. The user picks the correct Prepaid GL account
        // when saving. (Future: ai_target_account_id auto-maps to
        // "Prepaid X" if one exists in the chart.)
        qbo_account_id: c.ai_target_account_id || undefined,
        vendor,
        description,
        total_amount:        c.gl_amount,
        start_date:          start,
        end_date:            end,
        invoice_date:        c.gl_txn_date,
        amortization_method: aiMethod,
        methodReasoning:     c.ai_reasoning ?? undefined,
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

  function handleAddRenewal(prior: PrepaidAlertItem) {
    const ps = new Date(prior.start_date + "T00:00:00")
    const pe = new Date(prior.end_date   + "T00:00:00")
    const dur = pe.getTime() - ps.getTime()
    const newStart = new Date(pe.getTime() + 86_400_000)
    const newEnd   = new Date(newStart.getTime() + dur)
    const iso = (d: Date) => toISODate(d)

    setDialogState({
      open: true,
      prefill: {
        qbo_account_id: prior.qbo_account_id,
        vendor:         prior.vendor ?? "",
        description:    prior.description,
        total_amount:   prior.total_amount,
        start_date:     iso(newStart),
        end_date:       iso(newEnd),
        // Renewals don't carry the prior item's method through the
        // alerts API (the endpoint doesn't include it). The dialog
        // defaults to daily_rate; user can flip to straight_line.
        notes:          `Renewal of "${prior.description}" (ended ${prior.end_date}).`,
        source:         "renewal",
        sourceLabel:    `Renewal of "${prior.description}"`,
      },
    })
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto" style={{ background: "var(--bg)" }}>
      <SchedulePageHeader
        type="prepaid"
        icon={<Calendar size={20} strokeWidth={1.6} />}
        accent={{ fg: "#3c5a76", bg: "rgba(60, 90, 118, 0.10)" }}
        periodEnd={periodEnd}
        onPeriod={setPeriodEnd}
        onAddItem={() => setDialogState({ open: true })}
        addLabel="Add prepaid"
        onExport={() => exportMut.mutate()}
        exporting={exportMut.isPending}
        extraActions={!isClosed
          ? <ToolsButton onClick={() => setToolsOpen(true)} badge={candidateCount} />
          : undefined}
      />

      <div className="flex-1 px-4 sm:px-6 py-5 max-w-[1680px] w-full mx-auto space-y-5">
        <ClosedPeriodBanner periodEnd={periodEnd} />
        {/* The import / AI-detect tools live in a slide-over off the header
            rather than a permanent rail — see ScheduleTools.tsx for why. */}
        <ToolsDrawer
          open={toolsOpen}
          onClose={() => setToolsOpen(false)}
          title="Find prepaid items"
        >
          <ImportPrepaidsFromQboBanner
            qboAccountId={filterAccount}
            existingItemCount={items.length}
          />
          <AiDetectBanner periodEnd={periodEnd} onAccept={handleAcceptCandidate} />
        </ToolsDrawer>

        <ScheduleToolsLayout>
        {/* Renewal alerts stay in the main column — a data alert tied to the
            table, not an import tool. */}
        {!isClosed && (
          <RenewalAlertsBanner
            periodEnd={periodEnd}
            onAddRenewal={handleAddRenewal}
          />
        )}
        {/* Account filter — the roll-forward below carries the recon tie-out */}
        <div className="rounded-xl p-4"
          style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
          <AccountPicker
            value={filterAccount}
            onChange={setFilterAccount}
            mode="filter"
            label="GL account"
          />
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
          stale={!!snapshot?.stale}
        />

        {!isClosed && (
          <FindingsStrip
            count={candidateCount}
            noun="prepaid"
            periodLabel={formatDate(periodEnd)}
            onReview={() => setToolsOpen(true)}
            onScan={() => setToolsOpen(true)}
            scanned={false}
          />
        )}

        {/* Items */}
        <div>
          <div className="mb-2">
            <p className="text-sm font-semibold text-theme">Prepaid items</p>
            <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
              Each item is amortized over its [start &rarr; end] window per the
              method picked in the editor (straight-line monthly or
              days-based daily rate).
            </p>
          </div>
          <DataTable<PrepaidItem>
            id="schedules.prepaids"
            rows={items}
            columns={PREPAID_COLUMNS}
            rowKey={(it) => it.id}
            isLoading={itemsLoading}
            minWidth="1380px"
            search={{ placeholder: "Search description, vendor, reference…" }}
            // Soonest to finish amortizing first: on a prepaid schedule that is
            // the order the work actually follows.
            defaultSort={{ key: "window", dir: "asc" }}
            filters={prepaidFilters(periodEnd)}
            actions={(it) => (
              <div className="inline-flex items-center gap-1.5 justify-end w-full">
                <button
                  onClick={() => setAmortizationItem(it)}
                  className="p-1 rounded hover:bg-[var(--surface-2)]"
                  title="View amortization schedule + journal entry">
                  <FileText size={13} strokeWidth={1.8} style={{ color: "#3c5a76" }} />
                </button>
                <button
                  onClick={() => setDialogState({ open: true, item: it })}
                  disabled={isClosed}
                  className="p-1 rounded hover:bg-[var(--surface-2)] disabled:opacity-30 disabled:cursor-not-allowed"
                  title={isClosed ? "Period closed" : "Edit"}>
                  <Pencil size={13} strokeWidth={1.8} style={{ color: "var(--text-muted)" }} />
                </button>
                <button
                  onClick={() => { if (window.confirm(`Delete "${it.description}"?`)) deleteMut.mutate(it.id) }}
                  disabled={isClosed}
                  className="p-1 rounded hover:bg-[var(--surface-2)] disabled:opacity-30 disabled:cursor-not-allowed"
                  title={isClosed ? "Period closed" : "Delete"}>
                  <Trash2 size={13} strokeWidth={1.8} style={{ color: "#9b3d37" }} />
                </button>
              </div>
            )}
            actionsWidth="104px"
            exportFilename="prepaid-schedule"
            empty={{
              title: "No prepaid items yet",
              body: "Add your first prepaid invoice — Nordavix will compute the monthly amortization automatically.",
              action: (
                <Button size="sm" disabled={isClosed} onClick={() => setDialogState({ open: true })}>
                  Add prepaid
                </Button>
              ),
            }}
          />
        </div>
        </ScheduleToolsLayout>
      </div>

      <AnimatePresence>
        {dialogState.open && (
          <PrepaidDialog
            existing={dialogState.item}
            prefill={dialogState.prefill}
            onClose={() => setDialogState({ open: false })}
            initialAccount={filterAccount}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {amortizationItem && (
          <PrepaidAmortizationDrawer
            item={amortizationItem}
            onClose={() => setAmortizationItem(null)}
          />
        )}
      </AnimatePresence>
    </div>
  )
}


// ── Dialog ──────────────────────────────────────────────────────────────

/** end = start + N months − 1 day (inclusive coverage), matching the renewal
 *  and AI-candidate date math used elsewhere in this dialog.
 *
 *  The start day is clamped to the target month's last day BEFORE subtracting a
 *  day, so end-of-month starts don't overflow (naive Jan-31 + 1mo would build
 *  "Feb 31" → Mar 2; clamping yields Feb 27). This keeps it the exact inverse of
 *  the backend's _months_between for whole-month terms — which the Client Memory
 *  signature relies on so an applied learned default re-saves to the same term.
 *  Exported because the lease dialog reuses it to apply a learned lease term. */
export function addMonthsIso(startIso: string, months: number): string {
  const s = new Date(startIso + "T00:00:00")
  const lastDayOfTarget = new Date(s.getFullYear(), s.getMonth() + months + 1, 0).getDate()
  const day = Math.min(s.getDate(), lastDayOfTarget)
  const e = new Date(s.getFullYear(), s.getMonth() + months, day - 1)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${e.getFullYear()}-${p(e.getMonth() + 1)}-${p(e.getDate())}`
}

function PrepaidDialog({ existing, prefill, onClose, initialAccount }: {
  existing?:       PrepaidItem
  prefill?:        PrepaidPrefill
  onClose:         () => void
  initialAccount:  string
}) {
  const qc = useQueryClient()
  // Pre-fill rules:
  //   - existing wins (we're editing, not creating)
  //   - prefill provides values for a new item (renewal / AI / invoice)
  //   - blank/filter-account is the final fallback for a manual add
  const [account,     setAccount]     = useState(existing?.qbo_account_id ?? prefill?.qbo_account_id ?? initialAccount)
  const [description, setDescription] = useState(existing?.description ?? prefill?.description ?? "")
  const [vendor,      setVendor]      = useState(existing?.vendor      ?? prefill?.vendor      ?? "")
  const [reference,   setReference]   = useState(existing?.reference   ?? prefill?.reference   ?? "")
  const [invoiceDate, setInvoiceDate] = useState(existing?.invoice_date ?? prefill?.invoice_date ?? "")
  const [totalAmount, setTotalAmount] = useState(existing?.total_amount ?? prefill?.total_amount ?? "")
  const [startDate,   setStartDate]   = useState(existing?.start_date   ?? prefill?.start_date   ?? "")
  const [endDate,     setEndDate]     = useState(existing?.end_date     ?? prefill?.end_date     ?? "")
  const [notes,       setNotes]       = useState(existing?.notes        ?? prefill?.notes        ?? "")
  // Amortization method (Phase 3): user-pickable, defaults to daily_rate
  // unless prefill or existing supplies one. AI candidates set this.
  const [amortMethod, setAmortMethod] = useState<PrepaidAmortMethod>(
    (existing?.amortization_method as PrepaidAmortMethod | undefined) ??
      prefill?.amortization_method ??
      "daily_rate",
  )
  // Offset (expense) account — the P&L account this prepaid amortizes into.
  // Lets Nordavix draft complete two-sided proposed adjusting entries.
  const [offsetAccount, setOffsetAccount] = useState(existing?.offset_qbo_account_id ?? "")
  const [error,       setError]       = useState<string | null>(null)

  // Client Memory (Slice 2): a CONFIRMED setup for this vendor, if any. Only
  // shown for new items, and only once the vendor name is typed. Confirm-first
  // — the endpoint returns active facts only, so nothing surfaces unless a
  // reviewer confirmed it in Settings → Client memory.
  const vendorTrim = vendor.trim()
  const vendorLc = vendorTrim.toLowerCase()
  const { data: learnedResp } = useQuery({
    queryKey: ["schedule-default", "prepaid", vendorLc],
    queryFn:  () => memoryApi.scheduleDefault("prepaid", vendorTrim),
    enabled:  !existing && vendorTrim.length >= 2,
    staleTime: 60_000,
  })
  const learned = (!existing && learnedResp?.default) || null
  // Per-vendor sentinel (not a one-way boolean) so changing the vendor mid-
  // dialog re-offers the new vendor's learned default.
  const [appliedFor, setAppliedFor] = useState<string | null>(null)

  // Expense accounts — shares AccountPicker's cached query (same key), used to
  // resolve the offset account's NAME so it's persisted on the item (and learned
  // by Client Memory for the "amortizes into …" label).
  const { data: expenseAccts } = useQuery({
    queryKey: ["schedules", "accounts", "expense"],
    queryFn:  () => schedulesApi.listAccounts("expense"),
    staleTime: 5 * 60_000,
  })
  const offsetName = (id: string) =>
    (expenseAccts ?? []).find((a) => a.qbo_account_id === id)?.name || null

  function applyLearned() {
    if (!learned) return
    if (learned.amortization_method) setAmortMethod(learned.amortization_method)
    if (learned.offset_qbo_account_id) setOffsetAccount(String(learned.offset_qbo_account_id))
    if (!account && learned.qbo_account_id) setAccount(String(learned.qbo_account_id))
    if (startDate && learned.term_months) setEndDate(addMonthsIso(startDate, Number(learned.term_months)))
    setAppliedFor(vendorLc)
  }

  const optimistic = useScheduleOptimistic("prepaid")
  const mut = useMutation({
    mutationFn: (body: Partial<PrepaidItem>) => existing
      ? schedulesApi.updateItem("prepaid", existing.id, body)
      : schedulesApi.createItem("prepaid", body),
    onMutate: (body) => {
      if (existing) {
        return optimistic.beginUpdate(existing.id, body as Partial<PrepaidItem> as Record<string, unknown>)
      }
      // Create — stamp a temp id so the row keys; server response replaces it.
      const tempId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      return optimistic.beginCreate({ id: tempId, ...(body as Record<string, unknown>) })
    },
    onSuccess: async (created) => {
      // If this create came from an AI-detected candidate, link the
      // new schedule item back to the candidate so re-scans skip the
      // source GL txn. Fire-and-forget — a failure here doesn't block
      // the create (the schedule item is already saved).
      if (!existing && prefill?.candidateId && (created as PrepaidItem)?.id) {
        try {
          await schedulesApi.acceptPrepaidCandidate(
            prefill.candidateId,
            (created as PrepaidItem).id,
          )
          qc.invalidateQueries({ queryKey: ["schedules", "prepaid", "ai-candidates"] })
        } catch {
          // Non-fatal — the schedule item exists. Worst case the
          // banner re-suggests on next scan; the user can dismiss.
        }
      }
      onClose()
    },
    onError: (e: unknown, _vars, ctx) => {
      optimistic.rollback(ctx)
      const msg = (e as { response?: { data?: { detail?: string } } }).response?.data?.detail
      setError(msg ?? "Could not save the prepaid item.")
    },
    onSettled: () => optimistic.settle(),
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
      qbo_account_id:      account,
      description:         description.trim(),
      vendor:              vendor.trim() || null,
      reference:           reference.trim() || null,
      invoice_date:        invoiceDate || null,
      total_amount:        totalAmount,
      start_date:          startDate,
      end_date:            endDate,
      amortization_method: amortMethod,
      offset_qbo_account_id: offsetAccount || null,
      offset_account_name:   offsetAccount ? offsetName(offsetAccount) : null,
      notes:               notes.trim() || null,
      is_active:           true,
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
          <div className="flex items-center gap-2 min-w-0">
            <h3 className="text-base font-semibold text-theme">
              {existing ? "Edit prepaid item" : "New prepaid item"}
            </h3>
            {!existing && prefill?.source === "renewal" && (
              <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
                style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
                Renewal
              </span>
            )}
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
                {" "}Adjust amount, dates, or any other field — your edits override the suggestion.
              </span>
            </div>
          )}
          {!existing && learned && appliedFor !== vendorLc && (
            <div className="rounded-lg px-3 py-2.5 flex items-start gap-2.5"
              style={{ background: "var(--green-subtle)", border: "1px solid var(--green)" }}>
              <Brain size={15} strokeWidth={1.9} className="mt-0.5 shrink-0" style={{ color: "var(--green)" }} />
              <p className="text-[12px] min-w-0 flex-1" style={{ color: "var(--text)" }}>
                Client memory: <span className="font-semibold">{learned.vendor || vendorTrim}</span> is usually a{" "}
                {learned.term_months ? `${learned.term_months}-month ` : ""}
                {learned.amortization_method === "daily_rate" ? "daily-rate" : "straight-line"} prepaid
                {learned.offset_account_name ? <> into <span className="font-semibold">{learned.offset_account_name}</span></> : null}.
              </p>
              <button onClick={applyLearned}
                className="shrink-0 inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[12px] font-bold text-white transition-opacity hover:opacity-90"
                style={{ background: "var(--green)" }}>
                Apply
              </button>
            </div>
          )}
          <AccountPicker mode="form" label="GL account (prepaid asset)" value={account} onChange={setAccount} />
          <div>
            <AccountPicker mode="form" kind="expense" label="Expense account (amortizes into)" value={offsetAccount} onChange={setOffsetAccount} />
            <p className="text-[10px] mt-1" style={{ color: "var(--text-muted)" }}>
              The P&amp;L account this prepaid expenses to. Used to draft the proposed adjusting entries
              (Dr Expense / Cr Prepaid). Optional — leave blank to confirm it later.
            </p>
          </div>
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
          {/* Amortization method (Phase 3 — c) */}
          <AmortMethodPicker
            value={amortMethod}
            onChange={setAmortMethod}
            totalAmount={totalAmount}
            startDate={startDate}
            endDate={endDate}
            aiReasoning={!existing && prefill?.source === "ai-detect" ? prefill?.methodReasoning : undefined}
            aiSuggestedMethod={!existing && prefill?.source === "ai-detect" ? prefill?.amortization_method : undefined}
          />
          {/* Live calc — adapts to the picked method */}
          {totalAmount && startDate && endDate && (
            <div className="rounded-lg p-3 text-xs"
              style={{ background: "var(--green-subtle)", color: "var(--green)", border: "1px solid var(--green)" }}>
              {amortMethod === "straight_line" ? (
                <>
                  Each calendar month touched will recognize{" "}
                  <span className="font-bold">{monthlyAmount(totalAmount, startDate, endDate)}</span>{" "}
                  of expense — exactly, no day-count proration.
                </>
              ) : (
                <>
                  Daily rate is <span className="font-bold">{dailyRateLabel(totalAmount, startDate, endDate)}</span>.
                  Monthly amounts vary by month length (~{monthlyAmount(totalAmount, startDate, endDate)}/month on average).
                </>
              )}
            </div>
          )}
          <Field label="Notes">
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={inputCls} style={inputStyle} />
          </Field>
          {error && <p className="text-xs" style={{ color: "#9b3d37" }}>{error}</p>}
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

// ── Amortization method picker (Phase 3 — c) ──────────────────────────
//
// Two cards side-by-side, click-to-select. When the AI suggested one
// of them (ai-detect prefill), that card gets a small ✨ Recommended
// chip + the AI's one-line reasoning visible below it. User can pick
// the other and the AI chip just moves to a non-selected position —
// no warning, no friction; the user is always in control.

function AmortMethodPicker({
  value, onChange, totalAmount, startDate, endDate, aiReasoning, aiSuggestedMethod,
}: {
  value: PrepaidAmortMethod
  onChange: (v: PrepaidAmortMethod) => void
  totalAmount: string
  startDate:   string
  endDate:     string
  aiReasoning?:       string
  aiSuggestedMethod?: PrepaidAmortMethod
}) {
  const hasCalc = !!(totalAmount && startDate && endDate)
  return (
    <Field label="Amortization method">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <MethodCard
          method="daily_rate"
          title="Daily-rate"
          tagline="Precise day-based proration"
          rightLabel={hasCalc ? dailyRateLabel(totalAmount, startDate, endDate) : ""}
          body="Each period gets daily_rate × days_in_period. Most accurate when start/end fall mid-month — partial first/last months are split exactly by calendar days."
          selected={value === "daily_rate"}
          aiSuggested={aiSuggestedMethod === "daily_rate"}
          onClick={() => onChange("daily_rate")}
        />
        <MethodCard
          method="straight_line"
          title="Straight-line monthly"
          tagline="Even 1/N each calendar month touched"
          rightLabel={hasCalc ? `${monthlyAmount(totalAmount, startDate, endDate)}/mo` : ""}
          body="Recognized at month-end. Every touched calendar month books exactly total / N — the CPA-conventional even monthly amortization."
          selected={value === "straight_line"}
          aiSuggested={aiSuggestedMethod === "straight_line"}
          onClick={() => onChange("straight_line")}
        />
      </div>
      {/* AI reasoning — shown when the prefill came from AI detect.
          Sits below both cards so it doesn't tie visually to either
          selection — the user can keep or change AI's pick freely. */}
      {aiReasoning && aiSuggestedMethod && (
        <div className="mt-2 rounded-md px-2.5 py-1.5 text-[11px] inline-flex items-start gap-1.5"
          style={{ background: "rgba(84, 88, 138, 0.08)", color: "#494a74" }}>
          <span className="shrink-0 mt-px">✨</span>
          <span><span className="font-semibold">AI suggests {aiSuggestedMethod === "straight_line" ? "Straight-line" : "Daily-rate"}:</span>{" "}{aiReasoning}</span>
        </div>
      )}
    </Field>
  )
}

function MethodCard({
  method, title, tagline, rightLabel, body, selected, aiSuggested, onClick,
}: {
  method:     PrepaidAmortMethod
  title:      string
  tagline:    string
  rightLabel: string
  body:       string
  selected:   boolean
  aiSuggested: boolean
  onClick:    () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-method={method}
      className="text-left rounded-lg px-3 py-2.5 transition-all"
      style={{
        background: selected ? "var(--green-subtle)" : "var(--surface-2)",
        border: `1.5px solid ${selected ? "var(--green)" : "var(--border)"}`,
        boxShadow: selected ? "0 0 0 1px var(--green) inset" : "none",
      }}
      onMouseEnter={(e) => { if (!selected) (e.currentTarget as HTMLElement).style.borderColor = "var(--border-strong)" }}
      onMouseLeave={(e) => { if (!selected) (e.currentTarget as HTMLElement).style.borderColor = "var(--border)" }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[13px] font-semibold" style={{ color: selected ? "var(--green)" : "var(--text)" }}>
              {title}
            </span>
            {aiSuggested && (
              <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
                style={{ background: "rgba(84, 88, 138, 0.12)", color: "#54588a" }}>
                ✨ AI pick
              </span>
            )}
          </div>
          <p className="text-[10px] mt-0.5" style={{ color: "var(--text-muted)" }}>{tagline}</p>
        </div>
        {rightLabel && (
          <span className="text-[10px] font-mono shrink-0 tabular-nums px-1.5 py-0.5 rounded"
            style={{ background: "white", color: "var(--text-2)", border: "1px solid var(--border)" }}>
            {rightLabel}
          </span>
        )}
      </div>
      <p className="text-[11px] leading-snug mt-1.5" style={{ color: "var(--text-2)" }}>{body}</p>
    </button>
  )
}
