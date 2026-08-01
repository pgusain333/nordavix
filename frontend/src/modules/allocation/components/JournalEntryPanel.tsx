/**
 * JournalEntryPanel — the reclass entry, reviewable before it leaves the app.
 *
 * Each capitalized expense account is reclassed into its own mirror COGS
 * account — Dr "Other COGS - Rent" / Cr "Rent" — so the origin of every COGS
 * figure stays visible on the face of the trial balance. Shown as a real
 * two-column journal with an explicit balanced check, because an entry that
 * doesn't foot must never look postable.
 *
 * The mirror accounts have to EXIST in QuickBooks before the CSV will import —
 * QBO matches journal lines on account name — so they're listed up front.
 *
 * Export is the QuickBooks Online "Import journal entries" CSV, generated
 * server-side by the same builder the Adjustments export uses, so the column
 * layout is the one already proven against QBO.
 */
import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  AlertTriangle, BookCheck, CheckCircle2, Download, FileSpreadsheet,
} from "lucide-react"
import { Button, Spinner } from "@/core/ui"
import { allocationApi, money, type PostingCheck } from "../api"

interface Props {
  runId: string
  periodEnd: string
}

export function JournalEntryPanel({ runId, periodEnd }: Props) {
  const [busy, setBusy] = useState<"je" | "wp" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [check, setCheck] = useState<PostingCheck | null>(null)
  const qc = useQueryClient()

  // §471(c) is a books-and-records method: an entry that was exported but never
  // posted leaves the ledger showing ordinary expense while the allocation
  // claims COGS. Verifying it is what makes the position real rather than
  // merely computed.
  const verify = useMutation({
    mutationFn: () => allocationApi.checkPosting(runId),
    onSuccess: (r) => {
      setCheck(r); setError(null)
      qc.invalidateQueries({ queryKey: ["allocation", "run"] })
      qc.invalidateQueries({ queryKey: ["allocation", "runs"] })
    },
    onError: (e: unknown) => {
      const ex = e as { response?: { data?: { detail?: string } }; message?: string }
      setError(ex.response?.data?.detail ?? ex.message ?? "Couldn't check the books.")
    },
  })

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
Reclasses production cost into COGS
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

          {/* Book conformity — the step that makes the method defensible. */}
          <div className="px-4 py-3 flex items-start justify-between gap-3 flex-wrap"
            style={{ borderTop: "1px solid var(--border)" }}>
            <div className="flex items-start gap-2 min-w-0">
              <BookCheck size={15} strokeWidth={2} className="mt-0.5 shrink-0"
                style={{ color: check?.posted ? "var(--positive)" : "var(--text-muted)" }} />
              <div className="min-w-0">
                <p className="text-[12.5px] font-medium text-theme">
                  {check?.posted
                    ? `Posted in QuickBooks${check.doc_number ? ` — ${check.doc_number}` : ""}`
                    : check?.checked
                      ? "Not found in QuickBooks yet"
                      : "Books not verified"}
                </p>
                <p className="text-[11px] mt-0.5 max-w-lg leading-relaxed"
                  style={{ color: "var(--text-muted)" }}>
                  {check?.reason
                    ?? (check?.posted
                      ? "The ledger agrees with the allocation."
                      : "§471(c) is a books-and-records method — the entry has to reach "
                        + "the client's ledger for the position to hold. Import the CSV "
                        + "into QuickBooks, then verify.")}
                </p>
              </div>
            </div>
            <Button variant="outline" onClick={() => verify.mutate()} loading={verify.isPending}
              icon={<BookCheck size={14} strokeWidth={1.8} />}>
              Verify books
            </Button>
          </div>

          {je.cogs_accounts.length > 0 && (
            <div className="px-4 py-3" style={{ borderTop: "1px solid var(--border)" }}>
              <p className="text-[11px] font-medium text-theme">
                Create these {je.cogs_accounts.length} accounts in QuickBooks first
              </p>
              <p className="text-[10.5px] mt-0.5" style={{ color: "var(--text-muted)" }}>
                QuickBooks matches journal lines on account name and rejects the file if
                one is missing. Add them as Cost of Goods Sold accounts.
              </p>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {je.cogs_accounts.map((a) => (
                  <span key={a} className="rounded-md px-2 py-0.5 text-[11px]"
                    style={{ background: "var(--surface-2)", color: "var(--text-2)" }}>{a}</span>
                ))}
              </div>
            </div>
          )}

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
