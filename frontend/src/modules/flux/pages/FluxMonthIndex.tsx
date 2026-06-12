/**
 * FluxMonthIndex — month-by-month landing page for the Flux Analysis module.
 *
 * Layout:
 *   [Header]      Title + "what this is" tagline + New Analysis button
 *   [Search]      Quick filter by month label (e.g. "Apr 2026")
 *   [Month rows]  One per month from books_start through current.
 *                 Each row shows:
 *                   - Month label + ISO date
 *                   - Count of flux analyses for that month
 *                   - Status mix (complete / generating / pending / error)
 *                   - "Open" button → /app/flux?period=YYYY-MM-DD (sidebar
 *                     scrolls to that month; existing UploadFlow handles
 *                     the no-TB case)
 *
 * Why a separate index instead of dumping the user straight into
 * FluxDashboard:
 *   The user explicitly requested a month-wise dashboard like the recons
 *   one. This index gives them a single-glance view of "which months
 *   have flux done, which don't" and a one-click route to the actual
 *   analysis workspace.
 *
 * Empty states:
 *   - QBO not connected     → CTA to /app/connections
 *   - Books not seeded      → CTA to /app/setup/books
 *   - Seeded but no flux    → friendly placeholder + New Analysis CTA
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { formatDate } from "@/core/lib/dates"
import { motion } from "framer-motion"
import {
  BarChart3,
  ArrowRight,
  ArrowLeft,
  Search,
  CheckCircle2,
  Circle,
  Plug,
  ShieldCheck,
  Plus,
  AlertCircle,
  Sparkles,
} from "lucide-react"
import { Button } from "@/core/ui/components"
import { SkeletonTable } from "@/core/ui/Skeleton"
import { humanize } from "@/core/ui/utils"
import { api as fluxApi, type TrialBalance } from "@/modules/flux/api"
import { useQboConnection } from "@/modules/flux/hooks"
import { reconsApi } from "@/modules/recons/api"

// ── Helpers ────────────────────────────────────────────────────────────────

function monthLabelFromIso(iso: string): string {
  try {
    const d = new Date(iso + "T00:00:00")
    return d.toLocaleDateString(undefined, { month: "short", year: "numeric" })
  } catch { return iso }
}

function longMonthLabelFromIso(iso: string): string {
  try {
    const d = new Date(iso + "T00:00:00")
    return d.toLocaleDateString(undefined, { month: "long", year: "numeric" })
  } catch { return iso }
}

// ── Status visuals ─────────────────────────────────────────────────────────

const STATUS_DOT: Record<string, string> = {
  pending:          "var(--border-strong)",
  processing:       "#c79a52",
  parsed:           "#4e6e8e",
  ready_for_review: "#4e6e8e",
  generating:       "#c79a52",
  complete:         "var(--green)",
  error:            "#9b3d37",
}

// Human-readable labels for the same status keys. The shared `humanize`
// helper handles unknown keys with a snake_case → Title Case fallback
// so a new backend status never leaks raw into the UI again.
const STATUS_LABEL: Record<string, string> = {
  ready_for_review: "In review",
}
function humanizeStatus(s: string): string { return humanize(s, STATUS_LABEL) }

// ── Component ──────────────────────────────────────────────────────────────

interface MonthRow {
  periodEnd:    string   // ISO YYYY-MM-DD
  label:        string   // "Apr 2026"
  longLabel:    string   // "April 2026"
  tbs:          TrialBalance[]
  hasComplete:  boolean
  hasInflight:  boolean   // processing | generating
  hasError:     boolean
}

export function FluxMonthIndex() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [search, setSearch] = useState("")
  // Period passed in from the Dashboard's "Open Flux Analysis" tile.
  // We use it for two things: scroll the matching month row into view
  // and visually highlight it so the user sees "you came from there".
  const focusedPeriod = searchParams.get("period")
  const focusedRowRef = useRef<HTMLLIElement | null>(null)

  const { data: qbo, isLoading: qboLoading } = useQboConnection()

  const { data: books, isLoading: booksLoading } = useQuery({
    queryKey: ["books-status"],
    queryFn:  reconsApi.getBooksStatus,
    staleTime: 5 * 60_000,
  })

  // Use the same tracker as Recons so months are listed identically.
  // Falls back to TB-derived months if tracker is unavailable.
  const { data: tracker } = useQuery({
    queryKey: ["period-tracker"],
    queryFn:  reconsApi.listPeriodTracker,
    enabled:  books?.seeded === true,
    staleTime: 60_000,
  })

  const { data: tbs = [], isLoading: tbsLoading } = useQuery({
    queryKey: ["flux-trial-balances"],
    queryFn:  fluxApi.listTrialBalances,
    staleTime: 60_000,
  })

  // Build month rows. Source of truth for "which months exist" is the
  // tracker (so empty months still show); each row attaches its matching
  // TBs by year+month of period_current.
  const rows: MonthRow[] = useMemo(() => {
    const trackerMonths = tracker?.periods ?? []
    // Index TBs by YYYY-MM of period_current
    const tbByMonth = new Map<string, TrialBalance[]>()
    for (const tb of tbs) {
      const pc = (tb.period_current || "").slice(0, 7)
      if (!pc) continue
      const list = tbByMonth.get(pc) ?? []
      list.push(tb)
      tbByMonth.set(pc, list)
    }

    const built: MonthRow[] = []
    const seenMonths = new Set<string>()

    // First: every month the tracker knows about (even with zero flux)
    for (const p of trackerMonths) {
      const ym = p.period_end.slice(0, 7)
      seenMonths.add(ym)
      const monthTbs = tbByMonth.get(ym) ?? []
      built.push({
        periodEnd:   p.period_end,
        label:       p.label,
        longLabel:   longMonthLabelFromIso(p.period_end),
        tbs:         monthTbs,
        hasComplete: monthTbs.some((t) => t.status === "complete"),
        hasInflight: monthTbs.some((t) => t.status === "processing" || t.status === "generating"),
        hasError:    monthTbs.some((t) => t.status === "error"),
      })
    }

    // Second: any TB months NOT in tracker (e.g. flux ran for a month
    // outside the books-start range). Surface them so they're not lost.
    for (const [ym, list] of tbByMonth.entries()) {
      if (seenMonths.has(ym)) continue
      // Synthesize a period_end (last day of month) from any TB
      const sample = list[0].period_current
      built.push({
        periodEnd:   sample,
        label:       monthLabelFromIso(sample),
        longLabel:   longMonthLabelFromIso(sample),
        tbs:         list,
        hasComplete: list.some((t) => t.status === "complete"),
        hasInflight: list.some((t) => t.status === "processing" || t.status === "generating"),
        hasError:    list.some((t) => t.status === "error"),
      })
    }

    return built
  }, [tracker, tbs])

  // Filter + newest-first sort.
  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase()
    const filtered = q
      ? rows.filter((r) => r.label.toLowerCase().includes(q) || r.periodEnd.includes(q))
      : rows
    return filtered.slice().sort((a, b) => (a.periodEnd < b.periodEnd ? 1 : -1))
  }, [rows, search])

  const totals = useMemo(() => ({
    months:     rows.length,
    withFlux:   rows.filter((r) => r.tbs.length > 0).length,
    complete:   rows.filter((r) => r.hasComplete && !r.hasInflight && !r.hasError).length,
    inflight:   rows.filter((r) => r.hasInflight).length,
    error:      rows.filter((r) => r.hasError).length,
    totalTbs:   tbs.length,
  }), [rows, tbs])

  const loading = qboLoading || booksLoading || tbsLoading

  // Click → land in FluxDashboard scoped to this month.
  // - One analysis: deep-link to it
  // - Zero analyses: open the new-analysis wizard with the period
  //   pre-filled (?new=1 prevents FluxDashboard's auto-select-most-
  //   recent effect from hijacking the navigation to some unrelated
  //   month's analysis the user has lying around)
  // - Multiple: drop on the main flux page scoped to this period;
  //   user picks from the sidebar list
  function openMonth(r: MonthRow) {
    if (r.tbs.length === 1) {
      navigate(`/app/flux/${r.tbs[0].id}`)
      return
    }
    if (r.tbs.length === 0) {
      navigate(`/app/flux/analyses?new=1&period=${r.periodEnd}`)
      return
    }
    navigate(`/app/flux/analyses?period=${r.periodEnd}`)
  }

  // Scroll the focused-period row into view + flash a brief outline
  // so the user lands oriented when they come from the dashboard tile.
  useEffect(() => {
    if (!focusedPeriod) return
    const el = focusedRowRef.current
    if (!el) return
    el.scrollIntoView({ behavior: "smooth", block: "center" })
  }, [focusedPeriod, filteredRows.length])

  return (
    <div className="flex flex-col h-full overflow-y-auto" style={{ background: "var(--bg)" }}>
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}
        className="px-4 sm:px-8 pt-6 pb-4"
        style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <button
              onClick={() => navigate("/app")}
              className="inline-flex items-center gap-1 text-[11px] font-medium mb-2 transition-opacity hover:opacity-70"
              style={{ color: "var(--text-muted)" }}
              title="Back to the workspace dashboard"
            >
              <ArrowLeft size={12} strokeWidth={2} />
              Back to dashboard
            </button>
            <h1 style={{
              fontSize: "clamp(20px, 4vw, 24px)", fontWeight: 700, lineHeight: 1.2,
              letterSpacing: "-0.01em", color: "var(--text)", margin: 0,
            }}>
              Flux Analysis
            </h1>
            <p className="text-xs sm:text-sm mt-1.5" style={{ color: "var(--text-muted)" }}>
              Pick a month to run or review variance analysis between the
              current and prior period. Material movements are flagged and
              AI narratives explain the &quot;why&quot; for each one.
            </p>
          </div>
          <Button size="sm" icon={<Plus size={12} strokeWidth={1.8} />}
            onClick={() => navigate("/app/flux/analyses")}>
            New analysis
          </Button>
        </div>
      </motion.div>

      <div className="flex-1 px-4 sm:px-8 py-5 max-w-6xl w-full mx-auto space-y-5">

        {/* Setup-required CTAs */}
        {!loading && !qbo && (
          <SetupCard
            icon={<Plug size={20} strokeWidth={1.6} style={{ color: "#8a6326" }} />}
            title="Connect QuickBooks first"
            body="Flux analysis pulls TrialBalance reports for the current and prior period live from QuickBooks. Connect once and run analyses for any month with two clicks."
            cta="Connect QuickBooks"
            onClick={() => navigate("/app/connections")}
          />
        )}
        {!loading && qbo && books && !books.seeded && (
          <SetupCard
            icon={<ShieldCheck size={20} strokeWidth={1.6} style={{ color: "#8a6326" }} />}
            title="Set your books start date"
            body="Once books are seeded, every closeable month appears here automatically — you can run flux for any of them and the comparison period defaults to one year prior."
            cta="Set books start date"
            onClick={() => navigate("/app/setup/books")}
          />
        )}

        {/* Toolbar: search + summary chips */}
        {!loading && qbo && (rows.length > 0 || tbs.length > 0) && (
          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative flex-1 min-w-[200px] max-w-md">
              <Search size={14} strokeWidth={1.8}
                className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                style={{ color: "var(--text-muted)" }} />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter months (e.g. Apr 2026)…"
                className="w-full rounded-lg pl-9 pr-3 py-2 text-sm outline-none"
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--border-strong)",
                  color: "var(--text)",
                }}
              />
            </div>
            <div className="flex items-center gap-2 text-[11px] flex-wrap" style={{ color: "var(--text-muted)" }}>
              <Chip label={`${totals.months} month${totals.months === 1 ? "" : "s"}`} />
              <Chip label={`${totals.withFlux} with flux`} fg="var(--green)" bg="var(--green-subtle)" />
              {totals.inflight > 0 && <Chip label={`${totals.inflight} running`} fg="#7a5622" bg="#f4eddf" />}
              {totals.error > 0 && <Chip label={`${totals.error} error`} fg="#9b3d37" bg="#f7eeec" />}
              <Chip label={`${totals.totalTbs} total`} />
            </div>
          </div>
        )}

        {/* Month rows */}
        {loading ? (
          /* Structured skeleton — keeps the table's shape while data lands. */
          <div className="rounded-xl overflow-hidden px-4 py-3"
            style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
            <SkeletonTable rows={6} />
          </div>
        ) : !qbo ? null : rows.length === 0 ? (
          <div className="rounded-xl p-10 text-center"
            style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
            <BarChart3 size={28} strokeWidth={1.6}
              className="mx-auto mb-3" style={{ color: "var(--text-muted)" }} />
            <p className="text-sm font-semibold text-theme mb-1">No analyses yet</p>
            <p className="text-xs mb-4 max-w-md mx-auto" style={{ color: "var(--text-muted)" }}>
              Run your first flux analysis to start tracking month-over-month
              variances. You can pull data straight from QuickBooks or upload a
              trial balance file.
            </p>
            <Button size="sm" icon={<Plus size={12} strokeWidth={1.8} />}
              onClick={() => navigate("/app/flux/analyses")}>
              Start a new analysis
            </Button>
          </div>
        ) : (
          <div className="rounded-xl overflow-hidden"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
            {/* Table header */}
            <div className="hidden sm:grid grid-cols-[1fr_120px_180px_180px_120px] gap-3 px-4 py-2 text-[10px] font-semibold uppercase tracking-wide"
              style={{ borderBottom: "1px solid var(--border)", background: "var(--surface-2)", color: "var(--text-muted)" }}>
              <span>Period</span>
              <span>Analyses</span>
              <span>Status mix</span>
              <span>Latest activity</span>
              <span className="text-right">Action</span>
            </div>

            {filteredRows.length === 0 ? (
              <div className="px-4 py-10 text-center text-xs" style={{ color: "var(--text-muted)" }}>
                No months match &quot;{search}&quot;.
              </div>
            ) : (
              <ul>
                {filteredRows.map((r, idx) => {
                  const latest = r.tbs.length
                    ? r.tbs.slice().sort((a, b) =>
                        (a.created_at < b.created_at ? 1 : -1))[0]
                    : null
                  const statusCounts: Record<string, number> = {}
                  for (const tb of r.tbs) statusCounts[tb.status] = (statusCounts[tb.status] || 0) + 1
                  // Did the user come here from the dashboard tile?
                  // If yes, highlight + scroll their row into view.
                  const isFocused = focusedPeriod === r.periodEnd
                  return (
                    <motion.li
                      key={r.periodEnd}
                      ref={isFocused ? focusedRowRef : null}
                      initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.18, delay: Math.min(idx * 0.015, 0.18) }}
                      style={isFocused ? {
                        background: "var(--green-subtle)",
                        boxShadow: "inset 3px 0 0 var(--green)",
                      } : undefined}
                    >
                      <button
                        onClick={() => openMonth(r)}
                        className="w-full flex flex-col gap-2 sm:grid sm:grid-cols-[1fr_120px_180px_180px_120px] sm:gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--surface-2)] sm:items-center"
                        style={{ borderBottom: "1px solid var(--border)" }}
                      >
                        {/* Period label */}
                        <div className="min-w-0 flex items-center justify-between sm:block">
                          <div>
                            <p className="text-sm font-semibold text-theme">{r.longLabel}</p>
                            <p className="text-[10px] font-mono mt-0.5" style={{ color: "var(--text-muted)" }}>
                              {r.periodEnd}
                            </p>
                          </div>
                          {/* Mobile-only action chevron — keeps the action affordance
                              visible on the top row instead of pushing it to the bottom. */}
                          <span className="sm:hidden inline-flex items-center gap-1 text-xs font-semibold"
                            style={{ color: r.tbs.length > 0 ? "var(--green)" : "var(--text-muted)" }}>
                            {r.tbs.length > 0 ? "Open" : "Start"}
                            {r.tbs.length > 0
                              ? <ArrowRight size={12} strokeWidth={2} />
                              : <Sparkles size={12} strokeWidth={2} />}
                          </span>
                        </div>

                        {/* Count */}
                        <div className="text-xs tabular-nums sm:block">
                          <span className="sm:hidden text-[10px] uppercase tracking-wide mr-1.5" style={{ color: "var(--text-muted)" }}>Analyses:</span>
                          {r.tbs.length === 0 ? (
                            <span className="italic" style={{ color: "var(--text-muted)" }}>none yet</span>
                          ) : (
                            <span className="font-semibold text-theme">
                              {r.tbs.length} analysis{r.tbs.length === 1 ? "" : "es"}
                            </span>
                          )}
                        </div>

                        {/* Status mix */}
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="sm:hidden text-[10px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>Status:</span>
                          {Object.entries(statusCounts).map(([status, count]) => (
                            <span key={status}
                              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold"
                              style={{
                                background: "var(--surface-2)",
                                color: "var(--text)",
                                border: `1px solid ${STATUS_DOT[status] ?? "var(--border)"}`,
                              }}>
                              <span className="h-1.5 w-1.5 rounded-full"
                                style={{ background: STATUS_DOT[status] ?? "var(--border-strong)" }} />
                              {humanizeStatus(status)} · {count}
                            </span>
                          ))}
                          {r.tbs.length === 0 && (
                            <span className="text-[10px] italic" style={{ color: "var(--text-muted)" }}>—</span>
                          )}
                        </div>

                        {/* Latest activity */}
                        <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                          {latest ? (
                            <>
                              <span className="sm:hidden text-[10px] uppercase tracking-wide mr-1.5">Latest:</span>
                              <span className="sm:block">
                                <span className="truncate inline-block max-w-[60vw] align-bottom text-theme">{latest.name || "Untitled"}</span>
                                <span className="sm:block text-[10px] sm:mt-0.5 ml-1 sm:ml-0">
                                  · {formatDate(latest.created_at)}
                                </span>
                              </span>
                            </>
                          ) : (
                            <>
                              <span className="sm:hidden text-[10px] uppercase tracking-wide mr-1.5">Latest:</span>
                              <span className="italic">no activity</span>
                            </>
                          )}
                        </div>

                        {/* Action — desktop only; mobile shows it in the period row */}
                        <span className="hidden sm:inline-flex items-center justify-end gap-1 text-xs font-semibold"
                          style={{ color: r.tbs.length > 0 ? "var(--green)" : "var(--text-muted)" }}>
                          {r.tbs.length > 0 ? "Open" : "Start"}
                          {r.tbs.length > 0
                            ? <ArrowRight size={12} strokeWidth={2} />
                            : <Sparkles size={12} strokeWidth={2} />}
                        </span>
                      </button>
                    </motion.li>
                  )
                })}
              </ul>
            )}
            <div className="px-4 py-2 text-[10px] flex items-center justify-between"
              style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}>
              <span>
                {tracker?.books_start_date && `Books started ${tracker.books_start_date} · `}
                {totals.totalTbs} total analyses
              </span>
              <span className="inline-flex items-center gap-1">
                {totals.error > 0 && <AlertCircle size={10} strokeWidth={2} style={{ color: "#9b3d37" }} />}
                {totals.inflight > 0 && <Circle size={10} strokeWidth={2} style={{ color: "#c79a52" }} />}
                {totals.complete > 0 && <CheckCircle2 size={10} strokeWidth={2} style={{ color: "var(--green)" }} />}
                {totals.withFlux} of {totals.months} months have flux
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Subcomponents ──────────────────────────────────────────────────────────

function Chip({ label, fg = "var(--text)", bg = "var(--surface)" }: { label: string; fg?: string; bg?: string }) {
  return (
    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold"
      style={{ background: bg, color: fg, border: "1px solid var(--border)" }}>
      {label}
    </span>
  )
}

function SetupCard({ icon, title, body, cta, onClick }:
  { icon: React.ReactNode; title: string; body: string; cta: string; onClick: () => void }) {
  return (
    <div className="rounded-xl p-5 flex items-start gap-4"
      style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
      <div className="h-10 w-10 rounded-full flex items-center justify-center shrink-0"
        style={{ background: "rgba(199, 154, 82, 0.15)", border: "2px dashed #c79a52" }}>
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-theme">{title}</p>
        <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>{body}</p>
        <Button size="sm" className="mt-3" icon={<ArrowRight size={12} strokeWidth={1.8} />}
          onClick={onClick}>
          {cta}
        </Button>
      </div>
    </div>
  )
}
