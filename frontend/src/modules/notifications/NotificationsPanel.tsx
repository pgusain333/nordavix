/**
 * NotificationsPanel — right-side slide-in list of in-app notifications.
 *
 * Mounted once in the app shell (ThreePaneLayout). Opens when any control
 * dispatches the `nordavix:open-notifications` window event (the bell). Loads
 * the list lazily on open, lets the user mark all read, and clicking an item
 * marks it read and follows its link. Theme-aware; Esc / backdrop closes.
 */
import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { motion, AnimatePresence } from "framer-motion"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Bell, X, CheckCheck } from "lucide-react"
import { formatDate } from "@/core/lib/dates"
import { notificationsApi, NOTIF_EVENT, type NotificationItem } from "./api"

/** Compact "2h ago" / "3d ago" relative time, falling back to a short date. */
function timeAgo(iso: string): string {
  if (!iso) return ""
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ""
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (secs < 60) return "just now"
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d ago`
  return formatDate(iso)
}

export function NotificationsPanel() {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const qc = useQueryClient()

  // Open on the window event (bell click, anywhere).
  useEffect(() => {
    function onOpen() { setOpen(true) }
    window.addEventListener(NOTIF_EVENT, onOpen)
    return () => window.removeEventListener(NOTIF_EVENT, onOpen)
  }, [])

  // Esc closes while open.
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setOpen(false) }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open])

  const { data, isLoading } = useQuery({
    queryKey: ["notifications", "list"],
    queryFn:  () => notificationsApi.list(30),
    enabled:  open,
    refetchOnWindowFocus: false,
  })

  const items: NotificationItem[] = data?.items ?? []
  const unread = data?.unread ?? 0

  async function markAll() {
    try { await notificationsApi.markRead() } catch { /* best-effort */ }
    qc.invalidateQueries({ queryKey: ["notifications"] })
  }

  async function onItem(n: NotificationItem) {
    if (!n.read) {
      try { await notificationsApi.markRead([n.id]) } catch { /* best-effort */ }
      qc.invalidateQueries({ queryKey: ["notifications"] })
    }
    if (n.link) {
      setOpen(false)
      navigate(n.link)
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.14 }}
          className="fixed inset-0 z-[100] flex justify-end"
          style={{ background: "rgba(0,0,0,0.40)", backdropFilter: "blur(2px)" }}
          onClick={() => setOpen(false)}
        >
          <motion.div
            initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }}
            transition={{ duration: 0.26, ease: [0.32, 0.72, 0, 1] }}
            onClick={(e) => e.stopPropagation()}
            className="h-full w-full max-w-sm flex flex-col"
            style={{ background: "var(--surface)", borderLeft: "1px solid var(--border-strong)", boxShadow: "-24px 0 60px -12px rgba(0,0,0,0.45)" }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 shrink-0"
              style={{ borderBottom: "1px solid var(--border)" }}>
              <div className="flex items-center gap-2">
                <Bell size={16} strokeWidth={1.8} style={{ color: "var(--text)" }} />
                <span className="text-sm font-semibold" style={{ color: "var(--text)" }}>Notifications</span>
                {unread > 0 && (
                  <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] rounded-full px-1.5 text-[10px] font-bold tabular-nums"
                    style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
                    {unread > 99 ? "99+" : unread}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                {unread > 0 && (
                  <button
                    onClick={markAll}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors"
                    style={{ color: "var(--text-muted)" }}
                    title="Mark all as read"
                  >
                    <CheckCheck size={13} strokeWidth={1.9} /> Mark all read
                  </button>
                )}
                <button
                  onClick={() => setOpen(false)}
                  className="flex items-center justify-center h-7 w-7 rounded-md transition-colors"
                  style={{ color: "var(--text-muted)" }}
                  aria-label="Close"
                >
                  <X size={16} strokeWidth={1.8} />
                </button>
              </div>
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto">
              {isLoading && (
                <p className="px-4 py-8 text-center text-sm" style={{ color: "var(--text-muted)" }}>Loading…</p>
              )}
              {!isLoading && items.length === 0 && (
                <div className="px-6 py-16 text-center">
                  <Bell size={28} strokeWidth={1.4} className="mx-auto mb-3" style={{ color: "var(--text-muted)", opacity: 0.5 }} />
                  <p className="text-sm font-medium" style={{ color: "var(--text)" }}>You're all caught up</p>
                  <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
                    Closes, reopens, and other workspace activity will show up here.
                  </p>
                </div>
              )}
              {!isLoading && items.map((n) => {
                const clickable = !!n.link
                return (
                  <button
                    key={n.id}
                    onClick={() => onItem(n)}
                    disabled={!clickable && n.read}
                    className="w-full text-left px-4 py-3 flex gap-3 transition-colors"
                    style={{
                      borderBottom: "1px solid var(--border)",
                      background: n.read ? "transparent" : "var(--green-subtle)",
                      cursor: clickable ? "pointer" : "default",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "var(--surface-2)" }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = n.read ? "transparent" : "var(--green-subtle)" }}
                  >
                    {/* Unread dot */}
                    <span className="mt-1.5 h-2 w-2 rounded-full shrink-0"
                      style={{ background: n.read ? "transparent" : "var(--green)" }} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium truncate" style={{ color: "var(--text)" }}>{n.title}</span>
                      {n.body && (
                        <span className="block text-xs mt-0.5 leading-snug" style={{ color: "var(--text-muted)" }}>{n.body}</span>
                      )}
                      <span className="block text-[10px] mt-1 uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                        {timeAgo(n.created_at)}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
