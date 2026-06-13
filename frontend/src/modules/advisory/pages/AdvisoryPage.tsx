/**
 * AdvisoryPage — the longitudinal advisory layer.
 *
 *  1. KPIs vs. targets — each KPI's trend across recent closes, graded
 *     met/missed against a firm-set target you can edit inline.
 *  2. Tracked recommendations — the exec report's advice, persisted with a
 *     status lifecycle so "we advised X" becomes "the client did Y".
 *
 * KPI values come from cached insights snapshots (no live QuickBooks calls).
 */
import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Target, TrendingUp, TrendingDown, Minus, CheckCircle2, AlertTriangle,
  Lightbulb, ChevronDown, type LucideIcon,
} from "lucide-react"

import { PageHeader } from "@/core/ui/PageHeader"
import { DatePicker } from "@/core/ui/DatePicker"
import { Spinner } from "@/core/ui/components"
import { useSelectedPeriod } from "@/core/hooks/useSelectedPeriod"
import { formatDate } from "@/core/lib/dates"
import { workspaceApi } from "@/modules/workspace/api"
import {
  advisoryApi, formatKpi,
  type Comparator, type Kpi, type RecStatus, type TrackedRec,
} from "../api"

function defaultPeriod(): string {
  const d = new Date()
  const last = new Date(d.getFullYear(), d.getMonth(), 0)
  return last.toISOString().slice(0, 10)
}

const COMPARATOR_LABEL: Record<Comparator, string> = {
  gte: "At least", lte: "At most", between: "Between",
}
const REC_STATUS_LABEL: Record<RecStatus, string> = {
  open: "Open", in_progress: "In progress", done: "Done", dismissed: "Dismissed",
}
const REC_STATUS_META: Record<RecStatus, { bg: string; fg: string }> = {
  open:        { bg: "var(--warn-subtle)",     fg: "var(--warn)" },
  in_progress: { bg: "var(--info-subtle)",     fg: "var(--info)" },
  done:        { bg: "var(--positive-subtle)", fg: "var(--positive)" },
  dismissed:   { bg: "var(--surface-2)",       fg: "var(--text-muted)" },
}

