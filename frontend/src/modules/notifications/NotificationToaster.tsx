/**
 * NotificationToaster — transient toast pop-ups for newly-arrived notifications.
 *
 * Mounted once in the app shell (ThreePaneLayout), next to NotificationsPanel.
 * It polls the same notifications list the bell/panel use, detects genuinely-NEW
 * unread items, and slides each one in at the bottom-right corner; each toast
 * auto-fades after a few seconds (pause-on-hover so it's readable/clickable).
 * The bell + panel remain the persistent record — this is just the live nudge.
 *
 * Design notes:
 *   - On first load (and on org switch) we SEED the seen-set from whatever's
 *     already there and DON'T toast it — only things that arrive afterwards pop.
 *   - Clicking a toast marks it read + follows its link (same as the panel row).
 *   - Shares the ["notifications","list"] query cache, so opening the panel is
 *     instant (data's already warm) and mark-all-read clears everything together.
 */
import { useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useOrganization } from "@clerk/clerk-react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { AnimatePresence, motion } from "framer-motion"
import { Bell, X } from "lucide-react"
import { notificationsApi, type NotificationItem } from "./api"

interface Toast {
  id:    string
  title: string
  body:  string | null
  link:  string | null
}

const AUTO_DISMISS_MS = 6000   // how long a toast lingers before fading out
const MAX_VISIBLE = 4          // cap the stack so a burst doesn't fill the screen

export function NotificationToaster() {
  const { organization } = useOrganization()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [toasts, setToasts] = useState<Toast[]>([])

  // IDs we've already accounted for. `null` until the first successful load, so
  // we can seed it (and skip toasting the pre-existing backlog).
  const seenRef = useRef<Set<string> | null>(null)

  // Re-seed when the active workspace changes — otherwise switching orgs would
  // toast the new workspace's entire backlog as if it were brand-new.
  useEffect(() => {
    seenRef.current = null
    setToasts([])
  }, [organization?.id])

  const { data } = useQuery({
    queryKey: ["notifications", "list"],
    queryFn:  () => notificationsApi.list(30),
    enabled:  !!organization,
    // Poll on the same cadence as the bell's unread count so toasts track live
    // workspace activity. Tab-hidden polling pauses (RQ default), so we don't
    // pop a pile of toasts the moment the user tabs back.
    refetchInterval: 45_000,
    staleTime: 30_000,
  })

  useEffect(() => {
    const items: NotificationItem[] = data?.items ?? []
    if (seenRef.current === null) {
      // First load for this workspace — remember what's here, toast nothing.
      seenRef.current = new Set(items.map((i) => i.id))
      return
    }
    const fresh = items.filter((i) => !seenRef.current!.has(i.id) && !i.read)
    if (fresh.length === 0) return
    fresh.forEach((i) => seenRef.current!.add(i.id))
    // API returns newest-first; reverse so the newest ends up at the bottom of
    // the stack (closest to the corner), then cap the visible count.
    const add: Toast[] = fresh
      .slice()
      .reverse()
      .map((i) => ({ id: i.id, title: i.title, body: i.body, link: i.link }))
    setToasts((prev) => [...prev, ...add].slice(-MAX_VISIBLE))
  }, [data])

  function dismiss(id: string) {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }

  async function activate(t: Toast) {
    try { await notificationsApi.markRead([t.id]) } catch { /* best-effort */ }
    qc.invalidateQueries({ queryKey: ["notifications"] })
    dismiss(t.id)
    if (t.link) navigate(t.link)
  }

  if (toasts.length === 0) return null

  return (
    <div
      className="fixed bottom-4 right-4 z-[90] flex flex-col gap-2 pointer-events-none"
      role="status"
      aria-live="polite"
    >
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <ToastCard
            key={t.id}
            toast={t}
            onActivate={() => activate(t)}
            onDismiss={() => dismiss(t.id)}
          />
        ))}
      </AnimatePresence>
    </div>
  )
}

function ToastCard({
  toast, onActivate, onDismiss,
}: {
  toast: Toast
  onActivate: () => void
  onDismiss: () => void
}) {
  // Auto-dismiss after a few seconds, but pause while hovered so the user can
  // actually read + click it. A ref keeps the latest onDismiss without
  // restarting the timer on every parent render.
  const dismissRef = useRef(onDismiss)
  dismissRef.current = onDismiss
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function start() {
    stop()
    timerRef.current = setTimeout(() => dismissRef.current(), AUTO_DISMISS_MS)
  }
  function stop() {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
  }

  useEffect(() => {
    start()
    return stop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const clickable = !!toast.link

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 80 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 40 }}
      transition={{ duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
      onMouseEnter={stop}
      onMouseLeave={start}
      className="pointer-events-auto w-80 max-w-[calc(100vw-2rem)] rounded-xl p-3 flex gap-3"
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border-strong)",
        boxShadow: "0 12px 32px -8px rgba(0,0,0,0.35), 0 4px 10px -4px rgba(0,0,0,0.20)",
      }}
    >
      <span
        className="mt-0.5 h-7 w-7 rounded-lg inline-flex items-center justify-center shrink-0"
        style={{ background: "var(--green-subtle)", color: "var(--green)" }}
      >
        <Bell size={14} strokeWidth={1.9} />
      </span>

      <button
        type="button"
        onClick={onActivate}
        className="min-w-0 flex-1 text-left"
        style={{ cursor: clickable ? "pointer" : "default" }}
      >
        <span className="block text-sm font-semibold truncate" style={{ color: "var(--text)" }}>
          {toast.title}
        </span>
        {toast.body && (
          <span className="block text-xs mt-0.5 leading-snug line-clamp-2" style={{ color: "var(--text-muted)" }}>
            {toast.body}
          </span>
        )}
        {clickable && (
          <span className="block text-[10px] mt-1 font-semibold uppercase tracking-wide" style={{ color: "var(--green)" }}>
            View →
          </span>
        )}
      </button>

      <button
        type="button"
        onClick={onDismiss}
        className="h-6 w-6 rounded-md inline-flex items-center justify-center shrink-0 transition-colors"
        style={{ color: "var(--text-muted)" }}
        aria-label="Dismiss notification"
      >
        <X size={14} strokeWidth={1.9} />
      </button>
    </motion.div>
  )
}
