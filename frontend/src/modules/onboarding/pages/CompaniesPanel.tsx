/**
 * CompaniesPanel — the user's company switcher / first-time onboarding.
 *
 * Renders in two scenarios:
 *  1. First-time user (no companies yet)  → shows the create form.
 *  2. Existing user                       → shows a grid of clickable
 *     company cards + a "Create another" CTA. Clicking a card sets the
 *     active Clerk org and navigates to the dashboard.
 */
import { useEffect, useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useOrganization, useOrganizationList, useUser, UserButton } from "@clerk/clerk-react"
import { motion, AnimatePresence } from "framer-motion"
import {
  Building2,
  Plus,
  ArrowRight,
  Calendar,
  Globe,
  Briefcase,
  Users as UsersIcon,
  DollarSign,
  X,
  Sparkles,
} from "lucide-react"
import { Spinner } from "@/core/ui/components"

const INDUSTRIES = [
  "Accounting / Bookkeeping",
  "Professional Services",
  "Software / SaaS",
  "E-commerce / Retail",
  "Manufacturing",
  "Construction",
  "Real Estate",
  "Healthcare",
  "Hospitality",
  "Nonprofit",
  "Other",
]

const SIZES = [
  { label: "Just me",        value: "1" },
  { label: "2–10",           value: "2-10" },
  { label: "11–50",          value: "11-50" },
  { label: "51–200",         value: "51-200" },
  { label: "200+",           value: "200+" },
]

const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "INR", "JPY", "CHF", "CNY", "BRL", "MXN"]

const COUNTRIES = [
  "United States", "Canada", "United Kingdom", "India", "Australia",
  "Germany", "France", "Singapore", "United Arab Emirates", "Other",
]

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]

interface CompanyMeta {
  industry?: string
  fiscal_year_end?: string  // "March" — month name
  size?: string
  base_currency?: string
  country?: string
}

/**
 * Where the multi-field company details live.
 *
 * Clerk's frontend `organization.update()` only accepts `name` / `slug` —
 * `publicMetadata` is server-only. To avoid adding a backend write for an
 * MVP, we cache the extra fields in localStorage keyed by org id. The
 * data is per-browser; teammates will see defaults until we promote this
 * to a backend `tenant.settings` JSONB write (TODO).
 */
const META_KEY = (orgId: string) => `company_meta_${orgId}`

function readMeta(orgId: string): CompanyMeta {
  try {
    const raw = localStorage.getItem(META_KEY(orgId))
    return raw ? JSON.parse(raw) as CompanyMeta : {}
  } catch {
    return {}
  }
}

function writeMeta(orgId: string, meta: CompanyMeta): void {
  try {
    localStorage.setItem(META_KEY(orgId), JSON.stringify(meta))
  } catch {
    // localStorage may be full or disabled; not critical
  }
}

