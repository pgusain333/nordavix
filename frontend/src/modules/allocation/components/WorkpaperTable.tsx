/**
 * WorkpaperTable — the per-account allocation detail.
 *
 * This is the workpaper body a reviewer actually reads, so it behaves like a
 * working tool rather than a static list: search, filter by pool and treatment,
 * sort any column, group by pool with subtotals, and a totals row that always
 * reflects what's currently on screen.
 *
 * Two deliberate details:
 *   • The totals row shows the FILTERED total and says so when a filter is on,
 *     so a subtotal can never be mistaken for the run total.
 *   • Amounts are formatted from Decimal strings and never parsed into floats
 *     for arithmetic — the only sums computed here are for display, and they're
 *     done in integer cents to avoid drift.
 */
import { useMemo, useState } from "react"
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Search, X } from "lucide-react"
import { Input, Select } from "@/core/ui"
import { money, type RunLine, type Treatment } from "../api"

type SortKey = "account" | "pool" | "gross" | "capitalized" | "disallowed" | "rate"

const TREATMENT_LABEL: Record<Treatment, string> = {
  direct: "Direct", allocated: "Allocated", excluded: "Excluded",
}
const TREATMENT_TONE: Record<Treatment, string> = {
  direct: "var(--positive)", allocated: "var(--info)", excluded: "var(--text-muted)",
}

/** Sum decimal strings in integer cents — no float drift. */
function sumCents(rows: RunLine[], key: keyof RunLine): number {
  return rows.reduce((acc, r) => acc + Math.round(Number(r[key] as string) * 100), 0)
}
const fromCents = (c: number) => (c / 100).toFixed(2)

