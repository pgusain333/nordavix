/** PBC (client document requests) — authed API. */
import { apiClient } from "@/core/api/client"

export interface EvidenceRequestFile {
  file_name: string
  file_size: number
  uploaded_at: string
  evidence_id: string
}

export interface EvidenceRequestRow {
  id: string
  qbo_account_id: string
  period_end: string
  title: string
  note: string | null
  account_label: string | null
  recipient_email: string
  recipient_name: string | null
  status: "pending" | "fulfilled" | "cancelled" | "expired"
  expires_at: string
  fulfilled_at: string | null
  files: EvidenceRequestFile[]
  send_count: number
  last_sent_at: string | null
  created_at: string | null
}

export interface CreateRequestBody {
  qbo_account_id: string
  period_end: string
  title: string
  note?: string
  account_label?: string
  recipient_email: string
  recipient_name?: string
}

async function createRequest(body: CreateRequestBody): Promise<EvidenceRequestRow> {
  const { data } = await apiClient.post<EvidenceRequestRow>("/api/pbc", body)
  return data
}

async function listRequests(params: { qbo_account_id?: string; period_end?: string }): Promise<EvidenceRequestRow[]> {
  const { data } = await apiClient.get<{ requests: EvidenceRequestRow[] }>("/api/pbc", { params })
  return data.requests
}

async function remindRequest(id: string): Promise<EvidenceRequestRow> {
  const { data } = await apiClient.post<EvidenceRequestRow>(`/api/pbc/${id}/remind`)
  return data
}

async function cancelRequest(id: string): Promise<EvidenceRequestRow> {
  const { data } = await apiClient.post<EvidenceRequestRow>(`/api/pbc/${id}/cancel`)
  return data
}

export const pbcApi = { createRequest, listRequests, remindRequest, cancelRequest }