export function AdvisoryPage() {
  const qc = useQueryClient()
  // Default to the month being closed — shared with the dashboard + every
  // other module via the selected-period store; last month is the fallback.
  const [period, setPeriod] = useSelectedPeriod(defaultPeriod())

  const { data: me } = useQuery({ queryKey: ["workspace-me"], queryFn: workspaceApi.getMe, staleTime: 60_000 })
  const canEdit = me?.role === "admin" || me?.role === "reviewer"

  const { data: kpiData, isLoading: kpisLoading } = useQuery({
    queryKey: ["advisory-kpis", period],
    queryFn:  () => advisoryApi.getKpis(period),
    staleTime: 60_000,
  })
  const { data: recs = [], isLoading: recsLoading } = useQuery({
    queryKey: ["advisory-recs"],
    queryFn:  () => advisoryApi.getRecommendations(),
    staleTime: 60_000,
  })

  return (
    <div className="flex flex-col h-full overflow-hidden" style={{ background: "var(--bg)" }}>
      <PageHeader
        title="Advisory"
        subtitle="KPI trends vs. your targets, and the advice you've tracked over time"
        actions={<DatePicker value={period} onChange={setPeriod} compact />}
      />

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-5 space-y-6">

          {/* ── KPIs vs targets ──────────────────────────────────── */}
          <section>
            <div className="flex items-center gap-2 mb-3">
              <Target size={16} strokeWidth={1.9} style={{ color: "var(--green)" }} />
              <h2 className="text-base font-bold text-theme">KPIs vs. targets</h2>
            </div>
            {kpisLoading ? (
              <div className="rounded-2xl p-6 flex items-center gap-3"
                style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
                <Spinner className="h-5 w-5" />
                <span className="text-sm" style={{ color: "var(--text-muted)" }}>Loading KPI trends…</span>
              </div>
            ) : (kpiData?.kpis.some((k) => k.current !== null) ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {kpiData!.kpis.map((k) => (
                  <KpiCard key={k.key} kpi={k} canEdit={canEdit}
                    onSaved={() => qc.invalidateQueries({ queryKey: ["advisory-kpis", period] })} />
                ))}
              </div>
            ) : (
              <div className="rounded-2xl px-4 py-8 text-center"
                style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
                <p className="text-sm font-medium" style={{ color: "var(--text-2)" }}>No KPI history yet</p>
                <p className="text-[12px] mt-1" style={{ color: "var(--text-muted)" }}>
                  Run Insights for a period or two — KPI trends build from those snapshots.
                </p>
              </div>
            ))}
          </section>

          {/* ── Tracked recommendations ──────────────────────────── */}
          <section>
            <div className="flex items-center gap-2 mb-3">
              <Lightbulb size={16} strokeWidth={1.9} style={{ color: "var(--green)" }} />
              <h2 className="text-base font-bold text-theme">Tracked recommendations</h2>
            </div>
            {recsLoading ? (
              <div className="rounded-2xl p-6 flex items-center gap-3"
                style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
                <Spinner className="h-5 w-5" />
                <span className="text-sm" style={{ color: "var(--text-muted)" }}>Loading…</span>
              </div>
            ) : recs.length === 0 ? (
              <div className="rounded-2xl px-4 py-8 text-center"
                style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
                <p className="text-sm font-medium" style={{ color: "var(--text-2)" }}>No recommendations tracked yet</p>
                <p className="text-[12px] mt-1" style={{ color: "var(--text-muted)" }}>
                  Generate an executive report for a closed period — its recommendations land here to track.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {recs.map((r) => (
                  <RecRow key={r.id} rec={r} canEdit={canEdit}
                    onSaved={() => qc.invalidateQueries({ queryKey: ["advisory-recs"] })} />
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

// ── KPI card ──────────────────────────────────────────────────────────────────

function Sparkline({ values, higherBetter }: { values: number[]; higherBetter: boolean }) {
  if (values.length < 2) return null
  const min = Math.min(...values), max = Math.max(...values)
  const span = max - min || 1
  const up = values[values.length - 1] >= values[0]
  const good = up === higherBetter
  const color = good ? "var(--positive)" : "var(--danger)"
  return (
    <div className="flex items-end gap-0.5 h-7" aria-hidden="true">
      {values.map((v, i) => (
        <div key={i} className="w-1.5 rounded-t" style={{
          height: `${8 + ((v - min) / span) * 20}px`,
          background: i === values.length - 1 ? color : "var(--border-strong)",
        }} />
      ))}
    </div>
  )
}

function KpiCard({ kpi, canEdit, onSaved }: { kpi: Kpi; canEdit: boolean; onSaved: () => void }) {
  const [editing, setEditing] = useState(false)
  const delta = (kpi.current !== null && kpi.prior !== null) ? kpi.current - kpi.prior : null
  const improving = delta === null ? null : (delta === 0 ? null : (delta > 0) === kpi.higher_better)
  const TrendIcon: LucideIcon = delta === null || delta === 0 ? Minus : (delta > 0 ? TrendingUp : TrendingDown)
  const trendColor = improving === null ? "var(--text-muted)" : (improving ? "var(--positive)" : "var(--danger)")

  return (
    <div className="rounded-2xl p-4" style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>{kpi.label}</p>
          <p className="text-2xl font-bold mt-0.5" style={{ color: "var(--text)" }}>{formatKpi(kpi.current, kpi.unit)}</p>
        </div>
        <Sparkline values={kpi.series.map((s) => s.value)} higherBetter={kpi.higher_better} />
      </div>

      <div className="flex items-center gap-1.5 mt-1.5 text-[11px]" style={{ color: trendColor }}>
        <TrendIcon size={12} strokeWidth={2.2} />
        {delta === null ? "no prior period"
          : delta === 0 ? "flat vs last period"
          : `${formatKpi(Math.abs(delta), kpi.unit)} ${delta > 0 ? "up" : "down"} vs last period`}
      </div>

      {/* Target row */}
      <div className="mt-3 pt-3" style={{ borderTop: "1px solid var(--border)" }}>
        {editing ? (
          <TargetEditor kpi={kpi} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); onSaved() }} />
        ) : kpi.target ? (
          <div className="flex items-center justify-between gap-2">
            {kpi.status === "met" ? (
              <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold rounded-full px-2 py-0.5"
                style={{ background: "var(--positive-subtle)", color: "var(--positive)" }}>
                <CheckCircle2 size={11} strokeWidth={2.4} /> On target
              </span>
            ) : kpi.status === "missed" ? (
              <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold rounded-full px-2 py-0.5"
                style={{ background: "var(--warn-subtle)", color: "var(--warn)" }}>
                <AlertTriangle size={11} strokeWidth={2.2} /> Off target
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold rounded-full px-2 py-0.5"
                style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}>
                <Minus size={11} strokeWidth={2.2} /> Not yet measured
              </span>
            )}
            <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
              Target: {COMPARATOR_LABEL[kpi.target.comparator].toLowerCase()} {formatKpi(kpi.target.value, kpi.unit)}
              {kpi.target.comparator === "between" && kpi.target.value_upper !== null ? `–${formatKpi(kpi.target.value_upper, kpi.unit)}` : ""}
              {canEdit && <button onClick={() => setEditing(true)} className="ml-2 font-semibold" style={{ color: "var(--green)" }}>Edit</button>}
            </span>
          </div>
        ) : (
          canEdit ? (
            <button onClick={() => setEditing(true)}
              className="inline-flex items-center gap-1 text-[12px] font-semibold" style={{ color: "var(--green)" }}>
              <Target size={12} strokeWidth={2} /> Set a target
            </button>
          ) : (
            <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>No target set</span>
          )
        )}
      </div>
    </div>
  )
}

function TargetEditor({ kpi, onClose, onSaved }: { kpi: Kpi; onClose: () => void; onSaved: () => void }) {
  const [comparator, setComparator] = useState<Comparator>(kpi.target?.comparator ?? (kpi.higher_better ? "gte" : "lte"))
  const [value, setValue] = useState<string>(kpi.target ? String(kpi.target.value) : "")
  const [upper, setUpper] = useState<string>(kpi.target?.value_upper != null ? String(kpi.target.value_upper) : "")
  const [err, setErr] = useState<string | null>(null)

  const vNum = parseFloat(value)
  const uNum = parseFloat(upper)
  // 'between' needs a valid upper too; guard against NaN (paste/programmatic).
  const valid = !Number.isNaN(vNum) && (comparator !== "between" || (upper.trim() !== "" && !Number.isNaN(uNum)))

  const save = useMutation({
    mutationFn: () => advisoryApi.setTarget(kpi.key, {
      comparator, value: vNum,
      value_upper: comparator === "between" ? uNum : null,
    }),
    onSuccess: onSaved,
    onError: () => setErr("Could not save the target."),
  })
  const clear = useMutation({ mutationFn: () => advisoryApi.deleteTarget(kpi.key), onSuccess: onSaved })

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 flex-wrap">
        <select value={comparator} onChange={(e) => setComparator(e.target.value as Comparator)}
          aria-label="Target comparator"
          className="rounded-md px-2 py-1 text-[12px] outline-none"
          style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }}>
          <option value="gte">At least</option>
          <option value="lte">At most</option>
          <option value="between">Between</option>
        </select>
        <input type="number" step="any" value={value} onChange={(e) => setValue(e.target.value)}
          placeholder="value" aria-label="Target value"
          className="w-20 rounded-md px-2 py-1 text-[12px] outline-none"
          style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }} />
        {comparator === "between" && (
          <input type="number" step="any" value={upper} onChange={(e) => setUpper(e.target.value)}
            placeholder="upper" aria-label="Target upper bound"
            className="w-20 rounded-md px-2 py-1 text-[12px] outline-none"
            style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }} />
        )}
        <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>{kpi.unit}</span>
      </div>
      {err && <p className="text-[11px]" style={{ color: "var(--danger)" }}>{err}</p>}
      <div className="flex items-center gap-2">
        <button onClick={() => save.mutate()} disabled={save.isPending || !valid}
          className="rounded-md px-2.5 py-1 text-[12px] font-semibold text-white disabled:opacity-50"
          style={{ background: "var(--green)" }}>
          {save.isPending ? "Saving…" : "Save"}
        </button>
        <button onClick={onClose} className="text-[12px] font-semibold" style={{ color: "var(--text-muted)" }}>Cancel</button>
        {kpi.target && (
          <button onClick={() => clear.mutate()} className="ml-auto text-[11px] font-semibold" style={{ color: "var(--danger)" }}>
            Remove target
          </button>
        )}
      </div>
    </div>
  )
}

