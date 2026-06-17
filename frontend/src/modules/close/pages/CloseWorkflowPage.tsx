/**
 * Close Workflow — the milestone checklist for a period, split-view.
 *
 * LEFT  — this month's close as a connected vertical timeline. LINKED steps
 *         (sync / recon / schedule / flux / close) auto-reflect the underlying
 *         module's status for the period; MANUAL steps are ticked here. A step
 *         is "blocked" until its prerequisite is done. Admins tailor the
 *         checklist from the template editor below the timeline.
 * RIGHT — a sticky insights rail: a "This close" summary (progress ring, days
 *         open, blocked, up-next) for the selected period, and "Cycle-time"
 *         analytics across every period (avg days to close, on-time %, a
 *         days-to-close sparkline, and the bottleneck step).
 *
 * Motion is tasteful and respects prefers-reduced-motion: the timeline staggers
 * in, the progress ring sweeps, KPI numbers count up, and switching months
 * cross-fades the timeline.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useOrganization } from "@clerk/clerk-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AnimatePresence, motion, useReducedMotion } from "framer-motion"
import {
  RefreshCw, Scale, ClipboardList, Sparkles, BarChart3, BookOpen,
  ShieldCheck, Lock, ListChecks, CheckCircle2, Circle, Clock, Check,
  ChevronRight, Pencil, Trash2, Plus, ArrowUp, ArrowDown, UserPlus,
  Timer, TrendingUp, AlertTriangle, Brain, ScanSearch, type LucideIcon,
} from "lucide-react"
import { Button, Spinner } from "@/core/ui/components"
import { formatDate } from "@/core/lib/dates"
import { writeSelectedPeriod, useSelectedPeriodDefault } from "@/core/hooks/useSelectedPeriod"
import { workspaceApi, type WorkspaceMember } from "@/modules/workspace/api"
import { closeApi, type CloseStep, type TemplateStep, type PrefillItem, type ScheduleKindDetail } from "@/modules/close/api"
import { glAccuracyApi } from "@/modules/gl_accuracy/api"

const CAT_ICON: Record<string, LucideIcon> = {
  sync: RefreshCw, recon: Scale, schedule: ClipboardList, adjustments: Sparkles,
  flux: BarChart3, financials: BookOpen, review: ShieldCheck, close: Lock, custom: ListChecks,
}

function deepLink(step: CloseStep, periodEnd: string): string | null {
  const m = step.linked_module || step.category
  switch (m) {
    case "sync":
    case "recon":
    case "close":  return `/app/reconciliations/period/${periodEnd}`
    case "schedule":   return "/app/schedules"
    case "flux":       return "/app/flux"
    case "adjustments":return "/app/adjustments"
    case "financials": return "/app/financials"
    case "review":     return "/app/review"
    default:           return null
  }
}

function isOverdue(due: string | null, done: boolean): boolean {
  if (!due || done) return false
  const d = new Date(due + "T00:00:00")
  const today = new Date(); today.setHours(0, 0, 0, 0)
  return d.getTime() < today.getTime()
}

function daysSince(iso: string): number {
  const d = new Date(iso + "T00:00:00")
  const t = new Date(); t.setHours(0, 0, 0, 0)
  return Math.max(0, Math.round((t.getTime() - d.getTime()) / 86_400_000))
}

// Animated count toward a target — eased, rAF, reduced-motion aware. Eases from
// the CURRENTLY displayed value (not 0), so a refetch that changes the metric
// glides instead of snapping back to zero.
function useCountUp(value: number, enabled: boolean, duration = 700): number {
  const [n, setN] = useState(enabled ? 0 : value)
  const nRef = useRef<number>(enabled ? 0 : value)
  useEffect(() => {
    if (!enabled) { nRef.current = value; setN(value); return }
    let raf = 0
    const from = nRef.current
    const start = performance.now()
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / duration)
      const eased = 1 - Math.pow(1 - p, 3)
      const v = from + (value - from) * eased
      nRef.current = v
      setN(v)
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value, enabled, duration])
  return n
}

export function CloseWorkflowPage() {
  const { organization } = useOrganization()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const reduce = !!useReducedMotion()

  const { data: me } = useQuery({
    queryKey: ["workspace-me"], queryFn: workspaceApi.getMe,
    staleTime: 10 * 60_000, enabled: !!organization,
  })
  const isAdmin = me?.role === "admin"

  const { data: members } = useQuery({
    queryKey: ["workspace-members"], queryFn: workspaceApi.listMembers,
    staleTime: 5 * 60_000, enabled: !!organization,
  })
  const memberName = useMemo(() => {
    const by = new Map((members ?? []).filter((m) => m.id).map((m) => [m.id as string, m]))
    return (id: string | null) => {
      if (!id) return null
      const m = by.get(id)
      return m ? (m.display_name || m.email || "Teammate") : "Teammate"
    }
  }, [members])

  const { data: periodsResp, isLoading: periodsLoading } = useQuery({
    queryKey: ["close", "periods"], queryFn: closeApi.getPeriods, enabled: !!organization,
  })

  // Seed from the cross-app selected period (localStorage) so the checklist can
  // fire in PARALLEL with the periods fetch on revisit — instead of waiting for
  // periods to resolve AND a render cycle to set the month, which serialised the
  // two calls into a staircase. This matches how Recons / Schedules / Insights
  // already open. On a first-ever visit (nothing stored yet) it's "" and the
  // effect below fills it from the backend's focus period as before.
  const seededPeriod = useSelectedPeriodDefault("")
  const [period, setPeriod] = useState<string>(seededPeriod)
  useEffect(() => {
    if (!period && periodsResp) {
      setPeriod(periodsResp.focus || periodsResp.periods[0]?.period_end || "")
    }
  }, [periodsResp, period])

  // Drive the cross-app "selected period" so Schedules / Recons / Insights open to
  // the SAME month the close is on. Without this the schedule pages defaulted to
  // their own month, so committed snapshots landed on the wrong period_end and the
  // "Update supporting schedules" step stayed stuck no matter how often you committed.
  useEffect(() => {
    if (period && organization?.id) writeSelectedPeriod(period, organization.id)
  }, [period, organization?.id])

  const periodLabel = periodsResp?.periods.find((p) => p.period_end === period)?.label ?? ""

  const { data: checklist, isLoading: checklistLoading } = useQuery({
    queryKey: ["close", "checklist", period],
    queryFn:  () => closeApi.getChecklist(period),
    enabled:  !!organization && !!period,
  })

  const [actionErr, setActionErr] = useState<string | null>(null)
  const stepMut = useMutation({
    mutationFn: closeApi.updateStep,
    onSuccess: () => {
      setActionErr(null)
      qc.invalidateQueries({ queryKey: ["close", "checklist", period] })
      qc.invalidateQueries({ queryKey: ["close", "analytics"] })
    },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setActionErr(msg ?? "Couldn't update — you may not have permission, or the connection hiccuped.")
    },
  })

  if (!organization) {
    return <Shell><Card><div className="p-6 text-sm" style={{ color: "var(--text-muted)" }}>
      Select a workspace to manage the close.</div></Card></Shell>
  }

  const booksReady = periodsResp?.books_start_date && (periodsResp?.periods.length ?? 0) > 0
  const steps = checklist?.steps ?? []
  const upNextKey = steps.find((s) => s.status !== "done" && !s.blocked)?.step_key ?? null

  return (
    <Shell>
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap mb-5">
        <div className="flex items-center gap-3 min-w-0">
          <span className="h-10 w-10 rounded-xl flex items-center justify-center shrink-0"
            style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
            <ListChecks size={20} strokeWidth={1.8} />
          </span>
          <div className="min-w-0">
            <h1 className="text-lg font-bold text-theme leading-tight">Close Workflow</h1>
            <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
              Work the close on the left — track how you're trending on the right.
            </p>
          </div>
        </div>
        {booksReady && (
          <select
            value={period} onChange={(e) => setPeriod(e.target.value)}
            className="rounded-lg px-3 py-2 text-sm outline-none transition-colors"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }}
          >
            {periodsResp!.periods.map((p) => (
              <option key={p.period_end} value={p.period_end}>
                {p.label}{p.closed ? " · closed" : ""}
              </option>
            ))}
          </select>
        )}
      </div>

      {actionErr && (
        <div className="rounded-xl px-4 py-3 text-[12px] mb-4"
          style={{ background: "var(--danger-subtle)", color: "var(--danger)", border: "1px solid var(--danger-border)" }}>
          {actionErr}
        </div>
      )}

      {periodsLoading ? (
        <Card><div className="p-6 flex items-center gap-3"><Spinner className="h-5 w-5" />
          <span className="text-sm" style={{ color: "var(--text-muted)" }}>Loading…</span></div></Card>
      ) : !booksReady ? (
        <Card><div className="px-6 py-10 text-center">
          <p className="text-sm font-semibold text-theme mb-1">Books aren't set up yet</p>
          <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
            Finish books setup to start tracking your monthly close here.</p>
        </div></Card>
      ) : (
        <div className="flex flex-col lg:flex-row gap-5 lg:items-start">
          {/* LEFT — timeline + template editor */}
          <div className="flex-1 min-w-0">
            {checklistLoading && !checklist ? (
              <Card><div className="p-6 flex items-center gap-3"><Spinner className="h-5 w-5" />
                <span className="text-sm" style={{ color: "var(--text-muted)" }}>Loading checklist…</span></div></Card>
            ) : (
              <AnimatePresence mode="wait">
                <motion.div key={period}
                  initial={reduce ? false : { opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduce ? undefined : { opacity: 0, y: -6 }}
                  transition={{ duration: 0.2 }}>
                  {steps.map((step, i) => (
                    <motion.div key={step.step_key}
                      initial={reduce ? false : { opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ duration: 0.25, delay: reduce ? 0 : i * 0.035 }}>
                      <TimelineStep
                        step={step} periodEnd={period} isAdmin={!!isAdmin}
                        members={members ?? []} memberName={memberName} reduce={reduce}
                        upNext={step.step_key === upNextKey} isLast={i === steps.length - 1}
                        busy={stepMut.isPending && stepMut.variables?.step_key === step.step_key}
                        onOpen={(href) => navigate(href)}
                        onToggle={(status) => stepMut.mutate({ period_end: period, step_key: step.step_key, status })}
                        onAssign={(uid) => stepMut.mutate(uid
                          ? { period_end: period, step_key: step.step_key, assignee_id: uid }
                          : { period_end: period, step_key: step.step_key, clear_assignee: true })}
                        onDue={(d) => stepMut.mutate(d
                          ? { period_end: period, step_key: step.step_key, due_date: d }
                          : { period_end: period, step_key: step.step_key, clear_due: true })}
                      />
                    </motion.div>
                  ))}
                </motion.div>
              </AnimatePresence>
            )}

            {isAdmin && <TemplateEditor />}
          </div>

          {/* RIGHT — sticky insights rail */}
          <aside className="w-full lg:w-[300px] shrink-0 lg:sticky lg:top-4 space-y-4">
            {checklist && (
              <ThisCloseCard
                label={periodLabel} periodEnd={period} closed={checklist.closed}
                done={checklist.summary.done} total={checklist.summary.total} pct={checklist.summary.pct}
                blocked={steps.filter((s) => s.blocked && s.status !== "done").length}
                upNextTitle={steps.find((s) => s.step_key === upNextKey)?.title ?? null}
                reduce={reduce}
              />
            )}
            <PrefillCard period={period} onOpen={(href) => navigate(href)} />
            <GlAccuracyRailCard period={period} onOpen={(href) => navigate(href)} />
            <CycleTimeCard reduce={reduce} />
          </aside>
        </div>
      )}
    </Shell>
  )
}

