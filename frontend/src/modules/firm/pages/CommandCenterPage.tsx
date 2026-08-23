/**
 * Close Command Center — the firm-level cockpit.
 *
 * One dense table, every company the user belongs to, with where its close
 * stands and who is doing the work:
 *
 *   Company · Closed thru · Period · Progress · Preparer · Reviewer ·
 *   Signals · Age · Open
 *
 * WHO THIS IS FOR. A partner reading progress, not a supervisor assigning it.
 * The preparer and reviewer columns are ATTRIBUTION — they say who is on the
 * engagement. They deliberately do not say "waiting on you", and nothing here
 * ranks people; an earlier version did and it read as surveillance.
 *
 * A REAL TABLE, not a grid. The header and the rows used to be separate CSS
 * grids, so `auto` and bare `fr` tracks resolved independently in each and the
 * columns drifted a couple of pixels apart. `table-layout: fixed` with a
 * colgroup makes the browser guarantee they line up — the whole class of bug
 * stops being possible rather than being fixed again.
 *
 * Default order is the close's own urgency (ready-to-close first, then most
 * overdue); any column header overrides it. Filters narrow by name, by state,
 * and by person, because "show me everything Sarah prepared" is the question a
 * partner actually asks of a list this long.
 *
 * Clicking a row switches the active Clerk organization (same mechanism as the
 * company switcher) and lands on that company's dashboard — the org-change
 * listener invalidates every query, so data can never bleed between companies.
 */
import { useDeferredValue, useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useOrganization, useOrganizationList } from "@clerk/clerk-react"
import {
  ArrowRight,
  Building2,
  ChevronDown,
  ChevronUp,
  Flag,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  TrendingUp,
  X,
} from "lucide-react"
import { Spinner } from "@/core/ui/components"
import { PageHeader } from "@/core/ui/PageHeader"
import {
  firmApi,
  type CommandCenterActor,
  type CommandCenterCompany,
} from "@/modules/firm/api"

// ── Ordering ─────────────────────────────────────────────────────────────────

/** The close's own priority, used as the default order and as a tiebreak.
 *  Ready-to-close first (one click from done), then most overdue. */
function urgencyScore(c: CommandCenterCompany): number {
  if (!c.books_set || !c.qbo_connected) return 1000
  if (!c.focus) return 0                                  // fully caught up
  if (c.focus.status === "complete") return 4000          // ready to close NOW
  return 3000 + Math.min(c.focus.days_since_period_end, 365)
}

type SortKey =
  | "urgency" | "name" | "closed_through" | "period"
  | "progress" | "preparer" | "reviewer" | "age"

const COLUMNS: { key: SortKey | null; label: string; width: string; align?: "right" | "center" }[] = [
  { key: "name",           label: "Company",     width: "auto"  },
  { key: "closed_through", label: "Closed thru", width: "116px" },
  { key: "period",         label: "Period",      width: "92px"  },
  { key: "progress",       label: "Progress",    width: "168px" },
  { key: "preparer",       label: "Preparer",    width: "148px" },
  { key: "reviewer",       label: "Reviewer",    width: "148px" },
  { key: null,             label: "Signals",     width: "196px" },
  { key: "age",            label: "Age",         width: "66px", align: "right" },
  { key: null,             label: "",            width: "86px"  },
]

/** Sortable value per column. Null-ish always sinks to the bottom regardless
 *  of direction — a company with no data is never "the most" anything. */
function sortValue(c: CommandCenterCompany, key: SortKey): string | number | null {
  switch (key) {
    case "name":           return null   // handled by the caller (display name)
    case "closed_through": return c.closed_through ? monthKey(c.closed_through) : null
    case "period":         return c.focus?.period_end ?? null
    case "progress":       return c.focus && c.focus.total > 0
      ? c.focus.approved / c.focus.total : null
    case "preparer":       return firstName(c.focus?.preparers)
    case "reviewer":       return firstName(c.focus?.reviewers)
    case "age":            return c.focus?.days_since_period_end ?? null
    default:               return null
  }
}

/** "Apr 2026" → 202604, so closed-through sorts chronologically not alphabetically. */
function monthKey(label: string): number | null {
  const [mon, yr] = label.split(" ")
  const i = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(mon)
  const y = Number(yr)
  return i < 0 || !Number.isFinite(y) ? null : y * 100 + (i + 1)
}

