/**
 * ProductSwitcher — moves between Nordavix's two PRODUCTS.
 *
 * Nordavix ships two distinct products behind ONE Clerk login:
 *   • Month-end close   (/app/*)         — the original close platform
 *   • Cost allocation   (/allocation/*)  — §471(c) allocation for cannabis
 *
 * They are siblings, not parent/child: separate shells, separate nav, separate
 * dashboards. This control is the only UI seam between them.
 *
 * NAMING — read this before touching it. In this codebase "workspace" already
 * means a Clerk organization (a client company), and `WorkspaceSwitcher` is the
 * COMPANY switcher used by LeftNav + TopBar. This is a different axis entirely,
 * hence "product". Keeping the two controls distinct is deliberate: a user must
 * never confuse "which product am I in" with "which client am I looking at" —
 * both surfaces show dollar amounts, and conflating them causes real errors.
 *
 * The last-used product is remembered so sign-in lands where you left off
 * rather than forcing a chooser every session.
 */
import { useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { Check, ChevronDown, LayoutDashboard, Scale, type LucideIcon } from "lucide-react"
import { cn } from "@/core/ui/utils"

export type ProductId = "close" | "allocation"

interface Product {
  id:    ProductId
  label: string
  hint:  string
  to:    string
  icon:  LucideIcon
}

export const PRODUCTS: Product[] = [
  { id: "close",      label: "Month-end close", hint: "Reconcile, flux, report", to: "/app",        icon: LayoutDashboard },
  { id: "allocation", label: "Cost allocation", hint: "§471(c) for cannabis", to: "/allocation", icon: Scale },
]

const STORAGE_KEY = "nordavix:last-product"

/** Remember the product the user is in, so the next sign-in lands here. */
export function rememberProduct(id: ProductId): void {
  try { localStorage.setItem(STORAGE_KEY, id) } catch { /* private mode — ignore */ }
}

/** The product to land in on sign-in. Defaults to the close app. */
export function lastProduct(): ProductId {
  try {
    return localStorage.getItem(STORAGE_KEY) === "allocation" ? "allocation" : "close"
  } catch { return "close" }
}

interface Props {
  /** Which product is currently mounted. */
  current: ProductId
  /** Rail is collapsed — render the icon-only trigger. */
  collapsed?: boolean
  /** Close the mobile drawer after navigating. */
  onNavigate?: () => void
}

export function ProductSwitcher({ current, collapsed = false, onNavigate }: Props) {
  // Declared before the effect that closes over them.
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const navigate = useNavigate()

  const active = PRODUCTS.find((p) => p.id === current) ?? PRODUCTS[0]
  const ActiveIcon = active.icon

  // Dismiss on outside click or Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false) }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  function go(p: Product) {
    setOpen(false)
    if (p.id !== current) {
      rememberProduct(p.id)
      navigate(p.to)
    }
    onNavigate?.()
  }

  return (
    <div ref={wrapRef} className="relative px-3 py-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${active.label} — switch product`}
        className={cn(
          "flex items-center rounded-lg transition-colors w-full",
          collapsed ? "justify-center h-9" : "gap-2 px-2.5 py-2",
        )}
        style={{ background: "var(--nav-hover)", color: "var(--nav-text-act)" }}
      >
        <ActiveIcon size={15} strokeWidth={1.9} className="shrink-0" />
        {!collapsed && (
          <>
            <span className="text-[13px] font-medium truncate flex-1 text-left">{active.label}</span>
            <ChevronDown size={14} strokeWidth={2} className="shrink-0 opacity-70" />
          </>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-3 z-50 mt-1 rounded-lg overflow-hidden py-1"
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            boxShadow: "0 18px 44px -16px rgba(0,0,0,0.45)",
            minWidth: 232,
          }}
        >
          {PRODUCTS.map((p) => {
            const Icon = p.icon
            const isCurrent = p.id === current
            return (
              <button
                key={p.id}
                role="menuitem"
                onClick={() => go(p)}
                className="flex items-start gap-2.5 w-full px-3 py-2 text-left transition-colors"
                style={{ color: "var(--text)" }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--surface-2)" }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent" }}
              >
                <Icon size={15} strokeWidth={1.9} className="mt-0.5 shrink-0" style={{ color: "var(--text-2)" }} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium truncate">{p.label}</span>
                  <span className="block text-[11px] truncate" style={{ color: "var(--text-muted)" }}>{p.hint}</span>
                </span>
                {isCurrent && (
                  <Check size={14} strokeWidth={2.2} className="mt-0.5 shrink-0" style={{ color: "var(--green)" }} />
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
