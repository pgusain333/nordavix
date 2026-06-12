/**
 * Firm-level API — data that crosses workspace boundaries.
 *
 * The backend authorizes by Clerk-org membership (same model as the
 * intercompany accessible-companies endpoint): you see exactly the
 * companies you belong to, regardless of which one is active.
 */
import { apiClient } from "@/core/api/client"

export interface CommandCenterFocus {
  period_end: string
  label:      string
  status:     "complete" | "in_progress" | "not_started"
  total:      number
  approved:   number
  reviewed:   number
  flagged:    number
  days_since_period_end: number
}

export interface CommandCenterFlux {
  total:    number
  approved: number
  state:    "done" | "in_progress"
}

export interface CommandCenterCompany {
  tenant_id:     string
  name:          string
  clerk_org_id:  string
  is_demo:       boolean
  qbo_connected: boolean
  books_set:     boolean
  focus:         CommandCenterFocus | null
  closed_through: string | null
  flux:          CommandCenterFlux | null
  open_adjustments: number
}

export interface CommandCenterResponse {
  companies:    CommandCenterCompany[]
  generated_at: string
}

async function getCommandCenter(): Promise<CommandCenterResponse> {
  const { data } = await apiClient.get<CommandCenterResponse>("/api/workspace/command-center")
  return data
}

export const firmApi = { getCommandCenter }
