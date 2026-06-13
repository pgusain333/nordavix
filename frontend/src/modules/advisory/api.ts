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

export interface TrackedRec {
  id:            string
  period_end:    string
  period_label:  string
  source:        string
  priority:      "high" | "medium" | "low"
  title:         string
  detail:        string | null
  kpi_key:       string | null
  status:        RecStatus
  client_action: string | null
  outcome_note:  string | null
  status_changed_at: string | null
  created_at:    string | null
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

async function getRecommendations(status?: RecStatus): Promise<TrackedRec[]> {
  const { data } = await apiClient.get<{ items: TrackedRec[] }>(
    "/api/advisory/recommendations", { params: status ? { status } : {} },
  )
  return data.items
}

async function updateRecommendation(
  id: string,
  body: { status?: RecStatus; client_action?: string | null; outcome_note?: string | null },
): Promise<TrackedRec> {
  const { data } = await apiClient.post<TrackedRec>(`/api/advisory/recommendations/${id}`, body)
  return data
}

export const advisoryApi = {
  getKpis, getCatalog, setTarget, deleteTarget, getRecommendations, updateRecommendation,
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
