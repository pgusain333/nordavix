/**
 * TasksPage v3 — month-end close worklist with admin assignments + bulk ops.
 *
 * Major features over v2:
 *   • Cascading Year → Period filters (year defaults to current).
 *   • Bulk-select checkboxes per row + sticky header checkbox.
 *   • Bulk action toolbar (admin assign preparer/reviewer, set due,
 *     mark done, dismiss) — appears only when rows are selected.
 *   • Excel-style column header popovers: Status / Source / Preparer /
 *     Reviewer columns can be filtered down via checkboxes.
 *   • Inline admin editors: click a Preparer / Reviewer / Due cell as
 *     an admin to assign or override the auto-default.
 *   • Snooze removed — was unused workflow noise.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { motion, AnimatePresence } from "framer-motion"
import { formatDate } from "@/core/lib/dates"
import {
  CheckSquare,
  AlertTriangle,
  AlertCircle,
  ArrowLeft,
  ChevronDown,
  X,
  CheckCircle2,
  Plus,
  Search,
  ExternalLink,
  StickyNote,
  Filter,
  Pencil,
  Calendar,
} from "lucide-react"
import { Button, Spinner } from "@/core/ui/components"
import { DatePicker } from "@/core/ui/DatePicker"
import { tasksApi, type Task, type TaskSeverity, type TaskSourceType } from "@/modules/tasks/api"
import { useUserNames } from "@/modules/workspace/hooks"
import { workspaceApi } from "@/modules/workspace/api"

type FilterTab    = "open" | "completed" | "all"

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

function isCompleted(t: Task): boolean {
  return !!t.completed_at || t.status === "approved"
}
function isOpen(t: Task): boolean {
  return !isCompleted(t) && !t.dismissed_at
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—"
  try {
    return formatDate(iso)
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
  const [yearFilter,  setYearFilter]  = useState<string>(String(new Date().getFullYear()))
  const [periodFilter,setPeriodFilter]= useState<string>("all")
  const [search,      setSearch]      = useState("")
  const [showManualForm, setShowManualForm] = useState(false)
  // Column-header popover filters (multi-select per column)
  const [colFilters, setColFilters] = useState<Record<string, Set<string>>>({})
  // Bulk selection — task keys
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const { data: tasks = [], isLoading } = useQuery({
    queryKey: ["tasks", "all"],
    queryFn:  () => tasksApi.list(true),
    staleTime: 30_000,
  })

  // Workspace members (for assign dropdowns) + current user (for admin gate)
  const { data: members = [] } = useQuery({
    queryKey: ["workspace-members"],
    queryFn:  workspaceApi.listMembers,
    staleTime: 5 * 60_000,
  })
  const { data: me } = useQuery({
    queryKey: ["workspace-me"],
    queryFn:  workspaceApi.getMe,
    staleTime: 5 * 60_000,
  })
  const isAdmin = me?.role === "admin"

  // Resolve every preparer / reviewer / assignee UUID to display names.
  const userIds = useMemo(() => {
    const s = new Set<string>()
    for (const t of tasks) {
      if (t.prepared_by) s.add(t.prepared_by)
      if (t.approved_by) s.add(t.approved_by)
      if (t.assigned_preparer_id) s.add(t.assigned_preparer_id)
      if (t.assigned_reviewer_id) s.add(t.assigned_reviewer_id)
    }
    return Array.from(s)
  }, [tasks])
  const userNames = useUserNames(userIds)

  // All distinct years + periods present (drives the cascading filters)
  const yearOptions = useMemo(() => {
    const s = new Set<string>()
    for (const t of tasks) if (t.period_end) s.add(t.period_end.slice(0, 4))
    const arr = Array.from(s).sort().reverse()
    // Ensure the current year is always pickable, even if no tasks for it yet.
    const cur = String(new Date().getFullYear())
    if (!arr.includes(cur)) arr.unshift(cur)
    return arr
  }, [tasks])
  const periodOptions = useMemo(() => {
    const s = new Set<string>()
    for (const t of tasks) {
      if (!t.period_end) continue
      if (yearFilter !== "all" && t.period_end.slice(0, 4) !== yearFilter) continue
      s.add(t.period_end)
    }
    return Array.from(s).sort().reverse()
  }, [tasks, yearFilter])

  // If the current period filter falls outside the new year, reset it
  useEffect(() => {
    if (periodFilter === "all") return
    if (periodFilter.slice(0, 4) !== yearFilter && yearFilter !== "all") {
      setPeriodFilter("all")
    }
  }, [yearFilter, periodFilter])

  // Tab counts
  const counts = useMemo(() => {
    let open = 0, completed = 0
    for (const t of tasks) {
      if (isCompleted(t)) completed++
      else if (!t.dismissed_at) open++
    }
    return { open, completed, all: tasks.length }
  }, [tasks])

  // Apply all filters
  const filtered = useMemo(() => {
    let list = tasks
    if (tab === "open")        list = list.filter(isOpen)
    else if (tab === "completed") list = list.filter(isCompleted)

    if (yearFilter !== "all")  list = list.filter((t) => t.period_end?.slice(0, 4) === yearFilter)
    if (periodFilter !== "all")list = list.filter((t) => t.period_end === periodFilter)

    const q = search.trim().toLowerCase()
    if (q) list = list.filter((t) => t.subject.toLowerCase().includes(q))

    // Column header filters
    for (const [col, vals] of Object.entries(colFilters)) {
      if (!vals.size) continue
      list = list.filter((t) => {
        if (col === "status")    return vals.has(t.status)
        if (col === "source")    return vals.has(t.source_type)
        if (col === "preparer")  return vals.has(t.prepared_by ?? "")
            || (vals.has("(assigned)") && t.assigned_preparer_id)
        if (col === "reviewer")  return vals.has(t.approved_by ?? "")
            || (vals.has("(assigned)") && t.assigned_reviewer_id)
        return true
      })
    }
    return list
  }, [tasks, tab, yearFilter, periodFilter, search, colFilters])

  // Selection helpers
  const allFilteredKeys = useMemo(() => filtered.map((t) => t.key), [filtered])
  const isAllSelected = allFilteredKeys.length > 0
    && allFilteredKeys.every((k) => selected.has(k))
  const isSomeSelected = allFilteredKeys.some((k) => selected.has(k))
  function toggleAll() {
    if (isAllSelected) setSelected(new Set())
    else setSelected(new Set(allFilteredKeys))
  }
  function toggleOne(key: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  const bulkMut = useMutation({
    mutationFn: (body: Parameters<typeof tasksApi.bulkAction>[0]) => tasksApi.bulkAction(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tasks"] })
      setSelected(new Set())
    },
  })

  // Build the bulk targets payload from current selection
  function selectedTargets() {
    const byKey = new Map(tasks.map((t) => [t.key, t]))
    const out: { source_type: TaskSourceType; source_id: string | null; period_end: string | null }[] = []
    for (const k of selected) {
      const t = byKey.get(k); if (!t) continue
      out.push({
        source_type: t.source_type,
        // For manual, the backend expects source_id = action_id.
        source_id:   t.source_type === "manual" ? t.action_id : t.source_id,
        period_end:  t.period_end,
      })
    }
    return out
  }

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
              Close Tasks
            </h1>
            <p className="text-xs sm:text-sm mt-1.5" style={{ color: "var(--text-muted)" }}>
              One row per synced GL account + per flux analysis.
              {isAdmin && " Click a Preparer / Reviewer / Due cell to assign or override the default."}
            </p>
          </div>
          <Button size="sm" icon={<Plus size={12} strokeWidth={1.8} />}
            onClick={() => setShowManualForm(true)}>
            New task
          </Button>
        </div>
      </motion.div>

      <div className="flex-1 px-4 sm:px-8 py-5 max-w-[1500px] w-full mx-auto space-y-4">

        {/* Toolbar */}
        <div className="flex items-center gap-3 flex-wrap">
          {/* Status tabs */}
          <div className="flex items-center gap-1 flex-wrap rounded-lg p-1"
            style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
            {([
              { key: "open",      label: "Open",      count: counts.open      },
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

          {/* Year filter (cascades to Period) */}
          <select value={yearFilter} onChange={(e) => setYearFilter(e.target.value)}
            className="rounded-lg px-3 py-1.5 text-sm outline-none"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }}
            title="Filter by year — period choices below cascade from this">
            <option value="all">All years</option>
            {yearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>

          {/* Period filter */}
          <select value={periodFilter} onChange={(e) => setPeriodFilter(e.target.value)}
            className="rounded-lg px-3 py-1.5 text-sm outline-none"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }}>
            <option value="all">{yearFilter === "all" ? "All periods" : `All of ${yearFilter}`}</option>
            {periodOptions.map((p) => (
              <option key={p} value={p}>
                {new Date(p + "T00:00:00").toLocaleDateString(undefined, { month: "short", year: "numeric" })}
              </option>
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
              <ManualTaskForm
                isAdmin={isAdmin}
                members={members}
                onClose={() => setShowManualForm(false)}
                onCreated={() => {
                  setShowManualForm(false)
                  qc.invalidateQueries({ queryKey: ["tasks"] })
                }}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Bulk action toolbar */}
        <AnimatePresence>
          {selected.size > 0 && (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.15 }}
              className="rounded-xl p-3 flex items-center gap-2 flex-wrap"
              style={{ background: "var(--green-subtle)", border: "1px solid var(--green)" }}>
              <span className="text-[11px] font-semibold" style={{ color: "var(--green)" }}>
                {selected.size} selected
              </span>
              {isAdmin && (
                <>
                  <AssignDropdown
                    label="Assign preparer"
                    members={members}
                    onPick={(uid) => bulkMut.mutate({
                      targets: selectedTargets(),
                      assigned_preparer_id: uid,
                    })}
                  />
                  <AssignDropdown
                    label="Assign reviewer"
                    members={members}
                    onPick={(uid) => bulkMut.mutate({
                      targets: selectedTargets(),
                      assigned_reviewer_id: uid,
                    })}
                  />
                  <DueDatePopover
                    label="Set due date"
                    onPick={(iso) => bulkMut.mutate({
                      targets: selectedTargets(),
                      due_date: iso,
                    })}
                  />
                </>
              )}
              <Button size="sm" variant="outline"
                icon={<CheckCircle2 size={11} strokeWidth={1.8} />}
                loading={bulkMut.isPending}
                onClick={() => bulkMut.mutate({ targets: selectedTargets(), completed: true })}
                style={{ borderColor: "var(--green)", color: "var(--green)" }}>
                Mark done
              </Button>
              <Button size="sm" variant="ghost"
                loading={bulkMut.isPending}
                onClick={() => bulkMut.mutate({ targets: selectedTargets(), dismissed: true })}>
                <X size={11} strokeWidth={1.8} /> Dismiss
              </Button>
              <button onClick={() => setSelected(new Set())}
                className="ml-auto text-[11px] font-medium hover:underline"
                style={{ color: "var(--text-muted)" }}>
                Clear selection
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Table */}
        {isLoading ? (
          <div className="py-16 flex items-center justify-center"><Spinner /></div>
        ) : filtered.length === 0 ? (
          <EmptyState
            tab={tab}
            statusFilter={colFilters.status ?? new Set()}
            onSwitchTab={(t) => setTab(t)}
            onClearStatusFilter={() => setColFilters({ ...colFilters, status: new Set() })}
          />
        ) : (
          <div className="rounded-xl overflow-hidden"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[1100px]">
                <thead>
                  <tr style={{ background: "var(--surface-2)", borderBottom: "1px solid var(--border)" }}>
                    <th className="px-3 py-2.5 text-center" style={{ width: 32 }}>
                      <input type="checkbox"
                        checked={isAllSelected}
                        ref={(el) => { if (el) el.indeterminate = isSomeSelected && !isAllSelected }}
                        onChange={toggleAll}
                        aria-label="Select all visible" />
                    </th>
                    <Th label="Task" />
                    <Th label="Period" />
                    <Th label="Source"
                      filter={
                        <ColumnHeaderFilter
                          values={["recon_account", "flux", "manual"]}
                          labels={{ recon_account: "Reconciliation", flux: "Flux analysis", manual: "Manual" }}
                          selected={colFilters.source ?? new Set()}
                          onChange={(s) => setColFilters({ ...colFilters, source: s })}
                        />
                      } />
                    <Th label="Status"
                      filter={
                        <ColumnHeaderFilter
                          values={["pending", "reviewed", "approved", "flagged", "manual"]}
                          labels={{ pending: "Pending", reviewed: "Prepared", approved: "Approved", flagged: "Flagged", manual: "Manual" }}
                          selected={colFilters.status ?? new Set()}
                          onChange={(s) => {
                            setColFilters({ ...colFilters, status: s })
                            // Auto-resolve tab/filter conflicts so the user
                            // never sees an empty result for a status they
                            // explicitly picked. Logic:
                            //   - Open tab + only 'approved'   → Completed
                            //   - Open tab + 'approved' + others → All
                            //   - Completed + no 'approved'     → Open
                            //   - Completed + 'approved' + others → All
                            //   - 'manual' is bucket-neutral (compatible with both)
                            //   - clearing the filter restores nothing
                            if (s.size === 0 || tab === "all") return
                            const hasApproved = s.has("approved")
                            const hasOpenish  = [...s].some((v) => v !== "approved" && v !== "manual")
                            if (tab === "open" && hasApproved) {
                              setTab(hasOpenish ? "all" : "completed")
                            } else if (tab === "completed" && hasOpenish) {
                              setTab(hasApproved ? "all" : "open")
                            }
                          }}
                        />
                      } />
                    <Th label="Preparer"
                      filter={
                        <UserColumnFilter
                          allowAssigned
                          tasksField="prepared_by"
                          tasks={tasks}
                          userNames={userNames}
                          selected={colFilters.preparer ?? new Set()}
                          onChange={(s) => setColFilters({ ...colFilters, preparer: s })}
                        />
                      } />
                    <Th label="Reviewer"
                      filter={
                        <UserColumnFilter
                          allowAssigned
                          tasksField="approved_by"
                          tasks={tasks}
                          userNames={userNames}
                          selected={colFilters.reviewer ?? new Set()}
                          onChange={(s) => setColFilters({ ...colFilters, reviewer: s })}
                        />
                      } />
                    <Th label="Due" />
                    <Th label="Completed" />
                    <Th label="" />
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((t) => (
                    <TaskRow
                      key={t.key}
                      task={t}
                      userNames={userNames}
                      members={members}
                      isAdmin={isAdmin}
                      checked={selected.has(t.key)}
                      onToggleCheck={() => toggleOne(t.key)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-4 py-2 text-[10px] flex items-center justify-between"
              style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}>
              <span>{filtered.length} of {tasks.length} task{tasks.length === 1 ? "" : "s"}</span>
              <span>
                Due defaults to 15 days after period-end. Admins can override per-task or in bulk.
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Th — column header cell with optional inline filter popover ───────────

function Th({ label, filter }: { label: string; filter?: React.ReactNode }) {
  return (
    <th className="text-left text-[10px] font-semibold uppercase tracking-wide px-3 py-2.5 whitespace-nowrap"
      style={{ color: "var(--text-muted)" }}>
      <span className="inline-flex items-center gap-1.5">
        {label}
        {filter}
      </span>
    </th>
  )
}

// ── ColumnHeaderFilter — static checkbox list (Status, Source) ─────────────

function ColumnHeaderFilter({ values, labels, selected, onChange }:
  { values: string[]; labels: Record<string, string>; selected: Set<string>; onChange: (s: Set<string>) => void }
) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onClick)
    return () => document.removeEventListener("mousedown", onClick)
  }, [open])

  const active = selected.size > 0
  return (
    <div ref={ref} className="relative inline-block">
      <button onClick={(e) => { e.stopPropagation(); setOpen(!open) }}
        className="h-4 w-4 inline-flex items-center justify-center rounded transition-colors hover:bg-[var(--border)]"
        style={{ color: active ? "var(--green)" : "var(--text-muted)" }}
        title={active ? `${selected.size} active filter${selected.size === 1 ? "" : "s"}` : "Filter"}>
        <Filter size={11} strokeWidth={active ? 2.5 : 1.8} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.96 }}
            animate={{ opacity: 1, y: 0,  scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.96 }}
            transition={{ duration: 0.12, ease: "easeOut" }}
            className="absolute top-full left-0 mt-1.5 z-10 rounded-lg py-1 min-w-[150px] origin-top-left"
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border-strong)",
              boxShadow: "0 6px 24px -8px rgba(0,0,0,0.25), 0 2px 6px -2px rgba(0,0,0,0.10)",
            }}>
            {values.map((v) => {
              const checked = selected.has(v)
              return (
                <label key={v}
                  className="flex items-center gap-2 px-2.5 py-1 text-[11px] cursor-pointer transition-colors hover:bg-[var(--surface-2)]"
                  style={{ color: "var(--text)" }}>
                  <input type="checkbox" checked={checked}
                    className="h-3 w-3 cursor-pointer"
                    onChange={() => {
                      const next = new Set(selected)
                      if (next.has(v)) next.delete(v); else next.add(v)
                      onChange(next)
                    }} />
                  <span className="normal-case truncate">{labels[v] ?? v}</span>
                </label>
              )
            })}
            {active && (
              <>
                <div className="mx-2 my-1 h-px" style={{ background: "var(--border)" }} />
                <button onClick={() => onChange(new Set())}
                  className="w-full text-[10px] text-left px-2.5 py-1 transition-colors hover:bg-[var(--surface-2)]"
                  style={{ color: "var(--text-muted)" }}>
                  Clear filter
                </button>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── UserColumnFilter — dynamic list of users present in the data ───────────

function UserColumnFilter({ tasks, tasksField, userNames, selected, onChange, allowAssigned }:
  { tasks: Task[]; tasksField: "prepared_by" | "approved_by"; userNames: Record<string, string>;
    selected: Set<string>; onChange: (s: Set<string>) => void; allowAssigned?: boolean }
) {
  const values = useMemo(() => {
    const s = new Set<string>()
    for (const t of tasks) {
      const v = t[tasksField] as string | null
      if (v) s.add(v)
    }
    return Array.from(s)
  }, [tasks, tasksField])
  const labels: Record<string, string> = useMemo(() => {
    const m: Record<string, string> = {}
    for (const v of values) m[v] = userNames[v] ?? "Someone"
    if (allowAssigned) m["(assigned)"] = "— Assigned, not yet acted"
    return m
  }, [values, userNames, allowAssigned])
  const allValues = allowAssigned ? ["(assigned)", ...values] : values
  return (
    <ColumnHeaderFilter
      values={allValues}
      labels={labels}
      selected={selected}
      onChange={onChange}
    />
  )
}

// ── AssignDropdown ─────────────────────────────────────────────────────────

function AssignDropdown({ label, members, onPick, current }:
  { label: string; members: { id: string | null; display_name: string; role: string }[];
    onPick: (uid: string | null) => void; current?: string | null }
) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    function h(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener("mousedown", h)
    return () => document.removeEventListener("mousedown", h)
  }, [open])
  return (
    <div ref={ref} className="relative inline-block">
      <Button size="sm" variant="outline" onClick={() => setOpen(!open)}>
        {label}
        <ChevronDown size={11} strokeWidth={1.8}
          className="transition-transform"
          style={{ transform: open ? "rotate(180deg)" : "rotate(0)" }} />
      </Button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.96 }}
            animate={{ opacity: 1, y: 0,  scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.96 }}
            transition={{ duration: 0.12, ease: "easeOut" }}
            className="absolute top-full left-0 mt-1.5 z-20 rounded-lg py-1 min-w-[180px] max-h-[240px] overflow-y-auto origin-top-left"
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border-strong)",
              boxShadow: "0 6px 24px -8px rgba(0,0,0,0.25), 0 2px 6px -2px rgba(0,0,0,0.10)",
            }}>
            {members.length === 0 ? (
              <p className="px-3 py-1.5 text-[11px] italic" style={{ color: "var(--text-muted)" }}>No members</p>
            ) : (
              <>
                {members.filter((m) => m.id).map((m) => {
                  const isCurrent = current === m.id
                  return (
                    <button key={m.id!} onClick={() => { onPick(m.id); setOpen(false) }}
                      className="w-full text-left px-2.5 py-1 text-[11px] transition-colors hover:bg-[var(--surface-2)] flex items-center justify-between gap-2"
                      style={{ color: "var(--text)",
                                background: isCurrent ? "var(--surface-2)" : undefined,
                                fontWeight: isCurrent ? 600 : 400 }}>
                      <span className="truncate">{m.display_name}</span>
                      <span className="text-[9px] uppercase tracking-wide shrink-0"
                        style={{ color: "var(--text-muted)" }}>{m.role}</span>
                    </button>
                  )
                })}
                {current && (
                  <>
                    <div className="mx-2 my-1 h-px" style={{ background: "var(--border)" }} />
                    <button onClick={() => { onPick(null); setOpen(false) }}
                      className="w-full text-left px-2.5 py-1 text-[11px] transition-colors hover:bg-[var(--surface-2)]"
                      style={{ color: "#b91c1c" }}>
                      Clear assignment
                    </button>
                  </>
                )}
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── DueDatePopover ─────────────────────────────────────────────────────────

function DueDatePopover({ label, onPick, current }:
  { label: string; onPick: (iso: string | null) => void; current?: string | null }
) {
  const [open, setOpen] = useState(false)
  const [val, setVal] = useState(current ?? "")
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    function h(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener("mousedown", h)
    return () => document.removeEventListener("mousedown", h)
  }, [open])
  return (
    <div ref={ref} className="relative inline-block">
      <Button size="sm" variant="outline" onClick={() => setOpen(!open)}
        icon={<Calendar size={11} strokeWidth={1.8} />}>
        {label}
      </Button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.96 }}
            animate={{ opacity: 1, y: 0,  scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.96 }}
            transition={{ duration: 0.12, ease: "easeOut" }}
            className="absolute top-full left-0 mt-1.5 z-20 rounded-lg p-2.5 origin-top-left"
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border-strong)",
              boxShadow: "0 6px 24px -8px rgba(0,0,0,0.25), 0 2px 6px -2px rgba(0,0,0,0.10)",
            }}>
            <DatePicker value={val} onChange={setVal} compact className="block w-[160px]" />
            <div className="flex items-center gap-1.5 mt-2">
              <Button size="sm" onClick={() => { onPick(val || null); setOpen(false) }} disabled={!val}>
                Apply
              </Button>
              {current && (
                <Button size="sm" variant="ghost" onClick={() => { onPick(null); setOpen(false) }}>
                  Clear
                </Button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── TaskRow ────────────────────────────────────────────────────────────────

function TaskRow({ task, userNames, members, isAdmin, checked, onToggleCheck }: {
  task: Task
  userNames: Record<string, string>
  members: { id: string | null; display_name: string; role: string }[]
  isAdmin: boolean
  checked: boolean
  onToggleCheck: () => void
}) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const sev = severityMeta(task.severity)
  const stat = statusMeta(task.status)
  const src = sourceMeta(task.source_type)
  const SeverityIcon = sev.Icon
  const overdue = task.due_date && !isCompleted(task) && new Date(task.due_date) < new Date(new Date().toDateString())
  const completed = isCompleted(task)
  const dismissed = !!task.dismissed_at

  const actionMut = useMutation({
    mutationFn: (patch: Parameters<typeof tasksApi.upsertAction>[0]) => tasksApi.upsertAction(patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  })

  function assignPreparer(uid: string | null) {
    actionMut.mutate({
      source_type: task.source_type, source_id: task.source_id, period_end: task.period_end,
      assigned_preparer_id: uid ?? "",
    })
  }
  function assignReviewer(uid: string | null) {
    actionMut.mutate({
      source_type: task.source_type, source_id: task.source_id, period_end: task.period_end,
      assigned_reviewer_id: uid ?? "",
    })
  }
  function setDue(iso: string | null) {
    actionMut.mutate({
      source_type: task.source_type, source_id: task.source_id, period_end: task.period_end,
      due_date: iso ?? "",
    })
  }

  // Preparer cell logic: show actor when present, else assignment, else admin can assign
  const preparerActor    = task.prepared_by ? (userNames[task.prepared_by] ?? "Someone") : null
  const preparerAssigned = task.assigned_preparer_id ? (userNames[task.assigned_preparer_id] ?? "Someone") : null
  const reviewerActor    = task.approved_by ? (userNames[task.approved_by] ?? "Someone") : null
  const reviewerAssigned = task.assigned_reviewer_id ? (userNames[task.assigned_reviewer_id] ?? "Someone") : null
  const completedAt      = task.completed_at ?? task.approved_at

  const rowBg = completed
    ? "rgba(16, 185, 129, 0.04)"
    : dismissed ? "var(--surface-2)" : undefined

  return (
    <tr style={{
      borderBottom: "1px solid var(--border)",
      background: checked ? "var(--green-subtle)" : rowBg,
      opacity: dismissed ? 0.5 : 1,
    }}>
      <td className="px-3 py-3 text-center" onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" checked={checked} onChange={onToggleCheck} aria-label="Select task" />
      </td>

      {/* Task */}
      <td className="px-3 py-3">
        <div className="flex items-start gap-2">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full shrink-0 mt-0.5"
            style={{ background: sev.bg, color: sev.fg }}>
            <SeverityIcon size={11} strokeWidth={2} />
          </span>
          <div className="min-w-0 flex-1">
            <span className="text-sm font-medium text-theme"
              style={{ textDecoration: completed ? "line-through" : "none" }}>
              {task.subject}
            </span>
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

      <td className="px-3 py-3 text-xs" style={{ color: "var(--text-2)" }}>
        {task.period_end
          ? new Date(task.period_end + "T00:00:00").toLocaleDateString(undefined, { month: "short", year: "numeric" })
          : "—"}
      </td>

      <td className="px-3 py-3">
        <span className="text-[9px] font-bold uppercase tracking-wide rounded px-1.5 py-0.5"
          style={{ background: src.bg, color: src.fg }}>
          {src.label}
        </span>
      </td>

      <td className="px-3 py-3">
        <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold"
          style={{ background: stat.bg, color: stat.fg }}>
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: stat.fg }} />
          {stat.label}
        </span>
      </td>

      {/* Preparer */}
      <td className="px-3 py-3 text-xs">
        <PersonCell
          actorName={preparerActor}
          actorAt={task.prepared_at}
          assignedName={preparerAssigned}
          isAdmin={isAdmin}
          members={members}
          onAssign={assignPreparer}
          dropdownLabel="Set preparer"
          currentAssignedId={task.assigned_preparer_id}
        />
      </td>

      {/* Reviewer */}
      <td className="px-3 py-3 text-xs">
        <PersonCell
          actorName={reviewerActor}
          actorAt={task.approved_at}
          assignedName={reviewerAssigned}
          isAdmin={isAdmin}
          members={members}
          onAssign={assignReviewer}
          dropdownLabel="Set reviewer"
          currentAssignedId={task.assigned_reviewer_id}
        />
      </td>

      {/* Due */}
      <td className="px-3 py-3 text-xs">
        <DueCell
          dueDate={task.due_date}
          overridden={task.due_date_overridden}
          overdue={!!overdue}
          isAdmin={isAdmin}
          onSet={setDue}
        />
      </td>

      {/* Completed */}
      <td className="px-3 py-3 text-xs" style={{ color: "var(--text-2)" }}>
        {completedAt ? (
          <>
            <p className="text-theme">{fmtDate(completedAt)}</p>
            <p className="text-[10px]" style={{ color: "var(--text-muted)" }}>{fmtRelDate(completedAt)}</p>
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
        </div>
      </td>
    </tr>
  )
}

// ── PersonCell — renders preparer or reviewer with optional admin assign ──

function PersonCell({ actorName, actorAt, assignedName, isAdmin, members, onAssign, dropdownLabel, currentAssignedId }:
  { actorName: string | null; actorAt: string | null; assignedName: string | null;
    isAdmin: boolean; members: { id: string | null; display_name: string; role: string }[];
    onAssign: (uid: string | null) => void;
    dropdownLabel: string; currentAssignedId: string | null }
) {
  if (actorName) {
    // Someone already did this step — show them. Even admins don't
    // override actor stamps (those reflect history, not intent).
    return (
      <div style={{ color: "var(--text-2)" }}>
        <p className="text-theme truncate">{actorName}</p>
        <p className="text-[10px]" style={{ color: "var(--text-muted)" }}>{fmtRelDate(actorAt)}</p>
      </div>
    )
  }
  if (assignedName) {
    return (
      <div style={{ color: "var(--text-2)" }}>
        <p className="text-theme truncate inline-flex items-center gap-1">
          {assignedName}
          {isAdmin && (
            <AssignDropdown
              label="Edit"
              members={members}
              onPick={onAssign}
              current={currentAssignedId}
            />
          )}
        </p>
        <p className="text-[10px] italic" style={{ color: "var(--text-muted)" }}>assigned</p>
      </div>
    )
  }
  if (isAdmin) {
    return (
      <AssignDropdown
        label={dropdownLabel}
        members={members}
        onPick={onAssign}
        current={currentAssignedId}
      />
    )
  }
  return <span style={{ color: "var(--text-muted)" }}>—</span>
}

// ── DueCell ────────────────────────────────────────────────────────────────

function DueCell({ dueDate, overridden, overdue, isAdmin, onSet }:
  { dueDate: string | null; overridden: boolean; overdue: boolean;
    isAdmin: boolean; onSet: (iso: string | null) => void }
) {
  if (!dueDate) {
    return isAdmin
      ? <DueDatePopover label="Set due" onPick={onSet} />
      : <span style={{ color: "var(--text-muted)" }}>—</span>
  }
  return (
    <div>
      <p className="inline-flex items-center gap-1"
        style={{ color: overdue ? "#dc2626" : "var(--text-2)" }}>
        {fmtDate(dueDate)}
        {overridden && (
          <Pencil size={9} strokeWidth={2} style={{ color: "var(--text-muted)" }}
            aria-label="Custom due date" />
        )}
      </p>
      {overdue && <p className="text-[10px] font-semibold" style={{ color: "#dc2626" }}>overdue</p>}
      {isAdmin && (
        <DueDatePopover label="Edit" onPick={onSet} current={dueDate} />
      )}
    </div>
  )
}

// ── Empty + manual form ───────────────────────────────────────────────────

function EmptyState({ tab, statusFilter, onSwitchTab, onClearStatusFilter }:
  { tab: FilterTab; statusFilter: Set<string>;
    onSwitchTab: (t: FilterTab) => void; onClearStatusFilter: () => void }
) {
  // Detect the specific case of "status filter conflicts with current tab"
  // and surface a one-click fix CTA instead of the generic empty state.
  // Open tab can't show 'approved'; Completed tab can't show open-side
  // statuses (pending/reviewed/flagged).
  const sf = [...statusFilter]
  const hasApproved = statusFilter.has("approved")
  const hasOpenish  = sf.some((v) => v !== "approved" && v !== "manual")
  let conflict: { suggestedTab: FilterTab; reason: string } | null = null
  if (statusFilter.size > 0) {
    if (tab === "open" && hasApproved && !hasOpenish) {
      conflict = {
        suggestedTab: "completed",
        reason: "Approved tasks live in the Completed tab — the Open tab excludes them by definition.",
      }
    } else if (tab === "completed" && hasOpenish && !hasApproved) {
      conflict = {
        suggestedTab: "open",
        reason: "Pending / Prepared / Flagged tasks live in the Open tab — the Completed tab only shows approved or manually-completed work.",
      }
    } else if (tab !== "all" && hasApproved && hasOpenish) {
      conflict = {
        suggestedTab: "all",
        reason: "Your status filter spans both open and completed buckets. The All tab shows both.",
      }
    }
  }

  if (conflict) {
    return (
      <div className="rounded-xl p-8 text-center"
        style={{ background: "var(--surface)", border: "1px solid #f59e0b" }}>
        <div className="h-12 w-12 mx-auto rounded-full flex items-center justify-center mb-3"
          style={{ background: "rgba(245, 158, 11, 0.15)", border: "2px solid #f59e0b" }}>
          <Filter size={20} strokeWidth={1.6} style={{ color: "#b45309" }} />
        </div>
        <p className="text-sm font-semibold text-theme mb-1">
          Filter doesn&apos;t match the current tab
        </p>
        <p className="text-xs max-w-md mx-auto mb-4" style={{ color: "var(--text-muted)" }}>
          {conflict.reason}
        </p>
        <div className="flex items-center justify-center gap-2 flex-wrap">
          <Button size="sm" onClick={() => onSwitchTab(conflict!.suggestedTab)}>
            Switch to {conflict.suggestedTab === "all" ? "All" : conflict.suggestedTab === "open" ? "Open" : "Completed"} tab
          </Button>
          <Button size="sm" variant="ghost" onClick={onClearStatusFilter}>
            Clear status filter
          </Button>
        </div>
      </div>
    )
  }

  const copy: Record<FilterTab, { title: string; body: string }> = {
    open:      { title: "Nothing to do",     body: "No open tasks for the current filters. Try widening the filters or check the Completed tab." },
    completed: { title: "Nothing completed", body: "Tasks finish here as a record of work done." },
    all:       { title: "No tasks",          body: "Sync QuickBooks accounts and they'll show up as reconciliation tasks." },
  }
  const c = copy[tab]
  return (
    <div className="rounded-xl p-10 text-center"
      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <CheckSquare size={28} strokeWidth={1.6} className="mx-auto mb-3" style={{ color: "var(--text-muted)" }} />
      <p className="text-sm font-semibold text-theme mb-1">{c.title}</p>
      <p className="text-xs" style={{ color: "var(--text-muted)" }}>{c.body}</p>
    </div>
  )
}

function ManualTaskForm({ onClose, onCreated, members, isAdmin }: {
  onClose: () => void; onCreated: () => void
  members: { id: string | null; display_name: string; role: string }[]
  isAdmin: boolean
}) {
  const [subject, setSubject] = useState("")
  const [description, setDescription] = useState("")
  const [priority, setPriority] = useState("normal")
  const [periodEnd, setPeriodEnd] = useState("")
  const [dueDate, setDueDate] = useState("")
  const [preparerId, setPreparerId] = useState("")
  const [reviewerId, setReviewerId] = useState("")

  const createMut = useMutation({
    mutationFn: () => tasksApi.createManual({
      subject:     subject.trim(),
      description: description.trim() || null,
      priority,
      period_end:  periodEnd || null,
      // Admin-only — send blank otherwise
      due_date:             isAdmin ? (dueDate || null) : null,
      assigned_preparer_id: isAdmin ? (preparerId || null) : null,
      assigned_reviewer_id: isAdmin ? (reviewerId || null) : null,
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
      <Label text="Subject">
        <input type="text" value={subject} onChange={(e) => setSubject(e.target.value)}
          placeholder="e.g. Email client for September bank statement"
          className="w-full rounded-lg px-3 py-2 mt-1 text-sm outline-none"
          style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }} />
      </Label>
      <Label text="Description (optional)">
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2}
          className="w-full rounded-lg px-3 py-2 mt-1 text-sm outline-none resize-none"
          style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }} />
      </Label>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Label text="Priority">
          <select value={priority} onChange={(e) => setPriority(e.target.value)}
            className="w-full rounded-lg px-3 py-2 mt-1 text-sm outline-none"
            style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }}>
            <option value="low">Low</option><option value="normal">Normal</option>
            <option value="high">High</option><option value="critical">Critical</option>
          </select>
        </Label>
        <Label text="Period (optional)">
          <div className="mt-1">
            <DatePicker value={periodEnd} onChange={setPeriodEnd} className="block w-full" triggerClassName="inline-flex items-center gap-2 w-full rounded-lg px-3 py-2 text-sm outline-none transition-colors hover:bg-[var(--surface)]" />
          </div>
        </Label>
      </div>
      {isAdmin && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Label text="Preparer (optional)">
            <select value={preparerId} onChange={(e) => setPreparerId(e.target.value)}
              className="w-full rounded-lg px-3 py-2 mt-1 text-sm outline-none"
              style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }}>
              <option value="">— None</option>
              {members.filter((m) => m.id).map((m) => (
                <option key={m.id!} value={m.id!}>{m.display_name}</option>
              ))}
            </select>
          </Label>
          <Label text="Reviewer (optional)">
            <select value={reviewerId} onChange={(e) => setReviewerId(e.target.value)}
              className="w-full rounded-lg px-3 py-2 mt-1 text-sm outline-none"
              style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }}>
              <option value="">— None</option>
              {members.filter((m) => m.id).map((m) => (
                <option key={m.id!} value={m.id!}>{m.display_name}</option>
              ))}
            </select>
          </Label>
          <Label text="Due date (optional)">
            <div className="mt-1">
              <DatePicker value={dueDate} onChange={setDueDate} className="block w-full" triggerClassName="inline-flex items-center gap-2 w-full rounded-lg px-3 py-2 text-sm outline-none transition-colors hover:bg-[var(--surface)]" />
            </div>
          </Label>
        </div>
      )}
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

function Label({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
        {text}
      </span>
      {children}
    </label>
  )
}