// One pill per supporting-schedule kind in use: committed ✓ for THIS close
// period, stale (committed then items changed → re-commit), or never committed —
// and, the common gotcha, committed for a DIFFERENT month. Clicking opens
// Schedules, which now defaults to the close period (see the global-period write).
function ScheduleKindChip({ kind, onOpen }: { kind: ScheduleKindDetail; onOpen: () => void }) {
  const meta =
    kind.state === "committed"
      ? { Icon: CheckCircle2, fg: "var(--green)", bg: "var(--green-subtle)", border: "var(--green)", text: kind.label }
      : kind.state === "stale"
        ? { Icon: RefreshCw, fg: "#a9762a", bg: "rgba(199,154,82,0.14)", border: "#d8b070", text: `${kind.label} — re-commit` }
        : { Icon: Circle, fg: "var(--text-muted)", bg: "var(--surface-2)", border: "var(--border)", text: `${kind.label} — needs commit` }
  const title =
    kind.state === "committed"
      ? `Committed${kind.committed_at ? ` ${formatDate(kind.committed_at)}` : ""}`
      : kind.committed_other_period
        ? `Committed for ${formatDate(kind.committed_other_period)} — not this period. Open Schedules (now set to this period) and commit.`
        : "Open Schedules and commit this for the close period"
  return (
    <button onClick={onOpen} title={title}
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold transition-opacity hover:opacity-80"
      style={{ background: meta.bg, color: meta.fg, border: `1px solid ${meta.border}` }}>
      <meta.Icon size={10} strokeWidth={2.4} />
      {meta.text}
      {kind.state === "missing" && kind.committed_other_period && (
        <span style={{ opacity: 0.75, fontWeight: 500 }}>· committed {formatDate(kind.committed_other_period)}</span>
      )}
    </button>
  )
}

