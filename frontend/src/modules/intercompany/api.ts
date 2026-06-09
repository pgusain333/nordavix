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

// ── Cross-tenant pairing + eliminations ───────────────────────────────────

export interface AccessibleAccount {
  qbo_account_id: string
  account_number: string
  account_name:   string
  account_type:   string
  kind:           IcKind
  counterparty:   string | null
}

export interface AccessibleCompany {
  tenant_id:     string
  clerk_org_id:  string
  name:          string
  company_name:  string | null
  qbo_connected: boolean
  ic_accounts:   AccessibleAccount[]
}

export interface IcPair {
  pair_group_id:               string
  my_qbo_account_id:           string
  my_account_label:            string
  counterparty_tenant_id:      string
  counterparty_clerk_org_id:   string
  counterparty_label:          string
  counterparty_qbo_account_id: string
  notes:                       string | null
  created_at:                  string
}

export interface EliminationRow {
  pair_group_id:               string
  my_qbo_account_id:           string
  my_account_label:            string
  my_balance:                  string
  counterparty_tenant_id:      string
  counterparty_label:          string
  counterparty_balance:        string
  diff:                        string
  status:                      "matched" | "mismatch" | "one_side_missing"
}

export interface EliminationsResponse {
  period_end: string
  rows:       EliminationRow[]
  totals: {
    matched_count:       number
    mismatch_count:      number
    total_to_eliminate:  string
  }
}

export interface ConsolidatedRow {
  fs_category:        string
  account_label:      string
  tenant_id:          string
  company_name:       string
  qbo_account_id:     string
  raw_balance:        string
  elimination:        string
  consolidated:       string
  is_eliminated_row:  boolean
}

export interface ConsolidatedUnmatched {
  account_label:        string
  company_name:         string
  my_balance:           string
  counterparty_balance: string | null
  reason:               string
}

export interface ConsolidatedTbResponse {
  period_end: string
  companies:  { tenant_id: string; name: string }[]
  rows:       ConsolidatedRow[]
  totals: Record<string, { raw: string; elimination: string; consolidated: string }>
  // Integrity (Phase 3): does the consolidation balance, and which IC balances
  // couldn't be eliminated (still inflating the totals)?
  balanced?:   boolean
  imbalance?:  string
  unmatched?:  ConsolidatedUnmatched[]
}

async function listAccessibleCompanies(): Promise<{ companies: AccessibleCompany[] }> {
  const { data } = await apiClient.get<{ companies: AccessibleCompany[] }>(
    "/api/intercompany/accessible-companies",
  )
  return data
}

async function listPairs(): Promise<IcPair[]> {
  const { data } = await apiClient.get<IcPair[]>("/api/intercompany/pairs")
  return data
}

async function createPair(body: {
  my_qbo_account_id: string
  counterparty_tenant_id: string
  counterparty_qbo_account_id: string
  notes?: string | null
}): Promise<IcPair> {
  const { data } = await apiClient.post<IcPair>("/api/intercompany/pairs", body)
  return data
}

async function deletePair(pairGroupId: string): Promise<void> {
  await apiClient.delete(`/api/intercompany/pairs/${encodeURIComponent(pairGroupId)}`)
}

async function getEliminations(periodEnd: string): Promise<EliminationsResponse> {
  const { data } = await apiClient.get<EliminationsResponse>("/api/intercompany/eliminations", {
    params: { period_end: periodEnd },
  })
  return data
}

async function getConsolidatedTb(periodEnd: string): Promise<ConsolidatedTbResponse> {
  const { data } = await apiClient.get<ConsolidatedTbResponse>("/api/intercompany/consolidated-tb", {
    params: { period_end: periodEnd },
  })
  return data
}

/**
 * Download a binary export (Eliminations Excel or Consolidated TB Excel).
 * Mirrors the pattern used by the recon Excel export — fetch as Blob,
 * trigger a browser download via an anchor element, revoke the URL.
 */
async function downloadExport(path: string, periodEnd: string, filename: string): Promise<void> {
  const resp = await apiClient.get(path, {
    params: { period_end: periodEnd },
    responseType: "blob",
  })
  const url = URL.createObjectURL(resp.data as Blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

async function downloadEliminationsXlsx(periodEnd: string): Promise<void> {
  return downloadExport(
    "/api/intercompany/eliminations.xlsx",
    periodEnd,
    `intercompany_eliminations_${periodEnd}.xlsx`,
  )
}

async function downloadConsolidatedTbXlsx(periodEnd: string): Promise<void> {
  return downloadExport(
    "/api/intercompany/consolidated-tb.xlsx",
    periodEnd,
    `consolidated_tb_${periodEnd}.xlsx`,
  )
}

export const icApi = {
  getOverview, autoDetect, aiDetect, autoClassify, upsertMark, deleteMark, getTransactions,
  listAccessibleCompanies, listPairs, createPair, deletePair,
  getEliminations, getConsolidatedTb,
  downloadEliminationsXlsx, downloadConsolidatedTbXlsx,
}
