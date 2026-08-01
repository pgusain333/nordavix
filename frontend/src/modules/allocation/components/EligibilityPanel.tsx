/**
 * EligibilityPanel — the §448(c) small-business-taxpayer test.
 *
 * First tab, because it's the gate everything else stands on: §471(c) is only
 * available below the annually indexed gross-receipts threshold, and a client
 * above it cannot use the method at all — every allocation built on it would be
 * unusable.
 *
 * The screen is built around AGGREGATION. §448(c)(2) applies §52(a)/(b) and
 * §414(m)/(o), so commonly controlled entities are tested TOGETHER. Cannabis
 * groups are routinely a cultivation LLC plus a retail LLC plus a management
 * company — each comfortably under the threshold, the group over it. Testing
 * the connected client alone is the mistake, so the table takes entities as
 * rows rather than assuming there's only one.
 *
 * Nordavix can only read the books it's connected to, so affiliate receipts are
 * entered by the preparer. That's stated plainly rather than implied.
 */
import { useMemo, useState } from "react"
import { useOrganization } from "@clerk/clerk-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  AlertTriangle, CheckCircle2, Download, Plus, Scale, ShieldCheck, Trash2, XCircle,
} from "lucide-react"
import { Button, Input, Spinner } from "@/core/ui"
import { allocationApi, money, type EligibilityEntityRow } from "../api"

interface Row {
  entity: string
  year: number
  amount: string
  source: string
}

