/** Close Management workflow — the milestone checklist above Tasks. */
import { apiClient } from "@/core/api/client"

export type CloseStepStatus = "pending" | "in_progress" | "done" | "skipped"

export interface CloseStep {
  step_key:      string
  order_index:   number
  title:         string
  description:   string | null
  category:      string
  linked_module: string | null
  linked:        boolean
  status:        CloseStepStatus
  assignee_id:   string | null
  due_date:      string | null
  completed_at:  string | null
  completed_by:  string | null
  notes:         string | null
}

export interface ChecklistResponse {
  period_end: string
  closed:     boolean
  steps:      CloseStep[]
  summary:    { total: number; done: number; pct: number }
}

export interface ClosePeriod {
  period_end: string
  label:      string
  closed:     boolean
}

export interface PeriodsResponse {
  books_start_date: string | null
  periods:          ClosePeriod[]
  focus:            string | null
}

export interface TemplateStep {
  id:            string
  key:           string
  order_index:   number
  title:         string
  description:   string | null
  category:      string
  linked_module: string | null
  due_offset_days: number | null
  default_assignee_role: string | null
  is_active:     boolean
}

async function getPeriods(): Promise<PeriodsResponse> {
  const { data } = await apiClient.get<PeriodsResponse>("/api/close/periods")
  return data
}

async function getChecklist(periodEnd: string): Promise<ChecklistResponse> {
  const { data } = await apiClient.get<ChecklistResponse>(
    "/api/close/checklist", { params: { period_end: periodEnd } },
  )
  return data
}

async function updateStep(body: {
  period_end: string
  step_key:   string
  status?:    CloseStepStatus
  notes?:     string
}): Promise<CloseStep> {
  const { data } = await apiClient.post<CloseStep>("/api/close/step", body)
  return data
}

async function getTemplate(): Promise<{ steps: TemplateStep[] }> {
  const { data } = await apiClient.get<{ steps: TemplateStep[] }>("/api/close/template")
  return data
}

async function addStep(body: {
  title: string
  description?: string | null
  category?: string
  due_offset_days?: number | null
}): Promise<TemplateStep> {
  const { data } = await apiClient.post<TemplateStep>("/api/close/template", body)
  return data
}

async function editStep(id: string, body: Partial<{
  title: string
  description: string | null
  category: string
  due_offset_days: number | null
  is_active: boolean
  order_index: number
}>): Promise<TemplateStep> {
  const { data } = await apiClient.patch<TemplateStep>(`/api/close/template/${id}`, body)
  return data
}

async function deleteStep(id: string): Promise<{ deleted: boolean }> {
  const { data } = await apiClient.delete<{ deleted: boolean }>(`/api/close/template/${id}`)
  return data
}

async function reorder(orderedIds: string[]): Promise<{ steps: TemplateStep[] }> {
  const { data } = await apiClient.post<{ steps: TemplateStep[] }>(
    "/api/close/template/reorder", { ordered_ids: orderedIds },
  )
  return data
}

export const closeApi = {
  getPeriods, getChecklist, updateStep,
  getTemplate, addStep, editStep, deleteStep, reorder,
}
