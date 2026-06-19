import { apiClient } from "@/core/api/client"

export interface AssistantSource {
  tool: string
  input: Record<string, unknown>
}

export interface AssistantDraftLine {
  account_number?: string | null
  account_name?: string | null
  account_qbo_id?: string | null
  debit: string
  credit: string
}

export interface AssistantDraft {
  description: string
  lines: AssistantDraftLine[]
  memo?: string | null
  rationale?: string | null
  confidence?: string | null
  period_end?: string | null
}

export interface AssistantLink {
  path: string
  label: string
}

export interface AskResponse {
  answer: string
  sources: AssistantSource[]
  thread_id: string | null
  drafts: AssistantDraft[]
  links: AssistantLink[]
}

export interface AssistantTurn {
  role: "user" | "assistant"
  content: string
}

export interface ThreadSummary {
  id: string
  title: string
  updated_at: string
}

export interface ThreadMessage {
  role: "user" | "assistant"
  content: string
  sources: AssistantSource[] | null
  created_at: string
}

export const assistantApi = {
  /**
   * Ask a grounded question about the current client. `periodEnd` (YYYY-MM-DD)
   * sets the context month; null lets the backend default to the latest synced
   * period. `history` is the prior turns; `threadId` continues an existing
   * conversation (null/undefined starts a new one). Returns the (possibly new)
   * thread_id so the caller can keep persisting into it.
   */
  ask: async (
    question: string,
    periodEnd: string | null,
    history: AssistantTurn[],
    threadId: string | null,
  ): Promise<AskResponse> => {
    const { data } = await apiClient.post("/api/assistant/ask", {
      question,
      period_end: periodEnd || null,
      history,
      thread_id: threadId || null,
    })
    return data as AskResponse
  },

  /** The current user's recent conversations for this client, newest first. */
  listThreads: async (): Promise<ThreadSummary[]> => {
    const { data } = await apiClient.get("/api/assistant/threads")
    return data as ThreadSummary[]
  },

  /** Full message history for one conversation. */
  getThread: async (threadId: string): Promise<ThreadMessage[]> => {
    const { data } = await apiClient.get(`/api/assistant/threads/${threadId}`)
    return data as ThreadMessage[]
  },
}
