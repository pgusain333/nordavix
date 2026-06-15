/**
 * Workpapers — the on-screen close binder.
 *
 * A two-pane "binder" workspace. A readiness hero (cover graphic + meter) tops
 * the page; below, a sectioned binder index (mirroring the exported PDF 1:1)
 * sits beside the selected workpaper — its tie-out (for accounts), attached
 * evidence, a drop zone, and a link into the source module.
 *
 * The index is composed client-side from the modules that already own each
 * section (recon overview for the per-account rows) + the workpaper evidence
 * counts (W1). Evidence attaches per (period, ref_type, ref_id); the Close
 * Binder folds it in as a referenced appendix (W3). Read-only QBO throughout.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useOrganization } from "@clerk/clerk-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { AnimatePresence, motion, useReducedMotion } from "framer-motion"
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Circle, Clock,
  Download, ExternalLink, FileImage, FileSpreadsheet, FileText, FolderOpen,
  Lock, Paperclip, Scale, Search, ShieldCheck, Trash2, UploadCloud,
} from "lucide-react"
import { Button, Spinner } from "@/core/ui/components"
import { PageHeader } from "@/core/ui/PageHeader"
import { SkeletonBlock } from "@/core/ui/Skeleton"
import { MOTION, EASE } from "@/core/motion"
import { useSelectedPeriod } from "@/core/hooks/useSelectedPeriod"
import { closeApi } from "@/modules/close/api"
import { reconsApi, type OverviewAccount } from "@/modules/recons/api"
import { financialsApi } from "@/modules/financials/api"
import { workpapersApi, type WpEvidence, type WpRefType } from "@/modules/workpapers/api"

type RowState = "done" | "review" | "flag" | "open" | "section" | "system"

interface WpRow {
  key:        string
  refType:    WpRefType | "system"
  refId:      string | null
  index:      string
  title:      string
  subtitle?:  string
  state:      RowState
  deepLink?:  string
  uploadable: boolean
}

/* ── formatters ──────────────────────────────────────────────────────────── */
function fmtUsd(s: string | number | null | undefined): string {
  if (s == null || s === "") return "$0"
  const n = Number(s)
  if (Number.isNaN(n)) return "—"
  return `$${Math.abs(Math.round(n)).toLocaleString()}`
}
function fmtSize(b: number | null | undefined): string {
  if (!b) return ""
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}
function fmtDate(s: string | null | undefined): string {
  if (!s) return ""
  const d = new Date(s)
  if (Number.isNaN(+d)) return ""
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}
function acctState(s: string): RowState {
  return s === "approved" ? "done" : s === "flagged" ? "flag" : s === "reviewed" ? "review" : "open"
}
const isReconciled = (a: OverviewAccount) => Math.abs(Number(a.variance) || 0) < 0.5

/* ── small presentational pieces ─────────────────────────────────────────── */
function StateIcon({ state, size = 16 }: { state: RowState; size?: number }) {
  if (state === "done")    return <CheckCircle2 size={size} strokeWidth={2} style={{ color: "var(--green)" }} />
  if (state === "flag")    return <AlertTriangle size={size} strokeWidth={2} style={{ color: "var(--danger)" }} />
  if (state === "review")  return <Clock size={size} strokeWidth={2} style={{ color: "var(--warn)" }} />
  if (state === "section") return <FolderOpen size={size} strokeWidth={1.9} style={{ color: "var(--text-muted)" }} />
  if (state === "system")  return <Lock size={size} strokeWidth={1.9} style={{ color: "var(--text-muted)" }} />
  return <Circle size={size} strokeWidth={2} style={{ color: "var(--text-muted)" }} />
}

