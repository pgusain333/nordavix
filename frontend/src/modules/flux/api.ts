/**
 * Nordavix Flux API client — typed wrappers around axios calls.
 *
 * All functions talk to the backend at /api/flux/*.
 * Auth headers are injected by ClerkApiWirer on mount.
 */
import axios from "axios"

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TrialBalance {
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
  name:                 string
  period_current:       string
  period_prior:         string
  materiality_threshold:number
}

export interface ColumnMapping {
  account_number: string
  account_name:   string
  current_balance:string
  prior_balance:  string
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
}

export interface QboConnection {
  id:        string
  realm_id:  string
  company:   string
  connected_at: string
}

// ── Client ────────────────────────────────────────────────────────────────────

const BASE = "/api"

// ── Trial Balances ────────────────────────────────────────────────────────────

async function listTrialBalances(): Promise<TrialBalance[]> {
  const { data } = await axios.get<TrialBalance[]>(`${BASE}/flux/trial-balances`)
  return data
}

async function createTrialBalance(body: TrialBalanceCreate): Promise<TrialBalance> {
  const { data } = await axios.post<TrialBalance>(`${BASE}/flux/trial-balances`, body)
  return data
}

async function getTrialBalance(id: string): Promise<TrialBalance> {
  const { data } = await axios.get<TrialBalance>(`${BASE}/flux/trial-balances/${id}`)
  return data
}

// ── Upload & Parse ────────────────────────────────────────────────────────────

async function uploadFile(id: string, file: File): Promise<UploadPreview> {
  const form = new FormData()
  form.append("file", file)
  const { data } = await axios.post<UploadPreview>(
    `${BASE}/flux/trial-balances/${id}/upload`,
    form,
    { headers: { "Content-Type": "multipart/form-data" } }
  )
  return data
}

async function parseColumns(id: string, mapping: ColumnMapping): Promise<ParseResult> {
  const { data } = await axios.post<ParseResult>(
    `${BASE}/flux/trial-balances/${id}/parse`,
    { mapping }
  )
  return data
}

async function runFlux(id: string): Promise<{ task_id: string; status: string }> {
  const { data } = await axios.post(`${BASE}/flux/trial-balances/${id}/run`)
  return data
}

// ── Variances ─────────────────────────────────────────────────────────────────

async function listVariances(tbId: string): Promise<VarianceRow[]> {
  const { data } = await axios.get<VarianceRow[]>(
    `${BASE}/flux/trial-balances/${tbId}/variances`
  )
  return data
}

async function approveVariance(tbId: string, varId: string): Promise<VarianceRow> {
  const { data } = await axios.post<VarianceRow>(
    `${BASE}/flux/trial-balances/${tbId}/variances/${varId}/approve`
  )
  return data
}

async function updateNarrative(tbId: string, varId: string, content: string): Promise<VarianceRow> {
  const { data } = await axios.put<VarianceRow>(
    `${BASE}/flux/trial-balances/${tbId}/variances/${varId}/narrative`,
    { content }
  )
  return data
}

// ── Export ────────────────────────────────────────────────────────────────────

function exportUrl(tbId: string): string {
  return `${BASE}/flux/trial-balances/${tbId}/export`
}

async function exportExcel(tbId: string, fileName?: string): Promise<void> {
  const { data } = await axios.get(exportUrl(tbId), { responseType: "blob" })
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
    const { data } = await axios.get<QboConnection>(`${BASE}/qbo/connection`)
    return data
  } catch {
    return null
  }
}

function qboConnectUrl(): string {
  return `${BASE}/oauth/qbo/connect`
}

async function fetchQboTrialBalance(
  startDate: string,
  endDate:   string
): Promise<TrialBalance> {
  const { data } = await axios.get<TrialBalance>(`${BASE}/qbo/trial-balance`, {
    params: { start_date: startDate, end_date: endDate }
  })
  return data
}

// ── Exported namespace ────────────────────────────────────────────────────────

export const api = {
  // Trial Balances
  listTrialBalances,
  createTrialBalance,
  getTrialBalance,
  // Upload & Parse
  uploadFile,
  parseColumns,
  runFlux,
  // Variances
  listVariances,
  approveVariance,
  updateNarrative,
  // Export
  exportUrl,
  exportExcel,
  // QBO
  getQboConnection,
  qboConnectUrl,
  fetchQboTrialBalance,
}
