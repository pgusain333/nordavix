/**
 * Schedules API client.
 *
 * Thin wrapper around apiClient. One CRUD function set per type via a
 * single generic helper — the backend dispatches off the {type} path
 * segment so the frontend stays DRY.
 */
import { apiClient } from "@/core/api/client"
import type {
  AccrualItem,
  FixedAssetCandidatesList,
  FixedAssetItem,
  FixedAssetScanResult,
  LeaseItem,
  LoanItem,
  MissedAccrualCandidatesList,
  MissedAccrualScanResult,
  Overview,
  PrepaidAlerts,
  PrepaidCandidatesList,
  PrepaidItem,
  PrepaidScanResult,
  ScheduleType,
  Snapshot,
  UnreversedAccrualsList,
} from "@/modules/schedules/types"

type ItemMap = {
  prepaid:     PrepaidItem
  accrual:     AccrualItem
  fixed_asset: FixedAssetItem
  lease:       LeaseItem
  loan:        LoanItem
}

export interface ScheduleAccount {
  qbo_account_id: string
  name:           string
  number:         string
  account_type:   string
  group_label:    string
}

async function listAccounts(kind: "balance_sheet" | "expense" = "balance_sheet"): Promise<ScheduleAccount[]> {
  const { data } = await apiClient.get<{ accounts: ScheduleAccount[] }>(
    "/api/schedules/accounts",
    { params: { kind } },
  )
  return data.accounts
}

async function getOverview(periodEnd: string): Promise<Overview> {
  const { data } = await apiClient.get<Overview>(
    "/api/schedules/overview",
    { params: { period_end: periodEnd } },
  )
  return data
}

async function listItems<T extends ScheduleType>(
  type: T,
  opts: { qbo_account_id?: string; include_inactive?: boolean } = {},
): Promise<{ schedule_type: T; items: ItemMap[T][] }> {
  const { data } = await apiClient.get<{ schedule_type: T; items: ItemMap[T][] }>(
    `/api/schedules/${type}`,
    {
      params: {
        qbo_account_id:   opts.qbo_account_id,
        include_inactive: opts.include_inactive ?? true,
      },
    },
  )
  return data
}

async function createItem<T extends ScheduleType>(
  type: T,
  body: Partial<ItemMap[T]>,
): Promise<ItemMap[T]> {
  const { data } = await apiClient.post<ItemMap[T]>(`/api/schedules/${type}`, body)
  return data
}

async function updateItem<T extends ScheduleType>(
  type: T,
  id: string,
  body: Partial<ItemMap[T]>,
): Promise<ItemMap[T]> {
  const { data } = await apiClient.put<ItemMap[T]>(`/api/schedules/${type}/${id}`, body)
  return data
}

async function deleteItem(type: ScheduleType, id: string): Promise<{ deleted: boolean }> {
  const { data } = await apiClient.delete<{ deleted: boolean }>(`/api/schedules/${type}/${id}`)
  return data
}

async function previewSnapshot(
  type: ScheduleType,
  qboAccountId: string,
  periodEnd: string,
): Promise<Snapshot> {
  const { data } = await apiClient.get<Snapshot>(`/api/schedules/${type}/snapshot`, {
    params: { qbo_account_id: qboAccountId, period_end: periodEnd },
  })
  return data
}

async function commitSnapshot(
  type: ScheduleType,
  qboAccountId: string,
  periodEnd: string,
  notes?: string,
): Promise<Snapshot> {
  const { data } = await apiClient.post<Snapshot>(`/api/schedules/${type}/snapshot/commit`, {
    qbo_account_id: qboAccountId,
    period_end:     periodEnd,
    notes,
  })
  return data
}

// ── Per-item suggestions for the recon inline accordion ─────────────────

/**
 * One prepaid item's contribution to a given account+period. Each is
 * selectable as a subledger component in the recon detail accordion;
 * checking it adds `unamortized_at_period_end` to the recon's SL via
 * the existing reconciling-items mechanism.
 */
export interface PrepaidSuggestion {
  item_id:                     string
  description:                 string
  vendor:                      string | null
  reference:                   string | null
  invoice_date:                string | null
  start_date:                  string
  end_date:                    string
  total_amount:                string
  total_days:                  number
  daily_rate:                  string
  period_amortization:         string
  amortized_to_date:           string
  unamortized_at_period_end:   string
  fully_amortized:             boolean
}

export interface PrepaidSuggestionsResponse {
  qbo_account_id:   string
  period_end:       string
  items:            PrepaidSuggestion[]
  committed:        boolean
  committed_at?:    string | null
  /** True when there are active prepaid items for this account but no
   * committed snapshot for the period yet. UI shows a "commit to
   * surface here" hint so the user knows the workflow gate. */
  has_uncommitted:  boolean
}

