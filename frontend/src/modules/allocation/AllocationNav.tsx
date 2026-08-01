/**
 * AllocationNav — the nav rail for Nordavix Allocate.
 *
 * Intentionally a separate, much shorter rail than the close app's LeftNav:
 * this is a different product with a different job, and inheriting the close
 * nav's five groups would blur that. Same design tokens (--nav-*), so it still
 * looks like Nordavix — but `html.workspace-allocation` swaps the brand accent
 * to amber, which is the at-a-glance cue for which product you're in.
 */
import { useState } from "react"
import { NavLink, useNavigate } from "react-router-dom"
import {
  Building2, CalendarCheck2, Gauge, Layers, LifeBuoy, ListTree, MessageSquare,
  PlayCircle, Receipt, Scale, Settings, Users, X, type LucideIcon,
} from "lucide-react"
import { cn } from "@/core/ui/utils"
import { ProductSwitcher } from "@/core/layout/ProductSwitcher"
import { FeedbackDialog } from "@/core/ui/FeedbackDialog"

interface NavItem {
  label: string
  path:  string
  icon:  LucideIcon
  /** Exact match only — the dashboard lives at the index path. */
  end?:  boolean
}

interface NavSection {
  /** Null for the lead item, which needs no heading above it. */
  heading: string | null
  items: NavItem[]
}

/**
 * Ordered the way the work happens, not the way the screens were built.
 *
 * Set up once → run every month → close the year. The setup steps are in
 * dependency order too: eligibility decides whether any of it is usable, pools
 * decide what accounts can point at, and the two registries only matter if a
 * pool actually consumes them.
 */
const SECTIONS: NavSection[] = [
  { heading: null, items: [
    { label: "Dashboard", path: "/allocation", icon: Gauge, end: true },
  ] },
  { heading: "Set up", items: [
    { label: "Eligibility", path: "/allocation/eligibility", icon: Scale },
    { label: "Cost pools",  path: "/allocation/pools",       icon: Layers },
    { label: "Accounts",    path: "/allocation/accounts",    icon: ListTree },
    { label: "Spaces",      path: "/allocation/spaces",      icon: Building2 },
    { label: "Employees",   path: "/allocation/employees",   icon: Users },
    { label: "Settings",    path: "/allocation/settings",    icon: Settings },
  ] },
  { heading: "Every month", items: [
    { label: "Payroll register", path: "/allocation/payroll", icon: Receipt },
    { label: "Run allocation",   path: "/allocation/runs",    icon: PlayCircle },
  ] },
  { heading: "Year end", items: [
    // The written procedures memo isn't here: it's generated from this config
    // and downloaded from Settings, so it lives where the config does.
    { label: "Roll-up & 1125-A", path: "/allocation/year-end", icon: CalendarCheck2 },
  ] },
]

interface Props {
  /** Present when rendered inside the mobile drawer. */
  onClose?: () => void
}

