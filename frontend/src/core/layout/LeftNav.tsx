/**
 * Left navigation sidebar — Nordavix app shell.
 * Theme-aware, mobile-ready (accepts onClose for overlay dismiss).
 */
import { useEffect, useRef, useState } from "react"
import { NavLink, useNavigate } from "react-router-dom"
import { UserButton, useOrganization, useUser } from "@clerk/clerk-react"
import {
  LayoutDashboard, BarChart3, Scale, FileText, ArrowLeftRight,
  X, Pencil, Check, type LucideIcon,
} from "lucide-react"
import { cn } from "@/core/ui/utils"
import { Badge } from "@/core/ui/components"
import { ThemeToggle } from "@/core/theme/ThemeToggle"

interface NavItem {
  label:     string
  path:      string
  icon:      LucideIcon
  available: boolean
}

const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard",       path: "/app",                 icon: LayoutDashboard, available: true  },
  { label: "Flux Analysis",   path: "/app/flux",            icon: BarChart3,       available: true  },
  { label: "Reconciliations", path: "/app/reconciliations", icon: Scale,           available: false },
  { label: "Workpapers",      path: "/app/workpapers",      icon: FileText,        available: false },
  { label: "Intercompany",    path: "/app/intercompany",    icon: ArrowLeftRight,  available: false },
]

interface Props {
  onClose?: () => void
}

export function LeftNav({ onClose }: Props) {
  const { organization } = useOrganization()
  const { user } = useUser()
  const navigate = useNavigate()

  return (
    <aside
      className="flex h-screen w-60 shrink-0 flex-col"
      style={{ background: "var(--nav-bg)", borderRight: "1px solid var(--nav-border)" }}
    >
      {/* Brand */}
      <div className="flex items-center justify-between px-4 py-[18px]"
        style={{ borderBottom: "1px solid var(--nav-border)" }}>
        <button
          onClick={() => { navigate("/"); onClose?.() }}
          className="flex items-center gap-2.5 min-w-0 flex-1"
        >
          <img src="/logo-mark-dark.svg"  alt="Nordavix" className="h-7 w-7 shrink-0 dark:hidden" />
          <img src="/logo-mark-light.svg" alt="Nordavix" className="h-7 w-7 shrink-0 hidden dark:block" />
          <span className="text-[15px] font-semibold tracking-tight text-theme truncate">
            nordavix<span style={{ color: "var(--green)" }}>.</span>
          </span>
        </button>
        {/* Mobile close button */}
        {onClose && (
          <button
            onClick={onClose}
            className="lg:hidden ml-2 flex items-center justify-center h-7 w-7 rounded-md text-theme-muted hover:text-theme transition-colors"
          >
            <X size={16} strokeWidth={1.6} />
          </button>
        )}
      </div>

      {/* Org name — click to rename */}
      {organization && (
        <OrgNameInline organizationName={organization.name} onRename={(n) => organization.update({ name: n })} />
      )}

      {/* Navigation */}
      <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon

          if (!item.available) {
            return (
              <div
                key={item.path}
                className="flex items-center justify-between rounded-md px-3 py-2 text-sm cursor-not-allowed opacity-35"
                style={{ color: "var(--nav-text)" }}
              >
                <span className="flex items-center gap-2.5">
                  <Icon size={22} strokeWidth={1.6} className="shrink-0" />
                  {item.label}
                </span>
                <Badge variant="soon">soon</Badge>
              </div>
            )
          }

          return (
            <NavLink
              key={item.path}
              to={item.path}
              end={item.path === "/app"}
              onClick={() => onClose?.()}
              className={({ isActive }) =>
                cn("flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-all duration-150",
                  isActive ? "font-medium" : "")
              }
              style={({ isActive }) => isActive
                ? { background: "var(--nav-active)", color: "var(--nav-text-act)" }
                : { color: "var(--nav-text)" }
              }
            >
              {({ isActive }) => (
                <>
                  <Icon size={22} strokeWidth={1.6} className="shrink-0"
                    style={{ color: isActive ? "var(--green)" : "var(--nav-text)" }} />
                  <span className="truncate">{item.label}</span>
                  {isActive && (
                    <span className="ml-auto h-1.5 w-1.5 rounded-full shrink-0"
                      style={{ background: "var(--green)" }} />
                  )}
                </>
              )}
            </NavLink>
          )
        })}
      </nav>

      {/* Bottom: theme + user */}
      <div className="px-3 py-3 space-y-3" style={{ borderTop: "1px solid var(--nav-border)" }}>
        <div className="flex items-center justify-between px-1">
          <span className="text-[11px] font-medium" style={{ color: "var(--text-muted)" }}>Theme</span>
          <ThemeToggle />
        </div>
        <div className="flex items-center gap-3 px-1">
          <UserButton appearance={{ elements: { avatarBox: "h-7 w-7" } }} />
          <span className="text-xs truncate" style={{ color: "var(--nav-text)" }}>
            {user?.primaryEmailAddress?.emailAddress ?? "Account"}
          </span>
        </div>
      </div>
    </aside>
  )
}

