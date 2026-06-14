/**
 * NotificationBell — bell icon + unread-count badge.
 *
 * Polls the cheap /count endpoint so the badge follows what's happening in the
 * workspace (a teammate closing the books, etc.). Clicking dispatches the
 * window event that opens the NotificationsPanel (same pattern as ⌘K). Drop it
 * in the left nav and the mobile top bar.
 */
import { Bell } from "lucide-react"
import { useQuery } from "@tanstack/react-query"
import { useOrganization } from "@clerk/clerk-react"
import { cn } from "@/core/ui/utils"
import { notificationsApi, NOTIF_EVENT } from "./api"

interface Props {
  /** Called after opening — e.g. close the mobile nav drawer. */
  onOpen?: () => void
  className?: string
}

export function NotificationBell({ onOpen, className }: Props) {
  const { organization } = useOrganization()

  const { data: unread = 0 } = useQuery({
    queryKey: ["notifications", "count"],
    queryFn:  notificationsApi.count,
    staleTime: 30_000,
    // Pause polling while the tab is backgrounded — RQ v5 does NOT auto-pause
    // refetchInterval on hidden tabs, so an idle tab would keep pinging the
    // server every 45s. Resumes automatically when the tab is visible again.
    refetchInterval: () => (document.visibilityState === "visible" ? 45_000 : false),
    enabled: !!organization,
  })

  function open() {
    window.dispatchEvent(new Event(NOTIF_EVENT))
    onOpen?.()
  }

  return (
    <button
      onClick={open}
      className={cn(
        "relative flex items-center justify-center h-8 w-8 rounded-lg transition-colors shrink-0",
        className,
      )}
      style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}
      title={unread > 0 ? `${unread} unread notification${unread === 1 ? "" : "s"}` : "Notifications"}
      aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
    >
      <Bell size={16} strokeWidth={1.8} style={{ color: "var(--text-muted)" }} />
      {unread > 0 && (
        <span
          className="absolute -top-1 -right-1 inline-flex items-center justify-center min-w-[16px] h-[16px] rounded-full px-1 text-[9px] font-bold tabular-nums"
          style={{ background: "var(--green)", color: "#fff", border: "1.5px solid var(--surface)" }}
        >
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </button>
  )
}
