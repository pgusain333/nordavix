/**
 * Client Assistant — grounded, tenant-scoped Q&A (Tier 3 Phase 0).
 *
 * A chat surface that answers questions about the ACTIVE client by calling
 * read-only backend tools (reconciliations, balances, close status, taught
 * expectations). Every answer is grounded in the client's real synced data —
 * the model can't reach another client's books, and it can only read. The
 * "Sources" chips under each answer show which data it consulted.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react"
import { useMutation } from "@tanstack/react-query"
import { motion } from "framer-motion"
import { Bot, ArrowUp, Sparkles } from "lucide-react"
import { assistantApi, type AssistantSource, type AssistantTurn } from "@/modules/assistant/api"

interface ChatMsg {
  role: "user" | "assistant"
  content: string
  sources?: AssistantSource[]
  error?: boolean
}

const SUGGESTIONS = [
  "What's blocking the close this month?",
  "Which accounts are unreconciled?",
  "What's our cash balance?",
  "Are there any accounts that don't tie out?",
]

// Friendly labels for the tool a source came from.
const TOOL_LABEL: Record<string, string> = {
  get_reconciliations_overview: "Reconciliations",
  get_account_balance: "Account balance",
  get_close_status: "Close status",
  get_account_guidance: "Client memory",
}

function sourceLabels(sources: AssistantSource[] | undefined): string[] {
  if (!sources?.length) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of sources) {
    const label = TOOL_LABEL[s.tool] ?? s.tool
    if (!seen.has(label)) {
      seen.add(label)
      out.push(label)
    }
  }
  return out
}

export default function AssistantPage() {
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState("")
  const bottomRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  const askMut = useMutation({
    mutationFn: (v: { q: string; history: AssistantTurn[] }) =>
      assistantApi.ask(v.q, null, v.history),
  })

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [messages, askMut.isPending])

  async function send(text: string) {
    const q = text.trim()
    if (!q || askMut.isPending) return
    const history: AssistantTurn[] = messages
      .filter((m) => !m.error)
      .map((m) => ({ role: m.role, content: m.content }))
    setMessages((prev) => [...prev, { role: "user", content: q }])
    setInput("")
    try {
      const res = await askMut.mutateAsync({ q, history })
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: res.answer, sources: res.sources },
      ])
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "Sorry — I hit an error answering that. Please try again in a moment.",
          error: true,
        },
      ])
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      void send(input)
    }
  }

  const empty = messages.length === 0

  return (
    <div className="mx-auto flex h-[calc(100vh-7rem)] max-w-3xl flex-col">
      {/* Header */}
      <div className="shrink-0 px-1 pb-4">
        <div className="flex items-center gap-2.5">
          <div
            className="flex h-9 w-9 items-center justify-center rounded-lg"
            style={{ background: "var(--green-subtle)", color: "var(--green)" }}
          >
            <Sparkles size={18} strokeWidth={1.8} />
          </div>
          <div>
            <h1 className="text-lg font-semibold leading-tight" style={{ color: "var(--text)" }}>
              Assistant
            </h1>
            <p className="text-[12.5px]" style={{ color: "var(--text-muted)" }}>
              Grounded in this client's synced data · read-only
            </p>
          </div>
        </div>
      </div>

      {/* Conversation */}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-1 pb-4">
        {empty ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div
              className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl"
              style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}
            >
              <Bot size={24} strokeWidth={1.6} />
            </div>
            <p className="text-[15px] font-medium" style={{ color: "var(--text)" }}>
              Ask anything about this client's books
            </p>
            <p className="mt-1 max-w-sm text-[13px]" style={{ color: "var(--text-muted)" }}>
              I'll pull the answer from your reconciliations, balances, close status,
              and what you've taught me — never guessing.
            </p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => void send(s)}
                  className="rounded-full px-3 py-1.5 text-[12.5px] transition-colors"
                  style={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    color: "var(--text)",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "var(--surface)")}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m, i) => <MessageBubble key={i} msg={m} />)
        )}

        {askMut.isPending && (
          <div className="flex items-center gap-2 px-1" style={{ color: "var(--text-muted)" }}>
            <Bot size={16} strokeWidth={1.7} />
            <span className="flex gap-1">
              <Dot delay={0} />
              <Dot delay={0.15} />
              <Dot delay={0.3} />
            </span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Composer */}
      <div className="shrink-0 px-1 pt-1">
        <div
          className="flex items-end gap-2 rounded-xl p-2"
          style={{ background: "var(--surface)", border: "1px solid var(--border-strong)" }}
        >
          <textarea
            ref={taRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder="Ask about balances, variances, what's blocking close…"
            className="max-h-32 flex-1 resize-none bg-transparent px-2 py-1.5 text-[14px] outline-none"
            style={{ color: "var(--text)" }}
          />
          <button
            onClick={() => void send(input)}
            disabled={!input.trim() || askMut.isPending}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-opacity disabled:opacity-40"
            style={{ background: "var(--green)", color: "#fff" }}
            title="Send"
            aria-label="Send"
          >
            <ArrowUp size={18} strokeWidth={2.2} />
          </button>
        </div>
        <p className="mt-1.5 px-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
          The assistant reads your data to answer — it never posts entries or changes anything.
        </p>
      </div>
    </div>
  )
}

function MessageBubble({ msg }: { msg: ChatMsg }) {
  const isUser = msg.role === "user"
  const labels = sourceLabels(msg.sources)
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className={isUser ? "flex justify-end" : "flex justify-start"}
    >
      <div className={isUser ? "max-w-[85%]" : "max-w-[92%]"}>
        <div
          className="whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-[14px] leading-relaxed"
          style={
            isUser
              ? { background: "var(--green-subtle)", color: "var(--text)" }
              : {
                  background: "var(--surface-2)",
                  color: msg.error ? "var(--warn)" : "var(--text)",
                  border: "1px solid var(--border)",
                }
          }
        >
          {msg.content}
        </div>
        {labels.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5 px-1">
            <span className="text-[10.5px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
              Sources
            </span>
            {labels.map((l) => (
              <span
                key={l}
                className="rounded-full px-2 py-0.5 text-[10.5px] font-medium"
                style={{ background: "var(--info-subtle)", color: "var(--info)" }}
              >
                {l}
              </span>
            ))}
          </div>
        )}
      </div>
    </motion.div>
  )
}

function Dot({ delay }: { delay: number }) {
  return (
    <motion.span
      className="inline-block h-1.5 w-1.5 rounded-full"
      style={{ background: "currentColor" }}
      animate={{ opacity: [0.3, 1, 0.3] }}
      transition={{ duration: 1, repeat: Infinity, delay }}
    />
  )
}
