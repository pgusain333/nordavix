/**
 * Settings page — edit the active company's profile.
 *
 * Lives inside the regular app layout (sidebar visible). Reuses
 * CompanyForm in edit mode, pre-populated from:
 *   • the Clerk organization's `name`, and
 *   • the meta blob stored in localStorage under company_meta_<orgId>.
 *
 * On save:
 *   • renames the Clerk org (if the user changed the name), and
 *   • writes the meta blob back to localStorage.
 *
 * Shows a transient "Saved" indicator next to the submit button so
 * the user gets confirmation without a toast.
 */
import { useEffect, useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useOrganization } from "@clerk/clerk-react"
import { Settings as SettingsIcon } from "lucide-react"
import { Spinner } from "@/core/ui/components"
import {
  CompanyForm,
  readMeta,
  writeMeta,
  type CompanyMeta,
} from "@/modules/onboarding/components/CompanyForm"

export function SettingsPage() {
  const navigate = useNavigate()
  const { organization, isLoaded } = useOrganization()
  const [submitting, setSubmitting] = useState(false)
  const [error,      setError]      = useState<string | null>(null)
  const [savedAt,    setSavedAt]    = useState<number | null>(null)

  // Re-read meta whenever the active org changes. We key the initialMeta
  // object on org.id so React's reference-equality re-syncs the form
  // when the user switches workspaces from the LeftNav.
  const initialMeta: CompanyMeta = useMemo(
    () => (organization ? readMeta(organization.id) : {}),
    [organization?.id],
  )

  // Clear the "Saved" indicator after 2.5s.
  useEffect(() => {
    if (!savedAt) return
    const t = setTimeout(() => setSavedAt(null), 2500)
    return () => clearTimeout(t)
  }, [savedAt])

  if (!isLoaded) {
    return <div className="h-full flex items-center justify-center"><Spinner className="h-6 w-6" /></div>
  }

  if (!organization) {
    // WorkspaceGate should prevent this, but render a graceful fallback.
    return (
      <div className="h-full flex items-center justify-center text-sm" style={{ color: "var(--text-muted)" }}>
        Select a company workspace to access settings.
      </div>
    )
  }

  async function handleSubmit(name: string, meta: CompanyMeta) {
    if (!organization) return
    setError(null)
    setSubmitting(true)
    try {
      // Rename the Clerk org if the user changed it. This is the only
      // field Clerk's frontend update() accepts; everything else
      // lives in our meta blob.
      if (name && name !== organization.name) {
        await organization.update({ name })
      }
      writeMeta(organization.id, meta)
      setSavedAt(Date.now())
    } catch {
      setError("Could not save changes. Try again?")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto" style={{ background: "var(--bg)" }}>
      {/* Header */}
      <div className="px-4 sm:px-8 py-5 sm:py-6"
        style={{ borderBottom: "1px solid var(--border)", background: "var(--surface)" }}>
        <div className="max-w-4xl mx-auto flex items-start gap-3">
          <div className="h-9 w-9 rounded-lg flex items-center justify-center shrink-0"
            style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
            <SettingsIcon size={18} strokeWidth={1.8} />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-lg sm:text-xl font-bold text-theme leading-tight">
              Company settings
            </h1>
            <p className="text-xs sm:text-sm mt-1" style={{ color: "var(--text-muted)" }}>
              Update {organization.name}'s profile, address, tax info, and accounting
              defaults. Changes apply to this workspace only.
            </p>
          </div>
        </div>
      </div>

      <div className="flex-1 px-4 sm:px-8 py-6 max-w-4xl w-full mx-auto">
        <div className="rounded-2xl p-6 sm:p-7"
          style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
          <CompanyForm
            // re-mount the form when org changes so all controlled
            // state resets to the new org's values cleanly
            key={organization.id}
            mode="edit"
            initialName={organization.name ?? ""}
            initialMeta={initialMeta}
            submitting={submitting}
            error={error}
            statusText={savedAt ? "Saved" : null}
            onSubmit={handleSubmit}
            onCancel={() => navigate("/app")}
          />
        </div>
      </div>
    </div>
  )
}
