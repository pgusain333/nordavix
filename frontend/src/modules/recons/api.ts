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

// ── Live overview shapes ─────────────────────────────────────────────────────

export type AccountReviewStatus = "pending" | "reviewed" | "approved" | "flagged"

export interface ReconcilingItem {
  txn_id:     string
  txn_type:   string
  txn_number: string
  txn_date:   string
  amount:     string
  memo:       string
  entity?:    string
}

export interface OverviewEvidenceFile {
  id:          string
  file_name:   string
  mime_type:   string
  uploaded_at: string | null
}

export interface OverviewAccount {
  qbo_id:                 string
  account_number:         string
  account_name:           string
  account_type:           string
  group_label:            string   // Bank, AR, AP, Fixed Assets, etc.
  gl_balance:             string
  subledger_balance:      string
  subledger_source:       string
  subledger_is_manual:    boolean
  subledger_entered_by:   string | null
  subledger_entered_at:   string | null
  evidence_count:         number
  evidence_files:         OverviewEvidenceFile[]
  reconciling_items:      ReconcilingItem[]
  has_subledger_detail:   boolean
  variance:               string
  review_status:          AccountReviewStatus
  reviewed_by:            string | null
  reviewed_at:            string | null
  review_notes:           string | null
}

export interface PeriodEntries {
  rows:         ReconcilingItem[]
  period_start: string
  period_end:   string
  total:        string
}

export type VerificationConfidence = "high" | "medium" | "low"
export type VerificationMatchStatus = "match" | "mismatch" | "unknown"

export interface EvidenceVerification {
  extracted_balance: string | null
  statement_date:    string | null
  doc_type:          string
  doc_identifier:    string | null
  summary:           string
  confidence:        VerificationConfidence
  match_status:      VerificationMatchStatus
  difference:        string | null
  model:             string
  verified_at:       string
}

export interface EvidenceFile {
  id:           string
  file_name:    string
  file_size:    number
  mime_type:    string
  uploaded_by:  string
  uploaded_at:  string
  verification: EvidenceVerification | null
}

export type OverrideVerificationState = "match" | "mismatch" | "unknown" | "unverified"

export interface OverrideEntry {
  qbo_account_id:        string
  period_end:            string
  subledger_total:       string | null
  subledger_source:      string | null
  subledger_entered_by:  string | null
  subledger_entered_at:  string | null
  status:                AccountReviewStatus
  reviewed_by:           string | null
  reviewed_at:           string | null
  evidence_count:        number
  verification_state:    OverrideVerificationState
}

export interface OverviewGroup {
  group:     string
  count:     number
  gl:        string
  subledger: string
  variance:  string
}

export interface Overview {
  period_end:     string
  qbo_connected:  boolean
  accounts:       OverviewAccount[]
  totals:         { gl: string; subledger: string; variance: string }
  by_group:       OverviewGroup[]
}

export interface SubledgerRow {
  label:   string
  qbo_id?: string | null
  current?:string
  "1_30"?: string
  "31_60"?:string
  "61_90"?:string
  over_90?:string
  total?:  string
  txn_id?: string
  txn_type?: string
  txn_number?: string
  txn_date?: string
  amount?: string
  memo?:   string
}

export interface SubledgerDetail {
  account: {
    qbo_id:         string
    name:           string
    account_number: string
    account_type:   string
    gl_balance:     string
  } | null
  rows:   SubledgerRow[]
  source: string
}

export interface VarianceRow {
  txn_id:     string
  txn_type:   string
  txn_number: string
  txn_date:   string
  amount:     string
  memo:       string
  entity?:    string
  flag?:      string
}

