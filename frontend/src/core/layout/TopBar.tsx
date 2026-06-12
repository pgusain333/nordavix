/**
 * Desktop top bar (lg+ only). Three zones:
 *   left   — company › page-title breadcrumb (active workspace + where you are)
 *   center — search (opens the ⌘K command palette)
 *   right  — notification bell · divider · signed-in user (name · role · menu)
 *
 * Mounted in ThreePaneLayout. The mobile layout keeps its own top bar
 * (search + bell) and the nav drawer keeps the account block, so these
 * controls never double-render on mobile.
 */
import { useEffect, useMemo, useState } from "react"
import { UserButton, useOrganization, useUser } from "@clerk/clerk-react"
import { useNavigate, useLocation } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { Search, ChevronRight, HelpCircle } from "lucide-react"
import { workspaceApi } from "@/modules/workspace/api"
import { reconsApi } from "@/modules/recons/api"
import { NotificationBell } from "@/modules/notifications/NotificationBell"
import { WorkspaceSwitcher } from "@/core/layout/WorkspaceSwitcher"
import { CMDK_EVENT } from "@/core/ui/CommandPalette"

// Route → page title. Longest/most-specific paths first; "/app" (Dashboard)
// stays LAST so it only matches the exact dashboard route, not its children.
const PAGE_TITLES: [string, string][] = [
  ["/app/reconciliations", "Reconciliations"],
  ["/app/flux",            "Flux Analysis"],
  ["/app/schedules",       "Schedules"],
  ["/app/intercompany",    "Intercompany"],
  ["/app/financials",      "Financial Package"],
  ["/app/insights",        "Insights"],
  ["/app/connections",     "Connections"],
  ["/app/tasks",           "Close Tasks"],
  ["/app/team",            "Team"],
  ["/app/settings",        "Settings"],
  ["/app/help",            "Help"],
  ["/app/companies",       "Companies"],
  ["/app",                 "Dashboard"],
]

// One level deeper — sub-pages that earn a third breadcrumb crumb (the section
// above stays clickable). Currently the individual schedule pages.
const SUB_TITLES: [string, string][] = [
  ["/app/schedules/prepaids",     "Prepaid Expenses"],
  ["/app/schedules/accruals",     "Accrued Expenses"],
  ["/app/schedules/fixed-assets", "Fixed Assets"],
  ["/app/schedules/leases",       "Leases"],
  ["/app/schedules/loans",        "Loans"],
]