// ── Recommendation row ────────────────────────────────────────────────────────

function RecRow({ rec, canEdit, onSaved }: { rec: TrackedRec; canEdit: boolean; onSaved: () => void }) {
  const [open, setOpen] = useState(false)
  const [action, setAction] = useState(rec.client_action ?? "")
  const [outcome, setOutcome] = useState(rec.outcome_note ?? "")
  useEffect(() => { setAction(rec.client_action ?? ""); setOutcome(rec.outcome_note ?? "") }, [rec.id, rec.client_action, rec.outcome_note])

  const meta = REC_STATUS_META[rec.status]
  const setStatus = useMutation({
    mutationFn: (status: RecStatus) => advisoryApi.updateRecommendation(rec.id, { status }),
    onSuccess: onSaved,
  })
  const saveNotes = useMutation({
    mutationFn: () => advisoryApi.updateRecommendation(rec.id, { client_action: action, outcome_note: outcome }),
    onSuccess: () => { onSaved(); setOpen(false) },
  })

  return (
    <div className="rounded-xl" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <div className="flex items-start gap-3 p-3.5">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold" style={{ color: "var(--text)" }}>{rec.title}</p>
          <div className="flex items-center gap-2 mt-1 flex-wrap text-[11px]" style={{ color: "var(--text-muted)" }}>
            <span>{rec.period_label}</span>
            <span>·</span>
            <span className="capitalize">{rec.priority} priority</span>
            {rec.client_action && (<><span>·</span><span style={{ color: "var(--positive)" }}>has outcome</span></>)}
          </div>
        </div>
        {canEdit ? (
          <select value={rec.status} onChange={(e) => setStatus.mutate(e.target.value as RecStatus)}
            aria-label={`Status of ${rec.title}`}
            className="rounded-md px-2 py-1 text-[11px] font-semibold outline-none shrink-0"
            style={{ background: meta.bg, color: meta.fg, border: "1px solid var(--border)" }}>
            <option value="open">Open</option>
            <option value="in_progress">In progress</option>
            <option value="done">Done</option>
            <option value="dismissed">Dismissed</option>
          </select>
        ) : (
          <span className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider shrink-0"
            style={{ background: meta.bg, color: meta.fg }}>{REC_STATUS_LABEL[rec.status]}</span>
        )}
        <button onClick={() => setOpen((o) => !o)} aria-label="Toggle outcome notes"
          className="shrink-0 mt-0.5" style={{ color: "var(--text-muted)" }}>
          <ChevronDown size={16} strokeWidth={2} style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform .15s" }} />
        </button>
      </div>

      {open && (
        <div className="px-3.5 pb-3.5 pt-1 space-y-2" style={{ borderTop: "1px solid var(--border)" }}>
          {rec.detail && <p className="text-[12px]" style={{ color: "var(--text-2)" }}>{rec.detail}</p>}
          <div>
            <label className="block text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: "var(--text-muted)" }}>What the client did</label>
            <textarea value={action} onChange={(e) => setAction(e.target.value)} rows={2} disabled={!canEdit}
              placeholder="e.g. Tightened collections; offered 2/10 net 30 terms"
              className="w-full rounded-md px-2.5 py-1.5 text-[13px] outline-none resize-y disabled:opacity-60"
              style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }} />
          </div>
          <div>
            <label className="block text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: "var(--text-muted)" }}>Outcome</label>
            <textarea value={outcome} onChange={(e) => setOutcome(e.target.value)} rows={2} disabled={!canEdit}
              placeholder="e.g. DSO fell from 52 to 41 days over the next two months"
              className="w-full rounded-md px-2.5 py-1.5 text-[13px] outline-none resize-y disabled:opacity-60"
              style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }} />
          </div>
          {canEdit && (
            <div className="flex items-center gap-2">
              <button onClick={() => saveNotes.mutate()} disabled={saveNotes.isPending}
                className="rounded-md px-3 py-1 text-[12px] font-semibold text-white disabled:opacity-50"
                style={{ background: "var(--green)" }}>
                {saveNotes.isPending ? "Saving…" : "Save"}
              </button>
              {rec.status_changed_at && (
                <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                  Updated {formatDate(rec.status_changed_at)}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
