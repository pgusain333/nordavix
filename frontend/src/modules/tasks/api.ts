import { apiClient } from "@/core/api/client"

// ── Types (mirror backend TaskOut) ────────────────────────────────────────────

export type TaskSeverity   = "info" | "warn" | "critical"
export type TaskSourceType = "recon_account" | "flux" | "schedule" | "manual"
export type TaskStatus     = "pending" | "reviewed" | "approved" | "flagged" | "manual"

export interface Task {
  key:           string
  source_type:   TaskSourceType
  source_id:     string | null
  period_end:    string | null
  subject:       string
  description:   string | null
  severity:      TaskSeverity
  deep_link:     string | null

  // Workflow
  status:        TaskStatus
  prepared_by:   string | null
  prepared_at:   string | null
  approved_by:   string | null
  approved_at:   string | null
  due_date:           string | null
  due_date_overridden:boolean

  // Admin-set assignments
  assigned_preparer_id: string | null
  assigned_reviewer_id: string | null

  // Overlay
  action_id:     string | null
  assignee_id:   string | null      // legacy single-assignee
  notes:         string | null
  completed_at:  string | null
  dismissed_at:  string | null

  // Manual-only
  priority:      string | null
  created_by:    string | null
  created_at:    string | null
}

export interface TasksCount {
  open:     number
  critical: number
  manual:   number
  derived:  number
}

// ── Calls ────────────────────────────────────────────────────────────────────

async function list(includeClosed = false): Promise<Task[]> {
  const { data } = await apiClient.get<{ tasks: Task[] }>("/api/tasks", {
    params: { include_closed: includeClosed },
  })
  return data.tasks
}

async function getCount(): Promise<TasksCount> {
  const { data } = await apiClient.get<TasksCount>("/api/tasks/count")
  return data
}

interface ActionUpsert {
  source_type:           TaskSourceType
  source_id:             string | null
  period_end:            string | null
  // Admin-only
  assigned_preparer_id?: string | null
  assigned_reviewer_id?: string | null
  due_date?:             string | null
  // Anyone-can-edit
  notes?:                string | null
  dismissed?:            boolean
}

async function upsertAction(body: ActionUpsert): Promise<{ ok: true; action_id: string }> {
  const { data } = await apiClient.post<{ ok: true; action_id: string }>("/api/tasks/action", body)
  return data
}

export interface TaskTarget {
  source_type: TaskSourceType
  source_id:   string | null
  period_end:  string | null
}

interface BulkAction {
  targets:               TaskTarget[]
  // Pass exactly one of these per call
  assigned_preparer_id?: string | null
  assigned_reviewer_id?: string | null
  due_date?:             string | null
  dismissed?:            boolean
  completed?:            boolean
}

async function bulkAction(body: BulkAction): Promise<{ applied: number }> {
  const { data } = await apiClient.post<{ applied: number }>("/api/tasks/bulk-action", body)
  return data
}

interface ManualTaskCreate {
  subject:               string
  description?:          string | null
  priority?:             string | null
  period_end?:           string | null
  assigned_preparer_id?: string | null
  assigned_reviewer_id?: string | null
  due_date?:             string | null
}

async function createManual(body: ManualTaskCreate): Promise<Task> {
  const { data } = await apiClient.post<Task>("/api/tasks/manual", body)
  return data
}

interface ManualTaskUpdate {
  subject?:              string
  description?:          string | null
  priority?:             string | null
  notes?:                string | null
  assigned_preparer_id?: string | null
  assigned_reviewer_id?: string | null
  due_date?:             string | null
}

async function updateManual(taskId: string, body: ManualTaskUpdate): Promise<Task> {
  const { data } = await apiClient.patch<Task>(`/api/tasks/manual/${taskId}`, body)
  return data
}

async function complete(actionId: string): Promise<void> {
  await apiClient.post(`/api/tasks/${actionId}/complete`)
}

export const tasksApi = {
  list,
  getCount,
  upsertAction,
  bulkAction,
  createManual,
  updateManual,
  complete,
}