async function getPrepaidSuggestions(
  qboAccountId: string,
  periodEnd: string,
): Promise<PrepaidSuggestionsResponse> {
  const { data } = await apiClient.get<PrepaidSuggestionsResponse>(
    "/api/schedules/prepaid/suggestions",
    { params: { qbo_account_id: qboAccountId, period_end: periodEnd } },
  )
  return data
}

/**
 * Delta-based line item for an accrued liability recon. Each accrual
 * can emit up to two of these per period (one when accrued, one when
 * reversed). Amount is signed: positive for accrual, negative for
 * reversal — the recon's existing build-up math (opening + selected)
 * handles the lifecycle without any additional logic.
 */
export interface AccrualSuggestion {
  item_id:          string
  /** Distinguishes the original accrual entry from its reversal. */
  line_kind:        "accrual" | "reversal"
  /** YYYY-MM-DD — accrual_date for accrual, reverses_on for reversal. */
  line_date:        string
  /** Signed: + for accrual, − for reversal. */
  amount:           string
  description:      string
  vendor:           string | null
  reference:        string | null
  /** Lifecycle context — always populated regardless of line_kind. */
  accrual_date:     string
  amount_original:  string
  reverses_on:      string | null
  is_reversed_flag: boolean
}

export interface AccrualSuggestionsResponse {
  qbo_account_id:   string
  period_end:       string
  items:            AccrualSuggestion[]
  committed:        boolean
  committed_at?:    string | null
  has_uncommitted:  boolean
}

async function getAccrualSuggestions(
  qboAccountId: string,
  periodEnd: string,
): Promise<AccrualSuggestionsResponse> {
  const { data } = await apiClient.get<AccrualSuggestionsResponse>(
    "/api/schedules/accrual/suggestions",
    { params: { qbo_account_id: qboAccountId, period_end: periodEnd } },
  )
  return data
}

/**
 * Shared shape for fixed-asset / lease / loan suggestion line items.
 * Each is a signed delta in debit-positive convention (matches the
 * recon's internal storage; the UI's flipSign handles credit-natural
 * display). Selecting the row adds it to the recon's SL build-up.
 */
export interface ScheduleLineSuggestion {
  item_id:     string
  line_kind:   string  // type-specific: addition|disposal|depreciation|initial|principal_payment|origination
  line_date:   string  // YYYY-MM-DD
  amount:      string  // signed string
  description: string
  vendor:      string | null
  reference:   string | null
}

export interface ScheduleSuggestionsResponse {
  qbo_account_id:   string
  period_end:       string
  items:            ScheduleLineSuggestion[]
  committed:        boolean
  committed_at?:    string | null
  has_uncommitted:  boolean
}

async function getFixedAssetSuggestions(qboAccountId: string, periodEnd: string): Promise<ScheduleSuggestionsResponse> {
  const { data } = await apiClient.get<ScheduleSuggestionsResponse>(
    "/api/schedules/fixed_asset/suggestions",
    { params: { qbo_account_id: qboAccountId, period_end: periodEnd } },
  )
  return data
}

async function getLeaseSuggestions(qboAccountId: string, periodEnd: string): Promise<ScheduleSuggestionsResponse> {
  const { data } = await apiClient.get<ScheduleSuggestionsResponse>(
    "/api/schedules/lease/suggestions",
    { params: { qbo_account_id: qboAccountId, period_end: periodEnd } },
  )
  return data
}

async function getLoanSuggestions(qboAccountId: string, periodEnd: string): Promise<ScheduleSuggestionsResponse> {
  const { data } = await apiClient.get<ScheduleSuggestionsResponse>(
    "/api/schedules/loan/suggestions",
    { params: { qbo_account_id: qboAccountId, period_end: periodEnd } },
  )
  return data
}

/**
 * Pure-SQL attention list for the prepaids module: every active item
 * expiring within `expiringWithinDays` of period_end, or already past
 * its end_date. Drives the renewal-alerts banner on PrepaidsPage. No
 * QBO call, no AI — fast.
 */
async function getPrepaidAlerts(periodEnd: string, expiringWithinDays = 60): Promise<PrepaidAlerts> {
  const { data } = await apiClient.get<PrepaidAlerts>(
    "/api/schedules/prepaid/alerts",
    { params: { period_end: periodEnd, expiring_within_days: expiringWithinDays } },
  )
  return data
}

// ── Import existing prepaids from QBO (onboarding helper) ──────────────

