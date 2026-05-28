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
  FixedAssetItem,
  LeaseItem,
  LoanItem,
  Overview,
  PrepaidItem,
  ScheduleType,
  Snapshot,
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

async function listAccounts(): Promise<ScheduleAccount[]> {
  const { data } = await apiClient.get<{ accounts: ScheduleAccount[] }>(
    "/api/schedules/accounts",
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
}
