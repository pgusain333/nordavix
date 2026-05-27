/**
 * VarianceTable — TanStack Table displaying flux analysis results.
 *
 * Columns: Account #, Account Name, Category, Current, Prior, $ Var, % Var,
 *          Material, Status, AI Commentary, Actions (Approve / Edit)
 *
 * Row features:
 *   - Click to expand narrative editor
 *   - Approve button marks status → approved
 *   - Edit inline saves custom narrative
 *   - Material rows show amber badge
 */
import { useState, useMemo, Fragment } from "react"
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  flexRender,
  createColumnHelper,
  type SortingState,
} from "@tanstack/react-table"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AnimatePresence, motion } from "framer-motion"
import {
  CheckCircle2,
  Check,
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
  Pencil,
  AlertTriangle,
  Sparkles,
  Filter,
  Download,
  Eye,
  ListOrdered,
  RotateCcw,
  X,
} from "lucide-react"
import { api, type VarianceRow, type VarianceTransactionsResponse } from "@/modules/flux/api"
import { Button, Badge, StatusBadge, Spinner } from "@/core/ui/components"
import { cn, formatAccounting, formatPct } from "@/core/ui/utils"
import { workspaceApi } from "@/modules/workspace/api"

interface Props {
  tbId:      string
  rows:      VarianceRow[]
  isLoading: boolean
  onExport:  () => void
  /** Period end dates for column headers — displayed as "MMM DD YYYY (CY/PY)" */
  periodCurrent?: string  // ISO date
  periodPrior?:   string
  /**
   * Surfaces success/error messages from bulk actions to the parent
   * page banner. Lets the user see "Reset 3 variances to pending" or
   * "Bulk reset failed: …" without us having to render a duplicate
   * banner inside the table card.
   */
  onMessage?:   (msg: { kind: "ok" | "info" | "err"; text: string }) => void
  /**
   * When true (books closed for the analysis's period), the table goes
   * view-only: per-row Approve/Edit icons hide, bulk action toolbar
   * is suppressed, narrative edit is read-only. Mirrors the recons
   * lock-down on closed periods.
   */
  readOnly?:    boolean
}

function _formatHeaderDate(iso?: string, suffix?: string): string {
  if (!iso) return suffix ?? ""
  try {
    const d = new Date(iso + "T00:00:00")
    const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
    return suffix ? `${date} (${suffix})` : date
  } catch { return suffix ?? iso }
}

const col = createColumnHelper<VarianceRow>()

const STATUS_ORDER: Record<string, number> = {
  flagged:    0,
  pending:    1,
  generating: 2,
  generated:  3,
  edited:     4,
  approved:   5,
}

// ── Main component ────────────────────────────────────────────────────────────

