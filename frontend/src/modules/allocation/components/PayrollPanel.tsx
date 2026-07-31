/**
 * PayrollPanel — upload the month's payroll register.
 *
 * QuickBooks won't give per-employee wages through the API, so this is where
 * the payroll factor's numbers come from: the CSV/XLSX every provider exports
 * (ADP, Gusto, Paychex, KayaPush, Rippling).
 *
 * The register also carries the client's OWN org structure — department and job
 * title — which is the books-and-records basis §471(c) keys off, and far better
 * evidence for "is this person production?" than a preparer's judgement. So the
 * import builds the roster: you don't hand-type employees, you review what the
 * register already says about them.
 *
 * Upload is two-step on purpose. The file is parsed and shown — detected
 * columns, matched employees, the function each department implies — and
 * nothing is written until it's confirmed. A wage attached to the wrong person
 * silently shifts the payroll factor, and with it how much cost capitalizes.
 */
import { useMemo, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  AlertTriangle, CheckCircle2, FileUp, Info, Layers, Upload,
} from "lucide-react"
import { Button, Spinner } from "@/core/ui"
import { allocationApi, money, type PayrollPreview } from "../api"

interface Props {
  periodStart: string
  periodEnd: string
}

// Kept in step with PRODUCTION_EMPLOYEE_FUNCTIONS in the engine.
const PRODUCTION = new Set(["cultivation", "processing", "packaging"])

