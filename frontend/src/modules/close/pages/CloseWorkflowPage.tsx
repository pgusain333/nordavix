/**
 * Close Workflow — the milestone checklist for a period.
 *
 * Sits ABOVE the granular Close Tasks list: one ordered step per close
 * milestone (sync → reconcile → schedules → adjustments → flux → financials →
 * review → close). LINKED steps auto-reflect the underlying module's status for
 * the period (you can't tick them by hand — they go green when the work is
 * actually done); MANUAL steps are ticked here.
 *
 * Slice 2 adds: dependency gating (a step is "blocked" until its prerequisite
 * is done), per-step owners (admin-assigned, with an "assigned to you"
 * notification), and editable due dates with an overdue flag. Admins tailor the
 * checklist — including each step's prerequisite — from the template editor.
 */
import { useEffect, useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useOrganization } from "@clerk/clerk-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AnimatePresence, motion } from "framer-motion"
import {
  RefreshCw, Scale, ClipboardList, Sparkles, BarChart3, BookOpen,
  ShieldCheck, Lock, ListChecks, CheckCircle2, Circle, Clock,
  ChevronRight, Pencil, Trash2, Plus, ArrowUp, ArrowDown, UserPlus,
  type LucideIcon,
} from "lucide-react"
import { Button, Spinner } from "@/core/ui/components"
import { formatDate } from "@/core/lib/dates"
import { workspaceApi, type WorkspaceMember } from "@/modules/workspace/api"
import { closeApi, type CloseStep, type TemplateStep } from "@/modules/close/api"

const CAT_ICON: Record<string, LucideIcon> = {
  sync: RefreshCw, recon: Scale, schedule: ClipboardList, adjustments: Sparkles,
  flux: BarChart3, financials: BookOpen, review: ShieldCheck, close: Lock, custom: ListChecks,
}

/** Where a step's "View" / "Open" button takes the user, by linked module
 *  (or category for manual steps that still map to a screen). */
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

/** Past due and not yet done. due is a date-only string → anchor at local midnight. */
function isOverdue(due: string | null, done: boolean): boolean {
  if (!due || done) return false
  const d = new Date(due + "T00:00:00")
  const today = new Date(); today.setHours(0, 0, 0, 0)
  return d.getTime() < today.getTime()
}

