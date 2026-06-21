/**
 * Knowledge-graph read API — backs the "Related" panel.
 *
 * The graph stores relationships between close objects (reconciliations,
 * journal entries, accounts, findings, schedules…). This client fetches the
 * resolved, relationship-grouped neighborhood of one object so the UI can show
 * what it's connected to.
 */
import { apiClient } from "@/core/api/client"

export type GraphNodeType =
  | "account"
  | "journal_entry"
  | "reconciliation"
  | "flux_variance"
  | "finding"
  | "task"
  | "schedule"
  | "memo"
  | "period"

export interface RelatedItem {
  type:     GraphNodeType
  id:       string
  label:    string
  sublabel: string | null
  href:     string | null
  status:   string | null
}

export interface RelatedGroup {
  /** Stored predicate from the queried node's perspective (e.g. "has_finding"). */
  relation: string
  /** Human label for the relationship (e.g. "has finding"). */
  label:    string
  items:    RelatedItem[]
}

export interface RelatedResponse {
  node:   { type: string; id: string }
  groups: RelatedGroup[]
  total:  number
}

export const graphApi = {
  /** Connected objects for one node, grouped by relationship. For an account
   *  in a period (the recon drawer), the backend also folds in that account's
   *  reconciliation node so the panel shows the full story. */
  async related(
    nodeType: GraphNodeType,
    nodeId:   string,
    periodEnd?: string,
  ): Promise<RelatedResponse> {
    const { data } = await apiClient.get<RelatedResponse>("/api/graph/related", {
      params: { node_type: nodeType, node_id: nodeId, period_end: periodEnd },
    })
    return data
  },
}
