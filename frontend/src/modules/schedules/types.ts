/**
 * Schedules module — shared TypeScript types.
 *
 * Mirrors backend/modules/schedules/router.py serialization. One type
 * per schedule kind plus a discriminated `ScheduleType` string used
 * everywhere a generic schedule-typed function needs to dispatch.
 */

export type ScheduleType = "prepaid" | "accrual" | "fixed_asset" | "lease" | "loan"

export const SCHEDULE_TYPES: ScheduleType[] = [
  "prepaid",
  "accrual",
  "fixed_asset",
  "lease",
  "loan",
]

export const SCHEDULE_HUMAN: Record<ScheduleType, string> = {
  prepaid:     "Prepaid Expenses",
  accrual:     "Accrued Expenses",
  fixed_asset: "Fixed Assets",
  lease:       "Leases",
  loan:        "Loans",
}

export const SCHEDULE_BLURB: Record<ScheduleType, string> = {
  prepaid:     "Items paid upfront, amortized straight-line over their service period.",
  accrual:     "Expenses incurred but not yet paid. Reverses when paid.",
  fixed_asset: "Capitalized assets with straight-line depreciation.",
  lease:       "Operating lease commitments. Optional ASC 842 fields for ROU + liability.",
  loan:        "Term loans with amortization. Computes interest + principal each period.",
}

export const SCHEDULE_ROUTE: Record<ScheduleType, string> = {
  prepaid:     "/app/schedules/prepaids",
  accrual:     "/app/schedules/accruals",
  fixed_asset: "/app/schedules/fixed-assets",
  lease:       "/app/schedules/leases",
  loan:        "/app/schedules/loans",
}

// ── Common item fields ─────────────────────────────────────────────────────

interface CommonItem {
  id:             string
  qbo_account_id: string
  description:    string
  vendor:         string | null
  reference:      string | null
  notes:          string | null
  is_active:      boolean
  created_at:     string | null
  updated_at:     string | null
}

// ── Per-type item shapes ───────────────────────────────────────────────────

export interface PrepaidItem extends CommonItem {
  invoice_date: string | null
  total_amount: string
  start_date:   string
  end_date:     string
}

export interface AccrualItem extends CommonItem {
  accrual_date: string
  amount:       string
  reverses_on:  string | null
  is_reversed:  boolean
}

export interface FixedAssetItem extends CommonItem {
  category:                         string | null
  in_service_date:                  string
  cost:                             string
  salvage_value:                    string
  useful_life_months:               number
  depreciation_method:              string
  accumulated_dep_qbo_account_id:   string | null
  disposed_on:                      string | null
  disposal_proceeds:                string | null
}

export interface LeaseItem extends CommonItem {
  lessor:              string | null
  lease_start:         string
  lease_end:           string
  monthly_payment:     string
  discount_rate_pct:   string | null
  initial_rou_asset:   string | null
  initial_liability:   string | null
  rou_qbo_account_id:  string | null
}

export interface LoanItem extends CommonItem {
  lender:              string | null
  loan_date:           string
  original_principal:  string
  interest_rate_pct:   string
  term_months:         number
  monthly_payment:     string | null
  payment_type:        string
}

export type AnyItem =
  | (PrepaidItem & { _kind: "prepaid" })
  | (AccrualItem & { _kind: "accrual" })
  | (FixedAssetItem & { _kind: "fixed_asset" })
  | (LeaseItem & { _kind: "lease" })
  | (LoanItem & { _kind: "loan" })

// ── Snapshot ──────────────────────────────────────────────────────────────

export interface Snapshot {
  schedule_type:     ScheduleType
  qbo_account_id:    string
  period_end:        string
  beginning_balance: string
  additions:         string
  period_expense:    string
  payments:          string
  other:             string
  ending_balance:    string
  item_count:        number
  committed?:        boolean
  committed_at?:     string | null
  pushed_to_recon?:  boolean
}

// ── Overview ──────────────────────────────────────────────────────────────

export interface OverviewType {
  type:                       ScheduleType
  human_name:                 string
  active_count:               number
  total_count:                number
  ending_balance:             string
  period_expense:             string
  any_committed_for_period:   boolean
}

export interface Overview {
  period_end: string
  types:      OverviewType[]
}

// ── Renewal alerts (Phase 1) ───────────────────────────────────────────────

/** One row in the renewal-alerts banner on PrepaidsPage. */
export interface PrepaidAlertItem {
  id:             string
  qbo_account_id: string
  vendor:         string | null
  description:    string
  reference:      string | null
  total_amount:   string
  start_date:     string
  end_date:       string
  /** Negative when past_due; positive for expiring_soon. */
  days_to_end:    number
}

export interface PrepaidAlerts {
  period_end:           string
  expiring_within_days: number
  expiring_soon:        PrepaidAlertItem[]
  past_due:             PrepaidAlertItem[]
  total:                number
}

// ── AI prepaid detection (Phase 2) ────────────────────────────────────────

/** A single AI-detected potential prepaid from a GL transaction.
 * Persisted as a row in prepaid_candidates. */
export interface PrepaidCandidate {
  id:                string
  period_end:        string
  gl_account_id:     string
  gl_account_name:   string
  gl_txn_id:         string | null
  gl_txn_date:       string
  gl_amount:         string
  gl_memo:           string | null
  gl_vendor:         string | null
  ai_vendor:         string | null
  ai_service_start:  string | null
  ai_service_months: number | null
  ai_method:         "straight_line" | "daily_rate" | string
  ai_confidence:     string
  ai_reasoning:      string | null
  ai_target_account_id: string | null
  status:            "open" | "accepted" | "dismissed" | string
  accepted_item_id:  string | null
  created_at:        string | null
}

export interface PrepaidScanResult {
  scanned_accounts: number
  scanned_txns:     number
  new_candidates:   number
  candidates:       PrepaidCandidate[]
}

export interface PrepaidCandidatesList {
  status:     string
  candidates: PrepaidCandidate[]
}
