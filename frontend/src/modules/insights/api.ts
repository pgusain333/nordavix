import { apiClient } from "@/core/api/client"

// ── Types ────────────────────────────────────────────────────────────────────

export type RiskLevel = "green" | "amber" | "red" | "neutral"

export interface KpiRow {
  kpi:     string
  value:   string
  risk:    RiskLevel
  insight: string
}

export interface HistoryPoint {
  period: string  // ISO date
  label:  string  // short label like "Apr"
  cash?:  number
  ocf?:   number
  revenue?: number
  gp?:    number
  ni?:    number
}

export interface AgingBucket {
  bucket: string  // "Current" | "1–30" | "31–60" | "61–90" | "Over 90"
  amount: number
  pct:    number
}

export interface EntityRow {
  name:    string
  current: number
  "1_30":  number
  "31_60": number
  "61_90": number
  over_90: number
  total:   number
}

/** Decision-grade advisory for a section — deterministic, tied to the numbers. */
export interface Advisory {
  implications: string
  actions:      string[]
  watch:        string[]
  risks:        string[]
}

export interface ManagementSummary {
  headline:    string
  health:      "strong" | "watch" | "at_risk"
  score:       number          // 0–100
  priorities:  string[]
  strengths:   string[]
  watch_items: string[]
}

export interface Liquidity {
  cash_balance:          number
  cash_balance_prior:    number
  cash_change_str:       string | null
  operating_burn:        number          // operating cash burn / mo (positive = burning)
  net_cash_movement:     number          // avg monthly change in bank balance (incl. financing)
  monthly_burn:          number          // back-compat alias of operating_burn
  runway_months:         number | null
  operating_cash_flow:   number          // indirect-method OCF
  current_ratio:         number | null
  quick_ratio:           number | null
  working_capital:       number
  working_capital_prior: number
  cash_conversion_cycle: number | null   // DSO + DIO − DPO (days)
  dio_days:              number | null
  history:               HistoryPoint[]
  kpis:                  KpiRow[]
  advisory?:             Advisory
}

export interface Profitability {
  revenue:                  number
  revenue_prior:            number
  revenue_change_str:       string | null
  cogs:                     number
  direct_expenses_extra:    number   // Expense-type accounts classified as direct
  direct_expenses_total:    number   // COGS + direct-in-OpEx
  direct_expense_accounts:  { name: string; amount: number }[]
  gross_profit:             number
  gross_margin_pct:         number | null
  gross_margin_pct_prior:   number | null
  operating_expenses:       number   // indirect OpEx only (after pulling out direct)
  operating_income:         number
  operating_margin_pct:     number | null
  other_income:             number
  other_expense:            number
  net_other:                number
  net_income:               number
  net_margin_pct:           number | null
  history:                  HistoryPoint[]
  kpis:                     KpiRow[]
  advisory?:                Advisory
}

export interface CashForecast {
  horizon_months:     number
  out_of_cash_date:   string | null
  projected_cash_3mo: number
  projected_cash_6mo: number
  runway_minus_10:    number | null   // runway if burn cut 10%
  runway_plus_10:     number | null   // runway if burn rises 10%
  points:             { month: string; projected_cash: number }[]
  kpis:               KpiRow[]
  advisory?:          Advisory
}

export interface BalanceSheet {
  total_assets:          number
  total_liabilities:     number
  equity:                number   // net worth = assets − liabilities
  long_term_liabilities: number
  debt_to_equity:        number | null
  debt_to_assets:        number | null   // ratio (0–1)
  equity_history:        { period: string; label: string; equity: number }[]
  kpis:                  KpiRow[]
  advisory?:             Advisory
}

export interface Growth {
  revenue_growth_mom:  number | null
  trend_3mo_growth:    number | null
  annualized_run_rate: number
  expense_growth_mom:  number | null
  operating_leverage:  number | null   // rev growth − expense growth (pts)
  history:             HistoryPoint[]
  kpis:                KpiRow[]
  advisory?:           Advisory
}

export interface Breakeven {
  break_even_revenue:      number | null
  margin_of_safety_pct:    number | null
  contribution_margin_pct: number | null
  fixed_costs:             number
  current_revenue:         number
  kpis:                    KpiRow[]
  advisory?:               Advisory
}

export interface Receivables {
  ar_balance:        number
  dso_days:          number | null
  aging:             AgingBucket[]
  aging_over_60_pct: number | null
  top_customers:     EntityRow[]
  qbo_error:         string | null
  kpis:              KpiRow[]
  advisory?:         Advisory
}

export interface Payables {
  ap_balance:        number
  dpo_days:          number | null
  aging:             AgingBucket[]
  aging_over_60_pct: number | null
  top_vendors:       EntityRow[]
  payment_lag_days:  number | null
  qbo_error:         string | null
  kpis:              KpiRow[]
  advisory?:         Advisory
}

export interface ExpenseRow {
  category:     string
  amount:       number
  prior_amount: number
  change_pct:   number | null
}

export interface Expenses {
  total_expenses:    number
  top_categories:    ExpenseRow[]
  top_movers:        ExpenseRow[]
  biggest_mom_mover: { category: string; from: number; to: number; change_pct: number } | null
  kpis:              KpiRow[]
  advisory?:         Advisory
}

export interface Recommendation {
  priority: "high" | "medium" | "low"
  title:    string
  detail:   string
}

export interface InsightsOverview {
  period_end:       string
  period_start:     string | null
  period_label:     string
  custom_range:     boolean
  custom_pl_error:  string | null
  qbo_connected:    boolean
  liquidity:        Liquidity
  cash_forecast:    CashForecast
  balance_sheet:    BalanceSheet
  growth:           Growth
  breakeven:        Breakeven
  profitability:    Profitability
  receivables:      Receivables
  payables:         Payables
  expenses:         Expenses
  recommendations:  Recommendation[]
  management_summary?: ManagementSummary
}

// ── API ──────────────────────────────────────────────────────────────────────

async function getOverview(periodEnd: string, periodStart?: string | null): Promise<InsightsOverview> {
  const params: Record<string, string> = { period_end: periodEnd }
  if (periodStart) params.period_start = periodStart
  const { data } = await apiClient.get<InsightsOverview>(
    "/api/insights/overview", { params },
  )
  return data
}

export const insightsApi = { getOverview }
