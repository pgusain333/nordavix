import { apiClient } from "@/core/api/client"

export type IcKind = "receivable" | "payable" | "unknown"

export interface IcAccount {
  id:              string
  qbo_account_id:  string
  account_number:  string
  account_name:    string
  account_type:    string
  counterparty:    string | null
  kind:            IcKind
  auto_detected:   boolean
  notes:           string | null
  gl_balance:      string
  prior_balance:   string | null
  change:          string | null
  created_at:      string
  updated_at:      string
}

export interface IcOverview {
  qbo_connected:    boolean
  period_end:       string
  accounts:         IcAccount[]
  totals:           { receivables: string; payables: string; net: string }
  detected_pending: number
}

export interface IcTransaction {
  txn_id:     string
  txn_type:   string
  txn_number: string
  txn_date:   string
  amount:     string
  memo:       string
  entity:     string
}

interface IcMarkBody {
  qbo_account_id: string
  counterparty?:  string | null
  kind?:          IcKind
  notes?:         string | null
}

async function getOverview(periodEnd: string): Promise<IcOverview> {
  const { data } = await apiClient.get<IcOverview>("/api/intercompany/overview", {
    params: { period_end: periodEnd },
  })
  return data
}

export interface AutoDetectResult {
  added:          number
  classified:     number
  /** Total balance-sheet accounts QBO returned for scanning. */
  scanned:        number
  /** How many matched the IC name patterns this run. */
  matched:        number
  /** Already-tracked accounts that scanner skipped. */
  already_marked: number
  /** Up to 5 account names that DIDN'T match — diagnostic only. */
  skipped_sample: string[]
}

export interface AiDetectResult {
  added:           number
  scanned:         number
  /** How many candidates Claude returned (before confidence filter). */
  ai_candidates:   number
  already_marked:  number
  /** Candidates Claude flagged but at confidence < 0.6 — skipped. */
  skipped_lowconf: number
}

async function autoDetect(): Promise<AutoDetectResult> {
  const { data } = await apiClient.post<AutoDetectResult>("/api/intercompany/auto-detect")
  return data
}

async function aiDetect(): Promise<AiDetectResult> {
  const { data } = await apiClient.post<AiDetectResult>("/api/intercompany/ai-detect")
  return data
}

async function autoClassify(): Promise<{ classified: number; considered: number }> {
  const { data } = await apiClient.post<{ classified: number; considered: number }>("/api/intercompany/auto-classify")
  return data
}

async function upsertMark(body: IcMarkBody): Promise<{ id: string }> {
  const { data } = await apiClient.post<{ id: string }>("/api/intercompany/marks", body)
  return data
}

async function deleteMark(id: string): Promise<void> {
  await apiClient.delete(`/api/intercompany/marks/${encodeURIComponent(id)}`)
}

async function getTransactions(qboAccountId: string, periodEnd: string): Promise<{
  rows: IcTransaction[]; total: string; period_start: string; period_end: string
}> {
  const { data } = await apiClient.get(
    `/api/intercompany/account/${encodeURIComponent(qboAccountId)}/transactions`,
    { params: { period_end: periodEnd } },
  )
  return data
}

export const icApi = { getOverview, autoDetect, aiDetect, autoClassify, upsertMark, deleteMark, getTransactions }
