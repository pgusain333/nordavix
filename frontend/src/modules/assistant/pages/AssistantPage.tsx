/**
 * Client Assistant — "NDVX Copilot".
 *
 * Grounded, tenant-scoped Q&A with conversation memory and propose-only actions
 * (Tier 3). The answer STREAMS in token-by-token over SSE (assistantApi.askStream)
 * so it feels instant; a live status line shows which data it's reading. Empty
 * state is a centered hero with the composer; once a thread starts, messages fill
 * the view and the composer docks at the bottom. Answers render as themed Markdown.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react"
import { useNavigate } from "react-router-dom"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { motion } from "framer-motion"
import {
  Sparkles, ArrowUp, Square, Plus, History, Clock, FileText, ArrowUpRight,
  Copy, Check, Download, Loader2, Play, AlertTriangle, Wallet, Scale, ClipboardList,
  Trash2, X, PanelLeftClose, PanelLeftOpen,
} from "lucide-react"
import {
  assistantApi,
  type AssistantSource,
  type AssistantDraft,
  type AssistantLink,
  type AssistantAction,
  type AssistantChart,
  type AssistantChartPoint,
  type ThreadSummary,
} from "@/modules/assistant/api"
import { Markdown } from "@/modules/assistant/Markdown"
import { reconsApi } from "@/modules/recons/api"
import { api as fluxApi } from "@/modules/flux/api"

interface ChatMsg {
  role: "user" | "assistant"
  content: string
  question?: string // the user question that produced this answer (for export)
  sources?: AssistantSource[] | null
  drafts?: AssistantDraft[]
  links?: AssistantLink[]
  actions?: AssistantAction[]
  charts?: AssistantChart[]
  exportIntent?: "pdf" | "xlsx" | "both" | null // user asked for a downloadable file
  steps?: string[] // chatty progress lines shown while the answer is being worked on
  error?: boolean
  streaming?: boolean
}

function money(s: string | null | undefined): string {
  const n = Number(s ?? 0)
  if (!isFinite(n)) return String(s ?? "")
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** Did the user ask Copilot to make them a file? If so, which format(s)? Drives a
 *  prominent Download button under the answer so a file request always yields a file. */