export interface VarianceDetail {
  rows:   VarianceRow[]
  source: string
  total:  string
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

// ── Live overview calls ─────────────────────────────────────────────────────

async function getOverview(periodEnd: string): Promise<Overview> {
  const { data } = await apiClient.get<Overview>("/api/reconciliations/overview", {
    params: { period_end: periodEnd },
  })
  return data
}

async function getAccountSubledger(qboAccountId: string, periodEnd: string): Promise<SubledgerDetail> {
  const { data } = await apiClient.get<SubledgerDetail>(
    `/api/reconciliations/account/${encodeURIComponent(qboAccountId)}/subledger`,
    { params: { period_end: periodEnd } },
  )
  return data
}

async function getAccountVariance(qboAccountId: string, periodEnd: string): Promise<VarianceDetail> {
  const { data } = await apiClient.get<VarianceDetail>(
    `/api/reconciliations/account/${encodeURIComponent(qboAccountId)}/variance`,
    { params: { period_end: periodEnd } },
  )
  return data
}

async function clearSyncedData(): Promise<void> {
  await apiClient.post("/api/reconciliations/clear-synced-data")
}

async function updateAccountReviewStatus(
  qboAccountId: string,
  periodEnd: string,
  status: AccountReviewStatus,
  notes?: string,
): Promise<{ qbo_account_id: string; period_end: string; status: AccountReviewStatus; reviewed_by: string | null; reviewed_at: string | null }> {
  const { data } = await apiClient.post(
    `/api/reconciliations/account/${encodeURIComponent(qboAccountId)}/status`,
    null,
    { params: { period_end: periodEnd, status, notes } },
  )
  return data
}

async function setSubledgerOverride(
  qboAccountId: string,
  periodEnd: string,
  total: number | null,
  source: string | null,
  reconcilingItems?: ReconcilingItem[],
): Promise<{
  qbo_account_id: string
  period_end:     string
  subledger_total:  string | null
  subledger_source: string | null
  is_manual:      boolean
}> {
  const { data } = await apiClient.post(
    `/api/reconciliations/account/${encodeURIComponent(qboAccountId)}/subledger`,
    {
      period_end: periodEnd,
      total,
      source,
      reconciling_items: reconcilingItems ?? [],
    },
  )
  return data
}

async function getPeriodEntries(qboAccountId: string, periodEnd: string): Promise<PeriodEntries> {
  const { data } = await apiClient.get<PeriodEntries>(
    `/api/reconciliations/account/${encodeURIComponent(qboAccountId)}/period-entries`,
    { params: { period_end: periodEnd } },
  )
  return data
}

async function listAccountEvidence(qboAccountId: string, periodEnd: string): Promise<EvidenceFile[]> {
  const { data } = await apiClient.get<{ evidence: EvidenceFile[] }>(
    `/api/reconciliations/account/${encodeURIComponent(qboAccountId)}/evidence`,
    { params: { period_end: periodEnd } },
  )
  return data.evidence
}

async function uploadAccountEvidence(
  qboAccountId: string,
  periodEnd: string,
  file: File,
): Promise<EvidenceFile> {
  const fd = new FormData()
  fd.append("file", file)
  const { data } = await apiClient.post<EvidenceFile>(
    `/api/reconciliations/account/${encodeURIComponent(qboAccountId)}/evidence`,
    fd,
    {
      params: { period_end: periodEnd },
      // Clear the default JSON Content-Type so axios detects FormData and
      // writes "multipart/form-data; boundary=<...>" itself. Setting the
      // header manually to "multipart/form-data" drops the boundary and the
      // server can't split the body — that was the silent-upload bug.
      headers: { "Content-Type": undefined as unknown as string },
    },
  )
  return data
}

async function deleteAccountEvidence(evidenceId: string): Promise<void> {
  await apiClient.delete(`/api/reconciliations/evidence/${encodeURIComponent(evidenceId)}`)
}

async function getEvidenceDownloadUrl(evidenceId: string): Promise<{ download_url: string; file_name: string; mime_type: string }> {
  const { data } = await apiClient.get<{ download_url: string; file_name: string; mime_type: string }>(
    `/api/reconciliations/evidence/${encodeURIComponent(evidenceId)}/download`,
  )
  return data
}

async function verifyEvidence(evidenceId: string): Promise<EvidenceVerification> {
  const { data } = await apiClient.post<EvidenceVerification>(
    `/api/reconciliations/evidence/${encodeURIComponent(evidenceId)}/verify`,
  )
  return data
}

export interface PriorPeriodOverride {
  period_end:       string
  subledger_total:  string
  subledger_source: string | null
  status:           AccountReviewStatus
  evidence_count:   number
}

async function getPriorOverride(qboAccountId: string, periodEnd: string): Promise<PriorPeriodOverride | null> {
  const { data } = await apiClient.get<{ prior: PriorPeriodOverride | null }>(
    `/api/reconciliations/account/${encodeURIComponent(qboAccountId)}/prior-override`,
    { params: { period_end: periodEnd } },
  )
  return data.prior
}

export interface BooksStatus {
  books_start_date: string | null
  seeded:           boolean
  seeded_at:        string | null
}

export interface SeedPreviewAccount {
  qbo_id:           string
  account_number:   string
  account_name:     string
  account_type:     string
  group_label:      string
  proposed_opening: string
}

export interface SeedPreview {
  books_start: string
  seed_date:   string
  accounts:    SeedPreviewAccount[]
}

async function getBooksStatus(): Promise<BooksStatus> {
  const { data } = await apiClient.get<BooksStatus>("/api/reconciliations/books-status")
  return data
}

async function getSeedPreview(booksStart: string): Promise<SeedPreview> {
  const { data } = await apiClient.get<SeedPreview>(
    "/api/reconciliations/seed-preview",
    { params: { books_start: booksStart } },
  )
  return data
}

async function seedBooks(
  booksStart: string,
  accounts: { qbo_id: string; opening_balance: string; source_note?: string }[],
): Promise<{ books_start_date: string; seed_date: string; accounts_seeded: number }> {
  const { data } = await apiClient.post("/api/reconciliations/seed", {
    books_start: booksStart,
    accounts,
  })
  return data
}

async function listOverrides(periodEnd?: string): Promise<OverrideEntry[]> {
  const { data } = await apiClient.get<{ overrides: OverrideEntry[] }>(
    "/api/reconciliations/overrides",
    { params: periodEnd ? { period_end: periodEnd } : undefined },
  )
  return data.overrides
}

async function bulkUpdateAccountReviewStatus(
  periodEnd: string,
  status: AccountReviewStatus,
  qboAccountIds: string[],
): Promise<{ updated: number; status: AccountReviewStatus }> {
  const { data } = await apiClient.post(
    "/api/reconciliations/account/bulk-status",
    { period_end: periodEnd, status, qbo_account_ids: qboAccountIds },
  )
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
  getOverview,
  getAccountSubledger,
  getAccountVariance,
  clearSyncedData,
  updateAccountReviewStatus,
  bulkUpdateAccountReviewStatus,
  setSubledgerOverride,
  listAccountEvidence,
  uploadAccountEvidence,
  deleteAccountEvidence,
  getEvidenceDownloadUrl,
  verifyEvidence,
  getPriorOverride,
  getPeriodEntries,
  getBooksStatus,
  getSeedPreview,
  seedBooks,
  listOverrides,
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
