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

export type FinancialSource = "quickbooks" | "nordavix"

async function getIncomeStatement(
  periodEnd: string, comparative = true, source: FinancialSource = "quickbooks",
  periodStart?: string,
): Promise<Statement> {
  const { data } = await apiClient.get<Statement>("/api/financials/income-statement", {
    params: {
      period_end: periodEnd,
      ...(periodStart ? { period_start: periodStart } : {}),
      comparative, source,
    },
  })
  return data
}
async function getBalanceSheet(periodEnd: string, comparative = true, source: FinancialSource = "quickbooks"): Promise<Statement> {
  // Balance Sheet is point-in-time — period_start would be ignored
  // server-side, so we don't accept it here.
  const { data } = await apiClient.get<Statement>("/api/financials/balance-sheet", {
    params: { period_end: periodEnd, comparative, source },
  })
  return data
}
async function getCashFlow(
  periodEnd: string, comparative = true, source: FinancialSource = "quickbooks",
  periodStart?: string,
): Promise<Statement> {
  const { data } = await apiClient.get<Statement>("/api/financials/cash-flow", {
    params: {
      period_end: periodEnd,
      ...(periodStart ? { period_start: periodStart } : {}),
      comparative, source,
    },
  })
  return data
}

/**
 * Export the chosen statement(s) as a audit-ready styled PDF. When `draft`
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
  source: FinancialSource = "quickbooks",
): Promise<void> {
  try {
    const resp = await apiClient.get("/api/financials/pdf", {
      params: { statement, period_end: periodEnd, comparative, draft, source },
      responseType: "blob",
      // PDF generation can take ~10-30s on the "full" package while
      // QBO reports come back. Override axios's per-instance default
      // (none set, so this is just future-proofing) AND cover the
      // edge case where the browser drops a slow XHR.
      timeout: 5 * 60_000,
    })
    if (!resp.data || (resp.data as Blob).size === 0) {
      throw new Error("Server returned an empty PDF. Try again.")
    }
    const url  = URL.createObjectURL(new Blob([resp.data], { type: "application/pdf" }))
    const a    = document.createElement("a")
    a.href     = url
    a.download = `${draft ? "draft-" : ""}financial-package-${periodEnd}.pdf`
    document.body.appendChild(a); a.click()
    a.remove()
    URL.revokeObjectURL(url)
  } catch (e: unknown) {
    // axios + responseType=blob → error body is a Blob. Read it back.
    const err = e as { response?: { data?: Blob; status?: number }; message?: string; code?: string }
    if (err.code === "ECONNABORTED") {
      throw new Error("PDF export timed out. QuickBooks may be slow — please try again.")
    }
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
    throw new Error(err.message ?? "PDF export failed — check your network and try again.")
  }
}

/**
 * Build + download the Executive Financial Report PDF. This is the
 * AI-narrated, multi-page board package — only available when books
 * are closed for the period. Generation takes 10–30 seconds because
 * of live QBO pulls + the Claude call; UI should show a spinner.
 *
 * Error handling mirrors `exportPdf` — axios with blob responseType
 * returns errors as a Blob, so we read the JSON body back manually.
 */
async function exportExecutiveReport(periodEnd: string): Promise<void> {
  try {
    const resp = await apiClient.get("/api/financials/executive-report", {
      params:       { period_end: periodEnd },
      responseType: "blob",
      timeout:      5 * 60_000,   // AI + multi-call backend; generous ceiling.
    })
    if (!resp.data || (resp.data as Blob).size === 0) {
      throw new Error("Server returned an empty PDF. Try again.")
    }
    const url  = URL.createObjectURL(new Blob([resp.data], { type: "application/pdf" }))
    const a    = document.createElement("a")
    a.href     = url
    // Use the server-provided filename when available (preserves the
    // ExecutiveReport_{company}_{month}-{year}.pdf pattern).
    const cd = resp.headers["content-disposition"] as string | undefined
    const match = cd?.match(/filename="?([^";]+)/)
    a.download = match?.[1] ?? `ExecutiveReport-${periodEnd}.pdf`
    document.body.appendChild(a); a.click()
    a.remove()
    URL.revokeObjectURL(url)
  } catch (e: unknown) {
    const err = e as { response?: { data?: Blob; status?: number }; message?: string; code?: string }
    if (err.code === "ECONNABORTED") {
      throw new Error("Executive report timed out. The AI step can be slow — please try again.")
    }
    if (err.response?.data instanceof Blob) {
      try {
        const txt = await err.response.data.text()
        const parsed = JSON.parse(txt) as { detail?: string }
        throw new Error(parsed.detail ?? `HTTP ${err.response.status}`)
      } catch (parseErr) {
        if (parseErr instanceof Error && parseErr.message.startsWith("HTTP")) throw parseErr
        throw new Error(err.message ?? "Executive report failed")
      }
    }
    throw new Error(err.message ?? "Executive report failed — check your network and try again.")
  }
}

export const financialsApi = {
  getIncomeStatement,
  getBalanceSheet,
  getCashFlow,
  exportPdf,
  exportExecutiveReport,
}
