/**
 * AllocationExports — the two things that leave the building.
 *
 * A working file that gets defended, and a report that gets circulated. Both
 * are built from one dataset, so they can't tell different stories about the
 * same year — a firm that hands a client a report which doesn't tie to its own
 * workpaper has a problem no formatting fixes.
 *
 * Readiness is stated BEFORE the download button rather than discovered in the
 * file. Exporting an incomplete year is allowed — that's how a draft gets
 * reviewed — but the screen says what's outstanding first, and the PDF comes
 * back watermarked.
 */
import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import {
  AlertTriangle, ArrowRight, CheckCircle2, Download, FileSpreadsheet, FileText,
  Table2,
} from "lucide-react"
import { Select, Spinner } from "@/core/ui"
import { allocationApi, money } from "../api"

type Busy = "xlsx" | "pdf" | "csv" | null

export function AllocationExports() {
  const [taxYear, setTaxYear] = useState<number | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState<string | null>(null)

  const { data: yearsInfo } = useQuery({
    queryKey: ["allocation", "tax-years"],
    queryFn:  allocationApi.listTaxYears,
    staleTime: 60_000,
  })
  useEffect(() => {
    if (taxYear === null && yearsInfo?.years.length) setTaxYear(yearsInfo.years[0])
  }, [taxYear, yearsInfo])

  const { data, isLoading } = useQuery({
    queryKey: ["allocation", "annual", taxYear],
    queryFn:  () => allocationApi.getAnnual(taxYear!),
    enabled:  taxYear !== null,
  })

  async function run(kind: Exclude<Busy, null>, fn: () => Promise<void>) {
    setBusy(kind); setError(null)
    try { await fn() } catch (e) {
      const ex = e as { response?: { data?: { detail?: string } }; message?: string }
      setError(ex.response?.data?.detail ?? ex.message ?? "The export failed.")
    } finally { setBusy(null) }
  }

  const c = data?.checklist
  const outstanding = c
    ? c.missing_periods.length + c.unapproved_periods.length
      + c.unposted_periods.length + c.inventory_breaks.length
    : 0

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[1180px] mx-auto px-5 py-6 space-y-5">

        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-lg font-semibold text-theme tracking-tight">Export</h1>
            <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
              The working file and the client deliverable, both built from the same year
            </p>
          </div>
          <Select
            value={taxYear ?? ""}
            onChange={(e) => setTaxYear(Number(e.target.value))}
            className="w-[150px]"
            aria-label="Tax year"
          >
            {(yearsInfo?.years ?? []).map((y) => (
              <option key={y} value={y}>Tax year {y}</option>
            ))}
          </Select>
        </div>

        {isLoading || !data ? (
          <div className="flex justify-center py-16"><Spinner className="h-5 w-5" /></div>
        ) : (
          <>
            {/* What's about to be exported */}
            <div className="rounded-xl p-4"
              style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
              <div className="flex items-center gap-2">
                {data.complete
                  ? <CheckCircle2 size={17} strokeWidth={2} style={{ color: "var(--positive)" }} />
                  : <AlertTriangle size={17} strokeWidth={2} style={{ color: "var(--warn)" }} />}
                <span className="text-sm font-semibold text-theme">
                  {data.complete
                    ? `Tax year ${data.tax_year} is complete`
                    : `Tax year ${data.tax_year} is a draft`}
                </span>
              </div>
              <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
                {data.complete
                  ? "Every period is allocated, approved and confirmed in the books."
                  : `${outstanding} item${outstanding === 1 ? "" : "s"} outstanding. You can still `
                    + "export — the report comes back watermarked DRAFT and says why on the cover."}
              </p>

              <div className="mt-3.5 pt-3 flex flex-wrap gap-x-6 gap-y-1.5 text-[11.5px]"
                style={{ borderTop: "1px solid var(--border)", color: "var(--text-muted)" }}>
                <span>
                  {data.frequency === "annual" ? "Annual allocation" : "Monthly allocation"}
                  {" · "}{c!.months_present} of {c!.months_expected} period
                  {c!.months_expected === 1 ? "" : "s"}
                </span>
                <span>Capitalized {money(data.totals.capitalized)}</span>
                <span>Disallowed {money(data.totals.disallowed)}</span>
                {data.roll_forward && <span>COGS {money(data.roll_forward.cogs)}</span>}
              </div>

              {!data.complete && (
                <Link to="/allocation/year-end"
                  className="inline-flex items-center gap-1 text-[11.5px] font-medium mt-2.5"
                  style={{ color: "var(--green)" }}>
                  See what&rsquo;s outstanding <ArrowRight size={11} strokeWidth={2} />
                </Link>
              )}
            </div>

            {error && (
              <p className="text-xs" style={{ color: "var(--danger)" }}>{error}</p>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
              <ExportCard
                icon={FileSpreadsheet}
                title="Excel workbook"
                kicker="The working file"
                blurb="Seven sheets: cover and completeness, annual summary with the roll-forward and Form 1125-A, the period roll, account detail, pools, drivers, and the §448(c) test as performed."
                detail={[
                  "Money is written as numbers with a format, so every column foots",
                  "Registries are shown as at year end — the state the year was allocated on",
                  "Each sheet stands alone away from the app",
                ]}
                cta="Download .xlsx"
                loading={busy === "xlsx"}
                disabled={busy !== null}
                onClick={() => run("xlsx", () => allocationApi.downloadWorkbookXlsx(data.tax_year))}
              />

              <ExportCard
                icon={FileText}
                title="Client report"
                kicker="The deliverable"
                blurb="A PDF a firm can put its name on: the method and the authority for it, the §448(c) conclusion, the completeness controls, what the year concluded, Form 1125-A, and the basis behind every driver."
                detail={[
                  "Leads with method and eligibility — the numbers only matter if the method is available",
                  "An incomplete year is watermarked and stated on the cover",
                  "Carries the standard scope note: not a tax opinion, not assurance",
                ]}
                cta="Download .pdf"
                loading={busy === "pdf"}
                disabled={busy !== null}
                onClick={() => run("pdf", () => allocationApi.downloadClientReportPdf(data.tax_year))}
              />
            </div>

            {/* Narrower exports that already existed, kept findable. */}
            <div className="rounded-xl overflow-hidden"
              style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
              <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
                <h2 className="text-[13px] font-semibold text-theme">Single-purpose files</h2>
              </div>
              <button
                onClick={() => run("csv", () => allocationApi.downloadAnnualWorkpaperCsv(data.tax_year))}
                disabled={busy !== null}
                className="w-full flex items-center gap-3 px-4 py-3 text-left transition-opacity hover:opacity-80 disabled:opacity-50">
                <Table2 size={15} strokeWidth={1.8} style={{ color: "var(--text-muted)" }} />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] text-theme">Annual workpaper (CSV)</div>
                  <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                    Flat file — the checklist, period roll, account detail and 1125-A lines
                  </div>
                </div>
                {busy === "csv"
                  ? <Spinner className="h-4 w-4" />
                  : <Download size={14} strokeWidth={1.8} style={{ color: "var(--text-muted)" }} />}
              </button>
              <div className="px-4 py-3 flex items-center gap-3"
                style={{ borderTop: "1px solid var(--border)" }}>
                <Table2 size={15} strokeWidth={1.8} style={{ color: "var(--text-muted)" }} />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] text-theme">Per-period workpaper and journal entry</div>
                  <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                    The QuickBooks JE import CSV lives with the run that produced it
                  </div>
                </div>
                <Link to="/allocation/runs"
                  className="text-[11.5px] font-medium inline-flex items-center gap-1 shrink-0"
                  style={{ color: "var(--green)" }}>
                  Open runs <ArrowRight size={11} strokeWidth={2} />
                </Link>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function ExportCard({
  icon: Icon, title, kicker, blurb, detail, cta, loading, disabled, onClick,
}: {
  icon: typeof FileText
  title: string; kicker: string; blurb: string; detail: string[]
  cta: string; loading: boolean; disabled: boolean; onClick: () => void
}) {
  return (
    <div className="rounded-xl p-4 flex flex-col h-full"
      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <div className="flex items-center gap-2.5">
        <div className="h-8 w-8 rounded-lg grid place-items-center shrink-0"
          style={{ background: "var(--green-subtle)" }}>
          <Icon size={16} strokeWidth={1.8} style={{ color: "var(--green)" }} />
        </div>
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-wider"
            style={{ color: "var(--text-muted)" }}>{kicker}</div>
          <h2 className="text-[14px] font-semibold text-theme">{title}</h2>
        </div>
      </div>

      <p className="text-xs mt-3 leading-relaxed" style={{ color: "var(--text-2)" }}>{blurb}</p>

      <ul className="mt-3 space-y-1.5 flex-1">
        {detail.map((d) => (
          <li key={d} className="flex items-start gap-2 text-[11.5px] leading-snug"
            style={{ color: "var(--text-muted)" }}>
            <span className="mt-[6px] h-1 w-1 rounded-full shrink-0"
              style={{ background: "var(--text-muted)" }} />
            {d}
          </li>
        ))}
      </ul>

      <button onClick={onClick} disabled={disabled}
        className="mt-4 w-full inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-[12.5px] font-medium transition-opacity hover:opacity-90 disabled:opacity-50"
        style={{ background: "var(--green)", color: "#fff" }}>
        {loading ? <Spinner className="h-4 w-4" /> : <Download size={14} strokeWidth={2} />}
        {loading ? "Building…" : cta}
      </button>
    </div>
  )
}
