import { apiClient } from "@/core/api/client"

export type StatementKind = "income_statement" | "balance_sheet" | "cash_flow"

// Row kinds map directly to backend FinancialRow.kind. Frontend uses
// them to drive indentation + typography (totals bold, headers
// uppercase navy, etc).
export type RowKind =
  | "section_header"
  | "data"
  | "subtotal"
  | "total"
  | "computed"
  | "grand_total"
  | "spacer"

export interface FinancialRow {
  label:   string
  current: string | null
  prior:   string | null
  level:   number
  kind:    RowKind
}

export interface Statement {
  statement:         StatementKind
  title:             string
  subtitle:          string
  company:           string
  period_label:      string
  comparative_label: string | null
  period_end:        string
  comparative_end:   string | null
  rows:              FinancialRow[]
  is_closed:         boolean
  closed_at:         string | null
  notes:             string[]
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

/**
 * Export the chosen statement(s) as a Big-4 styled PDF. When `draft`
 * is true, the backend allows export for unclosed periods and stamps
 * the PDF with a large DRAFT watermark. Throws on HTTP error so the
 * caller can surface a useful message — axios's blob responseType
 * stuffs error bodies in `error.response.data` as a Blob, so we
 * read it back as text before re-raising.
 */
async function exportPdf(
  statement: "is" | "bs" | "cf" | "full",
  periodEnd: string,
  comparative = true,
  draft = false,
): Promise<void> {
  try {
    const resp = await apiClient.get("/api/financials/pdf", {
      params: { statement, period_end: periodEnd, comparative, draft },
      responseType: "blob",
    })
    const url  = URL.createObjectURL(new Blob([resp.data], { type: "application/pdf" }))
    const a    = document.createElement("a")
    a.href     = url
    a.download = `${draft ? "draft-" : ""}financial-package-${periodEnd}.pdf`
    document.body.appendChild(a); a.click()
    a.remove()
    URL.revokeObjectURL(url)
  } catch (e: unknown) {
    // axios + responseType=blob → error body is a Blob. Read it back.
    const err = e as { response?: { data?: Blob; status?: number }; message?: string }
    if (err.response?.data instanceof Blob) {
      try {
        const txt = await err.response.data.text()
        const parsed = JSON.parse(txt) as { detail?: string }
        throw new Error(parsed.detail ?? `HTTP ${err.response.status}`)
      } catch (parseErr) {
        if (parseErr instanceof Error && parseErr.message.startsWith("HTTP")) throw parseErr
        throw new Error(err.message ?? "PDF export failed")
      }
    }
    throw new Error(err.message ?? "PDF export failed")
  }
}

export const financialsApi = {
  getIncomeStatement,
  getBalanceSheet,
  getCashFlow,
  exportPdf,
}
