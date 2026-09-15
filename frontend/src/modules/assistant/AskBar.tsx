/**
 * AskBar — NDVX Copilot, where the question actually occurs.
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
 * ── Three window states ───────────────────────────────────────────────────
 * min   a single branded strip. The Copilot is present and out of the way.
 * dock  the default: chips, the ask field, and the conversation so far.
 * max   the conversation takes the room, for a long answer or a real thread.
 *
 * The choice PERSISTS per user. Someone who keeps it minimized has told us
 * something, and re-expanding on every drawer open would keep overruling them.
 * A conversation in flight suppresses the stored preference for that account
 * only — collapsing a panel mid-answer hides the thing you just asked for.
 *
 * ── Motion ────────────────────────────────────────────────────────────────
 * One heartbeat, from core/motion: FAST for affordances, DEFAULT for content,
 * SLOW for the window moves — the only gestures large enough to deserve being
 * watched. Heights animate on a single expo-out curve so the panel arrives
 * rather than snapping, and `prefers-reduced-motion` drops all of it to a
 * cross-fade without losing a state or a control.
 *
 * Two deliberate product choices, unchanged:
 *  - It never opens on an empty input. Chips come from /subject, which reads
 *    state the drawer already had and makes no model call.
 *  - Nothing runs until someone types or taps. No warming.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { AnimatePresence, motion, useReducedMotion } from "framer-motion"
import {
  ArrowUp, ChevronDown, Maximize2, Minimize2, Minus, Square, X,
} from "lucide-react"

import { MOTION } from "@/core/motion"
import {
  assistantApi,
  type AssistantAction,
  type AssistantChart,
  type AssistantDraft,
  type AssistantLink,
  type CopilotSubject,
} from "@/modules/assistant/api"
import { CopilotMark, CopilotWordmark } from "@/modules/assistant/CopilotMark"
import { Markdown } from "@/modules/assistant/Markdown"

/** Expo-out. Sharp departure, long soft landing — the curve that makes a
 *  panel feel like it arrives under its own weight instead of stopping. Used
 *  across the app's larger moves, so the Copilot shares their timing. */
const GLIDE = [0.22, 1, 0.36, 1] as const

type WindowState = "min" | "dock" | "max"

const STORE_KEY = "ndvx_askbar_state"

/** Conversation height per state. Capped in vh so a long thread never pushes
 *  the drawer's action footer off screen — the footer is how work gets signed,
 *  and the Copilot must never be in front of it. */
const CONV_MAX: Record<WindowState, string> = {
  min:  "0px",
  dock: "min(42vh, 380px)",
  max:  "min(68vh, 720px)",
}

function loadState(): WindowState {
  try {
    const v = localStorage.getItem(STORE_KEY)
    return v === "min" || v === "max" || v === "dock" ? v : "dock"
  } catch {
    return "dock"
  }
}

/** A question carried in the URL.
 *
 *  A subject is `{kind, id, period_end}` — serialisable, which makes it an
 *  ADDRESS rather than just a prop. So the autopilot digest that says "A/R is
 *  out by 14,368" can link to the drawer with the question already asked, a
 *  notification becomes a question instead of a destination, and a reviewer can
 *  send a colleague "look at this and ask why" as one link.
 *
 *  Read from `?ask=` (or the hash, since the recon drawer already addresses
 *  itself with `#acct=`). Consumed once and stripped, so a refresh doesn't
 *  re-ask and burn another answer.
 */
