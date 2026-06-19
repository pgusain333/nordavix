import { apiClient } from "@/core/api/client"

export interface AssistantSource {
  tool: string
  input: Record<string, unknown>
}

export interface AskResponse {
  answer: string
  sources: AssistantSource[]
}

export interface AssistantTurn {
  role: "user" | "assistant"
  content: string
}

export const assistantApi = {
  /**
   * Ask a grounded question about the current client. `periodEnd` (YYYY-MM-DD)
   * sets the context month; null lets the backend default to the latest synced
   * period. `history` is the prior turns for follow-up context.
   */
  ask: async (
    question: string,
    periodEnd: string | null,
    history: AssistantTurn[],
  ): Promise<AskResponse> => {
    const { data } = await apiClient.post("/api/assistant/ask", {
      question,
      period_end: periodEnd || null,
      history,
    })
    return data as AskResponse
  },
}
