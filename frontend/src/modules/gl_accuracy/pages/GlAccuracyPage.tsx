/**
 * GL Accuracy — "Second Set of Eyes". Nordavix compares each vendor's coding to
 * its own history and surfaces only the entries that break a strong habit, each
 * backed by a real tally you can audit at a glance. Calm, trust-first: the hero
 * is reassurance ("N look right"), red is one static dot, the dollar stat is
 * "to reclassify" (P&L-neutral). Accept files a reclass into Adjustments;
 * Dismiss teaches it. Nothing is ever written to QuickBooks.
 */
import { useState } from "react"
import { useOrganization } from "@clerk/clerk-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AnimatePresence, motion, useReducedMotion } from "framer-motion"
import { useNavigate } from "react-router-dom"
import {
  ShieldCheck, Sparkles, Brain, ArrowRight, ArrowUpRight, ArrowDown, ArrowLeft,
  Check, ThumbsUp, ChevronDown, ListChecks,
} from "lucide-react"
import { Button, Spinner } from "@/core/ui/components"
import { formatDate } from "@/core/lib/dates"
import { useSelectedPeriod } from "@/core/hooks/useSelectedPeriod"
import { closeApi } from "@/modules/close/api"
import { workspaceApi } from "@/modules/workspace/api"
import { ProposedEntryCard } from "@/modules/adjustments/components/ProposedEntryCard"
import type { ProposedEntry } from "@/modules/adjustments/api"
import { glAccuracyApi, type GlFinding } from "@/modules/gl_accuracy/api"

function fmtUsd(s: string | number | null | undefined): string {
  if (s == null || s === "") return "—"
  const n = Number(s)
  if (Number.isNaN(n)) return "—"
  return `$${Math.abs(Math.round(n)).toLocaleString()}`
}

// Build the proposed reclass JE from a finding (sign-aware), shaped for the
// shared ProposedEntryCard in preview mode — so the fix looks exactly like the
// adjustments the firm already posts. (The real ProposedEntry is created server-
// side on Accept; this is a faithful read-only mirror.)
function reclassPreview(f: GlFinding): ProposedEntry {
  const signed = Number(f.amount) || 0
  const amt = Math.abs(signed).toFixed(2)
  const right = { account_qbo_id: f.suggested_account_id, account_number: null, account_name: f.suggested_account_name || "Suggested account" }
  const wrong = { account_qbo_id: f.posted_account_id, account_number: null, account_name: f.posted_account_name || "Posted account" }
  const lines = signed >= 0
    ? [{ ...right, debit: amt, credit: "0.00" }, { ...wrong, debit: "0.00", credit: amt }]
    : [{ ...wrong, debit: amt, credit: "0.00" }, { ...right, debit: "0.00", credit: amt }]
  return {
    id: `preview-${f.id}`, source: "gl_accuracy", source_ref: f.id, period_end: f.period_end,
    description: `Reclassify ${f.vendor}: ${f.posted_account_name || "posted"} → ${f.suggested_account_name || "suggested"}`,
    lines, memo: f.memo, confidence: f.confidence, status: "open", saved_at: null,
    rationale: `${f.vendor} posts to ${f.suggested_account_name || "the right account"} on ${f.dominant_count} of its last ${f.total_count} transactions; this entry went to ${f.posted_account_name || "another account"}.`,
  } as unknown as ProposedEntry
}

