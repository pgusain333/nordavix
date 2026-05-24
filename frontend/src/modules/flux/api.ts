/**
 * Nordavix Flux API client — typed wrappers around apiClient (axios instance).
 *
 * All functions talk to the backend at VITE_API_BASE_URL/api/flux/*.
 * Auth headers are injected automatically by the apiClient interceptor
 * which gets the Clerk session token via ClerkApiWirer on mount.
 */
import { apiClient } from "@/core/api/client"

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TrialBalance {
  approved_by?: string | null
  approved_at?: string | null
  id:                   string
  name:                 string
  period_current:       string   // ISO date "YYYY-MM-DD"
  period_prior:         string
  status:               string   // pending | processing | parsed | ready_for_review | generating | complete | error
  materiality_threshold:string   // Decimal as string
  error_detail:         string | null
  created_at:           string
}

export interface TrialBalanceCreate {
  name:                  string
  period_current:        string   // ISO date — END of current period
  period_prior:          string   // ISO date — END of prior period (typically current minus 1 yr)
  materiality_threshold: number
  // Optional period START dates. When provided, the backend range-scopes
  // the QBO TrialBalance pull (P&L accounts get period activity, BS accounts
  // are still snapshots at end_date).
  period_start_current?: string
  period_start_prior?:   string
}

export interface ColumnMapping {
  account_number:  string
  account_name:    string
  current_balance?:string
  prior_balance?:  string
  // QBO two-period TB layout (Debit/Credit columns)
  current_debit?:  string
  current_credit?: string
  prior_debit?:    string
  prior_credit?:   string
  layout?:         "balance_pair" | "qbo_single_period_dc" | "qbo_two_period_dc"
}

export interface UploadPreview {
  headers:          string[]
  sample_rows:      (string | number | null)[][]
  detected_mapping: Partial<ColumnMapping>
}

export interface ParseResult {
  accounts_created: number
  variances_created:number
  material_count:   number
}

export interface VarianceRow {
  id:               string
  account_id:       string
  account_number:   string
  account_name:     string
  current_balance:  string
  prior_balance:    string
  dollar_variance:  string
  pct_variance:     string | null
  is_material:      boolean
  anomaly_flags:    string[]
  status:           string   // pending | generating | generated | approved | edited | flagged
  fs_category:      string | null
  narrative:        string | null
  confidence_score: string | null
  approved_by?:     string | null
  approved_at?:     string | null
}

export interface QboConnection {
  id:        string
  realm_id:  string
  company:   string
  connected_at: string
}

// ── Trial Balances ────────────────────────────────────────────────────────────

async function listTrialBalances(): Promise<TrialBalance[]> {
  const { data } = await apiClient.get<TrialBalance[]>("/api/flux/trial-balances")
  return data
}

async function createTrialBalance(body: TrialBalanceCreate): Promise<TrialBalance> {
  const { data } = await apiClient.post<TrialBalance>("/api/flux/trial-balances", body)
  return data
}

/**
 * Create a flux analysis directly from QuickBooks Online — no file upload.
 * Server pulls the TrialBalance report for both periods, parses it, and
 * starts variance computation. Returns the TB with status=processing/
 * parsed/generating.
 */
async function createTrialBalanceFromQbo(body: TrialBalanceCreate): Promise<TrialBalance> {
  const { data } = await apiClient.post<TrialBalance>("/api/flux/trial-balances/from-qbo", body)
  return data
}

async function getTrialBalance(id: string): Promise<TrialBalance> {
  const { data } = await apiClient.get<TrialBalance>(`/api/flux/trial-balances/${id}`)
  return data
}

async function resetTrialBalance(id: string): Promise<void> {
  await apiClient.post(`/api/flux/trial-balances/${id}/reset`)
}

async function deleteTrialBalance(id: string): Promise<void> {
  await apiClient.delete(`/api/flux/trial-balances/${id}`)
}

async function approveTrialBalance(id: string): Promise<TrialBalance> {
  const { data } = await apiClient.post<TrialBalance>(`/api/flux/trial-balances/${id}/approve`)
  return data
}

// ── Upload & Parse ────────────────────────────────────────────────────────────

async function uploadFile(id: string, file: File): Promise<UploadPreview> {
  const form = new FormData()
  form.append("file", file)
  const { data } = await apiClient.post<UploadPreview>(
    `/api/flux/trial-balances/${id}/upload`,
    form,
    { headers: { "Content-Type": "multipart/form-data" } }
  )
  return data
}

async function parseColumns(id: string, mapping: ColumnMapping): Promise<ParseResult> {
  const { data } = await apiClient.post<ParseResult>(
    `/api/flux/trial-balances/${id}/parse`,
    { mapping }
  )
  return data
}

