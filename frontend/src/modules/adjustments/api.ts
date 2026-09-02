import { apiClient } from "@/core/api/client"

/**
 * Adjustments API — AI-proposed journal entries.
 *
 * A proposed entry turns a close-difference explanation (bank reconciliation,
 * recon commentary, flux variance) into a reviewable JE the user approves and
 * copies into QuickBooks. Nordavix never writes to QBO — accept/post only
 * record the review state.
 */

/**
 * Where a proposed entry came from.
 *
 * Known CLOSE-APP producers are listed for autocomplete, but the union stays
 * OPEN (`string & {}`): the server decides this value. A closed union here is
 * what let the Adjustments list quietly drop entries from modules the UI hadn't
 * been told about — counted in the tab totals, rendered by nothing. Anything
 * unrecognised now lands in a labelled "Other" group instead.
 *
 * Entries from OTHER products (Nordavix Allocate's §471(c) reclass) never
 * reach this client: the close endpoints exclude them server-side.
 */
export type AdjustmentSource =
  | "bank" | "recon" | "flux" | "gl_accuracy" | "assistant"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {})
export type AdjustmentStatus = "open" | "accepted" | "posted" | "dismissed"
export type AdjustmentConfidence = "high" | "medium" | "low"

export interface ProposedEntryLine {
  account_qbo_id: string | null
  account_number: string | null
  account_name:   string
  debit:          string
  credit:         string
}

export interface ProposedEntry {
  id:                string
  source:            AdjustmentSource
  source_ref:        string
  period_end:        string
  description:       string
  lines:             ProposedEntryLine[]
  memo:              string | null
  rationale:         string | null
  confidence:        AdjustmentConfidence
  status:            AdjustmentStatus
  status_changed_at: string | null
  saved_at:          string | null
  created_at:        string | null
  /** Why a reviewer chose not to book it. Required on dismiss. */
  dismiss_reason:      string | null
  /** The QuickBooks journal entry this was FOUND as, by reading QBO — a
   *  stronger fact than a human ticking "posted", and stored separately. */
  posted_qbo_doc:      string | null
  posted_confirmed_at: string | null
}

/** What a set of entries does to the financial statements.
 *
 *  `complete` is false when any line couldn't be classified (a placeholder
 *  account, or one missing from the period's chart). The totals are then a
 *  partial view and must not be presented as the whole story. */
export interface NetEffect {
  revenue:            string
  cogs:               string
  gross_profit:       string
  opex:               string
  net_income:         string
  assets:             string
  liabilities_equity: string
  cash:               string
  unclassified_lines: number
  complete:           boolean
}

/** The statement lines the rail shows, in the order a P&L is read. */
export const EFFECT_LINES = [
  "revenue", "cogs", "gross_profit", "opex", "operating_income",
  "other_income", "other_expense", "net_income",
  "assets", "liabilities_equity",
] as const
export type EffectLine = (typeof EFFECT_LINES)[number]

/** Which basis the P&L figures are on.
 *  - "month" — this month's own activity
 *  - "ytd"   — year to date through the period end
 *  - "unavailable" — month was asked for but the prior month isn't synced, so
 *    there is nothing to difference against. The figures come back null rather
 *    than falling back to YTD under a monthly heading. */
export type PlBasis = "month" | "ytd" | "unavailable"

/** The GL as last read from QuickBooks. P&L lines are null when
 *  `pl_basis === "unavailable"`. The balance sheet is point-in-time under
 *  every basis — a balance is not period activity. */
export type StatementTotals = Record<EffectLine, string | null> & {
  captured_at:      string | null
  pl_basis:         PlBasis
  prior_period_end: string | null
}

