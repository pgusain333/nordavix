/**
 * ReconciliationsMonthIndex — month-by-month landing page for the Recons module.
 *
 * Layout:
 *   [Header]      Title + "what this is" tagline
 *   [Search]      Quick filter by month label (e.g. "Apr 2026")
 *   [Month rows]  One per month from books_start_date through current.
 *                 Each row shows status pill, approved / total count,
 *                 progress bar, and a "Open" button that lands the user
 *                 on the existing ReconciliationsDashboard scoped to that
 *                 specific period_end.
 *
 * Why a separate index instead of the existing dashboard:
 *   The dashboard is per-month — one period at a time. Users said they
 *   want to see "all my months" at a glance and drill in. This page is
 *   that view; clicking any row lands you on the full dashboard for the
 *   selected month (route: /app/reconciliations/period/:periodEnd).
 *
 * Empty states:
 *   - QBO not connected     → big CTA to /app/connections
 *   - Books not seeded      → CTA to /app/setup/books
 *   - Seeded but no months  → friendly placeholder (rare — only the very
 *                             first millisecond after seeding)
 */
import { useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { motion } from "framer-motion"
import {
  CalendarCheck,
  ArrowRight,
  ArrowLeft,
  Search,
  Lock,
  CheckCircle2,
  Circle,
  Plug,
  ShieldCheck,
  ListChecks,
} from "lucide-react"
import { Button, Spinner } from "@/core/ui/components"
import { reconsApi, type PeriodStatus } from "@/modules/recons/api"
import { api as fluxApi } from "@/modules/flux/api"

// ── Status visuals ─────────────────────────────────────────────────────────

const STATUS_META: Record<PeriodStatus, { label: string; fg: string; bg: string; icon: React.ReactNode }> = {
  closed: {
    label: "Closed",
    fg: "#b45309",
    bg: "rgba(245, 158, 11, 0.10)",
    icon: <Lock size={11} strokeWidth={2} />,
  },
  complete: {
    label: "Complete",
    fg: "var(--green)",
    bg: "var(--green-subtle)",
    icon: <CheckCircle2 size={11} strokeWidth={2} />,
  },
  in_progress: {
    label: "In progress",
    fg: "#1d4ed8",
    bg: "#dbeafe",
    icon: <Circle size={11} strokeWidth={2} />,
  },
  not_started: {
    label: "Not started",
    fg: "var(--text-muted)",
    bg: "var(--surface-2)",
    icon: <Circle size={11} strokeWidth={2} />,
  },
}

// ── Component ──────────────────────────────────────────────────────────────

export function ReconciliationsMonthIndex() {
  const navigate = useNavigate()
  const [search, setSearch] = useState("")

  const { data: qbo, isLoading: qboLoading } = useQuery({
    queryKey: ["qbo-connection"],
    queryFn:  fluxApi.getQboConnection,
    staleTime: 5 * 60_000,
  })

  const { data: books, isLoading: booksLoading } = useQuery({
    queryKey: ["books-status"],
    queryFn:  reconsApi.getBooksStatus,
    staleTime: 5 * 60_000,
  })

  const { data: tracker, isLoading: trackerLoading } = useQuery({
    queryKey: ["period-tracker"],
    queryFn:  reconsApi.listPeriodTracker,
    enabled:  books?.seeded === true,
    staleTime: 60_000,
  })

  // Filter + sort: newest first, optional text filter against label.
  const rows = useMemo(() => {
    const list = tracker?.periods ?? []
    const q = search.trim().toLowerCase()
    const filtered = q
      ? list.filter((p) => p.label.toLowerCase().includes(q) || p.period_end.includes(q))
      : list
    // Sort newest first
    return filtered.slice().sort((a, b) => (a.period_end < b.period_end ? 1 : -1))
  }, [tracker, search])

  const totals = useMemo(() => {
    const periods = tracker?.periods ?? []
    return {
      months:    periods.length,
      closed:    periods.filter((p) => p.status === "closed").length,
      complete:  periods.filter((p) => p.status === "complete").length,
      open:      periods.filter((p) => p.status === "in_progress" || p.status === "not_started").length,
    }
  }, [tracker])

  const loading = qboLoading || booksLoading || trackerLoading

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
              Reconciliations
            </h1>
            <p className="text-xs sm:text-sm mt-1.5" style={{ color: "var(--text-muted)" }}>
              Pick a month to open its live GL-vs-subledger reconciliation.
              Every balance-sheet account from QuickBooks is reconciled to its
              source data — bank statements, AR/AP aging, fixed-asset rolls, etc.
            </p>
          </div>
          <Button size="sm" variant="outline" icon={<ListChecks size={12} strokeWidth={1.8} />}
            onClick={() => navigate("/app/reconciliations/overrides")}>
            Manual overrides
          </Button>
        </div>
      </motion.div>

      <div className="flex-1 px-4 sm:px-8 py-5 max-w-6xl w-full mx-auto space-y-5">

        {/* Setup-required CTA(s) */}
        {!loading && !qbo && (
          <SetupCard
            icon={<Plug size={20} strokeWidth={1.6} style={{ color: "#b45309" }} />}
            title="Connect QuickBooks first"
            body="Reconciliations pull live GL balances and subledger detail from QuickBooks. Connect once and every month is reconciled automatically as data lands."
            cta="Connect QuickBooks"
            onClick={() => navigate("/app/connections")}
          />
        )}
        {!loading && qbo && books && !books.seeded && (
          <SetupCard
            icon={<ShieldCheck size={20} strokeWidth={1.6} style={{ color: "#b45309" }} />}
            title="Set your books start date"
            body="Tell Nordavix when your books begin and the prior-period closing balances. After that, every month rolls forward automatically and shows up here."
            cta="Set books start date"
            onClick={() => navigate("/app/setup/books")}
          />
        )}

        {/* Toolbar: search + summary chips */}
        {!loading && qbo && books?.seeded && (tracker?.periods.length ?? 0) > 0 && (
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
              <Chip label={`${totals.closed} closed`} fg="#b45309" bg="rgba(245, 158, 11, 0.10)" />
              <Chip label={`${totals.complete} complete`} fg="var(--green)" bg="var(--green-subtle)" />
              <Chip label={`${totals.open} open`} fg="#1d4ed8" bg="#dbeafe" />
            </div>
          </div>
        )}

        {/* Month rows */}
        {loading ? (
          <div className="py-16 flex items-center justify-center"><Spinner /></div>
        ) : qbo && books?.seeded && (tracker?.periods.length ?? 0) === 0 ? (
          <div className="rounded-xl p-10 text-center"
            style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
            <CalendarCheck size={28} strokeWidth={1.6}
              className="mx-auto mb-3" style={{ color: "var(--text-muted)" }} />
            <p className="text-sm font-semibold text-theme mb-1">No months yet</p>
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              Books start date is {books?.books_start_date ?? "set"} but no months have been
              materialised. They'll appear here once the tracker computes them
              (refresh in a moment).
            </p>
          </div>
        ) : qbo && books?.seeded ? (
          <div className="rounded-xl overflow-hidden"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
            {/* Table header */}
            <div className="hidden sm:grid grid-cols-[1fr_120px_140px_180px_120px] gap-3 px-4 py-2 text-[10px] font-semibold uppercase tracking-wide"
              style={{ borderBottom: "1px solid var(--border)", background: "var(--surface-2)", color: "var(--text-muted)" }}>
              <span>Period</span>
              <span>Status</span>
              <span>Approved</span>
              <span>Progress</span>
              <span className="text-right">Action</span>
            </div>

            {rows.length === 0 ? (
              <div className="px-4 py-10 text-center text-xs" style={{ color: "var(--text-muted)" }}>
                No months match "{search}".
              </div>
            ) : (
              <ul>
                {rows.map((p, idx) => {
                  const meta = STATUS_META[p.status]
                  const pct = Math.min(100, Math.max(0, p.approved_pct))
                  return (
                    <motion.li
                      key={p.period_end}
                      initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.18, delay: Math.min(idx * 0.015, 0.18) }}
                    >
                      <button
                        onClick={() => navigate(`/app/reconciliations/period/${p.period_end}`)}
                        className="w-full grid grid-cols-[1fr_120px_140px_180px_120px] gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--surface-2)] items-center"
                        style={{ borderBottom: "1px solid var(--border)" }}
                      >
                        {/* Period label */}
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-theme">{p.label}</p>
                          <p className="text-[10px] font-mono mt-0.5" style={{ color: "var(--text-muted)" }}>
                            {p.period_end}
                          </p>
                        </div>

                        {/* Status pill */}
                        <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold w-fit"
                          style={{ background: meta.bg, color: meta.fg }}>
                          {meta.icon}
                          {meta.label}
                        </span>

                        {/* Counts */}
                        <div className="text-xs tabular-nums" style={{ color: "var(--text)" }}>
                          {p.total === 0 ? (
                            <span style={{ color: "var(--text-muted)" }}>—</span>
                          ) : (
                            <>
                              <span className="font-semibold">{p.counts.approved}</span>
                              <span style={{ color: "var(--text-muted)" }}> / {p.total}</span>
                              <div className="text-[9px] mt-0.5 flex items-center gap-1.5" style={{ color: "var(--text-muted)" }}>
                                {p.counts.flagged > 0 && <span title="Flagged">🚩 {p.counts.flagged}</span>}
                                {p.counts.pending > 0 && <span title="Pending">⌛ {p.counts.pending}</span>}
                                {p.counts.reviewed > 0 && <span title="Reviewed">👁 {p.counts.reviewed}</span>}
                              </div>
                            </>
                          )}
                        </div>

                        {/* Progress bar */}
                        <div className="w-full">
                          {p.total === 0 ? (
                            <span className="text-[10px] italic" style={{ color: "var(--text-muted)" }}>not started</span>
                          ) : (
                            <>
                              <div className="h-1.5 w-full rounded-full overflow-hidden"
                                style={{ background: "rgba(0,0,0,0.08)" }}>
                                <div className="h-full rounded-full transition-all"
                                  style={{ width: `${pct}%`, background: meta.fg }} />
                              </div>
                              <p className="text-[9px] mt-1" style={{ color: "var(--text-muted)" }}>
                                {pct}%
                              </p>
                            </>
                          )}
                        </div>

                        {/* Action */}
                        <span className="inline-flex items-center justify-end gap-1 text-xs font-semibold"
                          style={{ color: "var(--green)" }}>
                          Open <ArrowRight size={12} strokeWidth={2} />
                        </span>
                      </button>
                    </motion.li>
                  )
                })}
              </ul>
            )}
            <div className="px-4 py-2 text-[10px] flex items-center justify-between"
              style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}>
              <span>Books started {tracker!.books_start_date}</span>
              <span>{totals.months} month{totals.months === 1 ? "" : "s"} tracked</span>
            </div>
          </div>
        ) : null}
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
        style={{ background: "rgba(245, 158, 11, 0.15)", border: "2px dashed #f59e0b" }}>
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