// ── Timeline step ─────────────────────────────────────────────────────────

function TimelineStep({ step, periodEnd, isAdmin, members, memberName, reduce, upNext, isLast, busy, onOpen, onToggle, onAssign, onDue }: {
  step: CloseStep
  periodEnd: string
  isAdmin: boolean
  members: WorkspaceMember[]
  memberName: (id: string | null) => string | null
  reduce: boolean
  upNext: boolean
  isLast: boolean
  busy: boolean
  onOpen: (href: string) => void
  onToggle: (status: "done" | "pending") => void
  onAssign: (uid: string | null) => void
  onDue: (dateIso: string | null) => void
}) {
  const Icon = CAT_ICON[step.category] || ListChecks
  const href = deepLink(step, periodEnd)
  const done = step.status === "done"
  const inProgress = step.status === "in_progress"
  const blocked = step.blocked && !done
  const overdue = isOverdue(step.due_date, done)

  const node = done
    ? { bg: "var(--green)", fg: "#fff", border: "var(--green)", NodeIcon: Check }
    : blocked
      ? { bg: "var(--surface-2)", fg: "var(--text-muted)", border: "var(--border)", NodeIcon: Lock }
      : inProgress
        ? { bg: "var(--surface)", fg: "#a9762a", border: "#d8b070", NodeIcon: Icon }
        : { bg: "var(--surface)", fg: "var(--text-muted)", border: "var(--border-strong)", NodeIcon: Icon }

  const statusMeta = done
    ? { label: "Done", bg: "var(--green-subtle)", fg: "var(--green)", Dot: CheckCircle2 }
    : inProgress
      ? { label: "In progress", bg: "rgba(199,154,82,0.14)", fg: "#a9762a", Dot: Clock }
      : { label: "Pending", bg: "var(--surface-2)", fg: "var(--text-muted)", Dot: Circle }

  return (
    <div className="flex gap-3.5">
      {/* Rail: node + connector down to the next step */}
      <div className="flex flex-col items-center shrink-0" style={{ width: 30 }}>
        <div className="relative flex items-center justify-center rounded-full shrink-0"
          style={{ width: 30, height: 30, background: node.bg, border: `2px solid ${node.border}`,
                   boxShadow: upNext ? "0 0 0 2px var(--green)" : "none",
                   transition: reduce ? "none" : "box-shadow .2s ease" }}>
          <node.NodeIcon size={14} strokeWidth={2.2} style={{ color: node.fg }} />
          {inProgress && !reduce && (
            <span className="absolute inset-0 rounded-full animate-ping"
              style={{ border: "2px solid #d8b070", opacity: 0.4 }} />
          )}
        </div>
        {!isLast && (
          <div className="w-px flex-1" style={{ minHeight: 20, marginTop: 4, marginBottom: 2,
            background: done ? "var(--green)" : "var(--border)" }} />
        )}
      </div>

      {/* Card */}
      <div className="flex-1 min-w-0 pb-4">
        <div className="rounded-xl p-3.5 flex items-start gap-3"
          style={{ background: "var(--surface)",
                   border: `1px solid ${upNext ? "var(--green)" : "var(--border)"}`,
                   boxShadow: "var(--card-shadow)", opacity: blocked ? 0.82 : 1 }}>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-sm font-semibold text-theme">{step.title}</p>
              {upNext && (
                <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide"
                  style={{ background: "var(--green-subtle)", color: "var(--green)" }}>Up next</span>
              )}
              <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide"
                style={{ background: statusMeta.bg, color: statusMeta.fg }}>
                <statusMeta.Dot size={10} strokeWidth={2.4} /> {statusMeta.label}
              </span>
              {blocked && (
                <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide"
                  style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}
                  title={`Blocked until “${step.blocked_by}” is done`}>
                  <Lock size={10} strokeWidth={2.4} /> Blocked
                </span>
              )}
              {step.linked && (
                <span className="text-[10px] px-1.5 py-0.5 rounded" title="Updates automatically from its module"
                  style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}>auto</span>
              )}
            </div>
            {step.description && (
              <p className="text-[12px] mt-0.5" style={{ color: "var(--text-muted)" }}>{step.description}</p>
            )}
            {step.category === "schedule" && step.schedule_detail?.applicable && step.schedule_detail.kinds.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                {step.schedule_detail.kinds.map((k) => (
                  <ScheduleKindChip key={k.kind} kind={k} onOpen={() => onOpen("/app/schedules")} />
                ))}
              </div>
            )}
            {blocked && step.blocked_by && (
              <p className="text-[11px] mt-1" style={{ color: "var(--text-muted)" }}>
                Waiting on <span className="font-medium">{step.blocked_by}</span>.
              </p>
            )}
            <div className="flex items-center gap-x-3 gap-y-1 mt-1.5 text-[11px] flex-wrap" style={{ color: "var(--text-muted)" }}>
              <DueCell due={step.due_date} overdue={overdue} isAdmin={isAdmin} onDue={onDue} />
              <span className="inline-flex items-center gap-1">
                Owner: <OwnerControl assigneeId={step.assignee_id} name={memberName(step.assignee_id)}
                  isAdmin={isAdmin} members={members} onAssign={onAssign} />
              </span>
              {done && step.completed_at && <span>· Completed {formatDate(step.completed_at)}</span>}
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {href && (
              <button onClick={() => onOpen(href)}
                className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[12px] font-semibold transition-colors hover:bg-[var(--surface-2)]"
                style={{ border: "1px solid var(--border)", color: "var(--text-2)" }}>
                Open <ChevronRight size={13} strokeWidth={2} />
              </button>
            )}
            {!step.linked && (
              done ? (
                <button onClick={() => onToggle("pending")} disabled={busy}
                  className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[12px] font-semibold transition-colors hover:bg-[var(--surface-2)] disabled:opacity-50"
                  style={{ border: "1px solid var(--border)", color: "var(--text-muted)" }}>
                  Undo
                </button>
              ) : (
                <button onClick={() => onToggle("done")} disabled={busy || blocked}
                  title={blocked ? `Complete “${step.blocked_by}” first` : undefined}
                  className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-[12px] font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{ background: blocked ? "var(--text-muted)" : "var(--green)" }}>
                  {busy ? <Spinner className="h-3.5 w-3.5" /> : blocked ? <Lock size={13} strokeWidth={2.4} /> : <CheckCircle2 size={13} strokeWidth={2.4} />}
                  Mark done
                </button>
              )
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function OwnerControl({ assigneeId, name, isAdmin, members, onAssign }: {
  assigneeId: string | null
  name: string | null
  isAdmin: boolean
  members: WorkspaceMember[]
  onAssign: (uid: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  if (!isAdmin) {
    return <span style={{ color: assigneeId ? "var(--text-2)" : "var(--text-muted)" }}>
      {assigneeId ? name : "Unassigned"}</span>
  }
  return (
    <span className="relative inline-block">
      <button onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors hover:bg-[var(--surface-2)]"
        style={{ color: assigneeId ? "var(--text-2)" : "var(--text-muted)", border: "1px solid var(--border)" }}>
        <UserPlus size={11} strokeWidth={2} /> {assigneeId ? name : "Assign"}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 z-20 mt-1 w-48 rounded-lg py-1 max-h-56 overflow-auto"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
            <button onClick={() => { onAssign(null); setOpen(false) }}
              className="w-full text-left px-3 py-1.5 text-[12px] hover:bg-[var(--surface-2)]"
              style={{ color: "var(--text-muted)" }}>Unassigned</button>
            {members.filter((m) => m.id).map((m) => (
              <button key={m.id} onClick={() => { onAssign(m.id); setOpen(false) }}
                className="w-full text-left px-3 py-1.5 text-[12px] hover:bg-[var(--surface-2)] truncate"
                style={{ color: "var(--text)" }}>
                {m.display_name || m.email}
                <span className="ml-1 text-[10px]" style={{ color: "var(--text-muted)" }}>· {m.role}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  )
}

function DueCell({ due, overdue, isAdmin, onDue }: {
  due: string | null
  overdue: boolean
  isAdmin: boolean
  onDue: (dateIso: string | null) => void
}) {
  const [editing, setEditing] = useState(false)
  if (editing && isAdmin) {
    return (
      <input type="date" defaultValue={due ?? ""} autoFocus
        onBlur={(e) => { onDue(e.target.value || null); setEditing(false) }}
        onKeyDown={(e) => {
          if (e.key === "Enter") { onDue((e.target as HTMLInputElement).value || null); setEditing(false) }
          else if (e.key === "Escape") setEditing(false)
        }}
        className="rounded px-1 py-0.5 text-[11px] outline-none"
        style={{ background: "var(--surface)", border: "1px solid var(--border-strong)", color: "var(--text)" }} />
    )
  }
  return (
    <span className={isAdmin ? "cursor-pointer hover:underline" : ""}
      onClick={() => isAdmin && setEditing(true)}
      title={isAdmin ? "Click to set the due date" : undefined}
      style={{ color: overdue ? "var(--danger)" : "var(--text-muted)", fontWeight: overdue ? 600 : 400 }}>
      {due ? `Due ${formatDate(due)}` : (isAdmin ? "Set due date" : "No due date")}{overdue ? " · overdue" : ""}
    </span>
  )
}

// ── Right rail: This close ────────────────────────────────────────────────

function ThisCloseCard({ label, periodEnd, closed, done, total, pct, blocked, upNextTitle, reduce }: {
  label: string
  periodEnd: string
  closed: boolean
  done: number
  total: number
  pct: number
  blocked: number
  upNextTitle: string | null
  reduce: boolean
}) {
  return (
    <div className="rounded-2xl p-5"
      style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
      <div className="flex items-center justify-between mb-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
          This close
        </p>
        {closed ? (
          <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide"
            style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
            <Lock size={10} strokeWidth={2.4} /> Closed
          </span>
        ) : (
          <span className="text-[11px] font-semibold text-theme">{label}</span>
        )}
      </div>

      <div className="flex items-center gap-4">
        <ProgressRing pct={pct} reduce={reduce} />
        <div className="min-w-0">
          <p className="text-sm font-bold text-theme">{done} / {total} steps</p>
          <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
            {closed ? "Books locked" : `${daysSince(periodEnd)} days since month-end`}
          </p>
          {blocked > 0 && (
            <p className="text-[12px] mt-0.5 inline-flex items-center gap-1" style={{ color: "var(--danger)" }}>
              <Lock size={11} strokeWidth={2.2} /> {blocked} blocked
            </p>
          )}
        </div>
      </div>

      {!closed && upNextTitle && (
        <div className="mt-3 rounded-lg px-3 py-2 text-[12px]"
          style={{ background: "var(--green-subtle)", color: "var(--text)" }}>
          <span style={{ color: "var(--green)" }} className="font-semibold">Up next:</span> {upNextTitle}
        </div>
      )}
    </div>
  )
}

function ProgressRing({ pct, size = 76, stroke = 7, reduce }: { pct: number; size?: number; stroke?: number; reduce: boolean }) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const clamped = Math.max(0, Math.min(100, pct))
  const off = c * (1 - clamped / 100)
  return (
    <svg width={size} height={size} className="shrink-0" role="img" aria-label={`${clamped}% complete`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-2)" strokeWidth={stroke} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--green)" strokeWidth={stroke}
        strokeLinecap="round" strokeDasharray={c} strokeDashoffset={off}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: reduce ? "none" : "stroke-dashoffset .8s cubic-bezier(0.22,1,0.36,1)" }} />
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" aria-hidden="true"
        style={{ fontSize: 17, fontWeight: 700, fill: "var(--text)" }}>{clamped}%</text>
    </svg>
  )
}

// ── Right rail: Prefilled by Nordavix (Client Memory) ─────────────────────

const PREFILL_MODULE: Record<string, { label: string; href: string; icon: LucideIcon }> = {
  flux:        { label: "Flux",        href: "/app/flux",        icon: BarChart3 },
  schedules:   { label: "Schedules",   href: "/app/schedules",   icon: ClipboardList },
  adjustments: { label: "Adjustments", href: "/app/adjustments", icon: Sparkles },
}

const PREFILL_MAX_ROWS = 6

// Surfaces the confirmed Client Memory conventions Nordavix will pre-fill for
// THIS close (read-only — confirming still happens in Settings → Memory).
function PrefillCard({ period, onOpen }: { period: string; onOpen: (href: string) => void }) {
  const { organization } = useOrganization()
  const navigate = useNavigate()
  const { data, isLoading } = useQuery({
    queryKey: ["close", "prefill", period],
    queryFn:  () => closeApi.getPrefill(period),
    enabled:  !!organization && !!period,
  })

  const items = data?.applying ?? []
  const now = items.filter((i) => i.applies_this_period)
  const later = items.length - now.length
  const suggested = data?.suggested_count ?? 0
  const hasAny = items.length > 0 || suggested > 0
  const shown = now.slice(0, PREFILL_MAX_ROWS)
  const overflow = now.length - shown.length

  return (
    <div className="rounded-2xl p-5"
      style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Brain size={14} strokeWidth={2} style={{ color: "var(--green)" }} />
          <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
            Prefilled by Nordavix
          </p>
        </div>
        {now.length > 0 && (
          <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold"
            style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
            {now.length} applying
          </span>
        )}
      </div>

      {isLoading && !data ? (
        <div className="flex items-center gap-2 py-2"><Spinner className="h-4 w-4" />
          <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>Loading…</span></div>
      ) : !hasAny ? (
        <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
          Nordavix is still learning this client. As you explain variances and set up schedules,
          confirmed conventions appear here and pre-fill your close.
        </p>
      ) : (
        <>
          {now.length > 0 ? (
            <div className="space-y-1.5">
              {shown.map((it) => <PrefillRow key={it.fact_id} item={it} onOpen={onOpen} />)}
              {overflow > 0 && (
                <p className="text-[11px] pt-0.5" style={{ color: "var(--text-muted)" }}>
                  + {overflow} more applying this close
                </p>
              )}
            </div>
          ) : (
            <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
              No confirmed conventions apply to this month yet.
            </p>
          )}

          {later > 0 && (
            <p className="text-[11px] mt-2" style={{ color: "var(--text-muted)" }}>
              + {later} confirmed rule{later === 1 ? "" : "s"} not applying this month.
            </p>
          )}

          {suggested > 0 && (
            <button onClick={() => navigate("/app/settings?tab=memory")}
              className="mt-3 w-full inline-flex items-center justify-between rounded-lg px-3 py-2 text-[12px] font-semibold transition-colors hover:bg-[var(--surface-2)]"
              style={{ border: "1px solid var(--border)", color: "var(--text-2)" }}>
              <span className="inline-flex items-center gap-1.5">
                <Sparkles size={12} strokeWidth={2} style={{ color: "var(--green)" }} />
                {suggested} suggestion{suggested === 1 ? "" : "s"} waiting
              </span>
              <span className="inline-flex items-center gap-0.5" style={{ color: "var(--text-muted)" }}>
                Review <ChevronRight size={13} strokeWidth={2} />
              </span>
            </button>
          )}
        </>
      )}
    </div>
  )
}

// The watchdog's second pair of eyes, surfaced in the close rail: how many
// entries this period's GL-accuracy scan thinks may be miscoded. Reads the same
// findings the GL Accuracy page does (shared query key → one fetch, always in
// sync). The auto-scan after each sync keeps this fresh without anyone clicking.
function GlAccuracyRailCard({ period, onOpen }: { period: string; onOpen: (href: string) => void }) {
  const { organization } = useOrganization()
  const { data, isLoading } = useQuery({
    queryKey: ["gl-accuracy", "findings", period],
    queryFn:  () => glAccuracyApi.getFindings(period),
    enabled:  !!organization && !!period,
    staleTime: 5 * 60_000,
  })

  const open = data?.open_count ?? 0
  const high = data?.high ?? 0
  const dollars = Number(data?.dollars ?? 0)

  return (
    <div className="rounded-2xl p-5"
      style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <ScanSearch size={14} strokeWidth={2} style={{ color: open > 0 ? "var(--warn)" : "var(--green)" }} />
          <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
            Risk Radar
          </p>
        </div>
        {open > 0 && (
          <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold"
            style={{ background: "var(--warn-subtle)", color: "var(--warn)" }}>
            {open} to review
          </span>
        )}
      </div>

      {isLoading && !data ? (
        <div className="flex items-center gap-2 py-2"><Spinner className="h-4 w-4" />
          <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>Loading…</span></div>
      ) : open === 0 ? (
        <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
          A second pair of eyes ran after your last sync. No likely miscodes flagged for this month.
        </p>
      ) : (
        <>
          <p className="text-[12px]" style={{ color: "var(--text-2)" }}>
            {open} {open === 1 ? "entry looks" : "entries look"} miscoded against the vendor's own history
            {high > 0 ? ` (${high} high-confidence)` : ""} — {dollars.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 })} to reclassify.
          </p>
          <button onClick={() => onOpen("/app/gl-accuracy")}
            className="mt-3 w-full inline-flex items-center justify-between rounded-lg px-3 py-2 text-[12px] font-semibold transition-colors hover:bg-[var(--surface-2)]"
            style={{ border: "1px solid var(--border)", color: "var(--text-2)" }}>
            <span className="inline-flex items-center gap-1.5">
              <ScanSearch size={12} strokeWidth={2} style={{ color: "var(--warn)" }} />
              Review findings
            </span>
            <span className="inline-flex items-center gap-0.5" style={{ color: "var(--text-muted)" }}>
              Open <ChevronRight size={13} strokeWidth={2} />
            </span>
          </button>
        </>
      )}
    </div>
  )
}

function PrefillRow({ item, onOpen }: { item: PrefillItem; onOpen: (href: string) => void }) {
  const mod = PREFILL_MODULE[item.module]
  const Icon = mod?.icon ?? Sparkles
  const clickable = !!mod?.href
  const seen = item.confidence > 0 ? `Seen ${item.confidence}×` : null
  return (
    <div
      onClick={() => clickable && onOpen(mod!.href)}
      className={`rounded-lg px-3 py-2 ${clickable ? "cursor-pointer hover:bg-[var(--surface)]" : ""}`}
      style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}
      title={clickable ? `Open ${mod!.label}` : undefined}
    >
      <div className="flex items-center gap-2">
        <Icon size={13} strokeWidth={1.9} className="shrink-0" style={{ color: "var(--text-muted)" }} />
        <span className="text-[12px] font-semibold text-theme truncate flex-1">{item.title}</span>
        {clickable && <ChevronRight size={13} strokeWidth={2} className="shrink-0" style={{ color: "var(--text-muted)" }} />}
      </div>
      <p className="text-[11px] mt-0.5 pl-[21px]" style={{ color: "var(--text-muted)" }}>
        {item.what_it_does}{seen ? ` · ${seen}` : ""}
      </p>
    </div>
  )
}