function detectExportIntent(text: string): "pdf" | "xlsx" | "both" | null {
  const t = text.toLowerCase()
  const action = /\b(creat|mak|generat|export|download|build|produc|prepar)\w*\b|give me|send me|i (need|want)\b/.test(t)
  const pdf = /\bpdf\b/.test(t)
  const xlsx = /\b(excel|spreadsheet|xlsx|workbook|csv)\b|\.xls/.test(t)
  if (pdf && xlsx) return "both"
  if (pdf) return "pdf"
  if (xlsx) return "xlsx"
  if (action && /\b(file|download|export)\b/.test(t)) return "both"
  return null
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
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try { return localStorage.getItem("ndvx_copilot_sidebar") !== "0" } catch { return true }
  })
  const [loadingThreadId, setLoadingThreadId] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const didAutoOpen = useRef(false)
  const instantScroll = useRef(true) // first paint / thread-load jumps; streaming glides

  const { data: threads } = useQuery({
    queryKey: ["assistant-threads"],
    queryFn: assistantApi.listThreads,
    staleTime: 30_000,
  })

  // Keep the answer pinned to the bottom. The first render and any thread load
  // jump instantly (so reopening lands already-scrolled, not animating down);
  // token streaming glides smoothly. useLayoutEffect → no top-then-jump flash.
  useLayoutEffect(() => {
    if (!messages.length) return
    bottomRef.current?.scrollIntoView({ behavior: instantScroll.current ? "auto" : "smooth", block: "end" })
    instantScroll.current = false
  }, [messages])

  // Persist the sidebar show/hide choice across visits.
  useEffect(() => {
    try { localStorage.setItem("ndvx_copilot_sidebar", sidebarOpen ? "1" : "0") } catch { /* ignore */ }
  }, [sidebarOpen])

  // On first open, resume the most recent conversation (already at the bottom),
  // so Copilot feels like returning to where you left off — not a blank restart.
  useEffect(() => {
    if (didAutoOpen.current || !threads) return
    didAutoOpen.current = true
    if (threads.length > 0) void loadThread(threads[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads])

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
      { role: "assistant", content: "", streaming: true, question: q, exportIntent: detectExportIntent(q), steps: [] },
    ])
    setInput("")
    setStreaming(true)
    const ctrl = new AbortController()
    abortRef.current = ctrl

    try {
      await assistantApi.askStream(
        q,
        null,
        history,
        threadId,
        (ev) => {
          if (ev.type === "step") {
            // Accumulate the chatty progress lines while the copilot works.
            patchLast((m) => ({ ...m, steps: [...(m.steps || []), ev.label] }))
          } else if (ev.type === "delta") {
            patchLast((m) => ({ ...m, content: m.content + ev.text }))
          } else if (ev.type === "result") {
            patchLast((m) => ({
              ...m,
              content: ev.answer,
              sources: ev.sources,
              drafts: ev.drafts,
              links: ev.links,
              actions: ev.actions,
              charts: ev.charts,
            }))
          } else if (ev.type === "done") {
            if (ev.thread_id) {
              setThreadId(ev.thread_id)
              // The thread gained a turn — refresh its cached messages for next open.
              void qc.invalidateQueries({ queryKey: ["assistant-thread", ev.thread_id] })
            }
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

  // Warm a thread's messages on hover so the click opens instantly.
  function prefetchThread(id: string) {
    void qc.prefetchQuery({
      queryKey: ["assistant-thread", id],
      queryFn: () => assistantApi.getThread(id),
      staleTime: 60_000,
    })
  }

  async function loadThread(id: string) {
    setHistoryOpen(false)
    instantScroll.current = true // jump to the bottom of the loaded thread, don't animate
    setLoadingThreadId(id)
    try {
      // Cache-first: instant if it was prefetched on hover or opened before.
      const msgs = await qc.fetchQuery({
        queryKey: ["assistant-thread", id],
        queryFn: () => assistantApi.getThread(id),
        staleTime: 60_000,
      })
      setMessages(msgs.map((m) => ({ role: m.role, content: m.content, sources: m.sources })))
      setThreadId(id)
    } catch {
      /* leave current conversation in place on failure */
    } finally {
      setLoadingThreadId(null)
    }
  }

  async function deleteThread(id: string) {
    // Optimistically drop it from the list; restore on failure.
    qc.setQueryData<ThreadSummary[]>(["assistant-threads"], (prev) => prev?.filter((t) => t.id !== id))
    qc.removeQueries({ queryKey: ["assistant-thread", id] })
    try {
      await assistantApi.deleteThread(id)
    } catch {
      void qc.invalidateQueries({ queryKey: ["assistant-threads"] })
      return
    }
    if (id === threadId) {
      setMessages([])
      setThreadId(null)
    }
    void qc.invalidateQueries({ queryKey: ["assistant-threads"] })
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
      <ThreadRow
        key={t.id}
        thread={t}
        active={t.id === threadId}
        loading={loadingThreadId === t.id}
        onOpen={() => void loadThread(t.id)}
        onPrefetch={() => prefetchThread(t.id)}
        onDelete={() => deleteThread(t.id)}
      />
    ))
  )

  return (
    <div className="flex h-[calc(100vh-7rem)]">
      {/* ── Left sidebar (desktop): brand · New chat · history (Claude-style).
           Width + opacity animate so opening/closing glides instead of snapping.
           A fixed-width inner wrapper keeps the content from reflowing as it
           collapses — it's clipped by the outer overflow-hidden instead. ── */}
      <motion.aside
        initial={false}
        animate={{ width: sidebarOpen ? 256 : 0, opacity: sidebarOpen ? 1 : 0 }}
        transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
        className="hidden shrink-0 overflow-hidden md:flex"
      >
        <div
          className="flex h-full w-64 flex-col px-1.5 pr-3.5 pt-1"
          style={{ borderRight: "1px solid var(--border)" }}
        >
          <div className="flex items-center gap-2 px-1 pb-5 pt-1">
            <div
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
              style={{ background: "var(--green-subtle)", color: "var(--green)" }}
            >
              <Sparkles size={15} strokeWidth={1.9} />
            </div>
            <span className="flex-1 text-[14px] font-semibold" style={{ color: "var(--text)" }}>
              NDVX Copilot
            </span>
            <button
              onClick={() => setSidebarOpen(false)}
              className="shrink-0 rounded-md p-1 transition-opacity hover:opacity-80"
              style={{ color: "var(--text-muted)" }}
              title="Hide sidebar"
              aria-label="Hide sidebar"
            >
              <PanelLeftClose size={16} strokeWidth={1.8} />
            </button>
          </div>
          <button
            onClick={newChat}
            className="mb-5 flex items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-[13px] font-medium transition-opacity hover:opacity-90"
            style={{ background: "var(--green)", color: "#fff" }}
          >
            <Plus size={15} strokeWidth={2.2} /> New chat
          </button>
          <div className="px-1 pb-2 text-[11px] font-medium uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
            Recent
          </div>
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-0.5">{historyList}</div>
        </div>
      </motion.aside>

      {/* ── Main pane (always padded on the left so the closed state isn't flush) ── */}
      <div className="flex min-w-0 flex-1 flex-col md:pl-4">
        {/* Desktop: when the sidebar is hidden, a slim bar to bring it back + New chat */}
        {!sidebarOpen && (
          <div className="mb-3 mt-3 hidden items-center gap-1.5 md:flex">
            <button
              onClick={() => setSidebarOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12.5px] transition-colors"
              style={{ border: "1px solid var(--border)", color: "var(--text-muted)" }}
              title="Show sidebar"
              aria-label="Show sidebar"
            >
              <PanelLeftOpen size={16} strokeWidth={1.8} />
            </button>
            <button
              onClick={newChat}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium"
              style={{ background: "var(--green)", color: "#fff" }}
            >
              <Plus size={15} strokeWidth={2} /> New chat
            </button>
          </div>
        )}
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
                  <MessageBubble key={i} msg={m} />
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

/** One row in the Recent list: open on click, with a hover trash that asks for a
 *  quick inline confirm before deleting (so a stray click can't wipe a chat). */
function ThreadRow({
  thread,
  active,
  loading,
  onOpen,
  onPrefetch,
  onDelete,
}: {
  thread: ThreadSummary
  active: boolean
  loading: boolean
  onOpen: () => void
  onPrefetch: () => void
  onDelete: () => Promise<void> | void
}) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  async function confirmDelete() {
    setBusy(true)
    try {
      await onDelete()
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  return (
    <div
      className="group relative flex items-center rounded-lg transition-colors"
      style={{ background: active ? "var(--surface-2)" : "transparent" }}
      onMouseEnter={(e) => { onPrefetch(); e.currentTarget.style.background = "var(--surface-2)" }}
      onMouseLeave={(e) => (e.currentTarget.style.background = active ? "var(--surface-2)" : "transparent")}
    >
      <button
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-start gap-2 rounded-lg px-2 py-2.5 text-left"
      >
        {loading ? (
          <Loader2 size={13} className="mt-0.5 shrink-0 animate-spin" style={{ color: "var(--green)" }} />
        ) : (
          <Clock size={13} strokeWidth={1.7} className="mt-0.5 shrink-0" style={{ color: "var(--text-muted)" }} />
        )}
        <span className="line-clamp-2 text-[12.5px]" style={{ color: "var(--text)" }}>{thread.title}</span>
      </button>
      {confirming ? (
        <div className="flex shrink-0 items-center gap-0.5 pr-1.5">
          <button
            onClick={() => void confirmDelete()}
            disabled={busy}
            className="rounded-md p-1 transition-colors disabled:opacity-60"
            style={{ color: "var(--danger, #dc2626)" }}
            title="Delete this chat"
            aria-label="Confirm delete"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={14} />}
          </button>
          <button
            onClick={() => setConfirming(false)}
            className="rounded-md p-1 transition-colors"
            style={{ color: "var(--text-muted)" }}
            title="Cancel"
            aria-label="Cancel delete"
          >
            <X size={14} />
          </button>
        </div>
      ) : (
        <button
          onClick={() => setConfirming(true)}
          className="mr-1.5 shrink-0 rounded-md p-1 opacity-0 transition-opacity group-hover:opacity-100"
          style={{ color: "var(--text-muted)" }}
          title="Delete chat"
          aria-label="Delete chat"
        >
          <Trash2 size={13} />
        </button>
      )}
    </div>
  )
}

function MessageBubble({ msg }: { msg: ChatMsg }) {
  const isUser = msg.role === "user"
  const navigate = useNavigate()
  const labels = sourceLabels(msg.sources)
  const [copied, setCopied] = useState(false)
  const [exporting, setExporting] = useState<"pdf" | "xlsx" | null>(null)

  function copy() {
    void navigator.clipboard?.writeText(msg.content)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  async function doExport(format: "pdf" | "xlsx") {
    if (exporting) return
    setExporting(format)
    try {
      await assistantApi.exportAnswer(format, msg.question || "", msg.content, msg.charts || [])
    } catch {
      /* best-effort; the button just re-enables on failure */
    } finally {
      setExporting(null)
    }
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

  const steps = msg.steps ?? []
  const working = !!msg.streaming && !msg.content && !msg.error
  const showSteps = working && steps.length > 0
  const showThinking = working && steps.length === 0

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
          {showSteps ? (
            <div className="flex flex-col gap-1.5">
              {steps.map((s, i) => {
                const last = i === steps.length - 1
                return (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, y: 2 }}
                    animate={{ opacity: last ? 1 : 0.55, y: 0 }}
                    transition={{ duration: 0.2 }}
                    className="flex items-center gap-2 text-[13px]"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {last ? (
                      <Loader2 size={13} className="shrink-0 animate-spin" />
                    ) : (
                      <Check size={13} className="shrink-0" style={{ color: "var(--green)" }} />
                    )}
                    <span>{s}</span>
                  </motion.div>
                )
              })}
            </div>
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

        {/* The user asked for a file → a prominent Download right under the answer. */}
        {!msg.streaming && !msg.error && msg.content && msg.exportIntent && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {(msg.exportIntent === "xlsx" || msg.exportIntent === "both") && (
              <button
                onClick={() => void doExport("xlsx")}
                disabled={!!exporting}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-[12.5px] font-medium transition-opacity hover:opacity-90 disabled:opacity-60"
                style={{ background: "var(--green)", color: "#fff" }}
              >
                {exporting === "xlsx" ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                Download Excel
              </button>
            )}
            {(msg.exportIntent === "pdf" || msg.exportIntent === "both") && (
              <button
                onClick={() => void doExport("pdf")}
                disabled={!!exporting}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-[12.5px] font-medium transition-opacity hover:opacity-90 disabled:opacity-60"
                style={
                  msg.exportIntent === "both"
                    ? { border: "1px solid var(--green)", color: "var(--green)" }
                    : { background: "var(--green)", color: "#fff" }
                }
              >
                {exporting === "pdf" ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                Download PDF
              </button>
            )}
          </div>
        )}

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
              <div className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  onClick={copy}
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] transition-colors"
                  style={{ color: "var(--text-muted)" }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  title="Copy answer"
                >
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                  {copied ? "Copied" : "Copy"}
                </button>
                <button
                  onClick={() => void doExport("pdf")}
                  disabled={!!exporting}
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] transition-colors disabled:opacity-60"
                  style={{ color: "var(--text-muted)" }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  title="Download this answer as a branded PDF"
                >
                  {exporting === "pdf" ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                  PDF
                </button>
                <button
                  onClick={() => void doExport("xlsx")}
                  disabled={!!exporting}
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] transition-colors disabled:opacity-60"
                  style={{ color: "var(--text-muted)" }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  title="Download this answer as Excel"
                >
                  {exporting === "xlsx" ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                  Excel
                </button>
              </div>
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

        {msg.actions?.map((a, ai) => (
          <ActionChip key={ai} action={a} />
        ))}

        {msg.charts?.map((c, ci) => (
          <ChartView key={ci} chart={c} />
        ))}
      </div>
    </motion.div>
  )
}

function ActionChip({ action }: { action: AssistantAction }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [phase, setPhase] = useState<"idle" | "running" | "done" | "error">("idle")
  const [summary, setSummary] = useState("")

  const reviewPath =
    action.kind === "prepare_reconciliations"
      ? "/app/reconciliations"
      : action.tb_id
        ? `/app/flux/${action.tb_id}`
        : "/app/flux"

  async function run() {
    if (phase === "running") return
    // Flux with no analysis yet → route to the create flow (the page auto-creates).
    if (action.kind === "prepare_flux" && !action.tb_id) {
      navigate(`/app/flux/analyses?new=1&period=${action.period_end}`)
      return
    }
    setPhase("running")
    try {
      if (action.kind === "prepare_reconciliations") {
        const r = action.qbo_account_id
          ? await reconsApi.runAgenticPrepForAccount(action.period_end, action.qbo_account_id)
          : await reconsApi.runAgenticPrep(action.period_end)
        setSummary(`${r.prepared} prepared · ${r.analyzed} analyzed${r.failed ? ` · ${r.failed} failed` : ""}`)
        void qc.invalidateQueries({ queryKey: ["recons-overview", action.period_end] })
        void qc.invalidateQueries({ queryKey: ["period-tracker"] })
        void qc.invalidateQueries({ queryKey: ["adjustments"] })
      } else {
        const r = await fluxApi.runAgenticFlux(action.tb_id!)
        setSummary(`${r.processed} explained${r.failed ? ` · ${r.failed} failed` : ""}`)
        void qc.invalidateQueries({ queryKey: ["variances", action.tb_id] })
        void qc.invalidateQueries({ queryKey: ["trial-balances"] })
      }
      setPhase("done")
    } catch {
      setPhase("error")
    }
  }

  return (
    <div className="mt-2 rounded-xl p-3" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      {phase === "done" ? (
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-[12.5px]" style={{ color: "var(--text)" }}>
            <Check size={14} style={{ color: "var(--green)" }} /> {summary || "Prepared"}
          </span>
          <button
            onClick={() => navigate(reviewPath)}
            className="inline-flex shrink-0 items-center gap-1 text-[12px] font-medium"
            style={{ color: "var(--green)" }}
          >
            Review <ArrowUpRight size={13} />
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2">
          <span className="text-[12.5px]" style={{ color: "var(--text)" }}>{action.label}</span>
          <button
            onClick={() => void run()}
            disabled={phase === "running"}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-opacity disabled:opacity-60"
            style={{ background: "var(--green)", color: "#fff" }}
          >
            {phase === "running" ? (
              <><Loader2 size={13} className="animate-spin" /> Preparing…</>
            ) : phase === "error" ? (
              "Retry"
            ) : (
              <><Play size={13} /> Run</>
            )}
          </button>
        </div>
      )}
      <p className="mt-1.5 text-[11px]" style={{ color: "var(--text-muted)" }}>
        Prepares only — a human still approves. Nothing posts to QuickBooks.
      </p>
    </div>
  )
}

// ── Charts (hand-rolled SVG, theme-aware, no chart-lib dependency) ──
const CHART_COLORS = ["var(--green)", "#5DCAA5", "#888780", "#B4B2A9", "#0F6E56", "#D3D1C7"]

function fmtNum(v: number, unit?: string): string {
  if (unit === "%") return `${Math.round(v * 10) / 10}%`
  const u = unit || ""
  const a = Math.abs(v)
  if (a >= 1_000_000) return `${u}${(v / 1_000_000).toFixed(1)}M`
  if (a >= 1_000) return `${u}${(v / 1_000).toFixed(1)}K`
  return `${u}${Math.round(v * 100) / 100}`
}

function ChartView({ chart }: { chart: AssistantChart }) {
  const data = (chart.data || []).slice(0, 24)
  if (!data.length) return null
  return (
    <div className="mt-2 rounded-xl p-3" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      {chart.title && (
        <div className="mb-2.5 text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
          {chart.title}
        </div>
      )}
      {chart.type === "pie" ? (
        <PieChart data={data} />
      ) : chart.type === "line" ? (
        <LineChart data={data} />
      ) : (
        <BarChart data={data} unit={chart.unit} />
      )}
    </div>
  )
}

function BarChart({ data, unit }: { data: AssistantChartPoint[]; unit?: string }) {
  const max = Math.max(...data.map((d) => Math.abs(d.value)), 1)
  return (
    <div className="flex flex-col gap-2">
      {data.map((d, i) => (
        <div key={i} className="grid items-center gap-2" style={{ gridTemplateColumns: "minmax(80px, 34%) 1fr auto" }}>
          <span className="truncate text-[12px]" style={{ color: "var(--text-muted)" }}>{d.label}</span>
          <span className="relative block h-3.5 overflow-hidden rounded" style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
            <span className="absolute inset-y-0 left-0 rounded" style={{ width: `${Math.max(2, Math.round((Math.abs(d.value) / max) * 100))}%`, background: "var(--green)" }} />
          </span>
          <span className="min-w-[52px] text-right text-[12px] font-semibold tabular-nums" style={{ color: "var(--text)" }}>{fmtNum(d.value, unit)}</span>
        </div>
      ))}
    </div>
  )
}

function PieChart({ data }: { data: AssistantChartPoint[] }) {
  const total = data.reduce((s, d) => s + Math.max(0, d.value), 0) || 1
  const C = 60, R = 54
  let angle = -90
  const slices = data.map((d, i) => {
    const frac = Math.max(0, d.value) / total
    const start = angle
    const end = angle + frac * 360
    angle = end
    const large = end - start > 180 ? 1 : 0
    const pt = (deg: number): [number, number] => [
      C + R * Math.cos((Math.PI / 180) * deg),
      C + R * Math.sin((Math.PI / 180) * deg),
    ]
    const [x1, y1] = pt(start)
    const [x2, y2] = pt(end)
    return {
      path: `M ${C} ${C} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${R} ${R} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`,
      color: CHART_COLORS[i % CHART_COLORS.length],
      label: d.label,
      pct: Math.round(frac * 100),
    }
  })
  return (
    <div className="flex items-center gap-4">
      <svg viewBox="0 0 120 120" width={120} height={120} className="shrink-0">
        {slices.length === 1 ? (
          <circle cx={C} cy={C} r={R} fill={slices[0].color} />
        ) : (
          slices.map((s, i) => <path key={i} d={s.path} fill={s.color} stroke="var(--surface)" strokeWidth={1} />)
        )}
      </svg>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {slices.map((s, i) => (
          <div key={i} className="flex items-center gap-2 text-[12px]">
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: s.color }} />
            <span className="truncate" style={{ color: "var(--text)" }}>{s.label}</span>
            <span className="ml-auto shrink-0 tabular-nums" style={{ color: "var(--text-muted)" }}>{s.pct}%</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function LineChart({ data }: { data: AssistantChartPoint[] }) {
  const W = 320, H = 110, pad = 10
  const vals = data.map((d) => d.value)
  const max = Math.max(...vals)
  const min = Math.min(...vals, 0)
  const range = max - min || 1
  const n = data.length
  const x = (i: number) => pad + (n <= 1 ? (W - 2 * pad) / 2 : (i / (n - 1)) * (W - 2 * pad))
  const y = (v: number) => H - pad - ((v - min) / range) * (H - 2 * pad)
  const pts = data.map((d, i) => `${x(i).toFixed(1)},${y(d.value).toFixed(1)}`).join(" ")
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none">
        <polyline points={pts} fill="none" stroke="var(--green)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        {data.map((d, i) => <circle key={i} cx={x(i)} cy={y(d.value)} r={2.5} fill="var(--green)" />)}
      </svg>
      <div className="mt-1 flex justify-between gap-2 text-[10.5px]" style={{ color: "var(--text-muted)" }}>
        <span className="truncate">{data[0]?.label}</span>
        {n > 2 && <span className="truncate">{data[Math.floor((n - 1) / 2)]?.label}</span>}
        <span className="truncate">{data[n - 1]?.label}</span>
      </div>
    </div>
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
