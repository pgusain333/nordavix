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
import { AnimatePresence, motion, useReducedMotion } from "framer-motion"
import { CheckCheck, FileText, Save, Download, Lock, RefreshCw, CheckCircle2, AlertCircle, Network, ChevronDown } from "lucide-react"

import { MOTION, EASE } from "@/core/motion"
import { SkeletonTable } from "@/core/ui/Skeleton"
import { PageHeader } from "@/core/ui/PageHeader"
import { formatDate } from "@/core/lib/dates"
import { workspaceApi } from "@/modules/workspace/api"
import { adjustmentsApi, type AdjustmentStatus, type CheckPostedResult, type ProposedEntry, type ProposedEntryList } from "../api"
import { ProposedEntryCard } from "../components/ProposedEntryCard"
import { EntryTrace } from "../components/EntryTrace"
import { StatementRail } from "../components/StatementRail"
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

/** A card leaving the queue, and its neighbours closing the gap. Shared by the
 *  groups and the rows so a whole section and a single entry exit on the same
 *  beat — the stagger is capped so a long list still clears promptly. */
function rowMotion(reduce: boolean | null, i = 0) {
  return {
    layout: !reduce,
    initial: reduce ? false : { opacity: 0, y: -6 },
    animate: { opacity: 1, y: 0 },
    exit: reduce ? undefined : { opacity: 0, height: 0, marginTop: 0 },
    transition: { duration: MOTION.DEFAULT, ease: EASE.OUT, delay: reduce ? 0 : Math.min(i, 5) * 0.02 },
  } as const
}

/** A section that opens and closes in place — disclosures, banners, the strip. */
function revealMotion(reduce: boolean | null) {
  return {
    initial: reduce ? false : { height: 0, opacity: 0 },
    animate: { height: "auto", opacity: 1 },
    exit: reduce ? { opacity: 0 } : { height: 0, opacity: 0 },
    transition: { duration: MOTION.DEFAULT, ease: EASE.OUT },
    style: { overflow: "hidden" as const },
  }
}