/** Proposed/created item shape returned by the import-from-qbo endpoint.
 * Mirrors the SchedulePrepaid create body so the dialog can display
 * each row before the user confirms. `qbo_txn_id` is informational. */
export interface PrepaidImportProposed {
  qbo_account_id:      string
  description:         string
  vendor:              string | null
  reference:           string | null
  invoice_date:        string | null
  total_amount:        string
  start_date:          string
  end_date:            string
  amortization_method: "straight_line" | "daily_rate" | string
  qbo_txn_id?:         string | null
}

export interface PrepaidImportPreview {
  preview:         true
  would_create:    number
  skipped:         number
  lookback_months: number
  items:           PrepaidImportProposed[]
}

export interface PrepaidImportResult {
  preview: false
  created: number
  skipped: number
  items:   PrepaidItem[]
}

async function previewImportPrepaidFromQbo(
  qboAccountId: string,
  lookbackMonths = 12,
): Promise<PrepaidImportPreview> {
  const { data } = await apiClient.post<PrepaidImportPreview>(
    "/api/schedules/prepaid/import-qbo",
    {
      qbo_account_id:  qboAccountId,
      lookback_months: lookbackMonths,
      preview_only:    true,
    },
  )
  return data
}

async function importPrepaidsFromQbo(
  qboAccountId: string,
  lookbackMonths = 12,
): Promise<PrepaidImportResult> {
  const { data } = await apiClient.post<PrepaidImportResult>(
    "/api/schedules/prepaid/import-qbo",
    {
      qbo_account_id:  qboAccountId,
      lookback_months: lookbackMonths,
      preview_only:    false,
    },
  )
  return data
}

// ── Import existing accruals / fixed assets / loans from QBO ───────────
//
// Mirrors the prepaid pattern: each scans GL on the user-selected account
// over a lookback window, dedupes against existing items, and either
// previews (preview_only: true) or creates real schedule rows. Sensible
// per-type defaults; user can edit each row after import.

export interface AccrualImportProposed {
  qbo_account_id: string
  description:    string
  vendor:         string | null
  reference:      string | null
  accrual_date:   string
  amount:         string
  reverses_on:    string | null
  qbo_txn_id?:    string | null
}
export interface AccrualImportPreview {
  preview:         true
  would_create:    number
  skipped:         number
  lookback_months: number
  items:           AccrualImportProposed[]
}
export interface AccrualImportResult { preview: false; created: number; skipped: number; items: unknown[] }

async function previewImportAccrualsFromQbo(qboAccountId: string, lookbackMonths = 12): Promise<AccrualImportPreview> {
  const { data } = await apiClient.post<AccrualImportPreview>(
    "/api/schedules/accrual/import-qbo",
    { qbo_account_id: qboAccountId, lookback_months: lookbackMonths, preview_only: true },
  )
  return data
}
async function importAccrualsFromQbo(qboAccountId: string, lookbackMonths = 12): Promise<AccrualImportResult> {
  const { data } = await apiClient.post<AccrualImportResult>(
    "/api/schedules/accrual/import-qbo",
    { qbo_account_id: qboAccountId, lookback_months: lookbackMonths, preview_only: false },
  )
  return data
}

export interface FixedAssetImportProposed {
  qbo_account_id:      string
  description:         string
  vendor:              string | null
  reference:           string | null
  category:            string | null
  in_service_date:     string
  cost:                string
  salvage_value:       string
  useful_life_months:  number
  depreciation_method: string
  qbo_txn_id?:         string | null
}
export interface FixedAssetImportPreview {
  preview:            true
  would_create:       number
  skipped:            number
  lookback_months:    number
  useful_life_months: number
  items:              FixedAssetImportProposed[]
}
export interface FixedAssetImportResult { preview: false; created: number; skipped: number; items: unknown[] }

async function previewImportFixedAssetsFromQbo(
  qboAccountId: string, lookbackMonths = 24, usefulLifeMonths = 60,
): Promise<FixedAssetImportPreview> {
  const { data } = await apiClient.post<FixedAssetImportPreview>(
    "/api/schedules/fixed-asset/import-qbo",
    { qbo_account_id: qboAccountId, lookback_months: lookbackMonths, useful_life_months: usefulLifeMonths, preview_only: true },
  )
  return data
}
async function importFixedAssetsFromQbo(
  qboAccountId: string, lookbackMonths = 24, usefulLifeMonths = 60,
): Promise<FixedAssetImportResult> {
  const { data } = await apiClient.post<FixedAssetImportResult>(
    "/api/schedules/fixed-asset/import-qbo",
    { qbo_account_id: qboAccountId, lookback_months: lookbackMonths, useful_life_months: usefulLifeMonths, preview_only: false },
  )
  return data
}

