/**
 * AllocationNav — the nav rail for Nordavix Allocate.
 *
 * Intentionally a separate, much shorter rail than the close app's LeftNav:
 * this is a different product with a different job, and inheriting the close
 * nav's five groups would blur that. Same design tokens (--nav-*), so it still
 * looks like Nordavix — but `html.workspace-allocation` swaps the brand accent
 * to amber, which is the at-a-glance cue for which product you're in.
 */
import { NavLink, useNavigate } from "react-router-dom"
import {
  Building2, ListChecks, Settings, SlidersHorizontal, X, type LucideIcon,
} from "lucide-react"
import { cn } from "@/core/ui/utils"
import { ProductSwitcher } from "@/core/layout/ProductSwitcher"

interface NavItem {
  label: string
  path:  string
  icon:  LucideIcon
  /** Exact match only — the roster lives at the index path. */
  end?:  boolean
}

const NAV: NavItem[] = [
  { label: "Clients",  path: "/allocation",          icon: Building2,         end: true },
  { label: "Runs",     path: "/allocation/runs",     icon: ListChecks },
  { label: "Setup",    path: "/allocation/setup",    icon: SlidersHorizontal },
  { label: "Settings", path: "/allocation/settings", icon: Settings },
]

interface Props {
  /** Present when rendered inside the mobile drawer. */
  onClose?: () => void
}

export function AllocationNav({ onClose }: Props) {
  const navigate = useNavigate()

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

      {/* Sections */}
      <div className="flex-1 px-3 pb-4 pt-1 space-y-0.5">
        {NAV.map((item) => {
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

      {/* Product footer — states what this surface is, and what it isn't. */}
      <div className="px-4 py-3" style={{ borderTop: "1px solid var(--nav-border)" }}>
        <p className="text-[10.5px] leading-snug" style={{ color: "var(--nav-text)" }}>
          §471(c) allocation · separate from month-end close
        </p>
      </div>
    </nav>
  )
}
