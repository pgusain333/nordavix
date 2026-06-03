/**
 * Desktop top bar — search (left) + notification bell and the signed-in user
 * (name · role chip · Clerk account menu) on the right. Mounted only at lg+
 * in ThreePaneLayout. The mobile layout keeps its own top bar (search + bell)
 * and the nav drawer keeps the account block, so this bar is desktop-only and
 * never double-renders those controls on mobile.
 */
import { UserButton, useOrganization, useUser } from "@clerk/clerk-react"
import { useNavigate } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { Search } from "lucide-react"
import { workspaceApi } from "@/modules/workspace/api"
import { NotificationBell } from "@/modules/notifications/NotificationBell"
import { CMDK_EVENT } from "@/core/ui/CommandPalette"

export function TopBar() {
  const navigate = useNavigate()
  const { organization } = useOrganization()
  const { user } = useUser()

  // Role → chip. Same source + mapping the nav used; long staleTime since
  // role changes rarely.
  const { data: me } = useQuery({
    queryKey: ["workspace-me"],
    queryFn:  workspaceApi.getMe,
    staleTime: 10 * 60_000,
    enabled:  !!organization,
  })
  const roleMeta = me ? ({
    admin:    { label: "Admin",    bg: "rgba(245, 158, 11, 0.15)", fg: "#f59e0b" },
    reviewer: { label: "Reviewer", bg: "#dbeafe",                  fg: "#1d4ed8" },
    preparer: { label: "Preparer", bg: "var(--surface-2)",         fg: "var(--text-muted)" },
  } as const)[me.role as "admin" | "reviewer" | "preparer"] : null

  // Show the real name; fall back to email, then a neutral label.
  const name = user?.fullName ?? user?.primaryEmailAddress?.emailAddress ?? "Account"

  return (
    <div
      className="hidden lg:flex shrink-0 h-14 items-center gap-3 px-6"
      style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}
    >
      {/* Search — opens the ⌘K command palette */}
      <button
        onClick={() => window.dispatchEvent(new Event(CMDK_EVENT))}
        className="inline-flex items-center gap-2 rounded-lg h-9 w-[300px] px-3 text-sm transition-colors hover:border-[var(--border-strong)]"
        style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}
        title="Search and jump anywhere (⌘K)"
      >
        <Search size={15} strokeWidth={1.8} className="shrink-0" style={{ color: "var(--text-muted)" }} />
        <span className="flex-1 text-left" style={{ color: "var(--text-muted)" }}>Search or jump to…</span>
        <kbd className="text-[10px] px-1 py-0.5 rounded"
          style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text-muted)" }}>⌘K</kbd>
      </button>

      {/* Actions — pushed to the right */}
      <div className="ml-auto flex items-center gap-2.5">
        <NotificationBell className="h-9 w-9" />

        <div className="h-6 w-px" style={{ background: "var(--border)" }} aria-hidden />

        <div className="flex items-center gap-2.5">
          <div className="text-right leading-tight">
            <p className="text-xs font-semibold truncate max-w-[200px]" style={{ color: "var(--text)" }}>
              {name}
            </p>
            {roleMeta && (
              <button
                onClick={() => navigate("/app/team")}
                className="mt-0.5 inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide transition-opacity hover:opacity-80"
                style={{ background: roleMeta.bg, color: roleMeta.fg }}
                title="Open the Team page"
              >
                {roleMeta.label}
              </button>
            )}
          </div>
          <UserButton
            afterSignOutUrl="/sign-in"
            appearance={{ elements: { avatarBox: "h-8 w-8" } }}
          />
        </div>
      </div>
    </div>
  )
}