// ── Right rail: Cycle-time analytics ──────────────────────────────────────

function CycleTimeCard({ reduce }: { reduce: boolean }) {
  const { organization } = useOrganization()
  const { data, isLoading } = useQuery({
    queryKey: ["close", "analytics"], queryFn: closeApi.getAnalytics, enabled: !!organization,
  })

  const hasData = !!data && (data.periods_closed > 0 || data.steps.length > 0)
  const bottleneck = data?.steps.find((s) => s.step_key === data.bottleneck_step_key) ?? null

  const avg = useCountUp(data?.avg_days_to_close ?? 0, !reduce && hasData)
  const ontime = useCountUp(data?.on_time_pct ?? 0, !reduce && hasData)

  return (
    <div className="rounded-2xl p-5"
      style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
      <div className="flex items-center gap-2 mb-3">
        <TrendingUp size={14} strokeWidth={2} style={{ color: "var(--text-muted)" }} />
        <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
          Cycle time · all periods
        </p>
      </div>

      {isLoading && !data ? (
        <div className="flex items-center gap-2 py-2"><Spinner className="h-4 w-4" />
          <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>Loading…</span></div>
      ) : !hasData ? (
        <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
          Close a couple of months and your days-to-close trend and per-step timing appear here.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Stat icon={Timer} label="Avg days to close"
              value={data!.avg_days_to_close != null ? (reduce ? `${data!.avg_days_to_close}` : avg.toFixed(1)) : "—"} />
            <Stat icon={CheckCircle2} label="On-time steps"
              value={data!.on_time_pct != null ? `${reduce ? data!.on_time_pct : Math.round(ontime)}%` : "—"} />
          </div>

          {data!.days_to_close_trend.length > 0 && (
            <div className="mt-4">
              <p className="text-[10px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: "var(--text-muted)" }}>
                Days to close · last {Math.min(12, data!.days_to_close_trend.length)}
              </p>
              <Sparkline values={data!.days_to_close_trend.slice(-12).map((t) => t.days)} reduce={reduce} />
            </div>
          )}

          {bottleneck && (
            <div className="mt-4 rounded-lg px-3 py-2 flex items-start gap-2"
              style={{ background: "var(--danger-subtle)", border: "1px solid var(--danger-border)" }}>
              <AlertTriangle size={13} strokeWidth={2.2} className="mt-0.5 shrink-0" style={{ color: "var(--danger)" }} />
              <p className="text-[12px]" style={{ color: "var(--text-2)" }}>
                <span className="font-semibold" style={{ color: "var(--danger)" }}>Bottleneck:</span> {bottleneck.title}
                <span style={{ color: "var(--text-muted)" }}> · avg {bottleneck.avg_days}d</span>
              </p>
            </div>
          )}

          <div className="mt-3 text-[11px] tabular-nums" style={{ color: "var(--text-muted)" }}>
            {data!.periods_closed} period{data!.periods_closed === 1 ? "" : "s"} closed
          </div>
        </>
      )}
    </div>
  )
}