async function runFlux(id: string): Promise<{ task_id: string; status: string; message?: string }> {
  const { data } = await apiClient.post(`/api/flux/trial-balances/${id}/run`)
  return data
}

// ── Variances ─────────────────────────────────────────────────────────────────

async function listVariances(tbId: string): Promise<VarianceRow[]> {
  const { data } = await apiClient.get<VarianceRow[]>(
    `/api/flux/trial-balances/${tbId}/variances`
  )
  return data
}

async function approveVariance(tbId: string, varId: string): Promise<VarianceRow> {
  const { data } = await apiClient.post<VarianceRow>(
    `/api/flux/trial-balances/${tbId}/variances/${varId}/approve`
  )
  return data
}

async function updateNarrative(tbId: string, varId: string, content: string): Promise<VarianceRow> {
  const { data } = await apiClient.put<VarianceRow>(
    `/api/flux/trial-balances/${tbId}/variances/${varId}/narrative`,
    { content }
  )
  return data
}

async function regenerateNarrative(tbId: string, varId: string): Promise<{ id: string; status: string }> {
  const { data } = await apiClient.post<{ id: string; status: string }>(
    `/api/flux/trial-balances/${tbId}/variances/${varId}/regenerate`
  )
  return data
}

// ── Variance transactions ────────────────────────────────────────────────────

export interface VarianceTxn {
  id:          string
  qbo_txn_id:  string | null
  txn_type:    string
  txn_number:  string
  txn_date:    string | null
  amount:      string
  memo:        string
  entity_name: string
  is_checked:  boolean
  checked_by:  string | null
  checked_at:  string | null
}

export interface VarianceTransactionsResponse {
  variance_id:    string
  qbo_account_id: string | null
  is_material:    boolean
  checked_count:  number
  total_count:    number
  transactions:   VarianceTxn[]
}

async function getVarianceTransactions(tbId: string, varId: string, refresh = false): Promise<VarianceTransactionsResponse> {
  const { data } = await apiClient.get<VarianceTransactionsResponse>(
    `/api/flux/trial-balances/${tbId}/variances/${varId}/transactions`,
    { params: { refresh } },
  )
  return data
}

async function toggleVarianceTransactionCheck(tbId: string, varId: string, txnId: string): Promise<VarianceTxn> {
  const { data } = await apiClient.post<VarianceTxn>(
    `/api/flux/trial-balances/${tbId}/variances/${varId}/transactions/${txnId}/check`,
  )
  return data
}

// ── Export ────────────────────────────────────────────────────────────────────

function exportUrl(tbId: string): string {
  const base = import.meta.env.VITE_API_BASE_URL ?? ""
  return `${base}/api/flux/trial-balances/${tbId}/export`
}

async function exportExcel(tbId: string, fileName?: string): Promise<void> {
  const { data } = await apiClient.get(`/api/flux/trial-balances/${tbId}/export`, {
    responseType: "blob",
  })
  const url = URL.createObjectURL(new Blob([data]))
  const a = document.createElement("a")
  a.href = url
  a.download = fileName ?? "flux-analysis.xlsx"
  a.click()
  URL.revokeObjectURL(url)
}

// ── QBO ───────────────────────────────────────────────────────────────────────

async function getQboConnection(): Promise<QboConnection | null> {
  try {
    const { data } = await apiClient.get<QboConnection>("/api/qbo/connection")
    return data
  } catch {
    return null
  }
}

async function getQboConnectUrl(): Promise<string> {
  // The backend generates the Intuit OAuth URL with the tenant's encoded state.
  // We must call it with auth headers (apiClient) — browser can't navigate there directly.
  const { data } = await apiClient.get<{ url: string }>("/api/qbo/connect-url")
  return data.url
}

async function fetchQboTrialBalance(
  startDate: string,
  endDate:   string
): Promise<TrialBalance> {
  const { data } = await apiClient.get<TrialBalance>("/api/qbo/trial-balance", {
    params: { start_date: startDate, end_date: endDate }
  })
  return data
}

// ── Exported namespace ────────────────────────────────────────────────────────

export const api = {
  // Trial Balances
  listTrialBalances,
  createTrialBalance,
  createTrialBalanceFromQbo,
  getTrialBalance,
  resetTrialBalance,
  deleteTrialBalance,
  approveTrialBalance,
  // Upload & Parse
  uploadFile,
  parseColumns,
  runFlux,
  // Variances
  listVariances,
  approveVariance,
  updateNarrative,
  regenerateNarrative,
  getVarianceTransactions,
  toggleVarianceTransactionCheck,
  // Export
  exportUrl,
  exportExcel,
  // QBO
  getQboConnection,
  getQboConnectUrl,
  fetchQboTrialBalance,
}
