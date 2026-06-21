/**
 * Settings — SaaS-style settings hub with a left sub-nav and animated
 * content panels on the right.
 *
 * Sections:
 *   • Company         — full company-profile form (4 sub-sections inside)
 *   • Profile         — read-only user info from Clerk + role chip
 *   • Workspaces      — list/switch/create company workspaces
 *   • Team            — member count + link to /app/team
 *   • Notifications   — preference toggles (local for now, backend sync TODO)
 *   • AI Preferences  — Agentic defaults, materiality, commentary style
 *   • Appearance      — theme + density
 *   • Data & Export   — audit log + reconciliations export
 *   • About           — version, docs, contact
 *
 * Section state lives in the URL (?tab=…) so it's shareable and the
 * browser back button works. Transitions are AnimatePresence mode="wait"
 * with a short fade+slide so sections don't pop.
 */
import { useEffect, useMemo, useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import {
  useOrganization,
  useOrganizationList,
  useUser,
  UserButton,
} from "@clerk/clerk-react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { notificationsApi } from "@/modules/notifications/api"
import { motion, AnimatePresence } from "framer-motion"
import {
  Building2, User, Briefcase, Users as UsersIcon, Bell, Sparkles,
  Palette, Download, Info, ArrowRight, Plus, Mail, ExternalLink,
  CheckCircle2, FileDown, AlertTriangle, ShieldCheck, BookOpen, Brain, Rocket,
  type LucideIcon,
} from "lucide-react"
import { MemorySection } from "@/modules/memory/MemorySection"
import { AutopilotSection } from "@/modules/autopilot/AutopilotSection"
import { Spinner } from "@/core/ui/components"
import { SkeletonBlock } from "@/core/ui/Skeleton"
import { ThemeToggle } from "@/core/theme/ThemeToggle"
import { DatePicker } from "@/core/ui/DatePicker"
import { apiClient } from "@/core/api/client"
import { formatDate, toISODate } from "@/core/lib/dates"
import { workspaceApi, type WorkspaceMember, type AiUsage } from "@/modules/workspace/api"
import {
  CompanyForm, readMeta, writeMeta, type CompanyMeta,
} from "@/modules/onboarding/components/CompanyForm"

// ── Section registry ─────────────────────────────────────────────────────────

type SectionKey =
  | "company" | "profile" | "workspaces" | "team"
  | "notifications" | "ai" | "autopilot" | "memory" | "appearance" | "data" | "about"

interface SectionDef {
  key:   SectionKey
  label: string
  icon:  LucideIcon
  hint?: string  // micro-copy in the sub-nav
}

const SECTIONS: SectionDef[] = [
  { key: "company",       label: "Company",         icon: Building2,  hint: "Profile, address, tax, accounting" },
  { key: "profile",       label: "Profile",         icon: User,       hint: "Your account info" },
  { key: "workspaces",    label: "Workspaces",      icon: Briefcase,  hint: "Switch or create company" },
  { key: "team",          label: "Team",            icon: UsersIcon,  hint: "Members and roles" },
  { key: "notifications", label: "Notifications",   icon: Bell,       hint: "Email and in-app alerts" },
  { key: "ai",            label: "AI preferences",  icon: Sparkles,   hint: "Agentic, materiality, tone" },
  { key: "autopilot",     label: "Close Autopilot", icon: Rocket,     hint: "Scheduled month-end automation" },
  { key: "memory",        label: "Client memory",   icon: Brain,      hint: "What the AI has learned" },
  { key: "appearance",    label: "Appearance",      icon: Palette,    hint: "Theme and density" },
  { key: "data",          label: "Data & export",   icon: Download,   hint: "Audit log, exports" },
  { key: "about",         label: "About",           icon: Info,       hint: "Version, docs, support" },
]

// ── Root ─────────────────────────────────────────────────────────────────────

export function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const tabFromUrl = searchParams.get("tab") as SectionKey | null
  const initialTab: SectionKey = SECTIONS.some((s) => s.key === tabFromUrl)
    ? (tabFromUrl as SectionKey)
    : "company"
  const [active, setActive] = useState<SectionKey>(initialTab)

  // Reflect tab changes back to the URL so the section is shareable
  // and the browser back button cycles between sections.
  useEffect(() => {
    const current = searchParams.get("tab")
    if (current !== active) {
      const next = new URLSearchParams(searchParams)
      next.set("tab", active)
      setSearchParams(next, { replace: true })
    }
  }, [active, searchParams, setSearchParams])

  // Sync the other direction too (e.g. user clicks a link to a
  // specific tab from outside the page).
  useEffect(() => {
    if (tabFromUrl && SECTIONS.some((s) => s.key === tabFromUrl) && tabFromUrl !== active) {
      setActive(tabFromUrl)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabFromUrl])

  return (
    <div className="flex flex-col h-full overflow-hidden" style={{ background: "var(--bg)" }}>
      {/* Header */}
      <div className="px-4 sm:px-8 py-5 sm:py-6 shrink-0"
        style={{ borderBottom: "1px solid var(--border)", background: "var(--surface)" }}>
        <div className="max-w-6xl mx-auto">
          <h1 className="text-lg sm:text-xl font-bold text-theme leading-tight lg:hidden">Settings</h1>
          <p className="text-xs sm:text-sm mt-1" style={{ color: "var(--text-muted)" }}>
            Manage your company profile, account, preferences, and exports.
          </p>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-hidden">
        <div className="max-w-6xl mx-auto h-full flex flex-col sm:flex-row gap-0 sm:gap-6 px-4 sm:px-8 pt-5 sm:pt-7 pb-6">
          <SubNav active={active} onSelect={setActive} />

          {/* Content panel */}
          <div className="flex-1 min-w-0 overflow-y-auto pb-6">
            <AnimatePresence mode="wait">
              <motion.div
                key={active}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.2, ease: "easeOut" }}
                className="space-y-5"
              >
                {active === "company"       && <CompanySection />}
                {active === "profile"       && <ProfileSection />}
                {active === "workspaces"    && <WorkspacesSection />}
                {active === "team"          && <TeamSection />}
                {active === "notifications" && <NotificationsSection />}
                {active === "ai"            && <AIPreferencesSection />}
                {active === "autopilot"     && <AutopilotSection />}
                {active === "memory"        && <MemorySection />}
                {active === "appearance"    && <AppearanceSection />}
                {active === "data"          && <DataExportSection />}
                {active === "about"         && <AboutSection />}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Sub-navigation ───────────────────────────────────────────────────────────

function SubNav({ active, onSelect }: { active: SectionKey; onSelect: (k: SectionKey) => void }) {
  return (
    <>
      {/* Mobile: horizontal scroll strip of pills */}
      <nav className="sm:hidden -mx-4 px-4 pb-4 overflow-x-auto"
        style={{ scrollbarWidth: "none" }}>
        <div className="flex items-center gap-2 min-w-max">
          {SECTIONS.map((s) => {
            const Icon = s.icon
            const isActive = s.key === active
            return (
              <button
                key={s.key}
                onClick={() => onSelect(s.key)}
                className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-all"
                style={{
                  background: isActive ? "var(--green-subtle)" : "var(--surface)",
                  color:      isActive ? "var(--green)"        : "var(--text-2)",
                  border:     `1px solid ${isActive ? "var(--green)" : "var(--border)"}`,
                }}
              >
                <Icon size={12} strokeWidth={1.8} />
                {s.label}
              </button>
            )
          })}
        </div>
      </nav>

      {/* Desktop: vertical sub-nav */}
      <aside className="hidden sm:block w-56 shrink-0">
        <div className="sticky top-0 space-y-0.5">
          {SECTIONS.map((s) => {
            const Icon = s.icon
            const isActive = s.key === active
            return (
              <button
                key={s.key}
                onClick={() => onSelect(s.key)}
                className="w-full text-left group/btn relative rounded-lg px-3 py-2.5 transition-all"
                style={{
                  background: isActive ? "var(--green-subtle)" : "transparent",
                }}
                onMouseEnter={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.background = "var(--surface)" }}
                onMouseLeave={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.background = "transparent" }}
              >
                {/* Active indicator bar */}
                {isActive && (
                  <motion.span
                    layoutId="settings-active-indicator"
                    className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r"
                    style={{ background: "var(--green)" }}
                    transition={{ type: "spring", stiffness: 380, damping: 30 }}
                  />
                )}
                <div className="flex items-center gap-2.5">
                  <Icon
                    size={15}
                    strokeWidth={1.8}
                    style={{ color: isActive ? "var(--green)" : "var(--text-muted)" }}
                  />
                  <div className="flex-1 min-w-0">
                    <p
                      className="text-sm font-semibold leading-tight"
                      style={{ color: isActive ? "var(--green)" : "var(--text)" }}
                    >
                      {s.label}
                    </p>
                    {s.hint && (
                      <p className="text-[10px] mt-0.5 truncate" style={{ color: "var(--text-muted)" }}>
                        {s.hint}
                      </p>
                    )}
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      </aside>
    </>
  )
}

// ── Section shell ────────────────────────────────────────────────────────────

function SectionShell({
  title, description, icon: Icon, badge, children,
}: {
  title:       string
  description: string
  icon:        LucideIcon
  badge?:      React.ReactNode
  children:    React.ReactNode
}) {
  return (
    <section className="rounded-2xl"
      style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
      <div className="px-6 py-5"
        style={{ borderBottom: "1px solid var(--border)" }}>
        <div className="flex items-start gap-3">
          <span className="h-9 w-9 rounded-lg flex items-center justify-center shrink-0"
            style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
            <Icon size={17} strokeWidth={1.8} />
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base font-bold text-theme leading-tight">{title}</h2>
              {badge}
            </div>
            <p className="text-xs sm:text-[13px] mt-1" style={{ color: "var(--text-muted)" }}>
              {description}
            </p>
          </div>
        </div>
      </div>
      <div className="p-6">
        {children}
      </div>
    </section>
  )
}

function ComingSoonBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold"
      style={{ background: "var(--surface-2)", color: "var(--text-2)", border: "1px solid var(--border)" }}>
      Coming soon
    </span>
  )
}

function LocalOnlyBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold"
      style={{ background: "#f4eddf", color: "#7a5622" }}>
      Saved locally
    </span>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTIONS
// ─────────────────────────────────────────────────────────────────────────────

function CompanySection() {
  const { organization, isLoaded } = useOrganization()
  const [submitting, setSubmitting] = useState(false)
  const [error,      setError]      = useState<string | null>(null)
  const [savedAt,    setSavedAt]    = useState<number | null>(null)

  const initialMeta: CompanyMeta = useMemo(
    () => (organization ? readMeta(organization.id) : {}),
    [organization?.id],
  )

  useEffect(() => {
    if (!savedAt) return
    const t = setTimeout(() => setSavedAt(null), 2500)
    return () => clearTimeout(t)
  }, [savedAt])

  if (!isLoaded) return (
    <SectionShell title="Company" description="Profile, address, tax info, and accounting defaults." icon={Building2}>
      <div className="space-y-6">
        <SkeletonBlock height={40} />
        <SkeletonBlock height={80} />
        <SkeletonBlock height={120} />
      </div>
    </SectionShell>
  )
  if (!organization) {
    return (
      <SectionShell title="Company" description="Select a workspace to edit company details." icon={Building2}>
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>No active workspace.</p>
      </SectionShell>
    )
  }

  async function handleSubmit(name: string, meta: CompanyMeta) {
    if (!organization) return
    setError(null)
    setSubmitting(true)
    try {
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
    <SectionShell
      title="Company"
      description={`Profile, address, tax info, and accounting defaults for ${organization.name}. Powers AI commentary, future audit-firm integrations, and materiality defaults.`}
      icon={Building2}
    >
      <CompanyForm
        key={organization.id}
        mode="edit"
        initialName={organization.name ?? ""}
        initialMeta={initialMeta}
        submitting={submitting}
        error={error}
        statusText={savedAt ? "Saved" : null}
        onSubmit={handleSubmit}
      />
    </SectionShell>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

function ProfileSection() {
  const { user, isLoaded: userLoaded } = useUser()
  const { organization } = useOrganization()
  const { data: me } = useQuery({
    queryKey: ["workspace-me"],
    queryFn:  workspaceApi.getMe,
    staleTime: 10 * 60_000,
    enabled:  !!organization,
  })

  if (!userLoaded) return (
    <SectionShell title="Profile" description="Your personal account." icon={User}>
      <div className="space-y-4">
        <div className="flex items-start gap-4 mb-6">
          <SkeletonBlock width={56} height={56} radius={8} className="shrink-0" />
          <div className="flex-1 space-y-2">
            <SkeletonBlock height={20} width="60%" />
            <SkeletonBlock height={16} width="40%" />
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <SkeletonBlock height={70} />
          <SkeletonBlock height={70} />
          <SkeletonBlock height={70} />
          <SkeletonBlock height={70} />
        </div>
      </div>
    </SectionShell>
  )
  if (!user) return null

  const displayName = [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username || "—"
  const primaryEmail = user.primaryEmailAddress?.emailAddress ?? "—"
  const role = me?.role ?? "—"

  return (
    <SectionShell
      title="Profile"
      description="Your personal account. Name + email are managed in Clerk — use the account menu to edit them."
      icon={User}
    >
      <div className="flex items-start gap-4 mb-6">
        <div className="shrink-0">
          <UserButton
            afterSignOutUrl="/sign-in"
            appearance={{ elements: { avatarBox: "h-14 w-14" } }}
          />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-base font-bold text-theme">{displayName}</p>
          <p className="text-sm mt-0.5" style={{ color: "var(--text-muted)" }}>{primaryEmail}</p>
          {organization && (
            <div className="flex items-center gap-2 mt-2">
              <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
                <ShieldCheck size={10} strokeWidth={2} />
                {role}
              </span>
              <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                in {organization.name}
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <ReadOnlyField label="Full name"     value={displayName} />
        <ReadOnlyField label="Primary email" value={primaryEmail} />
        <ReadOnlyField label="User ID"       value={user.id} mono />
        <ReadOnlyField label="Joined"        value={formatDate(user.createdAt) || "—"} />
      </div>

      <p className="text-[11px] mt-5" style={{ color: "var(--text-muted)" }}>
        To change your name, email, or password, click your avatar above and choose
        <span className="font-medium" style={{ color: "var(--text-2)" }}> Manage account</span>.
      </p>
    </SectionShell>
  )
}

function ReadOnlyField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg px-3 py-2.5"
      style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
      <p className="text-[10px] font-semibold uppercase tracking-wider mb-0.5"
        style={{ color: "var(--text-muted)" }}>
        {label}
      </p>
      <p className={`text-sm ${mono ? "font-mono text-xs" : ""}`} style={{ color: "var(--text)" }}>
        {value}
      </p>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

function WorkspacesSection() {
  const navigate = useNavigate()
  const { organization } = useOrganization()
  const { userMemberships, setActive } = useOrganizationList({
    userMemberships: { infinite: true },
  })
  const [switching, setSwitching] = useState<string | null>(null)

  const memberships = userMemberships?.data ?? []

  async function selectCompany(orgId: string) {
    if (!setActive) return
    setSwitching(orgId)
    try {
      await setActive({ organization: orgId })
      setTimeout(() => navigate("/app"), 50)
    } finally {
      // route change clears this
    }
  }

  return (
    <SectionShell
      title="Workspaces"
      description="Switch between companies you're a member of, or create a new one. Each workspace has its own QuickBooks, books, team, and data."
      icon={Briefcase}
    >
      <div className="space-y-2 mb-5">
        {memberships.length === 0 ? (
          <p className="text-sm py-2" style={{ color: "var(--text-muted)" }}>
            No workspaces yet. Create your first one below.
          </p>
        ) : memberships.map((m) => {
          const org = m.organization
          const meta = readMeta(org.id)
          const isActive = organization?.id === org.id
          const isSwitching = switching === org.id
          return (
            <button
              key={org.id}
              onClick={() => !isActive && selectCompany(org.id)}
              disabled={isActive || switching !== null}
              className="w-full rounded-xl p-4 text-left transition-all disabled:cursor-not-allowed"
              style={{
                background: isActive ? "var(--green-subtle)" : "var(--surface-2)",
                border: `1px solid ${isActive ? "var(--green)" : "var(--border)"}`,
              }}
              onMouseEnter={(e) => { if (!isActive && switching === null) (e.currentTarget as HTMLElement).style.borderColor = "var(--green)" }}
              onMouseLeave={(e) => { if (!isActive && switching === null) (e.currentTarget as HTMLElement).style.borderColor = "var(--border)" }}
            >
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 rounded-lg flex items-center justify-center shrink-0"
                  style={{ background: "var(--surface)", color: "var(--green)" }}>
                  <Building2 size={16} strokeWidth={1.8} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-theme truncate">
                    {org.name}
                    {isActive && (
                      <span className="ml-2 inline-flex items-center gap-0.5 text-[10px] font-bold uppercase tracking-wider"
                        style={{ color: "var(--green)" }}>
                        <CheckCircle2 size={11} strokeWidth={2.5} /> Active
                      </span>
                    )}
                  </p>
                  <p className="text-[11px] mt-0.5 truncate" style={{ color: "var(--text-muted)" }}>
                    {meta.industry ?? "Workspace"}
                    {meta.size ? ` · ${meta.size} people` : ""}
                    {meta.base_currency ? ` · ${meta.base_currency}` : ""}
                    {meta.fiscal_year_end ? ` · FY ends ${meta.fiscal_year_end}` : ""}
                  </p>
                </div>
                {isSwitching ? <Spinner className="h-4 w-4" />
                  : !isActive && <ArrowRight size={14} strokeWidth={1.8} style={{ color: "var(--text-muted)" }} />}
              </div>
            </button>
          )
        })}
      </div>

      <button
        onClick={() => navigate("/app/companies/new")}
        className="w-full inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90 transition-opacity"
        style={{ background: "var(--green)" }}
      >
        <Plus size={14} strokeWidth={2} />
        Create new company
      </button>
    </SectionShell>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

function TeamSection() {
  const { organization } = useOrganization()
  const { data: members = [], isLoading } = useQuery<WorkspaceMember[]>({
    queryKey: ["workspace-members"],
    queryFn:  workspaceApi.listMembers,
    enabled:  !!organization,
    staleTime: 60_000,
  })

  return (
    <SectionShell
      title="Team"
      description={
        organization
          ? `Members of ${organization.name}. To invite, change roles, or revoke access, open the Team page.`
          : "Select a workspace to manage team members."
      }
      icon={UsersIcon}
    >
      {isLoading ? (
        <Spinner className="h-5 w-5" />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3 mb-5">
            <Stat label="Members"     value={String(members.length)} />
            <Stat label="Admins"      value={String(members.filter((m) => /admin/i.test(m.role)).length)} />
            <Stat label="Active org"  value={organization?.name ?? "—"} />
          </div>

          {members.length > 0 && (
            <div className="space-y-1.5 mb-5">
              {members.slice(0, 5).map((m) => (
                <div key={m.clerk_user_id} className="flex items-center justify-between rounded-lg px-3 py-2"
                  style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate" style={{ color: "var(--text)" }}>
                      {m.display_name || m.email || "—"}
                    </p>
                    {m.email && m.display_name && (
                      <p className="text-[11px] truncate" style={{ color: "var(--text-muted)" }}>{m.email}</p>
                    )}
                  </div>
                  <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded"
                    style={{ background: "var(--surface)", color: "var(--text-muted)" }}>
                    {m.role}
                  </span>
                </div>
              ))}
              {members.length > 5 && (
                <p className="text-[11px] pt-1" style={{ color: "var(--text-muted)" }}>
                  …and {members.length - 5} more
                </p>
              )}
            </div>
          )}

          <Link to="/app/team"
            className="inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-semibold transition-opacity hover:opacity-90"
            style={{ background: "var(--green)", color: "white" }}>
            <UsersIcon size={14} strokeWidth={2} />
            Open team page
            <ArrowRight size={12} strokeWidth={2} />
          </Link>
        </>
      )}
    </SectionShell>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg p-3"
      style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
      <p className="text-[10px] font-semibold uppercase tracking-wider"
        style={{ color: "var(--text-muted)" }}>
        {label}
      </p>
      <p className="text-base font-bold mt-1 truncate" style={{ color: "var(--text)" }}>{value}</p>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

interface NotifPrefs {
  email_due_date_reminders: boolean
  email_recon_approved:     boolean
  email_period_close:       boolean
  inapp_task_assigned:      boolean
  inapp_recon_ready:        boolean
  digest_frequency:         "off" | "daily" | "weekly"
}

const NOTIF_DEFAULTS: NotifPrefs = {
  email_due_date_reminders: true,
  email_recon_approved:     true,
  email_period_close:       true,
  inapp_task_assigned:      true,
  inapp_recon_ready:        true,
  digest_frequency:         "weekly",
}

function NotificationsSection() {
  const { organization } = useOrganization()
  const storageKey = organization ? `notif_prefs_${organization.id}` : "notif_prefs_default"
  const [prefs, setPrefs] = useState<NotifPrefs>(NOTIF_DEFAULTS)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey)
      if (raw) setPrefs({ ...NOTIF_DEFAULTS, ...JSON.parse(raw) })
      else setPrefs(NOTIF_DEFAULTS)
    } catch { /* ignore */ }
  }, [storageKey])

  useEffect(() => {
    if (!savedAt) return
    const t = setTimeout(() => setSavedAt(null), 2000)
    return () => clearTimeout(t)
  }, [savedAt])

  function update<K extends keyof NotifPrefs>(key: K, value: NotifPrefs[K]) {
    const next = { ...prefs, [key]: value }
    setPrefs(next)
    try {
      localStorage.setItem(storageKey, JSON.stringify(next))
      setSavedAt(Date.now())
    } catch { /* ignore */ }
  }

  // The real, backend-backed master switch for notification emails.
  const qc = useQueryClient()
  const { data: emailPref } = useQuery({
    queryKey: ["notification-preferences"],
    queryFn:  notificationsApi.getPreferences,
    staleTime: 5 * 60_000,
  })
  const emailOn = emailPref?.email_notifications_enabled ?? true
  const setEmailPref = useMutation({
    mutationFn: (enabled: boolean) =>
      notificationsApi.setPreferences({ email_notifications_enabled: enabled }),
    onMutate: async (enabled: boolean) => {
      await qc.cancelQueries({ queryKey: ["notification-preferences"] })
      const prev = qc.getQueryData(["notification-preferences"])
      qc.setQueryData(["notification-preferences"], { email_notifications_enabled: enabled })
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["notification-preferences"], ctx.prev)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["notification-preferences"] }),
  })

  return (
    <SectionShell
      title="Notifications"
      description="Choose how Nordavix lets you know about workflow events. The email switch below is live; the finer-grained controls save on this device for now."
      icon={Bell}
    >
      <div className="space-y-5">
        <PrefGroup title="Email notifications">
          <Toggle
            label="Email me about notifications"
            hint="Mentions, task assignments, review-ready, and period closes. Off = in-app bell only."
            value={emailOn}
            onChange={(v) => setEmailPref.mutate(v)}
          />
        </PrefGroup>

        <PrefGroup title="More email (coming soon)">
          <Toggle label="Due-date reminders"         hint="Heads-up the day before a task is due."
            value={prefs.email_due_date_reminders} onChange={(v) => update("email_due_date_reminders", v)} />
          <Toggle label="Reconciliation approved"    hint="When someone approves your prepared work."
            value={prefs.email_recon_approved}     onChange={(v) => update("email_recon_approved", v)} />
          <Toggle label="Period closed"              hint="When the books for a month are locked."
            value={prefs.email_period_close}       onChange={(v) => update("email_period_close", v)} />
        </PrefGroup>

        <PrefGroup title="In-app">
          <Toggle label="Task assigned to you"
            value={prefs.inapp_task_assigned}      onChange={(v) => update("inapp_task_assigned", v)} />
          <Toggle label="Reconciliation ready for review"
            value={prefs.inapp_recon_ready}        onChange={(v) => update("inapp_recon_ready", v)} />
        </PrefGroup>

        <PrefGroup title="Digest">
          <Radio name="digest" label="Off"    value="off"
            checked={prefs.digest_frequency === "off"}    onChange={() => update("digest_frequency", "off")} />
          <Radio name="digest" label="Daily"  value="daily"
            checked={prefs.digest_frequency === "daily"}  onChange={() => update("digest_frequency", "daily")} />
          <Radio name="digest" label="Weekly" value="weekly"
            checked={prefs.digest_frequency === "weekly"} onChange={() => update("digest_frequency", "weekly")} />
        </PrefGroup>

        {savedAt && (
          <p className="text-[11px] inline-flex items-center gap-1" style={{ color: "var(--green)" }}>
            <CheckCircle2 size={11} strokeWidth={2.5} /> Saved
          </p>
        )}
      </div>
    </SectionShell>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

interface AIPrefs {
  agentic_default_on:        boolean
  default_materiality_pct:   string  // numeric string e.g. "1.0"
  commentary_style:          "concise" | "standard" | "detailed"
  commentary_tone:           "professional" | "friendly" | "audit-grade"
  show_source_citations:     boolean
}

const AI_DEFAULTS: AIPrefs = {
  agentic_default_on:      false,
  default_materiality_pct: "1.0",
  commentary_style:        "standard",
  commentary_tone:         "professional",
  show_source_citations:   true,
}

/**
 * AI usage this month vs the workspace cap. Real backend data (AIUsage ledger).
 * Shows a spend bar; turns amber/red as the cap approaches so users aren't
 * surprised by a hard block. When no dollar cap is configured it just reports
 * the running spend ("tracking only").
 */
function AiUsageCard() {
  const { organization } = useOrganization()
  const { data, isLoading } = useQuery<AiUsage>({
    queryKey: ["workspace-ai-usage"],
    queryFn:  workspaceApi.getAiUsage,
    enabled:  !!organization,
    staleTime: 60_000,
  })

  const hasCap = (data?.cap_usd ?? 0) > 0
  const spent = data?.spent_usd ?? 0
  const cap = data?.cap_usd ?? 0
  const pct = hasCap ? Math.min(100, Math.round((spent / cap) * 100)) : 0
  const near = hasCap && pct >= 80 && !data?.exceeded
  const over = !!data?.exceeded
  const barColor = over ? "#9b3d37" : near ? "#9a6b2e" : "var(--green)"
  const resetLabel = data?.resets_at ? formatDate(data.resets_at) : "—"

  // Show the meter in abstract "credits" rather than raw dollars. 1 credit = $0.01,
  // so a $25 monthly cap reads as 2,500 credits. Purely presentational — the
  // backend still tracks and enforces in USD. Change CREDITS_PER_USD to re-scale.
  const CREDITS_PER_USD = 100
  const creditsSpent = spent > 0 ? Math.max(1, Math.round(spent * CREDITS_PER_USD)) : 0
  const creditsCap = Math.round(cap * CREDITS_PER_USD)

  return (
    <div className="rounded-xl p-4"
      style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <Sparkles size={14} strokeWidth={1.8} style={{ color: "var(--green)" }} />
          <p className="text-sm font-semibold" style={{ color: "var(--text)" }}>AI credits this month</p>
        </div>
        {hasCap && (
          <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full"
            style={{
              background: over ? "#f7eeec" : near ? "#f8f4e9" : "var(--green-subtle)",
              color:      over ? "#9b3d37" : near ? "#7a5622" : "var(--green)",
            }}>
            {over ? "Limit reached" : `${pct}% used`}
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="h-2 rounded-full animate-pulse" style={{ background: "var(--border)" }} />
      ) : hasCap ? (
        <>
          <div className="h-2 rounded-full overflow-hidden" style={{ background: "var(--border)" }}>
            <div className="h-full rounded-full transition-all"
              style={{ width: `${pct}%`, background: barColor }} />
          </div>
          <div className="flex items-center justify-between mt-2">
            <p className="text-[12px]" style={{ color: "var(--text-2)" }}>
              <span className="font-semibold" style={{ color: "var(--text)" }}>{creditsSpent.toLocaleString()}</span>
              {" "}of {creditsCap.toLocaleString()} credits
            </p>
            <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
              Resets {resetLabel}
            </p>
          </div>
          {over && data?.enforced && (
            <p className="text-[11px] mt-2 inline-flex items-start gap-1" style={{ color: "#9b3d37" }}>
              <AlertTriangle size={11} strokeWidth={2} className="mt-0.5 shrink-0" />
              AI features are paused until {resetLabel}. Contact support@nordavix.com if you need a higher limit.
            </p>
          )}
        </>
      ) : (
        <p className="text-[12px]" style={{ color: "var(--text-2)" }}>
          <span className="font-semibold" style={{ color: "var(--text)" }}>{creditsSpent.toLocaleString()}</span>
          {" "}credits used this month. No limit set — usage is tracked only.
        </p>
      )}
    </div>
  )
}

function AIPreferencesSection() {
  const { organization } = useOrganization()
  const storageKey = organization ? `ai_prefs_${organization.id}` : "ai_prefs_default"
  const [prefs, setPrefs] = useState<AIPrefs>(AI_DEFAULTS)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey)
      if (raw) setPrefs({ ...AI_DEFAULTS, ...JSON.parse(raw) })
      else setPrefs(AI_DEFAULTS)
    } catch { /* ignore */ }
  }, [storageKey])

  useEffect(() => {
    if (!savedAt) return
    const t = setTimeout(() => setSavedAt(null), 2000)
    return () => clearTimeout(t)
  }, [savedAt])

  function update<K extends keyof AIPrefs>(key: K, value: AIPrefs[K]) {
    const next = { ...prefs, [key]: value }
    setPrefs(next)
    try {
      localStorage.setItem(storageKey, JSON.stringify(next))
      setSavedAt(Date.now())
    } catch { /* ignore */ }
  }

  return (
    <SectionShell
      title="AI preferences"
      description="How Nordavix's AI features behave in this workspace. Affects Agentic Mode defaults, variance commentary, and materiality."
      icon={Sparkles}
      badge={<LocalOnlyBadge />}
    >
      <div className="space-y-5">
        <AiUsageCard />

        <PrefGroup title="Agentic Mode">
          <Toggle
            label="Default Agentic Mode ON for new periods"
            hint="When a new month opens, the AI preparer is ready to auto-tick. You can still toggle it off per-period."
            value={prefs.agentic_default_on}
            onChange={(v) => update("agentic_default_on", v)}
          />
        </PrefGroup>

        <PrefGroup title="Materiality">
          <div className="flex items-end gap-3">
            <div className="flex-1 max-w-[180px]">
              <label className="block text-[11px] font-medium mb-1" style={{ color: "var(--text-2)" }}>
                Default threshold (%)
              </label>
              <input
                type="number" step="0.1" min="0" max="100"
                value={prefs.default_materiality_pct}
                onChange={(e) => update("default_materiality_pct", e.target.value)}
                className="w-full rounded-lg px-3 py-2 text-sm outline-none"
                style={{
                  background: "var(--surface-2)",
                  border: "1px solid var(--border-strong)",
                  color: "var(--text)",
                }}
              />
            </div>
            <p className="text-[11px] pb-2" style={{ color: "var(--text-muted)" }}>
              Flux variances under this threshold won't surface as material.
            </p>
          </div>
        </PrefGroup>

        <PrefGroup title="Commentary style">
          <Radio name="style" label="Concise — 1–2 sentences"           value="concise"
            checked={prefs.commentary_style === "concise"}  onChange={() => update("commentary_style", "concise")} />
          <Radio name="style" label="Standard — short paragraph"        value="standard"
            checked={prefs.commentary_style === "standard"} onChange={() => update("commentary_style", "standard")} />
          <Radio name="style" label="Detailed — multi-paragraph + cite" value="detailed"
            checked={prefs.commentary_style === "detailed"} onChange={() => update("commentary_style", "detailed")} />
        </PrefGroup>

        <PrefGroup title="Tone">
          <Radio name="tone" label="Professional"  value="professional"
            checked={prefs.commentary_tone === "professional"} onChange={() => update("commentary_tone", "professional")} />
          <Radio name="tone" label="Friendly"      value="friendly"
            checked={prefs.commentary_tone === "friendly"}     onChange={() => update("commentary_tone", "friendly")} />
          <Radio name="tone" label="Audit-grade"   value="audit-grade"
            checked={prefs.commentary_tone === "audit-grade"}  onChange={() => update("commentary_tone", "audit-grade")} />
        </PrefGroup>

        <PrefGroup title="Citations">
          <Toggle
            label="Show source citations in AI commentary"
            hint="Lists which transactions / accounts the AI used as evidence."
            value={prefs.show_source_citations}
            onChange={(v) => update("show_source_citations", v)}
          />
        </PrefGroup>

        {savedAt && (
          <p className="text-[11px] inline-flex items-center gap-1" style={{ color: "var(--green)" }}>
            <CheckCircle2 size={11} strokeWidth={2.5} /> Saved
          </p>
        )}
      </div>
    </SectionShell>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

interface AppearancePrefs {
  density: "comfortable" | "compact"
}

const APPEARANCE_DEFAULTS: AppearancePrefs = { density: "comfortable" }

function AppearanceSection() {
  const [prefs, setPrefs] = useState<AppearancePrefs>(APPEARANCE_DEFAULTS)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  useEffect(() => {
    try {
      const raw = localStorage.getItem("appearance_prefs")
      if (raw) setPrefs({ ...APPEARANCE_DEFAULTS, ...JSON.parse(raw) })
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    if (!savedAt) return
    const t = setTimeout(() => setSavedAt(null), 2000)
    return () => clearTimeout(t)
  }, [savedAt])

  function update<K extends keyof AppearancePrefs>(key: K, value: AppearancePrefs[K]) {
    const next = { ...prefs, [key]: value }
    setPrefs(next)
    try {
      localStorage.setItem("appearance_prefs", JSON.stringify(next))
      setSavedAt(Date.now())
    } catch { /* ignore */ }
  }

  return (
    <SectionShell
      title="Appearance"
      description="How Nordavix looks on this device. Theme syncs across tabs; density is per-browser."
      icon={Palette}
    >
      <div className="space-y-5">
        <PrefGroup title="Theme">
          <div className="flex items-center justify-between gap-3">
            <div className="flex-1">
              <p className="text-sm font-medium" style={{ color: "var(--text)" }}>Color scheme</p>
              <p className="text-[11px] mt-0.5" style={{ color: "var(--text-muted)" }}>
                System follows your OS preference.
              </p>
            </div>
            <ThemeToggle />
          </div>
        </PrefGroup>

        <PrefGroup title="Density" badge={<ComingSoonBadge />}>
          <Radio name="density" label="Comfortable — default spacing"  value="comfortable"
            checked={prefs.density === "comfortable"} onChange={() => update("density", "comfortable")} disabled />
          <Radio name="density" label="Compact — tighter rows, fits more on screen" value="compact"
            checked={prefs.density === "compact"}    onChange={() => update("density", "compact")} disabled />
        </PrefGroup>

        {savedAt && (
          <p className="text-[11px] inline-flex items-center gap-1" style={{ color: "var(--green)" }}>
            <CheckCircle2 size={11} strokeWidth={2.5} /> Saved
          </p>
        )}
      </div>
    </SectionShell>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

function DataExportSection() {
  const navigate = useNavigate()
  const { organization } = useOrganization()
  const { data: me } = useQuery({
    queryKey: ["workspace-me"],
    queryFn:  workspaceApi.getMe,
    staleTime: 10 * 60_000,
    enabled:  !!organization,
  })
  const isAdmin = me?.role === "admin"
  const [downloading, setDownloading] = useState<"audit" | "period" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showDelete, setShowDelete] = useState(false)
  /** Default period_end = last day of previous calendar month — the
   * most common close period people want to export. */
  const [periodEnd, setPeriodEnd] = useState<string>(() => {
    const d = new Date()
    const last = new Date(d.getFullYear(), d.getMonth(), 0)
    return toISODate(last)
  })

  /** Pull the Period Export workbook as a binary blob, then trigger a
   * browser download. We use axios's `responseType: "blob"` so the
   * raw bytes come through intact (default JSON parsing would corrupt
   * the .xlsx). Filename is taken from Content-Disposition when the
   * server sends it. */
  async function downloadPeriodWorkbook() {
    if (!organization) return
    setError(null)
    setDownloading("period")
    try {
      const resp = await apiClient.get<Blob>(
        "/api/exports/period",
        { params: { period_end: periodEnd }, responseType: "blob" },
      )
      // Extract filename from Content-Disposition if present
      const disp = (resp.headers["content-disposition"] ?? resp.headers["Content-Disposition"] ?? "") as string
      const match = disp.match(/filename="?([^"]+)"?/i)
      const fname = match?.[1] ?? `nordavix_close_${periodEnd}.xlsx`
      const url = URL.createObjectURL(resp.data)
      const a = document.createElement("a")
      a.href = url
      a.download = fname
      document.body.appendChild(a); a.click(); document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch {
      setError("Could not build the period export. The workspace may not have a committed snapshot for that period yet.")
    } finally {
      setDownloading(null)
    }
  }

  /** Full audit trail as a server-built Excel workbook — every recorded
   * action with date, time, and user, in the user's local timezone
   * (we pass the browser's offset so the server can convert). */
  async function downloadAuditLog() {
    setError(null)
    setDownloading("audit")
    try {
      const resp = await apiClient.get<Blob>(
        "/api/audit/export",
        { params: { tz_offset: new Date().getTimezoneOffset() }, responseType: "blob" },
      )
      const disp = (resp.headers["content-disposition"] ?? resp.headers["Content-Disposition"] ?? "") as string
      const match = disp.match(/filename="?([^"]+)"?/i)
      const fname = match?.[1] ?? `nordavix_audit_trail_${new Date().toISOString().slice(0, 10)}.xlsx`
      const url = URL.createObjectURL(resp.data)
      const a = document.createElement("a")
      a.href = url
      a.download = fname
      document.body.appendChild(a); a.click(); document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch {
      setError("Could not export the audit trail. Try again?")
    } finally {
      setDownloading(null)
    }
  }

  return (
    <SectionShell
      title="Data & export"
      description="Pull your workspace data out in standard formats. Useful for audit, compliance, or moving between systems."
      icon={Download}
    >
      <div className="space-y-3">
        {/* Period Export workbook (.xlsx) — the new big one.
            Single download with cover + recons + schedules + audit log. */}
        <div className="rounded-lg p-4 flex flex-col gap-3"
          style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
          <div className="flex items-center gap-4">
            <span className="h-8 w-8 rounded-md flex items-center justify-center shrink-0"
              style={{ background: "var(--surface)", color: "var(--green)" }}>
              <FileDown size={14} strokeWidth={1.8} />
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold" style={{ color: "var(--text)" }}>Period Export (Excel)</p>
              <p className="text-[11px] mt-0.5" style={{ color: "var(--text-muted)" }}>
                One workbook with cover sheet, reconciliations, prepaid / accrual / fixed-asset /
                lease / loan schedules, and a 90-day audit log. Brand-styled, totals included,
                pivot-ready.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap pl-12">
            <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
              Period end
            </span>
            <DatePicker value={periodEnd} onChange={setPeriodEnd} compact />
            <button
              onClick={downloadPeriodWorkbook}
              disabled={!organization || downloading !== null}
              className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed ml-auto"
              style={{
                background: downloading === "period" ? "var(--surface)" : "var(--green)",
                color: downloading === "period" ? "var(--text-muted)" : "white",
                border: downloading === "period" ? "1px solid var(--border)" : "none",
              }}
            >
              {downloading === "period" ? <Spinner className="h-3 w-3" /> : <Download size={12} strokeWidth={1.8} />}
              {downloading === "period" ? "Building workbook…" : "Download .xlsx"}
            </button>
          </div>
        </div>

        <ExportRow
          icon={<FileDown size={14} strokeWidth={1.8} />}
          title="Audit trail (Excel)"
          description="The complete, structured history of every action in this workspace — who did what, with date and time stamps in your local timezone. Organized by module with filters built in. Audit- and SOC-ready."
          buttonLabel={downloading === "audit" ? "Generating…" : "Download .xlsx"}
          loading={downloading === "audit"}
          onClick={downloadAuditLog}
          disabled={!organization || downloading !== null}
        />

        <ExportRow
          icon={<FileDown size={14} strokeWidth={1.8} />}
          title="Full workspace export (.zip)"
          description="One zip with everything: trial balances, every PDF, all schedules, evidence files. Coming soon — for now the Period Export above covers most needs."
          buttonLabel="Coming soon"
          disabled
        />
      </div>

      {error && <p className="text-xs mt-4" style={{ color: "#9b3d37" }}>{error}</p>}

      {/* Danger zone — delete workspace (admin only) */}
      <div className="mt-7 pt-5" style={{ borderTop: "1px solid var(--border)" }}>
        <div className="rounded-lg p-4"
          style={{ background: "#f7eeec", border: "1px solid #ecd7d3" }}>
          <div className="flex items-start gap-3">
            <AlertTriangle size={16} strokeWidth={1.8} className="shrink-0 mt-0.5" style={{ color: "#9b3d37" }} />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold" style={{ color: "#86332e" }}>Danger zone</p>
              <p className="text-[12px] mt-0.5" style={{ color: "#86332e" }}>
                Deleting this workspace removes <span className="font-semibold">{organization?.name ?? "the company"}</span>{" "}
                from your account and revokes access for every member. The QuickBooks connection
                is disconnected and revoked at the source, and all data (reconciliations,
                schedules, trial balances, evidence) is permanently deleted within 30 days.
                This cannot be undone.
              </p>
              {!isAdmin && organization && (
                <p className="text-[11px] mt-2 inline-flex items-center gap-1"
                  style={{ color: "#86332e" }}>
                  <ShieldCheck size={11} strokeWidth={2} />
                  Only workspace admins can delete a company.
                </p>
              )}
            </div>
            {isAdmin && organization && (
              <button
                onClick={() => setShowDelete(true)}
                className="shrink-0 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors"
                style={{
                  background: "white",
                  color: "#9b3d37",
                  border: "1px solid #ecd7d3",
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "#f4e9e7" }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "white" }}
              >
                Delete company
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Type-to-confirm modal */}
      <AnimatePresence>
        {showDelete && organization && (
          <DeleteCompanyModal
            organization={organization}
            onCancel={() => setShowDelete(false)}
            onDeleted={() => {
              setShowDelete(false)
              navigate("/app/companies")
            }}
          />
        )}
      </AnimatePresence>
    </SectionShell>
  )
}

/**
 * Type-to-confirm modal for deleting a workspace.
 *
 * Why type-to-confirm: a plain "Are you sure?" yes/no is easily clicked
 * through. Forcing the user to type the company name verbatim makes
 * accidental deletion essentially impossible while still being one
 * action away for the intentional case.
 *
 * Delete order matters: we call our backend (DELETE /api/workspace) FIRST,
 * while the Clerk JWT still resolves this org. That revokes the QuickBooks
 * token at Intuit and soft-deletes the tenant — access is cut off everywhere
 * immediately and a scheduled job hard-purges all data + files after a 30-day
 * grace window (audit logs retained). Only then do we call Clerk's
 * organization.destroy(). If the backend call fails we abort, so we never
 * tear down Clerk while leaving a live QBO token or orphaned data behind.
 *
 * After both succeed we wipe every localStorage / sessionStorage key whose
 * name contains the org id (CompanyForm meta, notif/AI prefs, schedules-loaded
 * flag, etc.) so the browser doesn't carry stale per-org state forward.
 */
function DeleteCompanyModal({
  organization, onCancel, onDeleted,
}: {
  organization: { id: string; name: string | null; destroy: () => Promise<unknown> }
  onCancel:  () => void
  onDeleted: () => void
}) {
  const [typed, setTyped] = useState("")
  const [working, setWorking] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const expected = organization.name ?? ""
  const canDelete = typed.trim() === expected.trim() && expected.length > 0 && !working

  // Esc closes (unless we're mid-delete).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !working) onCancel()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onCancel, working])

  async function handleDelete() {
    if (!canDelete) return
    setErr(null)
    setWorking(true)
    try {
      // 1. Delete on OUR backend FIRST, while the JWT still resolves this org.
      //    This revokes the QuickBooks token and soft-deletes the tenant
      //    (inaccessible immediately, hard-purged after the grace window).
      //    If it fails we abort — destroying the Clerk org without this would
      //    leave a live QBO token + orphaned data behind.
      await workspaceApi.deleteWorkspace()

      // 2. Now remove the Clerk organization itself.
      await organization.destroy()

      // 3. Wipe every browser-side key tied to this org so the next
      //    active workspace doesn't inherit stale meta / prefs.
      try {
        const orgId = organization.id
        for (const store of [localStorage, sessionStorage]) {
          const keys: string[] = []
          for (let i = 0; i < store.length; i++) {
            const k = store.key(i)
            if (k && k.includes(orgId)) keys.push(k)
          }
          keys.forEach((k) => store.removeItem(k))
        }
      } catch { /* harmless */ }
      onDeleted()
    } catch (e) {
      // Surface the backend detail when present (e.g. permission / network),
      // else the Clerk error message, else a generic fallback.
      const ax = e as { response?: { data?: { detail?: string } }; message?: string }
      const msg = ax?.response?.data?.detail ?? ax?.message
      setErr(msg ?? "Could not delete the workspace. Try again?")
      setWorking(false)
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.6)" }}
      onClick={() => !working && onCancel()}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
        className="rounded-2xl max-w-md w-full"
        style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
      >
        <div className="px-5 py-4" style={{ borderBottom: "1px solid var(--border)" }}>
          <div className="flex items-center gap-2.5">
            <span className="h-8 w-8 rounded-lg inline-flex items-center justify-center shrink-0"
              style={{ background: "#f7eeec", color: "#9b3d37" }}>
              <AlertTriangle size={15} strokeWidth={2} />
            </span>
            <div>
              <h3 className="text-sm font-bold" style={{ color: "var(--text)" }}>
                Delete workspace
              </h3>
              <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                This action cannot be undone.
              </p>
            </div>
          </div>
        </div>
        <div className="px-5 py-4 space-y-4">
          <p className="text-[13px]" style={{ color: "var(--text-2)" }}>
            You're about to permanently delete{" "}
            <span className="font-semibold" style={{ color: "var(--text)" }}>{expected}</span>.
            Every member loses access immediately and the QuickBooks connection is
            disconnected and revoked. Reconciliations, schedules, trial balances, and
            uploaded evidence are scheduled for permanent deletion within 30 days
            (audit logs are retained for compliance). This can't be undone.
          </p>
          <div>
            <label className="block text-[11px] font-semibold mb-1.5" style={{ color: "var(--text-2)" }}>
              Type <span className="font-mono px-1 rounded" style={{ background: "var(--surface-2)" }}>{expected}</span> to confirm
            </label>
            <input
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              disabled={working}
              placeholder={expected}
              className="w-full rounded-lg px-3 py-2 text-sm outline-none"
              style={{
                background: "var(--surface-2)",
                border: `1px solid ${canDelete ? "#9b3d37" : "var(--border-strong)"}`,
                color: "var(--text)",
              }}
            />
          </div>
          {err && (
            <div className="rounded-md px-3 py-2 text-[11px]"
              style={{ background: "#f7eeec", color: "#86332e", border: "1px solid #ecd7d3" }}>
              {err}
            </div>
          )}
        </div>
        <div className="px-5 py-3 flex items-center justify-end gap-2"
          style={{ borderTop: "1px solid var(--border)", background: "var(--surface-2)" }}>
          <button
            onClick={onCancel}
            disabled={working}
            className="px-3 py-1.5 rounded-md text-xs font-semibold transition-colors disabled:opacity-50"
            style={{ color: "var(--text-2)", background: "transparent" }}
            onMouseEnter={(e) => { if (!working) (e.currentTarget as HTMLElement).style.background = "var(--surface)" }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent" }}
          >
            Cancel
          </button>
          <button
            onClick={handleDelete}
            disabled={!canDelete}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ background: "#9b3d37", color: "white" }}
          >
            {working ? <Spinner className="h-3 w-3" /> : <AlertTriangle size={12} strokeWidth={2} />}
            {working ? "Deleting…" : "Delete forever"}
          </button>
        </div>
      </motion.div>
    </motion.div>
  )
}

function ExportRow({
  icon, title, description, buttonLabel, loading, onClick, disabled,
}: {
  icon: React.ReactNode
  title: string
  description: string
  buttonLabel: string
  loading?: boolean
  onClick?: () => void
  disabled?: boolean
}) {
  return (
    <div className="rounded-lg p-4 flex items-center gap-4"
      style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
      <span className="h-8 w-8 rounded-md flex items-center justify-center shrink-0"
        style={{ background: "var(--surface)", color: "var(--green)" }}>
        {icon}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold" style={{ color: "var(--text)" }}>{title}</p>
        <p className="text-[11px] mt-0.5" style={{ color: "var(--text-muted)" }}>{description}</p>
      </div>
      <button
        onClick={onClick}
        disabled={disabled}
        className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
        style={{ background: disabled ? "var(--surface)" : "var(--green)", color: disabled ? "var(--text-muted)" : "white", border: disabled ? "1px solid var(--border)" : "none" }}
      >
        {loading ? <Spinner className="h-3 w-3" /> : <Download size={12} strokeWidth={1.8} />}
        {buttonLabel}
      </button>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

function AboutSection() {
  return (
    <SectionShell
      title="About"
      description="Build info, helpful links, and how to reach us."
      icon={Info}
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5">
        <InfoRow label="App"      value="Nordavix" />
        <InfoRow label="Version"  value={import.meta.env.MODE === "production" ? "v0.2.0" : "v0.2.0 (dev)"} />
        <InfoRow label="Built for" value="AI-powered month-end close" />
        <InfoRow label="Region"   value="US-East (iad)" />
      </div>

      <PrefGroup title="Resources">
        <LinkRow icon={<BookOpen size={14} strokeWidth={1.8} />}      label="Documentation"   sub="Guides for Flux, Reconciliations, Tasks." href="#" />
        <LinkRow icon={<Mail size={14} strokeWidth={1.8} />}          label="Contact support" sub="support@nordavix.com — typical reply within a business day." href="mailto:support@nordavix.com" />
        <LinkRow icon={<ExternalLink size={14} strokeWidth={1.8} />}  label="What's new"      sub="Latest feature drops and changelog." href="#" />
      </PrefGroup>

      <p className="text-[11px] mt-6 text-center" style={{ color: "var(--text-muted)" }}>
        © {new Date().getFullYear()} Nordavix. All rights reserved.
      </p>
    </SectionShell>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg px-3 py-2.5"
      style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
      <p className="text-[10px] font-semibold uppercase tracking-wider mb-0.5" style={{ color: "var(--text-muted)" }}>
        {label}
      </p>
      <p className="text-sm font-semibold" style={{ color: "var(--text)" }}>{value}</p>
    </div>
  )
}

function LinkRow({ icon, label, sub, href }: { icon: React.ReactNode; label: string; sub: string; href: string }) {
  return (
    <a href={href}
      target={href.startsWith("http") ? "_blank" : undefined}
      rel={href.startsWith("http") ? "noreferrer" : undefined}
      className="block rounded-lg p-3 transition-colors"
      style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--green)" }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--border)" }}
    >
      <div className="flex items-center gap-3">
        <span className="h-8 w-8 rounded-md flex items-center justify-center shrink-0"
          style={{ background: "var(--surface)", color: "var(--green)" }}>
          {icon}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold" style={{ color: "var(--text)" }}>{label}</p>
          <p className="text-[11px] truncate" style={{ color: "var(--text-muted)" }}>{sub}</p>
        </div>
        <ArrowRight size={12} strokeWidth={1.8} style={{ color: "var(--text-muted)" }} />
      </div>
    </a>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared form primitives (Toggle, Radio, PrefGroup)
// ─────────────────────────────────────────────────────────────────────────────

function PrefGroup({ title, badge, children }: { title: string; badge?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <h3 className="text-[11px] font-bold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
          {title}
        </h3>
        {badge}
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  )
}

function Toggle({
  label, hint, value, onChange,
}: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-start justify-between gap-3 rounded-lg p-3 cursor-pointer transition-colors"
      style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--border-strong)" }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--border)" }}
    >
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium" style={{ color: "var(--text)" }}>{label}</p>
        {hint && <p className="text-[11px] mt-0.5" style={{ color: "var(--text-muted)" }}>{hint}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        onClick={(e) => { e.preventDefault(); onChange(!value) }}
        className="relative h-5 w-9 rounded-full transition-colors shrink-0 mt-0.5"
        style={{
          background: value ? "var(--green)" : "var(--border-strong)",
        }}
      >
        {/* Thumb anchored with an explicit left+top inset so its travel is
            self-contained: x 0 → 16 keeps it 2px inside the 36px track at both
            ends. (Relying on `absolute` auto-left let the knob overflow the
            right edge.) 2px inset + 16px thumb + 16px travel + 2px = 36px. */}
        <motion.span
          className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm"
          animate={{ x: value ? 16 : 0 }}
          transition={{ type: "spring", stiffness: 500, damping: 30 }}
        />
      </button>
    </label>
  )
}

function Radio({
  name, label, value, checked, onChange, disabled,
}: {
  name: string; label: string; value: string;
  checked: boolean; onChange: () => void; disabled?: boolean;
}) {
  return (
    <label className="flex items-center gap-3 rounded-lg p-3 cursor-pointer transition-colors"
      style={{
        background: checked ? "var(--green-subtle)" : "var(--surface-2)",
        border: `1px solid ${checked ? "var(--green)" : "var(--border)"}`,
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      <input
        type="radio" name={name} value={value} checked={checked} onChange={onChange}
        disabled={disabled} className="sr-only"
      />
      <span className="h-4 w-4 rounded-full flex items-center justify-center shrink-0"
        style={{ background: "white", border: `1px solid ${checked ? "var(--green)" : "var(--border-strong)"}` }}>
        {checked && <span className="h-2 w-2 rounded-full" style={{ background: "var(--green)" }} />}
      </span>
      <span className="text-sm" style={{ color: checked ? "var(--green)" : "var(--text)" }}>{label}</span>
    </label>
  )
}
