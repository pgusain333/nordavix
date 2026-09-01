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
import { CheckCheck, FileText, Save, Download, Lock, RefreshCw, CheckCircle2, AlertCircle, Network, ChevronDown } from "lucide-react"

import { SkeletonTable } from "@/core/ui/Skeleton"
import { PageHeader } from "@/core/ui/PageHeader"
import { formatDate } from "@/core/lib/dates"
import { workspaceApi } from "@/modules/workspace/api"
import { adjustmentsApi, type AdjustmentStatus, type CheckPostedResult, type ProposedEntry, type ProposedEntryList } from "../api"
import { ProposedEntryCard } from "../components/ProposedEntryCard"
import { EntryTrace } from "../components/EntryTrace"
import { patchAdjustments } from "../optimistic"

const SOURCE_META: Record<string, { label: string; hint: string }> = {
  bank:       { label: "Bank reconciliation", hint: "Fees, interest, and other bank-only items" },
  recon:      { label: "Reconciliations",     hint: "Corrections from account reconciliation review" },
  flux:       { label: "Flux analysis",       hint: "Adjustments surfaced by variance analysis" },
  gl_accuracy: { label: "GL accuracy",        hint: "Corrections raised by the misclassification watchdog" },
  assistant:  { label: "Assistant",           hint: "Entries drafted in conversation with the AI" },
}
/** Preferred ORDER, not an allowlist — see `renderOrder`.
 *
 *  §471(c) allocation entries are NOT here and must not be: Nordavix Allocate
 *  is a separate product with its own review, approval and export. The server
 *  excludes them from this queue entirely (see NON_CLOSE_SOURCES); this list
 *  simply has no reason to name them. */
const SOURCE_ORDER = ["bank", "recon", "flux", "gl_accuracy", "assistant"] as const

/** A producer this page hasn't been told about. A plainly-labelled group beats
 *  a row nobody can see. */
