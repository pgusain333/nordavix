/**
 * EmployeesPanel — review who counts as production, and by how much.
 *
 * The roster is BUILT BY THE PAYROLL IMPORT, not typed here. The register
 * already carries the client's own department and job title, which is the
 * books-and-records basis §471(c) keys off — far better evidence than a
 * preparer's unsourced judgement, and far less work than re-keying a roster.
 *
 * So this screen's job is confirmation: it surfaces the register's labels
 * beside the function they produced, and puts the people nobody has classified
 * at the top, because those are the only ones that need a decision. Manual add
 * stays available for someone genuinely off-payroll (an owner drawing no wage).
 *
 * Wages are not entered here — they arrive monthly with the register, so the
 * classification stays stable while the dollars change.
 */
import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowRight, CheckCircle2, Percent, Plus, Trash2, Upload, Users } from "lucide-react"
import { Button, Input, Select, Spinner } from "@/core/ui"
import { allocationApi, type Employee, type EmployeeInput } from "../api"
import { isEffective } from "./MonthPicker"

const FUNCTIONS = [
  "cultivation", "processing", "packaging",
  "retail", "admin", "management", "shared",
]
// Kept in step with PRODUCTION_EMPLOYEE_FUNCTIONS in the engine.
const PRODUCTION = new Set(["cultivation", "processing", "packaging"])

const EMPTY: EmployeeInput = { name: "", function: "cultivation", production_pct: 100 }

interface Props {
  periodEnd: string
  /** Jump to the Payroll tab — where the roster actually comes from. */
  onGoToPayroll?: () => void
}

