/**
 * CompanyForm — the shared 4-section "company details" form used by:
 *
 *   • Create Company page    /app/companies/new   (mode="create")
 *   • Company Settings page  /app/settings        (mode="edit")
 *
 * Only `name` is required. Everything else is optional but powers
 * future enhancements (AI commentary that knows the entity type and
 * accounting standard, audit-firm integrations, materiality defaults
 * for variance analysis, etc.).
 *
 * The extra fields persist per-org in localStorage today (keyed by
 * Clerk org id). When we promote this to backend tenant.settings JSONB,
 * only readMeta/writeMeta need to change — the form stays the same.
 */
import { useEffect, useMemo, useState } from "react"
import {
  Building2, Calendar, Globe, Briefcase, Users as UsersIcon,
  DollarSign, MapPin, Phone, Link as LinkIcon, Hash, Landmark,
  ShieldCheck, BookOpenText, Percent, Mail, Sparkles, Save,
} from "lucide-react"
import { Spinner } from "@/core/ui/components"

// ── Option lists (exported so callers can reuse the same labels) ─────────────

export const INDUSTRIES = [
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

export const SIZES = [
  { label: "Just me",        value: "1" },
  { label: "2–10",           value: "2-10" },
  { label: "11–50",          value: "11-50" },
  { label: "51–200",         value: "51-200" },
  { label: "201–1,000",      value: "201-1000" },
  { label: "1,000+",         value: "1000+" },
]

export const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "INR", "JPY", "CHF", "CNY", "BRL", "MXN", "SGD", "AED"]

export const COUNTRIES = [
  "United States", "Canada", "United Kingdom", "India", "Australia",
  "Germany", "France", "Singapore", "United Arab Emirates",
  "Ireland", "Netherlands", "Spain", "Mexico", "Brazil", "Japan",
  "Other",
]

export const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]

export const ENTITY_TYPES = [
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

export const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA",
  "ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK",
  "OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC",
]

export const REPORTING_BASIS = ["Accrual", "Cash", "Modified cash"]
export const ACCOUNTING_STANDARDS = ["US GAAP", "IFRS", "Other"]
export const BOOKS_SOFTWARE = [
  "QuickBooks Online", "QuickBooks Desktop", "Xero", "Sage Intacct",
  "NetSuite", "Wave", "FreshBooks", "Excel / Manual", "Other",
]

// ── Meta shape + localStorage helpers ────────────────────────────────────────

export interface CompanyMeta {
  // Section 1: Company
  legal_name?: string
  industry?: string
  description?: string
  size?: string
  founded_year?: string
  // Section 2: Address & Contact
  country?: string
  street?: string
  city?: string
  state_province?: string
  postal_code?: string
  phone?: string
  website?: string
  // Section 3: Tax & Legal
  entity_type?: string
  incorporation_state?: string
  tax_id?: string
  // Section 4: Accounting Setup
  base_currency?: string
  fiscal_year_end?: string
  reporting_basis?: string
  accounting_standard?: string
  books_software?: string
  materiality_threshold?: string
  auditor_firm?: string
  auditor_contact_email?: string
}

const META_KEY = (orgId: string) => `company_meta_${orgId}`

export function readMeta(orgId: string): CompanyMeta {
  try {
    const raw = localStorage.getItem(META_KEY(orgId))
    return raw ? JSON.parse(raw) as CompanyMeta : {}
  } catch {
    return {}
  }
}

export function writeMeta(orgId: string, meta: CompanyMeta): void {
  try {
    localStorage.setItem(META_KEY(orgId), JSON.stringify(meta))
  } catch {
    // localStorage may be full or disabled; not critical
  }
}

// ── Form ─────────────────────────────────────────────────────────────────────

export interface CompanyFormProps {
  /** Mode controls submit-button text and icon, not behaviour. */
  mode:           "create" | "edit"
  initialName:    string
  initialMeta:    CompanyMeta
  submitting:     boolean
  /** Inline error to show above the action bar. */
  error?:         string | null
  /** Status text to show next to the submit button (e.g. "Saved" toast). */
  statusText?:    string | null
  /** Called when the user hits the primary action. */
  onSubmit:       (name: string, meta: CompanyMeta) => void
  /** Called when the user hits Cancel (omit to hide the cancel button). */
  onCancel?:      () => void
}

