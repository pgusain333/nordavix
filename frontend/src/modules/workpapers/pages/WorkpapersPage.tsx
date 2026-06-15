/**
 * Workpapers — the on-screen close binder.
 *
 * Left: a sectioned binder index that mirrors the exported PDF 1:1 — close
 * certificate, financial statements, reconciliations (per account), schedules,
 * adjustments, flux, supporting documents, audit trail. Right: the selected
 * workpaper with its tie-out (for accounts), attached evidence, a drop zone, and
 * a link into the source module.
 *
 * The index is composed client-side from the modules that already own each
 * section (recon overview for the per-account rows) + the workpaper evidence
 * counts (W1). Evidence attaches per (period, ref_type, ref_id); the Close
 * Binder folds it in as a referenced appendix (W3). Read-only QBO throughout.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { useOrganization } from "@clerk/clerk-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import {
  AlertTriangle, BookOpen, CheckCircle2, ChevronRight, Circle, Clock,
  Download, ExternalLink, FileText, FolderOpen, Lock, Paperclip, Scale,
  Trash2, Upload,
} from "lucide-react"
import { Button, Spinner } from "@/core/ui/components"
import { PageHeader } from "@/core/ui/PageHeader"
import { useSelectedPeriod } from "@/core/hooks/useSelectedPeriod"
import { closeApi } from "@/modules/close/api"
import { reconsApi, type OverviewAccount } from "@/modules/recons/api"
import { financialsApi } from "@/modules/financials/api"
import { workpapersApi, type WpEvidence, type WpRefType } from "@/modules/workpapers/api"

interface WpRow {
  key:      string
  refType:  WpRefType | "system"
  refId:    string | null
  index:    string
  title:    string
  subtitle?: string
  state:    "done" | "review" | "flag" | "open" | "section" | "system"
  deepLink?: string
  uploadable: boolean
}

function fmtUsd(s: string | number | null | undefined): string {
  if (s == null || s === "") return "$0"
  const n = Number(s)
  if (Number.isNaN(n)) return "—"
  return `$${Math.abs(Math.round(n)).toLocaleString()}`
}

function acctState(s: string): WpRow["state"] {
  return s === "approved" ? "done" : s === "flagged" ? "flag" : s === "reviewed" ? "review" : "open"
}

function StateIcon({ state }: { state: WpRow["state"] }) {
  if (state === "done")    return <CheckCircle2 size={16} strokeWidth={2} style={{ color: "var(--green)" }} />
  if (state === "flag")    return <AlertTriangle size={16} strokeWidth={2} style={{ color: "var(--danger)" }} />
  if (state === "review")  return <Clock size={16} strokeWidth={2} style={{ color: "var(--warn)" }} />
  if (state === "section") return <FolderOpen size={16} strokeWidth={1.9} style={{ color: "var(--text-muted)" }} />
  if (state === "system")  return <Lock size={16} strokeWidth={1.9} style={{ color: "var(--text-muted)" }} />
  return <Circle size={16} strokeWidth={2} style={{ color: "var(--text-muted)" }} />
}

export function WorkpapersPage() {
  const { organization } = useOrganization()
  const qc = useQueryClient()
  const navigate = useNavigate()

  const { data: periodsResp } = useQuery({
    queryKey: ["close", "periods"], queryFn: closeApi.getPeriods, enabled: !!organization,
  })
  const fallback = periodsResp?.focus || periodsResp?.periods[0]?.period_end || ""
  const [period, setPeriod] = useSelectedPeriod(fallback)
  const activePeriod = period || fallback
  const periodMeta = periodsResp?.periods.find((p) => p.period_end === activePeriod)

  const { data: overview, isLoading: ovLoading } = useQuery({
    queryKey: ["reconciliations", "overview", activePeriod],
    queryFn:  () => reconsApi.getOverview(activePeriod),
    enabled:  !!organization && !!activePeriod,
  })
  const { data: summary } = useQuery({
    queryKey: ["workpapers", "evidence-summary", activePeriod],
    queryFn:  () => workpapersApi.evidenceSummary(activePeriod),
    enabled:  !!organization && !!activePeriod,
  })

  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [binderErr, setBinderErr] = useState<string | null>(null)

  const cnt = (refType: string, refId: string | null) =>
    summary?.counts[`${refType}:${refId ?? ""}`] ?? 0

  const accounts: OverviewAccount[] = useMemo(() => overview?.accounts ?? [], [overview])

  // The binder index: per-account recon rows + section rows + system rows.
  const rows: WpRow[] = useMemo(() => {
    const acctRows: WpRow[] = accounts.map((a) => ({
      key: `account:${a.qbo_id}`, refType: "account", refId: a.qbo_id, index: "3",
      title: a.account_name, subtitle: a.group_label,
      state: acctState(a.review_status), deepLink: "/app/reconciliations", uploadable: true,
    }))
    return [
      { key: "system:certificate", refType: "system", refId: null, index: "1", title: "Close certificate", state: overview?.is_closed ? "done" : "system", uploadable: false },
      { key: "financials:statements", refType: "financials", refId: "statements", index: "2", title: "Financial statements", state: "section", deepLink: "/app/financials", uploadable: true },
      ...acctRows,
      { key: "schedule:section", refType: "schedule", refId: "section", index: "4", title: "Schedules", state: "section", deepLink: "/app/schedules", uploadable: true },
      { key: "adjustment:section", refType: "adjustment", refId: "section", index: "5", title: "Adjustments", state: "section", deepLink: "/app/adjustments", uploadable: true },
      { key: "flux:section", refType: "flux", refId: "section", index: "6", title: "Flux analysis", state: "section", deepLink: "/app/flux", uploadable: true },
      { key: "general:", refType: "general", refId: null, index: "7", title: "Supporting documents", state: "section", uploadable: true },
      { key: "system:audit", refType: "system", refId: null, index: "8", title: "Audit trail", subtitle: "auto", state: "system", uploadable: false },
    ]
  }, [accounts, overview?.is_closed])

  // Default the selection to the first account (or the general bucket) once loaded.
  useEffect(() => {
    if (selectedKey || rows.length === 0) return
    const firstAccount = rows.find((r) => r.refType === "account")
    setSelectedKey(firstAccount?.key ?? "general:")
  }, [rows, selectedKey])

  const selected = rows.find((r) => r.key === selectedKey) ?? null
  const selectedAccount = selected?.refType === "account"
    ? accounts.find((a) => a.qbo_id === selected.refId) : undefined

  const { data: evidence, isLoading: evLoading } = useQuery({
    queryKey: ["workpapers", "evidence", activePeriod, selected?.refType, selected?.refId],
    queryFn:  () => workpapersApi.listEvidence(activePeriod, selected!.refType, selected!.refId),
    enabled:  !!organization && !!activePeriod && !!selected && selected.uploadable,
  })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["workpapers", "evidence", activePeriod] })
    qc.invalidateQueries({ queryKey: ["workpapers", "evidence-summary", activePeriod] })
  }
  const uploadMut = useMutation({
    mutationFn: (file: File) => workpapersApi.uploadEvidence({
      periodEnd: activePeriod, refType: selected!.refType as WpRefType, refId: selected!.refId, file,
    }),
    onSuccess: invalidate,
  })
  const deleteMut = useMutation({
    mutationFn: (id: string) => workpapersApi.deleteEvidence(id),
    onSuccess: invalidate,
  })
  const binderMut = useMutation({
    mutationFn: () => financialsApi.downloadCloseBinder(activePeriod),
    onMutate: () => setBinderErr(null),
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { detail?: string } }; message?: string })
      setBinderErr(msg?.response?.data?.detail ?? msg?.message ?? "Couldn't generate the binder.")
    },
  })

  const fileRef = useRef<HTMLInputElement>(null)
  const onPick = (f: File | null | undefined) => { if (f) uploadMut.mutate(f) }

  const total = accounts.length
  const approved = accounts.filter((a) => a.review_status === "approved").length

  if (!organization) {
    return (
      <>
        <PageHeader title="Workpapers" />
        <div className="p-6 text-sm" style={{ color: "var(--text-muted)" }}>Select a workspace to open its workpapers.</div>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Workpapers"
        subtitle={periodMeta ? `${periodMeta.label}${periodMeta.closed ? " · closed" : ""}` : "Close binder"}
        actions={
          <div className="flex items-center gap-2">
            {periodsResp && periodsResp.periods.length > 0 && (
              <select value={activePeriod} onChange={(e) => { setPeriod(e.target.value); setSelectedKey(null); setBinderErr(null) }}
                className="rounded-lg px-3 py-1.5 text-sm outline-none"
                style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }}>
                {periodsResp.periods.map((p) => (
                  <option key={p.period_end} value={p.period_end}>{p.label}{p.closed ? " · closed" : ""}</option>
                ))}
              </select>
            )}
            <Button size="sm" loading={binderMut.isPending} disabled={!activePeriod}
              onClick={() => binderMut.mutate()} icon={<BookOpen size={14} strokeWidth={2} />}>
              Generate close binder
            </Button>
          </div>
        }
      />

      <div className="px-4 sm:px-6 py-4">
        {binderErr && (
          <div className="rounded-xl px-4 py-3 text-[12px] mb-4"
            style={{ background: "var(--warn-subtle)", color: "var(--warn)", border: "1px solid var(--warn-border)" }}>
            {binderErr}
          </div>
        )}

        {/* Reassurance strip — recon completeness */}
        <div className="flex items-center gap-2 mb-4 text-[13px]" style={{ color: "var(--text-muted)" }}>
          <Scale size={15} strokeWidth={1.9} />
          <span><span className="font-semibold" style={{ color: total && approved === total ? "var(--green)" : "var(--text-2)" }}>{approved} of {total}</span> accounts reconciled</span>
        </div>

        <div className="grid gap-3" style={{ gridTemplateColumns: "minmax(0, 0.92fr) minmax(0, 1.08fr)" }}>

          {/* ── Binder index ── */}
          <div className="rounded-2xl overflow-hidden" style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
            <div className="text-[11px] uppercase tracking-wide px-4 pt-3 pb-1" style={{ color: "var(--text-muted)" }}>Binder index</div>
            {ovLoading && !overview ? (
              <div className="flex items-center gap-2 px-4 py-6"><Spinner className="h-4 w-4" /><span className="text-[12px]" style={{ color: "var(--text-muted)" }}>Loading…</span></div>
            ) : (
              <div className="pb-2">
                {rows.map((r) => {
                  const isAcct = r.refType === "account"
                  const n = r.uploadable ? cnt(r.refType, r.refId) : 0
                  const isSel = r.key === selectedKey
                  return (
                    <div key={r.key} onClick={() => setSelectedKey(r.key)}
                      className="flex items-center gap-2.5 cursor-pointer transition-colors"
                      style={{
                        padding: isAcct ? "6px 12px 6px 30px" : "9px 12px",
                        background: isSel ? "var(--surface-2)" : "transparent",
                        borderLeft: isSel ? "2px solid var(--green)" : "2px solid transparent",
                      }}>
                      {!isAcct && <span className="text-[12px] w-4 shrink-0" style={{ color: "var(--text-tertiary)" }}>{r.index}</span>}
                      <StateIcon state={r.state} />
                      <span className={`flex-1 min-w-0 truncate ${isAcct ? "text-[12px]" : "text-[13px]"}`}
                        style={{ color: isAcct ? "var(--text-2)" : "var(--text)", fontWeight: isAcct ? 400 : 500 }}>
                        {isAcct ? `${r.title}` : r.title}
                      </span>
                      {n > 0 && (
                        <span className="text-[11px] inline-flex items-center gap-0.5 shrink-0" style={{ color: "var(--text-muted)" }}>
                          <Paperclip size={11} strokeWidth={2} /> {n}
                        </span>
                      )}
                      {r.subtitle === "auto" && <span className="text-[11px] shrink-0" style={{ color: "var(--text-tertiary)" }}>auto</span>}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* ── Detail ── */}
          <div className="rounded-2xl p-4 sm:p-5" style={{ background: "var(--surface)", border: "1px solid var(--border-strong)", boxShadow: "var(--card-shadow)" }}>
            {!selected ? (
              <div className="text-[13px]" style={{ color: "var(--text-muted)" }}>Select a workpaper.</div>
            ) : (
              <>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[15px] font-semibold text-theme">{selected.title}</div>
                    {selectedAccount && (
                      <div className="text-[12px] mt-0.5" style={{ color: "var(--text-muted)" }}>{selectedAccount.group_label} · {selectedAccount.account_number}</div>
                    )}
                  </div>
                  {selected.deepLink && (
                    <button onClick={() => navigate(selected.deepLink!)}
                      className="shrink-0 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-semibold transition-colors hover:bg-[var(--surface-2)]"
                      style={{ border: "1px solid var(--border)", color: "var(--text-2)" }}>
                      Open <ExternalLink size={13} strokeWidth={2} />
                    </button>
                  )}
                </div>

                {/* Tie-out for account workpapers */}
                {selectedAccount && (
                  <div className="flex items-center gap-2 mt-3 px-3 py-2 rounded-lg" style={{ background: "var(--surface-2)" }}>
                    <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                      GL <span className="font-medium text-theme tabular-nums">{fmtUsd(selectedAccount.gl_balance)}</span> · Subledger <span className="font-medium text-theme tabular-nums">{fmtUsd(selectedAccount.subledger_balance)}</span>
                    </span>
                    <span className="ml-auto text-[11px]" style={{ color: Math.abs(Number(selectedAccount.variance) || 0) < 0.5 ? "var(--green)" : "var(--danger)" }}>
                      {Math.abs(Number(selectedAccount.variance) || 0) < 0.5 ? "reconciled" : `${fmtUsd(selectedAccount.variance)} variance`}
                    </span>
                  </div>
                )}

                {!selected.uploadable ? (
                  <p className="text-[12px] mt-4" style={{ color: "var(--text-muted)" }}>
                    {selected.key === "system:certificate"
                      ? "Generated automatically in the binder once the period is closed and signed."
                      : "The attributed audit trail is captured automatically and appended to the binder."}
                  </p>
                ) : (
                  <>
                    <div className="text-[11px] uppercase tracking-wide mt-4 mb-1.5" style={{ color: "var(--text-muted)" }}>Evidence</div>
                    {evLoading ? (
                      <div className="flex items-center gap-2 py-2"><Spinner className="h-4 w-4" /><span className="text-[12px]" style={{ color: "var(--text-muted)" }}>Loading…</span></div>
                    ) : (
                      <div className="space-y-1.5">
                        {(evidence ?? []).map((e: WpEvidence) => (
                          <div key={e.id} className="flex items-center gap-2 px-2.5 py-2 rounded-lg" style={{ border: "1px solid var(--border)" }}>
                            <FileText size={15} strokeWidth={1.9} style={{ color: "var(--text-muted)" }} />
                            <span className="flex-1 min-w-0 truncate text-[12px] text-theme">{e.file_name}</span>
                            <button onClick={() => workpapersApi.downloadEvidence(e.id)} title="Download"
                              className="p-1 rounded hover:bg-[var(--surface-2)]" style={{ color: "var(--text-muted)" }}><Download size={14} strokeWidth={2} /></button>
                            <button onClick={() => deleteMut.mutate(e.id)} disabled={deleteMut.isPending} title="Remove"
                              className="p-1 rounded hover:bg-[var(--surface-2)] disabled:opacity-50" style={{ color: "var(--text-muted)" }}><Trash2 size={14} strokeWidth={2} /></button>
                          </div>
                        ))}

                        <div
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={(e) => { e.preventDefault(); onPick(e.dataTransfer.files?.[0]) }}
                          onClick={() => fileRef.current?.click()}
                          className="flex items-center justify-center gap-2 px-3 py-3 rounded-lg cursor-pointer transition-colors hover:bg-[var(--surface-2)]"
                          style={{ border: "1px dashed var(--border-strong)", color: "var(--text-muted)" }}>
                          {uploadMut.isPending ? <Spinner className="h-4 w-4" /> : <Upload size={15} strokeWidth={2} />}
                          <span className="text-[12px]">{uploadMut.isPending ? "Uploading…" : "Drop support, or click to attach"}</span>
                        </div>
                        <input ref={fileRef} type="file" className="hidden"
                          accept=".pdf,.xlsx,.xls,.csv,.png,.jpg,.jpeg,.docx,.txt"
                          onChange={(e) => { onPick(e.target.files?.[0]); if (fileRef.current) fileRef.current.value = "" }} />
                        {uploadMut.isError && (
                          <p className="text-[11px]" style={{ color: "var(--danger)" }}>
                            {((uploadMut.error as { response?: { data?: { detail?: string } } })?.response?.data?.detail) ?? "Upload failed — check the file type and size (max 15 MB)."}
                          </p>
                        )}
                      </div>
                    )}
                    <p className="text-[11px] mt-3 inline-flex items-center gap-1" style={{ color: "var(--text-tertiary)" }}>
                      <ChevronRight size={12} strokeWidth={2} /> Folds into the close binder as a referenced appendix.
                    </p>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

export default WorkpapersPage
