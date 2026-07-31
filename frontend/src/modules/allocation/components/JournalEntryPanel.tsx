/**
 * JournalEntryPanel — the reclass entry, reviewable before it leaves the app.
 *
 * Dr inventory / Cr the expense accounts for their capitalized share. Shown as
 * a real two-column journal so a preparer can read it the way they'd read it in
 * QuickBooks, with an explicit balanced check — an entry that doesn't foot must
 * never look postable.
 *
 * Export is the QuickBooks Online "Import journal entries" CSV, generated
 * server-side by the same builder the Adjustments export uses, so the column
 * layout is the one already proven against QBO.
 */
import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet } from "lucide-react"
import { Button, Spinner } from "@/core/ui"
import { allocationApi, money } from "../api"

interface Props {
  runId: string
  periodEnd: string
}

export function JournalEntryPanel({ runId, periodEnd }: Props) {
  const [busy, setBusy] = useState<"je" | "wp" | null>(null)
  const [error, setError] = useState<string | null>(null)

  const { data: je, isLoading } = useQuery({
    queryKey: ["allocation", "journal-entry", runId],
    queryFn:  () => allocationApi.getJournalEntry(runId),
  })

  async function download(kind: "je" | "wp") {
    setBusy(kind); setError(null)
    try {
      if (kind === "je") await allocationApi.downloadJournalEntryCsv(runId, periodEnd)
      else await allocationApi.downloadWorkpaperCsv(runId, periodEnd)
    } catch (e) {
      const ex = e as { response?: { data?: { detail?: string } }; message?: string }
      setError(ex.response?.data?.detail ?? ex.message ?? "Download failed.")
    } finally {
      setBusy(null)
    }
  }

  if (isLoading) {
    return (
      <div className="rounded-xl p-5 flex justify-center"
        style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
        <Spinner className="h-5 w-5" />
      </div>
    )
  }

  return (
    <div className="rounded-xl overflow-hidden"
      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <div className="flex items-center justify-between gap-3 flex-wrap px-4 py-3"
        style={{ borderBottom: "1px solid var(--border)" }}>
        <div>
          <h3 className="text-sm font-semibold text-theme">Reclass journal entry</h3>
          <p className="text-[11px] mt-0.5" style={{ color: "var(--text-muted)" }}>
            Capitalizes production cost into inventory
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => download("wp")} loading={busy === "wp"}
            icon={<FileSpreadsheet size={14} strokeWidth={1.8} />}>
            Workpaper CSV
          </Button>
          <Button onClick={() => download("je")} loading={busy === "je"}
            disabled={!je?.available}
            icon={<Download size={14} strokeWidth={1.8} />}>
            QuickBooks JE CSV
          </Button>
        </div>
      </div>

      {error && (
        <p className="px-4 pt-3 text-xs" style={{ color: "var(--danger)" }}>{error}</p>
      )}

      {!je?.available ? (
        <div className="px-5 py-8 text-center">
          <AlertTriangle size={18} strokeWidth={1.8} style={{ color: "var(--warn)" }} className="mx-auto mb-2" />
          <p className="text-sm font-medium text-theme">No journal entry yet</p>
          <p className="text-xs mt-1 max-w-md mx-auto" style={{ color: "var(--text-muted)" }}>
            {je?.reason ?? "Nothing to post for this period."}
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-[minmax(0,2fr)_1fr_1fr] gap-3 px-4 py-2 text-[11px]"
            style={{ color: "var(--text-muted)", borderBottom: "1px solid var(--border)" }}>
            <span>Account</span>
            <span className="text-right">Debit</span>
            <span className="text-right">Credit</span>
          </div>

          {je.lines.map((ln, i) => {
            const isDebit = Number(ln.debit) > 0
            return (
              <div key={`${ln.account_qbo_id ?? ln.account_name}-${i}`}
                className="grid grid-cols-[minmax(0,2fr)_1fr_1fr] gap-3 px-4 py-2 text-[13px]"
                style={{ borderTop: i === 0 ? undefined : "1px solid var(--border)" }}>
                {/* Credits indent, the way a journal entry reads on paper. */}
                <span className="truncate text-theme" style={{ paddingLeft: isDebit ? 0 : 16 }}>
                  {ln.account_name}
                </span>
                <span className="text-right tabular-nums" style={{ color: "var(--text-2)" }}>
                  {Number(ln.debit) > 0 ? money(ln.debit) : ""}
                </span>
                <span className="text-right tabular-nums" style={{ color: "var(--text-2)" }}>
                  {Number(ln.credit) > 0 ? money(ln.credit) : ""}
                </span>
              </div>
            )
          })}

          <div className="grid grid-cols-[minmax(0,2fr)_1fr_1fr] gap-3 px-4 py-2.5 text-[13px] font-semibold"
            style={{ background: "var(--surface-2)", borderTop: "2px solid var(--border-strong)" }}>
            <span className="inline-flex items-center gap-1.5 text-theme">
              {je.balanced
                ? <CheckCircle2 size={13} strokeWidth={2.2} style={{ color: "var(--positive)" }} />
                : <AlertTriangle size={13} strokeWidth={2.2} style={{ color: "var(--danger)" }} />}
              {je.balanced ? "Balanced" : "Out of balance"}
            </span>
            <span className="text-right tabular-nums text-theme">{money(je.total_debits)}</span>
            <span className="text-right tabular-nums text-theme">{money(je.total_credits)}</span>
          </div>

          {je.rationale && (
            <p className="px-4 py-3 text-[11px] leading-relaxed"
              style={{ color: "var(--text-muted)", borderTop: "1px solid var(--border)" }}>
              {je.rationale}
            </p>
          )}
        </>
      )}
    </div>
  )
}