export interface LoanImportProposed {
  qbo_account_id:     string
  description:        string
  vendor:             string | null
  reference:          string | null
  loan_date:          string
  original_principal: string
  interest_rate_pct:  string
  term_months:        number
  payment_type:       string
  qbo_txn_id?:        string | null
}
export interface LoanImportPreview {
  preview:         true
  would_create:    number
  skipped:         number
  lookback_months: number
  items:           LoanImportProposed[]
}
export interface LoanImportResult { preview: false; created: number; skipped: number; items: unknown[] }

async function previewImportLoansFromQbo(qboAccountId: string, lookbackMonths = 24): Promise<LoanImportPreview> {
  const { data } = await apiClient.post<LoanImportPreview>(
    "/api/schedules/loan/import-qbo",
    { qbo_account_id: qboAccountId, lookback_months: lookbackMonths, preview_only: true },
  )
  return data
}
async function importLoansFromQbo(qboAccountId: string, lookbackMonths = 24): Promise<LoanImportResult> {
  const { data } = await apiClient.post<LoanImportResult>(
    "/api/schedules/loan/import-qbo",
    { qbo_account_id: qboAccountId, lookback_months: lookbackMonths, preview_only: false },
  )
  return data
}

// ── AI prepaid detection (Phase 2) ────────────────────────────────────────

/** Run the AI scan against the current period's expense-account GL.
 * Synchronous — 5-15s typical. Returns scan stats + the full open list. */
async function scanForPrepaidCandidates(
  periodEnd: string,
  materialityFloor = "500.00",
): Promise<PrepaidScanResult> {
  const { data } = await apiClient.post<PrepaidScanResult>(
    "/api/schedules/prepaid/ai/scan",
    null,
    { params: { period_end: periodEnd, materiality_floor: materialityFloor } },
  )
  return data
}

/** List candidates without re-scanning. Used to hydrate the banner on
 * page load — if results from a prior scan still exist, the user sees
 * them immediately instead of having to click Scan again. */
async function listPrepaidCandidates(status: "open" | "accepted" | "dismissed" | "all" = "open"): Promise<PrepaidCandidatesList> {
  const { data } = await apiClient.get<PrepaidCandidatesList>(
    "/api/schedules/prepaid/ai/candidates",
    { params: { status } },
  )
  return data
}

async function dismissPrepaidCandidate(id: string): Promise<{ id: string; status: string }> {
  const { data } = await apiClient.post<{ id: string; status: string }>(
    `/api/schedules/prepaid/ai/candidates/${id}/dismiss`,
  )
  return data
}

/** Record that the user turned a candidate into a real schedule item.
 * The schedule_item_id links the two so re-scans skip the source txn. */
async function acceptPrepaidCandidate(id: string, scheduleItemId: string | null): Promise<{ id: string; status: string }> {
  const { data } = await apiClient.post<{ id: string; status: string }>(
    `/api/schedules/prepaid/ai/candidates/${id}/accept`,
    { schedule_item_id: scheduleItemId },
  )
  return data
}

// ── Accrual AI (features a + d) ────────────────────────────────────────

async function scanForMissedAccruals(
  periodEnd: string,
  materialityFloor = "500.00",
): Promise<MissedAccrualScanResult> {
  const { data } = await apiClient.post<MissedAccrualScanResult>(
    "/api/schedules/accrual/ai/scan-missed",
    null,
    { params: { period_end: periodEnd, materiality_floor: materialityFloor } },
  )
  return data
}

async function listMissedAccrualCandidates(
  periodEnd: string,
  status: "open" | "accepted" | "dismissed" | "all" = "open",
): Promise<MissedAccrualCandidatesList> {
  const { data } = await apiClient.get<MissedAccrualCandidatesList>(
    "/api/schedules/accrual/ai/missed-candidates",
    { params: { period_end: periodEnd, status } },
  )
  return data
}

async function dismissMissedAccrualCandidate(id: string): Promise<{ id: string; status: string }> {
  const { data } = await apiClient.post<{ id: string; status: string }>(
    `/api/schedules/accrual/ai/missed-candidates/${id}/dismiss`,
  )
  return data
}

async function acceptMissedAccrualCandidate(id: string, scheduleItemId: string | null): Promise<{ id: string; status: string }> {
  const { data } = await apiClient.post<{ id: string; status: string }>(
    `/api/schedules/accrual/ai/missed-candidates/${id}/accept`,
    { schedule_item_id: scheduleItemId },
  )
  return data
}

