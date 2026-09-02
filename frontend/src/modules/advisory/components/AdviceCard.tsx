/**
 * One piece of advice, and whether it worked.
 *
 * A recommendation used to be an AI sentence with "medium priority" printed
 * under it — the same two words on every row, forever, because nothing in the
 * codebase could set the field. It recorded that the firm had advised
 * something and could never say what happened next, even though the KPI trend
 * was on the same page with six months of history.
 *
 * So this card leads with the hypothesis — the metric, where it started, where
 * it should get to — and then the answer: has it moved?
 *
 * The grade is never softened. "Worsening" is the most useful row on the page
 * and the one a flattering design would round away.
 */
import { useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { AnimatePresence, motion, useReducedMotion } from "framer-motion"
import { ArrowRight, CalendarClock, ChevronDown, TrendingDown, TrendingUp, User } from "lucide-react"

import { MOTION, EASE } from "@/core/motion"
import { formatDate } from "@/core/lib/dates"
import { advisoryApi, formatKpi, type Grade, type RecStatus, type TrackedRec } from "../api"

const GRADE: Record<Grade, { label: string; fg: string; bg: string; hint: string }> = {
  achieved:  { label: "Target met",  fg: "var(--green)", bg: "var(--green-subtle)",
               hint: "The metric reached the target that was set." },
  working:   { label: "Working",     fg: "var(--green)", bg: "var(--green-subtle)",
               hint: "Moving the right way since the advice was given." },
  flat:      { label: "No change",   fg: "var(--text-muted)", bg: "var(--surface-2)",
               hint: "Hasn't moved either way yet. Most advice takes a period or two." },
  worsening: { label: "Going backwards", fg: "#A0503F", bg: "rgba(160,80,63,.10)",
               hint: "The metric is moving the wrong way since this was advised." },
  unknown:   { label: "Not measurable", fg: "#8a6326", bg: "rgba(199,154,82,.10)",
               hint: "Linked to a metric, but there's no baseline reading to measure from." },
  unlinked:  { label: "Not tracked",  fg: "var(--text-muted)", bg: "var(--surface-2)",
               hint: "No metric attached, so this can't be graded. Link one to track it." },
}

const PRIORITY: Record<string, { fg: string; bg: string }> = {
  high:   { fg: "#A0503F", bg: "rgba(160,80,63,.10)" },
  medium: { fg: "var(--text-2)", bg: "var(--surface-2)" },
  low:    { fg: "var(--text-muted)", bg: "var(--surface-2)" },
}

const STATUS_LABEL: Record<RecStatus, string> = {
  open: "Open", in_progress: "In progress", done: "Done", dismissed: "Dismissed",
}

const money = (v: number) =>
  `$${Math.round(Math.abs(v)).toLocaleString(undefined, { maximumFractionDigits: 0 })}`

export function AdviceCard({ rec, canEdit, onSaved }: {
  rec: TrackedRec
  canEdit: boolean
  onSaved: () => void
}) {
  const reduce = useReducedMotion()
  const [open, setOpen] = useState(false)
  const [action, setAction] = useState(rec.client_action ?? "")
  const [outcome, setOutcome] = useState(rec.outcome_note ?? "")

  // Only fetched when there's a metric to pick — an already-linked card has no
  // use for the catalog.
  const { data: catalog = [] } = useQuery({
    queryKey: ["advisory", "catalog"],
    queryFn:  advisoryApi.getCatalog,
    staleTime: 30 * 60_000,
    enabled: !rec.kpi_key && canEdit,
  })

  const save = useMutation({
    mutationFn: (body: Parameters<typeof advisoryApi.updateRecommendation>[1]) =>
      advisoryApi.updateRecommendation(rec.id, body),
    onSuccess: onSaved,
  })

  const p = rec.progress
  const grade = GRADE[p?.grade ?? "unlinked"]
  const prio = PRIORITY[rec.priority] ?? PRIORITY.medium
  const unit = p?.unit ?? ""
  const moved = p?.current != null && rec.baseline_value != null
    ? p.current - rec.baseline_value
    : null
  const rightWay = moved != null && p?.higher_better != null
    ? (p.higher_better ? moved > 0 : moved < 0)
    : null
  const overdue = rec.due_date != null && rec.status !== "done"
    && new Date(rec.due_date) < new Date()

  return (
    <div className="rounded-xl overflow-hidden"
      style={{ background: "var(--surface)", border: "1px solid var(--border)",
               boxShadow: "var(--card-shadow)",
               opacity: rec.status === "dismissed" ? 0.6 : 1 }}>

      <div className="px-3.5 pt-3 pb-2.5">
        <div className="flex items-start gap-2">
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-semibold text-theme leading-snug">
              {rec.title}
            </span>
            {rec.detail && (
              <span className="block text-[11.5px] mt-1 leading-relaxed" style={{ color: "var(--text-2)" }}>
                {rec.detail}
              </span>
            )}
          </span>
          <span className="shrink-0 rounded-md px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide"
            style={{ background: grade.bg, color: grade.fg }} title={grade.hint}>
            {grade.label}
          </span>
        </div>

        {/* No metric, no grade — and until now no way to fix that. The
            scorecard told people to "link one to start tracking them" and there
            was nowhere to do it: kpi_key could only be set when a
            recommendation was created, so every item that predated the change
            was permanently ungradable. Copy that promises a control has to be
            met by the control. */}
        {!rec.kpi_key && canEdit && (
          <div className="mt-2.5 flex items-center gap-2 flex-wrap">
            <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
              Not tied to a metric
            </span>
            <select
              value=""
              onChange={(e) => e.target.value && save.mutate({ kpi_key: e.target.value })}
              disabled={save.isPending}
              className="rounded-md px-2 py-1 text-[11px] outline-none"
              style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)",
                       color: "var(--text)" }}>
              <option value="">Link a metric…</option>
              {catalog.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
            </select>
            <span className="text-[10.5px]" style={{ color: "var(--text-muted)" }}>
              Measured from {rec.period_label}, when this was advised.
            </span>
          </div>
        )}

        {/* The hypothesis: metric, from, to. Only drawn when there is one —
            an unlinked recommendation shouldn't be dressed up as measurable. */}
        {rec.kpi_label && (
          <div className="mt-2.5 flex items-center gap-2 flex-wrap text-[11.5px]">
            <span style={{ color: "var(--text-muted)" }}>{rec.kpi_label}</span>
            {rec.baseline_value != null && (
              <span className="tabular-nums" style={{ color: "var(--text-2)" }}>
                {formatKpi(rec.baseline_value, unit)}
              </span>
            )}
            {p?.current != null && rec.baseline_value != null && (
              <>
                <ArrowRight size={11} strokeWidth={2} style={{ color: "var(--text-muted)" }} />
                <span className="tabular-nums font-semibold inline-flex items-center gap-1"
                  style={{ color: rightWay === null ? "var(--text)"
                    : rightWay ? "var(--green)" : "#A0503F" }}>
                  {rightWay !== null && (rightWay
                    ? <TrendingUp size={11} strokeWidth={2.2} />
                    : <TrendingDown size={11} strokeWidth={2.2} />)}
                  {formatKpi(p.current, unit)}
                </span>
              </>
            )}
            {rec.target_value != null && (
              <span className="text-[10.5px]" style={{ color: "var(--text-muted)" }}>
                target {formatKpi(rec.target_value, unit)}
                {rec.due_date && <> by {formatDate(rec.due_date)}</>}
              </span>
            )}
          </div>
        )}

        {/* What it's worth, and who owns it. */}
        <div className="mt-2 flex items-center gap-2.5 flex-wrap text-[10.5px]"
          style={{ color: "var(--text-muted)" }}>
          <span className="rounded px-1.5 py-0.5 font-semibold capitalize"
            style={{ background: prio.bg, color: prio.fg }}>
            {rec.priority}
          </span>
          {rec.expected_impact != null && (
            <span title={rec.impact_note ?? undefined}>
              Worth <b style={{ color: "var(--text-2)" }}>~{money(rec.expected_impact)}</b>
            </span>
          )}
          {rec.owner && (
            <span className="inline-flex items-center gap-1">
              <User size={10} strokeWidth={2} />{rec.owner}
            </span>
          )}
          {rec.due_date && (
            <span className="inline-flex items-center gap-1"
              style={{ color: overdue ? "#A0503F" : undefined }}>
              <CalendarClock size={10} strokeWidth={2} />
              {overdue ? "Overdue " : "Due "}{formatDate(rec.due_date)}
            </span>
          )}
          <span>Advised {rec.period_label}</span>
          {rec.source === "manual" && <span>· by hand</span>}
        </div>
      </div>

      {/* Readings since the advice — the grade's own evidence, so the two can
          never tell different stories. */}
      {p?.since && p.since.length > 1 && (
        <div className="px-3.5 pb-2 flex items-center gap-1.5 flex-wrap text-[10.5px]"
          style={{ color: "var(--text-muted)" }}>
          <span>Since advised</span>
          {p.since.map((pt, i) => (
            <span key={pt.period} className="tabular-nums">
              {i > 0 && <span className="mx-1 opacity-50">→</span>}
              {formatKpi(pt.value, unit)}
            </span>
          ))}
        </div>
      )}

      <div className="px-3.5 py-2 flex items-center gap-2 flex-wrap"
        style={{ borderTop: "1px solid var(--border)" }}>
        {canEdit ? (
          <select value={rec.status}
            onChange={(e) => save.mutate({ status: e.target.value as RecStatus })}
            disabled={save.isPending}
            className="rounded-md px-2 py-1 text-[11px] outline-none"
            style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)",
                     color: "var(--text)" }}>
            {(Object.keys(STATUS_LABEL) as RecStatus[]).map((s) => (
              <option key={s} value={s}>{STATUS_LABEL[s]}</option>
            ))}
          </select>
        ) : (
          <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
            {STATUS_LABEL[rec.status]}
          </span>
        )}
        {canEdit && (
          <select value={rec.priority}
            onChange={(e) => save.mutate({ priority: e.target.value as "high" | "medium" | "low" })}
            disabled={save.isPending}
            className="rounded-md px-2 py-1 text-[11px] outline-none"
            style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)",
                     color: "var(--text)" }}>
            {["high", "medium", "low"].map((s) => (
              <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)} priority</option>
            ))}
          </select>
        )}
        <div className="flex-1" />
        <button type="button" onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-1 text-[11px] font-medium"
          style={{ color: "var(--text-muted)" }}>
          {rec.client_action ? "Outcome" : "Record what happened"}
          <ChevronDown size={12} strokeWidth={2}
            style={{ transform: open ? "rotate(180deg)" : "none",
                     transition: reduce ? "none" : `transform ${MOTION.DEFAULT}s ${EASE.OUT}` }} />
        </button>
      </div>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div key="outcome"
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: MOTION.DEFAULT, ease: EASE.OUT }}
            style={{ overflow: "hidden" }}>
            <div className="px-3.5 py-3 space-y-2" style={{ borderTop: "1px solid var(--border)" }}>
              <label className="block">
                <span className="block text-[10px] font-bold uppercase tracking-wider mb-1"
                  style={{ color: "var(--text-muted)" }}>What the client did</span>
                <textarea value={action} onChange={(e) => setAction(e.target.value)}
                  rows={2} disabled={!canEdit}
                  className="w-full rounded-lg px-2.5 py-1.5 text-[11.5px] outline-none resize-y"
                  style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)",
                           color: "var(--text)" }} />
              </label>
              <label className="block">
                <span className="block text-[10px] font-bold uppercase tracking-wider mb-1"
                  style={{ color: "var(--text-muted)" }}>What came of it</span>
                <textarea value={outcome} onChange={(e) => setOutcome(e.target.value)}
                  rows={2} disabled={!canEdit}
                  className="w-full rounded-lg px-2.5 py-1.5 text-[11.5px] outline-none resize-y"
                  style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)",
                           color: "var(--text)" }} />
              </label>
              {canEdit && (
                <button type="button" disabled={save.isPending}
                  onClick={() => save.mutate({ client_action: action, outcome_note: outcome })}
                  className="rounded-lg px-3 py-1.5 text-[11px] font-bold disabled:opacity-50"
                  style={{ background: "var(--green)", color: "white" }}>
                  {save.isPending ? "Saving…" : "Save"}
                </button>
              )}
              {rec.status_changed_at && (
                <p className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                  Updated {formatDate(rec.status_changed_at)}
                </p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
