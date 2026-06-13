/** AI Close Review — the reviewing-partner pass over a closed period. */
import { apiClient } from "@/core/api/client"

export type Severity = "high" | "review" | "info"
export type FindingStatus = "open" | "cleared" | "actioned" | "accepted"
export type FindingAction = "clear" | "action" | "accept" | "reopen"

export interface ReviewFinding {
  id:                 string
  code:               string
  category:           string
  severity:           Severity
  title:              string
  detail:             string
  recommended_action: string | null
  qbo_account_id:     string | null
  account_label:      string | null
  entity_ref:         string | null
  link_hint:          string | null
  status:             FindingStatus
  note:               string | null
  status_changed_at:  string | null
}

export interface ReviewMeta {
  id:            string
  status:        "open" | "signed_off"
  summary:       string | null
  high_count:    number
  review_count:  number
  info_count:    number
  cleared_count: number
  checks_run:    number
  passed:        string[]
  generated_at:  string | null
  signed_off_at: string | null
}

export interface ReviewState {
  period_end:   string
  period_label: string
  review:       ReviewMeta | null
  findings:     ReviewFinding[]   // open exceptions
  resolved:     ReviewFinding[]   // cleared / actioned / accepted
}

async function getState(periodEnd: string): Promise<ReviewState> {
  const { data } = await apiClient.get<ReviewState>("/api/review", { params: { period: periodEnd } })
  return data
}

async function run(periodEnd: string): Promise<ReviewState> {
  const { data } = await apiClient.post<ReviewState>("/api/review/run", null, { params: { period: periodEnd } })
  return data
}

async function act(findingId: string, action: FindingAction, note?: string): Promise<ReviewState> {
  const { data } = await apiClient.post<ReviewState>(`/api/review/finding/${findingId}/action`, { action, note })
  return data
}

async function signOff(periodEnd: string): Promise<ReviewState> {
  const { data } = await apiClient.post<ReviewState>("/api/review/signoff", null, { params: { period: periodEnd } })
  return data
}

export const reviewApi = { getState, run, act, signOff }
