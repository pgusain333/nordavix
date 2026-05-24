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
import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  CheckCircle2,
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
  Pencil,
  AlertTriangle,
  Sparkles,
  Filter,
  Download,
} from "lucide-react"
import { api, type VarianceRow } from "@/modules/flux/api"
import { Button, Badge, StatusBadge, Spinner } from "@/core/ui/components"
import { cn, formatAccounting, formatPct } from "@/core/ui/utils"

interface Props {
  tbId:      string
  rows:      VarianceRow[]
  isLoading: boolean
  onExport:  () => void
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

export function VarianceTable({ tbId, rows, isLoading, onExport }: Props) {
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
      header: "Account #",
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
      header: "Current",
      size:   110,
      cell: (c) => (
        <span className="tabular-nums text-sm text-right block text-theme">
          {formatAccounting(c.getValue(), 0)}
        </span>
      ),
    }),
    col.accessor("prior_balance", {
      header: "Prior",
      size:   110,
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
  ], [approve, tbId])

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
  row, isEditing, editContent, onEditContent,
  onEdit, onSave, onCancel, isSaving,
  onRegenerate, isRegenerating,
}: NarrativePanelProps) {
  const anomalyLabels: Record<string, string> = {
    new_account:        "New account",
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
    </div>
  )
}
