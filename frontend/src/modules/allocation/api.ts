/**
 * Nordavix Allocate — typed API client for the §471(c) product.
 *
 * Mirrors backend/modules/cost_allocation/{router,setup_router}.py. All money
 * and percentage values cross the wire as STRINGS: they're Decimal server-side,
 * and routing them through a JS number would silently round a workpaper figure.
 * Format at the edge, never parse into float for arithmetic.
 */
import { apiClient } from "@/core/api/client"

// ── Types ─────────────────────────────────────────────────────────────────────

export type Treatment = "direct" | "allocated" | "excluded"
export type Driver = "payroll" | "occupancy" | "blended" | "fixed"

export interface Pool {
  id: string
  name: string
  treatment: Treatment
  driver: Driver | null
  blend_payroll_wt: string | null
  blend_occupancy_wt: string | null
  fixed_pct: string | null
  sort_order: number
  active: boolean
  notes: string | null
}

export interface AccountRow {
  qbo_account_id: string
  account_number: string | null
  account_name: string | null
  account_type: string
  period_amount: string
  pool_id: string | null
  pool_name: string | null
  /** Template suggestion — present only while the account is unmapped. */
  suggested_pool: string | null
  confidence: "high" | "medium" | "low" | null
  reason: string | null
}

export interface AccountsResponse {
  accounts: AccountRow[]
  unmapped_count: number
  pools: Pool[]
}

export interface Space {
  id: string
  name: string
  function: string
  square_feet: string
  production_pct: string | null
  /** What the engine will actually apply — derived from function unless overridden. */
  effective_production_pct: string
  effective_from: string
  effective_to: string | null
  notes: string | null
}

export interface Employee {
  id: string
  name: string
  external_id: string | null
  qbo_employee_id: string | null
  /** From the payroll register — the evidence behind the classification. */
  department: string | null
  job_title: string | null
  function: string
  production_pct: string
  default_production_pct: string
  effective_from: string
  effective_to: string | null
  active: boolean
}

export interface AllocSettings {
  method: "books_records" | "afs"
  has_afs: boolean
  inventory_method: string
  inventory_account_id: string | null
  inventory_account_name: string | null
  fiscal_year_end: string | null
  gross_receipts_threshold: string | null
  election_attested_at: string | null
  notes: string | null
}

export interface ReadinessItem {
  code: string
  message: string
  fix: string
}

export interface Readiness {
  ready: boolean
  blockers: ReadinessItem[]
  warnings: ReadinessItem[]
  counts: {
    pools: number
    mapped_accounts: number
    spaces: number
    employees: number
    total_square_feet: string
  }
  requires: { occupancy: boolean; payroll: boolean }
}

export interface RunLine {
  qbo_account_id: string
  account_number: string | null
  account_name: string | null
  pool_name: string
  treatment: Treatment
  driver: Driver | null
  driver_pct: string
  gross_amount: string
  capitalized_amount: string
  disallowed_amount: string
}

export interface AllocRun {
  id: string
  period_start: string
  period_end: string
  status: "draft" | "in_review" | "approved" | "superseded"
  blocked_reason: string | null
  payroll_factor: string | null
  occupancy_factor: string | null
  driver_basis: Record<string, unknown> | null
  total_expenses: string | null
  direct_total: string | null
  allocated_total: string | null
  capitalized_total: string | null
  disallowed_total: string | null
  beginning_inventory: string | null
  additions_purchases: string | null
  ending_inventory: string | null
  cogs: string | null
  eligible: boolean | null
  has_afs: boolean | null
  prepared_at: string | null
  approved_at: string | null
  has_journal_entry: boolean
  created_at: string | null
  lines?: RunLine[]
}

const BASE = "/api/allocation"

// ── Settings ──────────────────────────────────────────────────────────────────

async function getSettings(): Promise<AllocSettings> {
  const { data } = await apiClient.get<AllocSettings>(`${BASE}/settings`)
  return data
}

async function updateSettings(body: Partial<AllocSettings>): Promise<AllocSettings> {
  const { data } = await apiClient.put<AllocSettings>(`${BASE}/settings`, body)
  return data
}

// ── Pools ─────────────────────────────────────────────────────────────────────

async function listPools(): Promise<Pool[]> {
  const { data } = await apiClient.get<Pool[]>(`${BASE}/pools`)
  return data
}

export interface PoolInput {
  name: string
  treatment: Treatment
  driver: Driver | null
  blend_payroll_wt?: number | null
  blend_occupancy_wt?: number | null
  fixed_pct?: number | null
  sort_order?: number
  notes?: string | null
}

