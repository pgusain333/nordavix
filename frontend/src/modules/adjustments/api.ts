import { apiClient } from "@/core/api/client"

/**
 * Adjustments API — AI-proposed journal entries.
 *
 * A proposed entry turns a close-difference explanation (bank reconciliation,
 * recon commentary, flux variance) into a reviewable JE the user approves and
 * copies into QuickBooks. Nordavix never writes to QBO — accept/post only
 * record the review state.
 */

export type AdjustmentSource = "bank" | "recon" | "flux"
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

async function dismiss(id: string): Promise<ProposedEntry> {
  const { data } = await apiClient.post<ProposedEntry>(`/api/adjustments/${id}/dismiss`)
  return data
}

async function markPosted(id: string): Promise<ProposedEntry> {
  const { data } = await apiClient.post<ProposedEntry>(`/api/adjustments/${id}/mark-posted`)
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

export const adjustmentsApi = { list, accounts, accept, dismiss, markPosted, edit, save, downloadCsv }

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
