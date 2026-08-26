/**
 * Close Command Center — the firm-level cockpit.
 *
 * One dense table, every company the user belongs to, with where its close
 * stands and who is doing the work:
 *
 *   Company · Closed thru · Period · Progress · Preparer · Reviewer ·
 *   Signals · Age
 *
 * WHO THIS IS FOR. A partner reading progress, not a supervisor assigning it.
 * The preparer and reviewer columns are ATTRIBUTION — they say who is on the
 * engagement. They deliberately do not say "waiting on you", and nothing here
 * ranks people; an earlier version did and it read as surveillance.
 *
 * The list mechanics — sorting, search, filters, density, column visibility,
 * CSV export, and the four states — come from the shared DataTable. This page
 * was the reference implementation for that primitive and is now its first
 * consumer, which is the point: the abstraction is proved against a screen that
 * already worked rather than a hypothetical one.
 *
 * Clicking a row switches the active Clerk organization (same mechanism as the
 * company switcher) and lands on that company's dashboard — the org-change
 * listener invalidates every query, so data can never bleed between companies.
 */
import { useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useOrganization, useOrganizationList } from "@clerk/clerk-react"
import {
  ArrowRight, Building2, Flag, Plug, Plus, RefreshCw, Sparkles, TrendingUp,
} from "lucide-react"
import { DataTable, Spinner, type Column } from "@/core/ui"
import { PageHeader } from "@/core/ui/PageHeader"
import {
  firmApi,
  type CommandCenterActor,
  type CommandCenterCompany,
} from "@/modules/firm/api"

// ── Ordering ─────────────────────────────────────────────────────────────────

/** The close's own priority: the order before any column is chosen, and the
 *  tiebreak after one is. Ready-to-close first (one click from done), then most
 *  overdue. Without a stable tiebreak, equal rows reshuffle between renders. */
function urgencyScore(c: CommandCenterCompany): number {
  if (!c.books_set || !c.qbo_connected) return 1000
  if (!c.focus) return 0                                  // fully caught up
  if (c.focus.status === "complete") return 4000          // ready to close NOW
  return 3000 + Math.min(c.focus.days_since_period_end, 365)
}

/** "Apr 2026" → 202604, so closed-through sorts chronologically, not
 *  alphabetically (which would put April before January). */
function monthKey(label: string | null): number | null {
  if (!label) return null
  const [mon, yr] = label.split(" ")
  const i = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(mon)
  const y = Number(yr)
  return i < 0 || !Number.isFinite(y) ? null : y * 100 + (i + 1)
}

const peopleText = (people?: CommandCenterActor[]) =>
  (people ?? []).map((p) => p.name).join(", ")

// ── Filters ──────────────────────────────────────────────────────────────────

function needsSetup(c: CommandCenterCompany): boolean {
  return !c.books_set || !c.qbo_connected
}

// ── Small atoms ──────────────────────────────────────────────────────────────

function Chip({ icon, label, fg, bg, title }: {
  icon?: React.ReactNode; label: string; fg: string; bg: string; title?: string
}) {
  return (
    <span title={title}
      className="inline-flex items-center gap-1 rounded px-1.5 py-px text-[10px] font-semibold whitespace-nowrap"
      style={{ color: fg, background: bg }}>
      {icon}{label}
    </span>
  )
}

/** Segmented recon progress: approved (green) → prepared (sage) → flagged
 *  (red) → remainder (track). Inline with the count so the row stays one line. */
function ProgressCell({ approved, reviewed, flagged, total }: {
  approved: number; reviewed: number; flagged: number; total: number
}) {
  const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0)
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 rounded-full overflow-hidden flex flex-1 min-w-0"
        style={{ background: "var(--surface-2)" }}
        title={`${approved} approved · ${reviewed} prepared · ${flagged} flagged · ${total} accounts`}>
        <div style={{ width: `${pct(approved)}%`, background: "var(--green)" }} />
        <div style={{ width: `${pct(reviewed)}%`, background: "#7FB89B" }} />
        <div style={{ width: `${pct(flagged)}%`, background: "#b4533d" }} />
      </div>
      <span className="text-[11px] tabular-nums shrink-0" style={{ color: "var(--text-muted)" }}>
        {approved}/{total}
      </span>
    </div>
  )
}

/** One name plus a count of the rest; the full list is in the tooltip. A column
 *  that wraps to three names defeats the point of a one-line row. */
