/**
 * AdjustmentsPage — the consolidated review queue for AI-proposed journal
 * entries. The same proposals shown inline (bank worksheet, recon drawer,
 * flux variance) gathered in one place so a reviewer can do a final
 * pre-close sweep and batch-approve. Reads the shared ["adjustments"] cache;
 * acting here updates the inline surfaces too.
 *
 * Inline is the primary flow (act in context, no navigation); this is the
 * optional roll-up — a controller's worklist of everything the AI drafted.
 */
import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CheckCheck, FileText, Save, Download, Lock, RefreshCw, CheckCircle2, AlertCircle } from "lucide-react"

import { SkeletonTable } from "@/core/ui/Skeleton"
import { PageHeader } from "@/core/ui/PageHeader"
import { formatDate } from "@/core/lib/dates"
import { workspaceApi } from "@/modules/workspace/api"
import { adjustmentsApi, type AdjustmentStatus, type CheckPostedResult, type ProposedEntry, type ProposedEntryList } from "../api"
import { ProposedEntryCard } from "../components/ProposedEntryCard"
import { patchAdjustments } from "../optimistic"

const SOURCE_META: Record<string, { label: string; hint: string }> = {
  bank:  { label: "Bank reconciliation", hint: "Fees, interest, and other bank-only items" },
  recon: { label: "Reconciliations",     hint: "Corrections from account reconciliation review" },
  flux:  { label: "Flux analysis",       hint: "Adjustments surfaced by variance analysis" },
}
const SOURCE_ORDER = ["bank", "recon", "flux"] as const

const STATUS_TABS: { key: AdjustmentStatus | "all"; label: string }[] = [
  { key: "open",      label: "Open" },
  { key: "accepted",  label: "Approved" },
  { key: "posted",    label: "Posted" },
  { key: "dismissed", label: "Dismissed" },
  { key: "all",       label: "All" },
]

