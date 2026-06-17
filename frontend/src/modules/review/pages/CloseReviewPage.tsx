/**
 * CloseReviewPage — the AI reviewing-partner pass over a closed period.
 *
 * Autopilot prepares the close; Close Review signs off on it. The page runs a
 * battery of deterministic checks (reconciliation hygiene, completeness,
 * analytical review, anomalies) plus an AI analytical narrative, and presents
 * the exceptions grouped by severity, each with its evidence and a
 * clear / accept lifecycle, ending in a reviewer sign-off.
 */
import { Fragment, useEffect, useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ShieldCheck, Sparkles, RefreshCw, Play, CheckCircle2, AlertTriangle,
  PenLine, ArrowRight, ExternalLink, Lock, Bot, type LucideIcon,
} from "lucide-react"

import { PageHeader } from "@/core/ui/PageHeader"
import { DatePicker } from "@/core/ui/DatePicker"
import { Spinner } from "@/core/ui/components"
import { useSelectedPeriod } from "@/core/hooks/useSelectedPeriod"
import { formatDateTime } from "@/core/lib/dates"
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
  return last.toISOString().slice(0, 10)
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
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
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
    mutationFn: (v: { id: string; action: "clear" | "accept" | "reopen" }) => reviewApi.act(v.id, v.action),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ["review", period] })
      const prev = qc.getQueryData<ReviewState>(["review", period])
      if (prev) {
        const STATUS = { clear: "cleared", accept: "accepted", reopen: "open" } as const
        const target = prev.findings.find((f) => f.id === v.id) ?? prev.resolved.find((f) => f.id === v.id)
        if (target) {
          const updated: ReviewFinding = { ...target, status: STATUS[v.action], status_changed_at: new Date().toISOString() }
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
    mutationFn: () => reviewApi.signOff(period),
    onSuccess: put,
    onError: (e: unknown) => setErr(detail(e) ?? "Could not sign off."),
  })

  const review = state?.review ?? null
  const findings = state?.findings ?? []
  const resolved = state?.resolved ?? []
  const label = state?.period_label ?? ""

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

  return (
    <div className="flex flex-col h-full overflow-hidden" style={{ background: "var(--bg)" }}>
      <PageHeader
        title="Close Review"
        subtitle="An AI reviewing partner checks the close and hands you a sign-off memo"
        actions={
          <>
            <DatePicker value={period} onChange={setPeriod} compact />
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
            <div className="rounded-2xl p-6 flex items-center gap-3"
              style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
              <Spinner className="h-5 w-5" />
              <span className="text-sm" style={{ color: "var(--text-muted)" }}>Loading review…</span>
            </div>
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

              {/* Findings */}
              {findings.length === 0 ? (
                <div className="rounded-2xl px-4 py-8 text-center"
                  style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
                  <CheckCircle2 size={26} strokeWidth={1.6} className="mx-auto mb-2" style={{ color: "var(--positive)" }} />
                  <p className="text-sm font-semibold" style={{ color: "var(--text)" }}>No open exceptions</p>
                  <p className="text-[12px] mt-1" style={{ color: "var(--text-muted)" }}>This close passed every review check.</p>
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
                              onAct={(action) => actM.mutate({ id: f.id, action })}
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
                          onAct={(action) => actM.mutate({ id: selectedFinding.id, action })}
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
                      <div key={f.id} className="flex items-center justify-between gap-3 rounded-lg px-3 py-2"
                        style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
                        <div className="min-w-0">
                          <p className="text-[13px] truncate" style={{ color: "var(--text-2)" }}>{f.title}</p>
                          <p className="text-[10px] mt-0.5" style={{ color: "var(--positive)" }}>
                            {RESOLVED_LABEL[f.status] ?? f.status}
                            {f.status_changed_at ? ` · ${formatDateTime(f.status_changed_at)}` : ""}
                            {f.note ? ` — ${f.note}` : ""}
                          </p>
                        </div>
                        {canReview && (
                          <button onClick={() => actM.mutate({ id: f.id, action: "reopen" })}
                            aria-label={`Reopen ${f.title}`}
                            className="text-[11px] font-semibold shrink-0" style={{ color: "var(--text-muted)" }}>
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
                busy={signM.isPending} onSignOff={() => signM.mutate()} />
            </>
          )}
        </div>
      </div>
    </div>
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
  review, label, canReview, busy, onSignOff,
}: {
  review: { status: string; high_count: number; review_count: number; signed_off_at: string | null }
  label: string
  canReview: boolean
  busy: boolean
  onSignOff: () => void
}) {
  if (review.status === "signed_off") {
    return (
      <div className="rounded-xl px-4 py-3 flex items-center gap-2.5"
        style={{ background: "var(--positive-subtle)", border: "1px solid var(--positive-border)" }}>
        <CheckCircle2 size={17} strokeWidth={2} style={{ color: "var(--positive)" }} />
        <p className="text-[13px] font-semibold" style={{ color: "var(--positive)" }}>
          {label} close review signed off{review.signed_off_at ? ` · ${formatDateTime(review.signed_off_at)}` : ""}
        </p>
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