export interface PeriodNetEffect {
  period_end: string
  /** null when the period has never been synced — an unsynced period and an
   *  empty one are different answers. */
  baseline:   StatementTotals | null
  adjusted:   Record<EffectLine, string | null> | null
  /** Only the entries not already inside the baseline. */
  applied:    NetEffect & { count: number }
  /** Booked, confirmed in QBO before the snapshot — already in the baseline. */
  already_in_baseline:  number
  /** Confirmed posted AFTER the snapshot: in QuickBooks but possibly not in
   *  this read. Neither applying nor skipping is right, so it's reported. */
  baseline_stale_count: number
  /** line → the entry ids that move it. The rail's click target. */
  contributors: Record<EffectLine, string[]>
  booked: NetEffect & { count: number }
  /** The passed-adjustments schedule: what was considered and not booked.
   *  Individually immaterial, which is exactly why the total matters. */
  passed: NetEffect & { count: number; without_reason: number }
  open_count: number
}

export interface TraceDecision {
  at:     string | null
  action: string
  label:  string
  by:     string
  reason: string | null
}

export interface EntryTrace {
  id: string
  origin: {
    source:     AdjustmentSource
    drafted_by: string
    created_at: string | null
    confidence: AdjustmentConfidence
    rationale:  string | null
    subject:    { type: string; id: string; label: string; resolved: boolean } | null
  }
  basis: {
    period_end: string
    lines: (ProposedEntryLine & { account_type: string | null; known_account: boolean })[]
  }
  decisions:      TraceDecision[]
  prepared_by:    string | null
  approved_by:    string | null
  dismiss_reason: string | null
  support: {
    rationale:   string | null
    memory_fact: { id: string; title: string; kind: string } | null
  }
  effect: NetEffect & {
    /** Only a booked entry has moved the statements. For a draft or a passed
     *  item the figures are what it WOULD do, and are labelled as such. */
    applied:             boolean
    posted_qbo_doc:      string | null
    posted_confirmed_at: string | null
    edges: { relation: string; type: string; id: string }[]
  }
}

export interface ProposedEntryList {
  items:      ProposedEntry[]
  open_count: number
}

export interface AdjustmentAccount {
  qbo_account_id: string
  account_number: string | null
  account_name:   string
  account_type:   string
}

interface ListParams {
  periodEnd?: string
  source?:    AdjustmentSource
  status?:    AdjustmentStatus
  sourceRef?: string
}

async function list(params: ListParams = {}): Promise<ProposedEntryList> {
  const { data } = await apiClient.get<ProposedEntryList>("/api/adjustments", {
    params: {
      period_end: params.periodEnd,
      source:     params.source,
      status:     params.status,
      source_ref: params.sourceRef,
    },
  })
  return data
}

async function accounts(periodEnd: string): Promise<AdjustmentAccount[]> {
  const { data } = await apiClient.get<{ accounts: AdjustmentAccount[] }>(
    "/api/adjustments/accounts",
    { params: { period_end: periodEnd } },
  )
  return data.accounts
}

async function accept(id: string): Promise<ProposedEntry> {
  const { data } = await apiClient.post<ProposedEntry>(`/api/adjustments/${id}/accept`)
  return data
}

/** Reject a draft. The reason is REQUIRED and kept with the close record —
 *  it is what the passed-adjustments schedule reports, what a reviewer
 *  re-reads, and what an examiner asks about. The server rejects a blank one. */
async function dismiss(id: string, reason: string): Promise<ProposedEntry> {
  const { data } = await apiClient.post<ProposedEntry>(
    `/api/adjustments/${id}/dismiss`, { reason },
  )
  return data
}

async function markPosted(id: string): Promise<ProposedEntry> {
  const { data } = await apiClient.post<ProposedEntry>(`/api/adjustments/${id}/mark-posted`)
  return data
}

/** Pull an approved entry back to 'open' so its accounts can be changed, then
 *  re-approved (admin + reviewer; works even after saving — pulls the entry
 *  back out of the saved batch). */
async function reopen(id: string): Promise<ProposedEntry> {
  const { data } = await apiClient.post<ProposedEntry>(`/api/adjustments/${id}/reopen`)
  return data
}