export function AdjustmentsPage() {
  const qc = useQueryClient()
  const [status, setStatus] = useState<AdjustmentStatus | "all">("open")

  const { data: me } = useQuery({
    queryKey: ["workspace-me"],
    queryFn:  workspaceApi.getMe,
    staleTime: 10 * 60_000,
  })
  const canReview = me?.role === "admin" || me?.role === "reviewer"
  // Preparers (and up) can select accounts on a JE; it auto-saves for review.
  const canEdit = !!me?.role

  // Fetch the full set once (all statuses, all periods) — drives both the
  // tab counts and the filtered view, so switching tabs is instant.
  const { data, isLoading } = useQuery({
    queryKey: ["adjustments", "queue"],
    queryFn:  () => adjustmentsApi.list({}),
    staleTime: 15_000,
  })
  const all: ProposedEntry[] = data?.items ?? []

  // Period scoping — Save / CSV / posting are per-period close operations.
  const periods = useMemo(() => {
    const s = new Set(all.map((e) => e.period_end))
    return Array.from(s).sort().reverse() // latest first
  }, [all])
  const [period, setPeriod] = useState<string>("") // "" = all periods
  useEffect(() => {
    // Default to the most recent period once data arrives.
    if (!period && periods.length) setPeriod(periods[0])
  }, [period, periods])

  const base = useMemo(
    () => (period ? all.filter((e) => e.period_end === period) : all),
    [all, period],
  )

  const counts = useMemo(() => {
    const c: Record<string, number> = { open: 0, accepted: 0, posted: 0, dismissed: 0, all: base.length }
    for (const e of base) c[e.status] = (c[e.status] ?? 0) + 1
    return c
  }, [base])

  const visible = useMemo(
    () => (status === "all" ? base : base.filter((e) => e.status === status)),
    [base, status],
  )

  const grouped = useMemo(() => {
    const g: Record<string, ProposedEntry[]> = { bank: [], recon: [], flux: [] }
    for (const e of visible) (g[e.source] ??= []).push(e)
    return g
  }, [visible])

  const openVisible = visible.filter((e) => e.status === "open")

  // Per-period batch gating (only meaningful when one period is selected).
  const periodActive = base.filter((e) => e.status !== "dismissed")
  const hasOpen = periodActive.some((e) => e.status === "open")
  const readyToSave = !!period && periodActive.length > 0 && !hasOpen && periodActive.some((e) => !e.saved_at)
  const savedCount = base.filter((e) => !!e.saved_at).length
  const allSaved = !!period && periodActive.length > 0 && periodActive.every((e) => !!e.saved_at)

  const saveMut = useMutation({
    mutationFn: () => adjustmentsApi.save(period),
    // Stamp saved_at on the period's active entries instantly — the banner flips
    // to "Saved" and the CSV / Check buttons unlock without waiting on the server.
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: ["adjustments"] })
      const prev = qc.getQueriesData<ProposedEntryList>({ queryKey: ["adjustments"] })
      const stamp = new Date().toISOString()
      patchAdjustments(
        qc,
        (e) => e.period_end === period && e.status !== "dismissed" && !e.saved_at,
        { saved_at: stamp },
      )
      return { prev }
    },
    onError: (_e, _v, ctx) => { ctx?.prev?.forEach(([k, d]) => qc.setQueryData(k, d)) },
    onSettled: () => { qc.invalidateQueries({ queryKey: ["adjustments"] }) },
  })
  const downloadMut = useMutation({
    mutationFn: () => adjustmentsApi.downloadCsv(period),
  })

  const [checkResult, setCheckResult] = useState<CheckPostedResult | null>(null)
  const checkMut = useMutation({
    mutationFn: () => adjustmentsApi.checkPosted(period),
    onSuccess: (res) => {
      setCheckResult(res)
      // Refresh adjustments + any recon/dashboard views (recons may have reopened).
      qc.invalidateQueries({
        predicate: (q) => {
          const k = q.queryKey
          const head = Array.isArray(k) && typeof k[0] === "string" ? k[0] : ""
          return head === "adjustments" || head.includes("recon") || head.includes("dashboard")
        },
      })
    },
  })
  // Clear a stale result when the selected period changes.
  useEffect(() => { setCheckResult(null) }, [period])

  const batchApprove = useMutation({
    mutationFn: async () => {
      // Sequential to keep audit ordering deterministic; the set is small.
      for (const e of openVisible) {
        try { await adjustmentsApi.accept(e.id) } catch { /* skip closed/locked */ }
      }
    },
    // Flip every visible open entry to Approved in one paint, then book them
    // server-side in the background.
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: ["adjustments"] })
      const prev = qc.getQueriesData<ProposedEntryList>({ queryKey: ["adjustments"] })
      const ids = new Set(openVisible.map((e) => e.id))
      patchAdjustments(qc, (e) => ids.has(e.id), { status: "accepted" })
      return { prev }
    },
    onError: (_e, _v, ctx) => { ctx?.prev?.forEach(([k, d]) => qc.setQueryData(k, d)) },
    onSettled: () => { qc.invalidateQueries({ queryKey: ["adjustments"] }) },
  })

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Header — compact single-row PageHeader (matches every other module) */}
      <PageHeader
        title="Adjustments"
        subtitle="AI-drafted journal entries to review, then copy into QuickBooks. Nordavix never posts for you."
      />

      <div className="flex-1 px-4 sm:px-8 py-5 max-w-5xl w-full mx-auto space-y-5">
        {/* Period + batch actions (Save → CSV) */}
        {all.length > 0 && (
          <div className="rounded-xl p-3 flex items-center gap-3 flex-wrap"
            style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                Period
              </span>
              <select
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
                className="rounded-lg px-2.5 py-1.5 text-xs outline-none"
                style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }}
              >
                <option value="">All periods</option>
                {periods.map((p) => (
                  <option key={p} value={p}>{formatDate(p)}</option>
                ))}
              </select>
            </div>

            {period && (
              <>
                <p className="text-[11px] min-w-0" style={{ color: "var(--text-muted)" }}>
                  {hasOpen
                    ? "Approve every entry, then Save to lock the batch."
                    : allSaved
                      ? `Saved · ${savedCount} entr${savedCount === 1 ? "y" : "ies"} locked. Download the CSV and import it in QuickBooks.`
                      : readyToSave
                        ? "All approved — Save to lock the batch and unlock the CSV."
                        : "No approved entries yet."}
                </p>

                <div className="ml-auto flex items-center gap-2">
                  {canReview && (
                    <button
                      onClick={() => saveMut.mutate()}
                      disabled={!readyToSave || saveMut.isPending}
                      className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-colors disabled:opacity-40"
                      style={{
                        background: allSaved ? "var(--surface-2)" : "var(--green)",
                        color:      allSaved ? "var(--text-muted)" : "white",
                      }}
                      title={allSaved ? "Batch already saved" : "Lock the approved batch"}
                    >
                      {allSaved ? <Lock size={13} strokeWidth={2.4} /> : <Save size={13} strokeWidth={2.4} />}
                      {saveMut.isPending ? "Saving…" : allSaved ? "Saved" : "Save batch"}
                    </button>
                  )}
                  <button
                    onClick={() => downloadMut.mutate()}
                    disabled={savedCount === 0 || downloadMut.isPending}
                    className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-40"
                    style={{ background: "var(--surface-2)", color: "var(--text)", border: "1px solid var(--border-strong)" }}
                    title={savedCount === 0 ? "Save the batch first" : "Download QBO journal-entry CSV"}
                  >
                    <Download size={13} strokeWidth={2.2} />
                    {downloadMut.isPending ? "Preparing…" : "Download QBO CSV"}
                  </button>
                  {/* Read-only posting check — available to every role (preparer+). */}
                  <button
                    onClick={() => checkMut.mutate()}
                    disabled={savedCount === 0 || checkMut.isPending}
                    className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-40"
                    style={{ background: "var(--surface-2)", color: "var(--text)", border: "1px solid var(--border-strong)" }}
                    title={savedCount === 0 ? "Save the batch first" : "Read QuickBooks and check whether these entries are posted"}
                  >
                    <RefreshCw size={13} strokeWidth={2.2} className={checkMut.isPending ? "animate-spin" : ""} />
                    {checkMut.isPending ? "Checking…" : "Check posted in QBO"}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Posting-check result */}
        {period && checkResult && checkResult.period_end === period && (
          <div className="rounded-xl p-3"
            style={{
              background: checkResult.all_posted ? "var(--green-subtle)" : "rgba(199, 154, 82, 0.08)",
              border: `1px solid ${checkResult.all_posted ? "var(--green)" : "rgba(199, 154, 82, 0.40)"}`,
            }}>
            <div className="flex items-start gap-2">
              {checkResult.all_posted
                ? <CheckCircle2 size={15} strokeWidth={2.2} style={{ color: "var(--green)" }} className="mt-0.5 shrink-0" />
                : <AlertCircle size={15} strokeWidth={2.2} style={{ color: "#8a6326" }} className="mt-0.5 shrink-0" />}
              <div className="min-w-0">
                <p className="text-[12.5px] font-semibold" style={{ color: "var(--text)" }}>
                  {checkResult.posted_count} of {checkResult.total} found in QuickBooks
                  {checkResult.all_posted
                    ? checkResult.reopened_accounts.length > 0
                      ? ` · all posted — ${checkResult.reopened_accounts.length} reconciliation${checkResult.reopened_accounts.length === 1 ? "" : "s"} reopened to reconcile`
                      : " · all posted"
                    : ""}
                </p>
                {!checkResult.all_posted && (
                  <>
                    <p className="text-[11px] mt-0.5" style={{ color: "var(--text-2)" }}>
                      Not yet found in QBO (dated within {formatDate(period)}):
                    </p>
                    <ul className="mt-1 space-y-0.5">
                      {checkResult.entries.filter((e) => !e.posted).slice(0, 8).map((e) => (
                        <li key={e.id} className="text-[11px] flex items-center gap-1.5" style={{ color: "var(--text-2)" }}>
                          <span className="inline-block h-1 w-1 rounded-full shrink-0" style={{ background: "#8a6326" }} />
                          {e.description}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Status tabs + batch approve */}
        <div className="flex items-center gap-2 flex-wrap">
          {STATUS_TABS.map((t) => {
            const active = status === t.key
            return (
              <button
                key={t.key}
                onClick={() => setStatus(t.key)}
                className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-all"
                style={{
                  background: active ? "var(--green-subtle)" : "var(--surface)",
                  color:      active ? "var(--green)" : "var(--text-muted)",
                  border:     `1px solid ${active ? "transparent" : "var(--border)"}`,
                }}
              >
                {t.label}
                <span className="text-[10px] opacity-70 tabular-nums">{counts[t.key] ?? 0}</span>
              </button>
            )
          })}

          {canReview && openVisible.length > 0 && (
            <button
              onClick={() => batchApprove.mutate()}
              disabled={batchApprove.isPending}
              className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-colors disabled:opacity-50"
              style={{ background: "var(--green)", color: "white" }}
            >
              <CheckCheck size={13} strokeWidth={2.4} />
              {batchApprove.isPending ? "Approving…" : `Approve all (${openVisible.length})`}
            </button>
          )}
        </div>

        {/* Body */}
        {isLoading ? (
          /* Structured skeleton — keeps the queue's shape while data lands. */
          <div className="rounded-xl overflow-hidden px-4 py-3"
            style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
            <SkeletonTable rows={5} />
          </div>
        ) : visible.length === 0 ? (
          <div className="rounded-xl p-12 text-center"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
            <FileText size={26} strokeWidth={1.5} style={{ color: "var(--text-muted)" }} className="mx-auto mb-3" />
            <p className="text-base font-semibold text-theme mb-1">
              {status === "open" ? "No proposed entries to review" : "Nothing here"}
            </p>
            <p className="text-sm max-w-md mx-auto" style={{ color: "var(--text-muted)" }}>
              Proposed entries appear as you reconcile bank accounts and run AI on reconciliations
              and flux variances. They'll show up here and inline on each surface.
            </p>
          </div>
        ) : (
          SOURCE_ORDER.map((src) => {
            const group = grouped[src] ?? []
            if (group.length === 0) return null
            const meta = SOURCE_META[src]
            return (
              <div key={src} className="space-y-2.5">
                <div className="flex items-baseline gap-2">
                  <h2 className="text-sm font-semibold text-theme">{meta.label}</h2>
                  <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                    {group.length} {group.length === 1 ? "entry" : "entries"} · {meta.hint}
                  </span>
                </div>
                <div className="space-y-3">
                  {group.map((e) => (
                    <div key={e.id}>
                      <div className="flex items-center gap-1.5 mb-1 text-[10px] uppercase tracking-wide"
                        style={{ color: "var(--text-muted)" }}>
                        <span>Period {formatDate(e.period_end)}</span>
                      </div>
                      <ProposedEntryCard entry={e} canReview={canReview} canEdit={canEdit} />
                    </div>
                  ))}
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