function PeopleCell({ people }: { people?: CommandCenterActor[] }) {
  if (!people || people.length === 0) {
    return <span className="text-[12px]" style={{ color: "var(--border-strong)" }}>—</span>
  }
  const [first, ...rest] = people
  return (
    <span className="text-[12px] truncate inline-block max-w-full align-bottom"
      style={{ color: "var(--text-2)" }} title={peopleText(people)}>
      {first.name}
      {rest.length > 0 && <span style={{ color: "var(--text-muted)" }}> +{rest.length}</span>}
    </span>
  )
}

function daysTone(days: number): { fg: string; bg: string } {
  if (days >= 15) return { fg: "#9b3d37", bg: "#f7eeec" }
  if (days >= 7)  return { fg: "#8a6326", bg: "rgba(199, 154, 82, 0.12)" }
  return { fg: "var(--text-muted)", bg: "var(--surface-2)" }
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function CommandCenterPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { organization } = useOrganization()
  const { setActive, userMemberships } = useOrganizationList({
    userMemberships: { infinite: true },
  })
  const [switchingId, setSwitchingId] = useState<string | null>(null)

  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ["command-center"],
    queryFn:  firmApi.getCommandCenter,
    staleTime: 60_000,
  })

  // Clerk is the canonical source for company names — the backend's
  // Tenant.name can lag (tenants provisioned before the org was named hold the
  // raw org_... id). Overlay Clerk's name whenever we have it.
  const orgNames = useMemo(() => {
    const m: Record<string, string> = {}
    for (const mem of userMemberships?.data ?? []) m[mem.organization.id] = mem.organization.name
    return m
  }, [userMemberships?.data])
  const displayName = useMemo(() => (c: CommandCenterCompany) =>
    orgNames[c.clerk_org_id]
    ?? (c.name && !c.name.startsWith("org_") ? c.name : "Unnamed company"),
  [orgNames])

  const companies = data?.companies ?? []

  const kpis = useMemo(() => ({
    total:    companies.length,
    ready:    companies.filter((c) => c.focus?.status === "complete").length,
    behind:   companies.filter((c) => c.focus && c.focus.status !== "complete"
                                      && c.focus.days_since_period_end >= 7).length,
    caughtUp: companies.filter((c) => c.books_set && c.qbo_connected && !c.focus).length,
  }), [companies])

  /** Everyone who appears as a preparer or reviewer anywhere, for the filter. */
  const allPeople = useMemo(() => {
    const names = new Set<string>()
    for (const c of companies) {
      for (const p of c.focus?.preparers ?? []) names.add(p.name)
      for (const p of c.focus?.reviewers ?? []) names.add(p.name)
    }
    return [...names].sort((a, b) => a.localeCompare(b))
  }, [companies])

  /** Switch the active Clerk org, then land on that company's dashboard. The
   *  app-level org-change listener invalidates every query, so the next screen
   *  renders from the new company's data only. */
  async function openCompany(c: CommandCenterCompany) {
    if (c.clerk_org_id === organization?.id) {
      navigate("/app")
      return
    }
    if (!setActive) return
    setSwitchingId(c.tenant_id)
    try {
      await setActive({ organization: c.clerk_org_id })
      qc.clear()
      navigate("/app")
    } finally {
      setSwitchingId(null)
    }
  }

  const columns: Column<CommandCenterCompany>[] = useMemo(() => [
    {
      key: "name", header: "Company", width: "auto", hideable: false,
      sortValue: (c) => displayName(c).toLowerCase(),
      text: (c) => displayName(c),
      cell: (c) => (
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-[13px] font-semibold truncate" style={{ color: "var(--text)" }}>
            {displayName(c)}
          </span>
          {c.clerk_org_id === organization?.id && (
            <Chip label="Current" fg="var(--green)" bg="var(--green-subtle)" />
          )}
          {c.is_demo && <Chip label="Sample" fg="var(--text-muted)" bg="var(--surface-2)" />}
        </div>
      ),
    },
    {
      key: "closed_through", header: "Closed thru", width: "116px",
      sortValue: (c) => monthKey(c.closed_through),
      text: (c) => c.closed_through ?? "",
      cell: (c) => (
        <span className="text-[12px]"
          style={{ color: c.closed_through ? "var(--text-2)" : "var(--border-strong)" }}>
          {c.closed_through ?? "—"}
        </span>
      ),
    },
    {
      key: "period", header: "Period", width: "92px",
      sortValue: (c) => c.focus?.period_end ?? null,
      text: (c) => c.focus?.label ?? "",
      cell: (c) => (
        <span className="text-[12px] font-medium"
          style={{ color: c.focus ? "var(--text)" : "var(--border-strong)" }}>
          {c.focus?.label ?? "—"}
        </span>
      ),
    },
    {
      key: "progress", header: "Progress", width: "168px",
      sortValue: (c) => (c.focus && c.focus.total > 0 ? c.focus.approved / c.focus.total : null),
      text: (c) => (c.focus ? `${c.focus.approved}/${c.focus.total}` : ""),
      cell: (c) => {
        if (needsSetup(c)) {
          return <Chip icon={<Plug size={9} strokeWidth={2.4} />}
            label={!c.books_set ? "Books setup" : "QBO disconnected"}
            fg="#8a6326" bg="rgba(199, 154, 82, 0.12)" />
        }
        if (!c.focus) {
          return <span className="text-[11px]" style={{ color: "var(--green)" }}>All months closed</span>
        }
        return <ProgressCell approved={c.focus.approved} reviewed={c.focus.reviewed}
          flagged={c.focus.flagged} total={Math.max(c.focus.total, 1)} />
      },
    },
    {
      key: "preparer", header: "Preparer", width: "148px",
      sortValue: (c) => c.focus?.preparers?.[0]?.name.toLowerCase() ?? null,
      text: (c) => peopleText(c.focus?.preparers),
      cell: (c) => <PeopleCell people={c.focus?.preparers} />,
    },
    {
      key: "reviewer", header: "Reviewer", width: "148px",
      sortValue: (c) => c.focus?.reviewers?.[0]?.name.toLowerCase() ?? null,
      text: (c) => peopleText(c.focus?.reviewers),
      cell: (c) => <PeopleCell people={c.focus?.reviewers} />,
    },
    {
      key: "signals", header: "Signals", width: "196px",
      text: (c) => [
        c.focus?.flagged ? `${c.focus.flagged} flagged` : "",
        c.flux ? `flux ${c.flux.approved}/${c.flux.total}` : "flux not run",
        c.open_adjustments ? `${c.open_adjustments} adjustments` : "",
      ].filter(Boolean).join(" · "),
      cell: (c) => (
        <div className="flex items-center gap-1 flex-nowrap overflow-hidden">
          {(c.focus?.flagged ?? 0) > 0 && (
            <Chip icon={<Flag size={9} strokeWidth={2.4} />} label={String(c.focus!.flagged)}
              title={`${c.focus!.flagged} flagged accounts`} fg="#9b3d37" bg="#f7eeec" />
          )}
          {c.flux && (
            <Chip icon={<TrendingUp size={9} strokeWidth={2.4} />}
              label={`${c.flux.approved}/${c.flux.total}`}
              title={`Flux: ${c.flux.approved} of ${c.flux.total} variances approved`}
              fg={c.flux.state === "done" ? "var(--green)" : "#3c5a76"}
              bg={c.flux.state === "done" ? "var(--green-subtle)" : "#e9eef3"} />
          )}
          {!c.flux && c.focus && (
            <Chip icon={<TrendingUp size={9} strokeWidth={2.4} />} label="—"
              title="Flux not run for this period"
              fg="var(--text-muted)" bg="var(--surface-2)" />
          )}
          {c.open_adjustments > 0 && (
            <Chip icon={<Sparkles size={9} strokeWidth={2.4} />} label={String(c.open_adjustments)}
              title={`${c.open_adjustments} open proposed entries`}
              fg="var(--text-2)" bg="var(--surface-2)" />
          )}
        </div>
      ),
    },
    {
      key: "age", header: "Age", width: "66px", align: "right",
      sortValue: (c) => c.focus?.days_since_period_end ?? null,
      text: (c) => (c.focus ? `${c.focus.days_since_period_end}d` : ""),
      cell: (c) => {
        if (!c.focus) return <span className="text-[12px]" style={{ color: "var(--border-strong)" }}>—</span>
        const tone = daysTone(c.focus.days_since_period_end)
        return (
          <span className="text-[11px] font-semibold tabular-nums rounded px-1.5 py-px"
            title={`${c.focus.days_since_period_end} days since ${c.focus.label} ended`}
            style={{ color: tone.fg, background: tone.bg }}>
            {c.focus.days_since_period_end}d
          </span>
        )
      },
    },
  ], [displayName, organization?.id])

  return (
    <div className="flex flex-col h-full overflow-y-auto" style={{ background: "var(--bg)" }}>
      <PageHeader
        title="Command Center"
        subtitle="Every company's close on one screen — where each one stands and who's on it."
        actions={
          <button onClick={() => refetch()} disabled={isFetching}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold disabled:opacity-60 transition-opacity"
            style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }}>
            <RefreshCw size={12} strokeWidth={2.2} className={isFetching ? "animate-spin" : ""} />
            Refresh
          </button>
        }
      />

      <div className="flex-1 px-4 sm:px-6 py-5 max-w-[1680px] w-full mx-auto space-y-4">

        {!isLoading && !isError && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              { label: "Companies",      value: kpis.total,    tone: "var(--text)" },
              { label: "Ready to close", value: kpis.ready,    tone: kpis.ready ? "var(--green)" : "var(--text)" },
              { label: "Behind",         value: kpis.behind,   tone: kpis.behind ? "#9b3d37" : "var(--text)" },
              { label: "Caught up",      value: kpis.caughtUp, tone: "var(--text)" },
            ].map((k) => (
              <div key={k.label} className="rounded-xl px-4 py-2.5"
                style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
                <p className="text-[10px] font-semibold uppercase tracking-wider"
                  style={{ color: "var(--text-muted)" }}>{k.label}</p>
                <p className="text-xl font-bold mt-0.5 tabular-nums" style={{ color: k.tone }}>{k.value}</p>
              </div>
            ))}
          </div>
        )}

        <DataTable<CommandCenterCompany>
          id="firm.command-center"
          rows={companies}
          columns={columns}
          rowKey={(c) => c.tenant_id}
          isLoading={isLoading}
          error={isError || undefined}
          onRetry={() => refetch()}
          // The fixed columns total 1020px; the floor keeps Company above ~280
          // so a long name clips instead of wrapping and tripling the row.
          minWidth="1300px"
          search={{ placeholder: "Search companies…" }}
          defaultOrder={(a, b) => urgencyScore(b) - urgencyScore(a)}
          filters={[
            {
              key: "status", label: "All companies",
              options: [
                { value: "ready",       label: "Ready to close" },
                { value: "in_progress", label: "In progress" },
                { value: "behind",      label: "Behind (7+ days)" },
                { value: "setup",       label: "Needs setup" },
                { value: "caught_up",   label: "Caught up" },
              ],
              test: (c, v) => {
                switch (v) {
                  case "setup":       return needsSetup(c)
                  case "caught_up":   return !needsSetup(c) && !c.focus
                  case "ready":       return !needsSetup(c) && c.focus?.status === "complete"
                  case "in_progress": return !needsSetup(c) && !!c.focus && c.focus.status !== "complete"
                  case "behind":      return !needsSetup(c) && !!c.focus && c.focus.status !== "complete"
                    && c.focus.days_since_period_end >= 7
                  default:            return true
                }
              },
            },
            ...(allPeople.length > 0 ? [{
              key: "person", label: "Anyone on the engagement",
              options: allPeople.map((n) => ({ value: n, label: n })),
              test: (c: CommandCenterCompany, v: string) =>
                [...(c.focus?.preparers ?? []), ...(c.focus?.reviewers ?? [])]
                  .some((p) => p.name === v),
            }] : []),
          ]}
          onRowClick={openCompany}
          actionsWidth="86px"
          actions={(c) => (
            <span className="inline-flex items-center justify-end gap-1 text-[11px] font-semibold"
              style={{ color: c.clerk_org_id === organization?.id ? "var(--text-muted)" : "var(--green)" }}>
              {switchingId === c.tenant_id
                ? <Spinner className="h-3 w-3" />
                : <>Open <ArrowRight size={11} strokeWidth={2.4} /></>}
            </span>
          )}
          exportFilename="nordavix-command-center"
          empty={{
            title: "No companies yet",
            body: "Create your first workspace and its close will show up here.",
            action: (
              <button onClick={() => navigate("/app/companies/new")}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold"
                style={{ background: "var(--green)", color: "white" }}>
                <Building2 size={13} strokeWidth={2} /> Add a company
              </button>
            ),
          }}
        />

        {!isLoading && !isError && companies.length > 0 && (
          <button onClick={() => navigate("/app/companies/new")}
            className="w-full rounded-xl px-5 py-2.5 flex items-center justify-center gap-2 text-xs font-semibold transition-colors hover:bg-[var(--surface)]"
            style={{ border: "1.5px dashed var(--border-strong)", color: "var(--text-muted)" }}>
            <Plus size={13} strokeWidth={2.2} />
            Add another company
          </button>
        )}
      </div>
    </div>
  )
}
