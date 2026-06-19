/**
 * Client Assistant — "NDVX Copilot".
 *
 * Grounded, tenant-scoped Q&A with conversation memory and propose-only actions
 * (Tier 3). The answer STREAMS in token-by-token over SSE (assistantApi.askStream)
 * so it feels instant; a live status line shows which data it's reading. Empty
 * state is a centered hero with the composer; once a thread starts, messages fill
 * the view and the composer docks at the bottom. Answers render as themed Markdown.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react"
import { useNavigate } from "react-router-dom"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { motion } from "framer-motion"
import {
  Sparkles, ArrowUp, Square, Plus, History, Clock, FileText, ArrowUpRight,
  Copy, Check, Loader2, AlertTriangle, Wallet, Scale, ClipboardList,
} from "lucide-react"
import {
  assistantApi,
  type AssistantSource,
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
  streaming?: boolean
}

function money(s: string | null | undefined): string {
  const n = Number(s ?? 0)
  if (!isFinite(n)) return String(s ?? "")
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const SUGGESTIONS: { icon: typeof Wallet; text: string }[] = [
  { icon: AlertTriangle, text: "What's blocking the close this month?" },
  { icon: ClipboardList, text: "Which accounts are unreconciled?" },
  { icon: Wallet, text: "What's our cash balance?" },
  { icon: Scale, text: "Are there any accounts that don't tie out?" },
]

const TOOL_LABEL: Record<string, string> = {
  get_reconciliations_overview: "Reconciliations",
  get_account_balance: "Account balance",
  get_close_status: "Close status",
  get_adjustments_queue: "Adjustments",
  get_financial_insights: "Insights",
  get_flux_variances: "Flux",
  get_schedules: "Schedules",
  get_risk_findings: "Risk Radar",
  get_close_tasks: "Close tasks",
  get_financial_statements: "Financials",
  get_intercompany: "Intercompany",
  get_team: "Team",
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

/** The brand mark used in the hero and on each assistant bubble. */
function BrandMark({ size = 28, box = 56 }: { size?: number; box?: number }) {
  return (
    <div
      className="flex items-center justify-center rounded-2xl shadow-sm"
      style={{
        height: box,
        width: box,
        background: "linear-gradient(145deg, var(--green), color-mix(in srgb, var(--green) 60%, #0a0f0d))",
        color: "#fff",
      }}
    >
      <Sparkles size={size} strokeWidth={1.7} />
    </div>
  )
}