export function WorkpaperTable({ lines }: { lines: RunLine[] }) {
  const [search, setSearch] = useState("")
  const [pool, setPool] = useState<string>("")
  const [treatment, setTreatment] = useState<string>("")
  const [sortKey, setSortKey] = useState<SortKey>("gross")
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc")
  const [grouped, setGrouped] = useState(true)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const pools = useMemo(
    () => Array.from(new Set(lines.map((l) => l.pool_name))).sort(),
    [lines],
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return lines.filter((l) => {
      if (pool && l.pool_name !== pool) return false
      if (treatment && l.treatment !== treatment) return false
      if (!q) return true
      return (
        (l.account_name ?? "").toLowerCase().includes(q) ||
        (l.account_number ?? "").toLowerCase().includes(q) ||
        l.pool_name.toLowerCase().includes(q)
      )
    })
  }, [lines, search, pool, treatment])

  const sorted = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1
    const num = (v: string) => Number(v) || 0
    return [...filtered].sort((a, b) => {
      switch (sortKey) {
        case "account":
          return dir * `${a.account_number ?? ""}${a.account_name ?? ""}`
            .localeCompare(`${b.account_number ?? ""}${b.account_name ?? ""}`)
        case "pool":        return dir * a.pool_name.localeCompare(b.pool_name)
        case "rate":        return dir * (num(a.driver_pct) - num(b.driver_pct))
        case "capitalized": return dir * (num(a.capitalized_amount) - num(b.capitalized_amount))
        case "disallowed":  return dir * (num(a.disallowed_amount) - num(b.disallowed_amount))
        default:            return dir * (num(a.gross_amount) - num(b.gross_amount))
      }
    })
  }, [filtered, sortKey, sortDir])

  const groups = useMemo(() => {
    if (!grouped) return null
    const m = new Map<string, RunLine[]>()
    for (const l of sorted) {
      const arr = m.get(l.pool_name)
      if (arr) arr.push(l); else m.set(l.pool_name, [l])
    }
    return Array.from(m.entries())
  }, [sorted, grouped])

  const totals = useMemo(() => ({
    gross: sumCents(filtered, "gross_amount"),
    cap:   sumCents(filtered, "capitalized_amount"),
    dis:   sumCents(filtered, "disallowed_amount"),
  }), [filtered])

  const isFiltered = !!(search.trim() || pool || treatment)

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    else { setSortKey(k); setSortDir(k === "account" || k === "pool" ? "asc" : "desc") }
  }
  function toggleGroup(name: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name); else next.add(name)
      return next
    })
  }
  function clearFilters() { setSearch(""); setPool(""); setTreatment("") }

  const COLS = "minmax(0,2.2fr) 1fr 0.8fr 1fr 1fr 1fr"

  const SortHead = ({ k, label, right }: { k: SortKey; label: string; right?: boolean }) => (
    <button onClick={() => toggleSort(k)}
      className={`inline-flex items-center gap-1 ${right ? "justify-end" : ""} hover:opacity-80`}
      style={{ color: sortKey === k ? "var(--text)" : "var(--text-muted)" }}>
      {label}
      {sortKey === k && (sortDir === "asc"
        ? <ArrowUp size={11} strokeWidth={2.2} /> : <ArrowDown size={11} strokeWidth={2.2} />)}
    </button>
  )

  const Row = ({ l }: { l: RunLine }) => (
    <div className="grid gap-3 items-center px-4 py-2 text-[13px]"
      style={{ gridTemplateColumns: COLS, borderTop: "1px solid var(--border)" }}>
      <div className="min-w-0">
        <span className="text-theme truncate block">
          {l.account_name || l.qbo_account_id}
          {l.account_number && (
            <span className="ml-1.5 text-[11px]" style={{ color: "var(--text-muted)" }}>
              {l.account_number}
            </span>
          )}
        </span>
      </div>
      <span className="truncate text-[12px]" style={{ color: "var(--text-2)" }}>{l.pool_name}</span>
      <span className="text-[11px] font-medium" style={{ color: TREATMENT_TONE[l.treatment] }}>
        {TREATMENT_LABEL[l.treatment]}
      </span>
      <span className="text-right tabular-nums" style={{ color: "var(--text-2)" }}>
        {l.treatment === "allocated" ? `${(Number(l.driver_pct) * 100).toFixed(2)}%` : "—"}
      </span>
      <span className="text-right tabular-nums" style={{ color: "var(--text-2)" }}>
        {money(l.gross_amount)}
      </span>
      <span className="text-right tabular-nums font-medium"
        style={{ color: Number(l.capitalized_amount) !== 0 ? "var(--green)" : "var(--text-muted)" }}>
        {money(l.capitalized_amount)}
      </span>
    </div>
  )

  return (
    <div className="space-y-2.5">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px]">
          <Search size={14} strokeWidth={1.8}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
            style={{ color: "var(--text-muted)" }} />
          <Input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search accounts…" style={{ paddingLeft: 30 }} />
        </div>
        <Select value={pool} onChange={(e) => setPool(e.target.value)} style={{ width: "auto", minWidth: 150 }}>
          <option value="">All pools</option>
          {pools.map((p) => <option key={p} value={p}>{p}</option>)}
        </Select>
        <Select value={treatment} onChange={(e) => setTreatment(e.target.value)} style={{ width: "auto", minWidth: 130 }}>
          <option value="">All treatments</option>
          <option value="direct">Direct</option>
          <option value="allocated">Allocated</option>
          <option value="excluded">Excluded</option>
        </Select>
        <button onClick={() => setGrouped((g) => !g)}
          className="rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors"
          style={grouped
            ? { background: "var(--green-subtle)", color: "var(--green)", border: "1px solid var(--green)" }
            : { background: "var(--surface)", color: "var(--text-2)", border: "1px solid var(--border)" }}>
          Group by pool
        </button>
        {isFiltered && (
          <button onClick={clearFilters}
            className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[12px]"
            style={{ color: "var(--text-2)", border: "1px solid var(--border)" }}>
            <X size={12} strokeWidth={2} /> Clear
          </button>
        )}
      </div>

      <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
        Showing {filtered.length} of {lines.length} accounts
      </p>

      {/* Table */}
      <div className="rounded-xl overflow-hidden"
        style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
        <div className="grid gap-3 px-4 py-2.5 text-[11px] sticky top-0 z-10"
          style={{ gridTemplateColumns: COLS, background: "var(--surface-2)",
                   borderBottom: "1px solid var(--border)" }}>
          <SortHead k="account" label="Account" />
          <SortHead k="pool" label="Pool" />
          <span style={{ color: "var(--text-muted)" }}>Treatment</span>
          <span className="text-right"><SortHead k="rate" label="Rate" right /></span>
          <span className="text-right"><SortHead k="gross" label="Gross" right /></span>
          <span className="text-right"><SortHead k="capitalized" label="Capitalized" right /></span>
        </div>

        {filtered.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <p className="text-sm font-medium text-theme">No matching accounts</p>
            <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
              Adjust the search or filters.
            </p>
          </div>
        ) : grouped && groups ? (
          groups.map(([name, rows]) => {
            const isOpen = !collapsed.has(name)
            const gGross = sumCents(rows, "gross_amount")
            const gCap = sumCents(rows, "capitalized_amount")
            return (
              <div key={name}>
                <button onClick={() => toggleGroup(name)}
                  className="w-full grid gap-3 items-center px-4 py-2 text-left"
                  style={{ gridTemplateColumns: COLS, background: "var(--surface-2)",
                           borderTop: "1px solid var(--border)" }}>
                  <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-theme min-w-0">
                    {isOpen ? <ChevronDown size={13} strokeWidth={2.2} /> : <ChevronRight size={13} strokeWidth={2.2} />}
                    <span className="truncate">{name}</span>
                    <span className="text-[11px] font-normal" style={{ color: "var(--text-muted)" }}>
                      ({rows.length})
                    </span>
                  </span>
                  <span /><span /><span />
                  <span className="text-right text-[12px] tabular-nums" style={{ color: "var(--text-2)" }}>
                    {money(fromCents(gGross))}
                  </span>
                  <span className="text-right text-[12px] tabular-nums font-semibold"
                    style={{ color: "var(--green)" }}>{money(fromCents(gCap))}</span>
                </button>
                {isOpen && rows.map((l) => <Row key={l.qbo_account_id} l={l} />)}
              </div>
            )
          })
        ) : (
          sorted.map((l) => <Row key={l.qbo_account_id} l={l} />)
        )}

        {/* Totals — always reflects what's on screen */}
        {filtered.length > 0 && (
          <div className="grid gap-3 items-center px-4 py-2.5 text-[13px] font-semibold"
            style={{ gridTemplateColumns: COLS, background: "var(--surface-2)",
                     borderTop: "2px solid var(--border-strong)" }}>
            <span className="text-theme">
              {isFiltered ? "Filtered total" : "Total"}
            </span>
            <span /><span /><span />
            <span className="text-right tabular-nums text-theme">{money(fromCents(totals.gross))}</span>
            <span className="text-right tabular-nums" style={{ color: "var(--green)" }}>
              {money(fromCents(totals.cap))}
            </span>
          </div>
        )}
      </div>

      {filtered.length > 0 && (
        <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
          Disallowed under §280E on the shown rows: {money(fromCents(totals.dis))}
        </p>
      )}
    </div>
  )
}