/** Tiny pine binder spine — echoes the exported PDF cover. */
function BinderGraphic({ sealed }: { sealed: boolean }) {
  return (
    <div className="relative shrink-0" style={{ width: 46, height: 58 }}>
      <div className="absolute inset-0 rounded" style={{ background: "#0C2620", boxShadow: "0 1px 3px rgba(12,38,32,0.20)" }}>
        <div className="absolute top-0 bottom-0" style={{ left: 6, width: 3, background: "#9CC4AD", opacity: 0.6 }} />
        <div className="absolute" style={{ left: 13, right: 6, top: 12, height: 2, background: "#F4F1E9", opacity: 0.85 }} />
        <div className="absolute" style={{ left: 13, right: 11, top: 18, height: 2, background: "#9CC4AD", opacity: 0.5 }} />
        <div className="absolute" style={{ left: 13, right: 8, top: 24, height: 2, background: "#F4F1E9", opacity: 0.4 }} />
      </div>
      {sealed && (
        <div className="absolute flex items-center justify-center rounded-full"
          style={{ right: -7, bottom: -7, width: 22, height: 22, background: "var(--surface)" }}>
          <ShieldCheck size={18} strokeWidth={2} style={{ color: "var(--green)" }} />
        </div>
      )}
    </div>
  )
}

function FileGlyph({ name }: { name: string }) {
  const ext = (name.split(".").pop() || "").toLowerCase()
  if (ext === "pdf") return <FileText size={17} strokeWidth={1.8} style={{ color: "var(--danger)" }} />
  if (["xls", "xlsx", "csv"].includes(ext)) return <FileSpreadsheet size={17} strokeWidth={1.8} style={{ color: "var(--green)" }} />
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return <FileImage size={17} strokeWidth={1.8} style={{ color: "var(--info)" }} />
  return <FileText size={17} strokeWidth={1.8} style={{ color: "var(--text-muted)" }} />
}