function Stat({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="rounded-xl p-2.5" style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
      <div className="flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide mb-0.5"
        style={{ color: "var(--text-muted)" }}>
        <Icon size={11} strokeWidth={2} /> {label}
      </div>
      <p className="text-lg font-bold tabular-nums text-theme leading-tight">{value}</p>
    </div>
  )
}

function Sparkline({ values, width = 252, height = 40, reduce }: { values: number[]; width?: number; height?: number; reduce: boolean }) {
  if (values.length === 0) return null
  const pts = values.length === 1 ? [values[0], values[0]] : values
  const max = Math.max(1, ...pts)
  const stepX = pts.length > 1 ? width / (pts.length - 1) : 0
  const coords = pts.map((v, i) => {
    const x = i * stepX
    const y = height - (v / max) * (height - 6) - 3
    return [x, y] as const
  })
  const line = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")
  const [lx, ly] = coords[coords.length - 1]
  const lineLen = width * 1.3
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <polyline points={line} fill="none" stroke="var(--green)" strokeWidth={2}
        strokeLinecap="round" strokeLinejoin="round"
        style={reduce ? undefined : { strokeDasharray: lineLen, strokeDashoffset: lineLen, animation: "ndvx-draw .9s ease forwards" }} />
      <circle cx={lx} cy={ly} r={3} fill="var(--green)" />
      <style>{"@keyframes ndvx-draw{to{stroke-dashoffset:0}}"}</style>
    </svg>
  )
}