export function EligibilityPanel({ periodEnd }: { periodEnd: string }) {
  // The method is used FOR the year the period falls in; the test looks back
  // three years from there.
  const taxYear = new Date(periodEnd + "T00:00:00").getFullYear()

  // The connected company, by name. A frozen §448(c) conclusion is read a year
  // later by someone who wasn't here; "This client" doesn't tell them which
  // entity was tested, which is precisely the question aggregation raises.
  const { organization } = useOrganization()
  const selfName = organization?.name?.trim() || "This client"

  const [rows, setRows] = useState<Row[] | null>(null)
  const [hasAfs, setHasAfs] = useState<boolean | null>(null)
  const [note, setNote] = useState("")
  const [thresholdOverride, setThresholdOverride] = useState("")
  const [error, setError] = useState<string | null>(null)
  const qc = useQueryClient()

  const { data: existing, isLoading } = useQuery({
    queryKey: ["allocation", "eligibility", taxYear],
    queryFn:  () => allocationApi.getEligibility(taxYear),
    staleTime: 30_000,
  })

  const years = useMemo(() => [taxYear - 3, taxYear - 2, taxYear - 1], [taxYear])

  // Editable rows: what's on file, else a blank sheet for this client.
  const working: Row[] = rows ?? (
    existing?.tested && existing.entities.length
      ? (existing.entities as EligibilityEntityRow[]).map((e) => ({
          entity: e.entity, year: e.year, amount: String(e.amount), source: e.source ?? "manual",
        }))
      : years.map((y) => ({ entity: selfName, year: y, amount: "", source: "manual" }))
  )

  const entityNames = useMemo(
    () => Array.from(new Set(working.map((r) => r.entity))),
    [working],
  )

  // The live conclusion, computed the same way the server will.
  const preview = useMemo(() => {
    const byYear = new Map<number, number>()
    for (const r of working) {
      const amt = Number(r.amount)
      if (!r.amount.trim() || !Number.isFinite(amt)) continue
      byYear.set(r.year, (byYear.get(r.year) ?? 0) + amt)
    }
    const present = years.filter((y) => byYear.has(y))
    if (present.length === 0) return null
    const avg = present.reduce((a, y) => a + (byYear.get(y) ?? 0), 0) / present.length
    const threshold = thresholdOverride.trim()
      ? Number(thresholdOverride)
      : Number(existing?.default_threshold ?? 0)
    return { byYear, present, avg, threshold, eligible: threshold > 0 && avg <= threshold }
  }, [working, years, thresholdOverride, existing?.default_threshold])

  const update = (i: number, patch: Partial<Row>) =>
    setRows(working.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  const suggest = useMutation({
    mutationFn: () => allocationApi.suggestReceipts(taxYear),
    onSuccess: (res) => {
      // Only fills THIS client's rows — affiliates aren't ours to read. Matches
      // on the connected company's name, and still on the old "This client"
      // label so a conclusion recorded before this change keeps working.
      const next = working.map((r) => {
        if (r.entity !== selfName && r.entity !== "This client") return r
        const hit = res.years.find((y) => y.year === r.year)
        return hit?.amount ? { ...r, amount: hit.amount, source: hit.source } : r
      })
      setRows(next); setError(null)
    },
    onError: (e: unknown) => {
      const ex = e as { response?: { data?: { detail?: string } }; message?: string }
      setError(ex.response?.data?.detail ?? ex.message ?? "Couldn't read receipts from QuickBooks.")
    },
  })

  const record = useMutation({
    mutationFn: () => allocationApi.recordEligibility({
      tax_year: taxYear,
      has_afs: hasAfs ?? existing?.has_afs ?? false,
      threshold: thresholdOverride.trim() ? Number(thresholdOverride) : null,
      aggregation_note: note.trim() || null,
      entities: working
        .filter((r) => r.entity.trim() && r.amount.trim())
        .map((r) => ({
          entity: r.entity.trim(), year: r.year,
          amount: Number(r.amount), source: r.source,
        })),
    }),
    onSuccess: () => {
      setRows(null); setError(null)
      qc.invalidateQueries({ queryKey: ["allocation", "eligibility"] })
      qc.invalidateQueries({ queryKey: ["allocation", "readiness"] })
      qc.invalidateQueries({ queryKey: ["allocation", "settings"] })
    },
    onError: (e: unknown) => {
      const ex = e as { response?: { data?: { detail?: string }; status?: number }; message?: string }
      setError(ex.response?.data?.detail ?? ex.message ?? "Couldn't record the test.")
    },
  })

  const approve = useMutation({
    mutationFn: () => allocationApi.approveEligibility(taxYear),
    onSuccess: () => {
      setError(null)
      qc.invalidateQueries({ queryKey: ["allocation", "eligibility"] })
      qc.invalidateQueries({ queryKey: ["allocation", "readiness"] })
    },
    onError: (e: unknown) => {
      const ex = e as { response?: { data?: { detail?: string }; status?: number }; message?: string }
      setError(
        ex.response?.status === 403
          ? (ex.response?.data?.detail
             ?? "This needs a reviewer other than the person who performed the test.")
          : ex.response?.data?.detail ?? ex.message ?? "Couldn't approve the conclusion.",
      )
    },
  })

  function addEntity() {
    const name = `Affiliate ${entityNames.length}`
    setRows([...working, ...years.map((y) => ({ entity: name, year: y, amount: "", source: "manual" }))])
  }
  function removeEntity(name: string) {
    setRows(working.filter((r) => r.entity !== name))
  }
  function renameEntity(from: string, to: string) {
    setRows(working.map((r) => (r.entity === from ? { ...r, entity: to } : r)))
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
      {/* Standing conclusion */}
      {existing?.tested && (
        <div className="rounded-xl px-4 py-3 flex items-start gap-2.5"
          style={{
            background: "var(--surface)",
            border: `1px solid ${existing.eligible ? "var(--green)" : "var(--danger)"}`,
          }}>
          {existing.eligible
            ? <CheckCircle2 size={17} strokeWidth={2} style={{ color: "var(--positive)" }} className="mt-0.5 shrink-0" />
            : <XCircle size={17} strokeWidth={2} style={{ color: "var(--danger)" }} className="mt-0.5 shrink-0" />}
          <div className="min-w-0">
            <p className="text-sm font-medium text-theme">
              {existing.eligible
                ? `Small business taxpayer for ${existing.tax_year}`
                : `NOT a small business taxpayer for ${existing.tax_year}`}
            </p>
            <p className="text-[11px] mt-0.5 leading-relaxed" style={{ color: "var(--text-muted)" }}>
              Three-year average {money(existing.three_year_avg ?? null)} against a{" "}
              {money(existing.threshold ?? null)} threshold
              {existing.method_available && ` · method: ${
                existing.method_available === "afs" ? "conform to the AFS" : "books and records"
              }`}
              {existing.tested_at && ` · concluded ${
                new Date(existing.tested_at).toLocaleDateString("en-US",
                  { month: "short", day: "numeric", year: "numeric" })
              }`}
            </p>
            {existing.reason && (
              <p className="text-[11px] mt-1" style={{ color: "var(--danger)" }}>{existing.reason}</p>
            )}

            {/* Maker-checker. A preparer performs the test; a reviewer signs it
                off, and never their own work. Shown as an open task rather than
                a silent state — until it's signed, the gate the whole method
                stands on is one person's unreviewed conclusion. */}
            {existing.status === "approved" ? (
              <p className="text-[11px] mt-1.5 inline-flex items-center gap-1"
                style={{ color: "var(--positive)" }}>
                <CheckCircle2 size={11} strokeWidth={2.4} />
                Approved{existing.approved_at && ` ${
                  new Date(existing.approved_at).toLocaleDateString("en-US",
                    { month: "short", day: "numeric", year: "numeric" })
                }`}
              </p>
            ) : (
              <div className="mt-2 flex items-center gap-2.5 flex-wrap">
                <span className="rounded-full px-2 py-0.5 text-[10.5px] font-medium"
                  style={{ background: "var(--warn-subtle)", color: "var(--warn)" }}>
                  Awaiting review
                </span>
                <Button onClick={() => approve.mutate()} loading={approve.isPending}
                  icon={<ShieldCheck size={13} strokeWidth={1.9} />}>
                  Approve the conclusion
                </Button>
                <span className="text-[10.5px]" style={{ color: "var(--text-muted)" }}>
                  Reviewer only, and not the person who performed the test
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="rounded-xl p-4 space-y-3"
        style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
        <div className="flex items-start gap-2.5">
          <Scale size={16} strokeWidth={2} style={{ color: "var(--green)" }} className="mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-theme">
              §448(c) test for tax year {taxYear}
            </p>
            <p className="text-[11px] mt-1 leading-relaxed" style={{ color: "var(--text-muted)" }}>
              Gross receipts for {years[0]}–{years[2]}, <strong>aggregated across commonly
              controlled entities</strong> under §448(c)(2). A cultivation LLC, a retail LLC
              and a management company are tested together — each can pass alone while the
              group fails. Nordavix can only read the books it&rsquo;s connected to, so
              affiliate figures are entered here.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => suggest.mutate()} loading={suggest.isPending}
            icon={<Download size={14} strokeWidth={1.8} />}>
            Pull this client from QuickBooks
          </Button>
          <Button variant="outline" onClick={addEntity} icon={<Plus size={14} strokeWidth={1.8} />}>
            Add affiliate
          </Button>
        </div>

        {error && <p className="text-xs" style={{ color: "var(--danger)" }}>{error}</p>}

        {/* Entity × year grid */}
        <div className="rounded-lg overflow-hidden" style={{ border: "1px solid var(--border)" }}>
          <div className="grid gap-3 px-3 py-2 text-[11px]"
            style={{
              gridTemplateColumns: `minmax(0,1.6fr) repeat(${years.length}, 1fr) auto`,
              color: "var(--text-muted)", background: "var(--surface-2)",
            }}>
            <span>Entity</span>
            {years.map((y) => <span key={y} className="text-right">{y}</span>)}
            <span />
          </div>

          {entityNames.map((name, ei) => (
            <div key={name} className="grid gap-3 items-center px-3 py-2"
              style={{
                gridTemplateColumns: `minmax(0,1.6fr) repeat(${years.length}, 1fr) auto`,
                borderTop: ei === 0 ? undefined : "1px solid var(--border)",
              }}>
              <Input value={name} onChange={(e) => renameEntity(name, e.target.value)} />
              {years.map((y) => {
                const idx = working.findIndex((r) => r.entity === name && r.year === y)
                const row = working[idx]
                return (
                  <Input key={y} type="number" placeholder="—"
                    style={{ textAlign: "right" }}
                    value={row?.amount ?? ""}
                    onChange={(e) => {
                      if (idx >= 0) update(idx, { amount: e.target.value, source: "manual" })
                      else setRows([...working, { entity: name, year: y, amount: e.target.value, source: "manual" }])
                    }} />
                )
              })}
              <button onClick={() => removeEntity(name)} aria-label={`Remove ${name}`}
                className="p-1 rounded-md justify-self-end" style={{ color: "var(--text-muted)" }}>
                <Trash2 size={14} strokeWidth={1.8} />
              </button>
            </div>
          ))}

          {/* Aggregated total per year — the figure the test actually uses. */}
          {preview && (
            <div className="grid gap-3 items-center px-3 py-2 text-[13px] font-semibold"
              style={{
                gridTemplateColumns: `minmax(0,1.6fr) repeat(${years.length}, 1fr) auto`,
                background: "var(--surface-2)", borderTop: "2px solid var(--border-strong)",
              }}>
              <span className="text-theme">Combined</span>
              {years.map((y) => (
                <span key={y} className="text-right tabular-nums text-theme">
                  {preview.byYear.has(y) ? money(String(preview.byYear.get(y))) : "—"}
                </span>
              ))}
              <span />
            </div>
          )}
        </div>

        {/* Conclusion preview */}
        {preview && (
          <div className="rounded-lg px-3.5 py-3 flex items-start gap-2.5"
            style={{ background: preview.eligible ? "var(--green-subtle)" : "var(--warn-subtle)" }}>
            {preview.eligible
              ? <CheckCircle2 size={15} strokeWidth={2} style={{ color: "var(--green)" }} className="mt-0.5 shrink-0" />
              : <AlertTriangle size={15} strokeWidth={2} style={{ color: "var(--warn)" }} className="mt-0.5 shrink-0" />}
            <div className="text-[12px]" style={{ color: "var(--text)" }}>
              <p>
                Three-year average <strong>{money(String(preview.avg))}</strong> against a{" "}
                <strong>{money(String(preview.threshold))}</strong> threshold —{" "}
                {preview.eligible ? "eligible for §471(c)." : "over the limit; §471(c) is not available."}
              </p>
              {preview.present.length < 3 && (
                <p className="mt-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
                  Only {preview.present.length} of 3 years entered — the average uses the years
                  present. A blank year is treated as missing, never as zero.
                </p>
              )}
              {existing && !existing.threshold_confirmed && (
                <p className="mt-1 text-[11px]" style={{ color: "var(--warn)" }}>
                  The threshold for {taxYear} isn&rsquo;t one we hold; the most recent known figure
                  is shown. It is indexed annually — confirm it and override below.
                </p>
              )}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="text-[11px] font-medium" style={{ color: "var(--text-muted)" }}>
              Threshold override
            </span>
            <Input type="number" value={thresholdOverride}
              placeholder={existing?.default_threshold ?? ""}
              onChange={(e) => setThresholdOverride(e.target.value)} />
          </label>
          <label className="block">
            <span className="text-[11px] font-medium" style={{ color: "var(--text-muted)" }}>
              Applicable financial statement
            </span>
            <select className="flux-input w-full"
              value={(hasAfs ?? existing?.has_afs ?? false) ? "yes" : "no"}
              onChange={(e) => setHasAfs(e.target.value === "yes")}>
              <option value="no">No AFS — books and records prong</option>
              <option value="yes">Has an AFS — must conform to it</option>
            </select>
          </label>
        </div>

        <label className="block">
          <span className="text-[11px] font-medium" style={{ color: "var(--text-muted)" }}>
            Aggregation basis <span className="font-normal">— which entities and why</span>
          </span>
          <Input value={note} placeholder="e.g. common ownership >50% by the same three individuals"
            onChange={(e) => setNote(e.target.value)} />
        </label>

        <Button onClick={() => record.mutate()} loading={record.isPending}>
          Record the conclusion
        </Button>
        <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
          Recording freezes the basis — which entities were included, each year&rsquo;s
          receipts, the threshold used and who concluded. A year later the question is
          what you tested and on what basis.
        </p>
        <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
          It lands as a <strong>draft</strong>: a reviewer other than you signs it off
          afterwards. Re-recording an approved conclusion reopens it, because the basis
          moved and the old sign-off no longer describes what&rsquo;s on file.
        </p>
      </div>
    </div>
  )
}