const FALLBACK_META = { label: "Other", hint: "Proposed from another Nordavix module" }

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

  /**
   * Every source actually PRESENT, preferred ones first.
   *
   * The list used to iterate a hardcoded array, so an entry from any module
   * this page hadn't been told about was counted in the tab totals and then
   * drawn by nothing — "Open 3" above an empty screen. Two producers were
   * already invisible that way: cost allocation and the assistant. Deriving
   * the order from the data means the next producer shows up by default
   * instead of disappearing.
   */
  const renderOrder = useMemo(() => {
    const known: string[] = SOURCE_ORDER.filter((s) => (grouped[s]?.length ?? 0) > 0)
    const extra = Object.keys(grouped)
      .filter((s) => !(SOURCE_ORDER as readonly string[]).includes(s))
      .filter((s) => (grouped[s]?.length ?? 0) > 0)
      .sort()
    return [...known, ...extra]
  }, [grouped])

  const openVisible = visible.filter((e) => e.status === "open")

  // Per-period batch gating (only meaningful when one period is selected).
  const periodActive = base.filter((e) => e.status !== "dismissed")
  const hasOpen = periodActive.some((e) => e.status === "open")
  const readyToSave = !!period && periodActive.length > 0 && !hasOpen && periodActive.some((e) => !e.saved_at)
  const savedCount = base.filter((e) => !!e.saved_at).length
  // Only saved entries still 'accepted' are importable — posted ones are
  // already in QBO and the CSV excludes them (re-importing would double-book).
  const importableCount = base.filter((e) => !!e.saved_at && e.status === "accepted").length
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
            || head.includes("trial-balance") || head.includes("flux") || head.includes("variance")
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
                    disabled={importableCount === 0 || downloadMut.isPending}
                    className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-40"
                    style={{ background: "var(--surface-2)", color: "var(--text)", border: "1px solid var(--border-strong)" }}
                    title={
                      savedCount === 0
                        ? "Save the batch first"
                        : importableCount === 0
                          ? "All saved entries are already posted in QuickBooks"
                          : "Download QBO journal-entry CSV"
                    }
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

        {/* What this period's adjustments do to the statements */}
        {period && <NetEffectStrip periodEnd={period} />}

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
                  {checkResult.all_posted && (() => {
                    const r = checkResult.reopened_accounts.length
                    const f = checkResult.reopened_flux_accounts?.length ?? 0
                    const parts: string[] = []
                    if (r) parts.push(`${r} reconciliation${r === 1 ? "" : "s"}`)
                    if (f) parts.push(`${f} flux analys${f === 1 ? "is" : "es"}`)
                    return parts.length
                      ? ` · all posted — ${parts.join(" + ")} reopened to redo`
                      : " · all posted"
                  })()}
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
          renderOrder.map((src) => {
            const group = grouped[src] ?? []
            if (group.length === 0) return null
            const meta = SOURCE_META[src] ?? FALLBACK_META
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
                    <EntryRow key={e.id} entry={e} canReview={canReview} canEdit={canEdit} />
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

// ── What the period's adjustments do to the financial statements ─────────────
//
// Two halves that answer different questions. BOOKED is the difference between
// the general ledger and the financials you will hand over — the first thing a
// reviewer asks of an approved batch and, until now, a figure nobody could see
// without re-adding the entries by hand.
//
// PASSED is the uncorrected-difference schedule an auditor keeps on paper. Each
// item was immaterial on its own — that is why it was passed — so the only way
// to know whether they matter is to total them. Three at $340, $290 and $410
// are $1,040, and no close product has ever added them up.
function NetEffectStrip({ periodEnd }: { periodEnd: string }) {
  const { data } = useQuery({
    queryKey: ["adjustments", "net-effect", periodEnd],
    queryFn:  () => adjustmentsApi.netEffect(periodEnd),
    staleTime: 15_000,
  })
  if (!data) return null
  const { booked, passed } = data
  if (booked.count === 0 && passed.count === 0) return null

  const n = (s: string) => parseFloat(s) || 0
  const money = (s: string) => {
    const v = n(s)
    return `${v < 0 ? "−" : v > 0 ? "+" : ""}$${Math.abs(v).toLocaleString(undefined, {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    })}`
  }
  const moves: [string, string][] = ([
    ["Net income", booked.net_income],
    ["Assets", booked.assets],
    ["Liabilities & equity", booked.liabilities_equity],
  ] as [string, string][]).filter(([, v]) => n(v) !== 0)

  return (
    <div className="rounded-xl px-3.5 py-3"
      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
          Booked
        </span>
        <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
          {booked.count} {booked.count === 1 ? "entry" : "entries"}
        </span>
        <div className="flex flex-wrap gap-x-4 gap-y-1 ml-auto">
          {moves.length === 0 ? (
            <span className="text-[11.5px]" style={{ color: "var(--text-muted)" }}>
              No net movement
            </span>
          ) : moves.map(([label, v]) => (
            <span key={label} className="text-[11.5px]">
              <span style={{ color: "var(--text-muted)" }}>{label}</span>{" "}
              <span className="font-semibold tabular-nums text-theme">{money(v)}</span>
            </span>
          ))}
        </div>
      </div>

      {!booked.complete && (
        <p className="text-[10.5px] mt-1.5 flex items-start gap-1.5" style={{ color: "#8a6326" }}>
          <AlertCircle size={11} strokeWidth={2} className="shrink-0 mt-0.5" />
          {booked.unclassified_lines} line{booked.unclassified_lines === 1 ? "" : "s"} couldn't
          be matched to an account in this period's chart, so this is part of the movement,
          not all of it.
        </p>
      )}

      {passed.count > 0 && (
        <div className="mt-2.5 pt-2.5" style={{ borderTop: "1px solid var(--border)" }}>
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
              Passed
            </span>
            <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
              {passed.count} not booked
            </span>
            <span className="text-[11.5px] ml-auto">
              <span style={{ color: "var(--text-muted)" }}>Would have moved net income</span>{" "}
              <span className="font-semibold tabular-nums text-theme">{money(passed.net_income)}</span>
            </span>
          </div>
          {!passed.complete && (
            <p className="text-[10.5px] mt-1" style={{ color: "#8a6326" }}>
              {passed.unclassified_lines} line{passed.unclassified_lines === 1 ? "" : "s"} here
              couldn't be classified, so the real total is larger than this.
            </p>
          )}
          {passed.without_reason > 0 && (
            <p className="text-[10.5px] mt-1" style={{ color: "#8a6326" }}>
              {passed.without_reason} of these {passed.without_reason === 1 ? "has" : "have"} no
              recorded reason — they were passed before Nordavix asked for one.
            </p>
          )}
        </div>
      )}
    </div>
  )
}


// ── One queue row: the entry card + a lazy provenance disclosure ─────────────
//
// The trail mounts only when opened, and for EVERY status. It used to be a
// "Related" graph panel gated on accepted/posted, which meant the two entries a
// reviewer most needs to account for — an open draft and one that was passed —
// were the two that could explain nothing about themselves.
function EntryRow({ entry, canReview, canEdit }: {
  entry:     ProposedEntry
  canReview: boolean
  canEdit:   boolean
}) {
  const [showTrail, setShowTrail] = useState(false)
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1 text-[10px] uppercase tracking-wide"
        style={{ color: "var(--text-muted)" }}>
        <span>Period {formatDate(entry.period_end)}</span>
        {entry.posted_qbo_doc && (
          <span className="inline-flex items-center gap-1 normal-case" style={{ color: "var(--green)" }}>
            <CheckCircle2 size={10} strokeWidth={2.4} />
            In QuickBooks as {entry.posted_qbo_doc}
          </span>
        )}
      </div>
      <ProposedEntryCard entry={entry} canReview={canReview} canEdit={canEdit} />
      <button
        type="button"
        onClick={() => setShowTrail((v) => !v)}
        className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium transition-opacity hover:opacity-80"
        style={{ color: "var(--text-muted)" }}
      >
        <Network size={12} strokeWidth={2} />
        {showTrail ? "Hide trail" : "Where this came from"}
        <ChevronDown size={12} strokeWidth={2}
          style={{ transform: showTrail ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
      </button>
      {showTrail && (
        <div className="mt-2">
          <EntryTrace entryId={entry.id} />
        </div>
      )}
    </div>
  )
}