export function VarianceTable({ tbId, rows, isLoading, onExport, periodCurrent, periodPrior, onMessage, readOnly = false }: Props) {
  const qc = useQueryClient()
  // Role-aware approve buttons. Backend now 403s preparers on the
  // /approve endpoints, so we hide the buttons here too — clicking
  // a button only to be told "you can't" is a worse experience than
  // never seeing the button. Preparers see prepare / flag / edit
  // (their actual workflow), reviewers + admins see approve as well.
  const { data: me } = useQuery({
    queryKey: ["workspace-me"],
    queryFn:  workspaceApi.getMe,
    staleTime: 5 * 60_000,
  })
  const canApprove = me?.role === "admin" || me?.role === "reviewer"
  const [sorting,    setSorting]   = useState<SortingState>([
    // Sort by absolute dollar variance desc so the biggest movers
    // surface first (formerly sorted by is_material; column is gone).
    { id: "dollar_variance", desc: true },
  ])
  // Status buckets mirror Reconciliations exactly:
  //   open      = needs work (pending / generating / flagged)
  //   prepared  = AI commentary written but not yet approved
  //                (generated / edited)
  //   approved  = signed off
  //   all       = everything
  const [filter, setFilter] = useState<"open" | "prepared" | "approved" | "all">("open")
  const [expandedRow, setExpanded] = useState<string | null>(null)
  const [editingRow,  setEditing]  = useState<string | null>(null)
  const [editContent, setEditContent] = useState("")
  // Bulk selection — same pattern as the recon accounts table.
  const [selected, setSelected] = useState<Set<string>>(new Set())

  // ── Approve mutation ───────────────────────────────────────────────────────
  const approve = useMutation({
    mutationFn: (varId: string) => api.approveVariance(tbId, varId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["variances", tbId] }),
  })

  // Map a target status → the tab the affected rows now belong to,
  // so we can auto-switch after a bulk action and the user actually
  // sees where their rows went. "flagged" stays in the Open bucket
  // (open = pending | generating | flagged).
  function bucketForStatus(s: "approved" | "pending" | "edited" | "flagged"): typeof filter {
    if (s === "approved") return "approved"
    if (s === "edited")   return "prepared"
    return "open"
  }

  // Pulls a useful error message out of an axios-style rejection.
  // Surfaces the backend's `detail` field when present (e.g. validation
  // errors from FastAPI), otherwise the generic message — which is at
  // least more informative than a silent no-op.
  function extractErrorDetail(err: unknown): string | undefined {
    const e = err as { response?: { data?: { detail?: unknown }; status?: number }; message?: string }
    const d = e?.response?.data?.detail
    if (typeof d === "string") return d
    if (Array.isArray(d) && d.length > 0) return JSON.stringify(d[0])
    if (e?.response?.status) return `HTTP ${e.response.status}: ${e.message ?? "Request failed"}`
    return e?.message
  }

  // Bulk approve — fires per-row approves in PARALLEL so a 5-row
  // operation finishes in 1 request-round-trip instead of 5. Uses
  // Promise.allSettled so a single failure doesn't abort the batch.
  // If EVERY id fails, throw so onError fires (rollback + visible
  // error banner) instead of silently swallowing the failure.
  const bulkApprove = useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(
        ids.map((id) => api.approveVariance(tbId, id)),
      )
      const failures = results
        .map((r, i) => (r.status === "rejected" ? { id: ids[i], reason: r.reason } : null))
        .filter((x): x is { id: string; reason: unknown } => x !== null)
      if (failures.length > 0) {
        console.warn("Bulk approve failures:", failures)
      }
      if (failures.length === ids.length && ids.length > 0) {
        // Every single request failed → bubble up so onError handles
        // the optimistic rollback + visible error banner. Without
        // this throw the mutation would silently "succeed" with
        // failed=N and the user would see the row snap back to its
        // original status with no explanation.
        throw failures[0].reason
      }
      return { total: ids.length, failed: failures.length }
    },
    onMutate: async (ids) => {
      await qc.cancelQueries({ queryKey: ["variances", tbId] })
      const prev = qc.getQueryData<VarianceRow[]>(["variances", tbId])
      if (prev) {
        const idSet = new Set(ids)
        const nowIso = new Date().toISOString()
        qc.setQueryData<VarianceRow[]>(["variances", tbId],
          prev.map((r) => idSet.has(r.id)
            ? { ...r, status: "approved", approved_at: nowIso }
            : r,
          ),
        )
      }
      return { prev }
    },
    onSuccess: ({ total, failed }) => {
      const moved = total - failed
      onMessage?.({
        kind: failed > 0 ? "info" : "ok",
        text: failed > 0
          ? `Approved ${moved} of ${total} — ${failed} failed`
          : `Approved ${moved} variance${moved === 1 ? "" : "s"}`,
      })
      if (moved > 0) setFilter(bucketForStatus("approved"))
      setSelected(new Set())
      // refetchType:"active" forces an immediate refetch on the
      // currently-mounted query — without it invalidateQueries just
      // marks the cache stale and the user can sit looking at the
      // optimistic state for the full staleTime window.
      qc.invalidateQueries({ queryKey: ["variances", tbId], refetchType: "active" })
    },
    onError: (err: unknown, _ids, ctx) => {
      if (ctx?.prev) qc.setQueryData(["variances", tbId], ctx.prev)
      onMessage?.({ kind: "err", text: extractErrorDetail(err) ?? "Bulk approve failed. Try again." })
    },
  })

  // Bulk status flip — backs the Mark prepared / Flag / Reset to
  // pending buttons. Same parallel-with-throw-on-total-failure pattern
  // as bulkApprove so silent failures can't make the UI look frozen.
  // Auto-switches the active filter tab to the bucket the affected rows
  // now belong to, so the user immediately SEES where their rows
  // landed instead of staring at a tab that looks empty.
  const bulkSetStatus = useMutation({
    mutationFn: async (vars: { ids: string[]; status: "pending" | "edited" | "flagged" }) => {
      const results = await Promise.allSettled(
        vars.ids.map((id) => api.setVarianceStatus(tbId, id, vars.status)),
      )
      const failures = results
        .map((r, i) => (r.status === "rejected" ? { id: vars.ids[i], reason: r.reason } : null))
        .filter((x): x is { id: string; reason: unknown } => x !== null)
      if (failures.length > 0) {
        console.warn(`Bulk ${vars.status} failures:`, failures)
      }
      if (failures.length === vars.ids.length && vars.ids.length > 0) {
        // Every PATCH failed — surface to onError so we roll back the
        // optimistic update and show the backend's actual error
        // detail in the banner. This is the path the user was hitting
        // before and it looked like the button did nothing.
        throw failures[0].reason
      }
      return { total: vars.ids.length, failed: failures.length, status: vars.status }
    },
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: ["variances", tbId] })
      const prev = qc.getQueryData<VarianceRow[]>(["variances", tbId])
      if (prev) {
        const idSet = new Set(vars.ids)
        qc.setQueryData<VarianceRow[]>(["variances", tbId],
          prev.map((r) => {
            if (!idSet.has(r.id)) return r
            // Reset to pending also clears approval stamps — mirror
            // the backend behaviour so the optimistic state matches
            // what the next refetch returns.
            if (vars.status === "pending") {
              return { ...r, status: "pending", approved_by: null, approved_at: null }
            }
            return { ...r, status: vars.status }
          }),
        )
      }
      return { prev }
    },
    onSuccess: ({ total, failed, status }) => {
      const moved = total - failed
      const labelMap: Record<typeof status, string> = {
        pending: "reset to pending",
        edited:  "marked prepared",
        flagged: "flagged",
      }
      onMessage?.({
        kind: failed > 0 ? "info" : "ok",
        text: failed > 0
          ? `${labelMap[status]} ${moved} of ${total} — ${failed} failed`
          : `Successfully ${labelMap[status]} ${moved} variance${moved === 1 ? "" : "s"}`,
      })
      if (moved > 0) setFilter(bucketForStatus(status))
      setSelected(new Set())
      qc.invalidateQueries({ queryKey: ["variances", tbId], refetchType: "active" })
    },
    onError: (err: unknown, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(["variances", tbId], ctx.prev)
      onMessage?.({ kind: "err", text: extractErrorDetail(err) ?? "Bulk update failed. Try again." })
    },
  })

  // ── Narrative edit mutation ────────────────────────────────────────────────
  const editNarrative = useMutation({
    mutationFn: ({ varId, content }: { varId: string; content: string }) =>
      api.updateNarrative(tbId, varId, content),
    onSuccess: () => {
      setEditing(null)
      qc.invalidateQueries({ queryKey: ["variances", tbId] })
    },
  })

  // Per-row Agentic — runs the deeper analysis on ONE variance.
  // Pulls QBO transactions for the change window + asks Claude for
  // structured commentary (narrative + risk_level + justified +
  // key_entities + recommendations). Returns immediately with the
  // commentary so we can patch the row optimistically — no need to
  // wait for a full list refetch. Confirms before overwriting any
  // existing commentary.
  const rowAgentic = useMutation({
    mutationFn: async (varId: string) => api.runAgenticOnVariance(tbId, varId),
    onSuccess: (data) => {
      // Patch the cached variances list so the new ai_commentary
      // renders without a network roundtrip.
      const prev = qc.getQueryData<VarianceRow[]>(["variances", tbId])
      if (prev) {
        qc.setQueryData<VarianceRow[]>(["variances", tbId],
          prev.map((r) => r.id === data.variance_id
            ? { ...r, ai_commentary: data.ai_commentary, status: r.status === "pending" || r.status === "flagged" ? "generated" : r.status }
            : r,
          ),
        )
      }
      onMessage?.({
        kind: "ok",
        text: `AI analysis done — risk: ${data.ai_commentary.risk_level}, justified: ${data.ai_commentary.justified}.`,
      })
    },
    onError: (err: unknown) => {
      onMessage?.({ kind: "err", text: extractErrorDetail(err) ?? "Per-row AI failed. Try again." })
    },
  })

  function triggerRowAgentic(row: VarianceRow) {
    // Confirm before overwriting existing commentary (per user spec).
    if (row.ai_commentary) {
      const ok = window.confirm(
        `${row.account_name} already has AI commentary (risk: ${row.ai_commentary.risk_level}, ` +
        `justified: ${row.ai_commentary.justified}).\n\n` +
        "Re-running will pull fresh transactions from QuickBooks and overwrite " +
        "the existing analysis with a new one.\n\nContinue?",
      )
      if (!ok) return
    }
    rowAgentic.mutate(row.id)
  }

  // ── Filter data ────────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    if (filter === "open")     return rows.filter((r) => ["pending", "generating", "flagged"].includes(r.status))
    if (filter === "prepared") return rows.filter((r) => ["generated", "edited"].includes(r.status))
    if (filter === "approved") return rows.filter((r) => r.status === "approved")
    return rows
  }, [rows, filter])

  // Bucket counts for the tab labels
  const bucketCounts = useMemo(() => ({
    open:     rows.filter((r) => ["pending", "generating", "flagged"].includes(r.status)).length,
    prepared: rows.filter((r) => ["generated", "edited"].includes(r.status)).length,
    approved: rows.filter((r) => r.status === "approved").length,
    all:      rows.length,
  }), [rows])

  // ── Columns ────────────────────────────────────────────────────────────────
  // Note: `selected` is captured in the closure for the checkbox column
  // header / cell. TanStack Table memoizes columns; re-creating them on
  // every selection change is the simplest way to keep the indeterminate
  // header checkbox in sync with the filtered view.
  const visibleIds = filtered.map((r) => r.id)
  const allChecked = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id))
  const someChecked = visibleIds.some((id) => selected.has(id))

  const columns = useMemo(() => [
    // Checkbox column — same pattern as the recon accounts table. Click
    // anywhere on this cell is stopped from bubbling to the row's
    // expand handler.
    col.display({
      id: "_select",
      size: 36,
      header: () => (
        <input
          type="checkbox"
          aria-label="Select all visible"
          checked={allChecked}
          ref={(el) => { if (el) el.indeterminate = !allChecked && someChecked }}
          onChange={(e) => {
            const next = new Set(selected)
            if (e.target.checked) visibleIds.forEach((id) => next.add(id))
            else                  visibleIds.forEach((id) => next.delete(id))
            setSelected(next)
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ),
      cell: (c) => {
        const id = c.row.original.id
        const checked = selected.has(id)
        return (
          <input
            type="checkbox"
            aria-label={`Select variance ${c.row.original.account_name}`}
            checked={checked}
            onChange={() => {
              const next = new Set(selected)
              if (next.has(id)) next.delete(id)
              else              next.add(id)
              setSelected(next)
            }}
            onClick={(e) => e.stopPropagation()}
          />
        )
      },
    }),
    col.accessor("account_number", {
      header: "Account No.",
      size:   90,
      cell: (c) => {
        const v = c.getValue() ?? ""
        // Hide synthetic qbo-id placeholders — show a dash so the user
        // sees clearly that this account isn't numbered in QBO.
        const display = !v || v.startsWith("qbo-") ? "—" : v
        return <span className="font-mono text-xs" style={{ color: "var(--text-2)" }}>{display}</span>
      },
    }),
    col.accessor("account_name", {
      header: "Account Name",
      size:   200,
      cell: (c) => (
        <span className="text-sm font-medium truncate max-w-[200px] block text-theme" title={c.getValue()}>
          {c.getValue()}
        </span>
      ),
    }),
    col.accessor("fs_category", {
      header: "Category",
      size:   120,
      cell: (c) => (
        <span className="text-xs" style={{ color: "var(--text-muted)" }}>{c.getValue() ?? "—"}</span>
      ),
    }),
    col.accessor("current_balance", {
      header: _formatHeaderDate(periodCurrent, "CY"),
      size:   140,
      cell: (c) => (
        <span className="tabular-nums text-sm text-right block text-theme">
          {formatAccounting(c.getValue(), 0)}
        </span>
      ),
    }),
    col.accessor("prior_balance", {
      header: _formatHeaderDate(periodPrior, "PY"),
      size:   140,
      cell: (c) => (
        <span className="tabular-nums text-sm text-right block" style={{ color: "var(--text-muted)" }}>
          {formatAccounting(c.getValue(), 0)}
        </span>
      ),
    }),
    col.accessor("dollar_variance", {
      header: "$ Var",
      size:   110,
      cell: (c) => {
        const v = parseFloat(c.getValue())
        return (
          <span
            className="tabular-nums text-sm font-medium text-right block"
            style={{ color: v > 0 ? "var(--green)" : v < 0 ? "#dc2626" : "var(--text-muted)" }}
          >
            {formatAccounting(c.getValue(), 0)}
          </span>
        )
      },
    }),
    col.accessor("pct_variance", {
      header: "% Var",
      size:   80,
      cell: (c) => {
        const v = c.getValue() ? parseFloat(c.getValue()!) : null
        return (
          <span
            className="tabular-nums text-sm text-right block"
            style={{ color: v && v > 0 ? "var(--green)" : v && v < 0 ? "#dc2626" : "var(--text-muted)" }}
          >
            {formatPct(c.getValue())}
          </span>
        )
      },
    }),
    // (Material column removed — materiality feature dropped per
    // user direction. Every variance row now gets the same Pull-
    // QBO / Run-AI affordances regardless of materiality.)
    col.accessor("status", {
      header: "Status",
      size:   120,
      sortingFn: (a, b) =>
        (STATUS_ORDER[a.original.status] ?? 9) - (STATUS_ORDER[b.original.status] ?? 9),
      cell: (c) => <StatusBadge status={c.getValue()} />,
    }),
    col.display({
      id:     "actions",
      header: "",
      size:   100,
      cell:   ({ row }) => {
        const r = row.original
        const agenticPendingForThisRow =
          rowAgentic.isPending && rowAgentic.variables === r.id
        return (
          <div className="flex items-center gap-1.5 justify-end">
            {/* Per-row Agentic — open to all workspace members.
                Pulls QBO txns + runs the deeper structured analysis
                on this row. Shown on every row (materiality removed).
                Hidden on locked periods. Spinner replaces icon while
                running. */}
            {!readOnly && (
              <Button
                size="icon-sm"
                variant="outline"
                title={r.ai_commentary
                  ? "Re-run AI on this row (overwrites existing analysis)"
                  : "Run AI on this row (pulls QBO transactions + structured analysis)"}
                onClick={(e) => {
                  e.stopPropagation()
                  triggerRowAgentic(r)
                }}
                disabled={agenticPendingForThisRow}
                style={r.ai_commentary
                  ? { borderColor: "var(--green)", color: "var(--green)" }
                  : undefined}
              >
                {agenticPendingForThisRow
                  ? <Spinner className="h-3 w-3" />
                  : <Sparkles size={14} strokeWidth={1.6} />}
              </Button>
            )}
            {/* Approve check icon — admin / reviewer only and only
                when the period isn't locked. Preparers still get the
                Edit button so they can write commentary + mark
                prepared via the bulk-action bar. */}
            {r.status !== "approved" && canApprove && !readOnly && (
              <Button
                size="icon-sm"
                variant="outline"
                title="Approve"
                onClick={(e) => {
                  e.stopPropagation()
                  approve.mutate(r.id)
                }}
                disabled={approve.isPending}
              >
                <CheckCircle2 size={14} strokeWidth={1.6} />
              </Button>
            )}
            <Button
              size="icon-sm"
              variant="outline"
              title="Edit narrative"
              onClick={(e) => {
                e.stopPropagation()
                setEditing(r.id)
                setEditContent(r.narrative ?? "")
                setExpanded(r.id)
              }}
            >
              <Pencil size={14} strokeWidth={1.6} />
            </Button>
          </div>
        )
      },
    }),
  // selected / visibleIds / *Checked are intentionally in deps so the
  // header checkbox + per-row checked state re-render on selection
  // change. allChecked / someChecked are derived from selected +
  // visibleIds so listing those covers them.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [approve, tbId, periodCurrent, periodPrior, selected, filter, rows])

  const table = useReactTable({
    data:               filtered,
    columns,
    state:              { sorting },
    onSortingChange:    setSorting,
    getCoreRowModel:    getCoreRowModel(),
    getSortedRowModel:  getSortedRowModel(),
    getFilteredRowModel:getFilteredRowModel(),
  })

  // ── Render ─────────────────────────────────────────────────────────────────

  // Filter buckets — match the Reconciliations status buckets EXACTLY:
  // Open (red) / Prepared (blue) / Approved (green) / All (neutral).
  // Same labels, same colors, same chrome.
  const FILTER_BUCKETS = [
    { key: "open",     label: "Open",     fg: "#b91c1c",      bg: "#fef2f2",        count: bucketCounts.open },
    { key: "prepared", label: "Prepared", fg: "#1d4ed8",      bg: "#dbeafe",        count: bucketCounts.prepared },
    { key: "approved", label: "Approved", fg: "var(--green)", bg: "var(--green-subtle)", count: bucketCounts.approved },
    { key: "all",      label: "All",      fg: "var(--text)",  bg: "var(--surface)", count: bucketCounts.all },
  ] as const

  // Ids of currently-selected variances that are not yet approved —
  // bulk approve only makes sense for these.
  const selectedApprovable = useMemo(
    () => Array.from(selected).filter((id) => {
      const r = rows.find((x) => x.id === id)
      return r && r.status !== "approved"
    }),
    [selected, rows],
  )

  return (
    <div className="flex flex-col px-4 sm:px-6 py-4 gap-4" style={{ background: "var(--bg)" }}>
      {/* Filters row — sits ABOVE the table card (like recon) instead of
          being baked into the same container. Tabs match the recon
          status-bucket style for visual parity. */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1 flex-wrap rounded-lg p-1"
          style={{ background: "var(--surface-2)", border: "1px solid var(--border)", width: "fit-content" }}>
          {FILTER_BUCKETS.map((b) => {
            const active = filter === b.key
            return (
              <button
                key={b.key}
                onClick={() => { setFilter(b.key); setSelected(new Set()) }}
                className="inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-all"
                style={{
                  background: active ? b.bg   : "transparent",
                  color:      active ? b.fg   : "var(--text-muted)",
                }}
              >
                {b.label}
                <span className="text-[10px] tabular-nums opacity-80">{b.count}</span>
              </button>
            )
          })}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            icon={<Download size={14} strokeWidth={1.6} />}
            onClick={onExport}
          >
            Export
          </Button>
        </div>
      </div>

      {/* Table card — same rounded-xl + surface + card-shadow chrome
          as the recon accounts table so the two pages read as one.
          No flex-1 / internal scroll: the parent FluxDashboard handles
          page-level scrolling so the sticky KPI strip works. */}
      <div className="rounded-xl overflow-hidden"
        style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
        {isLoading ? (
          <div className="py-12 flex items-center justify-center">
            <div className="flex items-center gap-2 text-sm" style={{ color: "var(--text-muted)" }}>
              <Spinner />
              Loading variances…
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-12 flex flex-col items-center text-center">
            <div
              className="h-12 w-12 rounded-full flex items-center justify-center mb-3"
              style={{ background: "var(--surface-2)" }}
            >
              <Filter size={22} strokeWidth={1.6} style={{ color: "var(--text-muted)" }} />
            </div>
            <p className="text-sm font-medium text-theme mb-1">No variances match this filter</p>
            <button
              onClick={() => setFilter("all")}
              className="text-xs underline"
              style={{ color: "var(--text-muted)" }}
            >
              Show all
            </button>
          </div>
        ) : (
          <>
            {/* Bulk-action toolbar — matches the Reconciliations
                accounts table button-for-button:
                  [N selected]  Approve  Mark prepared  Flag  Reset to pending  …  Clear selection
                Same chrome (green-subtle bg, 1px border below, 11px
                label), same icon set, same colour treatment on Flag
                (red outline). Click any action and the loading state
                covers every button in the row so the user can't
                double-fire. Hidden entirely when the period is
                closed — readOnly mode. */}
            {selected.size > 0 && !readOnly && (
              <div className="px-4 py-2 flex items-center gap-2 flex-wrap"
                style={{ background: "var(--green-subtle)", borderBottom: "1px solid var(--border)" }}>
                <span className="text-[11px] font-semibold" style={{ color: "var(--green)" }}>
                  {selected.size} selected
                </span>
                {/* Bulk Approve — admin / reviewer only.
                    Preparers still see Mark prepared / Flag / Reset
                    in the same toolbar (their actual workflow). */}
                {canApprove && (
                  <Button
                    size="sm"
                    icon={<CheckCircle2 size={11} strokeWidth={1.8} />}
                    loading={bulkApprove.isPending}
                    disabled={bulkSetStatus.isPending || selectedApprovable.length === 0}
                    onClick={() => bulkApprove.mutate(selectedApprovable)}
                    title={selectedApprovable.length === 0
                      ? "Every selected variance is already approved"
                      : `Approve ${selectedApprovable.length} variance${selectedApprovable.length === 1 ? "" : "s"}`}
                  >
                    Approve
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  icon={<Eye size={11} strokeWidth={1.8} />}
                  loading={bulkSetStatus.isPending && bulkSetStatus.variables?.status === "edited"}
                  disabled={bulkApprove.isPending || bulkSetStatus.isPending}
                  onClick={() => bulkSetStatus.mutate({
                    ids: Array.from(selected), status: "edited",
                  })}
                  title="Mark selected variances as prepared (human-reviewed, ready for sign-off)"
                >
                  Mark prepared
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  icon={<AlertTriangle size={11} strokeWidth={1.8} />}
                  loading={bulkSetStatus.isPending && bulkSetStatus.variables?.status === "flagged"}
                  disabled={bulkApprove.isPending || bulkSetStatus.isPending}
                  onClick={() => bulkSetStatus.mutate({
                    ids: Array.from(selected), status: "flagged",
                  })}
                  style={{ borderColor: "#fecaca", color: "#b91c1c" }}
                  title="Flag selected variances for follow-up"
                >
                  Flag
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  loading={bulkSetStatus.isPending && bulkSetStatus.variables?.status === "pending"}
                  disabled={bulkApprove.isPending || bulkSetStatus.isPending}
                  onClick={() => bulkSetStatus.mutate({
                    ids: Array.from(selected), status: "pending",
                  })}
                  title="Reset selected variances back to pending — clears any approval stamps"
                >
                  Reset to pending
                </Button>
                <button
                  onClick={() => setSelected(new Set())}
                  className="ml-auto text-[11px] font-medium"
                  style={{ color: "var(--text-muted)" }}
                >
                  Clear selection
                </button>
              </div>
            )}

            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-sm border-separate border-spacing-0">
                <thead>
                  <tr style={{ background: "var(--surface-2)" }}>
                    {table.getFlatHeaders().map((header) => (
                      <th
                        key={header.id}
                        className={cn(
                          "px-3 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide select-none whitespace-nowrap",
                          header.column.getCanSort() && "cursor-pointer transition-colors"
                        )}
                        style={{
                          width: header.getSize(),
                          borderBottom: "1px solid var(--border)",
                          color: "var(--text-muted)",
                        }}
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        <span className="flex items-center gap-1">
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {header.column.getCanSort() && (
                            header.column.getIsSorted() === "asc"  ? <ChevronUp   size={12} /> :
                            header.column.getIsSorted() === "desc" ? <ChevronDown size={12} /> :
                            <ChevronsUpDown size={12} className="opacity-40" />
                          )}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
            <tbody>
              {table.getRowModel().rows.map((row) => {
                const isExpanded = expandedRow === row.original.id
                const isEditing  = editingRow === row.original.id
                return (
                  <Fragment key={row.id}>
                    <tr
                      className="cursor-pointer transition-colors"
                      style={{
                        // Expanded rows pick up the secondary surface color;
                        // all other rows render plain (materiality removed).
                        background: isExpanded ? "var(--surface-2)" : "var(--surface)",
                        borderBottom: "1px solid var(--border)",
                      }}
                      onMouseEnter={(e) => {
                        if (!isExpanded) (e.currentTarget as HTMLElement).style.background = "var(--surface-2)"
                      }}
                      onMouseLeave={(e) => {
                        if (!isExpanded) (e.currentTarget as HTMLElement).style.background = "var(--surface)"
                      }}
                      onClick={() =>
                        setExpanded((p) => p === row.original.id ? null : row.original.id)
                      }
                    >
                      {row.getVisibleCells().map((cell) => (
                        <td key={cell.id} className="px-3 py-1.5">
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      ))}
                    </tr>

                    {/* Expanded narrative row — wrapped in motion.tr
                        so the height + opacity animate when the user
                        toggles a row. Previously a hard if-render which
                        snapped open/closed. Height auto + a short
                        cubic ease keeps the table feeling responsive
                        without being slow. */}
                    <AnimatePresence>
                      {isExpanded && (
                        <motion.tr
                          key={`${row.id}-exp`}
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          transition={{ duration: 0.18, ease: [0.32, 0.72, 0, 1] }}
                          style={{ background: "var(--surface-2)" }}
                        >
                          <td
                            colSpan={columns.length}
                            className="px-5"
                            style={{ borderBottom: "1px solid var(--border)", padding: 0 }}
                          >
                            <motion.div
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: "auto", opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
                              style={{ overflow: "hidden" }}
                            >
                              <div className="px-5 py-4">
                                <NarrativePanel
                                  row={row.original}
                                  tbId={tbId}
                                  isEditing={isEditing}
                                  editContent={editContent}
                                  onEditContent={setEditContent}
                                  onEdit={() => {
                                    setEditing(row.original.id)
                                    setEditContent(row.original.narrative ?? "")
                                  }}
                                  onSave={() => editNarrative.mutate({
                                    varId: row.original.id,
                                    content: editContent
                                  })}
                                  onCancel={() => setEditing(null)}
                                  isSaving={editNarrative.isPending}
                                />
                              </div>
                            </motion.div>
                          </td>
                        </motion.tr>
                      )}
                    </AnimatePresence>
                  </Fragment>
                )
              })}
                </tbody>
              </table>
            </div>
          </>
        )}

      {/* Footer summary */}
      {!isLoading && rows.length > 0 && (
        <div
          className="px-4 py-2"
          style={{ borderTop: "1px solid var(--border)", background: "var(--surface-2)" }}
        >
          <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
            {rows.filter((r) => r.status === "approved").length} of {rows.length} variances approved
          </p>
        </div>
      )}
      </div> {/* /table-card wrapper */}
    </div>
  )
}

// ── NarrativePanel ────────────────────────────────────────────────────────────

interface NarrativePanelProps {
  row:           VarianceRow
  tbId:          string
  isEditing:     boolean
  editContent:   string
  onEditContent: (v: string) => void
  onEdit:        () => void
  onSave:        () => void
  onCancel:      () => void
  isSaving:      boolean
  // onRegenerate + isRegenerating dropped along with the
  // Find-reason / Regenerate button. AI generation now goes through
  // Agentic Mode in the header.
}

function NarrativePanel({
  row, tbId, isEditing, editContent, onEditContent,
  onEdit, onSave, onCancel, isSaving,
}: NarrativePanelProps) {
  const anomalyLabels: Record<string, string> = {
    new_account:        "No prior balance",
    sign_flip:          "Sign flip",
    large_pct_change:   "Large % change",
    dormant_reactivated:"Reactivated",
  }

  return (
    <div className="space-y-3">
      {/* Anomaly flags */}
      {row.anomaly_flags.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <AlertTriangle size={14} strokeWidth={1.6} style={{ color: "#92400e" }} className="shrink-0" />
          {row.anomaly_flags.map((f) => (
            <Badge key={f} variant="material">
              {anomalyLabels[f] ?? f}
            </Badge>
          ))}
        </div>
      )}

      {/* Narrative */}
      <div>
        <div className="flex items-center gap-1.5 mb-1.5">
          <Sparkles size={13} strokeWidth={1.6} style={{ color: "var(--green)" }} />
          <span
            className="text-[11px] font-semibold uppercase tracking-wide"
            style={{ color: "var(--text-2)" }}
          >
            {row.status === "generated" || row.status === "approved" || row.status === "edited"
              ? "AI Commentary"
              : "Commentary"}
          </span>
          {row.confidence_score && (
            <span className="text-[10px] ml-auto" style={{ color: "var(--text-muted)" }}>
              Confidence: {(parseFloat(row.confidence_score) * 100).toFixed(0)}%
            </span>
          )}
        </div>

        {isEditing ? (
          <div className="space-y-2">
            <textarea
              className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none resize-none min-h-[80px]"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border-strong)",
                color: "var(--text)",
              }}
              onFocus={(e) => (e.currentTarget.style.borderColor = "var(--green)")}
              onBlur={(e) => (e.currentTarget.style.borderColor = "var(--border-strong)")}
              value={editContent}
              onChange={(e) => onEditContent(e.target.value)}
              rows={3}
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                loading={isSaving}
                onClick={onSave}
                disabled={!editContent.trim()}
              >
                Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={onCancel}
                disabled={isSaving}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {/* Structured AI commentary panel — only renders when the
                deeper Agentic Mode produced ai_commentary. Falls back
                to plain `narrative` prose below for rows that only
                have the legacy text. */}
            {row.ai_commentary ? (
              <AiCommentaryPanel commentary={row.ai_commentary} />
            ) : (
              <div className="flex items-start gap-2">
                <p
                  className="text-sm leading-relaxed flex-1"
                  style={{
                    color: row.narrative ? "var(--text)" : "var(--text-muted)",
                    fontStyle: row.narrative ? "normal" : "italic",
                  }}
                >
                  {row.narrative
                    ? row.narrative
                    : row.status === "generating"
                      ? "AI commentary is being generated…"
                      : row.status === "pending"
                        ? "AI commentary will be generated for material variances."
                        : "No commentary yet. Click edit to add your own."}
                </p>
              </div>
            )}
            {/* Approver stamp — only shown once this variance has been signed off */}
            {row.approved_at && (
              <p className="text-[11px] flex items-center gap-1.5" style={{ color: "var(--green)" }}>
                <CheckCircle2 size={11} strokeWidth={2} />
                Approved on {new Date(row.approved_at).toLocaleString()}
              </p>
            )}
            <div className="flex items-center gap-2">
              {/* (Find reason / Regenerate button removed — Agentic
                  Mode in the header covers AI generation for every
                  material variance at once. Manual edits via the Edit
                  button below.) */}
              <Button
                size="sm"
                variant="ghost"
                onClick={onEdit}
                icon={<Pencil size={12} strokeWidth={1.8} />}
                title="Write or edit the commentary manually"
              >
                Edit
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Transactions drill-in — shown on every row now (materiality
          dropped). Pull-from-QBO is the canonical way to evidence
          any variance, big or small. */}
      <VarianceTxnsSection
        tbId={tbId}
        varianceId={row.id}
        expectedVariance={row.dollar_variance}
      />
    </div>
  )
}

// ── AiCommentaryPanel ─────────────────────────────────────────────────────
//
// Renders the STRUCTURED AI commentary produced by the deeper Agentic
// Mode. Shape:
//   { narrative, risk_level, justified, key_entities[], recommendations[], confidence }
//
// Visual hierarchy:
//   1. Narrative as the lead (4-6 sentence prose)
//   2. Three chips: risk level, justified, confidence (color-coded)
//   3. Key entities row (customer/vendor names + amounts)
//   4. Recommendations bullets

type AiCommentaryShape = NonNullable<VarianceRow["ai_commentary"]>

function AiCommentaryPanel({ commentary }: { commentary: AiCommentaryShape }) {
  // Risk color: red=high, amber=medium, green=low
  const riskMeta = {
    high:   { fg: "#dc2626", bg: "#fef2f2", border: "#fecaca", label: "High risk" },
    medium: { fg: "#b45309", bg: "#fef3c7", border: "#fcd34d", label: "Medium risk" },
    low:    { fg: "var(--green)", bg: "var(--green-subtle)", border: "var(--green)", label: "Low risk" },
  }[commentary.risk_level] ?? {
    fg: "var(--text-muted)", bg: "var(--surface-2)", border: "var(--border)", label: "Risk —",
  }
  // Justified color: green=yes, red=no, amber=needs_review
  const justifiedMeta = {
    yes:           { fg: "var(--green)", bg: "var(--green-subtle)", label: "Justified" },
    no:            { fg: "#dc2626", bg: "#fef2f2", label: "Not justified" },
    needs_review:  { fg: "#b45309", bg: "#fef3c7", label: "Needs review" },
  }[commentary.justified] ?? {
    fg: "var(--text-muted)", bg: "var(--surface-2)", label: "Unknown",
  }
  // Confidence: monochrome chip
  const confLabel = commentary.confidence === "high" ? "High confidence"
                  : commentary.confidence === "low"  ? "Low confidence"
                  : "Medium confidence"

  return (
    <div className="space-y-3">
      {/* Narrative — leads the panel */}
      <p className="text-sm leading-relaxed text-theme whitespace-pre-wrap">
        {commentary.narrative || "(AI did not return a narrative for this variance.)"}
      </p>

      {/* Risk + Justified + Confidence chips */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold"
          style={{ background: riskMeta.bg, color: riskMeta.fg, border: `1px solid ${riskMeta.border}` }}>
          {riskMeta.label}
        </span>
        <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold"
          style={{ background: justifiedMeta.bg, color: justifiedMeta.fg, border: "1px solid var(--border)" }}>
          {justifiedMeta.label}
        </span>
        <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-medium"
          style={{ background: "var(--surface-2)", color: "var(--text-muted)", border: "1px solid var(--border)" }}>
          {confLabel}
        </span>
      </div>

      {/* Key entities */}
      {commentary.key_entities && commentary.key_entities.length > 0 && (
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider mb-1.5"
            style={{ color: "var(--text-muted)" }}>
            Key entities
          </p>
          <div className="flex flex-wrap gap-1.5">
            {commentary.key_entities.map((e, i) => (
              <span key={i}
                className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px]"
                style={{
                  background: "var(--surface-2)",
                  border: "1px solid var(--border)",
                  color: "var(--text)",
                }}
              >
                <span className="font-medium">{e.name}</span>
                {e.type !== "other" && (
                  <span className="text-[9px] uppercase tracking-wide px-1 rounded"
                    style={{
                      background: e.type === "customer" ? "#dbeafe" : "#fef3c7",
                      color: e.type === "customer" ? "#1d4ed8" : "#b45309",
                    }}>
                    {e.type}
                  </span>
                )}
                {e.amount && (
                  <span className="font-mono text-[10px]" style={{ color: "var(--text-muted)" }}>
                    ${e.amount}
                  </span>
                )}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Recommendations */}
      {commentary.recommendations && commentary.recommendations.length > 0 && (
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider mb-1.5"
            style={{ color: "var(--text-muted)" }}>
            Recommended next steps
          </p>
          <ul className="space-y-1">
            {commentary.recommendations.map((rec, i) => (
              <li key={i} className="flex items-start gap-2 text-[12px] leading-snug">
                <span className="text-[10px] mt-0.5" style={{ color: "var(--green)" }}>▸</span>
                <span style={{ color: "var(--text)" }}>{rec}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-[9px]" style={{ color: "var(--text-muted)" }}>
        Generated {commentary.generated_at
          ? new Date(commentary.generated_at).toLocaleString()
          : "(unknown)"}
      </p>
    </div>
  )
}


// ── VarianceTxnsSection ───────────────────────────────────────────────────────
// Lists the QBO transactions hitting this variance's account in the period.
// First click "Pull transactions" hits QBO; once fetched the rows are stored
// server-side so subsequent expands are instant. Each row has a check toggle
// that the reviewer flips as they investigate — backed by an audit-logged
// flip on the server. The footer totals the pulled txns and reconciles them
// to the expected GL variance so the reviewer can spot missing activity.

function VarianceTxnsSection({ tbId, varianceId, expectedVariance }:
  { tbId: string; varianceId: string; expectedVariance: string }
) {
  const qc = useQueryClient()
  const [enabled, setEnabled] = useState(false)
  /** Set of currently-selected transaction IDs for bulk actions */
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ["variance-txns", tbId, varianceId],
    queryFn:  () => api.getVarianceTransactions(tbId, varianceId, false),
    enabled,
    staleTime: 60_000,
  })

  const refresh = useMutation({
    mutationFn: () => api.getVarianceTransactions(tbId, varianceId, true),
    onSuccess: (fresh) => {
      qc.setQueryData(["variance-txns", tbId, varianceId], fresh)
      setEnabled(true)
      setSelected(new Set())
    },
  })

  // Cache patcher used by both single + bulk toggle paths
  function patchTxn(updated: Awaited<ReturnType<typeof api.toggleVarianceTransactionCheck>>) {
    qc.setQueryData<VarianceTransactionsResponse | undefined>(
      ["variance-txns", tbId, varianceId],
      (prev) => {
        if (!prev) return prev
        const transactions = prev.transactions.map((t) => t.id === updated.id ? updated : t)
        return {
          ...prev,
          transactions,
          checked_count: transactions.filter((t) => t.is_checked).length,
        }
      },
    )
  }

  const toggle = useMutation({
    mutationFn: (txnId: string) => api.toggleVarianceTransactionCheck(tbId, varianceId, txnId),
    onSuccess: patchTxn,
  })

  /**
   * Bulk action: flip selected rows to `target` (true=checked, false=unchecked).
   * We hit the toggle endpoint individually but only for rows whose current
   * state doesn't match the target — saves wasted writes + audit-log noise.
   * Parallelism is bounded so we don't slam the API.
   */
  const bulkToggle = useMutation({
    mutationFn: async (target: boolean) => {
      if (!data) return
      const candidates = data.transactions.filter(
        (t) => selected.has(t.id) && t.is_checked !== target
      )
      // Fire toggles 5 at a time
      const queue = [...candidates]
      const work = async () => {
        while (queue.length) {
          const t = queue.shift()
          if (!t) break
          try {
            const updated = await api.toggleVarianceTransactionCheck(tbId, varianceId, t.id)
            patchTxn(updated)
          } catch {
            // Swallow per-row errors — let the rest of the batch run
          }
        }
      }
      await Promise.all([work(), work(), work(), work(), work()])
    },
    onSuccess: () => setSelected(new Set()),
  })

  const errDetail = (error as { response?: { data?: { detail?: string } }; message?: string } | undefined)
  const errMsg = errDetail?.response?.data?.detail ?? errDetail?.message

  const showFetchCTA = !enabled || (!data && !isLoading && !isFetching)
  const allSelected = data && data.transactions.length > 0 && selected.size === data.transactions.length
  const someSelected = selected.size > 0 && !allSelected

  function toggleAll() {
    if (!data) return
    if (selected.size === data.transactions.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(data.transactions.map((t) => t.id)))
    }
  }
  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  return (
    <div className="rounded-lg" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <div className="px-4 py-2.5 flex items-center gap-2"
        style={{ borderBottom: "1px solid var(--border)" }}>
        <ListOrdered size={13} strokeWidth={1.8} style={{ color: "var(--text-2)" }} />
        <h4 className="text-xs font-semibold text-theme flex-1">Transactions driving this variance</h4>
        {data && (
          <span className="text-[10px] font-medium" style={{ color: "var(--text-muted)" }}>
            {data.checked_count} / {data.total_count} reviewed
          </span>
        )}
        <Button
          size="sm"
          variant="outline"
          icon={<RotateCcw size={11} strokeWidth={1.8} className={refresh.isPending || isFetching ? "animate-spin" : undefined} />}
          loading={refresh.isPending}
          onClick={() => refresh.mutate()}
        >
          {data ? "Re-pull from QBO" : "Pull transactions"}
        </Button>
      </div>

      {errMsg && (
        <div className="px-4 py-2 text-[11px] flex items-start gap-1.5"
          style={{ color: "#b91c1c", background: "#fef2f2" }}>
          <AlertTriangle size={11} strokeWidth={1.8} className="mt-0.5 shrink-0" />
          {errMsg}
        </div>
      )}

      {/* Bulk-action toolbar appears whenever rows are selected */}
      {data && selected.size > 0 && (
        <div className="px-4 py-2 flex items-center gap-2 flex-wrap"
          style={{ background: "var(--green-subtle)", borderBottom: "1px solid var(--border)" }}>
          <span className="text-[11px] font-semibold" style={{ color: "var(--green)" }}>
            {selected.size} selected
          </span>
          <Button
            size="sm"
            variant="outline"
            icon={<CheckCircle2 size={11} strokeWidth={1.8} />}
            loading={bulkToggle.isPending}
            onClick={() => bulkToggle.mutate(true)}
          >
            Mark as checked
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<X size={11} strokeWidth={1.8} />}
            loading={bulkToggle.isPending}
            onClick={() => bulkToggle.mutate(false)}
          >
            Mark as unchecked
          </Button>
          <button
            onClick={() => setSelected(new Set())}
            className="ml-auto text-[11px] font-medium"
            style={{ color: "var(--text-muted)" }}
          >
            Clear selection
          </button>
        </div>
      )}

      {showFetchCTA ? (
        <p className="px-4 py-5 text-xs text-center" style={{ color: "var(--text-muted)" }}>
          Click <b>Pull transactions</b> to fetch the QBO postings that drove this variance.
        </p>
      ) : isLoading ? (
        <div className="py-6 flex items-center justify-center"><Spinner className="h-4 w-4" /></div>
      ) : !data || data.transactions.length === 0 ? (
        <p className="px-4 py-5 text-xs text-center" style={{ color: "var(--text-muted)" }}>
          No transactions found hitting this account between {""}
          <span className="font-mono">prior period end + 1</span> and current period end.
          If you expected something here, try the Reset + re-run from QBO to make sure this analysis
          captured the account's QBO id.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[700px] text-xs">
            <thead>
              <tr style={{ background: "var(--surface-2)" }}>
                <th className="px-3 py-2 text-center" style={{ color: "var(--text-muted)", width: 30 }}>
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={!!allSelected}
                    ref={(el) => { if (el) el.indeterminate = !!someSelected }}
                    onChange={toggleAll}
                  />
                </th>
                <th className="px-3 py-2 text-left font-semibold" style={{ color: "var(--text-muted)" }}>Type</th>
                <th className="px-3 py-2 text-left font-semibold" style={{ color: "var(--text-muted)" }}>#</th>
                <th className="px-3 py-2 text-left font-semibold" style={{ color: "var(--text-muted)" }}>Date</th>
                <th className="px-3 py-2 text-right font-semibold" style={{ color: "var(--text-muted)" }}>Amount</th>
                <th className="px-3 py-2 text-left font-semibold" style={{ color: "var(--text-muted)" }}>Entity</th>
                <th className="px-3 py-2 text-left font-semibold" style={{ color: "var(--text-muted)" }}>Memo</th>
                <th className="px-3 py-2 text-center font-semibold" style={{ color: "var(--text-muted)" }} title="Checked / approved">
                  ✓
                </th>
              </tr>
            </thead>
            <tbody>
              {data.transactions.map((t) => {
                const isSelected = selected.has(t.id)
                return (
                  <tr key={t.id}
                    style={{
                      borderTop: "1px solid var(--border)",
                      background: isSelected ? "var(--green-subtle)" : "transparent",
                    }}
                  >
                    <td className="px-3 py-2 text-center">
                      <input
                        type="checkbox"
                        aria-label={`Select ${t.txn_type} ${t.txn_number || ""}`}
                        checked={isSelected}
                        onChange={() => toggleOne(t.id)}
                      />
                    </td>
                    <td className="px-3 py-2 text-theme">{t.txn_type}</td>
                    <td className="px-3 py-2 font-mono" style={{ color: "var(--text-2)" }}>{t.txn_number || "—"}</td>
                    <td className="px-3 py-2" style={{ color: "var(--text-2)" }}>{t.txn_date || "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium"
                      style={{ color: parseFloat(t.amount) < 0 ? "#dc2626" : "var(--text)" }}>
                      {formatAccounting(t.amount, 0)}
                    </td>
                    <td className="px-3 py-2 truncate max-w-[140px]" style={{ color: "var(--text-2)" }}>{t.entity_name || "—"}</td>
                    <td className="px-3 py-2 truncate max-w-[200px]" style={{ color: "var(--text-muted)" }} title={t.memo}>{t.memo || "—"}</td>
                    <td className="px-3 py-2 text-center">
                      <button
                        onClick={() => toggle.mutate(t.id)}
                        disabled={toggle.isPending}
                        className="h-5 w-5 inline-flex items-center justify-center rounded transition-colors"
                        style={t.is_checked
                          ? { background: "var(--green)", color: "#fff" }
                          : { background: "var(--surface-2)", color: "var(--text-muted)", border: "1px solid var(--border-strong)" }}
                        title={t.is_checked ? `Checked${t.checked_at ? ` on ${new Date(t.checked_at).toLocaleString()}` : ""}` : "Mark as checked"}
                      >
                        {t.is_checked ? <CheckCircle2 size={12} strokeWidth={2.2} /> : <Check size={12} strokeWidth={2.2} />}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
            {/* Reconciliation footer: sum of pulled txns vs the GL variance.
                The amounts will match within rounding for QBO-sourced
                analyses; any gap reveals txns we didn't pull (very old,
                voided, or outside the date window). */}
            {data && data.transactions.length > 0 && (
              <tfoot>
                {(() => {
                  const sum = data.transactions.reduce(
                    (n, t) => n + (parseFloat(t.amount) || 0),
                    0,
                  )
                  const variance = parseFloat(expectedVariance) || 0
                  const diff = sum - variance
                  const inSync = Math.abs(diff) < 1
                  return (
                    <>
                      <tr style={{
                        background: "var(--surface-2)",
                        borderTop: "2px solid var(--border-strong)",
                      }}>
                        <td className="px-3 py-2 text-center" colSpan={4} />
                        <td className="px-3 py-2 text-right font-semibold text-theme">
                          Sum of pulled transactions
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums font-bold text-theme">
                          {formatAccounting(sum, 0)}
                        </td>
                        <td colSpan={2} />
                      </tr>
                      <tr style={{ background: "var(--surface-2)" }}>
                        <td className="px-3 py-1.5 text-center" colSpan={4} />
                        <td className="px-3 py-1.5 text-right text-xs"
                          style={{ color: "var(--text-muted)" }}>
                          GL variance for this account
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-xs"
                          style={{ color: "var(--text-2)" }}>
                          {formatAccounting(variance, 0)}
                        </td>
                        <td colSpan={2} />
                      </tr>
                      <tr style={{
                        background: inSync ? "var(--green-subtle)" : "#fef2f2",
                        borderTop: "1px solid var(--border)",
                      }}>
                        <td className="px-3 py-2 text-center" colSpan={4} />
                        <td className="px-3 py-2 text-right text-xs font-semibold"
                          style={{ color: inSync ? "var(--green)" : "#b91c1c" }}>
                          {inSync
                            ? "Reconciles to GL variance"
                            : "Unreconciled difference"}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums font-bold"
                          style={{ color: inSync ? "var(--green)" : "#b91c1c" }}>
                          {inSync
                            ? <CheckCircle2 size={14} strokeWidth={2} className="inline" />
                            : formatAccounting(diff, 0)
                          }
                        </td>
                        <td colSpan={2} />
                      </tr>
                    </>
                  )
                })()}
              </tfoot>
            )}
          </table>
        </div>
      )}
    </div>
  )
}