export function AdjustmentsPage() {
  const qc = useQueryClient()
  const reduce = useReducedMotion()
  const [status, setStatus] = useState<AdjustmentStatus | "all">("open")
  // Entry ids behind the statement line the reviewer clicked in the rail. The
  // traceability chain, pointed at the number they actually sign.
  const [traced, setTraced] = useState<string[]>([])

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

      <div className="flex-1 px-4 sm:px-8 py-5 max-w-7xl w-full mx-auto space-y-5">
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
                {/* The batch walks through four states as you work. Crossfading
                    the sentence — rather than swapping the text under the
                    cursor — is what makes approving the last entry read as
                    progress instead of a flicker. */}
                <AnimatePresence mode="wait" initial={false}>
                  <motion.p
                    key={hasOpen ? "open" : allSaved ? "saved" : readyToSave ? "ready" : "none"}
                    initial={reduce ? false : { opacity: 0, y: 3 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={reduce ? { opacity: 0 } : { opacity: 0, y: -3 }}
                    transition={{ duration: MOTION.FAST, ease: EASE.OUT }}
                    className="text-[11px] min-w-0" style={{ color: "var(--text-muted)" }}>
                    {hasOpen
                      ? "Approve every entry, then Save to lock the batch."
                      : allSaved
                        ? `Saved · ${savedCount} entr${savedCount === 1 ? "y" : "ies"} locked. Download the CSV and import it in QuickBooks.`
                        : readyToSave
                          ? "All approved — Save to lock the batch and unlock the CSV."
                          : "No approved entries yet."}
                  </motion.p>
                </AnimatePresence>

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

        {/* Posting-check result — opens under the batch bar rather than
            shoving the queue down in one frame. */}
        <AnimatePresence initial={false}>
        {period && checkResult && checkResult.period_end === period && (
          <motion.div key="check" {...revealMotion(reduce)}>
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
          </motion.div>
        )}
        </AnimatePresence>

        {/* Status tabs + batch approve */}
        <div className="flex items-center gap-2 flex-wrap">
          {STATUS_TABS.map((t) => {
            const active = status === t.key
            const n = counts[t.key] ?? 0
            return (
              <button
                key={t.key}
                onClick={() => setStatus(t.key)}
                className="relative inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium"
                style={{
                  background: "var(--surface)",
                  color:      active ? "var(--green)" : "var(--text-muted)",
                  border:     `1px solid ${active ? "transparent" : "var(--border)"}`,
                  transition: reduce ? "none" : "color .18s",
                }}
              >
                {/* One pill, shared across all five tabs — framer moves it
                    between them instead of painting a new one, so the
                    selection travels with the click. */}
                {active && (
                  <motion.span
                    layoutId={reduce ? undefined : "adjustments-tab-pill"}
                    className="absolute inset-0 rounded-full"
                    style={{ background: "var(--green-subtle)" }}
                    transition={{ duration: MOTION.DEFAULT, ease: EASE.OUT }}
                  />
                )}
                <span className="relative">{t.label}</span>
                {/* The count changes the moment you approve something. Rolling
                    the new number in makes the tab you didn't click visibly
                    respond to what you did. */}
                <span className="relative text-[10px] opacity-70 tabular-nums overflow-hidden inline-block"
                  style={{ minWidth: `${String(n).length * 0.6}em` }}>
                  <AnimatePresence mode="popLayout" initial={false}>
                    <motion.span key={n} className="inline-block"
                      initial={reduce ? false : { y: -8, opacity: 0 }}
                      animate={{ y: 0, opacity: 1 }}
                      exit={reduce ? { opacity: 0 } : { y: 8, opacity: 0 }}
                      transition={{ duration: MOTION.FAST, ease: EASE.OUT }}>
                      {n}
                    </motion.span>
                  </AnimatePresence>
                </span>
              </button>
            )
          })}

          <AnimatePresence initial={false}>
            {canReview && openVisible.length > 0 && (
              <motion.button
                key="approve-all"
                initial={reduce ? false : { opacity: 0, scale: 0.94 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.94 }}
                whileTap={reduce ? undefined : { scale: 0.97 }}
                transition={{ duration: MOTION.FAST, ease: EASE.OUT }}
                onClick={() => batchApprove.mutate()}
                disabled={batchApprove.isPending}
                className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-colors disabled:opacity-50"
                style={{ background: "var(--green)", color: "white" }}
              >
                <CheckCheck size={13} strokeWidth={2.4} />
                {batchApprove.isPending ? "Approving…" : `Approve all (${openVisible.length})`}
              </motion.button>
            )}
          </AnimatePresence>
        </div>

        {/* The split. The queue is a list and reads narrow; what it adds up to
            is a table and belongs beside it, not below — a reviewer approving a
            batch is asking one question, and the answer should be in view while
            they work. Stacks under lg, where a sticky rail would just eat the
            screen. */}
        <div className="grid gap-4 items-start lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-5">

        {/* Body — the three states cross-fade rather than cutting, so landing
            data and emptying a filter both read as one movement.
            popLayout, not "wait": waiting unmounts the old body BEFORE the new
            one arrives, so switching tabs collapsed the page to nothing for a
            frame and then re-expanded. popLayout takes the outgoing view out
            of flow and lets the incoming one hold the height straight away. */}
        <AnimatePresence mode="popLayout" initial={false}>
        {isLoading ? (
          /* Structured skeleton — keeps the queue's shape while data lands. */
          <motion.div key="loading"
            initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }}
            exit={{ opacity: 0 }} transition={{ duration: MOTION.FAST, ease: EASE.OUT }}
            className="rounded-xl overflow-hidden px-4 py-3"
            style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
            <SkeletonTable rows={5} />
          </motion.div>
        ) : visible.length === 0 ? (
          <motion.div key="empty"
            initial={reduce ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }}
            transition={{ duration: MOTION.DEFAULT, ease: EASE.OUT }}
            className="rounded-xl p-12 text-center"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
            <FileText size={26} strokeWidth={1.5} style={{ color: "var(--text-muted)" }} className="mx-auto mb-3" />
            <p className="text-base font-semibold text-theme mb-1">
              {status === "open" ? "No proposed entries to review" : "Nothing here"}
            </p>
            <p className="text-sm max-w-md mx-auto" style={{ color: "var(--text-muted)" }}>
              Proposed entries appear as you reconcile bank accounts and run AI on reconciliations
              and flux variances. They'll show up here and inline on each surface.
            </p>
          </motion.div>
        ) : (
          /* Keyed on the filter so switching tabs is one crossfade, while
             WITHIN a tab the inner keys are entry ids — approving a card
             animates just that card out and slides its neighbours up. */
          <motion.div key={`list-${status}-${period}`}
            initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }}
            exit={{ opacity: 0 }} transition={{ duration: MOTION.FAST, ease: EASE.OUT }}
            className="space-y-5">
            <AnimatePresence initial={false}>
              {renderOrder.map((src, gi) => {
                const group = grouped[src] ?? []
                if (group.length === 0) return null
                const meta = SOURCE_META[src] ?? FALLBACK_META
                return (
                  <motion.div key={src} {...rowMotion(reduce, gi)} className="space-y-2.5">
                    <div className="flex items-baseline gap-2">
                      <h2 className="text-sm font-semibold text-theme">{meta.label}</h2>
                      <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                        {group.length} {group.length === 1 ? "entry" : "entries"} · {meta.hint}
                      </span>
                    </div>
                    <div className="space-y-3">
                      <AnimatePresence initial={false}>
                        {group.map((e, i) => (
                          <motion.div key={e.id} {...rowMotion(reduce, i)}>
                            <EntryRow entry={e} canReview={canReview} canEdit={canEdit}
                              reduce={reduce} traced={traced.includes(e.id)} />
                          </motion.div>
                        ))}
                      </AnimatePresence>
                    </div>
                  </motion.div>
                )
              })}
            </AnimatePresence>
          </motion.div>
        )}
        </AnimatePresence>
        </div>

        {/* Sticky only where there's room to be sticky. */}
        {period && (
          <div className="min-w-0 lg:sticky lg:top-4">
            <StatementRail periodEnd={period} onTrace={setTraced} />
          </div>
        )}
        </div>
      </div>
    </div>
  )
}

