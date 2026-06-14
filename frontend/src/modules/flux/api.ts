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
  // Which lens this analysis is viewed through. "prior" (default) = actual vs
  // same month last year; "expected" = actual vs NDVX's trailing run-rate.
  comparison_mode?:     "prior" | "expected"
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

/**
 * Structured AI commentary from the deeper Agentic Mode.
 * Schema matches backend modules.flux.deep_agentic.run_deep_agentic_for_variance.
 * NULL on rows that only have legacy prose in `narrative`.
 */
export interface AICommentaryDriver {
  label:     string
  amount:    string                       // positive decimal string
  direction: "increase" | "decrease"      // carries the sign
}

export interface AICommentary {
  generated_at:    string
  /** One-line summary of the change + its primary driver. (v2) */
  headline?:       string
  /** Variance bridge — the itemized causes that make up the change. (v2) */
  drivers?:        AICommentaryDriver[]
  /** Sum of signed drivers. (v2) */
  explained_amount?:   string
  /** Residual the drivers don't account for. (v2) */
  unexplained_amount?: string
  narrative:       string
  risk_level:      "low" | "medium" | "high"
  justified:       "yes" | "no" | "needs_review"
  key_entities:    { name: string; type: "customer" | "vendor" | "other"; amount: string }[]
  recommendations: string[]
  confidence:      "low" | "medium" | "high"
}

