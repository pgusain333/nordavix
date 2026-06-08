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
  // Statement-integrity check (Phase 2 trust sweep). Null on the live-QBO
  // source. When balanced is false, the UI shows a do-not-distribute banner
  // and exported PDFs are watermarked DRAFT.
  validation?: {
    balanced:           boolean
    bs_diff:            string
    cf_plug:            string
    unclassified_types: string[]
    messages:           string[]
  } | null
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

// ── Excel exports ─────────────────────────────────────────────────────────────

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

/** Shared blob → file download with the same error-reading pattern as exportPdf. */
async function downloadXlsx(
  path: string,
  params: Record<string, string | boolean>,
  fallbackName: string,
): Promise<void> {
  try {
    const resp = await apiClient.get(path, { params, responseType: "blob", timeout: 5 * 60_000 })
    if (!resp.data || (resp.data as Blob).size === 0) {
      throw new Error("Server returned an empty file. Try again.")
    }
    const url = URL.createObjectURL(new Blob([resp.data], { type: XLSX_MIME }))
    const a   = document.createElement("a")
    a.href    = url
    const cd  = resp.headers["content-disposition"] as string | undefined
    const m   = cd?.match(/filename="?([^";]+)/)
    a.download = m?.[1] ?? fallbackName
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(url)
  } catch (e: unknown) {
    const err = e as { response?: { data?: Blob; status?: number }; message?: string; code?: string }
    if (err.code === "ECONNABORTED") throw new Error("Export timed out — please try again.")
    if (err.response?.data instanceof Blob) {
      try {
        const txt = await err.response.data.text()
        const parsed = JSON.parse(txt) as { detail?: string }
        throw new Error(parsed.detail ?? `HTTP ${err.response.status}`)
      } catch (pe) {
        if (pe instanceof Error && pe.message.startsWith("HTTP")) throw pe
        throw new Error(err.message ?? "Export failed")
      }
    }
    throw new Error(err.message ?? "Export failed — check your network and try again.")
  }
}

/** Full financial-package workbook (statements + every schedule). */
async function exportFinancialsExcel(
  periodEnd: string, periodStart: string | undefined,
  comparative: boolean, source: FinancialSource,
): Promise<void> {
  const params: Record<string, string | boolean> = { period_end: periodEnd, comparative, source }
  if (periodStart) params.period_start = periodStart
  await downloadXlsx("/api/exports/financials", params, `financial-package-${periodEnd}.xlsx`)
}

/** A single financial schedule (cover + one sheet). */
async function exportScheduleExcel(
  slug: string, periodEnd: string, periodStart: string | undefined,
  comparative: boolean, source: FinancialSource,
): Promise<void> {
  const params: Record<string, string | boolean> = { period_end: periodEnd, comparative, source }
  if (periodStart) params.period_start = periodStart
  await downloadXlsx(`/api/exports/financials/${slug}`, params, `${slug}-${periodEnd}.xlsx`)
}

// ── Schedule catalog (presentational — drives the "Schedules & exports" card) ──

export interface ScheduleDef {
  slug:        string
  label:       string
  description: string
  group:       "Statements" | "Subledgers & agings" | "Account schedules" | "Support"
}

export const FINANCIAL_SCHEDULES: ScheduleDef[] = [
  { slug: "income-statement",       label: "Income Statement",        description: "Revenue, COGS, gross profit, OpEx, net income.", group: "Statements" },
  { slug: "balance-sheet",          label: "Balance Sheet",           description: "Assets, liabilities, and equity, point-in-time.", group: "Statements" },
  { slug: "cash-flow",              label: "Statement of Cash Flows", description: "Indirect method — operating, investing, financing.", group: "Statements" },
  { slug: "ar-aging",               label: "Accounts Receivable Aging", description: "Customer balances by aging bucket.", group: "Subledgers & agings" },
  { slug: "ap-aging",               label: "Accounts Payable Aging",  description: "Vendor balances by aging bucket.", group: "Subledgers & agings" },
  { slug: "prepaids",               label: "Prepaid Expense Schedule", description: "Amortization + unamortized carrying value.", group: "Account schedules" },
  { slug: "fixed-assets",           label: "Fixed Assets & Depreciation", description: "Cost, accumulated depreciation, net book value.", group: "Account schedules" },
  { slug: "accruals",               label: "Accrued Expense Schedule", description: "Accruals and reversals by period.", group: "Account schedules" },
  { slug: "leases",                 label: "Lease Schedule",          description: "ROU asset and lease liability detail.", group: "Account schedules" },
  { slug: "loans",                  label: "Loan Schedule",           description: "Principal, rate, term, and payment type.", group: "Account schedules" },
  { slug: "trial-balance",          label: "Trial Balance",           description: "Every GL account, debit/credit, balanced.", group: "Support" },
  { slug: "cash",                   label: "Cash & Cash Equivalents", description: "Bank account balances detail.", group: "Support" },
  { slug: "equity",                 label: "Equity Roll-forward",     description: "Beginning equity + net income +/- owner activity.", group: "Support" },
  { slug: "reconciliation-summary", label: "Reconciliation Summary",  description: "GL vs subledger, variance, and status per account.", group: "Support" },
]

export const SCHEDULE_GROUPS: ScheduleDef["group"][] = [
  "Statements", "Subledgers & agings", "Account schedules", "Support",
]

export const financialsApi = {
  getIncomeStatement,
  getBalanceSheet,
  getCashFlow,
  exportPdf,
  exportExecutiveReport,
  exportFinancialsExcel,
  exportScheduleExcel,
}
