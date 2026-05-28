/**
 * CompaniesPanel — the user's company switcher / first-time onboarding.
 *
 * Renders in three scenarios:
 *  1. First-time user (zero memberships, confirmed) → empty-state w/ Create CTA.
 *  2. Existing user                                  → grid of clickable cards.
 *  3. Membership list still loading                   → spinner.
 *
 * Create now navigates to /app/companies/new (a dedicated page) instead of
 * popping a modal, so the form has room to breathe and matches the rest of
 * the app's page-based UX.
 */
import { useNavigate } from "react-router-dom"
import { useOrganization, useOrganizationList, useSession, useUser, UserButton } from "@clerk/clerk-react"
import { Building2, Plus, ArrowRight, Calendar } from "lucide-react"
import { useState } from "react"
import { Spinner } from "@/core/ui/components"
import { readMeta } from "@/modules/onboarding/components/CompanyForm"

export function CompaniesPanel() {
  const navigate = useNavigate()
  const { user, isLoaded: userLoaded } = useUser()
  const { organization } = useOrganization()
  const { session } = useSession()
  const { userMemberships, setActive, isLoaded: listLoaded } = useOrganizationList({
    userMemberships: { infinite: true },
  })

  const [switching, setSwitching] = useState<string | null>(null)

  const memberships = userMemberships?.data ?? []
  const isFetchingOrgs = !!(userMemberships?.isLoading || userMemberships?.isFetching)
  const hasOrgs = memberships.length > 0
  const trulyEmpty = listLoaded && !isFetchingOrgs && memberships.length === 0

  async function selectCompany(orgId: string) {
    if (!setActive) return
    setSwitching(orgId)
    try {
      await setActive({ organization: orgId })
      // setActive doesn't synchronously refresh Clerk's session-token
      // cache, so the dashboard's first /api/* request can fire with
      // a JWT that still carries the OLD org_id — surfacing as
      // "Network Error" on /workspace/me, /members, etc. Force-mint
      // a token with the new org_id BEFORE navigating so the new
      // tenant context reaches the backend immediately.
      if (session) {
        try {
          await session.getToken({ skipCache: true })
        } catch { /* harmless — interceptor will retry */ }
      }
      navigate("/app")
    } finally {
      // setSwitching cleared by route change
    }
  }

  const showSpinner =
    !userLoaded ||
    !listLoaded ||
    (isFetchingOrgs && memberships.length === 0)

  if (showSpinner) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "var(--bg)" }}>
        <Spinner className="h-6 w-6" />
      </div>
    )
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

      <main className="flex-1 px-6 py-10">
        <div className="max-w-4xl mx-auto">
          <div className="mb-8 flex items-end justify-between gap-4 flex-wrap">
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold text-theme mb-1.5">
                {hasOrgs ? "Choose a company" : "Welcome to Nordavix"}
              </h1>
              <p className="text-sm sm:text-base" style={{ color: "var(--text-muted)" }}>
                {hasOrgs
                  ? "Select a workspace to continue, or create a new company."
                  : "Let's set up your first company to get started with your month-end close."
                }
              </p>
            </div>
            {hasOrgs && (
              <button
                onClick={() => navigate("/app/companies/new")}
                disabled={switching !== null}
                className="inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-semibold text-white hover:opacity-90 transition-opacity disabled:opacity-40"
                style={{ background: "var(--green)" }}
              >
                <Plus size={14} strokeWidth={2} />
                New company
              </button>
            )}
          </div>

          {hasOrgs && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
              {memberships.map((m) => {
                const org = m.organization
                const meta = readMeta(org.id)
                const isActive = organization?.id === org.id
                return (
                  <button
                    key={org.id}
                    onClick={() => selectCompany(org.id)}
                    disabled={switching !== null}
                    className="rounded-xl p-5 text-left transition-all disabled:opacity-50"
                    style={{
                      background: "var(--surface)",
                      border: `1px solid ${isActive ? "var(--green)" : "var(--border)"}`,
                      boxShadow: "var(--card-shadow)",
                    }}
                    onMouseEnter={(e) => { if (switching === null) (e.currentTarget as HTMLElement).style.borderColor = "var(--green)" }}
                    onMouseLeave={(e) => { if (switching === null && !isActive) (e.currentTarget as HTMLElement).style.borderColor = "var(--border)" }}
                  >
                    <div className="flex items-start gap-3">
                      <div className="h-10 w-10 rounded-lg flex items-center justify-center shrink-0"
                        style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
                        <Building2 size={18} strokeWidth={1.8} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-theme truncate">{org.name}</p>
                        <p className="text-xs mt-0.5 truncate" style={{ color: "var(--text-muted)" }}>
                          {meta.industry ?? "Workspace"}
                          {meta.size ? ` · ${meta.size} people` : ""}
                          {meta.base_currency ? ` · ${meta.base_currency}` : ""}
                        </p>
                        {meta.fiscal_year_end && (
                          <p className="text-[11px] mt-1.5 flex items-center gap-1" style={{ color: "var(--text-muted)" }}>
                            <Calendar size={10} strokeWidth={1.8} />
                            FY ends {meta.fiscal_year_end}
                          </p>
                        )}
                      </div>
                      {switching === org.id ? (
                        <Spinner className="h-4 w-4" />
                      ) : (
                        <ArrowRight size={14} strokeWidth={1.8} style={{ color: "var(--text-muted)" }} className="mt-1 shrink-0" />
                      )}
                    </div>
                  </button>
                )
              })}
            </div>
          )}

          {/* True empty state — no orgs at all, no fetch in flight. */}
          {trulyEmpty && (
            <div className="rounded-2xl p-8 text-center"
              style={{ background: "var(--surface)", border: "1px dashed var(--border-strong)" }}>
              <div className="h-12 w-12 mx-auto rounded-lg flex items-center justify-center mb-4"
                style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
                <Building2 size={22} strokeWidth={1.6} />
              </div>
              <p className="text-base font-semibold text-theme mb-1.5">Create your first company</p>
              <p className="text-sm mb-5 max-w-sm mx-auto" style={{ color: "var(--text-muted)" }}>
                Nordavix is organized around companies (workspaces). Each one has its
                own QuickBooks, books, and team — pick a setup that matches the entity
                you'll be closing books for.
              </p>
              <button
                onClick={() => navigate("/app/companies/new")}
                className="inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90 transition-opacity"
                style={{ background: "var(--green)" }}
              >
                <Plus size={14} strokeWidth={2} />
                Create company
              </button>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
