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
  /** When Nordavix FIRST saw this, surviving re-scans. Not created_at, which
   *  resets every scan because open findings are replaced wholesale. */
  first_seen_at:            string | null
}

/** Evidence that the books are actually being watched — the honest version of
 *  "real-time monitoring". `ok` is null while a scan is in flight and false if
 *  it failed; neither may render as a clean bill of health. */
export interface GlMonitoring {
  ever_scanned:          boolean
  /** Every run against the period, whatever triggered it. */
  checks_this_period:    number
  /** Runs the SCHEDULE fired — the only ones that evidence continuous close.
   *  Manual scans and post-sync passes are real checks but they are not the
   *  watch working, and counting them together let the strip take credit for
   *  work the user did by hand. */
  unattended_checks?:    number
  checked_at?:           string | null   // finished_at of the latest run
  started_at?:           string | null
  ok?:                   boolean | null
  error?:                string | null
  trigger?:              string          // sync | scheduled | manual
  transactions_reviewed?: number
  accounts_scanned?:     number
  new_last_check?:       number
  /** The period the last run covered. Not necessarily the one on screen — the
   *  sweep watches the open month AND the prior unclosed one. */
  scanned_period?:       string | null
}

/** The daily check's own state — separate from what the last scan found. */
export interface GlSchedule {
  enabled:        boolean
  check_hour?:    number
  /** The zone the hour is read in. "UTC" when the workspace never set one. */
  timezone?:      string
  /** True when no workspace timezone is set, so the chosen hour is being read
   *  as UTC. The commonest reason a check "didn't run at my time" — it ran,
   *  just five and a half hours later. */
  timezone_is_default?: boolean
  local_now?:     string
  next_due_at?:   string | null
  last_scheduled_at?: string | null
  /** The last scheduled run in the WORKSPACE's clock ("Sat 15:42"), so it can
   *  be compared against the hour that was chosen. "20 hours ago" is
   *  unarguable and says nothing about whether the schedule is honoured. */
  last_scheduled_local?: string | null
  /** Whether the SCHEDULE has ever completed a check. A manual scan doesn't
   *  count — conflating them is what hid this. */
  ever_ran_on_schedule?: boolean
  /** The schedule was edited after that run, so it happened under different
   *  settings and won't line up with the hour now shown. */
  changed_since_last_run?: boolean
  /** Why it cannot run at all: demo workspace, no QuickBooks, no books start
   *  date, or the watched month is closed. Null when nothing blocks it. */
  blocked?:       string | null
}

export interface GlFindingsResponse {
  /** The month CONTINUOUS CLOSE tracks — always the current one, never the
   *  period the user selected. Risk Radar checks the month being closed. */
  monitoring_period: string
  items:      GlFinding[]
  open_count: number
  high:       number
  medium:     number
  dollars:    string
  monitoring: GlMonitoring
  /** Whether the daily check CAN run, and when it next will. The rail could
   *  only ever say "on", while the sweep skipped the workspace for any of five
   *  reasons none of which were visible. */
  schedule?: GlSchedule | null
  /** What the WATCH has caught, in `monitoring_period` — newest first. Never
   *  derive this from `items`: those belong to the period being closed, and
   *  showing them under "Recently caught" credits continuous close with finds
   *  from a month it never looked at. */
  monitoring_recent: GlFinding[]
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
