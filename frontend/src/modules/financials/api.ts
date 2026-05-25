import { apiClient } from "@/core/api/client"

export type StatementKind = "income_statement" | "balance_sheet" | "cash_flow"

export interface StatementRow {
  label:        string
  current:      string | null
  prior:        string | null
  level:        number
  is_total:     boolean
  is_subtotal:  boolean
  is_header:    boolean
}

export interface StatementSection {
  name:  string
  rows:  StatementRow[]
  total: StatementRow | null
}

export interface Statement {
  statement:        StatementKind
  title:            string
  period_label:     string
  comparative_label:string | null
  period_end:       string
  comparative_end:  string | null
  company:          string
  sections:         StatementSection[]
  footer:           StatementRow | null
  is_closed:        boolean
  closed_at:        string | null
}

async function getIncomeStatement(periodEnd: string, comparative = true): Promise<Statement> {
  const { data } = await apiClient.get<Statement>("/api/financials/income-statement", {
    params: { period_end: periodEnd, comparative },
  })
  return data
}

async function getBalanceSheet(periodEnd: string, comparative = true): Promise<Statement> {
  const { data } = await apiClient.get<Statement>("/api/financials/balance-sheet", {
    params: { period_end: periodEnd, comparative },
  })
  return data
}

async function getCashFlow(periodEnd: string, comparative = true): Promise<Statement> {
  const { data } = await apiClient.get<Statement>("/api/financials/cash-flow", {
    params: { period_end: periodEnd, comparative },
  })
  return data
}

async function exportPdf(statement: "is" | "bs" | "cf" | "full", periodEnd: string, comparative = true): Promise<void> {
  const resp = await apiClient.get("/api/financials/pdf", {
    params: { statement, period_end: periodEnd, comparative },
    responseType: "blob",
  })
  const url  = URL.createObjectURL(new Blob([resp.data]))
  const a    = document.createElement("a")
  a.href     = url
  a.download = `financial-package-${periodEnd}.pdf`
  document.body.appendChild(a); a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export const financialsApi = {
  getIncomeStatement,
  getBalanceSheet,
  getCashFlow,
  exportPdf,
}