export function EmployeesPanel({ periodEnd, onGoToPayroll }: Props) {
  const [form, setForm] = useState<EmployeeInput>(EMPTY)
  const [editing, setEditing] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const qc = useQueryClient()

  const { data: employees = [], isLoading } = useQuery({
    queryKey: ["allocation", "employees"],
    queryFn:  allocationApi.listEmployees,
    staleTime: 30_000,
  })

  // Active AND in force for the period on screen — the same rule the run
  // applies, so the count here can't disagree with readiness.
  const live = useMemo(
    () => employees.filter(
      (e) => e.active && isEffective(e.effective_from, e.effective_to, periodEnd),
    ),
    [employees, periodEnd],
  )

  // Unclassified first: those are the only rows that need a decision.
  const sorted = useMemo(() => {
    const rank = (e: Employee) =>
      e.function === "shared" && Number(e.production_pct) === 0 ? 0 : 1
    return [...live].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
  }, [live])

  const stats = useMemo(() => {
    const unclassified = live.filter(
      (e) => e.function === "shared" && Number(e.production_pct) === 0,
    ).length
    const production = live.filter((e) => Number(e.production_pct) > 0).length
    const split = live.filter((e) => {
      const pct = Number(e.production_pct)
      return pct > 0 && pct < 100
    }).length
    return { unclassified, production, split }
  }, [live])

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

  /** Inline reclassify straight from the row — the common action.
   *
   *  `pct` is passed separately from `fn` on purpose. Plenty of people work
   *  across the line — a manager who spends part of the month in the grow, a
   *  packager who covers the counter at weekends — and forcing their wage to
   *  100% or 0% based on a single job label would misstate the payroll factor
   *  in whichever direction the label happened to fall. Changing the function
   *  offers a default; the percentage is the preparer's to state. */
  const reclassify = useMutation({
    mutationFn: (v: { e: Employee; fn?: string; pct?: number }) =>
      allocationApi.updateEmployee(v.e.id, {
        name: v.e.name,
        function: v.fn ?? v.e.function,
        production_pct: v.pct ?? Number(v.e.production_pct),
        external_id: v.e.external_id,
        department: v.e.department,
        job_title: v.e.job_title,
      }),
    onMutate: (v) => { setBusyId(v.e.id); setError(null) },
    onSettled: () => setBusyId(null),
    onSuccess: invalidate,
    onError,
  })

  function startEdit(e: Employee) {
    setEditing(e.id)
    setForm({
      name: e.name, function: e.function,
      production_pct: Number(e.production_pct), external_id: e.external_id,
      department: e.department, job_title: e.job_title,
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

  if (isLoading) {
    return (
      <div className="rounded-xl px-4 py-10 flex justify-center"
        style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
        <Spinner className="h-5 w-5" />
      </div>
    )
  }

  return (
    <div className="space-y-3 ndvx-fade-in">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          {live.length} on the roster · {stats.production} count as production
          {stats.split > 0 && <span> · {stats.split} split</span>}
          {stats.unclassified > 0 && (
            <span style={{ color: "var(--warn)" }}> · {stats.unclassified} unclassified</span>
          )}
        </p>
        <div className="flex gap-2">
          {onGoToPayroll && (
            <Button variant="outline" onClick={onGoToPayroll}
              icon={<Upload size={14} strokeWidth={1.8} />}>
              Import register
            </Button>
          )}
          <Button variant="outline"
            onClick={() => { setEditing(null); setForm(EMPTY); setError(null); setShowForm((v) => !v) }}
            icon={<Plus size={14} strokeWidth={1.8} />}>
            Add manually
          </Button>
        </div>
      </div>

      <p className="text-[11px] flex items-start gap-1.5" style={{ color: "var(--text-muted)" }}>
        <Percent size={12} strokeWidth={2} className="mt-[2px] shrink-0" />
        Anyone who works both sides of the line gets a SPLIT, not a label. Set the
        production % directly — a manager at 40%, a packager who covers the counter
        at 70%. Choosing a function only pre-fills it; the percentage is what the
        payroll factor actually uses, so state the share you can support.
      </p>
      {stats.unclassified > 0 && (
        <p className="text-[11px] flex items-start gap-1.5" style={{ color: "var(--text-muted)" }}>
          <Users size={12} strokeWidth={2} className="mt-[2px] shrink-0" />
          Unclassified people sit at 0% — their wages count against the payroll
          factor but not toward it, so capitalization is understated until you
          set them.
        </p>
      )}

      {showForm && (
        <div className="rounded-xl p-4 space-y-3 ndvx-fade-in"
          style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
          <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
            Most people arrive with the payroll register. Add manually only for
            someone genuinely off-payroll.
          </p>
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

      {error && !showForm && <p className="text-xs" style={{ color: "var(--danger)" }}>{error}</p>}

      {live.length === 0 ? (
        <div className="rounded-xl px-6 py-12 flex flex-col items-center text-center"
          style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
          <div className="h-10 w-10 rounded-full grid place-items-center mb-3"
            style={{ background: "var(--green-subtle)" }}>
            <Users size={18} strokeWidth={1.7} style={{ color: "var(--green)" }} />
          </div>
          <p className="text-sm font-medium text-theme">No roster yet</p>
          <p className="text-xs mt-1 max-w-sm leading-relaxed" style={{ color: "var(--text-muted)" }}>
            Import the payroll register and the roster builds itself — the file&rsquo;s own
            department and job title classify each person, so there&rsquo;s nothing to type.
          </p>
          {onGoToPayroll && (
            <button onClick={onGoToPayroll}
              className="inline-flex items-center gap-1 text-xs font-medium mt-3"
              style={{ color: "var(--green)" }}>
              Import the register <ArrowRight size={12} strokeWidth={2} />
            </button>
          )}
        </div>
      ) : (
        <div className="rounded-xl overflow-hidden"
          style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
          <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1.2fr)_minmax(0,1.1fr)_110px_auto] gap-3 px-4 py-2.5 text-[11px]"
            style={{ color: "var(--text-muted)", borderBottom: "1px solid var(--border)" }}>
            <span>Employee</span>
            <span>Per the register</span>
            <span>Function</span>
            <span className="text-right">Production %</span>
            <span />
          </div>
          {sorted.map((e, i) => {
            const unclassified = e.function === "shared" && Number(e.production_pct) === 0
            return (
              <div key={e.id}
                className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1.2fr)_minmax(0,1.1fr)_110px_auto] gap-3 items-center px-4 py-2 transition-colors"
                style={{
                  borderTop: i === 0 ? undefined : "1px solid var(--border)",
                  background: unclassified ? "var(--warn-subtle)" : undefined,
                  opacity: busyId === e.id ? 0.55 : 1,
                }}>
                <div className="min-w-0">
                  <div className="text-[13px] text-theme truncate">{e.name}</div>
                  {e.external_id && (
                    <div className="text-[10.5px]" style={{ color: "var(--text-muted)" }}>{e.external_id}</div>
                  )}
                </div>
                <div className="min-w-0 text-[11.5px]" style={{ color: "var(--text-2)" }}>
                  <div className="truncate">{e.department ?? "—"}</div>
                  {e.job_title && (
                    <div className="truncate text-[10.5px]" style={{ color: "var(--text-muted)" }}>
                      {e.job_title}
                    </div>
                  )}
                </div>
                <Select value={e.function} disabled={busyId === e.id}
                  onChange={(ev) => {
                    const fn = ev.target.value
                    // A function change PRE-FILLS the split; it doesn't dictate it.
                    reclassify.mutate({ e, fn, pct: PRODUCTION.has(fn) ? 100 : 0 })
                  }}>
                  {FUNCTIONS.map((f) => (
                    <option key={f} value={f}>
                      {f[0].toUpperCase() + f.slice(1)}{PRODUCTION.has(f) ? " (production)" : ""}
                    </option>
                  ))}
                </Select>
                <div className="flex items-center gap-1 justify-self-end">
                  {Number(e.production_pct) > 0 && (
                    <CheckCircle2 size={11} strokeWidth={2.4}
                      style={{ color: "var(--green)" }} className="shrink-0" />
                  )}
                  <Input type="number" min="0" max="100" disabled={busyId === e.id}
                    defaultValue={Number(e.production_pct)}
                    style={{ width: 72, textAlign: "right" }}
                    onBlur={(ev) => {
                      const v = Number(ev.target.value)
                      if (v !== Number(e.production_pct) && v >= 0 && v <= 100) {
                        reclassify.mutate({ e, pct: v })
                      }
                    }} />
                </div>
                <div className="flex items-center gap-1 justify-self-end">
                  <button onClick={() => startEdit(e)}
                    className="text-[12px] font-medium px-2 py-1 rounded-md"
                    style={{ color: "var(--green)" }}>Edit</button>
                  <button onClick={() => retire.mutate(e.id)} aria-label={`Remove ${e.name}`}
                    className="p-1 rounded-md" style={{ color: "var(--text-muted)" }}>
                    <Trash2 size={14} strokeWidth={1.8} />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
