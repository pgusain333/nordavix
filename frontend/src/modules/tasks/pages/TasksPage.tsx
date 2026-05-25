/**
 * TasksPage — month-end close worklist (v2).
 *
 * One row per balance-sheet account synced from QBO, per open period
 * (so users see every account that needs reconciliation, not just
 * the ones they've touched). Plus one row per flux analysis. Plus
 * any manual tasks the user added.
 *
 * Columns: Task name · Period · Status · Preparer · Reviewer · Due ·
 * Completed · Actions. User names resolved via the workspace lookup
 * hook (audit-feed-style "Jane (3d ago)" labels).
 *
 * Top toolbar:
 *   - Status tabs: Open / Snoozed / Completed / All
 *   - Period filter dropdown
 *   - Source filter (recon / flux / manual)
 *   - Search box (subject contains)
 *   - "New task" CTA
 *
 * Per-row actions live in a dropdown caret on the right: snooze
 * presets, dismiss, manually complete, deep-link out.
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
  Search,
  ExternalLink,
  StickyNote,
} from "lucide-react"
import { Button, Spinner } from "@/core/ui/components"
import { tasksApi, type Task, type TaskSeverity, type TaskSourceType } from "@/modules/tasks/api"
import { useUserNames } from "@/modules/workspace/hooks"

type FilterTab    = "open" | "snoozed" | "completed" | "all"
type SourceFilter = "all" | TaskSourceType

// ── Helpers ────────────────────────────────────────────────────────────────

function severityMeta(s: TaskSeverity) {
  if (s === "critical")
    return { fg: "#b91c1c", bg: "#fef2f2", Icon: AlertCircle, label: "Critical" }
  if (s === "warn")
    return { fg: "#92400e", bg: "#fef3c7", Icon: AlertTriangle, label: "High" }
  return     { fg: "var(--text-2)", bg: "var(--surface-2)", Icon: CheckSquare, label: "Normal" }
}

function statusMeta(s: Task["status"]) {
  const map = {
    pending:  { label: "Pending",  fg: "var(--text-muted)", bg: "var(--surface-2)" },
    reviewed: { label: "Prepared", fg: "#1d4ed8",           bg: "#dbeafe"          },
    approved: { label: "Approved", fg: "var(--green)",      bg: "var(--green-subtle)" },
    flagged:  { label: "Flagged",  fg: "#b91c1c",           bg: "#fee2e2"          },
    manual:   { label: "Manual",   fg: "#a855f7",           bg: "rgba(168, 85, 247, 0.15)" },
  } as const
  return map[s] ?? map.pending
}

function sourceMeta(s: TaskSourceType) {
  if (s === "recon_account")
    return { label: "Recon", fg: "var(--green)", bg: "var(--green-subtle)" }
  if (s === "flux")
    return { label: "Flux", fg: "#1d4ed8",  bg: "#dbeafe" }
  return     { label: "Manual",fg: "#a855f7", bg: "rgba(168, 85, 247, 0.15)" }
}

function isSnoozed(t: Task): boolean {
  if (!t.snooze_until) return false
  try { return new Date(t.snooze_until + "T00:00:00") > new Date() } catch { return false }
}
function isCompleted(t: Task): boolean {
  return !!t.completed_at || t.status === "approved"
}
function isOpen(t: Task): boolean {
  return !isCompleted(t) && !t.dismissed_at && !isSnoozed(t)
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—"
  try {
    return new Date(iso + (iso.includes("T") ? "" : "T00:00:00"))
      .toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
  } catch { return iso }
}
function fmtRelDate(iso: string | null | undefined): string {
  if (!iso) return ""
  try {
    const d = new Date(iso + (iso.includes("T") ? "" : "T00:00:00")).getTime()
    const s = Math.floor((Date.now() - d) / 1000)
    if (Math.abs(s) < 60) return "now"
    if (s < 0) {
      const a = Math.abs(s)
      if (a < 3600) return `in ${Math.floor(a / 60)}m`
      if (a < 86400) return `in ${Math.floor(a / 3600)}h`
      return `in ${Math.floor(a / 86400)}d`
    }
    if (s < 3600) return `${Math.floor(s / 60)}m ago`
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`
    return `${Math.floor(s / 86400)}d ago`
  } catch { return "" }
}

// ── Component ──────────────────────────────────────────────────────────────

export function TasksPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [tab,         setTab]         = useState<FilterTab>("open")
  const [sourceFilter,setSourceFilter]= useState<SourceFilter>("all")
  const [periodFilter,setPeriodFilter]= useState<string>("all")
  const [search,      setSearch]      = useState("")
  const [showManualForm, setShowManualForm] = useState(false)
  const [expandedKey, setExpandedKey] = useState<string | null>(null)

  const { data: tasks = [], isLoading } = useQuery({
    queryKey: ["tasks", "all"],
    queryFn:  () => tasksApi.list(true),
    staleTime: 30_000,
  })

  // Resolve every preparer / reviewer / assignee UUID to display names.
  const userIds = useMemo(() => {
    const s = new Set<string>()
    for (const t of tasks) {
      if (t.prepared_by) s.add(t.prepared_by)
      if (t.approved_by) s.add(t.approved_by)
      if (t.assignee_id) s.add(t.assignee_id)
      if (t.created_by)  s.add(t.created_by)
    }
    return Array.from(s)
  }, [tasks])
  const userNames = useUserNames(userIds)

  // Distinct periods present (for the period dropdown)
  const periodOptions = useMemo(() => {
    const set = new Set<string>()
    for (const t of tasks) if (t.period_end) set.add(t.period_end)
    return Array.from(set).sort().reverse()
  }, [tasks])

  // Tab counts
  const counts = useMemo(() => {
    let open = 0, snoozed = 0, completed = 0
    for (const t of tasks) {
      if (isCompleted(t)) completed++
      else if (isSnoozed(t)) snoozed++
      else if (!t.dismissed_at) open++
    }
    return { open, snoozed, completed, all: tasks.length }
  }, [tasks])

  // Applied filters
  const filtered = useMemo(() => {
    let list = tasks
    if (tab === "open")        list = list.filter(isOpen)
    else if (tab === "snoozed")   list = list.filter((t) => isSnoozed(t) && !isCompleted(t) && !t.dismissed_at)
    else if (tab === "completed") list = list.filter(isCompleted)
    // 'all' = no tab filter

    if (sourceFilter !== "all") list = list.filter((t) => t.source_type === sourceFilter)
    if (periodFilter !== "all") list = list.filter((t) => t.period_end === periodFilter)
    const q = search.trim().toLowerCase()
    if (q) list = list.filter((t) => t.subject.toLowerCase().includes(q))
    return list
  }, [tasks, tab, sourceFilter, periodFilter, search])

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
              One task per synced GL account + per flux analysis. Status, preparer,
              and reviewer reflect the underlying workflow in real time.
            </p>
          </div>
          <Button size="sm" icon={<Plus size={12} strokeWidth={1.8} />}
            onClick={() => setShowManualForm(true)}>
            New task
          </Button>
        </div>
      </motion.div>

      <div className="flex-1 px-4 sm:px-8 py-5 max-w-[1400px] w-full mx-auto space-y-4">

        {/* Toolbar: tabs + filters */}
        <div className="flex items-center gap-3 flex-wrap">
          {/* Status tabs */}
          <div className="flex items-center gap-1 flex-wrap rounded-lg p-1"
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

          {/* Source filter */}
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value as SourceFilter)}
            className="rounded-lg px-3 py-1.5 text-sm outline-none"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }}>
            <option value="all">All sources</option>
            <option value="recon_account">Reconciliations</option>
            <option value="flux">Flux analyses</option>
            <option value="manual">Manual</option>
          </select>

          {/* Period filter */}
          <select
            value={periodFilter}
            onChange={(e) => setPeriodFilter(e.target.value)}
            className="rounded-lg px-3 py-1.5 text-sm outline-none"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }}>
            <option value="all">All periods</option>
            {periodOptions.map((p) => (
              <option key={p} value={p}>{fmtDate(p)}</option>
            ))}
          </select>

          {/* Search */}
          <div className="relative flex-1 min-w-[180px] max-w-md">
            <Search size={14} strokeWidth={1.8}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
              style={{ color: "var(--text-muted)" }} />
            <input type="text" value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Search task name…"
              className="w-full rounded-lg pl-8 pr-3 py-1.5 text-sm outline-none"
              style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }}
            />
          </div>
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

        {/* Table */}
        {isLoading ? (
          <div className="py-16 flex items-center justify-center"><Spinner /></div>
        ) : filtered.length === 0 ? (
          <EmptyState tab={tab} />
        ) : (
          <div className="rounded-xl overflow-hidden"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[1000px]">
                <thead>
                  <tr style={{ background: "var(--surface-2)", borderBottom: "1px solid var(--border)" }}>
                    {[
                      { label: "Task",     w: "auto" },
                      { label: "Period",   w: "100px" },
                      { label: "Status",   w: "110px" },
                      { label: "Preparer", w: "150px" },
                      { label: "Reviewer", w: "150px" },
                      { label: "Due",      w: "110px" },
                      { label: "Completed",w: "120px" },
                      { label: "",         w: "100px" },
                    ].map((h) => (
                      <th key={h.label}
                        className="text-left text-[10px] font-semibold uppercase tracking-wide px-3 py-2.5"
                        style={{ color: "var(--text-muted)", width: h.w }}>
                        {h.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((t) => (
                    <TaskRow key={t.key} task={t}
                      userNames={userNames}
                      expanded={expandedKey === t.key}
                      onToggleExpand={() => setExpandedKey(expandedKey === t.key ? null : t.key)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-4 py-2 text-[10px] flex items-center justify-between"
              style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}>
              <span>{filtered.length} of {tasks.length} task{tasks.length === 1 ? "" : "s"}</span>
              <span>
                Due dates default to 15 days after period-end. Tasks auto-update as
                underlying work progresses.
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── TaskRow ────────────────────────────────────────────────────────────────

function TaskRow({ task, userNames, expanded, onToggleExpand }: {
  task: Task
  userNames: Record<string, string>
  expanded: boolean
  onToggleExpand: () => void
}) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const sev = severityMeta(task.severity)
  const stat = statusMeta(task.status)
  const src = sourceMeta(task.source_type)
  const SeverityIcon = sev.Icon
  const overdue = task.due_date && !isCompleted(task) && new Date(task.due_date) < new Date(new Date().toDateString())
  const snoozed = isSnoozed(task)
  const completed = isCompleted(task)
  const dismissed = !!task.dismissed_at

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

  const preparerName = task.prepared_by ? (userNames[task.prepared_by] ?? "Someone") : null
  const reviewerName = task.approved_by ? (userNames[task.approved_by] ?? "Someone") : null

  // Pick the most relevant "completed" timestamp: the manual complete
  // overrides everything; otherwise approved_at (the reviewer's stamp).
  const completedAt = task.completed_at ?? task.approved_at

  const rowBg = completed
    ? "rgba(16, 185, 129, 0.04)"
    : dismissed
      ? "var(--surface-2)"
      : undefined

  return (
    <>
      <tr style={{ borderBottom: "1px solid var(--border)", background: rowBg,
                   opacity: dismissed ? 0.5 : 1 }}>
        {/* Task */}
        <td className="px-3 py-3">
          <div className="flex items-start gap-2">
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-full shrink-0 mt-0.5"
              style={{ background: sev.bg, color: sev.fg }}>
              <SeverityIcon size={11} strokeWidth={2} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium text-theme"
                  style={{ textDecoration: completed ? "line-through" : "none" }}>
                  {task.subject}
                </span>
                <span className="text-[9px] font-bold uppercase tracking-wide rounded px-1 py-0.5"
                  style={{ background: src.bg, color: src.fg }}>
                  {src.label}
                </span>
                {snoozed && (
                  <span className="text-[9px] inline-flex items-center gap-0.5"
                    style={{ color: "var(--text-muted)" }}>
                    <Clock size={9} strokeWidth={2} /> snoozed
                  </span>
                )}
              </div>
              {task.notes && (
                <p className="text-[11px] mt-1 italic inline-flex items-center gap-1"
                  style={{ color: "var(--text-2)" }}>
                  <StickyNote size={9} strokeWidth={1.8} />
                  {task.notes}
                </p>
              )}
            </div>
          </div>
        </td>

        {/* Period */}
        <td className="px-3 py-3 text-xs" style={{ color: "var(--text-2)" }}>
          {task.period_end
            ? new Date(task.period_end + "T00:00:00").toLocaleDateString(undefined, { month: "short", year: "numeric" })
            : "—"}
        </td>

        {/* Status */}
        <td className="px-3 py-3">
          <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold"
            style={{ background: stat.bg, color: stat.fg }}>
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: stat.fg }} />
            {stat.label}
          </span>
        </td>

        {/* Preparer */}
        <td className="px-3 py-3 text-xs" style={{ color: "var(--text-2)" }}>
          {preparerName ? (
            <>
              <p className="text-theme truncate">{preparerName}</p>
              <p className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                {fmtRelDate(task.prepared_at)}
              </p>
            </>
          ) : "—"}
        </td>

        {/* Reviewer */}
        <td className="px-3 py-3 text-xs" style={{ color: "var(--text-2)" }}>
          {reviewerName ? (
            <>
              <p className="text-theme truncate">{reviewerName}</p>
              <p className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                {fmtRelDate(task.approved_at)}
              </p>
            </>
          ) : "—"}
        </td>

        {/* Due */}
        <td className="px-3 py-3 text-xs">
          {task.due_date ? (
            <>
              <p style={{ color: overdue ? "#dc2626" : "var(--text-2)" }}>
                {fmtDate(task.due_date)}
              </p>
              {overdue && (
                <p className="text-[10px] font-semibold" style={{ color: "#dc2626" }}>
                  overdue
                </p>
              )}
            </>
          ) : "—"}
        </td>

        {/* Completed */}
        <td className="px-3 py-3 text-xs" style={{ color: "var(--text-2)" }}>
          {completedAt ? (
            <>
              <p className="text-theme">{fmtDate(completedAt)}</p>
              <p className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                {fmtRelDate(completedAt)}
              </p>
            </>
          ) : "—"}
        </td>

        {/* Actions */}
        <td className="px-3 py-3">
          <div className="flex items-center justify-end gap-1">
            {task.deep_link && !completed && !dismissed && (
              <Button size="sm" variant="outline"
                icon={<ExternalLink size={11} strokeWidth={1.8} />}
                onClick={() => navigate(task.deep_link!)}>
                <span className="hidden md:inline">Open</span>
              </Button>
            )}
            <button onClick={onToggleExpand}
              className="h-7 w-7 rounded-md flex items-center justify-center transition-colors hover:bg-[var(--surface-2)]"
              style={{ color: "var(--text-muted)" }}
              title={expanded ? "Hide actions" : "More actions"}>
              <ChevronDown size={14} strokeWidth={2}
                className="transition-transform"
                style={{ transform: expanded ? "rotate(180deg)" : "rotate(0deg)" }} />
            </button>
          </div>
        </td>
      </tr>

      {/* Expanded row: per-task action drawer */}
      <AnimatePresence initial={false}>
        {expanded && (
          <tr>
            <td colSpan={8} className="p-0">
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.18 }}
                style={{ overflow: "hidden" }}>
                <div className="px-4 py-3 flex items-center gap-2 flex-wrap"
                  style={{ background: "var(--surface-2)", borderBottom: "1px solid var(--border)" }}>
                  <span className="text-[10px] font-semibold uppercase tracking-wide"
                    style={{ color: "var(--text-muted)" }}>
                    Actions:
                  </span>
                  {!completed && !dismissed && (
                    <>
                      {snoozed ? (
                        <Button size="sm" variant="outline" onClick={clearSnooze}
                          loading={actionMut.isPending}>Wake now</Button>
                      ) : (
                        <>
                          <Button size="sm" variant="outline" onClick={() => setSnooze(1)}
                            loading={actionMut.isPending}>
                            <Clock size={11} strokeWidth={1.8} className="inline mr-1" />
                            Snooze 1d
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => setSnooze(3)}
                            loading={actionMut.isPending}>3d</Button>
                          <Button size="sm" variant="outline" onClick={() => setSnooze(7)}
                            loading={actionMut.isPending}>1w</Button>
                        </>
                      )}
                      <div className="mx-1 h-4 w-px" style={{ background: "var(--border)" }} />
                      {task.action_id && (
                        <Button size="sm" variant="outline"
                          icon={<CheckCircle2 size={11} strokeWidth={1.8} />}
                          loading={completeMut.isPending}
                          onClick={() => completeMut.mutate()}
                          style={{ borderColor: "var(--green)", color: "var(--green)" }}>
                          Mark done
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={dismiss}
                        loading={actionMut.isPending}>
                        <X size={11} strokeWidth={1.8} /> Dismiss
                      </Button>
                    </>
                  )}
                  {(completed || dismissed) && (
                    <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                      {completed ? "Task is completed." : "Task is dismissed."}
                      {" "}Re-open by syncing the underlying source.
                    </span>
                  )}
                </div>
              </motion.div>
            </td>
          </tr>
        )}
      </AnimatePresence>
    </>
  )
}

// ── Empty state ────────────────────────────────────────────────────────────

function EmptyState({ tab }: { tab: FilterTab }) {
  const copy: Record<FilterTab, { title: string; body: string }> = {
    open:      { title: "Nothing to do",     body: "No open tasks for the current filters. Try widening the filters or check the Completed tab." },
    snoozed:   { title: "No snoozed tasks",  body: "Tasks you've snoozed will appear here until their wake date." },
    completed: { title: "Nothing completed", body: "Tasks finish here as a record of work done." },
    all:       { title: "No tasks",          body: "Sync QuickBooks accounts and they'll show up as reconciliation tasks." },
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

// Unused import shim — we may add an ArrowRight icon on a future row hover state.
void ArrowRight
