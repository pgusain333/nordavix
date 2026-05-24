/**
 * WorkspaceGate — shown once per session when a signed-in user has no active
 * Clerk organization.
 *
 * The user can either:
 *   A) Create an organization (becomes their multi-user workspace tenant)
 *   B) Continue solo (backend uses user_{clerk_user_id} as pseudo-tenant)
 *
 * "Skip" is remembered for the rest of the browser session so users who
 * intentionally work solo aren't interrupted on every page load.
 */
import { useState } from "react"
import { useOrganization, useOrganizationList } from "@clerk/clerk-react"
import { Building2, ArrowRight, UserCircle2 } from "lucide-react"
import { Spinner } from "@/core/ui/components"

interface Props {
  children: React.ReactNode
}

export function WorkspaceGate({ children }: Props) {
  const { organization, isLoaded: orgLoaded } = useOrganization()
  const { createOrganization, isLoaded: listLoaded } = useOrganizationList()

  const [skipped]    = useState(() => sessionStorage.getItem("ws_setup_skipped") === "1")
  const [orgName,    setOrgName]    = useState("")
  const [creating,   setCreating]   = useState(false)
  const [error,      setError]      = useState<string | null>(null)
  const [, forceRender] = useState(0)

  // Not loaded yet — render nothing (prevents flash)
  if (!orgLoaded || !listLoaded) return null

  // User already has an active org, or has skipped setup this session
  if (organization || skipped) return <>{children}</>

  function handleSkip() {
    sessionStorage.setItem("ws_setup_skipped", "1")
    forceRender(n => n + 1)
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!orgName.trim() || !createOrganization) return
    setCreating(true)
    setError(null)
    try {
      await createOrganization({ name: orgName.trim() })
      // Clerk automatically activates the new org — WorkspaceGate will
      // re-render with organization != null and pass through to children.
    } catch {
      setError("Failed to create workspace. Please try again.")
      setCreating(false)
    }
  }

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center px-6"
      style={{ background: "var(--bg)" }}
    >
      <div
        className="w-full max-w-md rounded-2xl p-8"
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          boxShadow: "var(--card-shadow)",
        }}
      >
        {/* Logo wordmark */}
        <div className="flex items-center gap-2 mb-8">
          <img src="/logo-mark-dark.svg"  alt="Nordavix" className="h-7 w-7 dark:hidden" />
          <img src="/logo-mark-light.svg" alt="Nordavix" className="h-7 w-7 hidden dark:block" />
          <span className="font-semibold text-base text-theme">
            nordavix<span style={{ color: "var(--green)" }}>.</span>
          </span>
        </div>

        <h1 className="text-xl font-bold text-theme mb-1">Set up your workspace</h1>
        <p className="text-sm mb-8" style={{ color: "var(--text-muted)" }}>
          Create a named workspace for your firm or team — or continue as an individual user.
        </p>

        {/* ── Create org form ── */}
        <form onSubmit={handleCreate} className="mb-4">
          <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--text-2)" }}>
            Workspace name
          </label>
          <input
            type="text"
            placeholder="e.g. Acme Accounting, Smith CPA"
            value={orgName}
            onChange={e => setOrgName(e.target.value)}
            className="w-full rounded-lg px-3 py-2.5 text-sm outline-none transition-all"
            style={{
              background:   "var(--surface-2)",
              border:       "1px solid var(--border-strong)",
              color:        "var(--text)",
            }}
            onFocus={e  => (e.currentTarget.style.borderColor = "var(--green)")}
            onBlur={e   => (e.currentTarget.style.borderColor = "var(--border-strong)")}
          />
          {error && (
            <p className="text-xs mt-2" style={{ color: "#dc2626" }}>{error}</p>
          )}
          <button
            type="submit"
            disabled={!orgName.trim() || creating}
            className="mt-3 w-full flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            style={{ background: "var(--green)" }}
          >
            {creating ? (
              <>
                <div style={{ color: "#fff" }}><Spinner className="h-4 w-4" /></div>
                Creating…
              </>
            ) : (
              <>
                <Building2 size={15} strokeWidth={1.6} />
                Create workspace
                <ArrowRight size={15} strokeWidth={1.6} />
              </>
            )}
          </button>
        </form>

        {/* Divider */}
        <div className="flex items-center gap-3 mb-4">
          <div className="flex-1 h-px" style={{ background: "var(--border)" }} />
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>or</span>
          <div className="flex-1 h-px" style={{ background: "var(--border)" }} />
        </div>

        {/* ── Solo option ── */}
        <button
          onClick={handleSkip}
          className="w-full flex items-center gap-2.5 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors text-left"
          style={{
            border: "1px solid var(--border-strong)",
            color:  "var(--text-2)",
            background: "transparent",
          }}
          onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-2)")}
          onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
        >
          <UserCircle2 size={16} strokeWidth={1.6} style={{ color: "var(--text-muted)" }} />
          Continue as individual user
        </button>

        <p className="text-xs mt-4 text-center" style={{ color: "var(--text-muted)" }}>
          You can create or join a workspace later from your account settings.
        </p>
      </div>
    </div>
  )
}