export function CloseWorkflowPage() {
  const { organization } = useOrganization()
  const qc = useQueryClient()
  const navigate = useNavigate()

  const { data: me } = useQuery({
    queryKey: ["workspace-me"], queryFn: workspaceApi.getMe,
    staleTime: 10 * 60_000, enabled: !!organization,
  })
  const isAdmin = me?.role === "admin"

  // Members — for the owner dropdown + resolving assignee names.
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

  const [period, setPeriod] = useState<string>("")
  // Default to the focus period (oldest open month) once periods load.
  useEffect(() => {
    if (!period && periodsResp) {
      setPeriod(periodsResp.focus || periodsResp.periods[0]?.period_end || "")
    }
  }, [periodsResp, period])

  const { data: checklist, isLoading: checklistLoading } = useQuery({
    queryKey: ["close", "checklist", period],
    queryFn:  () => closeApi.getChecklist(period),
    enabled:  !!organization && !!period,
  })

  const [actionErr, setActionErr] = useState<string | null>(null)
  const stepMut = useMutation({
    mutationFn: closeApi.updateStep,
    onSuccess: () => { setActionErr(null); qc.invalidateQueries({ queryKey: ["close", "checklist", period] }) },
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
              The month-end checklist — steps go green automatically as the work gets done.
            </p>
          </div>
        </div>
        {booksReady && (
          <select
            value={period} onChange={(e) => setPeriod(e.target.value)}
            className="rounded-lg px-3 py-2 text-sm outline-none"
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
        <>
          {/* Progress summary */}
          {checklist && (
            <div className="rounded-2xl p-5 mb-5"
              style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm font-semibold text-theme">
                  {checklist.summary.done} of {checklist.summary.total} steps done
                  {checklist.closed && (
                    <span className="ml-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide"
                      style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
                      <Lock size={10} strokeWidth={2.4} /> Closed
                    </span>
                  )}
                </p>
                <span className="text-sm font-bold tabular-nums" style={{ color: "var(--green)" }}>
                  {checklist.summary.pct}%
                </span>
              </div>
              <div className="h-2 rounded-full overflow-hidden" style={{ background: "var(--surface-2)" }}>
                <div className="h-full rounded-full transition-[width] duration-500"
                  style={{ width: `${checklist.summary.pct}%`, background: "var(--green)" }} />
              </div>
            </div>
          )}

          {/* Checklist */}
          {checklistLoading && !checklist ? (
            <Card><div className="p-6 flex items-center gap-3"><Spinner className="h-5 w-5" />
              <span className="text-sm" style={{ color: "var(--text-muted)" }}>Loading checklist…</span></div></Card>
          ) : (
            <div className="space-y-2.5">
              {checklist?.steps.map((step) => (
                <StepRow
                  key={step.step_key} step={step} periodEnd={period}
                  isAdmin={!!isAdmin} members={members ?? []} memberName={memberName}
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
              ))}
            </div>
          )}

          {/* Admin: template editor */}
          {isAdmin && <TemplateEditor />}
        </>
      )}
    </Shell>
  )
}

// ── Step row ────────────────────────────────────────────────────────────────

function StepRow({ step, periodEnd, isAdmin, members, memberName, busy, onOpen, onToggle, onAssign, onDue }: {
  step: CloseStep
  periodEnd: string
  isAdmin: boolean
  members: WorkspaceMember[]
  memberName: (id: string | null) => string | null
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
  const blocked = step.blocked
  const overdue = isOverdue(step.due_date, done)

  const statusMeta = done
    ? { label: "Done", bg: "var(--green-subtle)", fg: "var(--green)", Dot: CheckCircle2 }
    : inProgress
      ? { label: "In progress", bg: "rgba(199,154,82,0.14)", fg: "#a9762a", Dot: Clock }
      : { label: "Pending", bg: "var(--surface-2)", fg: "var(--text-muted)", Dot: Circle }

  return (
    <div className="rounded-xl flex items-start gap-3 p-4"
      style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)",
               opacity: blocked && !done ? 0.72 : 1 }}>
      <span className="h-9 w-9 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
        style={{ background: done ? "var(--green-subtle)" : "var(--surface-2)",
                 color: done ? "var(--green)" : "var(--text-muted)" }}>
        <Icon size={17} strokeWidth={1.8} />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-semibold text-theme">{step.title}</p>
          <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide"
            style={{ background: statusMeta.bg, color: statusMeta.fg }}>
            <statusMeta.Dot size={10} strokeWidth={2.4} /> {statusMeta.label}
          </span>
          {blocked && !done && (
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
        {blocked && !done && step.blocked_by && (
          <p className="text-[11px] mt-1" style={{ color: "var(--text-muted)" }}>
            Waiting on <span className="font-medium">{step.blocked_by}</span>.
          </p>
        )}

        {/* Meta: due · owner · completed */}
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
        {/* Manual steps are ticked here; linked steps update on their own. */}
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
      style={{ color: overdue ? "#9b3d37" : "var(--text-muted)", fontWeight: overdue ? 600 : 400 }}>
      {due ? `Due ${formatDate(due)}` : (isAdmin ? "Set due date" : "No due date")}{overdue ? " · overdue" : ""}
    </span>
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
  }
  const addMut    = useMutation({ mutationFn: closeApi.addStep, onSuccess: ok, onError: fail })
  const editMut   = useMutation({ mutationFn: (v: { id: string; body: Parameters<typeof closeApi.editStep>[1] }) => closeApi.editStep(v.id, v.body), onSuccess: ok, onError: fail })
  const deleteMut = useMutation({ mutationFn: closeApi.deleteStep, onSuccess: ok, onError: fail })
  const reorderMut = useMutation({ mutationFn: closeApi.reorder, onSuccess: ok, onError: fail })

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
    <div className="mt-6 rounded-2xl"
      style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
      <button onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-5 py-4">
        <span className="flex items-center gap-2 text-sm font-semibold text-theme">
          <Pencil size={15} strokeWidth={1.9} style={{ color: "var(--text-muted)" }} />
          Customize the checklist
        </span>
        <ChevronRight size={16} strokeWidth={2}
          style={{ color: "var(--text-muted)", transform: open ? "rotate(90deg)" : "none", transition: "transform .15s" }} />
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

              {/* Add custom step */}
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
  // Candidate prerequisites: any other step (by key); exclude self.
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
            <Trash2 size={13} strokeWidth={1.8} style={{ color: "#9b3d37" }} />
          </button>
        )}
      </div>

      {/* Prerequisite picker */}
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
      <div className="flex-1 px-4 sm:px-8 py-5 max-w-4xl w-full mx-auto">{children}</div>
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