// ── Admin template editor ─────────────────────────────────────────────────

function TemplateEditor() {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const { data, isLoading } = useQuery({
    queryKey: ["close", "template"], queryFn: closeApi.getTemplate, enabled: open,
  })
  const steps = useMemo(() => (data?.steps ?? []).slice().sort((a, b) => a.order_index - b.order_index), [data])

  const [err, setErr] = useState<string | null>(null)
  const ok = () => { setErr(null); invalidate() }
  const fail = (e: unknown) => setErr(
    (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
    ?? "Couldn't save that change — you may not have permission, or the connection hiccuped.")
  function invalidate() {
    qc.invalidateQueries({ queryKey: ["close", "template"] })
    qc.invalidateQueries({ queryKey: ["close", "checklist"] })
    qc.invalidateQueries({ queryKey: ["close", "analytics"] })
  }
  const addMut    = useMutation({ mutationFn: closeApi.addStep, onSuccess: ok, onError: fail })
  // Edit + reorder apply optimistically to the template cache so renames and
  // up/down feel instant; on error we roll the cache back and surface the reason.
  const editMut   = useMutation({
    mutationFn: (v: { id: string; body: Parameters<typeof closeApi.editStep>[1] }) => closeApi.editStep(v.id, v.body),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ["close", "template"] })
      const prev = qc.getQueryData<{ steps: TemplateStep[] }>(["close", "template"])
      if (prev) {
        const patch = v.body.clear_depends_on ? { ...v.body, depends_on_key: null } : v.body
        qc.setQueryData(["close", "template"], {
          steps: prev.steps.map((s) => (s.id === v.id ? { ...s, ...patch } : s)),
        })
      }
      return { prev }
    },
    onError: (e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(["close", "template"], ctx.prev); fail(e) },
    onSuccess: ok,
  })
  const deleteMut = useMutation({ mutationFn: closeApi.deleteStep, onSuccess: ok, onError: fail })
  const reorderMut = useMutation({
    mutationFn: closeApi.reorder,
    onMutate: async (ids: string[]) => {
      await qc.cancelQueries({ queryKey: ["close", "template"] })
      const prev = qc.getQueryData<{ steps: TemplateStep[] }>(["close", "template"])
      if (prev) {
        const byId = new Map(prev.steps.map((s) => [s.id, s]))
        const reordered = ids
          .map((id, i) => { const s = byId.get(id); return s ? { ...s, order_index: i } : null })
          .filter(Boolean) as TemplateStep[]
        qc.setQueryData(["close", "template"], { steps: reordered })
      }
      return { prev }
    },
    onError: (e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(["close", "template"], ctx.prev); fail(e) },
    onSuccess: ok,
  })

  const [newTitle, setNewTitle] = useState("")
  function submitAdd() {
    if (!newTitle.trim() || addMut.isPending) return
    addMut.mutate({ title: newTitle.trim() }); setNewTitle("")
  }

  function move(idx: number, dir: -1 | 1) {
    const next = idx + dir
    if (next < 0 || next >= steps.length) return
    const ids = steps.map((s) => s.id)
    ;[ids[idx], ids[next]] = [ids[next], ids[idx]]
    reorderMut.mutate(ids)
  }

  return (
    <div className="mt-4 rounded-2xl"
      style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
      <button onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-5 py-4">
        <span className="flex items-center gap-2 text-sm font-semibold text-theme">
          <Pencil size={15} strokeWidth={1.9} style={{ color: "var(--text-muted)" }} />
          Customize the checklist
        </span>
        <ChevronRight size={16} strokeWidth={2}
          style={{ color: "var(--text-muted)", transform: open ? "rotate(90deg)" : "none", transition: "transform 0.12s ease-out" }} />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }} className="overflow-hidden">
            <div className="px-5 pb-5 pt-0" style={{ borderTop: "1px solid var(--border)" }}>
              <p className="text-[12px] mt-3 mb-3" style={{ color: "var(--text-muted)" }}>
                Reorder, rename, hide, set a prerequisite, or add steps for this client. Linked steps (sync,
                reconcile, schedules, flux, close) update automatically and can't be removed — hide them if
                you don't use them. A step with a prerequisite stays blocked until that step is done.
              </p>

              {err && (
                <div className="rounded-lg px-3 py-2 text-[12px] mb-3"
                  style={{ background: "var(--danger-subtle)", color: "var(--danger)", border: "1px solid var(--danger-border)" }}>
                  {err}
                </div>
              )}

              {isLoading ? (
                <div className="flex items-center gap-2 py-3"><Spinner className="h-4 w-4" />
                  <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>Loading…</span></div>
              ) : (
                <div className="space-y-1.5">
                  {steps.map((s, i) => (
                    <TemplateRow
                      key={s.id} step={s} allSteps={steps} first={i === 0} last={i === steps.length - 1}
                      onMove={(dir) => move(i, dir)}
                      onEdit={(body) => editMut.mutate({ id: s.id, body })}
                      onDelete={() => deleteMut.mutate(s.id)}
                    />
                  ))}
                </div>
              )}

              <div className="flex items-center gap-2 mt-3">
                <input
                  value={newTitle} onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="Add a custom step (e.g. Confirm payroll posted)"
                  className="flex-1 rounded-lg px-3 py-2 text-sm outline-none"
                  style={{ background: "var(--surface-2)", border: "1px solid var(--border)", color: "var(--text)" }}
                  onKeyDown={(e) => { if (e.key === "Enter") submitAdd() }}
                />
                <Button size="sm" disabled={!newTitle.trim() || addMut.isPending} onClick={submitAdd}>
                  <Plus size={14} strokeWidth={2.2} /> Add
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function TemplateRow({ step, allSteps, first, last, onMove, onEdit, onDelete }: {
  step: TemplateStep
  allSteps: TemplateStep[]
  first: boolean
  last: boolean
  onMove: (dir: -1 | 1) => void
  onEdit: (body: Parameters<typeof closeApi.editStep>[1]) => void
  onDelete: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(step.title)
  const isCustom = step.key.startsWith("custom-")
  const Icon = CAT_ICON[step.category] || ListChecks
  const prereqOptions = allSteps.filter((s) => s.key !== step.key)

  return (
    <div className="rounded-lg px-3 py-2"
      style={{ background: "var(--surface-2)", border: "1px solid var(--border)", opacity: step.is_active ? 1 : 0.5 }}>
      <div className="flex items-center gap-2">
        <div className="flex flex-col">
          <button onClick={() => onMove(-1)} disabled={first} className="disabled:opacity-30" title="Move up">
            <ArrowUp size={12} strokeWidth={2} style={{ color: "var(--text-muted)" }} />
          </button>
          <button onClick={() => onMove(1)} disabled={last} className="disabled:opacity-30" title="Move down">
            <ArrowDown size={12} strokeWidth={2} style={{ color: "var(--text-muted)" }} />
          </button>
        </div>
        <Icon size={15} strokeWidth={1.8} className="shrink-0" style={{ color: "var(--text-muted)" }} />

        {editing ? (
          <input
            value={title} onChange={(e) => setTitle(e.target.value)} autoFocus
            className="flex-1 rounded px-2 py-1 text-sm outline-none"
            style={{ background: "var(--surface)", border: "1px solid var(--border-strong)", color: "var(--text)" }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && title.trim()) { onEdit({ title: title.trim() }); setEditing(false) }
              else if (e.key === "Escape") { setTitle(step.title); setEditing(false) }
            }}
            onBlur={() => { if (title.trim() && title !== step.title) onEdit({ title: title.trim() }); setEditing(false) }}
          />
        ) : (
          <span className="flex-1 text-sm text-theme truncate">
            {step.title}
            {step.linked_module && (
              <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded"
                style={{ background: "var(--surface)", color: "var(--text-muted)" }}>auto</span>
            )}
            {!step.is_active && (
              <span className="ml-2 text-[10px]" style={{ color: "var(--text-muted)" }}>(hidden)</span>
            )}
          </span>
        )}

        <button onClick={() => setEditing(true)} title="Rename"
          className="p-1 rounded hover:bg-[var(--surface)]">
          <Pencil size={13} strokeWidth={1.8} style={{ color: "var(--text-muted)" }} />
        </button>
        <button onClick={() => onEdit({ is_active: !step.is_active })}
          title={step.is_active ? "Hide this step" : "Show this step"}
          className="p-1 rounded hover:bg-[var(--surface)] text-[11px] font-semibold"
          style={{ color: "var(--text-muted)" }}>
          {step.is_active ? "Hide" : "Show"}
        </button>
        {isCustom && (
          <button onClick={onDelete} title="Delete custom step"
            className="p-1 rounded hover:bg-[var(--surface)]">
            <Trash2 size={13} strokeWidth={1.8} style={{ color: "var(--danger)" }} />
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 mt-1.5 pl-[26px] text-[11px]" style={{ color: "var(--text-muted)" }}>
        <span>Prerequisite:</span>
        <select
          value={step.depends_on_key ?? ""}
          onChange={(e) => {
            const v = e.target.value
            onEdit(v ? { depends_on_key: v } : { clear_depends_on: true })
          }}
          className="rounded px-1.5 py-0.5 text-[11px] outline-none"
          style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }}
        >
          <option value="">None</option>
          {prereqOptions.map((s) => (
            <option key={s.key} value={s.key} disabled={!s.is_active}>
              {s.title}{s.is_active ? "" : " (hidden)"}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}

// ── Shell / Card ──────────────────────────────────────────────────────────

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col h-full overflow-y-auto" style={{ background: "var(--bg)" }}>
      <div className="flex-1 px-4 sm:px-8 py-5 max-w-6xl w-full mx-auto">{children}</div>
    </div>
  )
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-2xl"
      style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
      {children}
    </section>
  )
}
