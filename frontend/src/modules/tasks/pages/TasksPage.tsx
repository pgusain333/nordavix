/**
 * TasksPage — single "everything that needs doing" inbox.
 *
 * The list is derived from existing data (pending/flagged
 * reconciliation accounts) and merged with action overlays
 * the user has attached (snoozed, dismissed, notes, completed).
 * Manual ad-hoc tasks live in the same list.
 *
 * Layout:
 *   [Header]   Title + counts + "New task" button
 *   [Filter]   Tabs: Open · Snoozed · Completed · All
 *   [List]     One row per task with subject + context + actions
 *
 * Each row links back to the page that resolves it (recons dashboard
 * for the relevant month). Snoozing pushes the row out of the "Open"
 * view until the snooze date; dismissing hides it permanently. Each
 * action is server-persisted in task_actions so it survives refresh.
 */
import { useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { motion, AnimatePresence } from "framer-motion"
import {
  CheckSquare,
  AlertTriangle,
  AlertCircle,
  ArrowRight,
  ArrowLeft,
  ChevronDown,
  Clock,
  X,
  CheckCircle2,
  Plus,
  StickyNote,
} from "lucide-react"
import { Button, Spinner } from "@/core/ui/components"
import { tasksApi, type Task, type TaskSeverity } from "@/modules/tasks/api"

type FilterTab = "open" | "snoozed" | "completed" | "all"

// ── Helpers ────────────────────────────────────────────────────────────────

function severityMeta(s: TaskSeverity) {
  if (s === "critical")
    return { fg: "#b91c1c", bg: "#fef2f2", border: "rgba(220, 38, 38, 0.40)",
             label: "Critical", Icon: AlertCircle }
  if (s === "warn")
    return { fg: "#92400e", bg: "#fef3c7", border: "#fcd34d",
             label: "High",     Icon: AlertTriangle }
  return     { fg: "var(--text-2)", bg: "var(--surface-2)", border: "var(--border)",
             label: "Normal",   Icon: CheckSquare }
}

function isSnoozed(t: Task): boolean {
  if (!t.snooze_until) return false
  try {
    return new Date(t.snooze_until + "T00:00:00") > new Date()
  } catch { return false }
}

function isOpen(t: Task): boolean {
  return !t.completed_at && !t.dismissed_at && !isSnoozed(t)
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return ""
  try {
    return new Date(iso + (iso.includes("T") ? "" : "T00:00:00"))
      .toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
  } catch { return iso }
}

// ── Component ──────────────────────────────────────────────────────────────

export function TasksPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [tab, setTab] = useState<FilterTab>("open")
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [showManualForm, setShowManualForm] = useState(false)

  const { data: tasks = [], isLoading } = useQuery({
    queryKey: ["tasks", "all"],
    // Always pull EVERYTHING so the filter tabs work without refetching.
    queryFn:  () => tasksApi.list(true),
    staleTime: 30_000,
  })

  const counts = useMemo(() => {
    let open = 0, snoozed = 0, completed = 0
    for (const t of tasks) {
      if (t.completed_at) completed++
      else if (isSnoozed(t)) snoozed++
      else if (!t.dismissed_at) open++
    }
    return { open, snoozed, completed, all: tasks.length }
  }, [tasks])

  const filtered = useMemo(() => {
    let list = tasks
    if (tab === "open")      list = list.filter(isOpen)
    else if (tab === "snoozed")   list = list.filter((t) => isSnoozed(t) && !t.completed_at && !t.dismissed_at)
    else if (tab === "completed") list = list.filter((t) => !!t.completed_at)
    // "all" → no filter
    return list
  }, [tasks, tab])

  // Group filtered tasks by period (newest first). Manual tasks
  // without a period are bucketed under "No period set".
  const grouped = useMemo(() => {
    const map = new Map<string, Task[]>()
    for (const t of filtered) {
      const key = t.period_end ?? "(no period)"
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(t)
    }
    const keys = Array.from(map.keys()).sort((a, b) => (a < b ? 1 : -1))
    return keys.map((k) => ({ period: k, tasks: map.get(k)! }))
  }, [filtered])

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
              Tasks
            </h1>
            <p className="text-xs sm:text-sm mt-1.5" style={{ color: "var(--text-muted)" }}>
              Everything left to do for month-end close — auto-generated from your reconciliation
              status, plus any ad-hoc tasks you create.
            </p>
          </div>
          <Button size="sm" icon={<Plus size={12} strokeWidth={1.8} />}
            onClick={() => setShowManualForm(true)}>
            New task
          </Button>
        </div>
      </motion.div>

      <div className="flex-1 px-4 sm:px-8 py-5 max-w-5xl w-full mx-auto space-y-4">

        {/* Filter tabs */}
        <div className="flex items-center gap-1 flex-wrap rounded-lg p-1 w-fit"
          style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
          {([
            { key: "open",      label: "Open",      count: counts.open      },
            { key: "snoozed",   label: "Snoozed",   count: counts.snoozed   },
            { key: "completed", label: "Completed", count: counts.completed },
            { key: "all",       label: "All",       count: counts.all       },
          ] as const).map((b) => {
            const active = tab === b.key
            return (
              <button key={b.key} onClick={() => setTab(b.key)}
                className="inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-all"
                style={{
                  background: active ? "var(--surface)" : "transparent",
                  color:      active ? "var(--text)"    : "var(--text-muted)",
                  border:     active ? "1px solid var(--border-strong)" : "1px solid transparent",
                }}>
                {b.label}
                <span className="text-[10px] tabular-nums opacity-80">{b.count}</span>
              </button>
            )
          })}
        </div>

        {/* Manual task form */}
        <AnimatePresence>
          {showManualForm && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.18 }}
              style={{ overflow: "hidden" }}
            >
              <ManualTaskForm onClose={() => setShowManualForm(false)} onCreated={() => {
                setShowManualForm(false)
                qc.invalidateQueries({ queryKey: ["tasks"] })
              }} />
            </motion.div>
          )}
        </AnimatePresence>

        {/* List */}
        {isLoading ? (
          <div className="py-16 flex items-center justify-center"><Spinner /></div>
        ) : filtered.length === 0 ? (
          <EmptyState tab={tab} />
        ) : (
          <div className="space-y-4">
            {grouped.map((g) => (
              <div key={g.period}>
                <div className="text-[10px] font-bold uppercase tracking-wide mb-1.5 px-1"
                  style={{ color: "var(--text-muted)" }}>
                  {g.period === "(no period)" ? "No period set" :
                    new Date(g.period + "T00:00:00").toLocaleDateString(undefined, {
                      month: "long", year: "numeric",
                    })}
                  <span className="ml-2 opacity-70">· {g.tasks.length}</span>
                </div>
                <div className="rounded-xl overflow-hidden divide-y"
                  style={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    boxShadow: "var(--card-shadow)",
                  }}>
                  {g.tasks.map((t) => (
                    <TaskRow key={t.key} task={t}
                      expanded={expandedKey === t.key}
                      onToggleExpand={() => setExpandedKey(expandedKey === t.key ? null : t.key)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── TaskRow ────────────────────────────────────────────────────────────────

function TaskRow({ task, expanded, onToggleExpand }:
  { task: Task; expanded: boolean; onToggleExpand: () => void }
) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const meta = severityMeta(task.severity)
  const SeverityIcon = meta.Icon
  const snoozed = isSnoozed(task)
  const completed = !!task.completed_at
  const dismissed = !!task.dismissed_at

  // Mutation helpers: every action invalidates the tasks query so the
  // counts + list re-derive once the server confirms.
  const actionMut = useMutation({
    mutationFn: (patch: Parameters<typeof tasksApi.upsertAction>[0]) => tasksApi.upsertAction(patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  })
  const completeMut = useMutation({
    mutationFn: () => tasksApi.complete(task.action_id!),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  })

  function setSnooze(days: number) {
    const d = new Date()
    d.setDate(d.getDate() + days)
    actionMut.mutate({
      source_type:  task.source_type,
      source_id:    task.source_id,
      period_end:   task.period_end,
      snooze_until: d.toISOString().slice(0, 10),
    })
  }
  function clearSnooze() {
    actionMut.mutate({
      source_type:  task.source_type,
      source_id:    task.source_id,
      period_end:   task.period_end,
      snooze_until: null,
    })
  }
  function dismiss() {
    actionMut.mutate({
      source_type:  task.source_type,
      source_id:    task.source_id,
      period_end:   task.period_end,
      dismissed:    true,
    })
  }

  return (
    <div className="px-4 py-3"
      style={{
        background: completed || dismissed ? "var(--surface-2)" : undefined,
        opacity: completed || dismissed ? 0.6 : 1,
      }}>
      <div className="flex items-start gap-3">
        {/* Severity dot */}
        <div className="shrink-0 mt-0.5">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full"
            style={{ background: meta.bg, border: `1px solid ${meta.border}`, color: meta.fg }}>
            <SeverityIcon size={11} strokeWidth={2} />
          </span>
        </div>

        {/* Body */}
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-sm font-semibold text-theme"
              style={{ textDecoration: completed ? "line-through" : "none" }}>
              {task.subject}
            </span>
            {task.source_type === "manual" && (
              <span className="text-[9px] font-bold uppercase tracking-wide rounded px-1 py-0.5"
                style={{ background: "rgba(168, 85, 247, 0.15)", color: "#a855f7" }}>
                Manual
              </span>
            )}
            {snoozed && (
              <span className="text-[9px] font-medium inline-flex items-center gap-0.5"
                style={{ color: "var(--text-muted)" }}>
                <Clock size={9} strokeWidth={2} /> snoozed until {fmtDate(task.snooze_until)}
              </span>
            )}
            {completed && (
              <span className="text-[9px] font-medium inline-flex items-center gap-0.5"
                style={{ color: "var(--green)" }}>
                <CheckCircle2 size={9} strokeWidth={2} /> completed {fmtDate(task.completed_at)}
              </span>
            )}
          </div>
          {task.description && (
            <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
              {task.description}
            </p>
          )}
          {task.notes && (
            <p className="text-[11px] mt-1.5 italic px-2 py-1 rounded"
              style={{ background: "var(--surface-2)", color: "var(--text-2)" }}>
              <StickyNote size={10} strokeWidth={1.8} className="inline mr-1" />
              {task.notes}
            </p>
          )}
        </div>

        {/* Actions: deep-link + expand-for-more */}
        <div className="flex items-center gap-1 shrink-0">
          {task.deep_link && !completed && !dismissed && (
            <Button size="sm" variant="outline"
              icon={<ArrowRight size={11} strokeWidth={1.8} />}
              onClick={() => navigate(task.deep_link!)}>
              <span className="hidden sm:inline">Open</span>
            </Button>
          )}
          <button
            onClick={onToggleExpand}
            className="h-7 w-7 rounded-md flex items-center justify-center transition-colors hover:bg-[var(--surface-2)]"
            style={{ color: "var(--text-muted)" }}
            title={expanded ? "Hide actions" : "Show actions"}
          >
            <ChevronDown size={14} strokeWidth={2}
              className="transition-transform"
              style={{ transform: expanded ? "rotate(180deg)" : "rotate(0deg)" }}
            />
          </button>
        </div>
      </div>

      {/* Expanded action area */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18 }}
            style={{ overflow: "hidden" }}
          >
            <div className="mt-3 pt-3 flex items-center gap-2 flex-wrap"
              style={{ borderTop: "1px dashed var(--border)" }}>
              {/* Snooze quick-picks */}
              {!completed && !dismissed && (
                <>
                  <span className="text-[10px] font-semibold uppercase tracking-wide mr-1"
                    style={{ color: "var(--text-muted)" }}>
                    Snooze:
                  </span>
                  {snoozed ? (
                    <Button size="sm" variant="outline" onClick={clearSnooze}
                      loading={actionMut.isPending}>
                      Wake now
                    </Button>
                  ) : (
                    <>
                      <Button size="sm" variant="outline" onClick={() => setSnooze(1)}
                        loading={actionMut.isPending}>Tomorrow</Button>
                      <Button size="sm" variant="outline" onClick={() => setSnooze(3)}
                        loading={actionMut.isPending}>3 days</Button>
                      <Button size="sm" variant="outline" onClick={() => setSnooze(7)}
                        loading={actionMut.isPending}>1 week</Button>
                    </>
                  )}
                </>
              )}

              <div className="mx-1 h-4 w-px" style={{ background: "var(--border)" }} />

              {!completed && task.action_id && (
                <Button size="sm" variant="outline"
                  icon={<CheckCircle2 size={11} strokeWidth={1.8} />}
                  loading={completeMut.isPending}
                  onClick={() => completeMut.mutate()}
                  style={{ borderColor: "var(--green)", color: "var(--green)" }}
                >
                  Mark done
                </Button>
              )}
              {!dismissed && !completed && (
                <Button size="sm" variant="ghost" onClick={dismiss}
                  loading={actionMut.isPending}>
                  <X size={11} strokeWidth={1.8} /> Dismiss
                </Button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── Empty state ────────────────────────────────────────────────────────────

function EmptyState({ tab }: { tab: FilterTab }) {
  const copy: Record<FilterTab, { title: string; body: string }> = {
    open:      { title: "Nothing to do",     body: "No open tasks. As soon as a recon goes pending or flagged, it'll show up here." },
    snoozed:   { title: "No snoozed tasks",  body: "Tasks you've snoozed appear here until their wake date." },
    completed: { title: "Nothing completed", body: "Done tasks land here as a record of work finished." },
    all:       { title: "No tasks yet",      body: "When recons need attention, they'll surface here automatically." },
  }
  const c = copy[tab]
  return (
    <div className="rounded-xl p-10 text-center"
      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <CheckSquare size={28} strokeWidth={1.6}
        className="mx-auto mb-3" style={{ color: "var(--text-muted)" }} />
      <p className="text-sm font-semibold text-theme mb-1">{c.title}</p>
      <p className="text-xs" style={{ color: "var(--text-muted)" }}>{c.body}</p>
    </div>
  )
}

// ── Manual task form ──────────────────────────────────────────────────────

function ManualTaskForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [subject, setSubject] = useState("")
  const [description, setDescription] = useState("")
  const [priority, setPriority] = useState("normal")
  const [periodEnd, setPeriodEnd] = useState("")

  const createMut = useMutation({
    mutationFn: () => tasksApi.createManual({
      subject:     subject.trim(),
      description: description.trim() || null,
      priority,
      period_end:  periodEnd || null,
    }),
    onSuccess: onCreated,
  })

  return (
    <div className="rounded-xl p-4 space-y-3"
      style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-theme">New task</h3>
        <button onClick={onClose} className="h-7 w-7 rounded-md flex items-center justify-center"
          style={{ color: "var(--text-muted)" }}>
          <X size={14} strokeWidth={1.8} />
        </button>
      </div>
      <label className="block">
        <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
          Subject
        </span>
        <input type="text" value={subject} onChange={(e) => setSubject(e.target.value)}
          placeholder="e.g. Email client for September bank statement"
          className="w-full rounded-lg px-3 py-2 mt-1 text-sm outline-none"
          style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }}
        />
      </label>
      <label className="block">
        <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
          Description (optional)
        </span>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)}
          rows={2}
          className="w-full rounded-lg px-3 py-2 mt-1 text-sm outline-none resize-none"
          style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }}
        />
      </label>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
            Priority
          </span>
          <select value={priority} onChange={(e) => setPriority(e.target.value)}
            className="w-full rounded-lg px-3 py-2 mt-1 text-sm outline-none"
            style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }}>
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </select>
        </label>
        <label className="block">
          <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
            Period (optional)
          </span>
          <input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)}
            className="w-full rounded-lg px-3 py-2 mt-1 text-sm outline-none"
            style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }}
          />
        </label>
      </div>
      {createMut.error ? (
        <p className="text-xs" style={{ color: "#b91c1c" }}>
          {((createMut.error as { message?: string })?.message) ?? "Couldn't create the task."}
        </p>
      ) : null}
      <div className="flex items-center justify-end gap-2 pt-1">
        <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button size="sm" loading={createMut.isPending} disabled={!subject.trim()}
          onClick={() => createMut.mutate()}>Create task</Button>
      </div>
    </div>
  )
}