async function listUnreversedAccruals(periodEnd: string): Promise<UnreversedAccrualsList> {
  const { data } = await apiClient.get<UnreversedAccrualsList>(
    "/api/schedules/accrual/ai/unreversed",
    { params: { period_end: periodEnd } },
  )
  return data
}

// ── AI fixed-asset detection ────────────────────────────────────────────

/** Run the AI capitalization scan against the current period's expense GL.
 * cap_threshold defaults to $1,000 (typical small-business de minimis).
 * Synchronous — 5-15s typical. */
async function scanForFixedAssetCandidates(
  periodEnd: string,
  capThreshold = "1000.00",
): Promise<FixedAssetScanResult> {
  const { data } = await apiClient.post<FixedAssetScanResult>(
    "/api/schedules/fixed_asset/ai/scan",
    null,
    { params: { period_end: periodEnd, cap_threshold: capThreshold } },
  )
  return data
}

async function listFixedAssetCandidates(
  status: "open" | "accepted" | "dismissed" | "all" = "open",
): Promise<FixedAssetCandidatesList> {
  const { data } = await apiClient.get<FixedAssetCandidatesList>(
    "/api/schedules/fixed_asset/ai/candidates",
    { params: { status } },
  )
  return data
}

async function dismissFixedAssetCandidate(id: string): Promise<{ id: string; status: string }> {
  const { data } = await apiClient.post<{ id: string; status: string }>(
    `/api/schedules/fixed_asset/ai/candidates/${id}/dismiss`,
  )
  return data
}

async function acceptFixedAssetCandidate(
  id: string, scheduleItemId: string | null,
): Promise<{ id: string; status: string }> {
  const { data } = await apiClient.post<{ id: string; status: string }>(
    `/api/schedules/fixed_asset/ai/candidates/${id}/accept`,
    { schedule_item_id: scheduleItemId },
  )
  return data
}

/**
 * Backend slugs for /api/exports/schedules/{slug}. The frontend uses the
 * ScheduleType enum (`prepaid`, `accrual`, ...) — this map converts to
 * the matching URL slug.
 */
const EXPORT_SLUG: Record<ScheduleType, "prepaids" | "accruals" | "fixed-assets" | "leases" | "loans"> = {
  prepaid:     "prepaids",
  accrual:     "accruals",
  fixed_asset: "fixed-assets",
  lease:       "leases",
  loan:        "loans",
}

/**
 * Download the per-schedule-type Excel workbook for a period.
 *
 * Server returns a Content-Disposition with the canonical filename;
 * we honour that when present and fall back to a sensible default.
 */
async function downloadScheduleExcel(
  type: ScheduleType,
  periodEnd: string,
): Promise<void> {
  const slug = EXPORT_SLUG[type]
  const res = await apiClient.get<Blob>(
    `/api/exports/schedules/${slug}`,
    {
      params:       { period_end: periodEnd },
      responseType: "blob",
    },
  )

  // Try to honour the server's Content-Disposition filename.
  let filename = `${slug}_${periodEnd}.xlsx`
  const cd = res.headers?.["content-disposition"] as string | undefined
  if (cd) {
    const m = cd.match(/filename="?([^"]+)"?/i)
    if (m && m[1]) filename = m[1]
  }

  const url = URL.createObjectURL(new Blob([res.data]))
  const a   = document.createElement("a")
  a.href     = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export const schedulesApi = {
  listAccounts,
  getOverview,
  listItems,
  createItem,
  updateItem,
  deleteItem,
  previewSnapshot,
  commitSnapshot,
  getPrepaidSuggestions,
  getAccrualSuggestions,
  getFixedAssetSuggestions,
  getLeaseSuggestions,
  getLoanSuggestions,
  getPrepaidAlerts,
  // Onboarding helpers — bulk-import existing items from QBO
  previewImportPrepaidFromQbo,
  importPrepaidsFromQbo,
  previewImportAccrualsFromQbo,
  importAccrualsFromQbo,
  previewImportFixedAssetsFromQbo,
  importFixedAssetsFromQbo,
  previewImportLoansFromQbo,
  importLoansFromQbo,
  // AI prepaid detection
  scanForPrepaidCandidates,
  listPrepaidCandidates,
  dismissPrepaidCandidate,
  acceptPrepaidCandidate,
  // Accrual AI
  scanForMissedAccruals,
  listMissedAccrualCandidates,
  dismissMissedAccrualCandidate,
  acceptMissedAccrualCandidate,
  listUnreversedAccruals,
  // Fixed-asset AI
  scanForFixedAssetCandidates,
  listFixedAssetCandidates,
  dismissFixedAssetCandidate,
  acceptFixedAssetCandidate,
  // Excel export
  downloadScheduleExcel,
}
