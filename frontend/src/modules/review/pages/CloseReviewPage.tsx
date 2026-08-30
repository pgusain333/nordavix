/**
 * CloseReviewPage — the AI reviewing-partner pass over a closed period.
 *
 * Autopilot prepares the close; Close Review signs off on it. The page runs a
 * battery of deterministic checks (reconciliation hygiene, completeness,
 * analytical review, anomalies) plus an AI analytical narrative, and presents
 * the exceptions grouped by severity, each with its evidence and a
 * clear / accept lifecycle, ending in a reviewer sign-off.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ShieldCheck, Sparkles, RefreshCw, Play, CheckCircle2, AlertTriangle,
  PenLine, ArrowRight, ExternalLink, Lock, Bot, FileText, Search, X,
  type LucideIcon,
} from "lucide-react"

import { PageHeader } from "@/core/ui/PageHeader"
import { DatePicker } from "@/core/ui/DatePicker"
import { Spinner } from "@/core/ui/components"
import { SkeletonPage } from "@/core/ui/Skeleton"
import { useSelectedPeriod } from "@/core/hooks/useSelectedPeriod"
import { formatDate, formatDateTime, toISODate } from "@/core/lib/dates"
import { workspaceApi } from "@/modules/workspace/api"
import { reviewApi, type ReviewFinding, type ReviewState, type Severity } from "../api"

const SEVERITY_META: Record<Severity, { label: string; bg: string; fg: string; border: string; icon: LucideIcon }> = {
  high:   { label: "High",   bg: "var(--danger-subtle)",   fg: "var(--danger)",   border: "var(--danger-border)",   icon: AlertTriangle },
  review: { label: "Review", bg: "var(--warn-subtle)",     fg: "var(--warn)",     border: "var(--warn-border)",     icon: AlertTriangle },
  info:   { label: "Info",   bg: "var(--info-subtle)",     fg: "var(--info)",     border: "var(--info-border)",     icon: Sparkles },
}
const SEVERITY_ORDER: Severity[] = ["high", "review", "info"]
const CATEGORY_LABEL: Record<string, string> = {
  control: "Control", completeness: "Completeness", analytical: "Analytical",
  anomaly: "Anomaly", hygiene: "Hygiene",
}
const RESOLVED_LABEL: Record<string, string> = {
  cleared: "Cleared", accepted: "Accepted", actioned: "Actioned", open: "Open",
}
const LINK_META: Record<string, { label: string; path: string }> = {
  recon:       { label: "Reconciliations", path: "/app/reconciliations" },
  flux:        { label: "Flux Analysis",   path: "/app/flux" },
  adjustments: { label: "Adjustments",     path: "/app/adjustments" },
  schedules:   { label: "Schedules",       path: "/app/schedules" },
  sync:        { label: "Reconciliations", path: "/app/reconciliations" },
}

function defaultPeriod(): string {
  const d = new Date()
  const last = new Date(d.getFullYear(), d.getMonth(), 0)
  return toISODate(last)
}

// ── JE-anomaly helpers (the rich finding card) ──────────────────────────────────
function fmtMoney(s?: string | null): string {
  if (s == null || s === "") return "—"
  const n = Number(s)
  if (Number.isNaN(n)) return "—"
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function fmtTxn(s?: string | null): string {
  if (!s) return ""
  const d = new Date(s + "T00:00:00")
  if (Number.isNaN(+d)) return s
  return formatDate(d)
}
// Standard QuickBooks Online deep link to a journal entry by transaction id.
const qboJournalUrl = (id: string) => `https://app.qbo.intuit.com/app/journal?txnId=${encodeURIComponent(id)}`

export function CloseReviewPage() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  // Default to the month being closed — shared with the dashboard + every
  // other module via the workspace-scoped selected-period store. Falls back
  // to last month only when nothing has been selected yet.
  const [period, setPeriod] = useSelectedPeriod(defaultPeriod())
  const [err, setErr] = useState<string | null>(null)

  const { data: me } = useQuery({
    queryKey: ["workspace-me"], queryFn: workspaceApi.getMe, staleTime: 10 * 60_000,
  })
  const canReview = me?.role === "admin" || me?.role === "reviewer"

  const { data: state, isLoading, isError, refetch } = useQuery({
    queryKey: ["review", period], queryFn: () => reviewApi.getState(period),
    enabled: !!period, staleTime: 30_000,
  })

  useEffect(() => { setErr(null) }, [period])
  const put = (s: ReviewState) => qc.setQueryData(["review", period], s)

  const runM = useMutation({
    mutationFn: () => reviewApi.run(period),
    onSuccess: put,
    onError: (e: unknown) => setErr(detail(e) ?? "Could not run the review."),
  })
  // Optimistic clear/accept/reopen — move the finding between the open and
  // Resolved lists (and adjust the severity counts) the instant the button is
  // clicked, so it doesn't visibly linger until the refetch. onSuccess(put)
  // overwrites with the authoritative server state; onError rolls back.
  const actM = useMutation({
    mutationFn: (v: { id: string; action: "clear" | "accept" | "reopen"; note?: string }) =>
      reviewApi.act(v.id, v.action, v.note),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ["review", period] })
      const prev = qc.getQueryData<ReviewState>(["review", period])
      if (prev) {
        const STATUS = { clear: "cleared", accept: "accepted", reopen: "open" } as const
        const target = prev.findings.find((f) => f.id === v.id) ?? prev.resolved.find((f) => f.id === v.id)
        if (target) {
          const updated: ReviewFinding = {
            ...target, status: STATUS[v.action],
            status_changed_at: new Date().toISOString(),
            note: v.action === "reopen" ? null : (v.note ?? target.note),
          }
          const reopening = v.action === "reopen"
          const findings = reopening
            ? [...prev.findings.filter((f) => f.id !== v.id), updated]
            : prev.findings.filter((f) => f.id !== v.id)
          const resolved = reopening
            ? prev.resolved.filter((f) => f.id !== v.id)
            : [...prev.resolved.filter((f) => f.id !== v.id), updated]
          const delta = reopening ? 1 : -1
          const review = prev.review ? {
            ...prev.review,
            high_count:   prev.review.high_count   + (updated.severity === "high"   ? delta : 0),
            review_count: prev.review.review_count + (updated.severity === "review" ? delta : 0),
          } : prev.review
          qc.setQueryData<ReviewState>(["review", period], { ...prev, findings, resolved, review })
        }
      }
      return { prev }
    },
    onSuccess: put,
    onError: (e: unknown, _v, ctx: { prev?: ReviewState } | undefined) => {
      if (ctx?.prev) qc.setQueryData(["review", period], ctx.prev)
      setErr(detail(e) ?? "Could not update the finding.")
    },
  })
  const signM = useMutation({
    mutationFn: (note: string) => reviewApi.signOff(period, note),
    onSuccess: (s) => { put(s); setSignOpen(false) },
    onError: (e: unknown) => setErr(detail(e) ?? "Could not sign off."),
  })
  const memoM = useMutation({
    mutationFn: () => reviewApi.downloadMemo(period),
    onError: (e: unknown) => setErr(detail(e) ?? "Could not build the memo."),
  })

  const review = state?.review ?? null
  const allFindings = useMemo(() => state?.findings ?? [], [state])
  const resolved = state?.resolved ?? []
  const label = state?.period_label ?? ""

  // ── Triage controls ───────────────────────────────────────────────────────
  // A close with 20 exceptions is an ordinary close, and the list had no way to
  // narrow or move through it. Filters are derived from what's actually on
  // screen, so a category chip never offers an empty result.
  const [q, setQ] = useState("")
  const [sevFilter, setSevFilter] = useState<Severity | null>(null)
  const [catFilter, setCatFilter] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => { setQ(""); setSevFilter(null); setCatFilter(null) }, [period])

  const categories = useMemo(
    () => [...new Set(allFindings.map((f) => f.category))].sort(),
    [allFindings],
  )
  const findings = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return allFindings.filter((f) => {
      if (sevFilter && f.severity !== sevFilter) return false
      if (catFilter && f.category !== catFilter) return false
      if (!needle) return true
      return (`${f.title} ${f.detail} ${f.account_label ?? ""}`).toLowerCase().includes(needle)
    })
  }, [allFindings, q, sevFilter, catFilter])
  const filtered = findings.length !== allFindings.length

  const grouped = useMemo(() => {
    const g: Record<Severity, ReviewFinding[]> = { high: [], review: [], info: [] }
    for (const f of findings) g[f.severity].push(f)
    return g
  }, [findings])

  // Master-detail selection for the desktop split view. Auto-select the top
  // finding; when the selected one is cleared/accepted it drops out of
  // `findings`, so this advances to the next — a natural triage flow.
  const [selId, setSelId] = useState<string | null>(null)
  useEffect(() => {
    if (!findings.length) { if (selId !== null) setSelId(null); return }
    if (!selId || !findings.some((f) => f.id === selId)) setSelId(findings[0].id)
  }, [findings, selId])
  const selectedFinding = findings.find((f) => f.id === selId) ?? null

  // ── Dispositions always carry a reason (required on high) ─────────────────
  const [pending, setPending] = useState<{ f: ReviewFinding; action: "clear" | "accept" } | null>(null)
  const [signOpen, setSignOpen] = useState(false)
  const askReason = useCallback(
    (f: ReviewFinding, action: "clear" | "accept") => setPending({ f, action }), [])

  // ── Keyboard triage ───────────────────────────────────────────────────────
  // j/k to move, c/a to dispose, / to search. Ignored while a dialog or a text
  // field has focus — a reviewer typing "accrual" into search must not clear
  // three findings on the way.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (pending || signOpen) return
      const t = e.target as HTMLElement | null
      const tag = t?.tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable) {
        if (e.key === "Escape") (t as HTMLElement).blur()
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === "/") { e.preventDefault(); searchRef.current?.focus(); return }
      if (!findings.length) return
      const i = Math.max(0, findings.findIndex((f) => f.id === selId))
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault(); setSelId(findings[Math.min(findings.length - 1, i + 1)].id)
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault(); setSelId(findings[Math.max(0, i - 1)].id)
      } else if ((e.key === "c" || e.key === "a") && canReview && findings[i]) {
        e.preventDefault(); askReason(findings[i], e.key === "c" ? "clear" : "accept")
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [findings, selId, canReview, pending, signOpen, askReason])

  return (
    <div className="flex flex-col h-full overflow-hidden" style={{ background: "var(--bg)" }}>
      <PageHeader
        title="Close Review"
        subtitle="An AI reviewing partner checks the close and hands you a sign-off memo"
        actions={
          <>
            <DatePicker value={period} onChange={setPeriod} compact />
            {/* The memo. Available before sign-off too — a partner reviewing a
                close in progress needs the same document, and one that refused
                to render until everything was signed would be retyped into
                Word instead. */}
            {review && (
              <button
                onClick={() => memoM.mutate()}
                disabled={memoM.isPending}
                title="Download the sign-off memo (PDF)"
                className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-60"
                style={{ border: "1px solid var(--border-strong)", color: "var(--text-2)" }}
              >
                {memoM.isPending ? <Spinner className="h-3.5 w-3.5" /> : <FileText size={13} strokeWidth={2} />}
                Memo
              </button>
            )}
            {canReview && (
              <button
                onClick={() => runM.mutate()}
                disabled={runM.isPending}
                className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
                style={{ background: "var(--green)" }}
              >
                {runM.isPending ? <Spinner className="h-3.5 w-3.5" /> : (review ? <RefreshCw size={13} strokeWidth={2} /> : <Play size={13} strokeWidth={2.4} />)}
                {runM.isPending ? "Reviewing…" : review ? "Re-run review" : "Run review"}
              </button>
            )}
          </>
        }
      />

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-6xl mx-auto px-4 sm:px-8 py-5 space-y-5">
          {err && (
            <div className="rounded-lg px-3 py-2.5 text-[12px] inline-flex items-start gap-1.5"
              style={{ background: "var(--danger-subtle)", color: "var(--danger)", border: "1px solid var(--danger-border)" }}>
              <AlertTriangle size={13} strokeWidth={2} className="mt-0.5 shrink-0" />{err}
            </div>
          )}

          {isLoading ? (
            /* The page's own shape — four counts, then the exception list —
               so the layout doesn't jump when the data lands. */
            <SkeletonPage stats={4} cards={1} rows={6} columns={["8%", "52%", "22%"]} />
          ) : isError ? (
            <div className="rounded-2xl px-6 py-10 text-center"
              style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
              <AlertTriangle size={24} strokeWidth={1.7} className="mx-auto mb-2" style={{ color: "var(--warn)" }} />
              <p className="text-sm font-semibold" style={{ color: "var(--text)" }}>Couldn't load the review</p>
              <p className="text-[12px] mt-1 max-w-md mx-auto" style={{ color: "var(--text-muted)" }}>
                The Close Review service may still be deploying (database migration 046). Try again in a moment.
              </p>
              <button onClick={() => refetch()}
                className="mt-4 inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-semibold transition-colors"
                style={{ background: "var(--surface-2)", color: "var(--text-2)", border: "1px solid var(--border-strong)" }}>
                <RefreshCw size={13} strokeWidth={2} />Retry
              </button>
            </div>
          ) : review === null ? (
            <EmptyState label={label} canReview={canReview} running={runM.isPending} onRun={() => runM.mutate()} />
          ) : (
            <>
              {/* Header band: status + AI summary + metrics */}
              <section className="rounded-2xl overflow-hidden"
                style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
                <div className="p-5 sm:p-6">
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div className="flex items-start gap-3 min-w-0">
                      <span className="h-10 w-10 rounded-xl flex items-center justify-center shrink-0"
                        style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
                        <ShieldCheck size={19} strokeWidth={1.8} />
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h2 className="text-base font-bold text-theme leading-tight">Close review — {label}</h2>
                          <StatusPill review={review} />
                        </div>
                        <p className="text-[11px] mt-0.5" style={{ color: "var(--text-muted)" }}>
                          {review.checks_run} checks run · generated {review.generated_at ? formatDateTime(review.generated_at) : "—"}
                        </p>
                      </div>
                    </div>
                  </div>

                  {review.summary && (
                    <div className="mt-4 flex gap-2.5 rounded-xl p-3.5"
                      style={{ background: "var(--info-subtle)", border: "1px solid var(--info-border)" }}>
                      <Sparkles size={16} strokeWidth={1.8} className="shrink-0 mt-0.5" style={{ color: "var(--info)" }} />
                      <p className="text-[13px] leading-relaxed" style={{ color: "var(--info)" }}>{review.summary}</p>
                    </div>
                  )}

                  <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                    <Metric label="High" value={review.high_count} color="var(--danger)" />
                    <Metric label="To review" value={review.review_count} color="var(--warn)" />
                    <Metric label="Cleared" value={review.cleared_count} color="var(--positive)" />
                    <Metric label="Info" value={review.info_count} />
                  </div>

                  {/* What THIS run changed. After the preparer says they've
                      fixed things, the only question is which ones actually
                      went away — and a re-run used to answer it by silently
                      redrawing the same list. */}
                  {(review.new_count > 0 || review.resolved_count > 0) && (
                    <div className="mt-3 flex items-center gap-2 flex-wrap rounded-lg px-3 py-2"
                      style={{ background: "var(--surface-2)" }}>
                      <RefreshCw size={13} strokeWidth={2} className="shrink-0" style={{ color: "var(--text-muted)" }} />
                      <p className="text-[12px]" style={{ color: "var(--text-2)" }}>
                        Since the last run:{" "}
                        {review.resolved_count > 0 && (
                          <span style={{ color: "var(--positive)" }} className="font-semibold">
                            {review.resolved_count} resolved
                          </span>
                        )}
                        {review.resolved_count > 0 && review.new_count > 0 ? " · " : ""}
                        {review.new_count > 0 && (
                          <span style={{ color: "var(--warn)" }} className="font-semibold">
                            {review.new_count} new
                          </span>
                        )}
                      </p>
                    </div>
                  )}

                  {review.passed.length > 0 && (
                    <div className="mt-3 flex items-start gap-2 flex-wrap rounded-lg px-3 py-2"
                      style={{ background: "var(--surface-2)" }}>
                      <CheckCircle2 size={14} strokeWidth={2} className="shrink-0 mt-0.5" style={{ color: "var(--positive)" }} />
                      <p className="text-[12px]" style={{ color: "var(--text-2)" }}>
                        Passed: {review.passed.join(" · ")}
                      </p>
                    </div>
                  )}
                </div>
              </section>

              {/* Triage bar — search + severity + category. Only once the list
                  is long enough to need narrowing; below that it's chrome. */}
              {allFindings.length > 4 && (
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="relative flex-1 min-w-[180px]">
                    <Search size={13} strokeWidth={2} className="absolute left-2.5 top-1/2 -translate-y-1/2"
                      style={{ color: "var(--text-muted)" }} />
                    <input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)}
                      placeholder="Search exceptions…  (press /)"
                      className="w-full rounded-lg pl-8 pr-7 py-1.5 text-[12.5px] outline-none"
                      style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }} />
                    {q && (
                      <button onClick={() => setQ("")} aria-label="Clear search"
                        className="absolute right-2 top-1/2 -translate-y-1/2"
                        style={{ color: "var(--text-muted)" }}>
                        <X size={13} strokeWidth={2.2} />
                      </button>
                    )}
                  </div>
                  {SEVERITY_ORDER.filter((s) => allFindings.some((f) => f.severity === s)).map((s) => (
                    <Chip key={s} active={sevFilter === s} color={SEVERITY_META[s].fg}
                      onClick={() => setSevFilter(sevFilter === s ? null : s)}
                      label={`${SEVERITY_META[s].label} ${allFindings.filter((f) => f.severity === s).length}`} />
                  ))}
                  {categories.length > 1 && categories.map((c) => (
                    <Chip key={c} active={catFilter === c}
                      onClick={() => setCatFilter(catFilter === c ? null : c)}
                      label={CATEGORY_LABEL[c] ?? c} />
                  ))}
                  {filtered && (
                    <button onClick={() => { setQ(""); setSevFilter(null); setCatFilter(null) }}
                      className="text-[11.5px] font-semibold" style={{ color: "var(--text-muted)" }}>
                      Reset
                    </button>
                  )}
                  {/* Shortcuts are worthless undiscovered. Desktop only —
                      that's where the split view and a keyboard both are. */}
                  {canReview && (
                    <span className="hidden lg:inline-flex items-center gap-1 text-[10.5px]"
                      style={{ color: "var(--text-muted)" }}>
                      <Kbd>j</Kbd><Kbd>k</Kbd> move <Kbd>c</Kbd> clear <Kbd>a</Kbd> accept
                    </span>
                  )}
                </div>
              )}

              {/* Findings */}
              {findings.length === 0 ? (
                <div className="rounded-2xl px-4 py-8 text-center"
                  style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
                  <CheckCircle2 size={26} strokeWidth={1.6} className="mx-auto mb-2"
                    style={{ color: filtered ? "var(--text-muted)" : "var(--positive)" }} />
                  {/* An empty filter result is not a clean close, and saying so
                      would be the worst kind of wrong on this page. */}
                  <p className="text-sm font-semibold" style={{ color: "var(--text)" }}>
                    {filtered ? "Nothing matches this filter" : "No open exceptions"}
                  </p>
                  <p className="text-[12px] mt-1" style={{ color: "var(--text-muted)" }}>
                    {filtered
                      ? `${allFindings.length} exception${allFindings.length === 1 ? "" : "s"} are still open — clear the filter to see them.`
                      : "This close passed every review check."}
                  </p>
                </div>
              ) : (
                <>
                  {/* Narrow screens: stacked full cards. */}
                  <div className="lg:hidden space-y-5">
                    {SEVERITY_ORDER.filter((s) => grouped[s].length > 0).map((sev) => (
                      <div key={sev}>
                        <h3 className="text-[11px] font-bold uppercase tracking-wider mb-2 px-1" style={{ color: "var(--text-muted)" }}>
                          {SEVERITY_META[sev].label} · {grouped[sev].length}
                        </h3>
                        <div className="space-y-2.5">
                          {grouped[sev].map((f) => (
                            <FindingCard key={f.id} f={f} canReview={canReview} busy={actM.isPending}
                              onAct={(action) => askReason(f, action)}
                              onNavigate={(p) => navigate(p)} />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Desktop: master-detail split — findings list ↔ detail pane. */}
                  <div className="hidden lg:grid gap-4 items-start"
                    style={{ gridTemplateColumns: "minmax(0,340px) minmax(0,1fr)" }}>
                    <div className="rounded-2xl overflow-hidden"
                      style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
                      {SEVERITY_ORDER.filter((s) => grouped[s].length > 0).map((sev, gi) => (
                        <div key={sev}>
                          <div className="px-3 pt-3 pb-1.5 text-[10px] font-bold uppercase tracking-wider"
                            style={{ color: SEVERITY_META[sev].fg, borderTop: gi > 0 ? "1px solid var(--border)" : undefined }}>
                            {SEVERITY_META[sev].label} · {grouped[sev].length}
                          </div>
                          {grouped[sev].map((f) => (
                            <FindingRow key={f.id} f={f} selected={f.id === selId} onSelect={() => setSelId(f.id)} />
                          ))}
                        </div>
                      ))}
                    </div>
                    <div className="lg:sticky lg:top-0 self-start">
                      {selectedFinding ? (
                        <FindingCard f={selectedFinding} canReview={canReview} busy={actM.isPending}
                          onAct={(action) => askReason(selectedFinding, action)}
                          onNavigate={(p) => navigate(p)} />
                      ) : (
                        <div className="rounded-xl px-4 py-10 text-center"
                          style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
                          <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>Select a finding to see its detail.</p>
                        </div>
                      )}
                    </div>
                  </div>
                </>
              )}

              {/* Resolved */}
              {resolved.length > 0 && (
                <details className="rounded-2xl overflow-hidden"
                  style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
                  <summary className="px-5 py-3 cursor-pointer text-[13px] font-semibold" style={{ color: "var(--text-2)" }}>
                    Resolved · {resolved.length}
                  </summary>
                  <div className="px-5 pb-4 space-y-2">
                    {resolved.map((f) => (
                      <div key={f.id} className="flex items-start justify-between gap-3 rounded-lg px-3 py-2"
                        style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
                        <div className="min-w-0">
                          <p className="text-[13px] truncate" style={{ color: "var(--text-2)" }}>{f.title}</p>
                          {/* Who, when, and why — the three facts that turn a
                              disposition into a record. The name was stored
                              from the start and never shown, so this line used
                              to say a decision had been made but not by whom. */}
                          <p className="text-[10.5px] mt-0.5" style={{ color: "var(--positive)" }}>
                            {RESOLVED_LABEL[f.status] ?? f.status}
                            {f.status_changed_by_name ? ` by ${f.status_changed_by_name}` : ""}
                            {f.status_changed_at ? ` · ${formatDateTime(f.status_changed_at)}` : ""}
                          </p>
                          {f.note ? (
                            <p className="text-[11.5px] mt-1" style={{ color: "var(--text-2)" }}>{f.note}</p>
                          ) : f.severity === "high" ? (
                            /* Only possible on rows dispositioned before the
                               reason became mandatory — and worth naming,
                               because it is what the memo will print. */
                            <p className="text-[11px] mt-1 italic" style={{ color: "var(--warn)" }}>
                              No reason recorded — reopen and clear it again to add one.
                            </p>
                          ) : null}
                        </div>
                        {canReview && (
                          <button onClick={() => actM.mutate({ id: f.id, action: "reopen" })}
                            aria-label={`Reopen ${f.title}`}
                            className="text-[11px] font-semibold shrink-0 mt-0.5" style={{ color: "var(--text-muted)" }}>
                            Reopen
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </details>
              )}

              {/* Sign-off */}
              <SignOffBar review={review} label={label} canReview={canReview}
                busy={signM.isPending} onSignOff={() => setSignOpen(true)}
                onMemo={() => memoM.mutate()} memoBusy={memoM.isPending} />
            </>
          )}
        </div>
      </div>

      <ReasonDialog
        open={pending !== null}
        title={pending?.f.title ?? ""}
        severity={pending?.f.severity ?? "review"}
        action={pending?.action ?? "clear"}
        busy={actM.isPending}
        error={err}
        onCancel={() => { setPending(null); setErr(null) }}
        onConfirm={(note) => {
          if (!pending) return
          actM.mutate({ id: pending.f.id, action: pending.action, note },
            { onSuccess: () => { setPending(null); setErr(null) } })
        }}
      />
      <SignOffDialog
        open={signOpen} label={label} busy={signM.isPending}
        onCancel={() => setSignOpen(false)}
        onConfirm={(note) => signM.mutate(note)}
      />
    </div>
  )
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center justify-center rounded px-1 font-mono text-[10px]"
      style={{ background: "var(--surface-2)", border: "1px solid var(--border)",
               color: "var(--text-2)", minWidth: 15, lineHeight: "15px" }}>
      {children}
    </kbd>
  )
}

/** A filter chip. Active state carries colour when the filter has one (severity),
 *  otherwise the neutral selected treatment (category). */
function Chip({ label, active, color, onClick }: {
  label: string; active: boolean; color?: string; onClick: () => void
}) {
  return (
    <button type="button" onClick={onClick}
      className="rounded-full px-2.5 py-1 text-[11.5px] font-semibold transition-colors whitespace-nowrap"
      style={active
        ? { background: color ?? "var(--text-2)", color: "#fff",
            border: `1px solid ${color ?? "var(--text-2)"}` }
        : { background: "var(--surface)", color: "var(--text-2)",
            border: "1px solid var(--border)" }}>
      {label}
    </button>
  )
}

// ── Pieces ────────────────────────────────────────────────────────────────────

function detail(e: unknown): string | null {
  const ax = e as { response?: { data?: { detail?: string } } }
  return ax?.response?.data?.detail ?? null
}

// "Blocking" == high only, to agree with the sign-off gate. Review-severity
// items are surfaced as non-blocking ("to review").
function StatusPill({ review }: { review: { status: string; high_count: number; review_count: number } }) {
  if (review.status === "signed_off") {
    return <Pill bg="var(--positive-subtle)" fg="var(--positive)" icon={CheckCircle2} text="Signed off" />
  }
  if (review.high_count > 0) {
    return <Pill bg="var(--warn-subtle)" fg="var(--warn)" icon={AlertTriangle} text={`${review.high_count} to clear`} />
  }
  if (review.review_count > 0) {
    return <Pill bg="var(--info-subtle)" fg="var(--info)" icon={Sparkles} text={`${review.review_count} to review`} />
  }
  return <Pill bg="var(--positive-subtle)" fg="var(--positive)" icon={CheckCircle2} text="Ready to sign off" />
}

function Pill({ bg, fg, icon: Icon, text }: { bg: string; fg: string; icon: LucideIcon; text: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider"
      style={{ background: bg, color: fg }}>
      <Icon size={11} strokeWidth={2.4} />{text}
    </span>
  )
}

function Metric({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="rounded-lg p-3" style={{ background: "var(--surface-2)" }}>
      <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>{label}</p>
      <p className="text-xl font-bold mt-0.5" style={{ color: color ?? "var(--text)" }}>{value}</p>
    </div>
  )
}

// Compact row for the desktop split-view list (left pane).
function FindingRow({ f, selected, onSelect }: {
  f: ReviewFinding; selected: boolean; onSelect: () => void
}) {
  const meta = SEVERITY_META[f.severity]
  const je = f.meta?.kind === "journal_entry" ? f.meta : null
  const title = je ? f.title.replace(/\s*—\s*JE\s+.*$/i, "") : f.title
  const sub = je
    ? [`$${fmtMoney(je.amount)}`, f.account_label].filter(Boolean).join(" · ")
    : (f.account_label ?? (CATEGORY_LABEL[f.category] ?? f.category))
  return (
    <button type="button" onClick={onSelect}
      className="w-full text-left flex items-start gap-2.5 px-3 py-2.5 transition-colors"
      style={{
        background: selected ? "var(--surface-2)" : "transparent",
        borderLeft: `2px solid ${selected ? meta.fg : "transparent"}`,
      }}
      onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = "var(--surface-2)" }}
      onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = "transparent" }}>
      <span className="mt-1.5 h-2 w-2 rounded-full shrink-0" style={{ background: meta.fg }} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium truncate" style={{ color: selected ? "var(--text)" : "var(--text-2)" }}>{title}</span>
        {sub && <span className="block text-[11px] truncate mt-0.5" style={{ color: "var(--text-muted)" }}>{sub}</span>}
      </span>
    </button>
  )
}

function FindingCard({
  f, canReview, busy, onAct, onNavigate,
}: {
  f: ReviewFinding
  canReview: boolean
  busy: boolean
  onAct: (action: "clear" | "accept") => void
  onNavigate: (path: string) => void
}) {
  const meta = SEVERITY_META[f.severity]
  const link = f.link_hint ? LINK_META[f.link_hint] : undefined
  // Journal-entry anomalies carry structured extras (amount/date/flags + the
  // Dr/Cr lines that show which accounts the entry hit).
  const je = f.meta?.kind === "journal_entry" ? f.meta : null
  const lines = je?.lines ?? []
  // The JE id is already shown as a fact; drop the redundant "— JE 0243" suffix.
  const title = je ? f.title.replace(/\s*—\s*JE\s+.*$/i, "") : f.title

  return (
    <div className="relative rounded-xl overflow-hidden"
      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <span aria-hidden className="absolute left-0 top-0 bottom-0" style={{ width: 3, background: meta.fg }} />
      <div className="p-4 pl-5">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className="rounded px-1.5 py-0.5 text-[10px] font-bold" style={{ background: meta.bg, color: meta.fg }}>
                {meta.label}
              </span>
              <span className="text-[10px] uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
                {CATEGORY_LABEL[f.category] ?? f.category}{je ? " · Manual JE" : ""}
              </span>
            </div>
            <p className="text-sm font-semibold" style={{ color: "var(--text)" }}>{title}</p>
          </div>
          {je && (
            <div className="text-right shrink-0">
              <div className="text-[15px] font-bold tabular-nums" style={{ color: "var(--text)" }}>${fmtMoney(je.amount)}</div>
              <div className="text-[10px] font-mono mt-0.5" style={{ color: "var(--text-muted)" }}>
                {[je.doc ? `JE ${je.doc}` : "", fmtTxn(je.txn_date)].filter(Boolean).join(" · ")}
              </div>
            </div>
          )}
        </div>

        {/* JE flag chips */}
        {je && ((je.flags?.length ?? 0) > 0 || je.poster) && (
          <div className="flex flex-wrap gap-1.5 mt-2.5">
            {(je.flags ?? []).map((fl, i) => (
              <span key={i} className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
                style={{ background: "var(--warn-subtle)", color: "var(--warn)" }}>
                <AlertTriangle size={10} strokeWidth={2.4} />{fl}
              </span>
            ))}
            {je.poster && (
              <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px]"
                style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}>
                by {je.poster}
              </span>
            )}
          </div>
        )}

        {/* JE debit/credit account breakdown */}
        {lines.length > 0 && (
          <div className="mt-3 rounded-lg overflow-hidden" style={{ border: "1px solid var(--border)" }}>
            <div className="grid text-[12px]" style={{ gridTemplateColumns: "1fr auto auto" }}>
              <div className="px-2.5 py-1.5 text-[10px] uppercase tracking-wider" style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}>Account</div>
              <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-right" style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}>Debit</div>
              <div className="px-2.5 py-1.5 pl-3 text-[10px] uppercase tracking-wider text-right" style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}>Credit</div>
              {lines.map((ln, i) => (
                <Fragment key={i}>
                  <div className="px-2.5 py-1.5" style={{ borderTop: "1px solid var(--border)", color: "var(--text)" }}>{ln.account}</div>
                  <div className="px-3 py-1.5 text-right tabular-nums" style={{ borderTop: "1px solid var(--border)", color: ln.debit ? "var(--text)" : "var(--text-tertiary)" }}>{ln.debit ? fmtMoney(ln.debit) : "—"}</div>
                  <div className="px-2.5 py-1.5 pl-3 text-right tabular-nums" style={{ borderTop: "1px solid var(--border)", color: ln.credit ? "var(--text)" : "var(--text-tertiary)" }}>{ln.credit ? fmtMoney(ln.credit) : "—"}</div>
                </Fragment>
              ))}
            </div>
          </div>
        )}
        {je?.memo && <p className="text-[11px] mt-1.5 italic" style={{ color: "var(--text-muted)" }}>Memo: “{je.memo}”</p>}

        {/* Non-JE findings: plain detail + account chip */}
        {!je && (
          <>
            <p className="text-[12px] mt-1 leading-relaxed" style={{ color: "var(--text-2)" }}>{f.detail}</p>
            {f.account_label && (
              <span className="inline-flex items-center mt-2 rounded px-2 py-0.5 text-[10px] font-mono"
                style={{ background: "var(--surface-2)", color: "var(--text-2)", border: "1px solid var(--border)" }}>
                {f.account_label}
              </span>
            )}
          </>
        )}

        {f.recommended_action && (
          <p className="text-[12px] mt-2.5 inline-flex items-start gap-1.5" style={{ color: "var(--text-2)" }}>
            <ArrowRight size={12} strokeWidth={2} className="mt-0.5 shrink-0" style={{ color: "var(--green)" }} />{f.recommended_action}
          </p>
        )}

        {canReview && (
          <div className="flex items-center gap-2 mt-3 flex-wrap">
            {je && f.entity_ref ? (
              <a href={qboJournalUrl(f.entity_ref)} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors"
                style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
                Open in QuickBooks <ExternalLink size={11} strokeWidth={2.4} />
              </a>
            ) : link ? (
              <button onClick={() => onNavigate(link.path)}
                className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors"
                style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
                Open {link.label} <ArrowRight size={11} strokeWidth={2.4} />
              </button>
            ) : null}
            <button onClick={() => onAct("clear")} disabled={busy}
              className="rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors disabled:opacity-50"
              style={{ border: "1px solid var(--border-strong)", color: "var(--text-2)" }}>
              Clear
            </button>
            <button onClick={() => onAct("accept")} disabled={busy}
              className="rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors disabled:opacity-50"
              style={{ border: "1px solid var(--border)", color: "var(--text-muted)" }}>
              Accept
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function SignOffBar({
  review, label, canReview, busy, onSignOff, onMemo, memoBusy,
}: {
  review: {
    status: string; high_count: number; review_count: number
    signed_off_at: string | null; signed_off_by_name: string | null; signoff_note: string | null
  }
  label: string
  canReview: boolean
  busy: boolean
  onSignOff: () => void
  onMemo: () => void
  memoBusy: boolean
}) {
  if (review.status === "signed_off") {
    return (
      <div className="rounded-xl px-4 py-3.5"
        style={{ background: "var(--positive-subtle)", border: "1px solid var(--positive-border)" }}>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-start gap-2.5 min-w-0">
            <CheckCircle2 size={17} strokeWidth={2} className="shrink-0 mt-0.5" style={{ color: "var(--positive)" }} />
            <div className="min-w-0">
              <p className="text-[13px] font-semibold" style={{ color: "var(--positive)" }}>
                {label} close review signed off
                {review.signed_off_by_name ? ` by ${review.signed_off_by_name}` : ""}
                {review.signed_off_at ? ` · ${formatDateTime(review.signed_off_at)}` : ""}
              </p>
              {review.signoff_note && (
                <p className="text-[12px] mt-1 italic" style={{ color: "var(--text-2)" }}>
                  “{review.signoff_note}”
                </p>
              )}
            </div>
          </div>
          {/* The memo is the deliverable, so once it's signed it's the most
              likely next action on this page — not a button in the header. */}
          <button onClick={onMemo} disabled={memoBusy}
            className="inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-[12.5px] font-bold text-white shrink-0 disabled:opacity-60"
            style={{ background: "var(--positive)" }}>
            {memoBusy ? <Spinner className="h-3.5 w-3.5" /> : <FileText size={13} strokeWidth={2.2} />}
            Download memo
          </button>
        </div>
      </div>
    )
  }
  const blocked = review.high_count > 0
  return (
    <div className="rounded-xl px-4 py-3 flex items-center justify-between gap-3 flex-wrap"
      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <p className="text-[12px] inline-flex items-center gap-1.5"
        style={{ color: blocked ? "var(--warn)" : "var(--text-muted)" }}>
        {blocked
          ? <><Lock size={13} strokeWidth={2} />Clear or accept the high-priority items before signing off.</>
          : review.review_count > 0
            ? <><PenLine size={13} strokeWidth={2} />No blocking items — {review.review_count} still to review (optional).</>
            : <><PenLine size={13} strokeWidth={2} />Everything checks out — ready for your sign-off.</>}
      </p>
      {canReview && (
        <button onClick={onSignOff} disabled={blocked || busy}
          className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ background: blocked ? "var(--text-muted)" : "var(--green)" }}>
          {busy ? <Spinner className="h-4 w-4" /> : <PenLine size={14} strokeWidth={2.2} />}
          Sign off on {label}
        </button>
      )}
    </div>
  )
}