export function TopBar() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { organization } = useOrganization()
  const { user } = useUser()

  const section = PAGE_TITLES.find(([p]) => pathname === p || pathname.startsWith(p + "/"))
  const pageTitle = section?.[1] ?? ""
  const sectionPath = section?.[0] ?? ""
  const subTitle = SUB_TITLES.find(([p]) => pathname === p || pathname.startsWith(p + "/"))?.[1] ?? ""

  // Browser-tab title follows the page — "Reconciliations · Nordavix" — so a
  // CPA with six tabs open can tell them apart. Marketing pages set their own
  // title via the SEO/Helmet component; this covers the app shell.
  useEffect(() => {
    const t = subTitle || pageTitle
    document.title = t ? `${t} · Nordavix` : "Nordavix"
  }, [pageTitle, subTitle])

  // Close-progress chip — the close is the product's heartbeat, so the bar
  // shows where it stands: the OLDEST non-closed month (sequential close
  // means that's the one being worked) + approved/total. Color carries
  // meaning only: slate = in progress, green = complete/all-closed, muted =
  // not started. Cached tracker query (same key the dashboards use).
  const { data: trackerData } = useQuery({
    queryKey: ["period-tracker"],
    queryFn:  reconsApi.listPeriodTracker,
    staleTime: 60_000,
    retry: 0,            // books not seeded yet → just hide the chip
  })
  const closeChip = useMemo(() => {
    const ps = trackerData?.periods ?? []
    if (ps.length === 0) return null
    const asc = [...ps].sort((a, b) => (a.period_end < b.period_end ? -1 : 1))
    const active = asc.find((p) => p.status !== "closed")
    if (!active) return { done: true as const, label: "All months closed", sub: "", fg: "var(--positive)", bg: "var(--positive-subtle)" }
    const fg = active.status === "complete" ? "var(--positive)"
             : active.status === "in_progress" ? "var(--info)" : "var(--text-muted)"
    const bg = active.status === "complete" ? "var(--positive-subtle)"
             : active.status === "in_progress" ? "var(--info-subtle)" : "var(--surface-2)"
    return { done: false as const, label: active.label, sub: `${active.counts.approved}/${active.total}`, fg, bg }
  }, [trackerData])

  // Role → chip. Same source + mapping the nav used; long staleTime.
  const { data: me } = useQuery({
    queryKey: ["workspace-me"],
    queryFn:  workspaceApi.getMe,
    staleTime: 10 * 60_000,
    enabled:  !!organization,
  })
  const roleMeta = me ? ({
    admin:    { label: "Admin",    bg: "rgba(199, 154, 82, 0.15)", fg: "#c79a52" },
    reviewer: { label: "Reviewer", bg: "#e9eef3",                  fg: "#3c5a76" },
    preparer: { label: "Preparer", bg: "var(--surface-2)",         fg: "var(--text-muted)" },
  } as const)[me.role as "admin" | "reviewer" | "preparer"] : null

  const name = user?.fullName ?? user?.primaryEmailAddress?.emailAddress ?? "Account"

  // Subtle shadow under the bar once page content scrolls beneath it. Capture
  // phase catches scrolls inside nested page containers; the height filter
  // ignores small inner scrollers (tables, drawers) so only the main content
  // area toggles it.
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const onScroll = (e: Event) => {
      const t = e.target as HTMLElement | null
      if (!t || typeof t.scrollTop !== "number" || t.clientHeight < 240) return
      setScrolled(t.scrollTop > 8)
    }
    document.addEventListener("scroll", onScroll, true)
    return () => document.removeEventListener("scroll", onScroll, true)
  }, [])

  return (
    <div
      className="hidden lg:flex shrink-0 h-14 items-center gap-3 px-6 relative z-20 transition-shadow duration-200"
      style={{
        background: "var(--surface)",
        borderBottom: "1px solid var(--border)",
        boxShadow: scrolled ? "0 6px 16px -10px rgba(0,0,0,0.28)" : "none",
      }}
    >
      {/* Left — company › page context */}
      <div className="flex-1 flex items-center gap-2 min-w-0">
        {/* Active company — click to switch workspaces */}
        <WorkspaceSwitcher variant="breadcrumb" />
        {pageTitle && (
          <>
            <ChevronRight size={14} strokeWidth={1.8} className="shrink-0" style={{ color: "var(--text-muted)" }} />
            {subTitle ? (
              <button
                onClick={() => navigate(sectionPath)}
                className="text-sm truncate transition-opacity hover:opacity-80"
                style={{ color: "var(--text-2)" }}
              >
                {pageTitle}
              </button>
            ) : (
              <span className="text-sm truncate" style={{ color: "var(--text-2)" }}>{pageTitle}</span>
            )}
          </>
        )}
        {subTitle && (
          <>
            <ChevronRight size={14} strokeWidth={1.8} className="shrink-0" style={{ color: "var(--text-muted)" }} />
            <span className="text-sm font-medium truncate" style={{ color: "var(--text)" }}>{subTitle}</span>
          </>
        )}
        {/* Close-progress chip (xl+ so the breadcrumb never crowds). */}
        {closeChip && (
          <button
            onClick={() => navigate("/app/reconciliations")}
            title="Close progress — open Reconciliations"
            className="hidden xl:inline-flex items-center gap-1.5 ml-2 shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold transition-transform hover:-translate-y-px"
            style={{ background: closeChip.bg, color: closeChip.fg, border: "1px solid var(--border)" }}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: closeChip.fg }} />
            {closeChip.done
              ? "All months closed"
              : <>Close · {closeChip.label}&nbsp;<span className="tabular-nums opacity-80">{closeChip.sub}</span></>}
          </button>
        )}
      </div>

      {/* Center — search (opens ⌘K) */}
      <button
        onClick={() => window.dispatchEvent(new Event(CMDK_EVENT))}
        className="shrink-0 inline-flex items-center gap-2 rounded-lg h-9 w-[320px] px-3 text-sm transition-colors hover:border-[var(--border-strong)]"
        style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}
        title="Search and jump anywhere (⌘K)"
      >
        <Search size={15} strokeWidth={1.8} className="shrink-0" style={{ color: "var(--text-muted)" }} />
        <span className="flex-1 text-left" style={{ color: "var(--text-muted)" }}>Search or jump to…</span>
        <kbd className="text-[10px] px-1 py-0.5 rounded"
          style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text-muted)" }}>⌘K</kbd>
      </button>

      {/* Right — help · bell · divider · user */}
      <div className="flex-1 flex items-center justify-end gap-2">
        <button
          onClick={() => navigate("/app/help")}
          className="flex items-center justify-center h-9 w-9 rounded-md transition-colors hover:bg-[var(--surface-2)]"
          title="Help & guide"
          aria-label="Help"
        >
          <HelpCircle size={18} strokeWidth={1.8} style={{ color: "var(--text-muted)" }} />
        </button>
        <NotificationBell className="h-9 w-9" />

        <div className="h-6 w-px" style={{ background: "var(--border)" }} aria-hidden />

        <div className="flex items-center gap-2.5">
          <div className="text-right leading-tight">
            <p className="text-xs font-semibold truncate max-w-[180px]" style={{ color: "var(--text)" }}>
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