interface EditBody {
  lines?:       ProposedEntryLine[]
  description?: string
  memo?:        string | null
}

async function edit(id: string, body: EditBody): Promise<ProposedEntry> {
  const { data } = await apiClient.patch<ProposedEntry>(`/api/adjustments/${id}`, body)
  return data
}

export interface SaveResult {
  period_end:  string
  newly_saved: number
  saved_total: number
}

/** Finalize a fully-approved period: lock the approved entries as a 'Saved'
 *  batch (reviewer+). Unlocks CSV export + posting check. */
async function save(periodEnd: string): Promise<SaveResult> {
  const { data } = await apiClient.post<SaveResult>(
    "/api/adjustments/save", null, { params: { period_end: periodEnd } },
  )
  return data
}

/** Download the saved adjustments as a QBO 'Import journal entries' CSV. */
async function downloadCsv(periodEnd: string): Promise<void> {
  const res = await apiClient.get("/api/adjustments/export.csv", {
    params: { period_end: periodEnd },
    responseType: "blob",
  })
  const url = URL.createObjectURL(res.data as Blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `nordavix_adjustments_${periodEnd}.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export interface CheckPostedEntry {
  id:          string
  description: string
  posted:      boolean
  qbo_doc:     string | null
}

export interface CheckPostedResult {
  period_end:        string
  entries:           CheckPostedEntry[]
  total:             number
  posted_count:      number
  all_posted:        boolean
  reopened_accounts: string[]
  reopened_flux_accounts: string[]
}

/** Read QuickBooks (read-only) and check whether each saved adjustment was
 *  posted. When all are found, the affected recons reopen server-side. */
async function checkPosted(periodEnd: string): Promise<CheckPostedResult> {
  const { data } = await apiClient.post<CheckPostedResult>(
    "/api/adjustments/check-posted", null, { params: { period_end: periodEnd } },
  )
  return data
}

/** Everything behind one entry: where it came from, what it's made of, who
 *  decided what and why, what supports it, and what changed as a result. */
async function trace(id: string): Promise<EntryTrace> {
  const { data } = await apiClient.get<EntryTrace>(`/api/adjustments/${id}/trace`)
  return data
}

/** What this period's adjustments do to the statements — split into what was
 *  booked and what was passed. `basis` defaults to the month being closed,
 *  which is what a reviewer working that month is actually asking about. */
async function netEffect(periodEnd: string, basis: "month" | "ytd" = "month"): Promise<PeriodNetEffect> {
  const { data } = await apiClient.get<PeriodNetEffect>("/api/adjustments/net-effect", {
    params: { period_end: periodEnd, basis },
  })
  return data
}

export const adjustmentsApi = {
  list, accounts, accept, dismiss, markPosted, reopen, edit, save, downloadCsv,
  checkPosted, trace, netEffect,
}

/** Plain-text rendering of a proposed entry for the clipboard, so the user can
 *  paste a clean two-column JE into QuickBooks (or a working paper). */
export function formatJeForClipboard(e: ProposedEntry): string {
  const money = (s: string) => {
    const n = parseFloat(s) || 0
    return n === 0 ? "" : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }
  const acctW = Math.max(24, ...e.lines.map((l) => l.account_name.length + 2))
  const head = `${"Account".padEnd(acctW)}${"Debit".padStart(14)}${"Credit".padStart(14)}`
  const body = e.lines
    .map((l) => {
      // Indent the credit line, accounting convention.
      const isCredit = (parseFloat(l.credit) || 0) > 0
      const label = (isCredit ? "  " : "") + l.account_name
      return `${label.padEnd(acctW)}${money(l.debit).padStart(14)}${money(l.credit).padStart(14)}`
    })
    .join("\n")
  const lines = [e.description, "", head, body]
  if (e.memo) lines.push("", `Memo: ${e.memo}`)
  return lines.join("\n")
}