function firstName(people?: CommandCenterActor[]): string | null {
  return people && people.length > 0 ? people[0].name.toLowerCase() : null
}

// ── Filtering ────────────────────────────────────────────────────────────────

type StatusFilter = "all" | "ready" | "in_progress" | "behind" | "setup" | "caught_up"

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all",         label: "All companies" },
  { value: "ready",       label: "Ready to close" },
  { value: "in_progress", label: "In progress" },
  { value: "behind",      label: "Behind (7+ days)" },
  { value: "setup",       label: "Needs setup" },
  { value: "caught_up",   label: "Caught up" },
]

function matchesStatus(c: CommandCenterCompany, f: StatusFilter): boolean {
  const needsSetup = !c.books_set || !c.qbo_connected
  switch (f) {
    case "all":         return true
    case "setup":       return needsSetup
    case "caught_up":   return !needsSetup && !c.focus
    case "ready":       return !needsSetup && c.focus?.status === "complete"
    case "in_progress": return !needsSetup && !!c.focus && c.focus.status !== "complete"
    case "behind":      return !needsSetup && !!c.focus && c.focus.status !== "complete"
      && c.focus.days_since_period_end >= 7
  }
}

// ── Small atoms ──────────────────────────────────────────────────────────────

function Chip({ icon, label, fg, bg, title }: {
  icon?: React.ReactNode
  label: string
  fg: string
  bg: string
  title?: string
}) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1 rounded px-1.5 py-px text-[10px] font-semibold whitespace-nowrap"
      style={{ color: fg, background: bg }}
    >
      {icon}
      {label}
    </span>
  )
}

/** Segmented recon progress: approved (green) → prepared (sage) → flagged
 *  (red) → remainder (track). Sits inline with the count so the row stays
 *  one line tall. */
