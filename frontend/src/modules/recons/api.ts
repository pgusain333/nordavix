import { apiClient } from "@/core/api/client"

// ── Types ────────────────────────────────────────────────────────────────────

export type ReconType =
  | "AR" | "AP" | "BANK" | "CC"
  | "FIXED_ASSETS"
  | "OTHER_CURRENT_ASSET"
  | "OTHER_ASSET"
  | "OTHER_CURRENT_LIABILITY"
  | "LONG_TERM_LIABILITY"
  | "EQUITY"
  | "OTHER"
export type ReconStatus = "pending" | "syncing" | "computing" | "in_review" | "approved" | "error"
export type ItemStatus  = "pending" | "reviewed" | "approved" | "flagged" | "resolved"
export type RiskLevel   = "low" | "medium" | "high"
export type TxnCategory = "unmatched" | "unapplied_cash" | "duplicate" | "manual_je"

export interface Reconciliation {
  id:                string
  name:              string
  recon_type:        ReconType
  period_end:        string
  gl_total:          string
  subledger_total:   string
  difference:        string
  status:            ReconStatus
  ai_summary:        string | null
  assigned_to:       string | null
  approved_by:       string | null
  approved_at:       string | null
  created_by:        string
  created_at:        string
  updated_at:        string
  error_detail:      string | null
}

export interface ReconciliationItem {
  id:                 string
  reconciliation_id:  string
  entity_name:        string
  entity_qbo_id:      string | null
  gl_balance:         string
  subledger_balance:  string
  difference:         string
  aging_current:      string
  aging_1_30:         string
  aging_31_60:        string
  aging_61_90:        string
  aging_over_90:      string
  risk_level:         RiskLevel
  status:             ItemStatus
  ai_commentary:      string | null
  approved_by:        string | null
  approved_at:        string | null
  notes:              string | null
  created_at:         string
  updated_at:         string
}

export interface ReconTransaction {
  id:                       string
  reconciliation_item_id:   string
  txn_type:                 string
  txn_number:               string | null
  txn_date:                 string | null
  amount:                   string
  memo:                     string | null
  category:                 TxnCategory
  meta:                     Record<string, unknown>
  created_at:               string
}

export interface ReconNote {
  id:                       string
  reconciliation_id:        string
  reconciliation_item_id:   string | null
  author_id:                string
  body:                     string
  created_at:               string
}

export interface ReconciliationDetail {
  recon:        Reconciliation
  items:        ReconciliationItem[]
  transactions: ReconTransaction[]
  notes:        ReconNote[]
}

export interface DashboardStats {
  total:                   number
  completed:               number
  pending_review:          number
  high_risk_accounts:      number
  unresolved_difference:   string
  overdue_aging_total:     string
}

export interface ActivityEntry {
  kind:        "created" | "synced" | "approved" | "noted" | "assigned" | "ai_commentary"
  recon_id:    string
  recon_name:  string
  happened_at: string
  actor_id:    string | null
  summary:     string
}

export interface ReconciliationDashboard {
  stats:       DashboardStats
  recent:      Reconciliation[]
  activity:    ActivityEntry[]
  ai_insights: string[]
}

export interface ReconciliationCreate {
  name:       string
  recon_type: ReconType
  period_end: string
}

// ── Calls ────────────────────────────────────────────────────────────────────

async function listReconciliations(type?: ReconType): Promise<Reconciliation[]> {
  const { data } = await apiClient.get<Reconciliation[]>("/api/reconciliations", {
    params: type ? { type } : undefined,
  })
  return data
}

async function getDashboard(): Promise<ReconciliationDashboard> {
  const { data } = await apiClient.get<ReconciliationDashboard>("/api/reconciliations/dashboard")
  return data
}

async function getReconciliation(id: string): Promise<ReconciliationDetail> {
  const { data } = await apiClient.get<ReconciliationDetail>(`/api/reconciliations/${id}`)
  return data
}

async function createReconciliation(body: ReconciliationCreate): Promise<Reconciliation> {
  const { data } = await apiClient.post<Reconciliation>("/api/reconciliations", body)
  return data
}

async function resyncReconciliation(id: string): Promise<Reconciliation> {
  const { data } = await apiClient.post<Reconciliation>(`/api/reconciliations/${id}/sync`)
  return data
}

async function approveReconciliation(id: string): Promise<Reconciliation> {
  const { data } = await apiClient.post<Reconciliation>(`/api/reconciliations/${id}/approve`)
  return data
}

async function assignReconciliation(id: string, userId: string | null): Promise<Reconciliation> {
  const { data } = await apiClient.post<Reconciliation>(`/api/reconciliations/${id}/assign`, { user_id: userId })
  return data
}

async function addNote(id: string, body: string, itemId?: string | null): Promise<ReconNote> {
  const { data } = await apiClient.post<ReconNote>(`/api/reconciliations/${id}/notes`, {
    body,
    reconciliation_item_id: itemId ?? null,
  })
  return data
}

async function setItemStatus(reconId: string, itemId: string, status: ItemStatus): Promise<ReconciliationItem> {
  const { data } = await apiClient.put<ReconciliationItem>(
    `/api/reconciliations/${reconId}/items/${itemId}/status`,
    { status }
  )
  return data
}

async function explainItem(reconId: string, itemId: string): Promise<ReconciliationItem> {
  // Synchronous AI commentary generation for a single item. Server waits for
  // the Anthropic call to finish and returns the saved commentary inline.
  const { data } = await apiClient.post<ReconciliationItem>(
    `/api/reconciliations/${reconId}/items/${itemId}/explain`
  )
  return data
}

async function explainRecon(reconId: string): Promise<Reconciliation> {
  // Aggregate AI summary for the whole reconciliation, on-demand only.
  const { data } = await apiClient.post<Reconciliation>(
    `/api/reconciliations/${reconId}/explain`
  )
  return data
}

async function deleteReconciliation(id: string): Promise<void> {
  await apiClient.delete(`/api/reconciliations/${id}`)
}

async function exportReconciliation(id: string, fileName?: string): Promise<void> {
  const { data } = await apiClient.get(`/api/reconciliations/${id}/export`, {
    responseType: "blob",
  })
  const url = URL.createObjectURL(new Blob([data]))
  const a = document.createElement("a")
  a.href = url
  a.download = fileName ?? "reconciliation.xlsx"
  a.click()
  URL.revokeObjectURL(url)
}

export const reconsApi = {
  listReconciliations,
  getDashboard,
  getReconciliation,
  createReconciliation,
  resyncReconciliation,
  approveReconciliation,
  assignReconciliation,
  addNote,
  setItemStatus,
  explainItem,
  explainRecon,
  deleteReconciliation,
  exportReconciliation,
}
