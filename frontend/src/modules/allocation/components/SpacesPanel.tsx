/**
 * SpacesPanel — the square-footage registry behind the occupancy driver.
 *
 * QuickBooks has no concept of square footage, so this table is the only source
 * of the occupancy factor. The running total and the resulting production
 * percentage are shown live, because that number IS the driver — a preparer
 * should see it move as they type rather than discover it inside a run.
 *
 * A licensed operator's floor plan is largely standard, so the room NAMES come
 * from a catalogue: tick the rooms this client has and enter square footage.
 * Nobody can guess square footage, and the same room name means different
 * things at different operators, so both stay editable. Custom rooms are always
 * available for anything the catalogue misses.
 *
 * Mixed rooms (receiving, vaults, security) carry an explicit production split
 * rather than being forced to 0 or 100 — that's the honest answer for a space
 * that genuinely serves both sides, and it's stated rather than implied.
 */
import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Building2, LayoutGrid, Plus, Trash2 } from "lucide-react"
import { Button, Input, Select, Spinner } from "@/core/ui"
import { allocationApi, type Space, type SpaceInput } from "../api"
import { isEffective } from "./MonthPicker"
import {
  PRODUCTION_SPACE_FUNCTIONS as PRODUCTION,
  SPACE_CATALOG,
  SPACE_FUNCTIONS as FUNCTIONS,
} from "../spaceCatalog"

const EMPTY: SpaceInput = { name: "", function: "cultivation", square_feet: 0, production_pct: null }

/**
 * Column templates, declared once and shared by each table's header and rows.
 *
 * The header is a SEPARATE grid container from every row, so `auto` and bare
 * `fr` tracks size against different content in each — an empty header cell
 * collapses to nothing while the row beneath it holds two buttons, and the
 * whole line walks out of step. Every track here is either a fixed width or an
 * `fr` with a floor, so both grids resolve identically whatever they contain.
 */
const ROSTER_COLS =
  "grid-cols-[minmax(150px,1.8fr)_minmax(130px,1fr)_100px_110px_84px]"
const CATALOG_COLS =
  "grid-cols-[26px_minmax(150px,1.6fr)_minmax(130px,1fr)_90px_90px]"

interface Draft {
  checked: boolean
  sqft: string
  fn: string
  pct: string
}

