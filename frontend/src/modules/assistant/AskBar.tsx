/**
 * AskBar — the Copilot, where the question actually occurs.
 *
 * The Copilot lives on its own page, so asking about the account already on
 * your screen meant leaving it, retyping which account and which month, and
 * waiting while the model rediscovered what had been rendered a second ago.
 * That round trip — six seconds and a paragraph of typing — is enough that
 * people don't bother, and a copilot nobody asks is an expensive tab.
 *
 * This mounts at the bottom of a detail view and carries the `subject` with
 * the question, so the model starts the turn already knowing the account, the
 * period, the balance, the variance and the status. The obvious questions cost
 * ZERO tool calls.
 *
 * Two deliberate choices:
 *
 *  - It never opens on an empty input. The chips come from `/subject`, which
 *    is derived from state the drawer already had and costs no model call. An
 *    assistant that shows a blinking cursor is the one people learn to ignore.
 *
 *  - Nothing runs until someone types or taps. No warming, no speculative
 *    answer — a live assistant on every drawer would multiply spend on
 *    questions nobody asked.
 *
 * One component for every surface that will mount it (flux variance, risk
 * finding, adjustment). Only the subject kind changes.
 */
import { useEffect, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { AnimatePresence, motion } from "framer-motion"
import { ArrowUp, Loader2, Sparkles, Square, X } from "lucide-react"

import {
  assistantApi,
  type AssistantAction,
  type AssistantChart,
  type AssistantDraft,
  type AssistantLink,
  type CopilotSubject,
} from "@/modules/assistant/api"
import { Markdown } from "@/modules/assistant/Markdown"

interface Turn {
  role:    "user" | "assistant"
  content: string
  streaming?: boolean
  step?:      string | null
  drafts?:    AssistantDraft[]
  links?:     AssistantLink[]
  actions?:   AssistantAction[]
  charts?:    AssistantChart[]
  error?:     boolean
}

interface Props {
  subject: CopilotSubject
  /** Shown in the subject chip while /subject is still resolving, so the bar
   *  never renders a nameless pill. */
  fallbackLabel?: string
  /** Deep-link to the full Copilot page carrying this conversation onward. */
  onOpenFull?: (seed: string) => void
}

export function AskBar({ subject, fallbackLabel, onOpenFull }: Props) {
  const [turns, setTurns]   = useState<Turn[]>([])
  const [input, setInput]   = useState("")
  const [busy, setBusy]     = useState(false)
  const [open, setOpen]     = useState(false)   // has the user engaged at all
  const inputRef  = useRef<HTMLTextAreaElement>(null)
  const abortRef  = useRef<AbortController | null>(null)
  const threadRef = useRef<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  // The opening state: label, where the account stands, and the questions
  // worth asking. No model call — see the endpoint's docstring.
  const { data: ctx } = useQuery({
    queryKey: ["copilot-subject", subject.kind, subject.id, subject.period_end],
    queryFn:  () => assistantApi.subjectContext(subject),
    staleTime: 60_000,
  })

  // Switching to a different account is a different question. Reset rather
  // than letting the previous account's answer sit under a new heading.
  const key = `${subject.kind}:${subject.id}:${subject.period_end}`
  const lastKey = useRef(key)
  useEffect(() => {
    if (lastKey.current === key) return
    lastKey.current = key
    abortRef.current?.abort()
    setTurns([]); setInput(""); setBusy(false); setOpen(false)
    threadRef.current = null
  }, [key])

  useEffect(() => () => abortRef.current?.abort(), [])

  useEffect(() => {
    if (turns.length) bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [turns])

  function patchLast(fn: (t: Turn) => Turn) {
    setTurns((prev) => (prev.length ? [...prev.slice(0, -1), fn(prev[prev.length - 1])] : prev))
  }

  async function send(text: string) {
    const q = text.trim()
    if (!q || busy) return
    setOpen(true)
    const history = turns.filter((t) => !t.error).map((t) => ({ role: t.role, content: t.content }))
    setTurns((prev) => [...prev, { role: "user", content: q },
                                 { role: "assistant", content: "", streaming: true, step: null }])
    setInput("")
    setBusy(true)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      await assistantApi.askStream(
        q, subject.period_end, history, threadRef.current,
        (ev) => {
          if (ev.type === "step") patchLast((t) => ({ ...t, step: ev.label }))
          else if (ev.type === "delta") patchLast((t) => ({ ...t, content: t.content + ev.text }))
          else if (ev.type === "reset") patchLast((t) => ({ ...t, content: "" }))
          else if (ev.type === "result") {
            patchLast((t) => ({
              ...t, content: ev.answer, step: null,
              drafts: ev.drafts, links: ev.links, actions: ev.actions, charts: ev.charts,
            }))
          } else if (ev.type === "done") {
            threadRef.current = ev.thread_id
          } else if (ev.type === "error") {
            patchLast((t) => ({ ...t, content: ev.message, error: true, step: null }))
          }
        },
        ctrl.signal,
        undefined,
        subject,               // ← the whole point
      )
    } catch (e) {
      if ((e as Error)?.name !== "AbortError") {
        patchLast((t) => ({
          ...t,
          content: "That didn't go through. Try again, or open the full Copilot.",
          error: true, step: null,
        }))
      }
    } finally {
      setBusy(false)
      patchLast((t) => ({ ...t, streaming: false }))
    }
  }

  const label = ctx?.label ?? fallbackLabel ?? "this account"
  const chips = ctx?.suggestions ?? []

  return (
    <div style={{ borderTop: "1px solid var(--border)", background: "var(--bg)" }}>
      {/* ── Conversation ─────────────────────────────────────────────── */}
      <AnimatePresence initial={false}>
        {open && turns.length > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            style={{ overflow: "hidden" }}
          >
            <div className="px-4 pt-3 pb-1 max-h-[46vh] overflow-y-auto flex flex-col gap-3">
              {turns.map((t, i) =>
                t.role === "user" ? (
                  <div key={i} className="self-end max-w-[85%] rounded-xl rounded-br-sm px-3 py-1.5 text-[13px]"
                    style={{ background: "var(--surface-2)", color: "var(--text)" }}>
                    {t.content}
                  </div>
                ) : (
                  <div key={i} className="text-[13px] leading-relaxed"
                    style={{ color: t.error ? "var(--danger)" : "var(--text)" }}>
                    {t.step && !t.content && (
                      <span className="inline-flex items-center gap-1.5 text-[12px]"
                        style={{ color: "var(--text-muted)" }}>
                        <Loader2 size={12} className="animate-spin" /> {t.step}
                      </span>
                    )}
                    {t.content && <Markdown text={t.content} />}
                    {t.streaming && !t.content && !t.step && (
                      <span className="inline-flex items-center gap-1.5 text-[12px]"
                        style={{ color: "var(--text-muted)" }}>
                        <Loader2 size={12} className="animate-spin" /> Thinking…
                      </span>
                    )}
                    {!!t.links?.length && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {t.links.map((l, li) => (
                          <a key={li} href={l.path}
                            className="rounded-lg px-2.5 py-1 text-[12px] font-medium"
                            style={{ border: "1px solid var(--border)", color: "var(--text)" }}>
                            {l.label}
                          </a>
                        ))}
                      </div>
                    )}
                    {!!t.drafts?.length && (
                      <p className="mt-2 text-[12px]" style={{ color: "var(--text-muted)" }}>
                        Drafted {t.drafts.length === 1 ? "an entry" : `${t.drafts.length} entries`} —
                        waiting in Adjustments for a reviewer.
                      </p>
                    )}
                  </div>
                ),
              )}
              <div ref={bottomRef} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Bar ──────────────────────────────────────────────────────── */}
      <div className="px-4 py-3">
        {/* Chips only before the conversation starts — once there are turns,
            the next question comes from what was just said, not from a
            suggestion computed before any of it. */}
        {!turns.length && chips.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {chips.map((c, i) => (
              <button key={i} onClick={() => void send(c)} disabled={busy}
                className="rounded-full px-2.5 py-1 text-[11.5px] transition-colors disabled:opacity-50"
                style={{
                  background: "var(--surface)",
                  border: `1px solid ${i === 0 ? "var(--green)" : "var(--border)"}`,
                  color: i === 0 ? "var(--green)" : "var(--text)",
                  fontWeight: i === 0 ? 600 : 400,
                }}>
                {c}
              </button>
            ))}
          </div>
        )}

        <div className="flex items-end gap-2 rounded-xl px-2.5 py-2"
          style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
          <Sparkles size={15} strokeWidth={1.9} className="shrink-0 mb-1"
            style={{ color: "var(--green)" }} />
          <span className="shrink-0 mb-1 rounded px-1.5 py-px text-[10.5px] font-mono truncate max-w-[180px]"
            style={{ background: "var(--surface-2)", border: "1px solid var(--border)",
                     color: "var(--text-2)" }}
            title={ctx?.headline ?? undefined}>
            {label}
          </span>
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(input) }
            }}
            placeholder={turns.length ? "Ask a follow-up…" : `Ask about ${label}…`}
            className="flex-1 resize-none bg-transparent text-[13px] outline-none py-1 max-h-24"
            style={{ color: "var(--text)" }}
          />
          {busy ? (
            <button onClick={() => abortRef.current?.abort()}
              className="shrink-0 h-7 w-7 rounded-lg flex items-center justify-center"
              style={{ background: "var(--surface-2)", color: "var(--text-2)" }}
              title="Stop">
              <Square size={12} strokeWidth={2.4} />
            </button>
          ) : (
            <button onClick={() => void send(input)} disabled={!input.trim()}
              className="shrink-0 h-7 w-7 rounded-lg flex items-center justify-center disabled:opacity-35"
              style={{ background: "var(--green)", color: "#fff" }}
              title="Ask">
              <ArrowUp size={14} strokeWidth={2.4} />
            </button>
          )}
        </div>

        <div className="mt-1.5 flex items-center justify-between gap-3">
          <span className="text-[11px] truncate" style={{ color: "var(--text-muted)" }}>
            {ctx?.headline ?? " "}
          </span>
          {turns.length > 0 && (
            <div className="flex items-center gap-2 shrink-0">
              {onOpenFull && (
                <button onClick={() => onOpenFull(turns[0]?.content ?? "")}
                  className="text-[11px] underline-offset-2 hover:underline"
                  style={{ color: "var(--text-muted)" }}>
                  Open in Copilot
                </button>
              )}
              <button onClick={() => { setTurns([]); setOpen(false); threadRef.current = null }}
                className="inline-flex items-center gap-1 text-[11px]"
                style={{ color: "var(--text-muted)" }}>
                <X size={11} /> Clear
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
