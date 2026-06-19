import { apiClient, API_BASE_URL, authHeaders } from "@/core/api/client"

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

/** One Server-Sent event from /ask/stream. */
export type StreamEvent =
  | { type: "step"; label: string }
  | { type: "delta"; text: string }
  | { type: "reset" }
  | { type: "result"; answer: string; sources: AssistantSource[]; drafts: AssistantDraft[]; links: AssistantLink[] }
  | { type: "done"; thread_id: string | null }
  | { type: "error"; message: string }

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

  /**
   * Streaming ask — same inputs as `ask`, but reads Server-Sent events and calls
   * `onEvent` for each (step / delta / reset / result / done / error). Uses fetch
   * (not axios) so we can read the response body as it arrives. Pass an
   * AbortSignal to cancel an in-flight answer. Resolves when the stream ends.
   */
  askStream: async (
    question: string,
    periodEnd: string | null,
    history: AssistantTurn[],
    threadId: string | null,
    onEvent: (ev: StreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> => {
    const res = await fetch(`${API_BASE_URL}/api/assistant/ask/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify({
        question,
        period_end: periodEnd || null,
        history,
        thread_id: threadId || null,
      }),
      signal,
    })
    if (!res.ok || !res.body) throw new Error(`assistant stream failed: ${res.status}`)

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ""
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      // SSE frames are separated by a blank line.
      let idx: number
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const dataLine = frame.split("\n").find((l) => l.startsWith("data:"))
        if (!dataLine) continue
        const json = dataLine.slice(5).trim()
        if (!json) continue
        try {
          onEvent(JSON.parse(json) as StreamEvent)
        } catch {
          /* ignore a malformed frame */
        }
      }
    }
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
