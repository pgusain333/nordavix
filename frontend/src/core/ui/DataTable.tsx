/**
 * DataTable — the shared list primitive.
 *
 * Every list in the app was hand-rolled, so capability drifted: of 29 screens,
 * one had sorting, five had search, and the five schedule pages — the ones that
 * actually hold a hundred rows — had neither. Each one also re-solved loading,
 * empty and error states, usually by getting one of them wrong.
 *
 * WHY A REAL TABLE, NOT A GRID. The header and the rows used to be separate CSS
 * grids, so `auto` and bare `fr` tracks resolved independently in each and the
 * columns drifted a few pixels apart — a bug that took pixel measurements to
 * find, twice. `table-layout: fixed` with a <colgroup> makes the browser
 * guarantee one set of column edges. The whole class stops being possible.
 *
 * WHY CLIENT-SIDE. These lists are dozens to low hundreds of rows and the data
 * is already fetched. Sorting and filtering in memory needs no endpoint, no
 * pagination contract, and no second source of truth for a count. Past a few
 * thousand rows this would need to move server-side; nothing here is close.
 *
 * Built in: sorting (nulls always sink), search, declarative filters, density,
 * column visibility, CSV export of the CURRENT view, optional row selection,
 * and four distinct states — loading, error, empty, and filtered-to-nothing,
 * which is a different message from "you have no data".
 *
 * Preferences persist per `id` in localStorage. Per-viewer convenience only:
 * named saved views that follow a user across devices need a table and a
 * migration, and are deliberately not here yet.
 */
