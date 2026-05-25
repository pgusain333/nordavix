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

async function autoDetect(): Promise<{ added: number }> {
  const { data } = await apiClient.post<{ added: number }>("/api/intercompany/auto-detect")
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

export const icApi = { getOverview, autoDetect, upsertMark, deleteMark, getTransactions }
