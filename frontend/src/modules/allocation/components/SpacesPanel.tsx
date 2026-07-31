/**
 * SpacesPanel — the square-footage registry behind the occupancy driver.
 *
 * QuickBooks has no concept of square footage, so this table is the only source
 * of the occupancy factor. The running total and the resulting production
 * percentage are shown live, because that number IS the driver — a preparer
 * should see it move as they type rather than discover it inside a run.
 *
 * "Shared" and "storage" default to 0% production and require an explicit
 * override. That's deliberate: a judgment call should be stated, not guessed.
 */
import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Building2, Plus, Trash2 } from "lucide-react"
import { Button, Input, Select, Spinner } from "@/core/ui"
import { allocationApi, type Space, type SpaceInput } from "../api"

const FUNCTIONS = [
  "cultivation", "processing", "curing", "packaging",
  "retail", "office", "storage", "shared",
]
// Kept in step with PRODUCTION_SPACE_FUNCTIONS in the engine.
const PRODUCTION = new Set(["cultivation", "processing", "curing", "packaging"])

const EMPTY: SpaceInput = { name: "", function: "cultivation", square_feet: 0, production_pct: null }

export function SpacesPanel() {
  const [form, setForm] = useState<SpaceInput>(EMPTY)
  const [editing, setEditing] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const qc = useQueryClient()

  const { data: spaces = [], isLoading } = useQuery({
    queryKey: ["allocation", "spaces"],
    queryFn:  allocationApi.listSpaces,
  })

  const live = useMemo(() => spaces.filter((s) => !s.effective_to), [spaces])
  const totals = useMemo(() => {
    let total = 0, production = 0
    for (const s of live) {
      const sqft = Number(s.square_feet) || 0
      total += sqft
      production += sqft * (Number(s.effective_production_pct) || 0) / 100
    }
    return { total, production, factor: total > 0 ? (production / total) * 100 : 0 }
  }, [live])

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

  function startEdit(s: Space) {
    setEditing(s.id)
    setForm({
      name: s.name, function: s.function, square_feet: Number(s.square_feet),
      production_pct: s.production_pct != null ? Number(s.production_pct) : null,
      notes: s.notes,
    })
    setError(null); setShowForm(true)
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

  if (isLoading) return <div className="flex justify-center py-10"><Spinner className="h-5 w-5" /></div>

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          {totals.total.toLocaleString()} sq ft total ·{" "}
          <span style={{ color: "var(--green)" }}>
            {totals.factor.toFixed(2)}% production
          </span>{" "}
          — the occupancy driver
        </p>
        <Button onClick={() => { setEditing(null); setForm(EMPTY); setError(null); setShowForm((v) => !v) }}
          icon={<Plus size={14} strokeWidth={1.8} />}>
          Add space
        </Button>
      </div>

      {showForm && (
        <div className="rounded-xl p-4 space-y-3"
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
          {!PRODUCTION.has(form.function) && form.production_pct == null && (
            <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
              {form.function === "shared" || form.function === "storage"
                ? "Shared and storage areas count as 0% production unless you set an override — state the split rather than leaving it implied."
                : "This function counts as 0% production."}
            </p>
          )}
          {error && <p className="text-xs" style={{ color: "var(--danger)" }}>{error}</p>}
          <div className="flex gap-2">
            <Button onClick={submit} loading={save.isPending}>{editing ? "Save changes" : "Add space"}</Button>
            <Button variant="secondary" onClick={() => { setShowForm(false); setEditing(null); setError(null) }}>
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
          <p className="text-xs mt-1 max-w-sm" style={{ color: "var(--text-muted)" }}>
            QuickBooks doesn&rsquo;t hold square footage, so occupancy-driven pools can&rsquo;t
            be allocated until the rooms are listed here.
          </p>
        </div>
      ) : (
        <div className="rounded-xl overflow-hidden"
          style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
          <div className="grid grid-cols-[minmax(0,2fr)_1fr_1fr_auto] gap-3 px-4 py-2.5 text-[11px]"
            style={{ color: "var(--text-muted)", borderBottom: "1px solid var(--border)" }}>
            <span>Space</span><span className="text-right">Sq ft</span>
            <span className="text-right">Production</span><span />
          </div>
          {live.map((s, i) => (
            <div key={s.id} className="grid grid-cols-[minmax(0,2fr)_1fr_1fr_auto] gap-3 items-center px-4 py-2.5"
              style={{ borderTop: i === 0 ? undefined : "1px solid var(--border)" }}>
              <div className="min-w-0">
                <div className="text-[13px] text-theme truncate">{s.name}</div>
                <div className="text-[11px] capitalize" style={{ color: "var(--text-muted)" }}>{s.function}</div>
              </div>
              <span className="text-right text-[13px] tabular-nums" style={{ color: "var(--text-2)" }}>
                {Number(s.square_feet).toLocaleString()}
              </span>
              <span className="text-right text-[13px] tabular-nums"
                style={{ color: Number(s.effective_production_pct) > 0 ? "var(--green)" : "var(--text-muted)" }}>
                {Number(s.effective_production_pct).toFixed(0)}%
                {s.production_pct != null && (
                  <span className="ml-1 text-[10px]" style={{ color: "var(--text-muted)" }}>set</span>
                )}
              </span>
              <div className="flex items-center gap-1">
                <button onClick={() => startEdit(s)} className="text-[12px] font-medium px-2 py-1 rounded-md"
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
