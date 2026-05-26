/**
 * CompaniesPanel — the user's company switcher / first-time onboarding.
 *
 * Renders in three scenarios:
 *  1. First-time user (zero memberships, confirmed) → empty-state w/ Create CTA.
 *     We do NOT auto-open the modal — Clerk's `userMemberships` hook briefly
 *     reports `data=[]` while the first fetch is in flight, and auto-opening
 *     based on that races the load and leaves the modal stuck open.
 *  2. Existing user → grid of clickable company cards + a "Create another" CTA.
 *  3. Membership list still loading → spinner.
 *
 * The Create form is now organized into four sections (Company, Address &
 * Contact, Tax & Legal, Accounting) so future modules (AI commentary that
 * speaks the entity's accounting language, audit-firm integrations,
 * materiality defaults, etc.) have the data they need from day one. All
 * fields except Name are optional. The extra meta is stashed in
 * localStorage today (TODO: backend `tenant.settings` JSONB write).
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
  MapPin,
  Phone,
  Link as LinkIcon,
  Hash,
  Landmark,
  ShieldCheck,
  BookOpenText,
  Percent,
  Mail,
} from "lucide-react"
import { Spinner } from "@/core/ui/components"

// ── Option lists ─────────────────────────────────────────────────────────────

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
  "Financial Services",
  "Education",
  "Other",
]

const SIZES = [
  { label: "Just me",        value: "1" },
  { label: "2–10",           value: "2-10" },
  { label: "11–50",          value: "11-50" },
  { label: "51–200",         value: "51-200" },
  { label: "201–1,000",      value: "201-1000" },
  { label: "1,000+",         value: "1000+" },
]

const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "INR", "JPY", "CHF", "CNY", "BRL", "MXN", "SGD", "AED"]

const COUNTRIES = [
  "United States", "Canada", "United Kingdom", "India", "Australia",
  "Germany", "France", "Singapore", "United Arab Emirates",
  "Ireland", "Netherlands", "Spain", "Mexico", "Brazil", "Japan",
  "Other",
]

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]

const ENTITY_TYPES = [
  "C-Corporation",
  "S-Corporation",
  "LLC (single-member)",
  "LLC (multi-member)",
  "Partnership",
  "Limited Partnership (LP)",
  "Limited Liability Partnership (LLP)",
  "Sole Proprietorship",
  "Nonprofit / 501(c)(3)",
  "Other",
]

const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA",
  "ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK",
  "OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC",
]

const REPORTING_BASIS = ["Accrual", "Cash", "Modified cash"]

const ACCOUNTING_STANDARDS = ["US GAAP", "IFRS", "Other"]

const BOOKS_SOFTWARE = [
  "QuickBooks Online",
  "QuickBooks Desktop",
  "Xero",
  "Sage Intacct",
  "NetSuite",
  "Wave",
  "FreshBooks",
  "Excel / Manual",
  "Other",
]

// ── Persisted company meta ───────────────────────────────────────────────────

interface CompanyMeta {
  // Section 1: Company basics
  legal_name?: string
  industry?: string
  description?: string
  size?: string
  founded_year?: string
  // Section 2: Address & contact
  country?: string
  street?: string
  city?: string
  state_province?: string
  postal_code?: string
  phone?: string
  website?: string
  // Section 3: Tax & legal
  entity_type?: string
  incorporation_state?: string
  tax_id?: string
  // Section 4: Accounting setup
  base_currency?: string
  fiscal_year_end?: string  // month name
  reporting_basis?: string
  accounting_standard?: string
  books_software?: string
  materiality_threshold?: string  // percentage, e.g. "1.0"
  auditor_firm?: string
  auditor_contact_email?: string
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

// ── CompaniesPanel ───────────────────────────────────────────────────────────

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
  const isFetchingOrgs = !!(userMemberships?.isLoading || userMemberships?.isFetching)
  const hasOrgs = memberships.length > 0
  // "Truly empty" = list hook is loaded AND no fetch is in flight AND zero
  // memberships came back. Used by the empty-state UI; we do NOT auto-open
  // the create modal anymore — the user always picks Create explicitly.
  const trulyEmpty = listLoaded && !isFetchingOrgs && memberships.length === 0

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

  // Loading: either Clerk's user/org-list hook isn't ready, or the memberships
  // fetch is still in flight. Show spinner instead of flashing an empty state.
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
          <UserButton appearance={{ elements: { avatarBox: "h-7 w-7" } }} />
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
                onClick={() => setShowCreate(true)}
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

          {/* True empty state — no orgs at all, no fetch in flight. Explicit
              CTA only; no auto-open modal that can stick if memberships
              come in late from Clerk. */}
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
                onClick={() => setShowCreate(true)}
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

      {/* Create modal */}
      <AnimatePresence>
        {showCreate && (
          <CreateCompanyModal
            onClose={() => setShowCreate(false)}
            allowDismiss={true}
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

  // Section 1: Company
  const [name,          setName]          = useState("")
  const [legalName,     setLegalName]     = useState("")
  const [industry,      setIndustry]      = useState(INDUSTRIES[0])
  const [description,   setDescription]   = useState("")
  const [size,          setSize]          = useState(SIZES[1].value)
  const [foundedYear,   setFoundedYear]   = useState("")

  // Section 2: Address & Contact
  const [country,       setCountry]       = useState(COUNTRIES[0])
  const [street,        setStreet]        = useState("")
  const [city,          setCity]          = useState("")
  const [stateProvince, setStateProvince] = useState("")
  const [postalCode,    setPostalCode]    = useState("")
  const [phone,         setPhone]         = useState("")
  const [website,       setWebsite]       = useState("")

  // Section 3: Tax & Legal
  const [entityType,    setEntityType]    = useState(ENTITY_TYPES[0])
  const [incState,      setIncState]      = useState("")
  const [taxId,         setTaxId]         = useState("")

  // Section 4: Accounting
  const [currency,      setCurrency]      = useState("USD")
  const [fiscalEnd,     setFiscalEnd]     = useState("December")
  const [reportingBasis,setReportingBasis]= useState(REPORTING_BASIS[0])
  const [accStd,        setAccStd]        = useState(ACCOUNTING_STANDARDS[0])
  const [booksSoftware, setBooksSoftware] = useState(BOOKS_SOFTWARE[0])
  const [materiality,   setMateriality]   = useState("1.0")
  const [auditorFirm,   setAuditorFirm]   = useState("")
  const [auditorEmail,  setAuditorEmail]  = useState("")

  const [error,        setError]        = useState<string | null>(null)
  const [submitting,   setSubmitting]   = useState(false)

  const canSubmit = useMemo(
    () => name.trim().length > 0 && !submitting && isLoaded,
    [name, submitting, isLoaded],
  )

  const isUS = country === "United States"

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit || !createOrganization) return
    setError(null)
    setSubmitting(true)
    try {
      const org = await createOrganization({ name: name.trim() })
      // Stash the rest in localStorage keyed by org.id (see notes in
      // CompaniesPanel — Clerk's frontend update() doesn't accept
      // publicMetadata). Empty strings are persisted as undefined to
      // keep the meta JSON compact.
      const trim = (v: string) => v.trim() || undefined
      writeMeta(org.id, {
        legal_name:            trim(legalName),
        industry,
        description:           trim(description),
        size,
        founded_year:          trim(foundedYear),
        country,
        street:                trim(street),
        city:                  trim(city),
        state_province:        trim(stateProvince),
        postal_code:           trim(postalCode),
        phone:                 trim(phone),
        website:               trim(website),
        entity_type:           entityType,
        incorporation_state:   isUS ? (trim(incState) || undefined) : undefined,
        tax_id:                trim(taxId),
        base_currency:         currency,
        fiscal_year_end:       fiscalEnd,
        reporting_basis:       reportingBasis,
        accounting_standard:   accStd,
        books_software:        booksSoftware,
        materiality_threshold: trim(materiality),
        auditor_firm:          trim(auditorFirm),
        auditor_contact_email: trim(auditorEmail),
      })
      onCreated(org.id)
    } catch {
      setError("Could not create company. Try a different name?")
      setSubmitting(false)
    }
  }

  // Close on Escape (when dismiss allowed)
  useEffect(() => {
    if (!allowDismiss) return
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [allowDismiss, onClose])

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
        className="w-full max-w-3xl rounded-2xl overflow-hidden my-4 flex flex-col"
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          boxShadow: "0 24px 64px rgba(0,0,0,0.35)",
          maxHeight: "calc(100vh - 3rem)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Sticky header */}
        <div className="px-6 pt-6 pb-4 flex items-start gap-3 shrink-0"
          style={{ borderBottom: "1px solid var(--border)", background: "var(--surface)" }}>
          <div className="h-10 w-10 rounded-lg flex items-center justify-center shrink-0"
            style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
            <Building2 size={20} strokeWidth={1.8} />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold text-theme">Create your company</h2>
            <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
              Only Company name is required. The rest powers AI commentary, audit
              defaults, and future integrations — you can edit any of it later.
            </p>
          </div>
          {allowDismiss && (
            <button onClick={onClose} className="h-7 w-7 rounded-md flex items-center justify-center hover:bg-black/5"
              style={{ color: "var(--text-muted)" }}>
              <X size={15} strokeWidth={1.8} />
            </button>
          )}
        </div>

        {/* Scrollable form */}
        <form
          id="create-company-form"
          onSubmit={handleSubmit}
          className="flex-1 overflow-y-auto px-6 py-5 space-y-7"
        >
          {/* ── Section 1: Company ─────────────────────────────────── */}
          <Section title="Company" icon={<Building2 size={13} strokeWidth={1.8} />}>
            <Field label="Company name *" icon={<Building2 size={12} strokeWidth={1.8} />}>
              <input
                type="text" autoFocus value={name} onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Acme Accounting, Smith CPA"
                disabled={submitting} className="input" required
              />
            </Field>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Legal name (if different)" icon={<Landmark size={12} strokeWidth={1.8} />}>
                <input value={legalName} onChange={(e) => setLegalName(e.target.value)}
                  placeholder="e.g. Acme Accounting, LLC" disabled={submitting} className="input" />
              </Field>
              <Field label="Industry" icon={<Briefcase size={12} strokeWidth={1.8} />}>
                <select value={industry} onChange={(e) => setIndustry(e.target.value)} disabled={submitting} className="input">
                  {INDUSTRIES.map((i) => <option key={i} value={i}>{i}</option>)}
                </select>
              </Field>
            </div>
            <Field label="Brief description (helps AI commentary)" icon={<BookOpenText size={12} strokeWidth={1.8} />}>
              <textarea
                value={description} onChange={(e) => setDescription(e.target.value)}
                placeholder="1–2 sentences about what the company does. e.g. 'Boutique tax & advisory firm serving early-stage SaaS founders.'"
                disabled={submitting} className="input min-h-[60px]" rows={2} maxLength={400}
              />
            </Field>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Company size" icon={<UsersIcon size={12} strokeWidth={1.8} />}>
                <select value={size} onChange={(e) => setSize(e.target.value)} disabled={submitting} className="input">
                  {SIZES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </Field>
              <Field label="Founded year" icon={<Calendar size={12} strokeWidth={1.8} />}>
                <input type="number" min={1800} max={new Date().getFullYear()}
                  value={foundedYear} onChange={(e) => setFoundedYear(e.target.value)}
                  placeholder="e.g. 2018" disabled={submitting} className="input" />
              </Field>
            </div>
          </Section>

          {/* ── Section 2: Address & Contact ───────────────────────── */}
          <Section title="Address & Contact" icon={<MapPin size={13} strokeWidth={1.8} />}>
            <Field label="Country" icon={<Globe size={12} strokeWidth={1.8} />}>
              <select value={country} onChange={(e) => setCountry(e.target.value)} disabled={submitting} className="input">
                {COUNTRIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>
            <Field label="Street address" icon={<MapPin size={12} strokeWidth={1.8} />}>
              <input value={street} onChange={(e) => setStreet(e.target.value)}
                placeholder="123 Main St, Suite 200" disabled={submitting} className="input" />
            </Field>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Field label="City">
                <input value={city} onChange={(e) => setCity(e.target.value)} disabled={submitting} className="input" />
              </Field>
              <Field label={isUS ? "State" : "State / Province"}>
                {isUS ? (
                  <select value={stateProvince} onChange={(e) => setStateProvince(e.target.value)} disabled={submitting} className="input">
                    <option value="">—</option>
                    {US_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                ) : (
                  <input value={stateProvince} onChange={(e) => setStateProvince(e.target.value)} disabled={submitting} className="input" />
                )}
              </Field>
              <Field label="Postal code">
                <input value={postalCode} onChange={(e) => setPostalCode(e.target.value)} disabled={submitting} className="input" />
              </Field>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Phone" icon={<Phone size={12} strokeWidth={1.8} />}>
                <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)}
                  placeholder="+1 (555) 123-4567" disabled={submitting} className="input" />
              </Field>
              <Field label="Website" icon={<LinkIcon size={12} strokeWidth={1.8} />}>
                <input type="url" value={website} onChange={(e) => setWebsite(e.target.value)}
                  placeholder="https://example.com" disabled={submitting} className="input" />
              </Field>
            </div>
          </Section>

          {/* ── Section 3: Tax & Legal ─────────────────────────────── */}
          <Section title="Tax & Legal" icon={<ShieldCheck size={13} strokeWidth={1.8} />}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Entity type" icon={<Landmark size={12} strokeWidth={1.8} />}>
                <select value={entityType} onChange={(e) => setEntityType(e.target.value)} disabled={submitting} className="input">
                  {ENTITY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </Field>
              {isUS && (
                <Field label="State of incorporation">
                  <select value={incState} onChange={(e) => setIncState(e.target.value)} disabled={submitting} className="input">
                    <option value="">—</option>
                    {US_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </Field>
              )}
            </div>
            <Field label={isUS ? "EIN (Tax ID)" : "Tax ID / business registration #"} icon={<Hash size={12} strokeWidth={1.8} />}>
              <input value={taxId} onChange={(e) => setTaxId(e.target.value)}
                placeholder={isUS ? "00-0000000" : "Tax / registration number"}
                disabled={submitting} className="input" />
            </Field>
          </Section>

          {/* ── Section 4: Accounting Setup ────────────────────────── */}
          <Section title="Accounting Setup" icon={<BookOpenText size={13} strokeWidth={1.8} />}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Base currency" icon={<DollarSign size={12} strokeWidth={1.8} />}>
                <select value={currency} onChange={(e) => setCurrency(e.target.value)} disabled={submitting} className="input">
                  {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </Field>
              <Field label="Fiscal year end" icon={<Calendar size={12} strokeWidth={1.8} />}>
                <select value={fiscalEnd} onChange={(e) => setFiscalEnd(e.target.value)} disabled={submitting} className="input">
                  {MONTHS.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </Field>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Reporting basis">
                <select value={reportingBasis} onChange={(e) => setReportingBasis(e.target.value)} disabled={submitting} className="input">
                  {REPORTING_BASIS.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </Field>
              <Field label="Accounting standard">
                <select value={accStd} onChange={(e) => setAccStd(e.target.value)} disabled={submitting} className="input">
                  {ACCOUNTING_STANDARDS.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </Field>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Books software (currently used)">
                <select value={booksSoftware} onChange={(e) => setBooksSoftware(e.target.value)} disabled={submitting} className="input">
                  {BOOKS_SOFTWARE.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </Field>
              <Field label="Default materiality (%)" icon={<Percent size={12} strokeWidth={1.8} />}>
                <input type="number" step="0.1" min="0" max="100"
                  value={materiality} onChange={(e) => setMateriality(e.target.value)}
                  placeholder="e.g. 1.0" disabled={submitting} className="input" />
              </Field>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="External auditor firm">
                <input value={auditorFirm} onChange={(e) => setAuditorFirm(e.target.value)}
                  placeholder="e.g. Smith & Co., or N/A" disabled={submitting} className="input" />
              </Field>
              <Field label="Auditor contact email" icon={<Mail size={12} strokeWidth={1.8} />}>
                <input type="email" value={auditorEmail} onChange={(e) => setAuditorEmail(e.target.value)}
                  placeholder="audit@example.com" disabled={submitting} className="input" />
              </Field>
            </div>
          </Section>

          {error && <p className="text-xs" style={{ color: "#dc2626" }}>{error}</p>}
        </form>

        {/* Sticky footer */}
        <div className="px-6 py-4 flex items-center justify-between gap-3 shrink-0"
          style={{ borderTop: "1px solid var(--border)", background: "var(--surface)" }}>
          <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
            * required
          </span>
          <div className="flex items-center gap-2">
            {allowDismiss && (
              <button type="button" onClick={onClose}
                className="rounded-lg px-3.5 py-2 text-sm font-medium hover:bg-black/5"
                style={{ color: "var(--text-muted)" }}>
                Cancel
              </button>
            )}
            <button
              type="submit"
              form="create-company-form"
              disabled={!canSubmit}
              className="flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
              style={{ background: "var(--green)" }}
            >
              {submitting ? <Spinner className="h-4 w-4" /> : <Sparkles size={14} strokeWidth={1.8} />}
              {submitting ? "Creating…" : "Create company"}
            </button>
          </div>
        </div>

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
          textarea.input { font-family: inherit; resize: vertical; line-height: 1.5; }
        `}</style>
      </motion.div>
    </motion.div>
  )
}

// ── Form helpers ─────────────────────────────────────────────────────────────

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-3 pb-1.5"
        style={{ borderBottom: "1px solid var(--border)" }}>
        <span className="inline-flex items-center justify-center h-5 w-5 rounded"
          style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
          {icon}
        </span>
        <h3 className="text-[11px] font-bold uppercase tracking-wider"
          style={{ color: "var(--text-2)" }}>
          {title}
        </h3>
      </div>
      <div className="space-y-3">
        {children}
      </div>
    </section>
  )
}

function Field({ label, icon, children }: { label: string; icon?: React.ReactNode; children: React.ReactNode }) {
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