export default function AssistantPage() {
  const qc = useQueryClient()
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState("")
  const [threadId, setThreadId] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [streaming, setStreaming] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const { data: threads } = useQuery({
    queryKey: ["assistant-threads"],
    queryFn: assistantApi.listThreads,
    staleTime: 30_000,
  })

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [messages, status])

  // Patch the last message (the in-flight assistant bubble).
  function patchLast(fn: (m: ChatMsg) => ChatMsg) {
    setMessages((prev) => {
      if (!prev.length) return prev
      const next = [...prev]
      next[next.length - 1] = fn(next[next.length - 1])
      return next
    })
  }

  async function send(text: string) {
    const q = text.trim()
    if (!q || streaming) return
    const history = messages
      .filter((m) => !m.error)
      .map((m) => ({ role: m.role, content: m.content }))
    setMessages((prev) => [
      ...prev,
      { role: "user", content: q },
      { role: "assistant", content: "", streaming: true },
    ])
    setInput("")
    setStreaming(true)
    setStatus(null)
    const ctrl = new AbortController()
    abortRef.current = ctrl

    try {
      await assistantApi.askStream(
        q,
        null,
        history,
        threadId,
        (ev) => {
          if (ev.type === "step") setStatus(ev.label)
          else if (ev.type === "delta") {
            setStatus(null)
            patchLast((m) => ({ ...m, content: m.content + ev.text }))
          } else if (ev.type === "reset") {
            patchLast((m) => ({ ...m, content: "" }))
          } else if (ev.type === "result") {
            patchLast((m) => ({
              ...m,
              content: ev.answer,
              sources: ev.sources,
              drafts: ev.drafts,
              links: ev.links,
            }))
          } else if (ev.type === "done") {
            if (ev.thread_id) setThreadId(ev.thread_id)
            void qc.invalidateQueries({ queryKey: ["assistant-threads"] })
          } else if (ev.type === "error") {
            patchLast((m) => ({ ...m, content: ev.message, error: true, streaming: false }))
          }
        },
        ctrl.signal,
      )
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === "AbortError"
      patchLast((m) => ({
        ...m,
        content: aborted
          ? m.content || "Stopped."
          : "Sorry — I hit an error answering that. Please try again in a moment.",
        error: !aborted && !m.content,
        streaming: false,
      }))
    } finally {
      patchLast((m) => ({ ...m, streaming: false }))
      setStreaming(false)
      setStatus(null)
      abortRef.current = null
    }
  }

  function stop() {
    abortRef.current?.abort()
  }

  function newChat() {
    if (streaming) stop()
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
        className="group flex items-end gap-2 rounded-2xl p-2 transition-shadow"
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border-strong)",
          boxShadow: "0 1px 2px rgba(0,0,0,.04), 0 8px 24px -16px rgba(0,0,0,.25)",
        }}
        onFocusCapture={(e) => (e.currentTarget.style.boxShadow = "0 0 0 3px var(--green-subtle), 0 8px 24px -16px rgba(0,0,0,.25)")}
        onBlurCapture={(e) => (e.currentTarget.style.boxShadow = "0 1px 2px rgba(0,0,0,.04), 0 8px 24px -16px rgba(0,0,0,.25)")}
      >
        <textarea
          value={input}
          onChange={(e) => {
            setInput(e.target.value)
            e.target.style.height = "auto"
            e.target.style.height = `${Math.min(e.target.scrollHeight, 176)}px`
          }}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder="Ask about balances, variances, what's blocking close…"
          className="max-h-44 flex-1 resize-none bg-transparent px-2.5 py-2 text-[14px] leading-relaxed outline-none placeholder:opacity-60"
          style={{ color: "var(--text)", outline: "none", border: "none", boxShadow: "none", WebkitAppearance: "none" }}
        />
        {streaming ? (
          <button
            onClick={stop}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-colors"
            style={{ background: "var(--surface-2)", color: "var(--text)", border: "1px solid var(--border)" }}
            title="Stop"
            aria-label="Stop generating"
          >
            <Square size={15} strokeWidth={2.4} fill="currentColor" />
          </button>
        ) : (
          <button
            onClick={() => void send(input)}
            disabled={!input.trim()}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-opacity disabled:opacity-40"
            style={{ background: "var(--green)", color: "#fff" }}
            title="Send"
            aria-label="Send"
          >
            <ArrowUp size={18} strokeWidth={2.2} />
          </button>
        )}
      </div>
      <p className="mt-2 px-1 text-center text-[11px]" style={{ color: "var(--text-muted)" }}>
        Grounded in your synced data · read-only · never posts to QuickBooks without you.
      </p>
    </div>
  )

  const historyList = !threads?.length ? (
    <p className="px-2 py-3 text-[12.5px]" style={{ color: "var(--text-muted)" }}>
      No conversations yet.
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
          (e.currentTarget.style.background = t.id === threadId ? "var(--surface-2)" : "transparent")
        }
      >
        <Clock size={13} strokeWidth={1.7} className="mt-0.5 shrink-0" style={{ color: "var(--text-muted)" }} />
        <span className="line-clamp-2 text-[12.5px]" style={{ color: "var(--text)" }}>{t.title}</span>
      </button>
    ))
  )

  return (
    <div className="flex h-[calc(100vh-7rem)]">
      {/* ── Left sidebar (desktop): brand · New chat · history (Claude-style) ── */}
      <aside
        className="hidden w-60 shrink-0 flex-col pr-3 md:flex"
        style={{ borderRight: "1px solid var(--border)" }}
      >
        <div className="flex items-center gap-2 px-1 pb-3">
          <div
            className="flex h-7 w-7 items-center justify-center rounded-lg"
            style={{ background: "var(--green-subtle)", color: "var(--green)" }}
          >
            <Sparkles size={15} strokeWidth={1.9} />
          </div>
          <span className="text-[14px] font-semibold" style={{ color: "var(--text)" }}>
            NDVX Copilot
          </span>
        </div>
        <button
          onClick={newChat}
          className="mb-3 flex items-center justify-center gap-2 rounded-xl px-3 py-2 text-[13px] font-medium transition-opacity hover:opacity-90"
          style={{ background: "var(--green)", color: "#fff" }}
        >
          <Plus size={15} strokeWidth={2.2} /> New chat
        </button>
        <div className="px-1 pb-1 text-[11px] font-medium uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
          Recent
        </div>
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">{historyList}</div>
      </aside>

      {/* ── Main pane ── */}
      <div className="flex min-w-0 flex-1 flex-col md:pl-4">
        {/* Mobile top bar: brand · History · New (the sidebar is desktop-only) */}
        <div className="relative mb-1 flex shrink-0 items-center justify-between gap-2 px-1 md:hidden">
          <div className="flex items-center gap-2">
            <div
              className="flex h-7 w-7 items-center justify-center rounded-lg"
              style={{ background: "var(--green-subtle)", color: "var(--green)" }}
            >
              <Sparkles size={15} strokeWidth={1.9} />
            </div>
            <span className="text-[14px] font-semibold" style={{ color: "var(--text)" }}>
              NDVX Copilot
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setHistoryOpen((o) => !o)}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px]"
              style={{ border: "1px solid var(--border)", color: "var(--text-muted)" }}
              title="Recent conversations"
            >
              <History size={15} strokeWidth={1.8} /> History
            </button>
            <button
              onClick={newChat}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium"
              style={{ background: "var(--green)", color: "#fff" }}
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
                  {historyList}
                </div>
              </>
            )}
          </div>
        </div>

        {empty ? (
          /* ── Centered hero ── */
          <div className="relative flex flex-1 flex-col items-center justify-center px-4 pb-10 text-center">
            <div
              aria-hidden
              className="pointer-events-none absolute left-1/2 top-1/2 h-80 w-80 -translate-x-1/2 -translate-y-[62%] rounded-full blur-3xl"
              style={{ background: "var(--green-subtle)", opacity: 0.6 }}
            />
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
              className="relative w-full max-w-2xl"
            >
              <div className="mx-auto mb-5 w-fit">
                <BrandMark />
              </div>
              <h1 className="text-3xl font-semibold tracking-tight sm:text-[2.5rem]" style={{ color: "var(--text)" }}>
                NDVX <span style={{ color: "var(--green)" }}>Copilot</span>
              </h1>
              <p className="mx-auto mt-3 max-w-md text-[14.5px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
                Ask anything about this client's books — answered straight from your real, synced
                data, with the numbers to back it up.
              </p>
              <div className="mt-7">{composer}</div>
              <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {SUGGESTIONS.map(({ icon: Icon, text }) => (
                  <button
                    key={text}
                    onClick={() => void send(text)}
                    className="flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-[13px] transition-all"
                    style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = "var(--surface-2)"
                      e.currentTarget.style.borderColor = "var(--border-strong)"
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "var(--surface)"
                      e.currentTarget.style.borderColor = "var(--border)"
                    }}
                  >
                    <Icon size={15} strokeWidth={1.8} style={{ color: "var(--green)" }} className="shrink-0" />
                    <span className="line-clamp-1">{text}</span>
                  </button>
                ))}
              </div>
            </motion.div>
          </div>
        ) : (
          /* ── Active conversation ── */
          <>
            {/* Full-width scroll area → scrollbar at the far right; messages centered. */}
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto max-w-4xl space-y-5 px-1 pb-4">
                {messages.map((m, i) => (
                  <MessageBubble key={i} msg={m} status={i === messages.length - 1 ? status : null} />
                ))}
                <div ref={bottomRef} />
              </div>
            </div>
            <div className="mx-auto w-full max-w-4xl shrink-0 px-1 pt-1">{composer}</div>
          </>
        )}
      </div>
    </div>
  )
}

