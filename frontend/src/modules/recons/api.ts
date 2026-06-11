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
  /** Ticked = reconciled/cleared this period. Falsy/absent = still open
   *  (outstanding) — open items are listed in the reconciliation PDF. */
  cleared?:   boolean
}

export interface OverviewEvidenceFile {
  id:          string
  file_name:   string
  mime_type:   string
  uploaded_at: string | null
}

export type AiCommentaryConfidence    = "high" | "medium" | "low"
export type AiCommentaryRecommendation = "approve" | "review" | "investigate"
export type AiCommentaryCheckStatus    = "pass" | "warn" | "fail"

export interface AiCommentaryCheck {
  name:   string
  status: AiCommentaryCheckStatus
  detail: string
}

/** A reconciling item the AI thinks looks unrelated / out-of-period /
 *  doubtful, with the reason and what to do about it. (actionable layer) */
export interface AiCommentaryItemFlag {
  label:    string
  amount:   string
  reason:   string
  action:   string
  severity: "low" | "medium" | "high"
}

export interface AiCommentary {
  generated_at:   string
  /** One-line reviewer verdict. (actionable layer) */
  headline?:      string
  confidence:     AiCommentaryConfidence
  checks:         AiCommentaryCheck[]
  recommendation: AiCommentaryRecommendation
  /** Concrete next actions for the preparer/reviewer. (actionable layer) */
  recommendations?: string[]
  /** Reconciling items that look wrong for this account/period. (actionable layer) */
  item_flags?:    AiCommentaryItemFlag[]
  narrative:      string
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
  subledger_is_rollforward?: boolean    // default subledger came from prior period close
  // Tells the UI which prior source the roll-forward came from:
  //   "subledger" — a reconciled prior-period subledger (most reliable)
  //   "gl"        — prior period's GL balance snapshot (audit-ready fallback
  //                 when no reconciled prior exists)
  //   null        — no roll-forward; subledger came from a different default
  rollforward_source?:    "subledger" | "gl" | null
  rollforward_from?:      string | null  // ISO date of the prior period we rolled from
  // Canonical opening balance for this period. The inline subledger
  // form's build-up uses this DIRECTLY so opening = prior period
  // close (never the current period's saved subledger). Without this
  // the form was falling back to subledger_balance when no prior
  // reconciled period existed, which made AI-prepared accounts look
  // like AI was overriding the opening.
  rollforward_opening_balance?: string
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
  // Set when the agentic preparer tied this row out. Null on human-
  // prepared rows. The expanded form renders an AI Commentary card
  // off this field; a sparkle badge appears on the row in the table.
  ai_commentary:          AiCommentary | null
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

export interface TbCheck {
  period_end:         string
  ytd_start:          string
  // Three sides of the balance sheet (positive totals, signs already
  // flipped on the credit-natural sides so they read naturally in UI).
  total_assets:       string
  total_liabilities:  string
  total_equity:       string
  // Math result: Assets − Liabilities − Equity. Must equal QBO's YTD NI
  // on a balanced GL.
  implied_net_income: string
  // QBO's reported YTD Net Income — independent cross-check from the
  // ProfitAndLoss report. Null when that pull failed.
  actual_net_income:  string | null
  // implied − actual; null when actual_net_income is null. Tiny diffs
  // (< $1) are treated as balanced for floating-point tolerance.
  difference:         string | null
  // True/false when actual_net_income is present; null when it isn't.
  balanced:           boolean | null
  // Set when the P&L pull failed.
  pl_error:           string | null
}

export interface Overview {
  period_end:      string
  qbo_connected:   boolean
  accounts:        OverviewAccount[]
  totals:          { gl: string; subledger: string; variance: string }
  by_group:        OverviewGroup[]
  is_closed?:      boolean
  closed_by?:      string | null
  closed_at?:      string | null
  closed_notes?:   string | null
  // Trial-balance proof — computed server-side, surfaces on the
  // dashboard so the user can verify the QBO sync is internally
  // consistent before doing close work on top of it.
  tb_check?:       TbCheck | null
  // True once the period has been Synced at least once. When false,
  // the dashboard renders the "Sync from QuickBooks" CTA instead of
  // the empty-state table. GET /overview is pure DB read — the
  // backend never auto-pulls from QBO. POST /sync is the only thing
  // that populates this and the snapshot tables.
  synced?:         boolean
  synced_at?:      string | null
  // Count of approved accounts auto-reverted to needs-review because this sync
  // changed their balances so they no longer tie out.
  reflagged?:      number
  // Ingest integrity of the last sync: did our parse of the QBO trial balance
  // tie out (debits = credits)? tb_balanced false = incomplete/bad data.
  sync_health?:    { tb_balanced: boolean | null; tb_diff: string | null }
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

// ── Agentic preparer ────────────────────────────────────────────────────────

export interface AgenticAccountResult {
  qbo_account_id:  string
  account_name:    string
  account_number:  string
  action:          "prepared" | "analyzed" | "skipped"
  reason:          string
  items_added:     number
  gap_before:      string
  gap_after:       string
}

export interface AgenticResult {
  period_end:   string
  prepared:     number
  analyzed:     number
  skipped:      number
  failed:       number
  accounts:     AgenticAccountResult[]
  duration_ms:  number
  started_at:   string
}

/**
 * Run the AI agentic preparer on every open account in the period.
 * One-shot per click — the user explicitly triggered it. Server-side
 * loops through accounts, ties subledger to GL where the math works
 * (saves override + marks status=reviewed), and asks Claude to analyze
 * the gap for accounts that don't tie.
 *
 * Synchronous response — typical 20-account period takes 5-15s. Caller
 * should show a spinner and invalidate the overview query on success.
 */
async function runAgenticPrep(periodEnd: string): Promise<AgenticResult> {
  const { data } = await apiClient.post<AgenticResult>(
    "/api/reconciliations/agentic/run",
    null,
    {
      params: { period_end: periodEnd },
      // QBO + AI together can be slow on a big period. 5 min ceiling
      // matches sync + PDF for consistency.
      timeout: 5 * 60_000,
    },
  )
  return data
}

/**
 * Per-row Agentic — run the same engine on ONE account. Used by the
 * per-row "Run AI" button in the recons table. Returns the same
 * AgenticResult shape (with `accounts: [...]` of length 1) so the UI
 * can reuse the bulk banner renderer for feedback.
 */
async function runAgenticPrepForAccount(
  periodEnd: string, qboAccountId: string,
): Promise<AgenticResult> {
  const { data } = await apiClient.post<AgenticResult>(
    "/api/reconciliations/agentic/run-one",
    null,
    {
      params: { period_end: periodEnd, qbo_account_id: qboAccountId },
      timeout: 60_000,   // ~5-15s typical; 60s ceiling for slow QBO
    },
  )
  return data
}

export interface AgenticResetResult {
  reset:      number
  period_end: string
  message:    string
}

/**
 * Reset all AI-prepared work for the period. Clears subledger_total,
 * reconciling items, AI commentary, and resets status back to pending
 * on every row AI touched. Lets the user switch from AI-prepared back
 * to manual reconciliation without per-row editing.
 */
async function resetAgenticPrep(periodEnd: string): Promise<AgenticResetResult> {
  const { data } = await apiClient.post<AgenticResetResult>(
    "/api/reconciliations/agentic/reset",
    null,
    { params: { period_end: periodEnd }, timeout: 60_000 },
  )
  return data
}

/**
 * Ask an in-flight agentic run to stop. The backend checks the cancel
 * flag between accounts — the current account finishes and commits,
 * then the run exits with everything-so-far. Calling cancel when
 * nothing is running is a harmless no-op.
 */
async function cancelAgenticPrep(periodEnd: string): Promise<{ cancelled: true; period_end: string }> {
  const { data } = await apiClient.post<{ cancelled: true; period_end: string }>(
    "/api/reconciliations/agentic/cancel",
    null,
    { params: { period_end: periodEnd }, timeout: 10_000 },
  )
  return data
}


/**
 * Explicit "Sync from QuickBooks" — fetches fresh TrialBalance, AR/AP
 * aging, and YTD net income from QBO and persists them as snapshots.
 * Takes 3-8s; returns the freshly-built Overview so the caller can
 * skip a follow-up getOverview round-trip.
 */
async function syncPeriod(periodEnd: string): Promise<Overview> {
  const { data } = await apiClient.post<Overview>("/api/reconciliations/sync", null, {
    params: { period_end: periodEnd },
    // QBO can be slow — 5min ceiling matches the PDF export timeout
    timeout: 5 * 60_000,
  })
  return data
}

/**
 * Result of a per-row account sync: just the freshly-pulled GL balance
 * for one (account, period). The recon dashboard patches the row in
 * place from this payload — no full overview refetch needed.
 */
export interface AccountSyncResult {
  qbo_account_id: string
  period_end:     string
  account_name:   string
  account_number: string | null
  account_type:   string
  gl_balance:     string
  captured_at:    string | null
}

async function syncOneAccount(qboAccountId: string, periodEnd: string): Promise<AccountSyncResult> {
  const { data } = await apiClient.post<AccountSyncResult>(
    `/api/reconciliations/account/${encodeURIComponent(qboAccountId)}/sync`,
    null,
    { params: { period_end: periodEnd } },
  )
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

/**
 * Per-account reconciliation PDF. Bundles GL/Subledger/Variance summary,
 * the full reconciling-items build-up, prepared/approved trail, notes,
 * and the list of supporting evidence files into an audit-ready working
 * paper. Triggers a browser download on success; throws a useful error
 * (parsed from the JSON body) on failure so the caller can surface it.
 */
async function downloadAccountPdf(
  qboAccountId: string,
  periodEnd: string,
  fallbackName?: string,
): Promise<void> {
  try {
    const resp = await apiClient.get(
      `/api/reconciliations/account/${encodeURIComponent(qboAccountId)}/pdf`,
      {
        params: { period_end: periodEnd },
        responseType: "blob",
        // PDF render is fast (~100ms) but allow a generous ceiling for
        // unusually large reconciling-items sets.
        timeout: 60_000,
      },
    )
    if (!resp.data || (resp.data as Blob).size === 0) {
      throw new Error("Server returned an empty PDF. Try again.")
    }
    // The server suggests a clean filename via Content-Disposition; honor it.
    const cd = (resp.headers as Record<string, string>)["content-disposition"] ?? ""
    const fnameMatch = cd.match(/filename="([^"]+)"/)
    const fname = fnameMatch
      ? fnameMatch[1]
      : `reconciliation-${periodEnd}-${(fallbackName ?? qboAccountId).replace(/[^a-z0-9-]/gi, "-")}.pdf`
    const url = URL.createObjectURL(new Blob([resp.data], { type: "application/pdf" }))
    const a = document.createElement("a")
    a.href = url
    a.download = fname
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  } catch (e: unknown) {
    // axios + responseType=blob → error body is a Blob. Read it back so
    // the user sees the real backend detail string instead of "Network Error".
    const err = e as { response?: { data?: Blob; status?: number }; message?: string }
    if (err.response?.data instanceof Blob) {
      try {
        const txt = await err.response.data.text()
        const parsed = JSON.parse(txt) as { detail?: string }
        throw new Error(parsed.detail ?? `HTTP ${err.response.status}`)
      } catch (parseErr) {
        if (parseErr instanceof Error && parseErr.message.startsWith("HTTP")) throw parseErr
        throw new Error(err.message ?? "PDF download failed")
      }
    }
    throw new Error(err.message ?? "PDF download failed — check your network and try again.")
  }
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

async function getPeriodEntries(
  qboAccountId: string,
  periodEnd: string,
  opts: { includeYtdNi?: boolean } = {},
): Promise<PeriodEntries> {
  const { data } = await apiClient.get<PeriodEntries>(
    `/api/reconciliations/account/${encodeURIComponent(qboAccountId)}/period-entries`,
    {
      params: {
        period_end: periodEnd,
        // Only sent when the account is Retained Earnings — backend
        // prepends a synthetic YTD-net-income row that the user can
        // check to close the SL-vs-GL gap caused by P&L absorption.
        ...(opts.includeYtdNi ? { include_ytd_ni: true } : {}),
      },
    },
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

// ── Bank reconciliation worksheet ──────────────────────────────────────

export interface BankStatementRow {
  id:                string
  txn_date:          string
  amount:            string  // signed: + = deposit, − = withdrawal
  description:       string | null
  bank_ref:          string | null
  match_status:      "cleared" | "bank_only" | "unmatched" | string
  matched_gl_txn_id: string | null
  match_confidence:  string | null
}

export interface BankGlRow {
  qbo_txn_id:  string | null
  txn_date:    string | null
  txn_type:    string | null
  txn_number:  string | null
  amount:      string  // signed
  memo:        string | null
  entity_name: string | null
}

export interface BankReconWorksheet {
  uploaded:    boolean
  filename:    string | null
  uploaded_at: string | null
  cleared:     Array<{ bank: BankStatementRow; gl: BankGlRow; score: number }>
  bank_only:   BankStatementRow[]
  gl_only:     BankGlRow[]
  summary: {
    cleared_count:     number
    bank_only_count:   number
    gl_only_count:     number
    cleared_total:     string
    bank_only_total:   string
    gl_only_total:     string
  }
  // Statement control totals for the cross-foot tie-out check. Values are
  // null when the parser couldn't read the statement's opening/ending balance
  // (tie_out_ok null = unverifiable, not a failure).
  statement_totals: {
    opening_balance: string | null
    ending_balance:  string | null
    line_sum:        string | null
    tie_out_ok:      boolean | null
    tie_out_diff:    string | null
  }
}

async function uploadBankStatement(
  qboAccountId: string,
  periodEnd: string,
  file: File,
): Promise<BankReconWorksheet> {
  const fd = new FormData()
  fd.append("file", file)
  const { data } = await apiClient.post<BankReconWorksheet>(
    `/api/reconciliations/account/${encodeURIComponent(qboAccountId)}/bank-statement/upload`,
    fd,
    {
      params: { period_end: periodEnd },
      headers: { "Content-Type": undefined as unknown as string },
    },
  )
  return data
}

async function getBankWorksheet(
  qboAccountId: string,
  periodEnd: string,
  refresh = false,
): Promise<BankReconWorksheet> {
  const { data } = await apiClient.get<BankReconWorksheet>(
    `/api/reconciliations/account/${encodeURIComponent(qboAccountId)}/bank-statement`,
    { params: { period_end: periodEnd, ...(refresh ? { refresh: true } : {}) } },
  )
  return data
}

async function clearBankStatement(
  qboAccountId: string,
  periodEnd: string,
): Promise<{ deleted: number }> {
  const { data } = await apiClient.delete<{ deleted: number }>(
    `/api/reconciliations/account/${encodeURIComponent(qboAccountId)}/bank-statement`,
    { params: { period_end: periodEnd } },
  )
  return data
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

export interface ScheduleSubledger {
  is_schedule_backed: boolean
  schedule_type:      string | null   // prepaid | accrual | fixed_asset_cost | ... | loan
  subledger_balance:  string | null   // signed (debit-positive) authoritative schedule balance
  item_count?:        number
}

/** For schedule-backed accounts (prepaid/accrual/FA/lease/loan), the schedule's
 *  authoritative computed balance — used as the subledger build-up's base line
 *  so the balance auto-pulls without listing each schedule entry. */
async function getScheduleSubledger(qboAccountId: string, periodEnd: string): Promise<ScheduleSubledger> {
  const { data } = await apiClient.get<ScheduleSubledger>(
    `/api/reconciliations/account/${encodeURIComponent(qboAccountId)}/schedule-subledger`,
    { params: { period_end: periodEnd } },
  )
  return data
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
  // Set on Retained Earnings accounts when the backend added YTD net
  // income to the proposed opening. UI uses these to render the
  // "RE balance + YTD NI = combined" breakdown.
  combined_with_ytd_ni?: boolean
  original_gl_balance?:  string
  ytd_ni_added?:         string
}

export interface SeedPreview {
  books_start:       string
  seed_date:         string
  accounts:          SeedPreviewAccount[]
  warning?:          string | null
  // RE-specific context — populated when at least one Retained Earnings
  // account was detected. The wizard uses these to explain why the RE
  // proposed opening differs from the raw GL value.
  ytd_ni?:               string | null
  ytd_ni_period?:        [string, string] | null
  ytd_ni_error?:         string | null
  re_accounts_adjusted?: string[]
  skipped_pl_count?: number   // Income/Expense/COGS accounts that always open at $0
  // Which QBO realm + company this preview was pulled from. Surfaced
  // in the wizard so the user can verify they're connected to the
  // company they intended (catches the "Intuit picker silently reused
  // the same sandbox" case).
  qbo_source?: {
    realm_id:     string
    company_name: string | null
  }
  diagnostics?: {
    tb_rows:                  number
    tb_names:                 string[]
    misses:                   string[]
    raw_qbo_account_count?:   number
    balance_sheet_kept?:      number
    balance_sheet_skipped?:   number
  }
}

async function getBooksStatus(): Promise<BooksStatus> {
  const { data } = await apiClient.get<BooksStatus>("/api/reconciliations/setup/books-status")
  return data
}

async function getSeedPreview(booksStart: string): Promise<SeedPreview> {
  const { data } = await apiClient.get<SeedPreview>(
    "/api/reconciliations/setup/seed-preview",
    { params: { books_start: booksStart } },
  )
  return data
}

async function seedBooks(
  booksStart: string,
  accounts: { qbo_id: string; opening_balance: string; source_note?: string }[],
): Promise<{ books_start_date: string; seed_date: string; accounts_seeded: number }> {
  const { data } = await apiClient.post("/api/reconciliations/setup/seed", {
    books_start: booksStart,
    accounts,
  })
  return data
}

export type PeriodStatus = "not_started" | "in_progress" | "complete" | "closed"

export interface PeriodTrackerEntry {
  period_end:   string
  label:        string             // "Apr 2026"
  status:       PeriodStatus
  counts:       { pending: number; reviewed: number; approved: number; flagged: number }
  total:        number
  approved_pct: number
  closed_by:    string | null
  closed_at:    string | null
}

async function listPeriodTracker(): Promise<{ books_start_date: string; periods: PeriodTrackerEntry[] }> {
  const { data } = await apiClient.get<{ books_start_date: string; periods: PeriodTrackerEntry[] }>(
    "/api/reconciliations/admin/periods",
  )
  return data
}

async function closePeriod(periodEnd: string, notes?: string): Promise<{ period_end: string; closed_at: string; closed_by: string }> {
  const { data } = await apiClient.post("/api/reconciliations/admin/close-period", {
    period_end: periodEnd, notes,
  })
  return data
}

async function reopenPeriod(periodEnd: string): Promise<{ period_end: string; status: string }> {
  const { data } = await apiClient.post("/api/reconciliations/admin/reopen-period", { period_end: periodEnd })
  return data
}

async function listClosedPeriods(): Promise<{ period_end: string; closed_by: string; closed_at: string; notes: string | null }[]> {
  const { data } = await apiClient.get<{ periods: { period_end: string; closed_by: string; closed_at: string; notes: string | null }[] }>(
    "/api/reconciliations/admin/closed-periods",
  )
  return data.periods
}

async function listOverrides(periodEnd?: string): Promise<OverrideEntry[]> {
  const { data } = await apiClient.get<{ overrides: OverrideEntry[] }>(
    "/api/reconciliations/admin/overrides",
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
  syncPeriod,
  syncOneAccount,
  runAgenticPrep,
  runAgenticPrepForAccount,
  resetAgenticPrep,
  cancelAgenticPrep,
  downloadAccountPdf,
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
  // Bank reconciliation worksheet
  uploadBankStatement,
  getBankWorksheet,
  clearBankStatement,
  verifyEvidence,
  getPriorOverride,
  getScheduleSubledger,
  getPeriodEntries,
  getBooksStatus,
  getSeedPreview,
  seedBooks,
  closePeriod,
  reopenPeriod,
  listClosedPeriods,
  listPeriodTracker,
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