import {
  useCallback, useDeferredValue, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from "react"
import {
  ChevronDown, ChevronUp, Columns3, Download, Rows3, Search, X,
} from "lucide-react"
import { SkeletonRow } from "./Skeleton"

// ── Types ────────────────────────────────────────────────────────────────────

export interface Column<T> {
  key:    string
  header: string
  /** Feeds <colgroup>. "auto" takes the remaining space; give at most one or
   *  two columns auto, and px to the rest, or the layout has nothing to solve. */
  width?: string
  align?: "left" | "right" | "center"
  cell:   (row: T) => ReactNode
  /** Present ⇒ the header is clickable. Return null for "no value"; nulls sink
   *  to the bottom whichever way the arrow points. */
  sortValue?: (row: T) => string | number | null
  /** Plain text for search and CSV. Falls back to a string sortValue. */
  text?:  (row: T) => string
  /** Offer this column in the chooser. Defaults to true. */
  hideable?: boolean
  defaultHidden?: boolean
  /** Allow this cell to wrap onto more lines. Off by default, and rarely
   *  worth turning on: one wrapping cell sets the height of its whole row, so
   *  a list's rhythm ends up decided by whichever record has the longest
   *  value. */
  wrap?: boolean
}

export interface FilterDef<T> {
  key:     string
  label:   string
  options: { value: string; label: string }[]
  /** Called only for a non-"all" value. */
  test:    (row: T, value: string) => boolean
}

export interface DataTableProps<T> {
  /** Stable key for persisted preferences. Namespace it: "schedules.prepaids". */
  id:      string
  rows:    T[]
  columns: Column<T>[]
  rowKey:  (row: T) => string

  isLoading?: boolean
  error?:     unknown
  onRetry?:   () => void

  search?:  boolean | { placeholder?: string }
  filters?: FilterDef<T>[]
  defaultSort?: { key: string; dir: "asc" | "desc" }
  /** Order used before any sort is chosen, and as the tiebreak after one is.
   *  Without it, equal values reshuffle between renders. */
  defaultOrder?: (a: T, b: T) => number

  onRowClick?: (row: T) => void
  /** Trailing actions column. Clicks inside it don't trigger onRowClick. */
  actions?:    (row: T) => ReactNode
  actionsWidth?: string
  selection?:  { render: (rows: T[], clear: () => void) => ReactNode }

  empty?: { title: string; body?: string; action?: ReactNode }
  /** Omit to hide the export button. ".csv" is appended. */
  exportFilename?: string
  /** Extra controls in the toolbar, left of the density/column buttons. */
  toolbarExtra?: ReactNode
  minWidth?: string
  density?: "comfortable" | "compact"
}

type Dir = "asc" | "desc"
type Prefs = {
  sortKey?: string; sortDir?: Dir
  density?: "comfortable" | "compact"
  hidden?: string[]
}

// ── Preference persistence ───────────────────────────────────────────────────

const PREF_KEY = (id: string) => `ndvx_table_${id}`

function readPrefs(id: string): Prefs {
  try {
    const raw = localStorage.getItem(PREF_KEY(id))
    return raw ? (JSON.parse(raw) as Prefs) : {}
  } catch {
    return {}                                  // private mode, blocked storage
  }
}

function writePrefs(id: string, p: Prefs): void {
  try { localStorage.setItem(PREF_KEY(id), JSON.stringify(p)) } catch { /* ignore */ }
}

// ── Cell text, for search and CSV ────────────────────────────────────────────

function cellText<T>(col: Column<T>, row: T): string {
  if (col.text) return col.text(row)
  const v = col.sortValue?.(row)
  return v == null ? "" : String(v)
}

/** RFC 4180: quote when the value contains a comma, quote or newline, and
 *  double any embedded quotes. Excel mangles the alternatives. */
function csvCell(s: string): string {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

// ── Component ────────────────────────────────────────────────────────────────

export function DataTable<T>({
  id, rows, columns, rowKey,
  isLoading, error, onRetry,
  search, filters, defaultSort, defaultOrder,
  onRowClick, actions, actionsWidth = "96px", selection,
  empty, exportFilename, toolbarExtra,
  minWidth, density: densityProp,
}: DataTableProps<T>) {
  const saved = useRef<Prefs>(readPrefs(id)).current

  // State is declared BEFORE anything that reads it in a closure — a memo or
  // query option referring to a `const` declared below it throws at runtime and
  // the build does not catch it.
  const [query, setQuery] = useState("")
  const [filterVals, setFilterVals] = useState<Record<string, string>>({})
  const [sort, setSort] = useState<{ key: string; dir: Dir } | null>(
    saved.sortKey ? { key: saved.sortKey, dir: saved.sortDir ?? "asc" }
      : defaultSort ?? null,
  )
  const [density, setDensity] = useState<"comfortable" | "compact">(
    densityProp ?? saved.density ?? "comfortable",
  )
  const [hidden, setHidden] = useState<Set<string>>(
    () => new Set(saved.hidden ?? columns.filter((c) => c.defaultHidden).map((c) => c.key)),
  )
  const [picker, setPicker] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const deferredQuery = useDeferredValue(query)

  useEffect(() => {
    writePrefs(id, {
      sortKey: sort?.key, sortDir: sort?.dir,
      density, hidden: [...hidden],
    })
  }, [id, sort, density, hidden])

  const visible = useMemo(
    () => columns.filter((c) => !hidden.has(c.key)),
    [columns, hidden],
  )

  const searchable = search !== undefined && search !== false
  const placeholder = typeof search === "object" ? search.placeholder : "Search…"

  const activeFilters = useMemo(
    () => Object.entries(filterVals).filter(([, v]) => v && v !== "all"),
    [filterVals],
  )
  const isFiltered = activeFilters.length > 0 || deferredQuery.trim() !== ""

  // ── Filter, then sort ──────────────────────────────────────────────────────
  const view = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase()
    let out = rows.filter((row) => {
      for (const [key, val] of activeFilters) {
        const def = filters?.find((f) => f.key === key)
        if (def && !def.test(row, val)) return false
      }
      if (!q) return true
      // Search spans VISIBLE columns only: a hit you cannot see on screen reads
      // as the filter being broken.
      return visible.some((c) => cellText(c, row).toLowerCase().includes(q))
    })

    const base = defaultOrder ?? (() => 0)
    if (sort) {
      const col = columns.find((c) => c.key === sort.key)
      if (col?.sortValue) {
        const dir = sort.dir === "asc" ? 1 : -1
        out = [...out].sort((a, b) => {
          const av = col.sortValue!(a)
          const bv = col.sortValue!(b)
          // Empty sinks in BOTH directions: a row with no value is not "the
          // most" of anything just because the arrow was reversed.
          if (av == null && bv == null) return base(a, b)
          if (av == null) return 1
          if (bv == null) return -1
          const an = typeof av === "string" ? av.toLowerCase() : av
          const bn = typeof bv === "string" ? bv.toLowerCase() : bv
          if (an < bn) return -1 * dir
          if (an > bn) return 1 * dir
          return base(a, b)
        })
      }
    } else if (defaultOrder) {
      out = [...out].sort(base)
    }
    return out
  }, [rows, columns, visible, filters, activeFilters, deferredQuery, sort, defaultOrder])

  // Selection is scoped to what's on screen: acting on rows a filter has hidden
  // is the kind of surprise that costs trust once.
  const visibleKeys = useMemo(() => new Set(view.map(rowKey)), [view, rowKey])
  const selectedRows = useMemo(
    () => view.filter((r) => selected.has(rowKey(r))),
    [view, selected, rowKey],
  )
  useEffect(() => {
    setSelected((prev) => {
      const next = new Set([...prev].filter((k) => visibleKeys.has(k)))
      return next.size === prev.size ? prev : next
    })
  }, [visibleKeys])

  const toggleSort = useCallback((key: string) => {
    setSort((s) => {
      if (s?.key === key) return { key, dir: s.dir === "asc" ? "desc" : "asc" }
      const col = columns.find((c) => c.key === key)
      // First click picks the direction that reads best: text A→Z, numbers
      // largest-first, since a numeric column is usually a "worst offender" list.
      const sample = col?.sortValue ? rows.map((r) => col.sortValue!(r)).find((v) => v != null) : null
      return { key, dir: typeof sample === "number" ? "desc" : "asc" }
    })
  }, [columns, rows])

  function clearAll() {
    setQuery("")
    setFilterVals({})
  }

  function exportCsv() {
    const head = visible.map((c) => csvCell(c.header)).join(",")
    const body = view.map((r) => visible.map((c) => csvCell(cellText(c, r))).join(",")).join("\n")
    // BOM so Excel reads the file as UTF-8 rather than the system codepage —
    // without it any name with an accent arrives mangled. Written as an escape,
    // never as a literal character: an invisible byte in source does not
    // survive every editor and tool, and it did not survive the first time.
    const blob = new Blob(
      [`\uFEFF${head}\n${body}`],
      { type: "text/csv;charset=utf-8" },
    )
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${exportFilename}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const rowPad = density === "compact" ? "py-1" : "py-1.5"
  const control = {
    background: "var(--surface)",
    border: "1px solid var(--border-strong)",
    color: "var(--text)",
  }

  // ── Toolbar ────────────────────────────────────────────────────────────────
  const toolbar = (searchable || filters?.length || exportFilename || toolbarExtra) ? (
    <div className="flex items-center gap-2 flex-wrap mb-3">
      {searchable && (
        <div className="relative">
          <Search size={13} strokeWidth={2}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
            style={{ color: "var(--text-muted)" }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={placeholder}
            aria-label={placeholder}
            className="rounded-lg pl-8 pr-3 py-1.5 text-xs w-56 outline-none"
            style={control}
          />
        </div>
      )}

      {filters?.map((f) => (
        <select
          key={f.key}
          aria-label={f.label}
          value={filterVals[f.key] ?? "all"}
          onChange={(e) => setFilterVals((v) => ({ ...v, [f.key]: e.target.value }))}
          className="rounded-lg px-2.5 py-1.5 text-xs font-medium outline-none"
          style={control}
        >
          <option value="all">{f.label}</option>
          {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ))}

      {isFiltered && (
        <button onClick={clearAll}
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-semibold transition-opacity hover:opacity-80"
          style={{ color: "var(--text-muted)" }}>
          <X size={11} strokeWidth={2.4} /> Clear
        </button>
      )}

      {toolbarExtra}

      <div className="ml-auto flex items-center gap-1.5">
        <span className="text-[11px] tabular-nums mr-1" style={{ color: "var(--text-muted)" }}>
          {isFiltered ? `${view.length} of ${rows.length}` : `${rows.length}`}
        </span>

        <button
          onClick={() => setDensity((d) => (d === "compact" ? "comfortable" : "compact"))}
          title={density === "compact" ? "Comfortable rows" : "Compact rows"}
          aria-label="Toggle row density"
          className="h-7 w-7 inline-flex items-center justify-center rounded-lg transition-colors hover:bg-[var(--surface-2)]"
          style={{ color: "var(--text-muted)", border: "1px solid var(--border-strong)" }}>
          <Rows3 size={13} strokeWidth={1.9} />
        </button>

        {columns.some((c) => c.hideable !== false) && (
          <div className="relative">
            <button
              onClick={() => setPicker((v) => !v)}
              title="Columns" aria-label="Choose columns" aria-expanded={picker}
              className="h-7 w-7 inline-flex items-center justify-center rounded-lg transition-colors hover:bg-[var(--surface-2)]"
              style={{ color: "var(--text-muted)", border: "1px solid var(--border-strong)" }}>
              <Columns3 size={13} strokeWidth={1.9} />
            </button>
            {picker && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setPicker(false)} />
                <div className="absolute right-0 mt-1 z-20 rounded-lg py-1 min-w-[180px]"
                  style={{ background: "var(--surface)", border: "1px solid var(--border-strong)", boxShadow: "var(--card-shadow)" }}>
                  {columns.filter((c) => c.hideable !== false).map((c) => (
                    <label key={c.key}
                      className="flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer hover:bg-[var(--surface-2)]"
                      style={{ color: "var(--text)" }}>
                      <input
                        type="checkbox"
                        checked={!hidden.has(c.key)}
                        onChange={() => setHidden((h) => {
                          const n = new Set(h)
                          if (n.has(c.key)) n.delete(c.key)
                          // Never hide the last column — an empty table has no
                          // way back except clearing storage.
                          else if (visible.length > 1) n.add(c.key)
                          return n
                        })}
                      />
                      {c.header || c.key}
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {exportFilename && (
          <button
            onClick={exportCsv}
            disabled={view.length === 0}
            title="Export this view to CSV" aria-label="Export to CSV"
            className="h-7 w-7 inline-flex items-center justify-center rounded-lg transition-colors hover:bg-[var(--surface-2)] disabled:opacity-40"
            style={{ color: "var(--text-muted)", border: "1px solid var(--border-strong)" }}>
            <Download size={13} strokeWidth={1.9} />
          </button>
        )}
      </div>
    </div>
  ) : null

  const shell = (children: ReactNode) => (
    <div>
      {toolbar}
      {children}
      {selection && selectedRows.length > 0 && (
        <div className="sticky bottom-4 mt-3 mx-auto w-fit rounded-xl px-3 py-2 flex items-center gap-3 z-20"
          style={{ background: "var(--surface)", border: "1px solid var(--border-strong)", boxShadow: "var(--card-shadow)" }}>
          <span className="text-xs font-semibold" style={{ color: "var(--text)" }}>
            {selectedRows.length} selected
          </span>
          {selection.render(selectedRows, () => setSelected(new Set()))}
          <button onClick={() => setSelected(new Set())}
            className="text-xs font-semibold" style={{ color: "var(--text-muted)" }}>
            Clear
          </button>
        </div>
      )}
    </div>
  )

  // ── The four states ────────────────────────────────────────────────────────

  if (isLoading) {
    return shell(
      <div className="rounded-xl overflow-hidden p-2 space-y-1.5"
        style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
        {[0, 1, 2, 3, 4].map((i) => <SkeletonRow key={i} />)}
      </div>,
    )
  }

  if (error) {
    return shell(
      <div className="rounded-xl px-4 py-3 flex items-center gap-3"
        style={{ background: "var(--danger-subtle)", border: "1px solid var(--danger-border)", color: "var(--danger)" }}>
        <p className="text-sm flex-1">Couldn't load this list.</p>
        {onRetry && (
          <button onClick={onRetry} className="text-xs font-bold underline underline-offset-2">Retry</button>
        )}
      </div>,
    )
  }

  // "You have no data" and "your filters match nothing" are different problems
  // with different fixes, and showing the first for the second sends the user
  // looking for data they already have.
  if (view.length === 0) {
    return shell(
      <div className="rounded-xl px-6 py-10 text-center"
        style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
        {isFiltered ? (
          <>
            <p className="text-sm font-semibold" style={{ color: "var(--text)" }}>
              Nothing matches these filters
            </p>
            <button onClick={clearAll}
              className="text-xs font-bold underline underline-offset-2 mt-1.5"
              style={{ color: "var(--green)" }}>
              Clear filters
            </button>
          </>
        ) : (
          <>
            <p className="text-sm font-semibold" style={{ color: "var(--text)" }}>
              {empty?.title ?? "Nothing here yet"}
            </p>
            {empty?.body && (
              <p className="text-xs mt-1 max-w-md mx-auto" style={{ color: "var(--text-muted)" }}>
                {empty.body}
              </p>
            )}
            {empty?.action && <div className="mt-3">{empty.action}</div>}
          </>
        )}
      </div>,
    )
  }

  const allOnScreenSelected = view.length > 0 && selectedRows.length === view.length

  return shell(
    <div className="rounded-xl overflow-hidden overflow-x-auto"
      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <table className="w-full" style={{ tableLayout: "fixed", borderCollapse: "collapse", minWidth }}>
        {/* The alignment guarantee: one set of column edges for head and body. */}
        <colgroup>
          {selection && <col style={{ width: "36px" }} />}
          {visible.map((c) => <col key={c.key} style={{ width: c.width ?? "auto" }} />)}
          {actions && <col style={{ width: actionsWidth }} />}
        </colgroup>

        <thead>
          <tr style={{ background: "var(--surface-2)" }}>
            {selection && (
              <th className="px-3 py-1.5" style={{ borderBottom: "1px solid var(--border)" }}>
                <input
                  type="checkbox"
                  aria-label="Select all rows on screen"
                  checked={allOnScreenSelected}
                  onChange={() => setSelected(allOnScreenSelected
                    ? new Set()
                    : new Set(view.map(rowKey)))}
                />
              </th>
            )}
            {visible.map((c) => {
              const active = sort?.key === c.key
              const sortable = !!c.sortValue
              return (
                <th key={c.key}
                  scope="col"
                  aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : undefined}
                  className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider select-none"
                  style={{
                    color: active ? "var(--text)" : "var(--text-muted)",
                    textAlign: c.align ?? "left",
                    borderBottom: "1px solid var(--border)",
                    cursor: sortable ? "pointer" : "default",
                  }}
                  onClick={sortable ? () => toggleSort(c.key) : undefined}
                >
                  <span className="inline-flex items-center gap-1">
                    {c.header}
                    {active && (sort!.dir === "asc"
                      ? <ChevronUp size={11} strokeWidth={2.6} />
                      : <ChevronDown size={11} strokeWidth={2.6} />)}
                  </span>
                </th>
              )
            })}
            {actions && <th style={{ borderBottom: "1px solid var(--border)" }} />}
          </tr>
        </thead>

        <tbody>
          {view.map((row) => {
            const k = rowKey(row)
            return (
              <tr key={k}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={onRowClick ? "cursor-pointer transition-colors hover:bg-[var(--surface-2)]" : ""}
                style={{ borderBottom: "1px solid var(--border)" }}
              >
                {selection && (
                  <td className={`px-3 ${rowPad}`} onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label="Select row"
                      checked={selected.has(k)}
                      onChange={() => setSelected((s) => {
                        const n = new Set(s)
                        if (n.has(k)) n.delete(k); else n.add(k)
                        return n
                      })}
                    />
                  </td>
                )}
                {visible.map((c) => (
                  // nowrap AND overflow-hidden. Clipping alone is not enough:
                  // a cell whose content can wrap still grows the row, and the
                  // primitive cannot rely on every consumer remembering to add
                  // `truncate` to whatever it renders. Measured on Prepaids —
                  // one date-range cell wrapped and took its row from 37px to
                  // 61px while every other row stayed at 37.
                  <td key={c.key}
                    className={`px-3 ${rowPad} overflow-hidden ${c.wrap ? "" : "whitespace-nowrap"}`}
                    style={{ textAlign: c.align ?? "left" }}>
                    {c.cell(row)}
                  </td>
                ))}
                {actions && (
                  // Row actions must not also trigger the row's own click.
                  <td className={`px-3 ${rowPad} text-right`} onClick={(e) => e.stopPropagation()}>
                    {actions(row)}
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>,
  )
}