function ProgressCell({ approved, reviewed, flagged, total }: {
  approved: number; reviewed: number; flagged: number; total: number
}) {
  const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0)
  return (
    <div className="flex items-center gap-2">
      <div
        className="h-1.5 rounded-full overflow-hidden flex flex-1 min-w-0"
        style={{ background: "var(--surface-2)" }}
        title={`${approved} approved · ${reviewed} prepared · ${flagged} flagged · ${total} accounts`}
      >
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

/** One name, plus a count of the rest. The full list is in the tooltip — a
 *  column that wraps to three names defeats the point of a thin row. */
function PeopleCell({ people }: { people?: CommandCenterActor[] }) {
  if (!people || people.length === 0) {
    return <span className="text-[12px]" style={{ color: "var(--border-strong)" }}>—</span>
  }
  const [first, ...rest] = people
  return (
    <span
      className="text-[12px] truncate inline-block max-w-full align-bottom"
      style={{ color: "var(--text-2)" }}
      title={people.map((p) => p.name).join(", ")}
    >
      {first.name}
      {rest.length > 0 && (
        <span style={{ color: "var(--text-muted)" }}> +{rest.length}</span>
      )}
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
  const [search, setSearch] = useState("")
  const [status, setStatus] = useState<StatusFilter>("all")
  const [person, setPerson] = useState<string>("all")
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "urgency", dir: "desc",
  })
  // Typing stays responsive on a long list: the input updates immediately, the
  // filtered table catches up.
  const deferredSearch = useDeferredValue(search)

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

  /** Everyone who appears as a preparer or reviewer anywhere, for the filter. */
  const allPeople = useMemo(() => {
    const names = new Set<string>()
    for (const c of data?.companies ?? []) {
      for (const p of c.focus?.preparers ?? []) names.add(p.name)
      for (const p of c.focus?.reviewers ?? []) names.add(p.name)
    }
    return [...names].sort((a, b) => a.localeCompare(b))
  }, [data])

  const rows = useMemo(() => {
    const q = deferredSearch.trim().toLowerCase()
    const list = (data?.companies ?? []).filter((c) => {
      if (!matchesStatus(c, status)) return false
      if (q && !displayName(c).toLowerCase().includes(q)) return false
      if (person !== "all") {
        const on = [...(c.focus?.preparers ?? []), ...(c.focus?.reviewers ?? [])]
        if (!on.some((p) => p.name === person)) return false
      }
      return true
    })

    const dir = sort.dir === "asc" ? 1 : -1
    return [...list].sort((a, b) => {
      if (sort.key === "urgency") return (urgencyScore(b) - urgencyScore(a)) * (dir === 1 ? -1 : 1)
      const av = sort.key === "name" ? displayName(a).toLowerCase() : sortValue(a, sort.key)
      const bv = sort.key === "name" ? displayName(b).toLowerCase() : sortValue(b, sort.key)
      // Empty always sinks, whichever way the arrow points: a company with no
      // period is not "the oldest" just because you reversed the sort.
      if (av == null && bv == null) return urgencyScore(b) - urgencyScore(a)
      if (av == null) return 1
      if (bv == null) return -1
      if (av < bv) return -1 * dir
      if (av > bv) return 1 * dir
      return urgencyScore(b) - urgencyScore(a)
    })
  }, [data, deferredSearch, status, person, sort, displayName])

  const kpis = useMemo(() => {
    const list = data?.companies ?? []
    return {
      total:    list.length,
      ready:    list.filter((c) => c.focus?.status === "complete").length,
      behind:   list.filter((c) => c.focus && c.focus.status !== "complete"
                                   && c.focus.days_since_period_end >= 7).length,
      caughtUp: list.filter((c) => c.books_set && c.qbo_connected && !c.focus).length,
    }
  }, [data])

  const filtered = status !== "all" || person !== "all" || search.trim() !== ""

  function toggleSort(key: SortKey) {
    setSort((s) => s.key === key
      ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
      // First click on a column picks the direction that reads best: names
      // A→Z, everything numeric worst-first.
      : { key, dir: key === "name" || key === "preparer" || key === "reviewer" ? "asc" : "desc" })
  }

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

  const selectStyle = {
    background: "var(--surface)",
    border: "1px solid var(--border-strong)",
    color: "var(--text)",
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto" style={{ background: "var(--bg)" }}>
      <PageHeader
        title="Command Center"
        subtitle="Every company's close on one screen — where each one stands and who's on it."
        actions={
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold disabled:opacity-60 transition-opacity"
            style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }}
          >
            <RefreshCw size={12} strokeWidth={2.2} className={isFetching ? "animate-spin" : ""} />
            Refresh
          </button>
        }
      />

      <div className="flex-1 px-4 sm:px-6 py-5 max-w-[1680px] w-full mx-auto space-y-4">

        {/* KPI strip */}
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
                  style={{ color: "var(--text-muted)" }}>
                  {k.label}
                </p>
                <p className="text-xl font-bold mt-0.5 tabular-nums" style={{ color: k.tone }}>
                  {k.value}
                </p>
              </div>
            ))}
          </div>
        )}

        {/* Filters */}
        {!isLoading && !isError && (
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative">
              <Search size={13} strokeWidth={2}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
                style={{ color: "var(--text-muted)" }} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search companies…"
                className="rounded-lg pl-8 pr-3 py-1.5 text-xs w-56 outline-none focus:ring-1"
                style={{ ...selectStyle }}
              />
            </div>

            <select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}
              className="rounded-lg px-2.5 py-1.5 text-xs font-medium outline-none"
              style={selectStyle}>
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>

            {allPeople.length > 0 && (
              <select value={person} onChange={(e) => setPerson(e.target.value)}
                className="rounded-lg px-2.5 py-1.5 text-xs font-medium outline-none max-w-[190px]"
                style={selectStyle}
                title="Companies this person prepared or approved">
                <option value="all">Anyone on the engagement</option>
                {allPeople.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            )}

            {filtered && (
              <button
                onClick={() => { setSearch(""); setStatus("all"); setPerson("all") }}
                className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-semibold transition-opacity hover:opacity-80"
                style={{ color: "var(--text-muted)" }}
              >
                <X size={11} strokeWidth={2.4} /> Clear
              </button>
            )}

            <span className="text-[11px] ml-auto tabular-nums" style={{ color: "var(--text-muted)" }}>
              {rows.length} of {kpis.total}
            </span>
          </div>
        )}

        {/* Loading skeleton */}
        {isLoading && (
          <div className="space-y-1.5">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="rounded-lg h-9 animate-pulse"
                style={{ background: "var(--surface)", border: "1px solid var(--border)" }} />
            ))}
          </div>
        )}

        {/* Error state */}
        {isError && (
          <div className="rounded-xl px-4 py-3 flex items-center gap-3"
            style={{ background: "#f7eeec", border: "1px solid #ecd7d3", color: "#86332e" }}>
            <p className="text-sm flex-1">Couldn't load the firm view. Check your connection and retry.</p>
            <button onClick={() => refetch()}
              className="text-xs font-bold underline underline-offset-2">Retry</button>
          </div>
        )}

        {/* The table. `table-layout: fixed` + colgroup is what guarantees the
            header and the body share one set of column edges. */}
        {!isLoading && !isError && rows.length > 0 && (
          <div className="rounded-xl overflow-hidden overflow-x-auto"
            style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
            {/* min-width is the sum of the fixed columns (1020px) plus a floor
                for Company. Measured at 1120 the Company column collapsed to
                ~100px and long names wrapped, tripling the row height — the
                thing this layout exists to avoid. */}
            <table className="w-full min-w-[1300px]" style={{ tableLayout: "fixed", borderCollapse: "collapse" }}>
              <colgroup>
                {COLUMNS.map((col, i) => <col key={i} style={{ width: col.width }} />)}
              </colgroup>
              <thead>
                <tr style={{ background: "var(--surface-2)" }}>
                  {COLUMNS.map((col, i) => {
                    const active = col.key !== null && sort.key === col.key
                    return (
                      <th key={i}
                        className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider select-none"
                        style={{
                          color: active ? "var(--text)" : "var(--text-muted)",
                          textAlign: col.align ?? "left",
                          borderBottom: "1px solid var(--border)",
                          cursor: col.key ? "pointer" : "default",
                        }}
                        onClick={col.key ? () => toggleSort(col.key!) : undefined}
                      >
                        <span className="inline-flex items-center gap-1">
                          {col.label}
                          {active && (sort.dir === "asc"
                            ? <ChevronUp size={11} strokeWidth={2.6} />
                            : <ChevronDown size={11} strokeWidth={2.6} />)}
                        </span>
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const f = c.focus
                  const needsSetup = !c.books_set || !c.qbo_connected
                  const isCurrent = c.clerk_org_id === organization?.id
                  const tone = f ? daysTone(f.days_since_period_end) : null
                  return (
                    <tr
                      key={c.tenant_id}
                      onClick={() => openCompany(c)}
                      className="cursor-pointer transition-colors hover:bg-[var(--surface-2)]"
                      style={{ borderBottom: "1px solid var(--border)" }}
                    >
                      {/* Company. overflow-hidden so the truncate inside can
                          actually clip — without it a long name grows the cell
                          and the row stops being one line. */}
                      <td className="px-3 py-1.5 overflow-hidden">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="text-[13px] font-semibold truncate"
                            style={{ color: "var(--text)" }}>
                            {displayName(c)}
                          </span>
                          {isCurrent && <Chip label="Current" fg="var(--green)" bg="var(--green-subtle)" />}
                          {c.is_demo && <Chip label="Sample" fg="var(--text-muted)" bg="var(--surface-2)" />}
                        </div>
                      </td>

                      {/* Closed through */}
                      <td className="px-3 py-1.5 text-[12px]"
                        style={{ color: c.closed_through ? "var(--text-2)" : "var(--border-strong)" }}>
                        {c.closed_through ?? "—"}
                      </td>

                      {/* Focus period */}
                      <td className="px-3 py-1.5 text-[12px] font-medium"
                        style={{ color: f ? "var(--text)" : "var(--border-strong)" }}>
                        {f?.label ?? "—"}
                      </td>

                      {/* Progress */}
                      <td className="px-3 py-1.5">
                        {needsSetup ? (
                          <Chip
                            icon={<Plug size={9} strokeWidth={2.4} />}
                            label={!c.books_set ? "Books setup" : "QBO disconnected"}
                            fg="#8a6326" bg="rgba(199, 154, 82, 0.12)"
                          />
                        ) : f ? (
                          <ProgressCell
                            approved={f.approved} reviewed={f.reviewed}
                            flagged={f.flagged} total={Math.max(f.total, 1)}
                          />
                        ) : (
                          <span className="text-[11px]" style={{ color: "var(--green)" }}>
                            All months closed
                          </span>
                        )}
                      </td>

                      {/* Preparer / Reviewer */}
                      <td className="px-3 py-1.5 min-w-0"><PeopleCell people={f?.preparers} /></td>
                      <td className="px-3 py-1.5 min-w-0"><PeopleCell people={f?.reviewers} /></td>

                      {/* Signals */}
                      <td className="px-3 py-1.5">
                        <div className="flex items-center gap-1 flex-nowrap overflow-hidden">
                          {(f?.flagged ?? 0) > 0 && (
                            <Chip icon={<Flag size={9} strokeWidth={2.4} />}
                              label={String(f!.flagged)} title={`${f!.flagged} flagged accounts`}
                              fg="#9b3d37" bg="#f7eeec" />
                          )}
                          {c.flux && (
                            <Chip icon={<TrendingUp size={9} strokeWidth={2.4} />}
                              label={`${c.flux.approved}/${c.flux.total}`}
                              title={`Flux: ${c.flux.approved} of ${c.flux.total} variances approved`}
                              fg={c.flux.state === "done" ? "var(--green)" : "#3c5a76"}
                              bg={c.flux.state === "done" ? "var(--green-subtle)" : "#e9eef3"} />
                          )}
                          {!c.flux && f && (
                            <Chip icon={<TrendingUp size={9} strokeWidth={2.4} />}
                              label="—" title="Flux not run for this period"
                              fg="var(--text-muted)" bg="var(--surface-2)" />
                          )}
                          {c.open_adjustments > 0 && (
                            <Chip icon={<Sparkles size={9} strokeWidth={2.4} />}
                              label={String(c.open_adjustments)}
                              title={`${c.open_adjustments} open proposed entries`}
                              fg="var(--text-2)" bg="var(--surface-2)" />
                          )}
                        </div>
                      </td>

                      {/* Age */}
                      <td className="px-3 py-1.5 text-right">
                        {f && tone ? (
                          <span
                            className="text-[11px] font-semibold tabular-nums rounded px-1.5 py-px"
                            title={`${f.days_since_period_end} days since ${f.label} ended`}
                            style={{ color: tone.fg, background: tone.bg }}
                          >
                            {f.days_since_period_end}d
                          </span>
                        ) : (
                          <span className="text-[12px]" style={{ color: "var(--border-strong)" }}>—</span>
                        )}
                      </td>

                      {/* Open */}
                      <td className="px-3 py-1.5 text-right">
                        <span className="inline-flex items-center justify-end gap-1 text-[11px] font-semibold"
                          style={{ color: isCurrent ? "var(--text-muted)" : "var(--green)" }}>
                          {switchingId === c.tenant_id
                            ? <Spinner className="h-3 w-3" />
                            : <>Open <ArrowRight size={11} strokeWidth={2.4} /></>}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Filtered to nothing — distinct from having no companies at all. */}
        {!isLoading && !isError && rows.length === 0 && kpis.total > 0 && (
          <div className="rounded-xl px-6 py-8 text-center"
            style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
            <p className="text-sm font-semibold" style={{ color: "var(--text)" }}>
              No companies match these filters
            </p>
            <button
              onClick={() => { setSearch(""); setStatus("all"); setPerson("all") }}
              className="text-xs font-bold underline underline-offset-2 mt-1.5"
              style={{ color: "var(--green)" }}
            >
              Clear filters
            </button>
          </div>
        )}

        {!isLoading && !isError && kpis.total === 0 && (
          <div className="rounded-xl px-6 py-10 text-center"
            style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
            <Building2 size={22} strokeWidth={1.6} className="mx-auto mb-2"
              style={{ color: "var(--text-muted)" }} />
            <p className="text-sm font-semibold" style={{ color: "var(--text)" }}>
              No companies yet
            </p>
            <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
              Create your first workspace and its close will show up here.
            </p>
          </div>
        )}

        {!isLoading && !isError && (
          <button
            onClick={() => navigate("/app/companies/new")}
            className="w-full rounded-xl px-5 py-2.5 flex items-center justify-center gap-2 text-xs font-semibold transition-colors hover:bg-[var(--surface)]"
            style={{ border: "1.5px dashed var(--border-strong)", color: "var(--text-muted)" }}
          >
            <Plus size={13} strokeWidth={2.2} />
            Add another company
          </button>
        )}
      </div>
    </div>
  )
}