async function createPool(body: PoolInput): Promise<Pool> {
  const { data } = await apiClient.post<Pool>(`${BASE}/pools`, body)
  return data
}

async function updatePool(id: string, body: PoolInput): Promise<Pool> {
  const { data } = await apiClient.put<Pool>(`${BASE}/pools/${id}`, body)
  return data
}

async function deactivatePool(id: string): Promise<void> {
  await apiClient.delete(`${BASE}/pools/${id}`)
}

/** Seed the cannabis template's pools. Idempotent — never duplicates. */
async function seedDefaultPools(): Promise<Pool[]> {
  const { data } = await apiClient.post<Pool[]>(`${BASE}/pools/seed-defaults`)
  return data
}

// ── Account map ───────────────────────────────────────────────────────────────

async function listAccounts(periodStart: string, periodEnd: string): Promise<AccountsResponse> {
  const { data } = await apiClient.get<AccountsResponse>(`${BASE}/accounts`, {
    params: { period_start: periodStart, period_end: periodEnd },
  })
  return data
}

async function mapAccount(
  qboAccountId: string,
  body: {
    pool_id: string
    account_number?: string | null
    account_name?: string | null
    /** Only honoured when re-pooling; a first mapping is backdated server-side. */
    effective_from?: string
  },
): Promise<{ qbo_account_id: string; pool_id: string; pool_name: string }> {
  const { data } = await apiClient.put(`${BASE}/accounts/${qboAccountId}`, body)
  return data
}

// ── Spaces ────────────────────────────────────────────────────────────────────

export interface SpaceInput {
  name: string
  function: string
  square_feet: number
  production_pct?: number | null
  notes?: string | null
}

async function listSpaces(): Promise<Space[]> {
  const { data } = await apiClient.get<Space[]>(`${BASE}/spaces`)
  return data
}
async function createSpace(body: SpaceInput): Promise<Space> {
  const { data } = await apiClient.post<Space>(`${BASE}/spaces`, body)
  return data
}
async function updateSpace(id: string, body: SpaceInput): Promise<Space> {
  const { data } = await apiClient.put<Space>(`${BASE}/spaces/${id}`, body)
  return data
}
async function retireSpace(id: string): Promise<void> {
  await apiClient.delete(`${BASE}/spaces/${id}`)
}

// ── Employees ─────────────────────────────────────────────────────────────────

export interface EmployeeInput {
  name: string
  function: string
  production_pct: number
  external_id?: string | null
  department?: string | null
  job_title?: string | null
}

async function listEmployees(): Promise<Employee[]> {
  const { data } = await apiClient.get<Employee[]>(`${BASE}/employees`)
  return data
}
async function createEmployee(body: EmployeeInput): Promise<Employee> {
  const { data } = await apiClient.post<Employee>(`${BASE}/employees`, body)
  return data
}
async function updateEmployee(id: string, body: EmployeeInput): Promise<Employee> {
  const { data } = await apiClient.put<Employee>(`${BASE}/employees/${id}`, body)
  return data
}
async function retireEmployee(id: string): Promise<void> {
  await apiClient.delete(`${BASE}/employees/${id}`)
}

// ── Readiness + runs ──────────────────────────────────────────────────────────

async function getReadiness(periodEnd: string): Promise<Readiness> {
  const { data } = await apiClient.get<Readiness>(`${BASE}/readiness`, {
    params: { period_end: periodEnd },
  })
  return data
}

async function listRuns(): Promise<AllocRun[]> {
  const { data } = await apiClient.get<AllocRun[]>(`${BASE}/runs`)
  return data
}

async function getRun(id: string): Promise<AllocRun> {
  const { data } = await apiClient.get<AllocRun>(`${BASE}/runs/${id}`)
  return data
}

async function createRun(body: {
  period_start: string
  period_end: string
  beginning_inventory?: number | null
  ending_inventory?: number | null
  purchases?: number | null
}): Promise<AllocRun> {
  // A QBO pull plus the allocation; well inside a minute, but not instant.
  const { data } = await apiClient.post<AllocRun>(`${BASE}/runs`, body, { timeout: 120_000 })
  return data
}

async function approveRun(id: string): Promise<AllocRun> {
  const { data } = await apiClient.post<AllocRun>(`${BASE}/runs/${id}/approve`)
  return data
}

// ── Payroll register ──────────────────────────────────────────────────────────

export interface PayrollPreviewRow {
  name: string | null
  external_id: string | null
  /** The client's own labels, straight from the register. */
  department: string | null
  job_title: string | null
  gross_wages: string
  employer_taxes: string
  benefits: string
  /** How many times this person appeared in the file (pay runs, earnings codes). */
  pay_runs: number
  /** Function inferred from the department/title, with the reason. */
  suggested_function: string
  suggested_production_pct: number
  suggestion_reason: string
  /** Null when the row didn't match a classified employee. */
  matched_employee_id: string | null
  matched_name: string | null
  matched_function: string | null
}