/* ── page ────────────────────────────────────────────────────────────────── */
export function WorkpapersPage() {
  const { organization } = useOrganization()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const reduce = useReducedMotion()

  const { data: periodsResp } = useQuery({
    queryKey: ["close", "periods"], queryFn: closeApi.getPeriods, enabled: !!organization,
  })
  const fallback = periodsResp?.focus || periodsResp?.periods[0]?.period_end || ""
  const [period, setPeriod] = useSelectedPeriod(fallback)

  // UI state declared before the data queries that close over it (TDZ-safe).
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [reconOpen, setReconOpen] = useState(true)
  const [acctQuery, setAcctQuery] = useState("")
  const [dragOver, setDragOver] = useState(false)
  const [justUploaded, setJustUploaded] = useState(false)
  const [binderErr, setBinderErr] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

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

  const cnt = (refType: string, refId: string | null) =>
    summary?.counts[`${refType}:${refId ?? ""}`] ?? 0
  // Pending PBC requests for an account (awaiting client) — separate from files.
  const reqCnt = (refId: string | null) =>
    summary?.requests?.[`account:${refId ?? ""}`] ?? 0

  const accounts: OverviewAccount[] = useMemo(() => overview?.accounts ?? [], [overview])
  const isClosed = !!overview?.is_closed

  // Section rows that bracket the per-account reconciliation group. Memoized so
  // allRows / orderedKeys keep stable identities across renders.
  const headRows: WpRow[] = useMemo(() => [
    { key: "system:certificate", refType: "system", refId: null, index: "1", title: "Close certificate", state: isClosed ? "done" : "system", uploadable: false },
    { key: "financials:statements", refType: "financials", refId: "statements", index: "2", title: "Financial statements", state: "section", deepLink: "/app/financials", uploadable: true },
  ], [isClosed])
  const tailRows: WpRow[] = useMemo(() => [
    { key: "schedule:section", refType: "schedule", refId: "section", index: "4", title: "Schedules", state: "section", deepLink: "/app/schedules", uploadable: true },
    { key: "adjustment:section", refType: "adjustment", refId: "section", index: "5", title: "Adjustments", state: "section", deepLink: "/app/adjustments", uploadable: true },
    { key: "flux:section", refType: "flux", refId: "section", index: "6", title: "Flux analysis", state: "section", deepLink: "/app/flux", uploadable: true },
    { key: "general:", refType: "general", refId: null, index: "7", title: "Supporting documents", state: "section", uploadable: true },
    { key: "system:audit", refType: "system", refId: null, index: "8", title: "Audit trail", subtitle: "auto", state: "system", uploadable: false },
  ], [])

  const acctRows: WpRow[] = useMemo(() => accounts.map((a) => ({
    key: `account:${a.qbo_id}`, refType: "account" as const, refId: a.qbo_id, index: "3",
    title: a.account_name, subtitle: a.group_label,
    state: acctState(a.review_status), deepLink: "/app/reconciliations", uploadable: true,
  })), [accounts])

  const q = acctQuery.trim().toLowerCase()
  const filteredAccts = useMemo(() => !q ? acctRows : acctRows.filter((r) =>
    r.title.toLowerCase().includes(q) || (r.subtitle ?? "").toLowerCase().includes(q) ||
    (accounts.find((a) => a.qbo_id === r.refId)?.account_number ?? "").toLowerCase().includes(q)
  ), [acctRows, accounts, q])
  const showAccts = reconOpen || !!q

  const allRows = useMemo(() => [...headRows, ...acctRows, ...tailRows], [headRows, acctRows, tailRows])

  // Ordered keys for keyboard navigation (display order, honouring collapse/filter).
  const orderedKeys = useMemo(() => [
    ...headRows.map((r) => r.key),
    ...(showAccts ? filteredAccts.map((r) => r.key) : []),
    ...tailRows.map((r) => r.key),
  ], [headRows, tailRows, filteredAccts, showAccts])

  // Default selection once data is ready — and self-heal if the current
  // selection no longer exists (e.g. after a period switch clears it).
  useEffect(() => {
    if (allRows.length === 0) return
    if (selectedKey && allRows.some((r) => r.key === selectedKey)) return
    setSelectedKey(acctRows[0]?.key ?? "general:")
  }, [allRows, acctRows, selectedKey])

  const selected = allRows.find((r) => r.key === selectedKey) ?? null
  const selectedAccount = selected?.refType === "account"
    ? accounts.find((a) => a.qbo_id === selected.refId) : undefined

  const { data: evidence, isLoading: evLoading } = useQuery({
    queryKey: ["workpapers", "evidence", activePeriod, selected?.refType, selected?.refId],
    queryFn:  () => workpapersApi.listEvidence(activePeriod, selected!.refType, selected!.refId),
    enabled:  !!organization && !!activePeriod && !!selected && selected.uploadable,
  })

  const invalidate = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["workpapers", "evidence", activePeriod] })
    qc.invalidateQueries({ queryKey: ["workpapers", "evidence-summary", activePeriod] })
  }, [qc, activePeriod])
  const uploadMut = useMutation({
    mutationFn: (file: File) => {
      if (!selected?.uploadable) throw new Error("No workpaper selected to attach to.")
      return workpapersApi.uploadEvidence({
        periodEnd: activePeriod, refType: selected.refType as WpRefType, refId: selected.refId, file,
      })
    },
    onSuccess: () => { invalidate(); setJustUploaded(true) },
  })
  const deleteMut = useMutation({
    mutationFn: (id: string) => workpapersApi.deleteEvidence(id),
    onSuccess: invalidate,
  })

  // Self-clearing "attached" flash, with cleanup if the component unmounts.
  useEffect(() => {
    if (!justUploaded) return
    const t = window.setTimeout(() => setJustUploaded(false), 1500)
    return () => window.clearTimeout(t)
  }, [justUploaded])
  const binderMut = useMutation({
    mutationFn: () => financialsApi.downloadCloseBinder(activePeriod),
    onMutate: () => setBinderErr(null),
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { detail?: string } }; message?: string })
      setBinderErr(msg?.response?.data?.detail ?? msg?.message ?? "Couldn't generate the binder.")
    },
  })

  const onPick = (f: File | null | undefined) => { if (f) uploadMut.mutate(f) }
  const selectByOffset = (delta: number) => {
    if (orderedKeys.length === 0) return
    const i = orderedKeys.indexOf(selectedKey ?? "")
    const next = orderedKeys[Math.max(0, Math.min(orderedKeys.length - 1, (i < 0 ? 0 : i) + delta))]
    if (next) setSelectedKey(next)
  }

  // Readiness — honest composite: account approvals are the gating work.
  const total = accounts.length
  const approved = accounts.filter((a) => a.review_status === "approved").length
  const docs = summary?.total ?? 0
  const reconRatio = total > 0 ? approved / total : (isClosed ? 1 : 0)
  const pct = Math.round(reconRatio * 100)
  const ready = total > 0 ? (approved === total && isClosed) : isClosed

  const ease = reduce ? { duration: 0 } : { duration: MOTION.DEFAULT, ease: EASE.OUT }

  if (!organization) {
    return (
      <>
        <PageHeader title="Workpapers" />
        <div className="p-6 text-sm" style={{ color: "var(--text-muted)" }}>Select a workspace to open its workpapers.</div>
      </>
    )
  }

  /* ── index row renderer (plain function — avoids per-render remounts) ── */
  const renderRow = (r: WpRow, account?: OverviewAccount) => {
    const isAcct = r.refType === "account"
    const n = r.uploadable ? cnt(r.refType, r.refId) : 0
    const isSel = r.key === selectedKey
    const flagged = account ? !isReconciled(account) : false
    return (
      <div key={r.key}
        role="option" aria-selected={isSel} onClick={() => setSelectedKey(r.key)}
        className="group flex items-center gap-2.5 cursor-pointer transition-colors"
        style={{
          padding: isAcct ? "6px 12px 6px 32px" : "9px 12px",
          background: isSel ? "var(--surface-2)" : "transparent",
          borderLeft: isSel ? "2px solid var(--green)" : "2px solid transparent",
        }}
        onMouseEnter={(e) => { if (!isSel) e.currentTarget.style.background = "var(--surface-2)" }}
        onMouseLeave={(e) => { if (!isSel) e.currentTarget.style.background = "transparent" }}>
        {!isAcct && <span className="text-[11px] w-3.5 shrink-0 tabular-nums" style={{ color: "var(--text-tertiary)" }}>{r.index}</span>}
        <StateIcon state={r.state} size={isAcct ? 15 : 16} />
        <span className={`flex-1 min-w-0 truncate ${isAcct ? "text-[12px]" : "text-[13px]"}`}
          style={{ color: isSel || !isAcct ? "var(--text)" : "var(--text-2)", fontWeight: isAcct ? (isSel ? 500 : 400) : 500 }}>
          {r.title}
          {isAcct && account?.group_label && <span style={{ color: "var(--text-muted)", fontWeight: 400 }}> · {account.group_label}</span>}
        </span>
        {isAcct && reqCnt(r.refId) > 0 && (
          <span className="text-[11px] inline-flex items-center gap-0.5 shrink-0" style={{ color: "var(--warn)" }}
            title={`${reqCnt(r.refId)} document${reqCnt(r.refId) === 1 ? "" : "s"} requested — awaiting client`}>
            <Clock size={11} strokeWidth={2} /> {reqCnt(r.refId)}
          </span>
        )}
        {isAcct && flagged
          ? <span className="text-[11px] shrink-0 tabular-nums" style={{ color: "var(--danger)" }}>{fmtUsd(account?.variance)}</span>
          : n > 0 && (
            <span className="text-[11px] inline-flex items-center gap-0.5 shrink-0" style={{ color: "var(--text-muted)" }}>
              <Paperclip size={11} strokeWidth={2} /> {n}
            </span>
          )}
        {r.subtitle === "auto" && <span className="text-[11px] shrink-0" style={{ color: "var(--text-tertiary)" }}>auto</span>}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PageHeader
        title="Workpapers"
        subtitle={periodMeta ? `${periodMeta.label}${periodMeta.closed ? " · closed" : ""}` : "Close binder"}
        actions={
          <div className="flex items-center gap-2">
            {periodsResp && periodsResp.periods.length > 0 && (
              <select value={activePeriod}
                onChange={(e) => { setPeriod(e.target.value); setSelectedKey(null); setBinderErr(null); setAcctQuery("") }}
                className="rounded-lg px-3 py-1.5 text-sm outline-none"
                style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }}>
                {periodsResp.periods.map((p) => (
                  <option key={p.period_end} value={p.period_end}>{p.label}{p.closed ? " · closed" : ""}</option>
                ))}
              </select>
            )}
            <Button size="sm" loading={binderMut.isPending} disabled={!activePeriod}
              onClick={() => binderMut.mutate()} icon={<ShieldCheck size={14} strokeWidth={2} />}>
              Generate close binder
            </Button>
          </div>
        }
      />

      <div className="flex-1 min-h-0 overflow-y-auto lg:overflow-hidden flex flex-col px-4 sm:px-6 py-4">
        {binderErr && (
          <div className="rounded-xl px-4 py-3 text-[12px] mb-4"
            style={{ background: "var(--warn-subtle)", color: "var(--warn)", border: "1px solid var(--warn-border)" }}>
            {binderErr}
          </div>
        )}

        {/* ── Binder readiness hero ── */}
        <div className="flex flex-wrap items-center gap-4 rounded-2xl px-4 py-3.5 mb-3"
          style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
          <BinderGraphic sealed={ready} />
          <div className="min-w-0">
            <div className="text-[14px] font-semibold text-theme truncate">
              Close binder{organization?.name ? ` — ${organization.name}` : ""}
            </div>
            <div className="text-[12px] mt-0.5" style={{ color: "var(--text-muted)" }}>
              {periodMeta?.label ?? "—"}{ready ? " · locked & signed off" : isClosed ? " · closed" : " · in progress"}
            </div>
          </div>

          <div className="ml-auto flex items-center gap-4">
            <div className="text-right">
              <div className="flex items-center justify-end gap-2.5 mb-1.5 text-[11px]" style={{ color: "var(--text-2)" }}>
                <span className="inline-flex items-center gap-1"><Scale size={13} strokeWidth={1.9} style={{ color: total && approved === total ? "var(--green)" : "var(--text-muted)" }} />{approved}/{total} approved</span>
                <span style={{ color: "var(--text-tertiary)" }}>·</span>
                <span className="inline-flex items-center gap-1"><Paperclip size={12} strokeWidth={1.9} />{docs} document{docs === 1 ? "" : "s"}</span>
                <span style={{ color: "var(--text-tertiary)" }}>·</span>
                <span className="inline-flex items-center gap-1" style={{ color: isClosed ? "var(--green)" : "var(--text-muted)" }}>
                  <Lock size={12} strokeWidth={1.9} />certificate {isClosed ? "locked" : "open"}
                </span>
              </div>
              <div className="rounded-full overflow-hidden ml-auto" style={{ width: 220, height: 7, background: "var(--surface-2)" }}>
                <motion.div initial={false} animate={{ width: `${pct}%` }} transition={reduce ? { duration: 0 } : { duration: MOTION.SLOW, ease: EASE.OUT }}
                  style={{ height: "100%", borderRadius: 99, background: ready ? "var(--green)" : pct >= 60 ? "var(--green)" : "var(--warn)" }} />
              </div>
            </div>

            {ready ? (
              <div className="flex flex-col items-center rounded-xl px-3.5 py-2"
                style={{ background: "var(--green-subtle)", border: "1px solid var(--positive-border)" }}>
                <ShieldCheck size={20} strokeWidth={2} style={{ color: "var(--green)" }} />
                <span className="text-[10px] font-semibold tracking-wide mt-0.5" style={{ color: "var(--green)" }}>BINDER READY</span>
              </div>
            ) : (
              <div className="flex flex-col items-center rounded-xl px-3.5 py-1.5"
                style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
                <span className="text-[20px] font-bold leading-none tabular-nums text-theme">{pct}%</span>
                <span className="text-[10px] font-semibold tracking-wide mt-0.5" style={{ color: "var(--text-muted)" }}>READY</span>
              </div>
            )}
          </div>
        </div>

        <div className="grid gap-3 grid-cols-1 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)] lg:flex-1 lg:min-h-0 lg:[grid-template-rows:minmax(0,1fr)]">

          {/* ── Binder index ── */}
          <div className="rounded-2xl overflow-hidden lg:flex lg:flex-col lg:min-h-0" style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}
            tabIndex={0} role="listbox" aria-label="Binder index"
            onKeyDown={(e) => {
              if ((e.target as HTMLElement).tagName === "INPUT") return
              if (e.key === "ArrowDown") { e.preventDefault(); selectByOffset(1) }
              else if (e.key === "ArrowUp") { e.preventDefault(); selectByOffset(-1) }
              else if (e.key === "Enter" && selected?.deepLink) { navigate(selected.deepLink) }
            }}>
            <div className="flex items-center gap-2 px-3 pt-2.5 pb-2 border-b" style={{ borderColor: "var(--border)" }}>
              <span className="text-[11px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>Binder index</span>
              <div className="ml-auto flex items-center gap-1.5 rounded-lg px-2 py-1" style={{ background: "var(--surface-2)" }}>
                <Search size={12} strokeWidth={2} style={{ color: "var(--text-muted)" }} />
                <input value={acctQuery} onChange={(e) => setAcctQuery(e.target.value)} placeholder="Filter accounts"
                  className="bg-transparent outline-none text-[11px] w-[110px]" style={{ color: "var(--text)" }} />
              </div>
            </div>

            <div className="lg:flex-1 lg:min-h-0 lg:overflow-y-auto">
            {ovLoading && !overview ? (
              <div className="p-3 space-y-2.5">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-2.5"><SkeletonBlock width={16} height={16} radius={5} /><SkeletonBlock width={`${60 + (i % 3) * 12}%`} height={12} /></div>
                ))}
              </div>
            ) : (
              <div className="pb-2 pt-1">
                {headRows.map((r) => renderRow(r))}

                {/* Reconciliations group */}
                <div className="group flex items-center gap-2.5 cursor-pointer px-3 py-2.5 transition-colors"
                  onClick={() => setReconOpen((v) => !v)}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                  <span className="text-[11px] w-3.5 shrink-0 tabular-nums" style={{ color: "var(--text-tertiary)" }}>3</span>
                  {showAccts ? <ChevronDown size={15} strokeWidth={2} style={{ color: "var(--text-2)" }} /> : <ChevronRight size={15} strokeWidth={2} style={{ color: "var(--text-2)" }} />}
                  <span className="flex-1 min-w-0 truncate text-[13px] font-semibold text-theme">Reconciliations</span>
                  {total > 0 && (
                    <>
                      <span className="text-[11px] font-medium tabular-nums shrink-0" style={{ color: approved === total ? "var(--green)" : "var(--text-2)" }}>{approved}/{total}</span>
                      <div className="rounded-full overflow-hidden shrink-0" style={{ width: 46, height: 5, background: "var(--surface-2)" }}>
                        <div style={{ width: `${total ? (approved / total) * 100 : 0}%`, height: "100%", background: approved === total ? "var(--green)" : "var(--warn)" }} />
                      </div>
                    </>
                  )}
                </div>

                <AnimatePresence initial={false}>
                  {showAccts && (
                    <motion.div
                      initial={reduce ? false : { height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
                      transition={ease} style={{ overflow: "hidden" }}>
                      {filteredAccts.length === 0 ? (
                        <div className="text-[11px] px-3 py-2 pl-8" style={{ color: "var(--text-muted)" }}>
                          {q ? `No accounts match “${acctQuery}”.` : "No accounts synced for this period yet."}
                        </div>
                      ) : filteredAccts.map((r) => renderRow(r, accounts.find((a) => a.qbo_id === r.refId)))}
                    </motion.div>
                  )}
                </AnimatePresence>

                {tailRows.map((r) => renderRow(r))}
              </div>
            )}
            </div>
          </div>

          {/* ── Detail ── */}
          <div className="rounded-2xl p-4 sm:p-5 lg:min-h-0 lg:overflow-y-auto" style={{ background: "var(--surface)", border: "1px solid var(--border-strong)", boxShadow: "var(--card-shadow)" }}>
            {!selected ? (
              <div className="text-[13px]" style={{ color: "var(--text-muted)" }}>Select a workpaper.</div>
            ) : (
              <AnimatePresence mode="wait">
                <motion.div key={selectedKey}
                  initial={reduce ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                  exit={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }} transition={ease}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex items-start gap-2.5">
                      <div className="mt-0.5"><StateIcon state={selected.state} size={18} /></div>
                      <div className="min-w-0">
                        <div className="text-[15px] font-semibold text-theme">{selected.title}</div>
                        {selectedAccount && (
                          <div className="text-[12px] mt-0.5" style={{ color: "var(--text-muted)" }}>{selectedAccount.group_label} · {selectedAccount.account_number}</div>
                        )}
                      </div>
                    </div>
                    {selected.deepLink && (
                      <button onClick={() => navigate(selected.deepLink!)}
                        className="shrink-0 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-semibold transition-colors"
                        style={{ border: "1px solid var(--border)", color: "var(--text-2)" }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
                        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                        Open <ExternalLink size={13} strokeWidth={2} />
                      </button>
                    )}
                  </div>

                  {/* Tie-out for account workpapers */}
                  {selectedAccount && (() => {
                    const ok = isReconciled(selectedAccount)
                    return (
                      <div className="mt-4">
                        <div className="grid grid-cols-3 gap-2">
                          <div className="rounded-xl px-3 py-2.5" style={{ background: "var(--surface-2)" }}>
                            <div className="text-[10px] font-semibold tracking-wide" style={{ color: "var(--text-muted)" }}>GL BALANCE</div>
                            <div className="text-[16px] font-bold mt-0.5 tabular-nums text-theme">{fmtUsd(selectedAccount.gl_balance)}</div>
                          </div>
                          <div className="rounded-xl px-3 py-2.5" style={{ background: "var(--surface-2)" }}>
                            <div className="text-[10px] font-semibold tracking-wide" style={{ color: "var(--text-muted)" }}>SUBLEDGER</div>
                            <div className="text-[16px] font-bold mt-0.5 tabular-nums text-theme">{fmtUsd(selectedAccount.subledger_balance)}</div>
                          </div>
                          <div className="rounded-xl px-3 py-2.5"
                            style={{ background: ok ? "var(--green-subtle)" : "var(--danger-subtle)", border: `1px solid ${ok ? "var(--positive-border)" : "var(--danger-border)"}` }}>
                            <div className="text-[10px] font-semibold tracking-wide" style={{ color: ok ? "var(--green)" : "var(--danger)" }}>VARIANCE</div>
                            <div className="text-[16px] font-bold mt-0.5 tabular-nums inline-flex items-center gap-1" style={{ color: ok ? "var(--green)" : "var(--danger)" }}>
                              {ok && <CheckCircle2 size={14} strokeWidth={2.2} />}{fmtUsd(selectedAccount.variance)}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 mt-2">
                          <div className="flex-1 rounded-full overflow-hidden" style={{ height: 5, background: "var(--surface-2)" }}>
                            <div style={{ width: "100%", height: "100%", background: ok ? "var(--green)" : "var(--danger)" }} />
                          </div>
                          <span className="text-[11px] font-medium" style={{ color: ok ? "var(--green)" : "var(--danger)" }}>{ok ? "reconciled" : "out of balance"}</span>
                        </div>
                      </div>
                    )
                  })()}

                  {!selected.uploadable ? (
                    <div className="flex items-start gap-2.5 mt-4 px-3.5 py-3 rounded-xl" style={{ background: "var(--surface-2)" }}>
                      {selected.key === "system:certificate"
                        ? <ShieldCheck size={16} strokeWidth={1.9} style={{ color: "var(--text-muted)", marginTop: 1 }} />
                        : <Lock size={16} strokeWidth={1.9} style={{ color: "var(--text-muted)", marginTop: 1 }} />}
                      <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                        {selected.key === "system:certificate"
                          ? "The close certificate is generated automatically in the binder once the period is closed and signed off."
                          : "The attributed audit trail is captured automatically and appended to the binder — every prepare, approve and sign-off action."}
                      </p>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-2 mt-4 mb-1.5">
                        <span className="text-[11px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                          Evidence{(evidence?.length ?? 0) > 0 ? ` · ${evidence!.length}` : ""}
                        </span>
                        <AnimatePresence>
                          {justUploaded && (
                            <motion.span key="ok" initial={reduce ? false : { scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ opacity: 0 }}
                              transition={reduce ? { duration: 0 } : { duration: MOTION.FAST, ease: EASE.OUT }}
                              className="inline-flex items-center gap-1 text-[11px] font-medium" style={{ color: "var(--green)" }}>
                              <CheckCircle2 size={13} strokeWidth={2.2} /> attached
                            </motion.span>
                          )}
                        </AnimatePresence>
                      </div>

                      {evLoading ? (
                        <div className="flex items-center gap-2 py-2"><Spinner className="h-4 w-4" /><span className="text-[12px]" style={{ color: "var(--text-muted)" }}>Loading…</span></div>
                      ) : (
                        <div className="space-y-1.5">
                          {(evidence ?? []).map((e: WpEvidence) => (
                            <div key={e.id} className="group flex items-center gap-2.5 px-2.5 py-2 rounded-lg transition-colors"
                              style={{ border: "1px solid var(--border)" }}
                              onMouseEnter={(ev) => (ev.currentTarget.style.background = "var(--surface-2)")}
                              onMouseLeave={(ev) => (ev.currentTarget.style.background = "transparent")}>
                              {e.source === "request"
                                ? <Clock size={16} strokeWidth={1.9} style={{ color: "var(--warn)" }} />
                                : <FileGlyph name={e.file_name} />}
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5 min-w-0">
                                  <span className="truncate text-[12px] font-medium text-theme">{e.file_name}</span>
                                  {e.source === "recon" && (
                                    <span className="shrink-0 inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded"
                                      style={{ background: "var(--info-subtle)", color: "var(--info)" }}
                                      title="Provided in Reconciliations (includes client magic-link uploads) — manage it there">
                                      <Scale size={9} strokeWidth={2.4} /> Recon
                                    </span>
                                  )}
                                  {e.source === "request" && (
                                    <span className="shrink-0 inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded"
                                      style={{ background: "var(--warn-subtle)", color: "var(--warn)" }}
                                      title="Requested via client magic link — manage it in Reconciliations">
                                      <Clock size={9} strokeWidth={2.4} /> Requested
                                    </span>
                                  )}
                                </div>
                                {e.source === "request" ? (
                                  <div className="text-[11px] mt-0.5" style={{ color: "var(--warn)" }}>
                                    Awaiting client{e.recipient ? ` · ${e.recipient}` : ""}
                                  </div>
                                ) : (fmtSize(e.file_size) || fmtDate(e.uploaded_at)) ? (
                                  <div className="text-[11px] mt-0.5" style={{ color: "var(--text-muted)" }}>
                                    {[fmtSize(e.file_size), e.uploaded_at ? `attached ${fmtDate(e.uploaded_at)}` : ""].filter(Boolean).join(" · ")}
                                  </div>
                                ) : null}
                              </div>
                              {e.source !== "request" && (
                                <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                                  <button onClick={() => workpapersApi.downloadEvidence(e.id)} title="Download"
                                    className="p-1.5 rounded-md" style={{ color: "var(--text-muted)" }}
                                    onMouseEnter={(ev) => (ev.currentTarget.style.background = "var(--surface)")}
                                    onMouseLeave={(ev) => (ev.currentTarget.style.background = "transparent")}><Download size={14} strokeWidth={2} /></button>
                                  {e.source !== "recon" && (
                                    <button onClick={() => deleteMut.mutate(e.id)} disabled={deleteMut.isPending} title="Remove"
                                      className="p-1.5 rounded-md disabled:opacity-50" style={{ color: "var(--text-muted)" }}
                                      onMouseEnter={(ev) => (ev.currentTarget.style.color = "var(--danger)")}
                                      onMouseLeave={(ev) => (ev.currentTarget.style.color = "var(--text-muted)")}><Trash2 size={14} strokeWidth={2} /></button>
                                  )}
                                </div>
                              )}
                            </div>
                          ))}

                          <div
                            onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                            onDragLeave={() => setDragOver(false)}
                            onDrop={(e) => { e.preventDefault(); setDragOver(false); onPick(e.dataTransfer.files?.[0]) }}
                            onClick={() => fileRef.current?.click()}
                            className="flex flex-col items-center justify-center gap-1.5 px-3 py-5 rounded-xl cursor-pointer transition-all"
                            style={{
                              border: `1.5px dashed ${dragOver ? "var(--green)" : "var(--border-strong)"}`,
                              background: dragOver ? "var(--green-subtle)" : "transparent",
                              transform: dragOver && !reduce ? "scale(1.01)" : "scale(1)",
                            }}>
                            {uploadMut.isPending
                              ? <Spinner className="h-5 w-5" />
                              : <UploadCloud size={22} strokeWidth={1.9} style={{ color: dragOver ? "var(--green)" : "var(--text-muted)" }} />}
                            <span className="text-[12px] font-medium" style={{ color: dragOver ? "var(--green)" : "var(--text-2)" }}>
                              {uploadMut.isPending ? "Uploading…" : dragOver ? "Release to attach" : "Drag files here, or click to browse"}
                            </span>
                            {!uploadMut.isPending && !dragOver && (
                              <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>PDF, Excel, CSV, images · max 15 MB</span>
                            )}
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
                </motion.div>
              </AnimatePresence>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default WorkpapersPage