function takeSeededQuestion(subjectId: string): string | null {
  if (typeof window === "undefined") return null
  try {
    const url = new URL(window.location.href)
    const hash = new URLSearchParams(url.hash.replace(/^#/, ""))
    const q = url.searchParams.get("ask") ?? hash.get("ask")
    if (!q) return null
    // Only fire when the link also names the object it meant. Without this, a
    // link to one account would re-ask its question on whatever the user
    // navigated to next.
    const forId = url.searchParams.get("ask_id") ?? hash.get("ask_id")
    if (forId && forId !== subjectId) return null

    url.searchParams.delete("ask")
    url.searchParams.delete("ask_id")
    hash.delete("ask"); hash.delete("ask_id")
    const h = hash.toString()
    history.replaceState(null, "", `${url.pathname}${url.search}${h ? `#${h}` : ""}`)
    return q.slice(0, 500)
  } catch {
    return null
  }
}

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
  /** Shown in the subject chip while /subject resolves, so the header never
   *  renders a nameless pill. */
  fallbackLabel?: string
  /** Deep-link to the full Copilot page carrying this thread onward. */
  onOpenFull?: (seed: string) => void
}

export function AskBar({ subject, fallbackLabel, onOpenFull }: Props) {
  const reduce = useReducedMotion()
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState("")
  const [busy, setBusy]   = useState(false)
  const [win, setWin]     = useState<WindowState>(loadState)
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

  useEffect(() => {
    try { localStorage.setItem(STORE_KEY, win) } catch { /* private mode */ }
  }, [win])

  // A different account is a different question. Reset rather than leaving the
  // previous account's answer sitting under a new heading. The WINDOW state is
  // deliberately kept — it's a preference about the panel, not about the row.
  const key = `${subject.kind}:${subject.id}:${subject.period_end}`
  const lastKey = useRef(key)
  useEffect(() => {
    if (lastKey.current === key) return
    lastKey.current = key
    abortRef.current?.abort()
    setTurns([]); setInput(""); setBusy(false)
    threadRef.current = null
  }, [key])

  useEffect(() => () => abortRef.current?.abort(), [])

  // Follow the answer as it streams, but never yank the page for a user who
  // asked not to be moved.
  useEffect(() => {
    if (!turns.length || win === "min") return
    bottomRef.current?.scrollIntoView({
      behavior: reduce ? "auto" : "smooth", block: "end",
    })
  }, [turns, win, reduce])

  const patchLast = useCallback((fn: (t: Turn) => Turn) => {
    setTurns((prev) => (prev.length ? [...prev.slice(0, -1), fn(prev[prev.length - 1])] : prev))
  }, [])

  const send = useCallback(async (text: string) => {
    const q = text.trim()
    if (!q || busy) return
    // Asking from a minimized panel is a request to see the answer.
    setWin((w) => (w === "min" ? "dock" : w))
    const history = turns.filter((t) => !t.error).map((t) => ({ role: t.role, content: t.content }))
    setTurns((prev) => [...prev,
      { role: "user", content: q },
      { role: "assistant", content: "", streaming: true, step: null },
    ])
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
  }, [busy, turns, subject, patchLast])

  // A question that arrived in the link. Fired once, after /subject has
  // resolved so the answer has its context — and guarded by a ref because
  // StrictMode double-invokes effects and an answer is not free.
  const seeded = useRef(false)
  useEffect(() => {
    if (seeded.current || !ctx) return
    const q = takeSeededQuestion(subject.id)
    if (!q) return
    seeded.current = true
    void send(q)
    // send is intentionally omitted: it closes over `turns`, and re-running
    // this on every turn would re-ask the seeded question mid-conversation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, subject.id])

  const label = ctx?.label ?? fallbackLabel ?? "this account"
  const chips = ctx?.suggestions ?? []
  const open  = win !== "min"

  // Auto-grow the field up to a ceiling, so a long question is readable while
  // typing without the panel walking up the screen.
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 104)}px`
  }, [input])

  const dur = useMemo(() => ({
    win:  reduce ? 0 : MOTION.SLOW,
    body: reduce ? 0 : MOTION.DEFAULT,
    tick: reduce ? 0 : MOTION.FAST,
  }), [reduce])

  return (
    <motion.div
      layout={!reduce}
      transition={{ duration: dur.win, ease: GLIDE }}
      style={{
        borderTop: "1px solid var(--border)",
        background: "var(--bg)",
        // A whisper of lift so the panel reads as sitting above the body it
        // overlays, without a hard shadow line across the drawer.
        boxShadow: open ? "0 -10px 28px -22px rgba(12,38,32,0.45)" : "none",
      }}
    >
      {/* ── Branded header — always present, always the same height ────── */}
      <div
        className="flex items-center gap-2.5 px-5"
        style={{ height: 42, cursor: win === "min" ? "pointer" : "default" }}
        onClick={win === "min" ? () => setWin("dock") : undefined}
        role={win === "min" ? "button" : undefined}
        tabIndex={win === "min" ? 0 : undefined}
        onKeyDown={win === "min" ? (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setWin("dock") }
        } : undefined}
        aria-label={win === "min" ? "Open NDVX Copilot" : undefined}
      >
        {open ? <CopilotWordmark size={19} muted /> : (
          <span className="inline-flex items-center gap-2 min-w-0">
            <CopilotMark size={19} />
            <span className="text-[12px] font-semibold truncate" style={{ color: "var(--text-2)" }}>
              Ask NDVX Copilot about {label}
            </span>
          </span>
        )}

        {/* Subject chip — the panel says what it is about before you ask. */}
        {open && (
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={label}
              initial={{ opacity: 0, y: -3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 3 }}
              transition={{ duration: dur.tick, ease: "easeOut" }}
              className="rounded-md px-2 py-0.5 text-[10.5px] font-mono truncate max-w-[190px]"
              style={{
                background: "var(--surface-2)", border: "1px solid var(--border)",
                color: "var(--text-2)",
              }}
              title={ctx?.headline ?? undefined}
            >
              {label}
            </motion.span>
          </AnimatePresence>
        )}

        {/* Unread marker when collapsed over a live thread. */}
        {!open && turns.length > 0 && (
          <span className="ml-auto inline-flex items-center gap-1.5 text-[10.5px] font-semibold"
            style={{ color: "var(--green)" }}>
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--green)" }} />
            {Math.ceil(turns.length / 2)}
          </span>
        )}

        <div className={`flex items-center gap-0.5 ${!open && turns.length > 0 ? "" : "ml-auto"}`}>
          {/* Maximize only once there is a conversation to give the room to.
              Empty, it toggled state and visibly did nothing — a window control
              that does nothing is worse than not having one. Kept visible while
              already maximized so there is always a way back. */}
          {open && (turns.length > 0 || win === "max") && (
            <WinBtn
              label={win === "max" ? "Restore" : "Maximize"}
              onClick={() => setWin(win === "max" ? "dock" : "max")}
              dur={dur.tick}
            >
              {win === "max"
                ? <Minimize2 size={13} strokeWidth={2} />
                : <Maximize2 size={13} strokeWidth={2} />}
            </WinBtn>
          )}
          <WinBtn
            label={open ? "Minimize" : "Open"}
            onClick={() => setWin(open ? "min" : "dock")}
            dur={dur.tick}
          >
            {open
              ? <Minus size={14} strokeWidth={2.2} />
              : <ChevronDown size={14} strokeWidth={2.2} style={{ transform: "rotate(180deg)" }} />}
          </WinBtn>
        </div>
      </div>

      {/* ── Body — one collapse, so min/dock/max is a single smooth move ── */}
      <motion.div
        initial={false}
        animate={{ height: open ? "auto" : 0, opacity: open ? 1 : 0 }}
        transition={{ duration: dur.win, ease: GLIDE }}
        style={{ overflow: "hidden" }}
      >
        {/* Conversation */}
        <AnimatePresence initial={false}>
          {turns.length > 0 && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: dur.body, ease: "easeOut" }}
              className="px-5 overflow-y-auto flex flex-col gap-4"
              style={{ maxHeight: CONV_MAX[win], paddingBottom: 4 }}
            >
              {turns.map((t, i) =>
                t.role === "user" ? (
                  <motion.div
                    key={i}
                    initial={reduce ? false : { opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: dur.body, ease: GLIDE }}
                    className="self-end max-w-[86%] rounded-2xl rounded-br-md px-3.5 py-2 text-[13px] leading-relaxed"
                    style={{ background: "var(--surface-2)", color: "var(--text)" }}
                  >
                    {t.content}
                  </motion.div>
                ) : (
                  <motion.div
                    key={i}
                    initial={reduce ? false : { opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: dur.body, ease: GLIDE }}
                    className="flex gap-2.5"
                  >
                    <CopilotMark size={20} className="mt-px" />
                    <div className="min-w-0 flex-1 text-[13px] leading-[1.62]"
                      style={{ color: t.error ? "var(--danger)" : "var(--text)" }}>
                      {!t.content && (t.step || t.streaming) && (
                        <Thinking label={t.step ?? "Thinking"} reduce={!!reduce} />
                      )}
                      {t.content && <Markdown text={t.content} />}
                      {!!t.links?.length && (
                        <div className="mt-2.5 flex flex-wrap gap-1.5">
                          {t.links.map((l, li) => (
                            <a key={li} href={l.path}
                              className="rounded-lg px-2.5 py-1 text-[12px] font-medium transition-colors"
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
                  </motion.div>
                ),
              )}
              <div ref={bottomRef} />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Composer */}
        <div className="px-5 pt-3 pb-4">
          {/* Chips only before the thread starts — after that the next question
              comes from what was just said, not from a suggestion computed
              before any of it. They stagger in so the row assembles rather
              than appearing, which is the one place a flourish earns its keep:
              it draws the eye to the thing that makes this usable. */}
          <AnimatePresence initial={false}>
            {!turns.length && chips.length > 0 && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: dur.body, ease: GLIDE }}
                className="flex flex-wrap gap-1.5 overflow-hidden"
                style={{ marginBottom: 10 }}
              >
                {chips.map((c, i) => (
                  <motion.button
                    key={c}
                    initial={reduce ? false : { opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: dur.body, ease: GLIDE, delay: reduce ? 0 : i * 0.045 }}
                    whileHover={reduce ? undefined : { y: -1 }}
                    whileTap={reduce ? undefined : { scale: 0.97 }}
                    onClick={() => void send(c)}
                    disabled={busy}
                    className="rounded-full px-3 py-1.5 text-[11.5px] disabled:opacity-50"
                    style={{
                      background: i === 0 ? "var(--green-subtle)" : "var(--surface)",
                      border: `1px solid ${i === 0 ? "var(--positive-border)" : "var(--border)"}`,
                      color: i === 0 ? "var(--positive)" : "var(--text)",
                      fontWeight: i === 0 ? 650 : 450,
                    }}
                  >
                    {c}
                  </motion.button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>

          <Composer
            inputRef={inputRef}
            value={input}
            onChange={setInput}
            onSubmit={() => void send(input)}
            onStop={() => abortRef.current?.abort()}
            busy={busy}
            placeholder={turns.length ? "Ask a follow-up…" : `Ask about ${label}…`}
            reduce={!!reduce}
            dur={dur.tick}
          />

          <div className="mt-2 flex items-center justify-between gap-3 min-h-[16px]">
            <span className="text-[11px] truncate" style={{ color: "var(--text-muted)" }}>
              {ctx?.headline ?? ""}
            </span>
            <AnimatePresence initial={false}>
              {turns.length > 0 && (
                <motion.div
                  initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                  transition={{ duration: dur.tick }}
                  className="flex items-center gap-2.5 shrink-0"
                >
                  {onOpenFull && (
                    <button onClick={() => onOpenFull(turns[0]?.content ?? "")}
                      className="text-[11px] transition-opacity hover:opacity-70"
                      style={{ color: "var(--text-muted)" }}>
                      Open in Copilot
                    </button>
                  )}
                  <button
                    onClick={() => { setTurns([]); threadRef.current = null }}
                    className="inline-flex items-center gap-1 text-[11px] transition-opacity hover:opacity-70"
                    style={{ color: "var(--text-muted)" }}>
                    <X size={11} /> Clear
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </motion.div>
    </motion.div>
  )
}

// ── Pieces ───────────────────────────────────────────────────────────────────

/** A window control. 24px hit area, no border at rest — chrome you notice only
 *  when you reach for it. */
function WinBtn({
  label, onClick, dur, children,
}: {
  label: string
  onClick: () => void
  dur: number
  children: React.ReactNode
}) {
  return (
    <motion.button
      onClick={onClick}
      title={label}
      aria-label={label}
      whileHover={{ backgroundColor: "var(--surface-2)" }}
      whileTap={{ scale: 0.92 }}
      transition={{ duration: dur, ease: "easeOut" }}
      className="h-6 w-6 rounded-md inline-flex items-center justify-center"
      style={{ color: "var(--text-muted)", background: "transparent" }}
    >
      {children}
    </motion.button>
  )
}

/** Three dots breathing in sequence. A spinner says "blocked"; this says
 *  "working", which is what is actually happening. */
function Thinking({ label, reduce }: { label: string; reduce: boolean }) {
  return (
    <span className="inline-flex items-center gap-2 text-[12px]" style={{ color: "var(--text-muted)" }}>
      <span className="inline-flex items-center gap-[3px]">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="h-[3px] w-[3px] rounded-full"
            style={{ background: "var(--text-muted)" }}
            animate={reduce ? undefined : { opacity: [0.25, 1, 0.25] }}
            transition={reduce ? undefined : {
              duration: 1.15, repeat: Infinity, ease: "easeInOut", delay: i * 0.16,
            }}
          />
        ))}
      </span>
      {label}
    </span>
  )
}

function Composer({
  inputRef, value, onChange, onSubmit, onStop, busy, placeholder, reduce, dur,
}: {
  inputRef: React.RefObject<HTMLTextAreaElement | null>
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  onStop: () => void
  busy: boolean
  placeholder: string
  reduce: boolean
  dur: number
}) {
  const [focus, setFocus] = useState(false)
  return (
    <div
      className="flex items-end gap-2 rounded-xl px-3 py-2 transition-colors"
      style={{
        background: "var(--surface)",
        border: `1px solid ${focus ? "var(--green)" : "var(--border)"}`,
        boxShadow: focus ? "0 0 0 3px color-mix(in srgb, var(--green) 12%, transparent)" : "none",
      }}
    >
      <textarea
        ref={inputRef as React.Ref<HTMLTextAreaElement>}
        rows={1}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSubmit() }
        }}
        placeholder={placeholder}
        className="flex-1 resize-none bg-transparent text-[13px] leading-relaxed outline-none py-1"
        style={{ color: "var(--text)", maxHeight: 104 }}
      />
      <AnimatePresence mode="popLayout" initial={false}>
        {busy ? (
          <motion.button
            key="stop"
            initial={reduce ? false : { opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={reduce ? undefined : { opacity: 0, scale: 0.8 }}
            transition={{ duration: dur, ease: "easeOut" }}
            whileTap={reduce ? undefined : { scale: 0.92 }}
            onClick={onStop}
            title="Stop"
            aria-label="Stop"
            className="shrink-0 h-7 w-7 rounded-lg flex items-center justify-center"
            style={{ background: "var(--surface-2)", color: "var(--text-2)" }}
          >
            <Square size={11} strokeWidth={2.6} />
          </motion.button>
        ) : (
          <motion.button
            key="send"
            initial={reduce ? false : { opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={reduce ? undefined : { opacity: 0, scale: 0.8 }}
            transition={{ duration: dur, ease: "easeOut" }}
            whileTap={reduce ? undefined : { scale: 0.92 }}
            onClick={onSubmit}
            disabled={!value.trim()}
            title="Ask"
            aria-label="Ask"
            className="shrink-0 h-7 w-7 rounded-lg flex items-center justify-center disabled:opacity-30"
            style={{ background: "var(--green)", color: "#fff" }}
          >
            <ArrowUp size={14} strokeWidth={2.5} />
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  )
}