export function PayrollPanel({ periodStart, periodEnd }: Props) {
  const [preview, setPreview] = useState<PayrollPreview | null>(null)
  const [createMissing, setCreateMissing] = useState(true)
  const [applySuggestions, setApplySuggestions] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const qc = useQueryClient()

  const { data: employees = [] } = useQuery({
    queryKey: ["allocation", "employees"],
    queryFn:  allocationApi.listEmployees,
    staleTime: 30_000,
  })

  const fail = (e: unknown, fallback: string) => {
    const ex = e as { response?: { data?: { detail?: string } }; message?: string }
    const detail = ex.response?.data?.detail
    // Axios reports a response-less failure as a bare "Network Error", which
    // tells the user nothing. Say something they can act on instead.
    const msg = detail
      ?? (ex.message === "Network Error"
        ? "The server didn't respond. The file may be too large, or the request timed out — try again."
        : ex.message)
      ?? fallback
    setError(msg)
  }

  const upload = useMutation({
    mutationFn: (file: File) => allocationApi.previewPayroll(file),
    onSuccess: (p) => { setPreview(p); setError(null); setDone(null) },
    onError: (e) => { setPreview(null); fail(e, "Could not read that file.") },
  })

  const doImport = useMutation({
    mutationFn: () => allocationApi.importPayroll({
      period_start: periodStart,
      period_end:   periodEnd,
      create_missing: createMissing,
      rows: (preview?.rows ?? []).map((r) => ({
        external_id:    r.external_id,
        name:           r.name,
        gross_wages:    Number(r.gross_wages),
        employer_taxes: Number(r.employer_taxes),
        benefits:       Number(r.benefits),
        department:     r.department,
        job_title:      r.job_title,
        // Only meaningful when creating someone new; an existing employee's
        // classification is never overwritten by an import.
        function:       applySuggestions ? r.suggested_function : null,
        production_pct: applySuggestions ? r.suggested_production_pct : null,
      })),
    }),
    onSuccess: (res) => {
      setPreview(null)
      setError(null)
      setDone(
        `Imported ${res.imported} employee${res.imported === 1 ? "" : "s"}`
        + (res.created.length ? ` · added ${res.created.length} to the roster` : "")
        + (res.unmatched.length ? ` · ${res.unmatched.length} skipped` : ""),
      )
      if (fileRef.current) fileRef.current.value = ""
      qc.invalidateQueries({ queryKey: ["allocation", "employees"] })
      qc.invalidateQueries({ queryKey: ["allocation", "readiness"] })
      // The standing "register imported" banner reads from the server, so it
      // has to be refetched or the screen still says nothing was imported.
      qc.invalidateQueries({ queryKey: ["allocation", "payroll-status"] })
    },
    onError: (e) => fail(e, "Import failed."),
  })

  const rows = preview?.rows ?? []

  const summary = useMemo(() => {
    let labor = 0
    let production = 0
    const byFunction = new Map<string, number>()
    let extraRuns = 0
    for (const r of rows) {
      const cost = Number(r.gross_wages) + Number(r.employer_taxes) + Number(r.benefits)
      labor += cost
      const fn = r.matched_employee_id ? (r.matched_function ?? "shared") : r.suggested_function
      byFunction.set(fn, (byFunction.get(fn) ?? 0) + 1)
      if (applySuggestions || r.matched_employee_id) {
        if (PRODUCTION.has(fn)) production += cost
      }
      if (r.pay_runs > 1) extraRuns += r.pay_runs - 1
    }
    return {
      labor,
      production,
      factor: labor > 0 ? (production / labor) * 100 : 0,
      byFunction: [...byFunction.entries()].sort((a, b) => b[1] - a[1]),
      extraRuns,
    }
  }, [rows, applySuggestions])

  function pick(file: File | undefined) {
    if (file) upload.mutate(file)
  }

  return (
    <div className="space-y-3 ndvx-fade-in">
      {/* Drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); pick(e.dataTransfer.files?.[0]) }}
        className="rounded-xl p-4 transition-colors"
        style={{
          background: dragging ? "var(--green-subtle)" : "var(--surface)",
          border: `1px ${dragging ? "dashed" : "solid"} ${dragging ? "var(--green)" : "var(--border)"}`,
        }}
      >
        <div className="flex items-start gap-3">
          <div className="h-9 w-9 rounded-lg grid place-items-center shrink-0"
            style={{ background: "var(--green-subtle)" }}>
            <FileUp size={17} strokeWidth={1.8} style={{ color: "var(--green)" }} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-theme">Payroll register for this period</p>
            <p className="text-xs mt-1 leading-relaxed" style={{ color: "var(--text-muted)" }}>
              Drop the period&rsquo;s CSV or Excel export from ADP, Gusto, Paychex, KayaPush
              or Rippling. Columns are detected automatically, and the register&rsquo;s own
              department and job title classify each person — so you review the roster
              rather than typing it.
            </p>

            <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls,.xlsm" className="hidden"
              onChange={(e) => pick(e.target.files?.[0])} />
            <div className="flex items-center gap-2 mt-3 flex-wrap">
              <Button onClick={() => fileRef.current?.click()} loading={upload.isPending}
                icon={<Upload size={14} strokeWidth={1.8} />}>
                {upload.isPending ? "Reading…" : "Choose file"}
              </Button>
              <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                {employees.length === 0
                  ? "No roster yet — the import will build it."
                  : `${employees.length} on the roster`}
              </span>
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-xl px-4 py-3 flex items-start gap-2 ndvx-fade-in"
          style={{ background: "var(--surface)", border: "1px solid var(--danger)" }}>
          <AlertTriangle size={14} strokeWidth={2} style={{ color: "var(--danger)" }} className="mt-0.5 shrink-0" />
          <p className="text-xs" style={{ color: "var(--text)" }}>{error}</p>
        </div>
      )}

      {done && (
        <div className="rounded-xl px-4 py-3 flex items-center gap-2 ndvx-fade-in"
          style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
          <CheckCircle2 size={14} strokeWidth={2.2} style={{ color: "var(--positive)" }} />
          <p className="text-xs text-theme">{done}</p>
        </div>
      )}

      {upload.isPending && (
        <div className="rounded-xl px-4 py-8 flex items-center justify-center gap-2"
          style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
          <Spinner className="h-4 w-4" />
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>Reading the register…</span>
        </div>
      )}

      {preview && (
        <div className="space-y-3 ndvx-fade-in">
          {/* What this file means for the factor */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
            {[
              { label: "People", value: String(rows.length) },
              { label: "Total labor cost", value: money(String(summary.labor)) },
              { label: "Counts as production", value: money(String(summary.production)), tone: "var(--green)" },
              { label: "Payroll factor", value: `${summary.factor.toFixed(2)}%`, tone: "var(--green)" },
            ].map((k) => (
              <div key={k.label} className="rounded-lg px-3.5 py-3"
                style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
                <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>{k.label}</div>
                <div className="text-base font-semibold tabular-nums mt-0.5"
                  style={{ color: k.tone ?? "var(--text)" }}>{k.value}</div>
              </div>
            ))}
          </div>

          {summary.extraRuns > 0 && (
            <p className="text-[11px] flex items-start gap-1.5" style={{ color: "var(--text-muted)" }}>
              <Layers size={12} strokeWidth={2} className="mt-[2px] shrink-0" />
              {summary.extraRuns} extra pay run{summary.extraRuns === 1 ? "" : "s"} combined —
              someone listed more than once in the month is summed into a single figure.
            </p>
          )}

          {/* Controls */}
          <div className="rounded-xl px-4 py-3 flex items-center justify-between gap-3 flex-wrap"
            style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
            <div className="flex items-center gap-4 flex-wrap text-[11.5px]" style={{ color: "var(--text-2)" }}>
              {preview.unmatched_count > 0 && (
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" checked={createMissing}
                    onChange={(e) => setCreateMissing(e.target.checked)} />
                  Add {preview.unmatched_count} new to the roster
                </label>
              )}
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={applySuggestions}
                  onChange={(e) => setApplySuggestions(e.target.checked)} />
                Classify from the register&rsquo;s department
              </label>
            </div>
            <Button onClick={() => doImport.mutate()} loading={doImport.isPending}>
              Import {rows.length} {rows.length === 1 ? "person" : "people"}
            </Button>
          </div>

          {/* What the classification will be */}
          {summary.byFunction.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {summary.byFunction.map(([fn, n]) => (
                <span key={fn} className="rounded-full px-2.5 py-1 text-[11px] font-medium"
                  style={PRODUCTION.has(fn)
                    ? { background: "var(--green-subtle)", color: "var(--green)" }
                    : { background: "var(--surface-2)", color: "var(--text-2)" }}>
                  {n} {fn}{PRODUCTION.has(fn) ? " · production" : ""}
                </span>
              ))}
            </div>
          )}

          {!applySuggestions && (
            <p className="text-[11px] flex items-start gap-1.5" style={{ color: "var(--text-muted)" }}>
              <Info size={12} strokeWidth={2} className="mt-[2px] shrink-0" />
              New people will arrive unclassified at 0% production — their wages count
              against the factor but not toward it, so nothing is overstated until you
              classify them on the Employees tab.
            </p>
          )}

          {/* The rows */}
          <div className="rounded-xl overflow-hidden"
            style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
            <div className="grid grid-cols-[minmax(0,1.5fr)_minmax(0,1.1fr)_1fr_1fr_auto] gap-3 px-4 py-2.5 text-[11px]"
              style={{ color: "var(--text-muted)", borderBottom: "1px solid var(--border)" }}>
              <span>Employee</span>
              <span>Department / title</span>
              <span className="text-right">Labor cost</span>
              <span>Function</span>
              <span className="text-right">Status</span>
            </div>
            {rows.map((r, i) => {
              const cost = Number(r.gross_wages) + Number(r.employer_taxes) + Number(r.benefits)
              const fn = r.matched_employee_id ? (r.matched_function ?? "shared") : r.suggested_function
              const counts = PRODUCTION.has(fn) && (applySuggestions || !!r.matched_employee_id)
              return (
                <div key={`${r.external_id ?? r.name}-${i}`}
                  className="grid grid-cols-[minmax(0,1.5fr)_minmax(0,1.1fr)_1fr_1fr_auto] gap-3 items-center px-4 py-2 text-[13px]"
                  style={{ borderTop: i === 0 ? undefined : "1px solid var(--border)" }}>
                  <div className="min-w-0">
                    <div className="truncate text-theme">{r.name ?? r.external_id}</div>
                    {r.pay_runs > 1 && (
                      <div className="text-[10.5px]" style={{ color: "var(--text-muted)" }}>
                        {r.pay_runs} pay runs combined
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 text-[11.5px]" style={{ color: "var(--text-2)" }}>
                    <div className="truncate">{r.department ?? "—"}</div>
                    {r.job_title && (
                      <div className="truncate text-[10.5px]" style={{ color: "var(--text-muted)" }}>
                        {r.job_title}
                      </div>
                    )}
                  </div>
                  <span className="text-right tabular-nums" style={{ color: "var(--text-2)" }}>
                    {money(String(cost))}
                  </span>
                  <span className="text-[11.5px] capitalize truncate"
                    style={{ color: counts ? "var(--green)" : "var(--text-muted)" }}
                    title={r.matched_employee_id ? "Already on the roster" : r.suggestion_reason}>
                    {fn}{counts ? "" : " · 0%"}
                  </span>
                  <span className="text-right text-[11px] justify-self-end whitespace-nowrap"
                    style={{ color: r.matched_employee_id ? "var(--positive)" : "var(--info)" }}>
                    {r.matched_employee_id ? "on roster" : "new"}
                  </span>
                </div>
              )
            })}
          </div>

          <details className="text-[11px]" style={{ color: "var(--text-muted)" }}>
            <summary className="cursor-pointer">Detected columns</summary>
            <ul className="mt-1.5 space-y-0.5 pl-4">
              {Object.entries(preview.mapping).map(([role, col]) => (
                <li key={role}>
                  {role.replace(/_/g, " ")}: <span className="text-theme">{col ?? "not found"}</span>
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </div>
  )
}
