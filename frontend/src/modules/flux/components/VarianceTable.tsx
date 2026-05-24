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
  ListOrdered,
  RotateCcw,
  X,
} from "lucide-react"
import { api, type VarianceRow, type VarianceTransactionsResponse } from "@/modules/flux/api"
import { Button, Badge, StatusBadge, Spinner } from "@/core/ui/components"
import { cn, formatAccounting, formatPct } from "@/core/ui/utils"

interface Props {
  tbId:      string
  rows:      VarianceRow[]
  isLoading: boolean
  onExport:  () => void
  /** Period end dates for column headers — displayed as "MMM DD YYYY (CY/PY)" */
  periodCurrent?: string  // ISO date
  periodPrior?:   string
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

export function VarianceTable({ tbId, rows, isLoading, onExport, periodCurrent, periodPrior }: Props) {
  const qc = useQueryClient()
  const [sorting,    setSorting]   = useState<SortingState>([
    { id: "is_material", desc: true },
  ])
  const [filter, setFilter]       = useState<"all" | "material" | "pending">("all")
  const [expandedRow, setExpanded] = useState<string | null>(null)
  const [editingRow,  setEditing]  = useState<string | null>(null)
  const [editContent, setEditContent] = useState("")

  // ── Approve mutation ───────────────────────────────────────────────────────
  const approve = useMutation({
    mutationFn: (varId: string) => api.approveVariance(tbId, varId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["variances", tbId] }),
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

  // ── Regenerate (per-variance AI rerun) ────────────────────────────────────
  const regenerate = useMutation({
    mutationFn: (varId: string) => api.regenerateNarrative(tbId, varId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["variances", tbId] }),
  })

  // ── Filter data ────────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    if (filter === "material") return rows.filter((r) => r.is_material)
    if (filter === "pending")  return rows.filter((r) =>
      ["pending", "generating", "generated"].includes(r.status)
    )
    return rows
  }, [rows, filter])

  // ── Columns ────────────────────────────────────────────────────────────────
  const columns = useMemo(() => [
    col.accessor("account_number", {
      header: "Account No.",
      size:   90,
      cell: (c) => (
        <span className="font-mono text-xs" style={{ color: "var(--text-2)" }}>{c.getValue()}</span>
      ),
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
    col.accessor("is_material", {
      header: "Material",
      size:   80,
      sortingFn: (a, b) =>
        (b.original.is_material ? 1 : 0) - (a.original.is_material ? 1 : 0),
      cell: (c) =>
        c.getValue() ? (
          <Badge variant="material" dot>Material</Badge>
        ) : null,
    }),
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
        return (
          <div className="flex items-center gap-1.5 justify-end">
            {r.status !== "approved" && (
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
  ], [approve, tbId, periodCurrent, periodPrior])

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
  const materialCount = rows.filter((r) => r.is_material).length
  const pendingCount  = rows.filter((r) =>
    ["pending", "generating", "generated"].includes(r.status)
  ).length

  return (
    <div className="flex flex-col h-full" style={{ background: "var(--bg)" }}>
      {/* Toolbar */}
      <div
        className="flex items-center gap-3 px-5 py-3"
        style={{ borderBottom: "1px solid var(--border)", background: "var(--surface)" }}
      >
        <div
          className="flex items-center gap-1 rounded-lg p-0.5"
          style={{ background: "var(--surface-2)" }}
        >
          {(["all", "material", "pending"] as const).map((f) => (
            <button
              key={f}
              className={cn(
                "px-2.5 py-1 rounded-md text-xs font-medium transition-colors",
              )}
              style={
                filter === f
                  ? { background: "var(--surface)", color: "var(--text)", boxShadow: "var(--card-shadow)" }
                  : { color: "var(--text-muted)" }
              }
              onMouseEnter={(e) => { if (filter !== f) (e.currentTarget as HTMLElement).style.color = "var(--text)" }}
              onMouseLeave={(e) => { if (filter !== f) (e.currentTarget as HTMLElement).style.color = "var(--text-muted)" }}
              onClick={() => setFilter(f)}
            >
              {f === "all"      ? `All (${rows.length})` :
               f === "material" ? `Material (${materialCount})` :
                                  `Pending (${pendingCount})`}
            </button>
          ))}
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

      {/* Table */}
      <div className="flex-1 overflow-auto" style={{ background: "var(--bg)" }}>
        {isLoading ? (
          <div className="flex items-center justify-center h-full">
            <div className="flex items-center gap-2 text-sm" style={{ color: "var(--text-muted)" }}>
              <Spinner />
              Loading variances…
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center py-12">
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
          <table className="w-full text-sm border-separate border-spacing-0">
            <thead className="sticky top-0 z-10">
              <tr style={{ background: "var(--surface-2)" }}>
                {table.getFlatHeaders().map((header) => (
                  <th
                    key={header.id}
                    className={cn(
                      "px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide select-none",
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
                const isMaterial = row.original.is_material
                return (
                  <Fragment key={row.id}>
                    <tr
                      className="cursor-pointer transition-colors"
                      style={{
                        // Material rows get a subtle amber tint that works in both themes;
                        // expanded rows pick up the secondary surface color.
                        background: isExpanded
                          ? "var(--surface-2)"
                          : isMaterial
                            ? "rgba(245, 158, 11, 0.08)"
                            : "var(--surface)",
                        borderBottom: "1px solid var(--border)",
                      }}
                      onMouseEnter={(e) => {
                        if (!isExpanded) {
                          (e.currentTarget as HTMLElement).style.background = isMaterial
                            ? "rgba(245, 158, 11, 0.14)"
                            : "var(--surface-2)"
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!isExpanded) {
                          (e.currentTarget as HTMLElement).style.background = isMaterial
                            ? "rgba(245, 158, 11, 0.08)"
                            : "var(--surface)"
                        }
                      }}
                      onClick={() =>
                        setExpanded((p) => p === row.original.id ? null : row.original.id)
                      }
                    >
                      {row.getVisibleCells().map((cell) => (
                        <td key={cell.id} className="px-3 py-2.5">
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      ))}
                    </tr>

                    {/* Expanded narrative row */}
                    {isExpanded && (
                      <tr style={{ background: "var(--surface-2)" }}>
                        <td
                          colSpan={columns.length}
                          className="px-5 py-4"
                          style={{ borderBottom: "1px solid var(--border)" }}
                        >
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
                            onRegenerate={() => regenerate.mutate(row.original.id)}
                            isRegenerating={regenerate.isPending && regenerate.variables === row.original.id}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Footer summary */}
      {!isLoading && rows.length > 0 && (
        <div
          className="px-5 py-2.5"
          style={{ borderTop: "1px solid var(--border)", background: "var(--surface)" }}
        >
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            {rows.filter((r) => r.status === "approved").length} of {rows.length} variances approved
            {materialCount > 0 && ` · ${materialCount} material`}
          </p>
        </div>
      )}
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
  onRegenerate:  () => void
  isRegenerating:boolean
}

function NarrativePanel({
  row, tbId, isEditing, editContent, onEditContent,
  onEdit, onSave, onCancel, isSaving,
  onRegenerate, isRegenerating,
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
            {/* Approver stamp — only shown once this variance has been signed off */}
            {row.approved_at && (
              <p className="text-[11px] flex items-center gap-1.5" style={{ color: "var(--green)" }}>
                <CheckCircle2 size={11} strokeWidth={2} />
                Approved on {new Date(row.approved_at).toLocaleString()}
              </p>
            )}
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={onRegenerate}
                loading={isRegenerating}
                icon={!isRegenerating ? <Sparkles size={12} strokeWidth={1.8} /> : undefined}
                title="Have the AI re-analyze this variance from scratch"
              >
                {row.narrative ? "Regenerate" : "Find reason"}
              </Button>
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

      {/* Transactions drill-in — only for material variances */}
      {row.is_material && (
        <VarianceTxnsSection tbId={tbId} varianceId={row.id} />
      )}
    </div>
  )
}

// ── VarianceTxnsSection ───────────────────────────────────────────────────────
// Lists the QBO transactions hitting this variance's account in the period.
// First click "Pull transactions" hits QBO; once fetched the rows are stored
// server-side so subsequent expands are instant. Each row has a check toggle
// that the reviewer flips as they investigate — backed by an audit-logged
// flip on the server.

function VarianceTxnsSection({ tbId, varianceId }: { tbId: string; varianceId: string }) {
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
          <table className="w-full text-xs">
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
          </table>
        </div>
      )}
    </div>
  )
}
