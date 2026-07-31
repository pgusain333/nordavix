/**
 * PoolsPanel — the cost pools and the driver each one uses.
 *
 * This is where "configurable per client" lives: a pool is either fully
 * inventoriable (direct), apportioned by a driver (allocated), or disallowed
 * under §280E (excluded).
 *
 * The form mirrors the database CHECK constraints rather than trusting them to
 * produce a readable error — an allocated pool must name a driver, direct and
 * excluded pools must not, and blended weights must sum to 100.
 */
import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Layers, Plus, Sparkles, Trash2 } from "lucide-react"
import { Button, Input, Select, Spinner } from "@/core/ui"
import { allocationApi, type Driver, type Pool, type PoolInput, type Treatment } from "../api"

const TREATMENT_LABEL: Record<Treatment, string> = {
  direct:    "Direct — 100% inventoriable",
  allocated: "Allocated — by driver",
  excluded:  "Excluded — §280E disallowed",
}

const DRIVER_LABEL: Record<Driver, string> = {
  payroll:   "Payroll",
  occupancy: "Occupancy",
  blended:   "Blended",
  fixed:     "Fixed rate",
}

const EMPTY: PoolInput = {
  name: "", treatment: "allocated", driver: "occupancy",
  blend_payroll_wt: 50, blend_occupancy_wt: 50, fixed_pct: null, sort_order: 0,
}

