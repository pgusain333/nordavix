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

export interface Liquidity {
  cash_balance:        number
  cash_balance_prior:  number
  cash_change_str:     string | null
  monthly_burn:        number
  runway_months:       number | null
  operating_cash_flow: number
  history:             HistoryPoint[]
  kpis:                KpiRow[]
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
}

export interface Receivables {
  ar_balance:        number
  dso_days:          number | null
  aging:             AgingBucket[]
  aging_over_60_pct: number | null
  top_customers:     EntityRow[]
  qbo_error:         string | null
  kpis:              KpiRow[]
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
  profitability:    Profitability
  receivables:      Receivables
  payables:         Payables
  expenses:         Expenses
  recommendations:  Recommendation[]
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