/**
 * The reason a finding was set aside.
 *
 * Required for high severity, optional otherwise — and the asymmetry is the
 * point. Setting aside a high exception is the one action here a partner may
 * later have to defend, and "cleared" with no words next to it is exactly what
 * a memo cannot say. The text lands on the memo verbatim, which the dialog
 * says out loud so nobody writes "ok" into a document a client will read.
 */
function ReasonDialog({
  open, title, severity, action, busy, error, onCancel, onConfirm,
}: {
  open: boolean
  title: string
  severity: Severity
  action: "clear" | "accept"
  busy: boolean
  error: string | null
  onCancel: () => void
  onConfirm: (note: string) => void
}) {
  const [note, setNote] = useState("")
  const required = severity === "high"
  const ref = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    if (open) { setNote(""); setTimeout(() => ref.current?.focus(), 30) }
  }, [open])
  if (!open) return null
  const tooShort = required && note.trim().length < 4
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(8,12,10,0.45)" }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel() }}>
      <div role="dialog" aria-modal="true" aria-label="Reason for this decision"
        className="w-full max-w-lg rounded-2xl overflow-hidden"
        style={{ background: "var(--surface)", border: "1px solid var(--border)",
                 boxShadow: "0 24px 60px rgba(0,0,0,0.28)" }}>
        <div className="px-5 pt-4 pb-3" style={{ borderBottom: "1px solid var(--border)" }}>
          <p className="text-[10px] font-bold uppercase tracking-wider"
            style={{ color: SEVERITY_META[severity].fg }}>
            {SEVERITY_META[severity].label} · {action === "clear" ? "Clear" : "Accept"}
          </p>
          <p className="text-sm font-semibold mt-0.5" style={{ color: "var(--text)" }}>{title}</p>
        </div>
        <div className="px-5 py-4">
          <label className="block text-[12px] font-semibold mb-1.5" style={{ color: "var(--text-2)" }}>
            {required ? "Reason (required)" : "Reason (optional)"}
          </label>
          <textarea ref={ref} value={note} onChange={(e) => setNote(e.target.value)}
            rows={3} maxLength={500}
            placeholder={action === "clear"
              ? "What was done about it?"
              : "Why is this acceptable as it stands?"}
            onKeyDown={(e) => {
              if (e.key === "Escape") onCancel()
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !tooShort) onConfirm(note.trim())
            }}
            className="w-full rounded-lg px-3 py-2 text-[13px] outline-none resize-none"
            style={{ background: "var(--surface-2)", border: "1px solid var(--border)", color: "var(--text)" }} />
          <p className="text-[11px] mt-1.5" style={{ color: "var(--text-muted)" }}>
            {required
              ? "This is printed on the sign-off memo, next to the exception."
              : "If you write one, it goes on the sign-off memo."}
          </p>
          {error && (
            <p className="text-[11.5px] mt-2" style={{ color: "var(--danger)" }}>{error}</p>
          )}
        </div>
        <div className="px-5 pb-4 flex items-center justify-end gap-2">
          <button onClick={onCancel}
            className="rounded-lg px-3 py-1.5 text-[12px] font-semibold"
            style={{ border: "1px solid var(--border-strong)", color: "var(--text-2)" }}>
            Cancel
          </button>
          <button onClick={() => onConfirm(note.trim())} disabled={tooShort || busy}
            className="inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-[12px] font-bold text-white disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ background: "var(--green)" }}>
            {busy ? <Spinner className="h-3.5 w-3.5" /> : <CheckCircle2 size={13} strokeWidth={2.4} />}
            {action === "clear" ? "Clear it" : "Accept it"}
          </button>
        </div>
      </div>
    </div>
  )
}

