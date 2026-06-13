/** Close Autopilot — config, runs, manual trigger. */
import { apiClient } from "@/core/api/client"

export interface AutopilotConfig {
  enabled: boolean
  run_day: number
  run_flux: boolean
  send_pbc_requests: boolean
  pbc_recipient_email: string | null
  updated_at: string | null
}

export interface AutopilotRunResults {
  synced?: boolean
  accounts_total?: number
  prepared?: number
  ai_analyzed?: number
  skipped?: number
  flux_created?: boolean
  flux_variances?: number
  flux_material?: number
  flux_ai_queued?: number
  pbc_sent?: number
  errors?: string[]
}

export interface AutopilotRun {
  id: string
  period_end: string
  period_label: string
  status: "running" | "completed" | "partial" | "failed"
  triggered_by: "schedule" | "manual"
  results: AutopilotRunResults
  started_at: string | null
  finished_at: string | null
}

export interface AutopilotState {
  config: AutopilotConfig | null
  runs: AutopilotRun[]
  next_period: string | null
  next_period_label: string | null
  running: boolean
}

async function getState(): Promise<AutopilotState> {
  const { data } = await apiClient.get<AutopilotState>("/api/autopilot")
  return data
}

async function saveConfig(body: Omit<AutopilotConfig, "updated_at">): Promise<AutopilotConfig> {
  const { data } = await apiClient.put<AutopilotConfig>("/api/autopilot/config", body)
  return data
}

async function runNow(): Promise<{ started: boolean; period_end: string; period_label: string }> {
  const { data } = await apiClient.post<{ started: boolean; period_end: string; period_label: string }>("/api/autopilot/run")
  return data
}

export const autopilotApi = { getState, saveConfig, runNow }