export function SpacesPanel({ periodEnd }: { periodEnd: string }) {
  const [form, setForm] = useState<SpaceInput>(EMPTY)
  const [editing, setEditing] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [showCatalog, setShowCatalog] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const qc = useQueryClient()

  const { data: spaces = [], isLoading } = useQuery({
    queryKey: ["allocation", "spaces"],
    queryFn:  allocationApi.listSpaces,
    staleTime: 30_000,
  })

  // In force for the period being viewed — NOT merely undeleted. Showing
  // every row here while readiness filtered by period is what made the
  // screen contradict itself.
  const live = useMemo(
    () => spaces.filter((s) => isEffective(s.effective_from, s.effective_to, periodEnd)),
    [spaces, periodEnd],
  )
  const hiddenCount = spaces.filter(
    (s) => !s.effective_to && !isEffective(s.effective_from, s.effective_to, periodEnd),
  ).length

  const totals = useMemo(() => {
    let total = 0, production = 0
    for (const s of live) {
      const sqft = Number(s.square_feet) || 0
      total += sqft
      production += sqft * (Number(s.effective_production_pct) || 0) / 100
    }
    return { total, production, factor: total > 0 ? (production / total) * 100 : 0 }
  }, [live])

  const alreadyAdded = useMemo(
    () => new Set(live.map((s) => s.name.trim().toLowerCase())),
    [live],
  )

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["allocation", "spaces"] })
    qc.invalidateQueries({ queryKey: ["allocation", "readiness"] })
  }
  const onError = (e: unknown) => {
    const ex = e as { response?: { data?: { detail?: string } }; message?: string }
    setError(ex.response?.data?.detail ?? ex.message ?? "Something went wrong.")
  }

  const save = useMutation({
    mutationFn: (b: SpaceInput) =>
      editing ? allocationApi.updateSpace(editing, b) : allocationApi.createSpace(b),
    onSuccess: () => { invalidate(); setShowForm(false); setEditing(null); setForm(EMPTY); setError(null) },
    onError,
  })
  const retire = useMutation({ mutationFn: allocationApi.retireSpace, onSuccess: invalidate, onError })

  /** Inline square-footage / split edits straight from the table. */
  const patch = useMutation({
    mutationFn: (v: { s: Space; sqft?: number; pct?: number | null; fn?: string }) =>
      allocationApi.updateSpace(v.s.id, {
        name: v.s.name,
        function: v.fn ?? v.s.function,
        square_feet: v.sqft ?? Number(v.s.square_feet),
        production_pct: v.pct !== undefined
          ? v.pct
          : (v.s.production_pct != null ? Number(v.s.production_pct) : null),
        notes: v.s.notes,
      }),
    onSuccess: invalidate,
    onError,
  })

  function draftFor(name: string): Draft {
    const c = SPACE_CATALOG.find((x) => x.name === name)!
    return drafts[name] ?? {
      checked: false, sqft: "", fn: c.function, pct: String(c.productionPct),
    }
  }
  const setDraft = (name: string, next: Partial<Draft>) =>
    setDrafts((d) => ({ ...d, [name]: { ...draftFor(name), ...next } }))

  async function addSelected() {
    const picked = SPACE_CATALOG.filter((c) => draftFor(c.name).checked)
    if (picked.length === 0) { setError("Tick at least one room."); return }
    setAdding(true); setError(null)
    try {
      for (const c of picked) {
        const d = draftFor(c.name)
        await allocationApi.createSpace({
          name: c.name,
          function: d.fn,
          square_feet: Number(d.sqft) || 0,
          // Always explicit for a catalogue room: the split is the judgement,
          // and it should be recorded rather than inferred from the function.
          production_pct: d.pct === "" ? null : Number(d.pct),
        })
      }
      setDrafts({}); setShowCatalog(false)
      invalidate()
    } catch (e) { onError(e) } finally { setAdding(false) }
  }

  function startEdit(s: Space) {
    setEditing(s.id)
    setForm({
      name: s.name, function: s.function, square_feet: Number(s.square_feet),
      production_pct: s.production_pct != null ? Number(s.production_pct) : null,
      notes: s.notes,
    })
    setError(null); setShowForm(true); setShowCatalog(false)
  }

  function submit() {
    setError(null)
    if (!form.name.trim()) { setError("Give the space a name."); return }
    if (!(form.square_feet >= 0)) { setError("Square feet must be zero or more."); return }
    if (form.production_pct != null && (form.production_pct < 0 || form.production_pct > 100)) {
      setError("Production % must be between 0 and 100."); return
    }
    save.mutate({ ...form, name: form.name.trim() })
  }

  if (isLoading) {
    return (
      <div className="rounded-xl px-4 py-10 flex justify-center"
        style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
        <Spinner className="h-5 w-5" />
      </div>
    )
  }

  const selectedCount = SPACE_CATALOG.filter((c) => draftFor(c.name).checked).length

  return (
    <div className="space-y-3 ndvx-fade-in">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          {totals.total.toLocaleString()} sq ft total ·{" "}
          <span style={{ color: "var(--green)" }}>{totals.factor.toFixed(2)}% production</span>
          {" "}— the occupancy driver
          {hiddenCount > 0 && (
            <span style={{ color: "var(--warn)" }}>
              {" "}· {hiddenCount} not yet in effect this period
            </span>
          )}
        </p>
        <div className="flex gap-2">
          <Button onClick={() => { setShowCatalog((v) => !v); setShowForm(false); setError(null) }}
            icon={<LayoutGrid size={14} strokeWidth={1.8} />}>
            Add standard rooms
          </Button>
          <Button variant="outline"
            onClick={() => { setEditing(null); setForm(EMPTY); setError(null); setShowForm((v) => !v); setShowCatalog(false) }}
            icon={<Plus size={14} strokeWidth={1.8} />}>
            Custom
          </Button>
        </div>
      </div>

      {error && <p className="text-xs" style={{ color: "var(--danger)" }}>{error}</p>}

      {/* Standard-rooms picker */}
      {showCatalog && (
        <div className="rounded-xl overflow-hidden ndvx-fade-in"
          style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
          <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
            <p className="text-sm font-medium text-theme">Tick the rooms this client has</p>
            <p className="text-[11px] mt-0.5" style={{ color: "var(--text-muted)" }}>
              Enter the square footage for each. The function and production split are
              pre-filled from the typical layout — change either where this client differs.
            </p>
          </div>

          {/* The header lives INSIDE the scroller. Outside it, the scrollbar
              takes width from the rows but not from the header, and the two
              grids resolve six pixels apart — visible as a drift that grows
              across the row. Sticky keeps the headings in view as well. */}
          <div className="max-h-[420px] overflow-y-auto">
          <div className={`grid ${CATALOG_COLS} gap-3 px-4 py-2 text-[11px] font-medium sticky top-0 z-10`}
            style={{ color: "var(--text-muted)", background: "var(--surface)",
                     borderBottom: "1px solid var(--border)" }}>
            <span /><span>Room</span><span>Function</span>
            <span className="text-right">Sq ft</span><span className="text-right">Prod %</span>
          </div>

            {SPACE_CATALOG.map((c, i) => {
              const d = draftFor(c.name)
              const exists = alreadyAdded.has(c.name.trim().toLowerCase())
              return (
                <div key={c.name}
                  className={`grid ${CATALOG_COLS} gap-3 items-center px-4 py-2`}
                  style={{
                    borderTop: i === 0 ? undefined : "1px solid var(--border)",
                    opacity: exists ? 0.45 : 1,
                  }}>
                  <input type="checkbox" checked={d.checked} disabled={exists}
                    onChange={(e) => setDraft(c.name, { checked: e.target.checked })} />
                  <div className="min-w-0">
                    <div className="text-[13px] text-theme truncate">{c.name}</div>
                    {exists ? (
                      <div className="text-[10.5px]" style={{ color: "var(--text-muted)" }}>
                        already added
                      </div>
                    ) : c.note ? (
                      <div className="text-[10.5px] truncate" style={{ color: "var(--text-muted)" }}
                        title={c.note}>{c.note}</div>
                    ) : null}
                  </div>
                  <Select value={d.fn} disabled={exists}
                    onChange={(e) => setDraft(c.name, { fn: e.target.value })}>
                    {FUNCTIONS.map((f) => (
                      <option key={f} value={f}>{f[0].toUpperCase() + f.slice(1)}</option>
                    ))}
                  </Select>
                  <Input type="number" min="0" value={d.sqft} placeholder="0" disabled={exists}
                    className="text-right"
                    onChange={(e) => setDraft(c.name, { sqft: e.target.value, checked: true })} />
                  <Input type="number" min="0" max="100" value={d.pct} disabled={exists}
                    className="text-right"
                    onChange={(e) => setDraft(c.name, { pct: e.target.value })} />
                </div>
              )
            })}
          </div>

          <div className="px-4 py-3 flex items-center gap-2"
            style={{ borderTop: "1px solid var(--border)" }}>
            <Button onClick={addSelected} loading={adding} disabled={selectedCount === 0}>
              Add {selectedCount || ""} {selectedCount === 1 ? "room" : "rooms"}
            </Button>
            <Button variant="outline" onClick={() => { setShowCatalog(false); setDrafts({}) }}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Custom / edit */}
      {showForm && (
        <div className="rounded-xl p-4 space-y-3 ndvx-fade-in"
          style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="text-[11px] font-medium" style={{ color: "var(--text-muted)" }}>Name</span>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Flower room A" />
            </label>
            <label className="block">
              <span className="text-[11px] font-medium" style={{ color: "var(--text-muted)" }}>Function</span>
              <Select value={form.function}
                onChange={(e) => setForm({ ...form, function: e.target.value })}>
                {FUNCTIONS.map((f) => (
                  <option key={f} value={f}>
                    {f[0].toUpperCase() + f.slice(1)}{PRODUCTION.has(f) ? " (production)" : ""}
                  </option>
                ))}
              </Select>
            </label>
            <label className="block">
              <span className="text-[11px] font-medium" style={{ color: "var(--text-muted)" }}>Square feet</span>
              <Input type="number" min="0" value={form.square_feet}
                onChange={(e) => setForm({ ...form, square_feet: Number(e.target.value) })} />
            </label>
            <label className="block">
              <span className="text-[11px] font-medium" style={{ color: "var(--text-muted)" }}>
                Production % override
              </span>
              <Input type="number" min="0" max="100"
                placeholder={PRODUCTION.has(form.function) ? "100 (from function)" : "0 (from function)"}
                value={form.production_pct ?? ""}
                onChange={(e) => setForm({
                  ...form,
                  production_pct: e.target.value === "" ? null : Number(e.target.value),
                })} />
            </label>
          </div>
          {error && <p className="text-xs" style={{ color: "var(--danger)" }}>{error}</p>}
          <div className="flex gap-2">
            <Button onClick={submit} loading={save.isPending}>{editing ? "Save changes" : "Add space"}</Button>
            <Button variant="outline" onClick={() => { setShowForm(false); setEditing(null); setError(null) }}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {live.length === 0 ? (
        <div className="rounded-xl px-6 py-12 flex flex-col items-center text-center"
          style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
          <div className="h-10 w-10 rounded-full grid place-items-center mb-3"
            style={{ background: "var(--green-subtle)" }}>
            <Building2 size={18} strokeWidth={1.7} style={{ color: "var(--green)" }} />
          </div>
          <p className="text-sm font-medium text-theme">No spaces on file</p>
          <p className="text-xs mt-1 max-w-sm leading-relaxed" style={{ color: "var(--text-muted)" }}>
            QuickBooks doesn&rsquo;t hold square footage, so occupancy-driven pools
            can&rsquo;t be allocated until the rooms are listed. Start from the standard
            layout and just fill in the footage.
          </p>
        </div>
      ) : (
        <div className="rounded-xl overflow-hidden"
          style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
          <div className={`grid ${ROSTER_COLS} gap-3 px-4 py-2.5 text-[11px] font-medium`}
            style={{ color: "var(--text-muted)", borderBottom: "1px solid var(--border)" }}>
            <span>Space</span><span>Function</span>
            <span className="text-right">Sq ft</span>
            <span className="text-right">Production %</span><span />
          </div>
          {live.map((s, i) => (
            <div key={s.id}
              className={`grid ${ROSTER_COLS} gap-3 items-center px-4 py-2`}
              style={{ borderTop: i === 0 ? undefined : "1px solid var(--border)" }}>
              <div className="min-w-0">
                <div className="text-[13px] text-theme truncate">{s.name}</div>
              </div>
              <Select value={s.function}
                onChange={(e) => patch.mutate({ s, fn: e.target.value })}>
                {FUNCTIONS.map((f) => (
                  <option key={f} value={f}>{f[0].toUpperCase() + f.slice(1)}</option>
                ))}
              </Select>
              {/* Right-aligned to match the heading above them — a right-aligned
                  "Sq ft" over a left-aligned number is the misalignment you see
                  before you notice the column widths. */}
              <Input type="number" min="0" defaultValue={Number(s.square_feet)}
                className="text-right"
                onBlur={(e) => {
                  const v = Number(e.target.value)
                  if (v !== Number(s.square_feet)) patch.mutate({ s, sqft: v })
                }} />
              <Input type="number" min="0" max="100"
                defaultValue={Number(s.effective_production_pct)}
                className="text-right"
                onBlur={(e) => {
                  const v = Number(e.target.value)
                  if (v !== Number(s.effective_production_pct)) patch.mutate({ s, pct: v })
                }} />
              <div className="flex items-center gap-1 justify-self-end">
                <button onClick={() => startEdit(s)}
                  className="text-[12px] font-medium px-2 py-1 rounded-md"
                  style={{ color: "var(--green)" }}>Edit</button>
                <button onClick={() => retire.mutate(s.id)} aria-label={`Retire ${s.name}`}
                  className="p-1 rounded-md" style={{ color: "var(--text-muted)" }}>
                  <Trash2 size={14} strokeWidth={1.8} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