export function CompaniesPanel() {
  const navigate = useNavigate()
  const { user, isLoaded: userLoaded } = useUser()
  const { organization } = useOrganization()
  const { userMemberships, setActive, isLoaded: listLoaded } = useOrganizationList({
    userMemberships: { infinite: true },
  })

  const [showCreate, setShowCreate] = useState(false)
  const [switching, setSwitching]   = useState<string | null>(null)

  const memberships = userMemberships?.data ?? []
  const hasOrgs = memberships.length > 0

  // First-time user with no orgs: auto-open the create modal
  useEffect(() => {
    if (listLoaded && !hasOrgs) setShowCreate(true)
  }, [listLoaded, hasOrgs])

  async function selectCompany(orgId: string) {
    if (!setActive) return
    setSwitching(orgId)
    try {
      await setActive({ organization: orgId })
      // Give Clerk a tick to settle, then navigate
      setTimeout(() => navigate("/app"), 50)
    } finally {
      // setSwitching cleared by route change
    }
  }

  if (!userLoaded || !listLoaded) {
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
          <UserButton appearance={{ elements: { avatarBox: "h-7 w-7" } }} />
        </div>
      </header>

      <main className="flex-1 px-6 py-10">
        <div className="max-w-4xl mx-auto">
          <div className="mb-8">
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

              {/* Create-another card */}
              <button
                onClick={() => setShowCreate(true)}
                disabled={switching !== null}
                className="rounded-xl p-5 text-left transition-all disabled:opacity-50 flex items-center justify-center gap-3 min-h-[110px]"
                style={{
                  background: "transparent",
                  border: "2px dashed var(--border-strong)",
                  color: "var(--text-muted)",
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--green)"; (e.currentTarget as HTMLElement).style.color = "var(--green)" }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--border-strong)"; (e.currentTarget as HTMLElement).style.color = "var(--text-muted)" }}
              >
                <Plus size={18} strokeWidth={1.8} />
                <span className="text-sm font-medium">Create another company</span>
              </button>
            </div>
          )}
        </div>
      </main>

      {/* Create modal */}
      <AnimatePresence>
        {showCreate && (
          <CreateCompanyModal
            onClose={() => { if (hasOrgs) setShowCreate(false) }}
            allowDismiss={hasOrgs}
            onCreated={(orgId) => {
              setShowCreate(false)
              selectCompany(orgId)
            }}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

// ── Create Company modal ─────────────────────────────────────────────────────

interface CreateProps {
  onClose:      () => void
  onCreated:    (orgId: string) => void
  allowDismiss: boolean
}

function CreateCompanyModal({ onClose, onCreated, allowDismiss }: CreateProps) {
  const { createOrganization, isLoaded } = useOrganizationList()

  const [name,        setName]        = useState("")
  const [industry,    setIndustry]    = useState(INDUSTRIES[0])
  const [fiscalEnd,   setFiscalEnd]   = useState("December")
  const [size,        setSize]        = useState(SIZES[1].value)
  const [currency,    setCurrency]    = useState("USD")
  const [country,     setCountry]     = useState(COUNTRIES[0])
  const [error,       setError]       = useState<string | null>(null)
  const [submitting,  setSubmitting]  = useState(false)

  const canSubmit = useMemo(() => name.trim().length > 0 && !submitting && isLoaded, [name, submitting, isLoaded])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit || !createOrganization) return
    setError(null)
    setSubmitting(true)
    try {
      const org = await createOrganization({ name: name.trim() })
      // Stash the rest in localStorage keyed by org.id (see notes in
      // CompaniesPanel — Clerk's frontend update() doesn't accept publicMetadata).
      writeMeta(org.id, {
        industry,
        fiscal_year_end: fiscalEnd,
        size,
        base_currency: currency,
        country,
      })
      onCreated(org.id)
    } catch {
      setError("Could not create company. Try a different name?")
      setSubmitting(false)
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      className="fixed inset-0 z-50 flex items-center justify-center px-4 py-6 overflow-y-auto"
      style={{ background: "rgba(0,0,0,0.55)" }}
      onClick={allowDismiss ? onClose : undefined}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96, y: 10 }}
        transition={{ duration: 0.22, ease: "easeOut" }}
        className="w-full max-w-lg rounded-2xl overflow-hidden"
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          boxShadow: "0 24px 64px rgba(0,0,0,0.35)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 pt-6 pb-4 flex items-start gap-3"
          style={{ borderBottom: "1px solid var(--border)" }}>
          <div className="h-10 w-10 rounded-lg flex items-center justify-center shrink-0"
            style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
            <Building2 size={20} strokeWidth={1.8} />
          </div>
          <div className="flex-1">
            <h2 className="text-base font-semibold text-theme">Create your company</h2>
            <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
              A few details so AI commentary speaks your accounting language. You can edit these later.
            </p>
          </div>
          {allowDismiss && (
            <button onClick={onClose} className="h-7 w-7 rounded-md flex items-center justify-center"
              style={{ color: "var(--text-muted)" }}>
              <X size={15} strokeWidth={1.8} />
            </button>
          )}
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          <Field label="Company name" icon={<Building2 size={12} strokeWidth={1.8} />}>
            <input
              type="text" autoFocus value={name} onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Acme Accounting, Smith CPA"
              disabled={submitting} className="input"
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Industry" icon={<Briefcase size={12} strokeWidth={1.8} />}>
              <select value={industry} onChange={(e) => setIndustry(e.target.value)} disabled={submitting} className="input">
                {INDUSTRIES.map((i) => <option key={i} value={i}>{i}</option>)}
              </select>
            </Field>

            <Field label="Company size" icon={<UsersIcon size={12} strokeWidth={1.8} />}>
              <select value={size} onChange={(e) => setSize(e.target.value)} disabled={submitting} className="input">
                {SIZES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Fiscal year end" icon={<Calendar size={12} strokeWidth={1.8} />}>
              <select value={fiscalEnd} onChange={(e) => setFiscalEnd(e.target.value)} disabled={submitting} className="input">
                {MONTHS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </Field>

            <Field label="Base currency" icon={<DollarSign size={12} strokeWidth={1.8} />}>
              <select value={currency} onChange={(e) => setCurrency(e.target.value)} disabled={submitting} className="input">
                {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>
          </div>

          <Field label="Country" icon={<Globe size={12} strokeWidth={1.8} />}>
            <select value={country} onChange={(e) => setCountry(e.target.value)} disabled={submitting} className="input">
              {COUNTRIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>

          {error && <p className="text-xs" style={{ color: "#dc2626" }}>{error}</p>}

          <button
            type="submit" disabled={!canSubmit}
            className="w-full flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            style={{ background: "var(--green)" }}
          >
            {submitting ? <Spinner className="h-4 w-4" /> : <Sparkles size={14} strokeWidth={1.8} />}
            {submitting ? "Creating…" : "Create company"}
          </button>
        </form>

        {/* Component-scoped styles */}
        <style>{`
          .input {
            width: 100%;
            background: var(--surface-2);
            border: 1px solid var(--border-strong);
            color: var(--text);
            border-radius: 8px;
            padding: 8px 10px;
            font-size: 13px;
            outline: none;
            transition: border-color 0.15s;
          }
          .input:focus { border-color: var(--green); }
          .input:disabled { opacity: 0.6; }
        `}</style>
      </motion.div>
    </motion.div>
  )
}

function Field({ label, icon, children }: { label: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="flex items-center gap-1.5 text-[11px] font-medium mb-1" style={{ color: "var(--text-2)" }}>
        {icon}
        {label}
      </span>
      {children}
    </label>
  )
}
