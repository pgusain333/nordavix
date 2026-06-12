/**
 * WorkspaceSwitcher — dropdown menu in the LeftNav for switching
 * between Clerk organizations (companies). Replaces the plain
 * "Switch company" text link with a proper menu that lists all the
 * user's workspaces, marks the active one, and includes a
 * "+ Create company" footer action.
 *
 * Click-outside + Escape both close the menu. Switching org calls
 * Clerk's setActive then awaits a fresh JWT (matches the create-
 * company flow in CompaniesPanel) so the dashboard's first queries
 * after switch already carry the new org_id.
 */
import { useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useOrganization, useOrganizationList, useSession } from "@clerk/clerk-react"
import { motion, AnimatePresence } from "framer-motion"
import { Building2, Check, ChevronDown, LayoutGrid, Plus } from "lucide-react"
import { Spinner } from "@/core/ui/components"

interface Props {
  /** Called after a successful switch so the LeftNav can close its
   * mobile slide-out drawer. Optional. */
  onAfterSwitch?: () => void
  /** "menu" = full-width "Switch workspace" trigger (nav). "breadcrumb" =
   * shows the active company name + chevron, for the top-bar breadcrumb. */
  variant?: "menu" | "breadcrumb"
}

export function WorkspaceSwitcher({ onAfterSwitch, variant = "menu" }: Props) {
  const navigate = useNavigate()
  const { organization } = useOrganization()
  const { session } = useSession()
  const { userMemberships, setActive, isLoaded } = useOrganizationList({
    userMemberships: { infinite: true },
  })

  const [open, setOpen] = useState(false)
  const [switching, setSwitching] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef    = useRef<HTMLDivElement>(null)

  // Warm the Command Center chunk the moment the menu opens — by the
  // time the user reads the list, the firm view loads instantly.
  useEffect(() => {
    if (open) void import("@/modules/firm/pages/CommandCenterPage")
  }, [open])

  // Click-outside + Esc close
  useEffect(() => {
    if (!open) return
    function onClick(e: MouseEvent) {
      const t = e.target as Node
      if (triggerRef.current?.contains(t)) return
      if (menuRef.current?.contains(t)) return
      setOpen(false)
    }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setOpen(false) }
    document.addEventListener("mousedown", onClick)
    document.addEventListener("keydown",   onKey)
    return () => {
      document.removeEventListener("mousedown", onClick)
      document.removeEventListener("keydown",   onKey)
    }
  }, [open])

  async function selectCompany(orgId: string) {
    if (!setActive || orgId === organization?.id) {
      setOpen(false)
      return
    }
    setSwitching(orgId)
    try {
      await setActive({ organization: orgId })
      // Force-mint a JWT with the new org_id before navigating so the
      // dashboard's first /api/* request doesn't fire with a stale token.
      if (session) {
        try { await session.getToken({ skipCache: true }) } catch { /* harmless */ }
      }
      navigate("/app")
      onAfterSwitch?.()
    } finally {
      setSwitching(null)
      setOpen(false)
    }
  }

  const memberships = userMemberships?.data ?? []
  const otherCount  = memberships.filter((m) => m.organization.id !== organization?.id).length

  return (
    <div className="relative">
      {variant === "breadcrumb" ? (
        <div className="inline-flex items-center min-w-0">
          {/* Company name → dashboard */}
          <button
            type="button"
            onClick={() => { navigate("/app"); onAfterSwitch?.() }}
            className="inline-flex items-center gap-1.5 min-w-0 rounded-md px-1.5 py-1 transition-colors hover:bg-[var(--surface-2)]"
            title={`${organization?.name ?? "Workspace"} — go to dashboard`}
          >
            <Building2 size={15} strokeWidth={1.8} className="shrink-0" style={{ color: "var(--text-muted)" }} />
            <span className="text-sm font-semibold truncate max-w-[200px]" style={{ color: "var(--text)" }}>
              {organization?.name ?? "Workspace"}
            </span>
          </button>
          {/* Chevron → toggle the workspace switcher */}
          <button
            ref={triggerRef}
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex items-center justify-center h-6 w-6 rounded-md transition-colors hover:bg-[var(--surface-2)]"
            title={`Switch workspace · ${otherCount} other${otherCount === 1 ? "" : "s"}`}
            aria-label="Switch workspace"
          >
            <ChevronDown size={13} strokeWidth={1.8} className="transition-transform"
              style={{ color: "var(--text-muted)", transform: open ? "rotate(180deg)" : "rotate(0deg)" }} />
          </button>
        </div>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="w-full inline-flex items-center justify-between gap-2 px-2 py-1.5 rounded-md text-[11px] font-medium transition-colors hover:bg-[var(--nav-hover)]"
          style={{ color: "var(--nav-text)" }}
          title={`Switch workspace · ${otherCount} other${otherCount === 1 ? "" : "s"}`}
        >
          <span className="inline-flex items-center gap-1.5 min-w-0">
            <Building2 size={11} strokeWidth={1.8} className="shrink-0" />
            <span className="truncate">Switch workspace</span>
          </span>
          <ChevronDown
            size={11}
            strokeWidth={1.8}
            className="shrink-0 transition-transform"
            style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)" }}
          />
        </button>
      )}

      <AnimatePresence>
        {open && (
          <motion.div
            ref={menuRef}
            initial={{ opacity: 0, y: -4, scale: 0.97 }}
            animate={{ opacity: 1, y: 0,  scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.97 }}
            transition={{ duration: 0.12, ease: "easeOut" }}
            className={`absolute mt-1 rounded-lg overflow-hidden ${variant === "breadcrumb" ? "left-0 w-64 z-50" : "left-0 right-0 z-40"}`}
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border-strong)",
              boxShadow: "0 10px 28px -8px rgba(0,0,0,0.30), 0 4px 8px -2px rgba(0,0,0,0.10)",
              maxHeight: "320px",
            }}
          >
            {/* Firm level — sits ABOVE the company list. The Command
                Center is the CPA-firm home: every company's close on one
                screen, doubling as the company switcher. */}
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                navigate("/app/command-center")
                onAfterSwitch?.()
              }}
              className="w-full text-left px-3 py-2.5 inline-flex items-center gap-2 transition-colors hover:bg-[var(--green-subtle)]"
              style={{ borderBottom: "1px solid var(--border)" }}
            >
              <LayoutGrid size={13} strokeWidth={2} className="shrink-0" style={{ color: "var(--green)" }} />
              <span className="flex-1 min-w-0">
                <span className="block text-xs font-bold" style={{ color: "var(--text)" }}>
                  Command Center
                </span>
                <span className="block text-[10px]" style={{ color: "var(--text-muted)" }}>
                  All companies · firm overview
                </span>
              </span>
            </button>

            {/* Header */}
            <div className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider"
              style={{ background: "var(--surface-2)", color: "var(--text-muted)", borderBottom: "1px solid var(--border)" }}>
              Companies
            </div>

            {/* Members list */}
            <div className="max-h-[210px] overflow-y-auto">
              {!isLoaded ? (
                <div className="px-3 py-4 flex items-center justify-center">
                  <Spinner className="h-4 w-4" />
                </div>
              ) : memberships.length === 0 ? (
                <p className="px-3 py-3 text-[11px]" style={{ color: "var(--text-muted)" }}>
                  No workspaces yet — create your first below.
                </p>
              ) : (
                memberships.map((m) => {
                  const org = m.organization
                  const isActive = organization?.id === org.id
                  const isSwitching = switching === org.id
                  return (
                    <button
                      key={org.id}
                      onClick={() => selectCompany(org.id)}
                      disabled={isSwitching}
                      className="w-full text-left px-3 py-2 inline-flex items-center gap-2 transition-colors disabled:opacity-50 hover:bg-[var(--surface-2)]"
                      style={{ color: isActive ? "var(--green)" : "var(--text)" }}
                    >
                      <Building2 size={12} strokeWidth={1.8}
                        style={{ color: isActive ? "var(--green)" : "var(--text-muted)" }}
                        className="shrink-0" />
                      <span className="text-xs truncate flex-1" title={org.name}>{org.name}</span>
                      {isSwitching ? (
                        <Spinner className="h-3 w-3" />
                      ) : isActive ? (
                        <Check size={12} strokeWidth={2.2} className="shrink-0" />
                      ) : null}
                    </button>
                  )
                })
              )}
            </div>

            {/* Footer: + Create */}
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                navigate("/app/companies/new")
                onAfterSwitch?.()
              }}
              className="w-full text-left px-3 py-2 inline-flex items-center gap-2 text-xs font-medium transition-colors hover:bg-[var(--green-subtle)]"
              style={{
                color: "var(--green)",
                borderTop: "1px solid var(--border)",
              }}
            >
              <Plus size={12} strokeWidth={2} />
              Create company
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