// ── One queue row: the entry card + a lazy provenance disclosure ─────────────
//
// The trail mounts only when opened, and for EVERY status. It used to be a
// "Related" graph panel gated on accepted/posted, which meant the two entries a
// reviewer most needs to account for — an open draft and one that was passed —
// were the two that could explain nothing about themselves.
function EntryRow({ entry, canReview, canEdit, reduce, traced }: {
  entry:     ProposedEntry
  canReview: boolean
  canEdit:   boolean
  reduce:    boolean | null
  /** This entry moves the statement line selected in the rail. */
  traced?:   boolean
}) {
  const [showTrail, setShowTrail] = useState(false)
  return (
    <div className="rounded-xl"
      style={{
        // The link back from a figure to the entries behind it. A ring rather
        // than a colour change, so it reads as "these ones" without implying
        // anything about their status.
        boxShadow: traced ? "0 0 0 2px var(--green)" : "none",
        transition: reduce ? "none" : "box-shadow .18s",
      }}>
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
          style={{
            transform: showTrail ? "rotate(180deg)" : "none",
            transition: reduce ? "none" : `transform ${MOTION.DEFAULT}s ${EASE.OUT}`,
          }} />
      </button>
      {/* The trail opens in place. Height AND opacity, with opacity trailing
          slightly, so the panel isn't legible before it has finished sizing. */}
      <AnimatePresence initial={false}>
        {showTrail && (
          <motion.div key="trail"
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{
              height: "auto", opacity: 1,
              transition: reduce ? { duration: 0 } : {
                height:  { duration: MOTION.SLOW, ease: EASE.OUT },
                opacity: { duration: MOTION.DEFAULT, delay: 0.05 },
              },
            }}
            exit={reduce ? { opacity: 0 } : {
              height: 0, opacity: 0,
              transition: { height: { duration: MOTION.DEFAULT, ease: EASE.OUT }, opacity: { duration: MOTION.FAST } },
            }}
            style={{ overflow: "hidden" }}>
            <div className="mt-2">
              <EntryTrace entryId={entry.id} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
