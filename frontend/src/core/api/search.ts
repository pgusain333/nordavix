/** Workspace search — one query across accounts, findings, tasks, entries,
 *  schedules and periods. Backs the command palette. */
import { apiClient } from "@/core/api/client"

export type SearchType =
  | "account" | "finding" | "review" | "task"
  | "adjustment" | "schedule" | "period"

export interface SearchHit {
  type:       SearchType
  id:         string
  label:      string
  sublabel:   string | null
  link:       string
  score:      number
  period_end: string | null
}

export interface SearchResponse {
  query:     string
  /** Below this many characters the server returns nothing — a single letter
   *  matches most of a workspace, and the UI says so rather than looking broken. */
  min_query: number
  results:   SearchHit[]
}

async function query(q: string, signal?: AbortSignal): Promise<SearchResponse> {
  const { data } = await apiClient.get<SearchResponse>("/api/search", {
    params: { q }, signal,
  })
  return data
}

export const searchApi = { query }
