/** Advisory — longitudinal KPI trends vs targets + tracked recommendations. */
import { apiClient } from "@/core/api/client"

export type Comparator = "gte" | "lte" | "between"
export type KpiStatus = "met" | "missed" | null
export type RecStatus = "open" | "in_progress" | "done" | "dismissed"

export interface KpiSeriesPoint { period: string; label: string; value: number }
export interface KpiTargetDef {
  comparator:  Comparator
  value:       number
  value_upper: number | null
  note:        string | null
}
export interface Kpi {
  key:           string
  label:         string
  unit:          string         // "$" | "%" | "months" | "days" | "x"
  higher_better: boolean
  current:       number | null
  prior:         number | null
  series:        KpiSeriesPoint[]
  target:        KpiTargetDef | null
  status:        KpiStatus
}
export interface KpiOverview {
  period_end: string
  kpis:       Kpi[]
  periods:    string[]
}

export interface CatalogKpi {
  key: string; label: string; section: string; field: string; unit: string; higher_better: boolean
}

/** Has the metric this advice was meant to move actually moved?
 *
 *  `unlinked` means no KPI was named — the advice can't be graded at all.
 *  `unknown` means it was linked but there's no baseline or no current
 *  reading. Kept apart because they call for different fixes. */
export type Grade = "achieved" | "working" | "flat" | "worsening" | "unknown" | "unlinked"

export interface RecProgress {
  grade:         Grade
  /** Readings at or after the baseline — a recommendation can't claim credit
   *  for a month that happened before the advice was given. */
  since:         KpiSeriesPoint[]
  current:       number | null
  unit?:         string
  kpi_label?:    string
  higher_better?: boolean
}

export interface TrackedRec {
  id:            string
  period_end:    string
  period_label:  string
  source:        string
  priority:      "high" | "medium" | "low"
  title:         string
  detail:        string | null
  kpi_key:       string | null
  kpi_label:     string | null
  /** The metric's value when the advice was given. Everything is measured
   *  from here, so it's stored rather than re-derived. */
  baseline_value: number | null
  baseline_at:    string | null
  target_value:   number | null
  due_date:       string | null
  expected_impact: number | null
  impact_note:     string | null
  owner:           string | null
  status:        RecStatus
  client_action: string | null
  outcome_note:  string | null
  status_changed_at: string | null
  created_at:    string | null
  progress?:     RecProgress
}

/** What the firm's advice has been worth — assembled from the client's own
 *  numbers rather than asserted. */
export interface AdvisoryScorecard {
  period_end: string
  total:      number
  acted_on:   number
  graded:     number
  /** Advice with no metric attached, or no baseline to measure from. Counted
   *  in the open, because a scorecard that drops its own ungradable rows
   *  flatters itself. */
  unlinked:   number
  by_grade:   Partial<Record<Grade, number>>
  /** Estimated impact on the items that are moving — an expectation being met,
   *  not a measured saving. The label has to say so. */
  impact_in_motion: number
}

export interface NewRec {
  period_end:       string
  title:            string
  detail?:          string | null
  kpi_key?:         string | null
  priority?:        "high" | "medium" | "low"
  target_value?:    number | null
  due_date?:        string | null
  expected_impact?: number | null
  impact_note?:     string | null
  owner?:           string | null
}

async function getKpis(periodEnd: string): Promise<KpiOverview> {
  const { data } = await apiClient.get<KpiOverview>("/api/advisory", { params: { period: periodEnd } })
  return data
}

async function getCatalog(): Promise<CatalogKpi[]> {
  const { data } = await apiClient.get<{ kpis: CatalogKpi[] }>("/api/advisory/catalog")
  return data.kpis
}

async function setTarget(
  kpiKey: string,
  body: { comparator: Comparator; value: number; value_upper?: number | null; note?: string | null },
): Promise<KpiTargetDef> {
  const { data } = await apiClient.put<KpiTargetDef>(`/api/advisory/targets/${kpiKey}`, body)
  return data
}

async function deleteTarget(kpiKey: string): Promise<void> {
  await apiClient.delete(`/api/advisory/targets/${kpiKey}`)
}

async function getRecommendations(status?: RecStatus, periodEnd?: string): Promise<TrackedRec[]> {
  const { data } = await apiClient.get<{ items: TrackedRec[] }>(
    "/api/advisory/recommendations",
    { params: { ...(status ? { status } : {}), ...(periodEnd ? { period: periodEnd } : {}) } },
  )
  return data.items
}

async function updateRecommendation(
  id: string,
  body: {
    status?: RecStatus; client_action?: string | null; outcome_note?: string | null
    priority?: "high" | "medium" | "low"; owner?: string | null
    due_date?: string | null; target_value?: number | null
    /** Link the metric this advice is meant to move. "" unlinks. Setting it
     *  also captures what that metric read when the advice was given, so the
     *  grade measures from the advice rather than from today. */
    kpi_key?: string | null
  },
): Promise<TrackedRec> {
  const { data } = await apiClient.post<TrackedRec>(`/api/advisory/recommendations/${id}`, body)
  return data
}

/** Advice a human is giving. This path didn't exist — the module could only
 *  hold what the AI said in a monthly report. */
async function createRecommendation(body: NewRec): Promise<TrackedRec> {
  const { data } = await apiClient.post<TrackedRec>("/api/advisory/recommendations", body)
  return data
}

async function getScorecard(periodEnd: string): Promise<AdvisoryScorecard> {
  const { data } = await apiClient.get<AdvisoryScorecard>(
    "/api/advisory/scorecard", { params: { period: periodEnd } },
  )
  return data
}

export const advisoryApi = {
  getKpis, getCatalog, setTarget, deleteTarget, getRecommendations,
  updateRecommendation, createRecommendation, getScorecard,
}

/** Format a KPI value for display, by unit. */
export function formatKpi(value: number | null | undefined, unit: string): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—"
  if (unit === "$") {
    const abs = Math.abs(value)
    const sign = value < 0 ? "-" : ""
    if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`
    if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`
    return `${sign}$${abs.toFixed(0)}`
  }
  if (unit === "%") return `${value.toFixed(1)}%`
  if (unit === "x") return `${value.toFixed(2)}x`
  if (unit === "months" || unit === "days") return `${value.toFixed(1)} ${unit}`
  return value.toLocaleString()
}