export interface VarianceRow {
  id:               string
  account_id:       string
  /** QBO account id; null on Excel-uploaded TBs. Drives the per-row sync button. */
  qbo_account_id:   string | null
  account_number:   string
  account_name:     string
  current_balance:  string
  prior_balance:    string
  dollar_variance:  string
  pct_variance:     string | null
  is_material:      boolean
  anomaly_flags:    string[]
  status:           string   // pending | generating | generated | approved | edited | flagged
  // ── Expectation Engine (actual-vs-expected lens) ──────────────────────────
  // NDVX's expected balance for this account + the human-readable basis, and
  // the actual-vs-expected deltas. All null on older analyses / when there
  // isn't enough history to form an expectation. pre_explained is set once a
  // confirmed expectation rule explains the variance up front (Slice 2).
  expected_value?:            string | null
  expected_basis?:            string | null
  dollar_variance_expected?:  string | null
  pct_variance_expected?:     string | null
  pre_explained?:             boolean
  fs_category:      string | null
  narrative:        string | null
  confidence_score: string | null
  approved_by?:     string | null
  approved_at?:     string | null
  ai_commentary?:   AICommentary | null
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

/** Flip the analysis lens between actual-vs-prior and actual-vs-expected.
 *  Persisted on the analysis so the choice sticks for everyone. */
async function setComparisonMode(id: string, mode: "prior" | "expected"): Promise<TrialBalance> {
  const { data } = await apiClient.post<TrialBalance>(
    `/api/flux/trial-balances/${id}/comparison-mode`,
    { mode },
  )
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

/**
 * Flip a variance's review status to pending / generated / edited / flagged.
 * Backs the Mark prepared / Flag / Reset to pending buttons in the
 * variance table's bulk-action bar. "approved" is handled by its own
 * endpoint (approveVariance above) because it also stamps approver
 * metadata + writes a distinct audit event.
 */
async function setVarianceStatus(
  tbId: string,
  varId: string,
  status: "pending" | "generated" | "edited" | "flagged",
): Promise<{ id: string; status: string }> {
  const { data } = await apiClient.post<{ id: string; status: string }>(
    `/api/flux/trial-balances/${tbId}/variances/${varId}/status`,
    { status },
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

// ── Agentic flux (auto-commentary for every material variance) ───────────────

export interface AgenticFluxVarianceResult {
  variance_id:    string
  account_name:   string
  account_number: string
  action:         "generated" | "skipped" | "failed"
  reason:         string
}

export interface AgenticFluxResult {
  tb_id:        string
  started_at:   string
  finished_at:  string
  processed:    number
  skipped:      number
  failed:       number
  variances:    AgenticFluxVarianceResult[]
}

async function runAgenticFlux(tbId: string): Promise<AgenticFluxResult> {
  const { data } = await apiClient.post<AgenticFluxResult>(
    `/api/flux/trial-balances/${tbId}/agentic/run`,
    null,
    // Worst-case 20 variances × 15s = 5 min. Mirror the recons agentic ceiling.
    { timeout: 5 * 60_000 },
  )
  return data
}

async function cancelAgenticFlux(tbId: string): Promise<{ cancelled: true; tb_id: string }> {
  const { data } = await apiClient.post<{ cancelled: true; tb_id: string }>(
    `/api/flux/trial-balances/${tbId}/agentic/cancel`,
    null,
    { timeout: 10_000 },
  )
  return data
}

/**
 * Run the deeper Agentic analysis on ONE variance.
 *
 * Auto-pulls QBO transactions for the variance's change window, asks
 * Claude for a structured analysis (narrative + risk_level + justified
 * + key_entities + recommendations), and persists the result on
 * Variance.ai_commentary. Returns the structured commentary so the UI
 * can render it immediately without waiting for a list refetch.
 */
async function runAgenticOnVariance(
  tbId: string, varId: string,
): Promise<{ variance_id: string; ai_commentary: AICommentary }> {
  const { data } = await apiClient.post<{ variance_id: string; ai_commentary: AICommentary }>(
    `/api/flux/trial-balances/${tbId}/variances/${varId}/agentic/run`,
    null,
    { timeout: 60_000 },   // ~10-15s typical; 60s ceiling for slow QBO
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

// ── Per-account QBO sync (surgical row refresh) ────────────────────────

export interface AccountSyncResult {
  account_id:      string
  qbo_account_id:  string
  account_name:    string
  current_balance: string
  prior_balance:   string
  variance?: {
    id:              string | null
    dollar_variance: string
    pct_variance:    string | null
    is_material:     boolean
    anomaly_flags:   string[]
  } | null
  synced_at:       string
}

async function syncOneAccountFromQbo(
  tbId: string,
  qboAccountId: string,
): Promise<AccountSyncResult> {
  const { data } = await apiClient.post<AccountSyncResult>(
    `/api/flux/trial-balances/${tbId}/accounts/${qboAccountId}/sync`,
  )
  return data
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

/** Per-variance flux working-paper PDF. Server suggests the filename
 *  via Content-Disposition (draft- prefix until approved); honor it. */
async function downloadVariancePdf(
  tbId: string,
  varId: string,
  fallbackName?: string,
): Promise<void> {
  const resp = await apiClient.get(
    `/api/flux/trial-balances/${tbId}/variances/${varId}/pdf`,
    { responseType: "blob", timeout: 60_000 },
  )
  if (!resp.data || (resp.data as Blob).size === 0) {
    throw new Error("Server returned an empty PDF. Try again.")
  }
  const cd = (resp.headers as Record<string, string>)["content-disposition"] ?? ""
  const fname = cd.match(/filename="([^"]+)"/)?.[1]
    ?? fallbackName ?? "flux-variance.pdf"
  const url = URL.createObjectURL(new Blob([resp.data], { type: "application/pdf" }))
  const a = document.createElement("a")
  a.href = url
  a.download = fname
  document.body.appendChild(a)
  a.click()
  a.remove()
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
  setComparisonMode,
  // Upload & Parse
  uploadFile,
  parseColumns,
  runFlux,
  // Variances
  listVariances,
  approveVariance,
  setVarianceStatus,
  updateNarrative,
  regenerateNarrative,
  // Agentic
  runAgenticFlux,
  cancelAgenticFlux,
  runAgenticOnVariance,
  getVarianceTransactions,
  toggleVarianceTransactionCheck,
  // Per-row refresh
  syncOneAccountFromQbo,
  // Export
  exportUrl,
  exportExcel,
  downloadVariancePdf,
  // QBO
  getQboConnection,
  getQboConnectUrl,
  fetchQboTrialBalance,
}