export interface PayrollPreview {
  headers: string[]
  mapping: Record<string, string | null>
  rows: PayrollPreviewRow[]
  matched_count: number
  unmatched_count: number
}

/** Parse a register and show what WOULD import. Writes nothing. */
async function previewPayroll(file: File): Promise<PayrollPreview> {
  const form = new FormData()
  form.append("file", file)
  const { data } = await apiClient.post<PayrollPreview>(`${BASE}/payroll/preview`, form, {
    headers: { "Content-Type": "multipart/form-data" },
    timeout: 60_000,
  })
  return data
}

async function importPayroll(body: {
  period_start: string
  period_end: string
  create_missing: boolean
  rows: {
    external_id: string | null
    name: string | null
    gross_wages: number
    employer_taxes: number
    benefits: number
    department: string | null
    job_title: string | null
    /** Applied only when creating a new employee. */
    function: string | null
    production_pct: number | null
  }[]
}): Promise<{ imported: number; unmatched: string[]; created: string[]; period_end: string }> {
  const { data } = await apiClient.post(`${BASE}/payroll/import`, body, { timeout: 60_000 })
  return data
}

// ── Journal entry + exports ───────────────────────────────────────────────────

export interface JeLine {
  account_name: string
  account_qbo_id?: string | null
  debit: string
  credit: string
}

export interface JournalEntry {
  available: boolean
  reason: string | null
  entry_id?: string
  status?: string
  description?: string
  memo?: string | null
  rationale?: string | null
  period_end?: string
  lines: JeLine[]
  total_debits: string
  total_credits: string
  balanced: boolean
}

async function getJournalEntry(runId: string): Promise<JournalEntry> {
  const { data } = await apiClient.get<JournalEntry>(`${BASE}/runs/${runId}/journal-entry`)
  return data
}

/** Download a CSV the server generated. Honors the server's filename. */
async function downloadCsv(path: string, fallbackName: string): Promise<void> {
  const resp = await apiClient.get(path, { responseType: "blob", timeout: 60_000 })
  const cd = (resp.headers as Record<string, string>)["content-disposition"] ?? ""
  const name = cd.match(/filename="([^"]+)"/)?.[1] ?? fallbackName
  const url = URL.createObjectURL(new Blob([resp.data], { type: "text/csv;charset=utf-8" }))
  const a = document.createElement("a")
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/** QuickBooks Online "Import journal entries" CSV for the run's reclass entry. */
async function downloadJournalEntryCsv(runId: string, periodEnd: string): Promise<void> {
  await downloadCsv(`${BASE}/runs/${runId}/journal-entry.csv`, `471c-journal-entry-${periodEnd}.csv`)
}

/** The per-account allocation detail — the workpaper body. */
async function downloadWorkpaperCsv(runId: string, periodEnd: string): Promise<void> {
  await downloadCsv(`${BASE}/runs/${runId}/workpaper.csv`, `471c-workpaper-${periodEnd}.csv`)
}

export interface QboAccount {
  qbo_account_id: string
  account_number: string | null
  account_name: string
  account_type: string
}

async function listInventoryAccounts(): Promise<QboAccount[]> {
  const { data } = await apiClient.get<QboAccount[]>(`${BASE}/inventory-accounts`)
  return data
}

export const allocationApi = {
  previewPayroll, importPayroll,
  getJournalEntry, downloadJournalEntryCsv, downloadWorkpaperCsv, listInventoryAccounts,
  getSettings, updateSettings,
  listPools, createPool, updatePool, deactivatePool, seedDefaultPools,
  listAccounts, mapAccount,
  listSpaces, createSpace, updateSpace, retireSpace,
  listEmployees, createEmployee, updateEmployee, retireEmployee,
  getReadiness, listRuns, getRun, createRun, approveRun,
}

// ── Display helpers ───────────────────────────────────────────────────────────

/** Decimal string → accounting display. Never used for arithmetic. */
export function money(v: string | null | undefined): string {
  if (v == null || v === "") return "—"
  const n = Number(v)
  if (!Number.isFinite(n)) return v
  const s = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return n < 0 ? `(${s})` : s
}

/** Engine factor (fraction 0–1) → percentage display. */
export function factorPct(v: string | null | undefined, dp = 2): string {
  if (v == null || v === "") return "—"
  const n = Number(v)
  if (!Number.isFinite(n)) return v
  return `${(n * 100).toFixed(dp)}%`
}