export function GlAccuracyPage() {
  const { organization } = useOrganization()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const reduce = !!useReducedMotion()

  const { data: me } = useQuery({
    queryKey: ["workspace-me"], queryFn: workspaceApi.getMe,
    staleTime: 10 * 60_000, enabled: !!organization,
  })
  const canReview = me?.role === "admin" || me?.role === "reviewer"

  const { data: periodsResp } = useQuery({
    queryKey: ["close", "periods"], queryFn: closeApi.getPeriods, enabled: !!organization,
  })
  const fallback = periodsResp?.focus || periodsResp?.periods[0]?.period_end || ""
  const [period, setPeriod] = useSelectedPeriod(fallback)
  const activePeriod = period || fallback

  const { data, isLoading } = useQuery({
    queryKey: ["gl-accuracy", "findings", activePeriod],
    queryFn:  () => glAccuracyApi.getFindings(activePeriod),
    enabled:  !!organization && !!activePeriod,
  })

  const [scanned, setScanned] = useState<{ period: string; total: number } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [filter, setFilter] = useState<"all" | "high" | "medium">("all")
  const [openId, setOpenId] = useState<string | null>(null)
  // C3c — the reviewer's pre-close sweep: multi-select for bulk-accept and a
  // guided one-at-a-time walk. Accept-only by design; dismiss stays single.
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [guided, setGuided] = useState(false)
  const [step, setStep] = useState(0)

  const scanMut = useMutation({
    mutationFn: () => glAccuracyApi.scan(activePeriod),
    onSuccess: (s) => {
      setErr(null)
      setScanned({ period: activePeriod, total: s.scanned })
      setSelected(new Set())
      qc.invalidateQueries({ queryKey: ["gl-accuracy", "findings", activePeriod] })
    },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setErr(msg ?? "Couldn't finish the check — the last QuickBooks sync may be incomplete. Your books are unchanged.")
    },
  })

  const bulkMut = useMutation({
    mutationFn: (ids: string[]) => glAccuracyApi.bulkAccept(ids),
    onSuccess: () => {
      setSelected(new Set())
      qc.invalidateQueries({ queryKey: ["adjustments"] })
      qc.invalidateQueries({ queryKey: ["gl-accuracy", "findings", activePeriod] })
    },
  })

  const items = data?.items ?? []
  const open = items.filter((f) => f.status === "open")
  const high = open.filter((f) => f.confidence === "high").length
  const medium = open.length - high
  const dollars = open.reduce((s, f) => s + Math.abs(Number(f.amount) || 0), 0)
  const shown = items.filter((f) => filter === "all" || (f.status === "open" && f.confidence === filter))
  // Trophy only right after an explicit scan of this period returned nothing.
  const justScannedClean = scanned?.period === activePeriod && open.length === 0

  // Selection only ever acts on still-open findings (stale ids are pruned both
  // here and server-side), and the guided queue walks the filtered open list.
  const openIds = new Set(open.map((f) => f.id))
  const selectedOpen = [...selected].filter((id) => openIds.has(id))
  const selectedDollars = open.filter((f) => selected.has(f.id)).reduce((s, f) => s + Math.abs(Number(f.amount) || 0), 0)
  const guidedQueue = shown.filter((f) => f.status === "open")
  const guidedIdx = Math.min(step, Math.max(0, guidedQueue.length - 1))

  const toggleSelect = (id: string) => setSelected((prev) => {
    const n = new Set(prev)
    if (n.has(id)) n.delete(id); else n.add(id)
    return n
  })
  const selectHigh = () => setSelected(new Set(open.filter((f) => f.confidence === "high").map((f) => f.id)))

  if (!organization) {
    return <Shell><Card><div className="p-6 text-sm" style={{ color: "var(--text-muted)" }}>
      Select a workspace to run the accuracy check.</div></Card></Shell>
  }

  return (
    <Shell>
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap mb-5">
        <div className="flex items-center gap-3 min-w-0">
          <span className="h-10 w-10 rounded-xl flex items-center justify-center shrink-0"
            style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
            <ShieldCheck size={20} strokeWidth={1.8} />
          </span>
          <div className="min-w-0">
            <h1 className="text-lg font-bold text-theme leading-tight">GL accuracy</h1>
            <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
              {scanned?.period === activePeriod
                ? <>Nordavix checked <span className="text-theme font-semibold">{scanned.total.toLocaleString()} entries</span> against this client's posting history.</>
                : "Nordavix compares each vendor's coding to its own history — and never writes to QuickBooks."}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {periodsResp && periodsResp.periods.length > 0 && (
            <select value={activePeriod} onChange={(e) => { setPeriod(e.target.value); setScanned(null); setOpenId(null); setSelected(new Set()); setGuided(false); setStep(0) }}
              className="rounded-lg px-3 py-2 text-sm outline-none"
              style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }}>
              {periodsResp.periods.map((p) => (
                <option key={p.period_end} value={p.period_end}>{p.label}{p.closed ? " · closed" : ""}</option>
              ))}
            </select>
          )}
          <Button size="sm" loading={scanMut.isPending} disabled={!activePeriod} onClick={() => scanMut.mutate()}
            icon={<Sparkles size={14} strokeWidth={2} />}>
            {data && items.length > 0 ? "Re-run check" : "Run accuracy check"}
          </Button>
        </div>
      </div>

      {err && (
        <div className="rounded-xl px-4 py-3 text-[12px] mb-4"
          style={{ background: "var(--danger-subtle)", color: "var(--danger)", border: "1px solid var(--danger-border)" }}>
          {err} <span style={{ color: "var(--text-muted)" }}>Retry when ready.</span>
        </div>
      )}

      {scanMut.isPending ? (
        <ScanningCard />
      ) : isLoading && !data ? (
        <Card><div className="p-6 flex items-center gap-3"><Spinner className="h-5 w-5" />
          <span className="text-sm" style={{ color: "var(--text-muted)" }}>Loading…</span></div></Card>
      ) : justScannedClean ? (
        <AllClearTrophy total={scanned?.total ?? 0} reduce={reduce} />
      ) : items.length === 0 ? (
        <FirstRun onRun={() => scanMut.mutate()} busy={scanMut.isPending} hasPeriod={!!activePeriod} />
      ) : (
        <>
          {/* Reassurance strip */}
          <div className="rounded-xl p-4 mb-4" style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
            <div className="flex items-stretch text-center">
              {scanned?.period === activePeriod && (
                <>
                  <div className="flex-1">
                    <div className="text-2xl font-bold" style={{ color: "var(--green)" }}>{Math.max(0, scanned.total - open.length).toLocaleString()}</div>
                    <div className="text-[12px]" style={{ color: "var(--text-muted)" }}>look right</div>
                  </div>
                  <div className="w-px" style={{ background: "var(--border)" }} />
                </>
              )}
              <div className="flex-1">
                <div className="text-2xl font-bold text-theme">{open.length}</div>
                <div className="text-[12px]" style={{ color: "var(--text-muted)" }}>to review</div>
              </div>
              <div className="w-px" style={{ background: "var(--border)" }} />
              <div className="flex-1">
                <div className="text-2xl font-bold" style={{ color: "var(--text-2)" }}>{fmtUsd(dollars)}</div>
                <div className="text-[12px]" style={{ color: "var(--text-muted)" }} title="Reclassifying doesn't change net income, only where it lands.">to reclassify</div>
              </div>
            </div>
            {open.length > 0 && (
              <div role="img" aria-label={`${high} high confidence, ${medium} medium`} className="flex gap-0.5 mt-3.5 rounded-full overflow-hidden" style={{ height: 4 }}>
                {high > 0 && <div style={{ flex: high, background: "var(--green)", opacity: 0.55 }} />}
                {medium > 0 && <div style={{ flex: medium, background: "#8a6326", opacity: 0.45 }} />}
              </div>
            )}
          </div>

          {/* Toolbar — filter chips + bulk / guided affordances */}
          {open.length > 0 && (
            <div className="flex items-center gap-1.5 mb-3 flex-wrap">
              {([["all", "All", open.length], ["high", "High", high], ["medium", "Medium", medium]] as const).map(([k, lbl, n]) => (
                <button key={k} onClick={() => setFilter(k)}
                  className="text-[13px] px-2.5 py-1 rounded-md"
                  style={filter === k
                    ? { background: "var(--green-subtle)", color: "var(--green)", border: "1px solid var(--green)" }
                    : { background: "var(--surface-2)", color: "var(--text-muted)", border: "1px solid var(--border)" }}>
                  {lbl} <span style={{ opacity: 0.6 }}>{n}</span>
                </button>
              ))}
              <div className="flex-1" />
              {high > 0 && !guided && (
                <button onClick={selectHigh}
                  className="text-[12px] px-2.5 py-1 rounded-md inline-flex items-center gap-1"
                  style={{ background: "var(--surface-2)", color: "var(--text-2)", border: "1px solid var(--border)" }}>
                  <Check size={12} strokeWidth={2.4} /> Select {high} high-confidence
                </button>
              )}
              <button onClick={() => { setGuided((g) => !g); setStep(0); setSelected(new Set()) }}
                className="text-[12px] px-2.5 py-1 rounded-md inline-flex items-center gap-1"
                style={guided
                  ? { background: "var(--green-subtle)", color: "var(--green)", border: "1px solid var(--green)" }
                  : { background: "var(--surface-2)", color: "var(--text-2)", border: "1px solid var(--border)" }}>
                <ListChecks size={12} strokeWidth={2} /> Guided review
              </button>
            </div>
          )}

          {/* Guarded bulk-accept bar — accept-only; never bulk-dismiss. The
              reclasses still land in Adjustments for the normal approval gate. */}
          <AnimatePresence initial={false}>
            {!guided && selectedOpen.length > 0 && (
              <motion.div initial={reduce ? false : { height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={reduce ? undefined : { height: 0, opacity: 0 }} transition={{ duration: 0.15 }} style={{ overflow: "hidden" }}>
                <div className="flex items-center gap-2 mb-3 rounded-xl px-3.5 py-2.5"
                  style={{ background: "var(--green-subtle)", border: "1px solid var(--green)" }}>
                  <span className="text-[13px] font-semibold" style={{ color: "var(--green)" }}>
                    {selectedOpen.length} selected · {fmtUsd(selectedDollars)} to reclassify
                  </span>
                  <div className="flex-1" />
                  <button onClick={() => setSelected(new Set())} className="text-[12px] px-2.5 py-1.5 rounded-lg font-semibold"
                    style={{ color: "var(--text-2)", border: "1px solid var(--border-strong)" }}>Clear</button>
                  <button onClick={() => bulkMut.mutate(selectedOpen)} disabled={bulkMut.isPending}
                    className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-bold text-white disabled:opacity-50"
                    style={{ background: "var(--green)" }}>
                    {bulkMut.isPending ? <Spinner className="h-3.5 w-3.5" /> : <Check size={13} strokeWidth={2.6} />}
                    Accept {selectedOpen.length} → Adjustments
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Findings — guided one-at-a-time, or the full reviewable list */}
          {guided ? (
            guidedQueue.length === 0 ? (
              <div className="rounded-xl p-6 text-center" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
                <ShieldCheck size={28} strokeWidth={1.8} style={{ color: "var(--green)" }} className="mx-auto mb-2" />
                <p className="text-sm font-semibold text-theme">Every flagged entry reviewed</p>
                <p className="text-[12px] mt-1" style={{ color: "var(--text-muted)" }}>Nothing left in the guided queue for this filter.</p>
                <button onClick={() => setGuided(false)} className="mt-3 text-[12px] font-semibold" style={{ color: "var(--green)" }}>Back to list</button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                    Reviewing <span className="text-theme font-semibold">{guidedIdx + 1}</span> of {guidedQueue.length}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <button onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={guidedIdx === 0}
                      className="inline-flex items-center gap-1 text-[12px] px-2.5 py-1 rounded-md disabled:opacity-40"
                      style={{ background: "var(--surface-2)", color: "var(--text-2)", border: "1px solid var(--border)" }}>
                      <ArrowLeft size={13} strokeWidth={2} /> Prev
                    </button>
                    <button onClick={() => setStep(() => Math.min(guidedQueue.length - 1, guidedIdx + 1))} disabled={guidedIdx >= guidedQueue.length - 1}
                      className="inline-flex items-center gap-1 text-[12px] px-2.5 py-1 rounded-md disabled:opacity-40"
                      style={{ background: "var(--surface-2)", color: "var(--text-2)", border: "1px solid var(--border)" }}>
                      Next <ArrowRight size={13} strokeWidth={2} />
                    </button>
                  </div>
                </div>
                <FindingCard key={guidedQueue[guidedIdx].id} f={guidedQueue[guidedIdx]} open canReview={canReview} reduce={reduce}
                  onToggle={() => {}}
                  onChanged={() => qc.invalidateQueries({ queryKey: ["gl-accuracy", "findings", activePeriod] })}
                  onGoAdjustments={() => navigate("/app/adjustments")} />
              </div>
            )
          ) : (
            <div className="space-y-2">
              {shown.map((f) => (
                <FindingCard key={f.id} f={f} open={openId === f.id} canReview={canReview} reduce={reduce}
                  selectable checked={selected.has(f.id)} onCheck={() => toggleSelect(f.id)}
                  onToggle={() => setOpenId(openId === f.id ? null : f.id)}
                  onChanged={() => qc.invalidateQueries({ queryKey: ["gl-accuracy", "findings", activePeriod] })}
                  onGoAdjustments={() => navigate("/app/adjustments")} />
              ))}
            </div>
          )}
        </>
      )}
    </Shell>
  )
}

// ── Finding card (collapsed row + expanded review) ─────────────────────────

function FindingCard({ f, open, canReview, reduce, selectable, checked, onCheck, onToggle, onChanged, onGoAdjustments }: {
  f: GlFinding; open: boolean; canReview: boolean; reduce: boolean
  selectable?: boolean; checked?: boolean; onCheck?: () => void
  onToggle: () => void; onChanged: () => void; onGoAdjustments: () => void
}) {
  const qc = useQueryClient()
  const isOpen = f.status === "open"
  const dot = f.confidence === "high" ? "var(--green)" : "#8a6326"

  const acceptMut = useMutation({
    mutationFn: () => glAccuracyApi.accept(f.id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["adjustments"] }); onChanged() },
  })
  const dismissMut = useMutation({
    mutationFn: () => glAccuracyApi.dismiss(f.id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["memory", "account-context"] }); onChanged() },
  })
  const busy = acceptMut.isPending || dismissMut.isPending

  const statusChip =
    f.status === "in_adjustments" ? { label: "In Adjustments", bg: "var(--green-subtle)", color: "var(--green)" }
    : f.status === "dismissed" ? { label: "Confirmed correct", bg: "var(--surface-2)", color: "var(--text-muted)" }
    : null

  return (
    <div className="rounded-xl overflow-hidden"
      style={{ background: "var(--surface)", border: `1px solid ${open ? "var(--green)" : "var(--border)"}`,
               boxShadow: "var(--card-shadow)", opacity: isOpen ? 1 : 0.72 }}>
      <div onClick={onToggle} className="flex items-center gap-2.5 px-3.5 py-3 cursor-pointer">
        {selectable && isOpen && (
          <input type="checkbox" checked={!!checked}
            onClick={(e) => e.stopPropagation()} onChange={onCheck}
            className="shrink-0 h-3.5 w-3.5 cursor-pointer" style={{ accentColor: "var(--green)" }}
            aria-label={`Select ${f.vendor} for bulk accept`} />
        )}
        <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: dot }} title={f.confidence === "high" ? "High confidence" : "Medium confidence"} />
        <span className="text-sm font-semibold text-theme shrink-0" style={{ minWidth: 72 }}>{f.vendor}</span>
        <span className="text-[12px] flex-1 min-w-0 truncate" style={{ color: "var(--text-muted)" }}>
          <span style={{ textDecoration: "line-through" }}>{f.posted_account_name || "—"}</span>{" "}
          <ArrowRight size={12} strokeWidth={2} style={{ display: "inline", verticalAlign: "-2px" }} />{" "}
          <span className="text-theme">{f.suggested_account_name || "—"}</span>
        </span>
        <span className="text-[13px] tabular-nums font-medium text-theme shrink-0">{fmtUsd(f.amount)}</span>
        {statusChip && (
          <span className="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded shrink-0" style={{ background: statusChip.bg, color: statusChip.color }}>{statusChip.label}</span>
        )}
        <ChevronDown size={15} strokeWidth={2} className="shrink-0" style={{ color: "var(--text-muted)", transform: open ? "rotate(180deg)" : "none", transition: reduce ? "none" : "transform .15s" }} />
      </div>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={reduce ? false : { height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={reduce ? undefined : { height: 0, opacity: 0 }} transition={{ duration: 0.18 }} style={{ overflow: "hidden" }}>
            <div className="px-3.5 pb-3.5 space-y-2.5" style={{ borderTop: "1px solid var(--border)" }}>
              {/* Zone 1 — the entry under review */}
              <div className="rounded-lg px-3 py-2 mt-2.5" style={{ border: "1px solid var(--border)" }}>
                <div className="text-[10px] uppercase tracking-wide mb-0.5" style={{ color: "var(--text-muted)" }}>The entry under review</div>
                <div className="text-[13px] text-theme">
                  {[f.txn_type, f.txn_number ? `#${f.txn_number}` : null, f.txn_date ? formatDate(f.txn_date) : null].filter(Boolean).join(" · ")}
                  {f.memo ? <span style={{ color: "var(--text-muted)" }}> · {f.memo}</span> : null}
                </div>
                <div className="text-[12px] mt-0.5">Booked to <span style={{ color: "#9b3d37" }}>{f.posted_account_name || f.posted_account_id}</span> · <span className="tabular-nums">{fmtUsd(f.amount)}</span></div>
              </div>

              {/* Zone 2 — the evidence (the hero) */}
              <EvidenceBar f={f} />

              {/* Zone 3 — why (demoted footnote) */}
              <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                Statistical pattern, not a prediction — {Math.round((f.dominant_count / Math.max(1, f.total_count)) * 100)}% of this vendor's spend goes there. Nordavix never writes to QuickBooks.
              </p>

              {/* Zone 4 — the fix + actions, OR the resolved receipt */}
              {isOpen ? (
                <>
                  <ProposedEntryCard entry={reclassPreview(f)} preview />
                  <div className="flex items-center gap-2 pt-0.5">
                    <button onClick={() => acceptMut.mutate()} disabled={busy}
                      className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-bold text-white disabled:opacity-50"
                      style={{ background: "var(--green)" }}>
                      {acceptMut.isPending ? <Spinner className="h-3.5 w-3.5" /> : <Check size={13} strokeWidth={2.6} />}
                      Accept · post to Adjustments
                    </button>
                    {canReview && (
                      <button onClick={() => dismissMut.mutate()} disabled={busy}
                        className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-semibold disabled:opacity-50"
                        style={{ border: "1px solid var(--border-strong)", color: "var(--text-2)" }}>
                        <ThumbsUp size={13} strokeWidth={2} /> This is right
                      </button>
                    )}
                  </div>
                  {!canReview && (
                    <p className="text-[10px]" style={{ color: "var(--text-muted)" }}>A reviewer can mark a finding correct (Settings → roles).</p>
                  )}
                </>
              ) : f.status === "in_adjustments" ? (
                <button onClick={onGoAdjustments}
                  className="w-full inline-flex items-center justify-between rounded-lg px-3 py-2 text-[12px] font-semibold"
                  style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
                  <span className="inline-flex items-center gap-1.5"><ArrowUpRight size={13} strokeWidth={2.2} /> Filed as a reclass — review and post in Adjustments</span>
                  <ArrowRight size={13} strokeWidth={2} />
                </button>
              ) : (
                <div className="rounded-lg px-3 py-2 flex items-start gap-2" style={{ background: "var(--surface-2)" }}>
                  <Brain size={16} strokeWidth={1.9} style={{ color: "#54588a", marginTop: 1 }} />
                  <p className="text-[12px] text-theme">What Nordavix knows — <span style={{ color: "var(--text-muted)" }}>{f.vendor} → {f.posted_account_name || f.posted_account_id} is correct. I won't flag this pairing again.</span></p>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── Evidence bar — the auditable tally (the trust centerpiece) ──────────────

function EvidenceBar({ f }: { f: GlFinding }) {
  const dom = Math.max(0, f.dominant_count)
  const other = Math.max(1, f.total_count - dom)
  return (
    <div className="rounded-lg px-3 py-2.5" style={{ border: "1px solid var(--border)" }}>
      <div className="text-[10px] uppercase tracking-wide mb-2" style={{ color: "var(--text-muted)" }}>Evidence</div>
      <div role="img" aria-label={`${dom} of ${f.total_count} to ${f.suggested_account_name}, ${other} to ${f.posted_account_name} (this entry)`}
        className="flex rounded-md overflow-hidden" style={{ height: 34, border: "1px solid var(--border)" }}>
        <div style={{ flex: dom, background: "var(--green)", display: "flex", alignItems: "center", padding: "0 10px", minWidth: 0 }}>
          <span className="text-[11px] text-white truncate">{dom} → {f.suggested_account_name || "right account"}</span>
        </div>
        <div style={{ flex: other, background: "var(--surface-2)", display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}>
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: "#9b3d37" }} />
          <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>{other}</span>
        </div>
      </div>
      <div className="flex justify-end mt-0.5">
        <span className="text-[11px] inline-flex items-center gap-0.5" style={{ color: "#9b3d37" }}><ArrowDown size={11} strokeWidth={2.4} /> this one</span>
      </div>
      <div className="font-mono text-[12.5px] mt-1 text-theme">{f.dominant_count} of {f.total_count} transactions → {f.suggested_account_name || "right account"}</div>
      {f.confidence !== "high" && (
        <div className="text-[11px] mt-0.5" style={{ color: "var(--text-muted)" }}>Lower confidence — smaller or mixed sample. Open the entry and judge it yourself.</div>
      )}
    </div>
  )
}

// ── States ─────────────────────────────────────────────────────────────────

function ScanningCard() {
  return (
    <Card><div className="px-6 py-10 text-center">
      <div className="inline-flex items-center gap-2 mb-2"><Spinner className="h-5 w-5" />
        <span className="text-sm font-semibold text-theme">Reading vendor histories…</span></div>
      <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>Comparing this period's postings against each vendor's own history.</p>
    </div></Card>
  )
}

function AllClearTrophy({ total, reduce }: { total: number; reduce: boolean }) {
  return (
    <div className="text-center py-12">
      <motion.div initial={reduce ? false : { scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", duration: 0.6 }}
        className="h-[72px] w-[72px] rounded-full mx-auto flex items-center justify-center mb-4"
        style={{ background: "var(--green-subtle)" }}>
        <ShieldCheck size={34} strokeWidth={1.9} style={{ color: "var(--green)" }} />
      </motion.div>
      <h2 className="text-lg font-bold text-theme">Books look clean</h2>
      <p className="text-[13px] mt-1.5 mx-auto" style={{ color: "var(--text-muted)", maxWidth: 420 }}>
        We checked {total ? `all ${total.toLocaleString()} entries` : "every entry"} against each vendor's history. Nothing to reclassify.
      </p>
    </div>
  )
}

function FirstRun({ onRun, busy, hasPeriod }: { onRun: () => void; busy: boolean; hasPeriod: boolean }) {
  return (
    <Card><div className="px-6 py-12 text-center">
      <div className="h-12 w-12 rounded-xl mx-auto flex items-center justify-center mb-3" style={{ background: "var(--surface-2)" }}>
        <ShieldCheck size={24} strokeWidth={1.6} style={{ color: "var(--text-muted)" }} />
      </div>
      <p className="text-sm font-semibold text-theme mb-1">Nordavix hasn't audited this period yet</p>
      <p className="text-[12px] mx-auto mb-4" style={{ color: "var(--text-muted)", maxWidth: 440 }}>
        Run a check to compare every entry against its vendor's own posting history. We only compare a vendor's coding to its past — and never write to QuickBooks.
      </p>
      <Button size="sm" loading={busy} disabled={!hasPeriod} onClick={onRun} icon={<Sparkles size={14} strokeWidth={2} />}>
        Run accuracy check
      </Button>
    </div></Card>
  )
}

// ── Shell / Card ───────────────────────────────────────────────────────────

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col h-full overflow-y-auto" style={{ background: "var(--bg)" }}>
      <div className="flex-1 px-4 sm:px-8 py-5 max-w-[880px] w-full mx-auto">{children}</div>
    </div>
  )
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-2xl" style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
      {children}
    </section>
  )
}
