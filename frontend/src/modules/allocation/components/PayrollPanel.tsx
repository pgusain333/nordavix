/**
 * PayrollPanel — upload the month's payroll register.
 *
 * QuickBooks won't give per-employee wages through the API, so this is where
 * the payroll factor's numbers come from: the CSV/XLSX every provider exports
 * (ADP, Gusto, Paychex, KayaPush, Rippling).
 *
 * Upload is a two-step on purpose. The file is parsed and shown — detected
 * columns, matched employees, unmatched rows — and nothing is written until the
 * preparer confirms. A wage attached to the wrong person silently shifts the
 * payroll factor, and with it how much cost gets capitalized.
 */
import { useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertTriangle, CheckCircle2, FileUp, Upload, Users } from "lucide-react"
import { Button, Spinner } from "@/core/ui"
import { allocationApi, money, type PayrollPreview } from "../api"

interface Props {
  periodStart: string
  periodEnd: string
}

export function PayrollPanel({ periodStart, periodEnd }: Props) {
  const [preview, setPreview] = useState<PayrollPreview | null>(null)
  const [createMissing, setCreateMissing] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const qc = useQueryClient()

  const { data: employees = [] } = useQuery({
    queryKey: ["allocation", "employees"],
    queryFn:  allocationApi.listEmployees,
  })

  const fail = (e: unknown, fallback: string) => {
    const ex = e as { response?: { data?: { detail?: string } }; message?: string }
    setError(ex.response?.data?.detail ?? ex.message ?? fallback)
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
      })),
    }),
    onSuccess: (res) => {
      setPreview(null)
      setError(null)
      setDone(
        `Imported ${res.imported} employee${res.imported === 1 ? "" : "s"}`
        + (res.created.length ? ` · created ${res.created.length}` : "")
        + (res.unmatched.length ? ` · ${res.unmatched.length} skipped` : ""),
      )
      if (fileRef.current) fileRef.current.value = ""
      qc.invalidateQueries({ queryKey: ["allocation", "employees"] })
      qc.invalidateQueries({ queryKey: ["allocation", "readiness"] })
    },
    onError: (e) => fail(e, "Import failed."),
  })

  const totals = (preview?.rows ?? []).reduce(
    (acc, r) => acc + Number(r.gross_wages) + Number(r.employer_taxes) + Number(r.benefits),
    0,
  )

  return (
    <div className="space-y-3">
      <div className="rounded-xl p-4"
        style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
        <div className="flex items-start gap-3">
          <div className="h-9 w-9 rounded-lg grid place-items-center shrink-0"
            style={{ background: "var(--green-subtle)" }}>
            <FileUp size={17} strokeWidth={1.8} style={{ color: "var(--green)" }} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-theme">Payroll register for this period</p>
            <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
              Export the period&rsquo;s register from ADP, Gusto, Paychex, KayaPush or
              Rippling and drop the CSV or Excel file here. Columns are detected
              automatically, and nothing is saved until you review the match.
            </p>

            <input
              ref={fileRef}
              type="file"
              accept=".csv,.xlsx,.xls,.xlsm"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) upload.mutate(f)
              }}
            />
            <div className="flex items-center gap-2 mt-3">
              <Button onClick={() => fileRef.current?.click()} loading={upload.isPending}
                icon={<Upload size={14} strokeWidth={1.8} />}>
                Choose file
              </Button>
              {employees.length === 0 && (
                <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                  No employees classified yet — importing can create them for you.
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-xl px-4 py-3 flex items-start gap-2"
          style={{ background: "var(--surface)", border: "1px solid var(--danger)" }}>
          <AlertTriangle size={14} strokeWidth={2} style={{ color: "var(--danger)" }} className="mt-0.5 shrink-0" />
          <p className="text-xs" style={{ color: "var(--text)" }}>{error}</p>
        </div>
      )}

      {done && (
        <div className="rounded-xl px-4 py-3 flex items-center gap-2"
          style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
          <CheckCircle2 size={14} strokeWidth={2.2} style={{ color: "var(--positive)" }} />
          <p className="text-xs text-theme">{done}</p>
        </div>
      )}

      {preview && (
        <>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              {preview.rows.length} rows · {preview.matched_count} matched
              {preview.unmatched_count > 0 && (
                <span style={{ color: "var(--warn)" }}> · {preview.unmatched_count} unmatched</span>
              )}
              {" · "}{money(String(totals))} total labor cost
            </p>
            <div className="flex items-center gap-2">
              {preview.unmatched_count > 0 && (
                <label className="flex items-center gap-1.5 text-[11.5px] cursor-pointer"
                  style={{ color: "var(--text-2)" }}>
                  <input type="checkbox" checked={createMissing}
                    onChange={(e) => setCreateMissing(e.target.checked)} />
                  Create the {preview.unmatched_count} missing
                </label>
              )}
              <Button onClick={() => doImport.mutate()} loading={doImport.isPending}>
                Import {preview.rows.length} rows
              </Button>
            </div>
          </div>

          {preview.unmatched_count > 0 && createMissing && (
            <p className="text-[11px] flex items-start gap-1.5" style={{ color: "var(--text-muted)" }}>
              <Users size={12} strokeWidth={2} className="mt-[2px] shrink-0" />
              New employees are created unclassified at 0% production — their wages
              count against the factor but not toward it, so nothing is overstated
              before you set their function on the Employees tab.
            </p>
          )}

          <div className="rounded-xl overflow-hidden"
            style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
            <div className="grid grid-cols-[minmax(0,1.8fr)_1fr_1fr_1fr_auto] gap-3 px-4 py-2.5 text-[11px]"
              style={{ color: "var(--text-muted)", borderBottom: "1px solid var(--border)" }}>
              <span>Employee</span>
              <span className="text-right">Gross</span>
              <span className="text-right">Er taxes</span>
              <span className="text-right">Benefits</span>
              <span className="text-right">Match</span>
            </div>
            {preview.rows.map((r, i) => (
              <div key={`${r.external_id ?? r.name}-${i}`}
                className="grid grid-cols-[minmax(0,1.8fr)_1fr_1fr_1fr_auto] gap-3 items-center px-4 py-2 text-[13px]"
                style={{ borderTop: i === 0 ? undefined : "1px solid var(--border)" }}>
                <div className="min-w-0">
                  <div className="truncate text-theme">{r.name ?? r.external_id}</div>
                  {r.external_id && r.name && (
                    <div className="text-[10.5px]" style={{ color: "var(--text-muted)" }}>{r.external_id}</div>
                  )}
                </div>
                <span className="text-right tabular-nums" style={{ color: "var(--text-2)" }}>
                  {money(r.gross_wages)}
                </span>
                <span className="text-right tabular-nums" style={{ color: "var(--text-2)" }}>
                  {money(r.employer_taxes)}
                </span>
                <span className="text-right tabular-nums" style={{ color: "var(--text-2)" }}>
                  {money(r.benefits)}
                </span>
                <span className="text-right text-[11px] justify-self-end whitespace-nowrap"
                  style={{ color: r.matched_employee_id ? "var(--positive)" : "var(--warn)" }}>
                  {r.matched_employee_id ? (r.matched_function ?? "matched") : "new"}
                </span>
              </div>
            ))}
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
        </>
      )}

      {upload.isPending && (
        <div className="flex justify-center py-6"><Spinner className="h-5 w-5" /></div>
      )}
    </div>
  )
}
