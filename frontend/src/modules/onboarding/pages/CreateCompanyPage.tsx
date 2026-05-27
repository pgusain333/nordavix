/**
 * Create Company page — standalone, no sidebar.
 *
 * Reached from:
 *   • the CompaniesPanel "Create company" CTA, and
 *   • the empty-state on first-time sign-in.
 *
 * On success, provisions the Clerk org, stashes the meta in
 * localStorage, switches the active org to the new one, and lands
 * the user on /app (dashboard surfaces the next-step nudge for
 * connecting QBO + setting up books).
 */
import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { useOrganizationList, useUser, UserButton } from "@clerk/clerk-react"
import { ArrowLeft } from "lucide-react"
import { CompanyForm, writeMeta, type CompanyMeta } from "@/modules/onboarding/components/CompanyForm"

export function CreateCompanyPage() {
  const navigate = useNavigate()
  const { user } = useUser()
  const { createOrganization, setActive, isLoaded } = useOrganizationList()
  const [submitting, setSubmitting] = useState(false)
  const [error,      setError]      = useState<string | null>(null)

  async function handleSubmit(name: string, meta: CompanyMeta) {
    if (!isLoaded || !createOrganization) return
    setError(null)
    setSubmitting(true)
    try {
      const org = await createOrganization({ name })
      writeMeta(org.id, meta)
      // Switch the Clerk session to the new org so the next request
      // already carries its org_id, then land on the dashboard.
      if (setActive) {
        await setActive({ organization: org.id })
      }
      setTimeout(() => navigate("/app"), 50)
    } catch {
      setError("Could not create company. Try a different name?")
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "var(--bg)" }}>
      {/* Header */}
      <header className="px-6 py-5 flex items-center justify-between"
        style={{ borderBottom: "1px solid var(--border)", background: "var(--surface)" }}>
        <div className="flex items-center gap-2.5">
          <img src="/logo-mark-dark.svg"  alt="" className="h-7 w-7 dark:hidden" />
          <img src="/logo-mark-light.svg" alt="" className="h-7 w-7 hidden dark:block" />
          <span className="font-bold text-base text-theme tracking-tight">
            nordavix<span style={{ color: "var(--green)" }}>.</span>
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden sm:inline text-xs" style={{ color: "var(--text-muted)" }}>
            {user?.primaryEmailAddress?.emailAddress}
          </span>
          <UserButton
            afterSignOutUrl="/sign-in"
            appearance={{ elements: { avatarBox: "h-7 w-7" } }}
          />
        </div>
      </header>

      <main className="flex-1 px-6 py-8">
        <div className="max-w-3xl mx-auto">
          {/* Back + title */}
          <button
            onClick={() => navigate("/app/companies")}
            disabled={submitting}
            className="inline-flex items-center gap-1.5 text-xs mb-4 hover:underline disabled:opacity-50"
            style={{ color: "var(--text-muted)" }}
          >
            <ArrowLeft size={12} strokeWidth={2} />
            Back to companies
          </button>
          <h1 className="text-2xl sm:text-3xl font-bold text-theme mb-1.5">
            Create your company
          </h1>
          <p className="text-sm sm:text-base mb-6" style={{ color: "var(--text-muted)" }}>
            Only the company name is required. The rest powers AI commentary, audit
            defaults, and future integrations — you can edit any of it later from
            <span className="font-medium" style={{ color: "var(--text)" }}> Settings</span>.
          </p>

          <div className="rounded-2xl p-6 sm:p-7"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
            <CompanyForm
              mode="create"
              initialName=""
              initialMeta={{}}
              submitting={submitting}
              error={error}
              onSubmit={handleSubmit}
              onCancel={() => navigate("/app/companies")}
            />
          </div>
        </div>
      </main>
    </div>
  )
}
