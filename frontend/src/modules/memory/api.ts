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

export const memoryApi = { listFacts, confirmFact, dismissFact, getEvidence }
