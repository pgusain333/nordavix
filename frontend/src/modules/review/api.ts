/** AI Close Review — the reviewing-partner pass over a closed period. */
import { apiClient } from "@/core/api/client"

export type Severity = "high" | "review" | "info"
export type FindingStatus = "open" | "cleared" | "actioned" | "accepted"
export type FindingAction = "clear" | "action" | "accept" | "reopen"

/** One line of a flagged journal entry — which account it hit, and on which side. */
export interface FindingJeLine {
  account: string
  debit:   string | null
  credit:  string | null
}

/** Structured extras for rich rendering. Present on manual-JE anomalies; the
 *  Dr/Cr `lines` show exactly which accounts the entry touched. */
export interface FindingMeta {
  kind?:     string
  doc?:      string | null
  amount?:   string | null
  txn_date?: string | null
  poster?:   string | null
  memo?:     string | null
  flags?:    string[]
  lines?:    FindingJeLine[]
}

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
  meta:               FindingMeta | null
  status:             FindingStatus
  /** The reason the reviewer gave. Required to set aside a high-severity
   *  exception — it is printed on the sign-off memo. */
  note:               string | null
  status_changed_at:  string | null
  /** WHO decided. The id was always stored and never resolved, so the UI could
   *  say when a finding was cleared but never by whom — the half that makes a
   *  review defensible. */
  status_changed_by_name: string | null
  /** When the exception was FIRST raised, surviving re-runs. */
  first_seen_at:      string | null
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
  /** What THIS run changed: raised for the first time, and gone since the last
   *  run. The only question a reviewer has after the preparer says they've
   *  fixed things. */
  new_count:      number
  resolved_count: number
  generated_at:  string | null
  signed_off_at: string | null
  signed_off_by_name: string | null
  /** The reviewing partner's statement, printed under the signature. */
  signoff_note:  string | null
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

async function signOff(periodEnd: string, note?: string): Promise<ReviewState> {
  const { data } = await apiClient.post<ReviewState>(
    "/api/review/signoff", { note: note ?? null }, { params: { period: periodEnd } },
  )
  return data
}

/** Fetch the memo PDF and hand it to the browser as a download.
 *
 *  Goes through apiClient rather than a bare link so the request carries the
 *  Clerk token and the workspace header — a plain <a href> would arrive
 *  unauthenticated and 401. */
async function downloadMemo(periodEnd: string): Promise<void> {
  const { data } = await apiClient.get<Blob>("/api/review/memo", {
    params: { period: periodEnd }, responseType: "blob",
  })
  const url = URL.createObjectURL(data)
  const a = document.createElement("a")
  a.href = url
  a.download = `Close-review-memo-${periodEnd.slice(0, 7)}.pdf`
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoked on the next tick: revoking synchronously can beat the click in
  // Safari and the download silently produces an empty file.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export const reviewApi = { getState, run, act, signOff, downloadMemo }
