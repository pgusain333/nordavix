/** Workpapers — supporting-document evidence client (W1 backend). */
import { apiClient } from "@/core/api/client"

export type WpRefType = "account" | "schedule" | "adjustment" | "flux" | "financials" | "general"

export interface WpEvidence {
  id:          string
  period_end:  string
  ref_type:    string
  ref_id:      string | null
  file_name:   string
  file_size:   number
  mime_type:   string
  note:        string | null
  uploaded_by: string
  uploaded_at: string | null
  verification: Record<string, unknown> | null
  /** "workpaper" = attached here; "recon" = merged in from the account's
   *  reconciliation (manual recon upload or PBC client magic-link upload),
   *  shown read-only and managed in Reconciliations. */
  source?: "workpaper" | "recon"
}

export interface WpEvidenceSummary {
  counts: Record<string, number>   // keyed "ref_type:ref_id" ("general:" for general)
  total:  number
}

async function listEvidence(periodEnd: string, refType?: string, refId?: string | null): Promise<WpEvidence[]> {
  const { data } = await apiClient.get<{ items: WpEvidence[] }>("/api/workpapers/evidence", {
    params: { period_end: periodEnd, ref_type: refType, ref_id: refId ?? undefined },
  })
  return data.items
}

async function evidenceSummary(periodEnd: string): Promise<WpEvidenceSummary> {
  const { data } = await apiClient.get<WpEvidenceSummary>("/api/workpapers/evidence/summary", {
    params: { period_end: periodEnd },
  })
  return data
}

async function uploadEvidence(args: {
  periodEnd: string; refType: WpRefType; refId?: string | null; note?: string; file: File
}): Promise<WpEvidence> {
  const form = new FormData()
  form.append("file", args.file)
  const { data } = await apiClient.post<WpEvidence>("/api/workpapers/evidence", form, {
    params: {
      period_end: args.periodEnd, ref_type: args.refType,
      ref_id: args.refId ?? undefined, note: args.note || undefined,
    },
    headers: { "Content-Type": "multipart/form-data" },
    timeout: 60_000,
  })
  return data
}

async function downloadEvidence(id: string): Promise<void> {
  const { data } = await apiClient.get<{ url: string; file_name: string }>(
    `/api/workpapers/evidence/${id}/download`,
  )
  window.open(data.url, "_blank", "noopener,noreferrer")
}

async function deleteEvidence(id: string): Promise<void> {
  await apiClient.delete(`/api/workpapers/evidence/${id}`)
}

export const workpapersApi = {
  listEvidence, evidenceSummary, uploadEvidence, downloadEvidence, deleteEvidence,
}