export function AllocationNav({ onClose }: Props) {
  const navigate = useNavigate()
  const [feedbackOpen, setFeedbackOpen] = useState(false)

  return (
    <nav
      className={cn(
        "no-scrollbar flex h-screen flex-col overflow-y-auto overflow-x-hidden",
        onClose ? "w-[300px]" : "w-[248px] shrink-0",
      )}
      style={{ background: "var(--nav-bg)", borderRight: "1px solid var(--nav-border)" }}
    >
      {/* Brand */}
      <div
        className="flex items-center justify-between gap-2 px-3 py-[18px]"
        style={{ borderBottom: "1px solid var(--nav-border)" }}
      >
        <button
          onClick={() => { navigate("/"); onClose?.() }}
          className="flex items-center gap-2.5 min-w-0 flex-1"
          title="Nordavix home"
        >
          <img src="/logo-mark-white.svg" alt="Nordavix" className="h-8 w-8 shrink-0" />
          <span
            className="text-xl font-semibold tracking-tight leading-none truncate"
            style={{ color: "#FFFFFF" }}
          >
            nordavix<span style={{ color: "var(--green-light)" }}>.</span>
          </span>
        </button>
        {onClose && (
          <button
            onClick={onClose}
            className="lg:hidden flex items-center justify-center h-7 w-7 rounded-md transition-colors"
            style={{ color: "var(--nav-text)" }}
            aria-label="Close menu"
          >
            <X size={16} strokeWidth={1.6} />
          </button>
        )}
      </div>

      {/* Product switcher — the only seam back to the close app. */}
      <ProductSwitcher current="allocation" onNavigate={onClose} />

      {/* Sections — headings carry the sequence, so the rail reads as a
          workflow rather than a pile of screens. */}
      <div className="flex-1 px-3 pb-4 pt-1">
        {SECTIONS.map((section, si) => (
          <div key={section.heading ?? "lead"} className={si === 0 ? "space-y-0.5" : "mt-4 space-y-0.5"}>
            {section.heading && (
              <p
                className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wider"
                style={{ color: "var(--nav-text)", opacity: 0.55 }}
              >
                {section.heading}
              </p>
            )}
            {section.items.map((item) => {
              const Icon = item.icon
              return (
                <NavLink
                  key={item.path}
                  to={item.path}
                  end={item.end}
                  onClick={() => onClose?.()}
                  className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors"
                  style={({ isActive }) =>
                    isActive
                      ? { background: "var(--nav-active)", color: "var(--nav-text-act)" }
                      : { color: "var(--nav-text)" }
                  }
                >
                  {({ isActive }) => (
                    <>
                      <Icon
                        size={16}
                        strokeWidth={1.8}
                        className="shrink-0"
                        style={{ color: isActive ? "var(--nav-text-act)" : "var(--nav-text)" }}
                      />
                      <span className="truncate">{item.label}</span>
                    </>
                  )}
                </NavLink>
              )
            })}
          </div>
        ))}
      </div>

      {/* Help + Feedback — the same utility pair the close nav carries, so
          staff don't have to learn where they went in this product. */}
      <div className="px-3 pt-2 pb-1 space-y-1.5" style={{ borderTop: "1px solid var(--nav-border)" }}>
        <a
          href="/app/help"
          target="_blank"
          rel="noopener noreferrer"
          title="Step-by-step guide — every workflow, every screen"
          className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] font-medium transition-colors"
          style={{ color: "var(--nav-text)" }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--nav-hover)" }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent" }}
        >
          <LifeBuoy size={16} strokeWidth={1.8} className="shrink-0" />
          <span className="flex-1 text-left">Help</span>
        </a>
        <button
          type="button"
          onClick={() => setFeedbackOpen(true)}
          title="Share a bug, idea, or comment with the Nordavix team"
          className="w-full inline-flex items-center gap-2.5 rounded-md px-3 py-2 text-[13px] font-medium transition-all"
          style={{
            color: "var(--nav-text)",
            background: "transparent",
            border: "1px dashed rgba(255,255,255,0.35)",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--nav-hover)"
            e.currentTarget.style.color = "var(--nav-text-act)"
            e.currentTarget.style.borderColor = "rgba(255,255,255,0.7)"
            e.currentTarget.style.borderStyle = "solid"
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent"
            e.currentTarget.style.color = "var(--nav-text)"
            e.currentTarget.style.borderColor = "rgba(255,255,255,0.35)"
            e.currentTarget.style.borderStyle = "dashed"
          }}
        >
          <MessageSquare size={16} strokeWidth={1.8} className="shrink-0" />
          <span className="flex-1 text-left">Send feedback</span>
        </button>
      </div>
      <FeedbackDialog open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />

      {/* Product footer — states what this surface is, and what it isn't. */}
      <div className="px-4 py-3" style={{ borderTop: "1px solid var(--nav-border)" }}>
        <p className="text-[10.5px] leading-snug" style={{ color: "var(--nav-text)" }}>
          §471(c) allocation · separate from month-end close
        </p>
      </div>
    </nav>
  )
}