export function CompanyForm({
  mode, initialName, initialMeta, submitting, error, statusText, onSubmit, onCancel,
}: CompanyFormProps) {
  // Section 1: Company
  const [name,          setName]          = useState(initialName)
  const [legalName,     setLegalName]     = useState(initialMeta.legal_name ?? "")
  const [industry,      setIndustry]      = useState(initialMeta.industry ?? INDUSTRIES[0])
  const [description,   setDescription]   = useState(initialMeta.description ?? "")
  const [size,          setSize]          = useState(initialMeta.size ?? SIZES[1].value)
  const [foundedYear,   setFoundedYear]   = useState(initialMeta.founded_year ?? "")

  // Section 2: Address & Contact
  const [country,       setCountry]       = useState(initialMeta.country ?? COUNTRIES[0])
  const [street,        setStreet]        = useState(initialMeta.street ?? "")
  const [city,          setCity]          = useState(initialMeta.city ?? "")
  const [stateProvince, setStateProvince] = useState(initialMeta.state_province ?? "")
  const [postalCode,    setPostalCode]    = useState(initialMeta.postal_code ?? "")
  const [phone,         setPhone]         = useState(initialMeta.phone ?? "")
  const [website,       setWebsite]       = useState(initialMeta.website ?? "")

  // Section 3: Tax & Legal
  const [entityType,    setEntityType]    = useState(initialMeta.entity_type ?? ENTITY_TYPES[0])
  const [incState,      setIncState]      = useState(initialMeta.incorporation_state ?? "")
  const [taxId,         setTaxId]         = useState(initialMeta.tax_id ?? "")

  // Section 4: Accounting Setup
  const [currency,      setCurrency]      = useState(initialMeta.base_currency ?? "USD")
  const [fiscalEnd,     setFiscalEnd]     = useState(initialMeta.fiscal_year_end ?? "December")
  const [reportingBasis,setReportingBasis]= useState(initialMeta.reporting_basis ?? REPORTING_BASIS[0])
  const [accStd,        setAccStd]        = useState(initialMeta.accounting_standard ?? ACCOUNTING_STANDARDS[0])
  const [booksSoftware, setBooksSoftware] = useState(initialMeta.books_software ?? BOOKS_SOFTWARE[0])
  const [materiality,   setMateriality]   = useState(initialMeta.materiality_threshold ?? "1.0")
  const [auditorFirm,   setAuditorFirm]   = useState(initialMeta.auditor_firm ?? "")
  const [auditorEmail,  setAuditorEmail]  = useState(initialMeta.auditor_contact_email ?? "")

  // When the parent swaps to a different org (e.g. user changes workspace
  // while on the settings page), the initial values change — re-seed the
  // form so it reflects the new org, not the previous one.
  useEffect(() => {
    setName(initialName)
    setLegalName(initialMeta.legal_name ?? "")
    setIndustry(initialMeta.industry ?? INDUSTRIES[0])
    setDescription(initialMeta.description ?? "")
    setSize(initialMeta.size ?? SIZES[1].value)
    setFoundedYear(initialMeta.founded_year ?? "")
    setCountry(initialMeta.country ?? COUNTRIES[0])
    setStreet(initialMeta.street ?? "")
    setCity(initialMeta.city ?? "")
    setStateProvince(initialMeta.state_province ?? "")
    setPostalCode(initialMeta.postal_code ?? "")
    setPhone(initialMeta.phone ?? "")
    setWebsite(initialMeta.website ?? "")
    setEntityType(initialMeta.entity_type ?? ENTITY_TYPES[0])
    setIncState(initialMeta.incorporation_state ?? "")
    setTaxId(initialMeta.tax_id ?? "")
    setCurrency(initialMeta.base_currency ?? "USD")
    setFiscalEnd(initialMeta.fiscal_year_end ?? "December")
    setReportingBasis(initialMeta.reporting_basis ?? REPORTING_BASIS[0])
    setAccStd(initialMeta.accounting_standard ?? ACCOUNTING_STANDARDS[0])
    setBooksSoftware(initialMeta.books_software ?? BOOKS_SOFTWARE[0])
    setMateriality(initialMeta.materiality_threshold ?? "1.0")
    setAuditorFirm(initialMeta.auditor_firm ?? "")
    setAuditorEmail(initialMeta.auditor_contact_email ?? "")
  }, [initialName, initialMeta])

  const canSubmit = useMemo(() => name.trim().length > 0 && !submitting, [name, submitting])
  const isUS = country === "United States"

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    const trim = (v: string) => v.trim() || undefined
    onSubmit(name.trim(), {
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
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-7">

      {/* ── Section 1: Company ─────────────────────────────────── */}
      <Section title="Company" icon={<Building2 size={13} strokeWidth={1.8} />}>
        <Field label="Company name *" icon={<Building2 size={12} strokeWidth={1.8} />}>
          <input
            type="text" autoFocus value={name} onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Acme Accounting, Smith CPA"
            disabled={submitting} className="cf-input" required
          />
        </Field>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Legal name (if different)" icon={<Landmark size={12} strokeWidth={1.8} />}>
            <input value={legalName} onChange={(e) => setLegalName(e.target.value)}
              placeholder="e.g. Acme Accounting, LLC" disabled={submitting} className="cf-input" />
          </Field>
          <Field label="Industry" icon={<Briefcase size={12} strokeWidth={1.8} />}>
            <select value={industry} onChange={(e) => setIndustry(e.target.value)} disabled={submitting} className="cf-input">
              {INDUSTRIES.map((i) => <option key={i} value={i}>{i}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Brief description (helps AI commentary)" icon={<BookOpenText size={12} strokeWidth={1.8} />}>
          <textarea
            value={description} onChange={(e) => setDescription(e.target.value)}
            placeholder="1–2 sentences about what the company does. e.g. 'Boutique tax & advisory firm serving early-stage SaaS founders.'"
            disabled={submitting} className="cf-input min-h-[60px]" rows={2} maxLength={400}
          />
        </Field>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Company size" icon={<UsersIcon size={12} strokeWidth={1.8} />}>
            <select value={size} onChange={(e) => setSize(e.target.value)} disabled={submitting} className="cf-input">
              {SIZES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </Field>
          <Field label="Founded year" icon={<Calendar size={12} strokeWidth={1.8} />}>
            <input type="number" min={1800} max={new Date().getFullYear()}
              value={foundedYear} onChange={(e) => setFoundedYear(e.target.value)}
              placeholder="e.g. 2018" disabled={submitting} className="cf-input" />
          </Field>
        </div>
      </Section>

      {/* ── Section 2: Address & Contact ───────────────────────── */}
      <Section title="Address & Contact" icon={<MapPin size={13} strokeWidth={1.8} />}>
        <Field label="Country" icon={<Globe size={12} strokeWidth={1.8} />}>
          <select value={country} onChange={(e) => setCountry(e.target.value)} disabled={submitting} className="cf-input">
            {COUNTRIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="Street address" icon={<MapPin size={12} strokeWidth={1.8} />}>
          <input value={street} onChange={(e) => setStreet(e.target.value)}
            placeholder="123 Main St, Suite 200" disabled={submitting} className="cf-input" />
        </Field>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field label="City">
            <input value={city} onChange={(e) => setCity(e.target.value)} disabled={submitting} className="cf-input" />
          </Field>
          <Field label={isUS ? "State" : "State / Province"}>
            {isUS ? (
              <select value={stateProvince} onChange={(e) => setStateProvince(e.target.value)} disabled={submitting} className="cf-input">
                <option value="">—</option>
                {US_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            ) : (
              <input value={stateProvince} onChange={(e) => setStateProvince(e.target.value)} disabled={submitting} className="cf-input" />
            )}
          </Field>
          <Field label="Postal code">
            <input value={postalCode} onChange={(e) => setPostalCode(e.target.value)} disabled={submitting} className="cf-input" />
          </Field>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Phone" icon={<Phone size={12} strokeWidth={1.8} />}>
            <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)}
              placeholder="+1 (555) 123-4567" disabled={submitting} className="cf-input" />
          </Field>
          <Field label="Website" icon={<LinkIcon size={12} strokeWidth={1.8} />}>
            <input type="url" value={website} onChange={(e) => setWebsite(e.target.value)}
              placeholder="https://example.com" disabled={submitting} className="cf-input" />
          </Field>
        </div>
      </Section>

      {/* ── Section 3: Tax & Legal ─────────────────────────────── */}
      <Section title="Tax & Legal" icon={<ShieldCheck size={13} strokeWidth={1.8} />}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Entity type" icon={<Landmark size={12} strokeWidth={1.8} />}>
            <select value={entityType} onChange={(e) => setEntityType(e.target.value)} disabled={submitting} className="cf-input">
              {ENTITY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          {isUS && (
            <Field label="State of incorporation">
              <select value={incState} onChange={(e) => setIncState(e.target.value)} disabled={submitting} className="cf-input">
                <option value="">—</option>
                {US_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
          )}
        </div>
        <Field label={isUS ? "EIN (Tax ID)" : "Tax ID / business registration #"} icon={<Hash size={12} strokeWidth={1.8} />}>
          <input value={taxId} onChange={(e) => setTaxId(e.target.value)}
            placeholder={isUS ? "00-0000000" : "Tax / registration number"}
            disabled={submitting} className="cf-input" />
        </Field>
      </Section>

      {/* ── Section 4: Accounting Setup ────────────────────────── */}
      <Section title="Accounting Setup" icon={<BookOpenText size={13} strokeWidth={1.8} />}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Base currency" icon={<DollarSign size={12} strokeWidth={1.8} />}>
            <select value={currency} onChange={(e) => setCurrency(e.target.value)} disabled={submitting} className="cf-input">
              {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Fiscal year end" icon={<Calendar size={12} strokeWidth={1.8} />}>
            <select value={fiscalEnd} onChange={(e) => setFiscalEnd(e.target.value)} disabled={submitting} className="cf-input">
              {MONTHS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Reporting basis">
            <select value={reportingBasis} onChange={(e) => setReportingBasis(e.target.value)} disabled={submitting} className="cf-input">
              {REPORTING_BASIS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </Field>
          <Field label="Accounting standard">
            <select value={accStd} onChange={(e) => setAccStd(e.target.value)} disabled={submitting} className="cf-input">
              {ACCOUNTING_STANDARDS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Books software (currently used)">
            <select value={booksSoftware} onChange={(e) => setBooksSoftware(e.target.value)} disabled={submitting} className="cf-input">
              {BOOKS_SOFTWARE.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </Field>
          <Field label="Default materiality (%)" icon={<Percent size={12} strokeWidth={1.8} />}>
            <input type="number" step="0.1" min="0" max="100"
              value={materiality} onChange={(e) => setMateriality(e.target.value)}
              placeholder="e.g. 1.0" disabled={submitting} className="cf-input" />
          </Field>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="External auditor firm">
            <input value={auditorFirm} onChange={(e) => setAuditorFirm(e.target.value)}
              placeholder="e.g. Smith & Co., or N/A" disabled={submitting} className="cf-input" />
          </Field>
          <Field label="Auditor contact email" icon={<Mail size={12} strokeWidth={1.8} />}>
            <input type="email" value={auditorEmail} onChange={(e) => setAuditorEmail(e.target.value)}
              placeholder="audit@example.com" disabled={submitting} className="cf-input" />
          </Field>
        </div>
      </Section>

      {error && <p className="text-xs" style={{ color: "#dc2626" }}>{error}</p>}

      {/* Action bar */}
      <div className="flex items-center justify-between gap-3 pt-3"
        style={{ borderTop: "1px solid var(--border)" }}>
        <div className="text-[11px] flex items-center gap-2" style={{ color: "var(--text-muted)" }}>
          <span>* required</span>
          {statusText && (
            <span className="inline-flex items-center gap-1" style={{ color: "var(--green)" }}>
              <span className="h-1 w-1 rounded-full" style={{ background: "var(--green)" }} />
              {statusText}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {onCancel && (
            <button type="button" onClick={onCancel}
              className="rounded-lg px-3.5 py-2 text-sm font-medium hover:bg-black/5"
              style={{ color: "var(--text-muted)" }}>
              Cancel
            </button>
          )}
          <button
            type="submit"
            disabled={!canSubmit}
            className="flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            style={{ background: "var(--green)" }}
          >
            {submitting ? (
              <Spinner className="h-4 w-4" />
            ) : mode === "create" ? (
              <Sparkles size={14} strokeWidth={1.8} />
            ) : (
              <Save size={14} strokeWidth={1.8} />
            )}
            {submitting ? (mode === "create" ? "Creating…" : "Saving…")
              : mode === "create" ? "Create company"
              : "Save changes"}
          </button>
        </div>
      </div>

      {/* Component-scoped styles. .cf-input avoids clashing with any
          existing .input class elsewhere in the app. */}
      <style>{`
        .cf-input {
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
        .cf-input:focus { border-color: var(--green); }
        .cf-input:disabled { opacity: 0.6; }
        textarea.cf-input { font-family: inherit; resize: vertical; line-height: 1.5; }
      `}</style>
    </form>
  )
}

// ── Small layout helpers used by the form ────────────────────────────────────

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
