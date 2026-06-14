/** Client Memory — the conventions the AI has learned for this workspace. */
import { apiClient } from "@/core/api/client"

export type MemoryStatus = "suggested" | "active" | "dismissed" | "stale"

export interface MemoryFact {
  id: string
  kind: string
  fact_key: string
  title: string
  value: Record<string, unknown>
  confidence: number
  status: MemoryStatus
  provenance: { seen?: number; signal_ids?: string[] }
  confirmed_at: string | null
  last_seen_at: string | null
  created_at: string | null
}

export interface MemoryEvidenceSignal {
  id: string
  signal_type: string
  period_end: string
  before: Record<string, unknown>
  after: Record<string, unknown>
  created_at: string | null
}

/** A read-only "what Nordavix knows about this account" note, surfaced wherever
 *  the account appears (flux variance / recon detail). Context only — never
 *  changes a computed figure. */
export interface MemoryContextItem {
  kind:    string
  module:  string
  text:    string
  fact_id: string
}

async function getAccountContext(
  qboAccountId?: string | null, accountNumber?: string | null,
): Promise<{ notes: MemoryContextItem[] }> {
  const { data } = await apiClient.get<{ notes: MemoryContextItem[] }>(
    "/api/memory/account-context",
    { params: { qbo_account_id: qboAccountId || undefined, account_number: accountNumber || undefined } },
  )
  return data
}

async function listFacts(status?: MemoryStatus): Promise<{ items: MemoryFact[]; suggested_count: number }> {
  const { data } = await apiClient.get<{ items: MemoryFact[]; suggested_count: number }>(
    "/api/memory/facts", { params: status ? { status } : undefined },
  )
  return data
}

async function confirmFact(id: string): Promise<MemoryFact> {
  const { data } = await apiClient.post<MemoryFact>(`/api/memory/facts/${id}/confirm`)
  return data
}

async function dismissFact(id: string): Promise<MemoryFact> {
  const { data } = await apiClient.post<MemoryFact>(`/api/memory/facts/${id}/dismiss`)
  return data
}

async function getEvidence(id: string): Promise<{ fact: MemoryFact; signals: MemoryEvidenceSignal[] }> {
  const { data } = await apiClient.get<{ fact: MemoryFact; signals: MemoryEvidenceSignal[] }>(
    `/api/memory/facts/${id}/evidence`,
  )
  return data
}

/** The confirmed vendor setup to pre-fill a new schedule item, if any.
 *  Returns { default: null } when there's no active learned default. */
export interface ScheduleDefault {
  vendor?: string
  schedule_type?: string
  // shared
  offset_qbo_account_id?: string | null
  offset_account_name?: string | null
  qbo_account_id?: string | null
  term_months?: number
  // prepaid
  amortization_method?: "daily_rate" | "straight_line"
  // fixed_asset
  category?: string | null
  useful_life_months?: number
  depreciation_method?: string | null
  accumulated_dep_qbo_account_id?: string | null
  // lease
  discount_rate_pct?: string | null
  rou_qbo_account_id?: string | null
  // loan
  interest_rate_pct?: string | null
  payment_type?: string | null
}
async function scheduleDefault(
  scheduleType: string, vendor: string,
): Promise<{ default: ScheduleDefault | null; fact_id: string | null }> {
  const { data } = await apiClient.get<{ default: ScheduleDefault | null; fact_id: string | null }>(
    "/api/memory/schedule-default", { params: { schedule_type: scheduleType, vendor } },
  )
  return data
}

export const memoryApi = { listFacts, confirmFact, dismissFact, getEvidence, scheduleDefault, getAccountContext }