export function PoolsPanel() {
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState<PoolInput>(EMPTY)
  const [showForm, setShowForm] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const qc = useQueryClient()

  const { data: pools = [], isLoading } = useQuery({
    queryKey: ["allocation", "pools"],
    queryFn:  allocationApi.listPools,
  })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["allocation", "pools"] })
    qc.invalidateQueries({ queryKey: ["allocation", "readiness"] })
  }
  const onError = (e: unknown) => {
    const ex = e as { response?: { data?: { detail?: string } }; message?: string }
    setError(ex.response?.data?.detail ?? ex.message ?? "Something went wrong.")
  }

  const seed = useMutation({
    mutationFn: allocationApi.seedDefaultPools,
    onSuccess: invalidate, onError,
  })
  const save = useMutation({
    mutationFn: (body: PoolInput) =>
      editing ? allocationApi.updatePool(editing, body) : allocationApi.createPool(body),
    onSuccess: () => { invalidate(); setShowForm(false); setEditing(null); setForm(EMPTY); setError(null) },
    onError,
  })
  const remove = useMutation({
    mutationFn: allocationApi.deactivatePool, onSuccess: invalidate, onError,
  })

  function startEdit(p: Pool) {
    setEditing(p.id)
    setForm({
      name: p.name, treatment: p.treatment, driver: p.driver,
      blend_payroll_wt: p.blend_payroll_wt ? Number(p.blend_payroll_wt) : 50,
      blend_occupancy_wt: p.blend_occupancy_wt ? Number(p.blend_occupancy_wt) : 50,
      fixed_pct: p.fixed_pct ? Number(p.fixed_pct) : null,
      sort_order: p.sort_order, notes: p.notes,
    })
    setError(null)
    setShowForm(true)
  }

  function submit() {
    setError(null)
    if (!form.name.trim()) { setError("Give the pool a name."); return }
    if (form.treatment === "allocated" && !form.driver) {
      setError("An allocated pool needs a driver."); return
    }
    if (form.treatment === "allocated" && form.driver === "blended") {
      const sum = Number(form.blend_payroll_wt ?? 0) + Number(form.blend_occupancy_wt ?? 0)
      if (sum !== 100) { setError(`Blend weights must sum to 100 — currently ${sum}.`); return }
    }
    if (form.treatment === "allocated" && form.driver === "fixed" && form.fixed_pct == null) {
      setError("A fixed-rate pool needs a rate."); return
    }
    // direct / excluded must not carry a driver (the DB enforces this too)
    const body: PoolInput = {
      ...form,
      driver: form.treatment === "allocated" ? form.driver : null,
      blend_payroll_wt: form.driver === "blended" ? form.blend_payroll_wt : null,
      blend_occupancy_wt: form.driver === "blended" ? form.blend_occupancy_wt : null,
      fixed_pct: form.driver === "fixed" ? form.fixed_pct : null,
    }
    save.mutate(body)
  }

  if (isLoading) {
    return <div className="flex justify-center py-10"><Spinner className="h-5 w-5" /></div>
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          {pools.length} pool{pools.length === 1 ? "" : "s"}
        </p>
        <div className="flex gap-2">
          {pools.length === 0 && (
            <Button variant="secondary" onClick={() => seed.mutate()} loading={seed.isPending}
              icon={<Sparkles size={14} strokeWidth={1.8} />}>
              Use cannabis template
            </Button>
          )}
          <Button onClick={() => { setEditing(null); setForm(EMPTY); setError(null); setShowForm((v) => !v) }}
            icon={<Plus size={14} strokeWidth={1.8} />}>
            New pool
          </Button>
        </div>
      </div>

      {showForm && (
        <div className="rounded-xl p-4 space-y-3"
          style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="text-[11px] font-medium" style={{ color: "var(--text-muted)" }}>Name</span>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Facility overhead" />
            </label>
            <label className="block">
              <span className="text-[11px] font-medium" style={{ color: "var(--text-muted)" }}>Treatment</span>
              <Select value={form.treatment}
                onChange={(e) => {
                  const t = e.target.value as Treatment
                  setForm({ ...form, treatment: t, driver: t === "allocated" ? (form.driver ?? "occupancy") : null })
                }}>
                {(Object.keys(TREATMENT_LABEL) as Treatment[]).map((t) => (
                  <option key={t} value={t}>{TREATMENT_LABEL[t]}</option>
                ))}
              </Select>
            </label>

            {form.treatment === "allocated" && (
              <label className="block">
                <span className="text-[11px] font-medium" style={{ color: "var(--text-muted)" }}>Driver</span>
                <Select value={form.driver ?? "occupancy"}
                  onChange={(e) => setForm({ ...form, driver: e.target.value as Driver })}>
                  {(Object.keys(DRIVER_LABEL) as Driver[]).map((d) => (
                    <option key={d} value={d}>{DRIVER_LABEL[d]}</option>
                  ))}
                </Select>
              </label>
            )}

            {form.treatment === "allocated" && form.driver === "fixed" && (
              <label className="block">
                <span className="text-[11px] font-medium" style={{ color: "var(--text-muted)" }}>Rate %</span>
                <Input type="number" min="0" max="100" value={form.fixed_pct ?? ""}
                  onChange={(e) => setForm({ ...form, fixed_pct: e.target.value === "" ? null : Number(e.target.value) })} />
              </label>
            )}

            {form.treatment === "allocated" && form.driver === "blended" && (
              <>
                <label className="block">
                  <span className="text-[11px] font-medium" style={{ color: "var(--text-muted)" }}>Payroll weight %</span>
                  <Input type="number" min="0" max="100" value={form.blend_payroll_wt ?? ""}
                    onChange={(e) => {
                      const wp = Number(e.target.value)
                      setForm({ ...form, blend_payroll_wt: wp, blend_occupancy_wt: 100 - wp })
                    }} />
                </label>
                <label className="block">
                  <span className="text-[11px] font-medium" style={{ color: "var(--text-muted)" }}>Occupancy weight %</span>
                  <Input type="number" value={form.blend_occupancy_wt ?? ""} readOnly />
                </label>
              </>
            )}
          </div>

          {error && <p className="text-xs" style={{ color: "var(--danger)" }}>{error}</p>}

          <div className="flex gap-2">
            <Button onClick={submit} loading={save.isPending}>{editing ? "Save changes" : "Create pool"}</Button>
            <Button variant="secondary" onClick={() => { setShowForm(false); setEditing(null); setError(null) }}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {pools.length === 0 ? (
        <div className="rounded-xl px-6 py-12 flex flex-col items-center text-center"
          style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
          <div className="h-10 w-10 rounded-full grid place-items-center mb-3"
            style={{ background: "var(--green-subtle)" }}>
            <Layers size={18} strokeWidth={1.7} style={{ color: "var(--green)" }} />
          </div>
          <p className="text-sm font-medium text-theme">No pools yet</p>
          <p className="text-xs mt-1 max-w-sm" style={{ color: "var(--text-muted)" }}>
            Start from the cannabis template — five pools covering direct production,
            facility, indirect labour, shared services and selling &amp; admin — then tune them.
          </p>
        </div>
      ) : (
        <div className="rounded-xl overflow-hidden"
          style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
          {pools.map((p, i) => (
            <div key={p.id}
              className="flex items-center gap-3 px-4 py-3"
              style={{ borderTop: i === 0 ? undefined : "1px solid var(--border)", opacity: p.active ? 1 : 0.5 }}>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-theme truncate">{p.name}</div>
                <div className="text-[11px] mt-0.5" style={{ color: "var(--text-muted)" }}>
                  {TREATMENT_LABEL[p.treatment]}
                  {p.driver && ` · ${DRIVER_LABEL[p.driver]}`}
                  {p.driver === "blended" && ` ${p.blend_payroll_wt}/${p.blend_occupancy_wt}`}
                  {p.driver === "fixed" && ` ${p.fixed_pct}%`}
                </div>
              </div>
              <button onClick={() => startEdit(p)}
                className="text-[12px] font-medium px-2 py-1 rounded-md"
                style={{ color: "var(--green)" }}>
                Edit
              </button>
              {p.active && (
                <button onClick={() => remove.mutate(p.id)} aria-label={`Deactivate ${p.name}`}
                  className="p-1 rounded-md" style={{ color: "var(--text-muted)" }}>
                  <Trash2 size={14} strokeWidth={1.8} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
