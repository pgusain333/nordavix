/** GL Accuracy — the misclassification watchdog (Client Brain). */
import { apiClient } from "@/core/api/client"

export type GlConfidence = "high" | "medium"
export type GlSeverity = "high" | "medium" | "low"
export type GlActionKind = "reclass" | "accrual" | "flag"
export type GlFindingStatus = "open" | "in_adjustments" | "dismissed" | "acknowledged"

export interface GlFinding {
  id:                       string
  finding_key:              string   // stable graph-node id for this finding
  period_end:               string
  // ── Risk Radar envelope (every finding) ──
  kind:                     string          // "misclassification" | future detectors
  severity:                 GlSeverity | string
  action_kind:              GlActionKind | string  // reclass | accrual | flag
  title:                    string
  detail:                   string | null
  evidence:                 Record<string, unknown> | null
  vendor:                   string
  qbo_txn_id:               string | null
  txn_type:                 string | null
  txn_number:               string | null
  txn_date:                 string | null
  amount:                   string   // signed (debit-positive)
  memo:                     string | null
  posted_account_id:        string | null
  posted_account_name:      string | null
  suggested_account_id:     string | null
  suggested_account_name:   string | null
  dominant_count:           number
  total_count:              number
  posted_count:             number
  confidence:               GlConfidence | string
  status:                   GlFindingStatus | string
  linked_proposed_entry_id: string | null
}

export interface GlFindingsResponse {
  items:      GlFinding[]
  open_count: number
  high:       number
  medium:     number
  dollars:    string
}

export interface GlScanSummary {
  period_end: string
  scanned:    number
  accounts:   number
  findings:   number
  high:       number
  medium:     number
  dollars:    string
}

async function scan(periodEnd: string): Promise<GlScanSummary> {
  const { data } = await apiClient.post<GlScanSummary>(
    "/api/gl-accuracy/scan", null, { params: { period_end: periodEnd }, timeout: 5 * 60_000 },
  )
  return data
}

async function getFindings(periodEnd: string): Promise<GlFindingsResponse> {
  const { data } = await apiClient.get<GlFindingsResponse>(
    "/api/gl-accuracy/findings", { params: { period_end: periodEnd } },
  )
  return data
}

async function accept(id: string): Promise<GlFinding> {
  const { data } = await apiClient.post<GlFinding>(`/api/gl-accuracy/findings/${id}/accept`)
  return data
}

async function bulkAccept(ids: string[]): Promise<{ accepted: number }> {
  const { data } = await apiClient.post<{ accepted: number }>(
    "/api/gl-accuracy/findings/bulk-accept", { ids },
  )
  return data
}

async function dismiss(id: string): Promise<GlFinding> {
  const { data } = await apiClient.post<GlFinding>(`/api/gl-accuracy/findings/${id}/dismiss`)
  return data
}

async function acknowledge(id: string): Promise<GlFinding> {
  const { data } = await apiClient.post<GlFinding>(`/api/gl-accuracy/findings/${id}/acknowledge`)
  return data
}

export const glAccuracyApi = { scan, getFindings, accept, bulkAccept, dismiss, acknowledge }