// ── OrgNameInline ───────────────────────────────────────────────────────────
// Click the workspace name to rename. Enter saves; Esc cancels.
// Wraps Clerk's `organization.update({ name })` so members with admin
// permission can change the workspace label without leaving the app.

interface OrgNameInlineProps {
  organizationName: string
  onRename: (name: string) => Promise<unknown>
}

function OrgNameInline({ organizationName, onRename }: OrgNameInlineProps) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(organizationName)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Stay in sync if Clerk updates the org from elsewhere
  useEffect(() => { setValue(organizationName) }, [organizationName])

  // Focus & select-all when entering edit mode
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  async function commit() {
    const next = value.trim()
    if (!next || next === organizationName) { setEditing(false); setValue(organizationName); return }
    setSaving(true); setError(null)
    try {
      await onRename(next)
      setEditing(false)
    } catch {
      // Most likely cause: user isn't an admin of this org
      setError("Couldn't rename. You may not have permission.")
    } finally {
      setSaving(false)
    }
  }

  function cancel() {
    setValue(organizationName)
    setEditing(false)
    setError(null)
  }

  return (
    <div
      className="px-4 py-2 group relative"
      style={{ borderBottom: "1px solid var(--nav-border)" }}
    >
      {editing ? (
        <div className="flex items-center gap-1.5">
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit()
              else if (e.key === "Escape") cancel()
            }}
            disabled={saving}
            className="flex-1 min-w-0 rounded px-1.5 py-0.5 text-xs outline-none"
            style={{
              background: "var(--surface-2)",
              border: "1px solid var(--border-strong)",
              color: "var(--text)",
            }}
            onFocus={(e) => (e.currentTarget.style.borderColor = "var(--green)")}
            onBlur={(e) => (e.currentTarget.style.borderColor = "var(--border-strong)")}
          />
          <button
            onClick={commit}
            disabled={saving}
            className="shrink-0 h-5 w-5 rounded flex items-center justify-center"
            style={{ color: "var(--green)" }}
            title="Save"
          >
            <Check size={13} strokeWidth={2.2} />
          </button>
          <button
            onClick={cancel}
            disabled={saving}
            className="shrink-0 h-5 w-5 rounded flex items-center justify-center"
            style={{ color: "var(--text-muted)" }}
            title="Cancel"
          >
            <X size={13} strokeWidth={2.2} />
          </button>
        </div>
      ) : (
        <button
          onClick={() => setEditing(true)}
          className="flex items-center gap-1.5 w-full text-left group/btn"
          title="Click to rename workspace"
        >
          <p className="text-xs truncate flex-1" style={{ color: "var(--nav-text)" }}>{organizationName}</p>
          <Pencil
            size={11}
            strokeWidth={1.8}
            className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
            style={{ color: "var(--text-muted)" }}
          />
        </button>
      )}
      {error && (
        <p className="text-[10px] mt-1" style={{ color: "#dc2626" }}>{error}</p>
      )}
    </div>
  )
}