function MessageBubble({ msg, status }: { msg: ChatMsg; status: string | null }) {
  const isUser = msg.role === "user"
  const navigate = useNavigate()
  const labels = sourceLabels(msg.sources)
  const [copied, setCopied] = useState(false)

  function copy() {
    void navigator.clipboard?.writeText(msg.content)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  if (isUser) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18 }}
        className="flex justify-end"
      >
        <div
          className="max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[14px] leading-relaxed"
          style={{ background: "var(--green-subtle)", color: "var(--text)", whiteSpace: "pre-wrap" }}
        >
          {msg.content}
        </div>
      </motion.div>
    )
  }

  const showStatus = !!status && !msg.content
  const showThinking = msg.streaming && !msg.content && !status

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className="group flex justify-start gap-2.5"
    >
      <div className="mt-0.5 shrink-0">
        <div
          className="flex h-7 w-7 items-center justify-center rounded-lg"
          style={{ background: "var(--green-subtle)", color: "var(--green)" }}
        >
          <Sparkles size={14} strokeWidth={1.9} />
        </div>
      </div>

      <div className="min-w-0 max-w-[92%]">
        <div
          className="rounded-2xl px-3.5 py-2.5 text-[14px] leading-relaxed"
          style={{
            background: "var(--surface-2)",
            color: msg.error ? "var(--warn)" : "var(--text)",
            border: "1px solid var(--border)",
            whiteSpace: msg.error ? "pre-wrap" : undefined,
          }}
        >
          {showStatus ? (
            <span className="flex items-center gap-2" style={{ color: "var(--text-muted)" }}>
              <Loader2 size={14} className="animate-spin" />
              <span className="text-[13px]">{status}…</span>
            </span>
          ) : showThinking ? (
            <span className="flex items-center gap-1.5" style={{ color: "var(--text-muted)" }}>
              <Dot delay={0} /> <Dot delay={0.15} /> <Dot delay={0.3} />
            </span>
          ) : msg.error ? (
            msg.content
          ) : (
            <div className="inline">
              <Markdown text={msg.content} />
              {msg.streaming && (
                <motion.span
                  className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[2px] rounded-full"
                  style={{ background: "var(--green)" }}
                  animate={{ opacity: [1, 0.2, 1] }}
                  transition={{ duration: 0.9, repeat: Infinity }}
                />
              )}
            </div>
          )}
        </div>

        {/* meta row: sources + copy (copy appears on hover once the answer is done) */}
        {(labels.length > 0 || (!msg.streaming && !msg.error && msg.content)) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 px-1">
            {labels.length > 0 && (
              <span className="text-[10.5px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                Sources
              </span>
            )}
            {labels.map((l) => (
              <span
                key={l}
                className="rounded-full px-2 py-0.5 text-[10.5px] font-medium"
                style={{ background: "var(--info-subtle)", color: "var(--info)" }}
              >
                {l}
              </span>
            ))}
            {!msg.streaming && !msg.error && msg.content && (
              <button
                onClick={copy}
                className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] opacity-0 transition-opacity group-hover:opacity-100"
                style={{ color: "var(--text-muted)" }}
                title="Copy answer"
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
                {copied ? "Copied" : "Copy"}
              </button>
            )}
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