/** The reviewing partner's statement, captured at sign-off and printed under
 *  the signature. Optional — but a signature with nothing under it is a rubber
 *  stamp, and the placeholder says what a useful one looks like. */
function SignOffDialog({
  open, label, busy, onCancel, onConfirm,
}: {
  open: boolean; label: string; busy: boolean
  onCancel: () => void; onConfirm: (note: string) => void
}) {
  const [note, setNote] = useState("")
  const ref = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    if (open) { setNote(""); setTimeout(() => ref.current?.focus(), 30) }
  }, [open])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(8,12,10,0.45)" }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel() }}>
      <div role="dialog" aria-modal="true" aria-label={`Sign off on ${label}`}
        className="w-full max-w-lg rounded-2xl overflow-hidden"
        style={{ background: "var(--surface)", border: "1px solid var(--border)",
                 boxShadow: "0 24px 60px rgba(0,0,0,0.28)" }}>
        <div className="px-5 pt-4 pb-3" style={{ borderBottom: "1px solid var(--border)" }}>
          <p className="text-[10px] font-bold uppercase tracking-wider" style={{ color: "var(--green)" }}>
            Sign off
          </p>
          <p className="text-sm font-semibold mt-0.5" style={{ color: "var(--text)" }}>
            {label} close review
          </p>
        </div>
        <div className="px-5 py-4">
          <label className="block text-[12px] font-semibold mb-1.5" style={{ color: "var(--text-2)" }}>
            Your statement (optional)
          </label>
          <textarea ref={ref} value={note} onChange={(e) => setNote(e.target.value)}
            rows={4} maxLength={2000}
            placeholder="e.g. Reviewed the exceptions above and the supporting workpapers. The close is appropriate for issuance subject to the in-transit item noted."
            onKeyDown={(e) => {
              if (e.key === "Escape") onCancel()
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onConfirm(note.trim())
            }}
            className="w-full rounded-lg px-3 py-2 text-[13px] outline-none resize-none"
            style={{ background: "var(--surface-2)", border: "1px solid var(--border)", color: "var(--text)" }} />
          <p className="text-[11px] mt-1.5" style={{ color: "var(--text-muted)" }}>
            Printed under your name on the memo. Your name and the timestamp are recorded either way.
          </p>
        </div>
        <div className="px-5 pb-4 flex items-center justify-end gap-2">
          <button onClick={onCancel}
            className="rounded-lg px-3 py-1.5 text-[12px] font-semibold"
            style={{ border: "1px solid var(--border-strong)", color: "var(--text-2)" }}>
            Cancel
          </button>
          <button onClick={() => onConfirm(note.trim())} disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-[12px] font-bold text-white disabled:opacity-50"
            style={{ background: "var(--green)" }}>
            {busy ? <Spinner className="h-3.5 w-3.5" /> : <PenLine size={13} strokeWidth={2.4} />}
            Sign off
          </button>
        </div>
      </div>
    </div>
  )
}

function EmptyState({
  label, canReview, running, onRun,
}: { label: string; canReview: boolean; running: boolean; onRun: () => void }) {
  return (
    <div className="rounded-2xl px-6 py-12 text-center"
      style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
      <span className="h-12 w-12 rounded-2xl inline-flex items-center justify-center mb-3"
        style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
        <Bot size={24} strokeWidth={1.7} />
      </span>
      <h2 className="text-base font-bold text-theme">No review yet for {label}</h2>
      <p className="text-[13px] mt-1.5 max-w-md mx-auto" style={{ color: "var(--text-muted)" }}>
        Run the AI reviewing partner over this period — it checks reconciliation hygiene,
        completeness, analytical review, and anomalies, then hands you a sign-off memo.
      </p>
      {canReview ? (
        <button onClick={onRun} disabled={running}
          className="mt-5 inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
          style={{ background: "var(--green)" }}>
          {running ? <Spinner className="h-4 w-4" /> : <Play size={15} strokeWidth={2.4} />}
          {running ? "Reviewing…" : "Run review"}
        </button>
      ) : (
        <p className="text-[12px] mt-4" style={{ color: "var(--text-muted)" }}>
          A reviewer or admin can run the review.
        </p>
      )}
    </div>
  )
}
