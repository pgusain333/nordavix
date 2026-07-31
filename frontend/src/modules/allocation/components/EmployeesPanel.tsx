/**
 * EmployeesPanel — who counts as production, and by how much.
 *
 * QuickBooks won't tell a grower from a budtender, so the classification lives
 * here. Production % handles the working owner who spends 60% of their time in
 * the grow: the split is stated once and applied consistently, which is exactly
 * what an examiner wants to see.
 *
 * Wages are NOT entered here — they arrive monthly from the payroll register,
 * so the classification stays stable while the dollars change.
 */
import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus, Trash2, Users } from "lucide-react"
import { Button, Input, Select, Spinner } from "@/core/ui"
import { allocationApi, type Employee, type EmployeeInput } from "../api"

const FUNCTIONS = [
  "cultivation", "processing", "packaging",
  "retail", "admin", "management", "shared",
]
// Kept in step with PRODUCTION_EMPLOYEE_FUNCTIONS in the engine.
const PRODUCTION = new Set(["cultivation", "processing", "packaging"])

const EMPTY: EmployeeInput = { name: "", function: "cultivation", production_pct: 100 }

export function EmployeesPanel() {
  const [form, setForm] = useState<EmployeeInput>(EMPTY)
  const [editing, setEditing] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const qc = useQueryClient()

  const { data: employees = [], isLoading } = useQuery({
    queryKey: ["allocation", "employees"],
    queryFn:  allocationApi.listEmployees,
  })

  const live = useMemo(() => employees.filter((e) => e.active), [employees])

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["allocation", "employees"] })
    qc.invalidateQueries({ queryKey: ["allocation", "readiness"] })
  }
  const onError = (e: unknown) => {
    const ex = e as { response?: { data?: { detail?: string } }; message?: string }
    setError(ex.response?.data?.detail ?? ex.message ?? "Something went wrong.")
  }

  const save = useMutation({
    mutationFn: (b: EmployeeInput) =>
      editing ? allocationApi.updateEmployee(editing, b) : allocationApi.createEmployee(b),
    onSuccess: () => { invalidate(); setShowForm(false); setEditing(null); setForm(EMPTY); setError(null) },
    onError,
  })
  const retire = useMutation({ mutationFn: allocationApi.retireEmployee, onSuccess: invalidate, onError })

  function startEdit(e: Employee) {
    setEditing(e.id)
    setForm({
      name: e.name, function: e.function,
      production_pct: Number(e.production_pct), external_id: e.external_id,
    })
    setError(null); setShowForm(true)
  }

  function submit() {
    setError(null)
    if (!form.name.trim()) { setError("Give the employee a name."); return }
    if (form.production_pct < 0 || form.production_pct > 100) {
      setError("Production % must be between 0 and 100."); return
    }
    save.mutate({ ...form, name: form.name.trim() })
  }

  if (isLoading) return <div className="flex justify-center py-10"><Spinner className="h-5 w-5" /></div>

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          {live.length} classified · wages come from the monthly payroll register
        </p>
        <Button onClick={() => { setEditing(null); setForm(EMPTY); setError(null); setShowForm((v) => !v) }}
          icon={<Plus size={14} strokeWidth={1.8} />}>
          Add employee
        </Button>
      </div>

      {showForm && (
        <div className="rounded-xl p-4 space-y-3"
          style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="text-[11px] font-medium" style={{ color: "var(--text-muted)" }}>Name</span>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Jordan Alvarez" />
            </label>
            <label className="block">
              <span className="text-[11px] font-medium" style={{ color: "var(--text-muted)" }}>Function</span>
              <Select value={form.function}
                onChange={(e) => {
                  const f = e.target.value
                  setForm({ ...form, function: f, production_pct: PRODUCTION.has(f) ? 100 : 0 })
                }}>
                {FUNCTIONS.map((f) => (
                  <option key={f} value={f}>
                    {f[0].toUpperCase() + f.slice(1)}{PRODUCTION.has(f) ? " (production)" : ""}
                  </option>
                ))}
              </Select>
            </label>
            <label className="block">
              <span className="text-[11px] font-medium" style={{ color: "var(--text-muted)" }}>Production %</span>
              <Input type="number" min="0" max="100" value={form.production_pct}
                onChange={(e) => setForm({ ...form, production_pct: Number(e.target.value) })} />
            </label>
            <label className="block">
              <span className="text-[11px] font-medium" style={{ color: "var(--text-muted)" }}>
                Payroll ID <span className="font-normal">(optional)</span>
              </span>
              <Input value={form.external_id ?? ""}
                placeholder="Matches the payroll register"
                onChange={(e) => setForm({ ...form, external_id: e.target.value || null })} />
            </label>
          </div>
          <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
            Split anyone who works across functions — a working owner at 60% production
            is a defensible, consistently applied position.
          </p>
          {error && <p className="text-xs" style={{ color: "var(--danger)" }}>{error}</p>}
          <div className="flex gap-2">
            <Button onClick={submit} loading={save.isPending}>
              {editing ? "Save changes" : "Add employee"}
            </Button>
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
            <Users size={18} strokeWidth={1.7} style={{ color: "var(--green)" }} />
          </div>
          <p className="text-sm font-medium text-theme">No employees classified</p>
          <p className="text-xs mt-1 max-w-sm" style={{ color: "var(--text-muted)" }}>
            Payroll-driven pools need to know who works in production. QuickBooks
            can&rsquo;t tell a grower from a budtender, so the split is stated here.
          </p>
        </div>
      ) : (
        <div className="rounded-xl overflow-hidden"
          style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
          <div className="grid grid-cols-[minmax(0,2fr)_1fr_1fr_auto] gap-3 px-4 py-2.5 text-[11px]"
            style={{ color: "var(--text-muted)", borderBottom: "1px solid var(--border)" }}>
            <span>Employee</span><span>Function</span>
            <span className="text-right">Production</span><span />
          </div>
          {live.map((e, i) => (
            <div key={e.id} className="grid grid-cols-[minmax(0,2fr)_1fr_1fr_auto] gap-3 items-center px-4 py-2.5"
              style={{ borderTop: i === 0 ? undefined : "1px solid var(--border)" }}>
              <div className="min-w-0">
                <div className="text-[13px] text-theme truncate">{e.name}</div>
                {e.external_id && (
                  <div className="text-[10.5px]" style={{ color: "var(--text-muted)" }}>{e.external_id}</div>
                )}
              </div>
              <span className="text-[12px] capitalize" style={{ color: "var(--text-2)" }}>{e.function}</span>
              <span className="text-right text-[13px] tabular-nums"
                style={{ color: Number(e.production_pct) > 0 ? "var(--green)" : "var(--text-muted)" }}>
                {Number(e.production_pct).toFixed(0)}%
              </span>
              <div className="flex items-center gap-1">
                <button onClick={() => startEdit(e)} className="text-[12px] font-medium px-2 py-1 rounded-md"
                  style={{ color: "var(--green)" }}>Edit</button>
                <button onClick={() => retire.mutate(e.id)} aria-label={`Retire ${e.name}`}
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
