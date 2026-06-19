/**
 * Client Assistant — "NDVX Chat".
 *
 * Grounded, tenant-scoped Q&A with conversation memory and propose-only actions
 * (Tier 3). Empty state is a centered hero with the composer; once a thread
 * starts, messages fill the view and the composer docks at the bottom. Answers
 * render as themed Markdown (tables, lists, bold) — never raw "| --- |" text.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react"
import { useNavigate } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { motion } from "framer-motion"
import { Bot, ArrowUp, Sparkles, Plus, History, Clock, FileText, ArrowUpRight } from "lucide-react"
import {
  assistantApi,
  type AssistantSource,
  type AssistantTurn,
  type AssistantDraft,
  type AssistantLink,
} from "@/modules/assistant/api"
import { Markdown } from "@/modules/assistant/Markdown"

interface ChatMsg {
  role: "user" | "assistant"
  content: string
  sources?: AssistantSource[] | null
  drafts?: AssistantDraft[]
  links?: AssistantLink[]
  error?: boolean
}

function money(s: string | null | undefined): string {
  const n = Number(s ?? 0)
  if (!isFinite(n)) return String(s ?? "")
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const SUGGESTIONS = [
  "What's blocking the close this month?",
  "Which accounts are unreconciled?",
  "What's our cash balance?",
  "Are there any accounts that don't tie out?",
]

const TOOL_LABEL: Record<string, string> = {
  get_reconciliations_overview: "Reconciliations",
  get_account_balance: "Account balance",
  get_close_status: "Close status",
  get_account_guidance: "Client memory",
  recall: "Past records",
  draft_journal_entry: "Drafted entry",
  suggest_link: "Link",
}

function sourceLabels(sources: AssistantSource[] | null | undefined): string[] {
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
  const qc = useQueryClient()
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState("")
  const [threadId, setThreadId] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  const { data: threads } = useQuery({
    queryKey: ["assistant-threads"],
    queryFn: assistantApi.listThreads,
    staleTime: 30_000,
  })

  const askMut = useMutation({
    mutationFn: (v: { q: string; history: AssistantTurn[]; threadId: string | null }) =>
      assistantApi.ask(v.q, null, v.history, v.threadId),
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
      const res = await askMut.mutateAsync({ q, history, threadId })
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: res.answer,
          sources: res.sources,
          drafts: res.drafts,
          links: res.links,
        },
      ])
      if (res.thread_id) setThreadId(res.thread_id)
      void qc.invalidateQueries({ queryKey: ["assistant-threads"] })
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

  function newChat() {
    setMessages([])
    setThreadId(null)
    setHistoryOpen(false)
  }

  async function loadThread(id: string) {
    setHistoryOpen(false)
    try {
      const msgs = await assistantApi.getThread(id)
      setMessages(msgs.map((m) => ({ role: m.role, content: m.content, sources: m.sources })))
      setThreadId(id)
    } catch {
      /* leave current conversation in place on failure */
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      void send(input)
    }
  }

  const empty = messages.length === 0

  const composer = (
    <div className="w-full">
      <div
        className="flex items-end gap-2 rounded-2xl p-2.5 shadow-sm"
        style={{ background: "var(--surface)", border: "1px solid var(--border-strong)" }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder="Ask about balances, variances, what's blocking close…"
          className="max-h-40 flex-1 resize-none bg-transparent px-2 py-1.5 text-[14px] outline-none"
          style={{ color: "var(--text)" }}
        />
        <button
          onClick={() => void send(input)}
          disabled={!input.trim() || askMut.isPending}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-opacity disabled:opacity-40"
          style={{ background: "var(--green)", color: "#fff" }}
          title="Send"
          aria-label="Send"
        >
          <ArrowUp size={18} strokeWidth={2.2} />
        </button>
      </div>
      <p className="mt-1.5 px-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
        Grounded in your data · read-only · never posts to QuickBooks without you.
      </p>
    </div>
  )

  const suggestionChips = (
    <div className="flex flex-wrap justify-center gap-2">
      {SUGGESTIONS.map((s) => (
        <button
          key={s}
          onClick={() => void send(s)}
          className="rounded-full px-3 py-1.5 text-[12.5px] transition-colors"
          style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "var(--surface)")}
        >
          {s}
        </button>
      ))}
    </div>
  )

  return (
    <div className="mx-auto flex h-[calc(100vh-7rem)] max-w-3xl flex-col">
      {/* Header: controls always; small title only once a conversation is active */}
      <div className="relative flex shrink-0 items-center justify-between gap-2 px-1 pb-3">
        <div className="flex items-center gap-2.5" style={{ visibility: empty ? "hidden" : "visible" }}>
          <div
            className="flex h-8 w-8 items-center justify-center rounded-lg"
            style={{ background: "var(--green-subtle)", color: "var(--green)" }}
          >
            <Sparkles size={16} strokeWidth={1.8} />
          </div>
          <span className="text-[15px] font-semibold" style={{ color: "var(--text)" }}>
            NDVX Chat
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setHistoryOpen((o) => !o)}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] transition-colors"
            style={{ border: "1px solid var(--border)", color: "var(--text-muted)" }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            title="Recent conversations"
          >
            <History size={15} strokeWidth={1.8} /> History
          </button>
          <button
            onClick={newChat}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium transition-colors"
            style={{ background: "var(--green)", color: "#fff" }}
            title="Start a new conversation"
          >
            <Plus size={15} strokeWidth={2} /> New
          </button>

          {historyOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setHistoryOpen(false)} />
              <div
                className="absolute right-0 top-11 z-20 max-h-80 w-72 overflow-y-auto rounded-xl p-1.5 shadow-xl"
                style={{ background: "var(--surface)", border: "1px solid var(--border-strong)" }}
              >
                {!threads?.length ? (
                  <p className="px-2 py-3 text-center text-[12.5px]" style={{ color: "var(--text-muted)" }}>
                    No past conversations yet.
                  </p>
                ) : (
                  threads.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => void loadThread(t.id)}
                      className="flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors"
                      style={{ background: t.id === threadId ? "var(--surface-2)" : "transparent" }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
                      onMouseLeave={(e) =>
                        (e.currentTarget.style.background =
                          t.id === threadId ? "var(--surface-2)" : "transparent")
                      }
                    >
                      <Clock size={13} strokeWidth={1.7} className="mt-0.5 shrink-0" style={{ color: "var(--text-muted)" }} />
                      <span className="line-clamp-2 text-[12.5px]" style={{ color: "var(--text)" }}>
                        {t.title}
                      </span>
                    </button>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {empty ? (
        /* ── Centered hero ── */
        <div className="relative flex flex-1 flex-col items-center justify-center px-4 pb-10 text-center">
          {/* soft brand glow */}
          <div
            aria-hidden
            className="pointer-events-none absolute left-1/2 top-1/2 h-72 w-72 -translate-x-1/2 -translate-y-[60%] rounded-full blur-3xl"
            style={{ background: "var(--green-subtle)", opacity: 0.55 }}
          />
          <div className="relative w-full max-w-xl">
            <div
              className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl shadow-sm"
              style={{ background: "var(--green-subtle)", color: "var(--green)" }}
            >
              <Sparkles size={28} strokeWidth={1.7} />
            </div>
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl" style={{ color: "var(--text)" }}>
              NDVX <span style={{ color: "var(--green)" }}>Chat</span>
            </h1>
            <p className="mx-auto mt-2.5 max-w-md text-[14px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
              Ask anything about this client's books — answered straight from your real, synced
              data, with the numbers to back it up.
            </p>
            <div className="mt-6">{composer}</div>
            <div className="mt-5">{suggestionChips}</div>
          </div>
        </div>
      ) : (
        /* ── Active conversation ── */
        <>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-1 pb-4">
            {messages.map((m, i) => (
              <MessageBubble key={i} msg={m} />
            ))}
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
          <div className="shrink-0 px-1 pt-1">{composer}</div>
        </>
      )}
    </div>
  )
}

function MessageBubble({ msg }: { msg: ChatMsg }) {
  const isUser = msg.role === "user"
  const navigate = useNavigate()
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
          className="rounded-2xl px-3.5 py-2.5 text-[14px] leading-relaxed"
          style={
            isUser
              ? { background: "var(--green-subtle)", color: "var(--text)", whiteSpace: "pre-wrap" }
              : {
                  background: "var(--surface-2)",
                  color: msg.error ? "var(--warn)" : "var(--text)",
                  border: "1px solid var(--border)",
                  whiteSpace: msg.error ? "pre-wrap" : undefined,
                }
          }
        >
          {isUser || msg.error ? msg.content : <Markdown text={msg.content} />}
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

        {msg.drafts?.map((d, di) => (
          <div
            key={di}
            className="mt-2 rounded-xl p-3"
            style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
          >
            <div className="mb-1.5 flex items-center gap-1.5">
              <FileText size={14} style={{ color: "var(--green)" }} />
              <span className="text-[12.5px] font-medium" style={{ color: "var(--text)" }}>
                {d.description}
              </span>
            </div>
            <div className="space-y-0.5">
              {d.lines.map((ln, li) => (
                <div
                  key={li}
                  className="flex items-center justify-between text-[12px] tabular-nums"
                  style={{ color: "var(--text-muted)" }}
                >
                  <span className="truncate">
                    {[ln.account_number, ln.account_name].filter(Boolean).join(" · ") || "—"}
                  </span>
                  <span className="ml-3 shrink-0">
                    {Number(ln.debit) > 0 ? `Dr ${money(ln.debit)}` : `Cr ${money(ln.credit)}`}
                  </span>
                </div>
              ))}
            </div>
            {d.memo && (
              <p className="mt-1.5 text-[11.5px]" style={{ color: "var(--text-muted)" }}>
                Memo: {d.memo}
              </p>
            )}
            <div className="mt-2 flex items-center justify-between">
              <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                Draft · in Adjustments for review
              </span>
              <button
                onClick={() => navigate("/app/adjustments")}
                className="inline-flex items-center gap-1 text-[12px] font-medium"
                style={{ color: "var(--green)" }}
              >
                Review <ArrowUpRight size={13} />
              </button>
            </div>
          </div>
        ))}

        {msg.links && msg.links.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {msg.links.map((l, li) => (
              <button
                key={li}
                onClick={() => navigate(l.path)}
                className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium transition-colors"
                style={{ border: "1px solid var(--border)", color: "var(--text)" }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                {l.label} <ArrowUpRight size={13} />
              </button>
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
