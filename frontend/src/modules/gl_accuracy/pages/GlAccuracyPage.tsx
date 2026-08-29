/**
 * GL Accuracy / Risk Radar — "Second Set of Eyes". Nordavix runs a catalog of
 * deterministic checks over the period — vendor coding vs. the client's own
 * history, missing recurring charges, duplicates, suspense / catch-all accounts
 * and balance-sheet sanity — each backed by a real tally you can audit at a
 * glance. Calm, trust-first: the hero is reassurance ("N look right"), red is one
 * static dot, the dollar stat is "to reclassify" (P&L-neutral). Accept files a
 * fix into Adjustments; Dismiss teaches it. Nothing is ever written to QuickBooks.
 */
import { useEffect, useState } from "react"
import { useOrganization } from "@clerk/clerk-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AnimatePresence, motion, useReducedMotion } from "framer-motion"
import { useNavigate } from "react-router-dom"
import {
  ShieldCheck, Sparkles, Brain, ArrowRight, ArrowUpRight, ArrowDown, ArrowLeft,
  Check, ThumbsUp, ChevronDown, ListChecks, ScanSearch, Settings, History, RefreshCw,
} from "lucide-react"
import { Button, Spinner } from "@/core/ui/components"
import { formatDate } from "@/core/lib/dates"
import { useSelectedPeriod } from "@/core/hooks/useSelectedPeriod"
import { closeApi } from "@/modules/close/api"
import { workspaceApi } from "@/modules/workspace/api"
import { ProposedEntryCard } from "@/modules/adjustments/components/ProposedEntryCard"
import { RelatedPanel } from "@/modules/graph/RelatedPanel"
import type { ProposedEntry } from "@/modules/adjustments/api"
import { glAccuracyApi, type GlFinding, type GlMonitoring } from "@/modules/gl_accuracy/api"
import { autopilotApi, type AutopilotState } from "@/modules/autopilot/api"

/** Turn the watching on, and choose when.
 *
 *  Deliberately three controls, not eight. Per-detector switches are the
 *  obvious design and the wrong one: nobody can predict which checks they need
 *  before seeing output, and people switch things off to silence noise and then
 *  blame the product for missing what it was told to ignore. Nordavix already
 *  learns from a rejection — dismissing a finding writes a vendor→account
 *  exception into Client Memory — so the tuning happens through use rather than
 *  a preferences panel nobody revisits.
 *
 *  The config is Autopilot's row (one automation config per workspace); this is
 *  just the surface for the part of it that belongs beside the findings. */
function ContinuousSettings() {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const { data: state } = useQuery({
    queryKey: ["autopilot"], queryFn: autopilotApi.getState, staleTime: 5 * 60_000,
  })
  const cfg = state?.config
  const [hour, setHour] = useState<number | null>(null)
  const [tz, setTz] = useState<string | null>(null)

  const effHour = hour ?? cfg?.check_hour ?? 9
  // The browser's own zone is the right default and almost always correct —
  // asking someone to pick their timezone from a list of 400 is a worse
  // first-run than getting it right and letting them correct it.
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  const effTz = tz ?? cfg?.timezone ?? browserTz

  // Defaults for a workspace that has never saved automation settings. The
  // config row is created on first PUT, so continuous close can be the thing
  // that creates it — requiring a trip through Autopilot first would hide this
  // feature behind an unrelated one.
  const base = cfg ?? {
    enabled: false, run_day: 1, run_flux: true, send_pbc_requests: false,
    pbc_recipient_email: null, run_review: true, attach_reports: false,
    continuous_enabled: false, check_hour: 9, timezone: null, updated_at: null,
  }

  const save = useMutation({
    mutationFn: async (patch: { on?: boolean; h?: number; z?: string }) => {
      // Re-read the config at call time rather than closing over the render's
      // copy. The toggle fires the moment the page settles, and a body built
      // from a snapshot taken before the GET resolved is how a first click
      // fails and an identical second click succeeds.
      const fresh = qc.getQueryData<AutopilotState>(["autopilot"])?.config ?? base
      return autopilotApi.saveConfig({
        ...fresh,
        continuous_enabled: patch.on ?? fresh.continuous_enabled ?? false,
        check_hour:         patch.h ?? (fresh.check_hour ?? effHour),
        timezone:           patch.z ?? (fresh.timezone ?? effTz),
      })
    },
    // Flip immediately and roll back if the server disagrees. A checkbox that
    // waits on a round trip before moving reads as broken even when it works.
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: ["autopilot"] })
      const prev = qc.getQueryData<AutopilotState>(["autopilot"])
      if (prev?.config && patch.on !== undefined) {
        qc.setQueryData(["autopilot"], {
          ...prev, config: { ...prev.config, continuous_enabled: patch.on },
        })
      }
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["autopilot"], ctx.prev)
    },
    onSuccess: (saved) => {
      qc.setQueryData(["autopilot"], (old: AutopilotState | undefined) =>
        old ? { ...old, config: saved } : old)
    },
  })

  /** The real reason, not "couldn't save that."
   *
   *  FastAPI returns a string `detail` for a raised HTTPException and a LIST of
   *  objects for a 422 validation error; rendering the list directly throws, and
   *  falling through to a generic string hides the only useful information on
   *  the screen. Both shapes are flattened, and the status is shown because
   *  "401" and "500" send you to completely different places. */
  function saveError(e: unknown): string | null {
    if (!e) return null
    const err = e as { response?: { status?: number; data?: { detail?: unknown } }; message?: string }
    const status = err.response?.status
    const detail = err.response?.data?.detail
    let text: string
    if (typeof detail === "string") text = detail
    else if (Array.isArray(detail)) {
      text = detail
        .map((d) => (d as { msg?: string })?.msg ?? JSON.stringify(d))
        .join("; ")
    } else if (err.message) text = err.message
    else text = "Couldn't save that."
    return status ? `${text} (HTTP ${status})` : text
  }

  // Wait for the query, but not for a row to exist.
  if (!state) return null
  const on = base.continuous_enabled

  return (
    <div className="mb-4">
      <button onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold transition-colors"
        style={{ color: "var(--text-muted)" }}>
        <Settings size={12} strokeWidth={2} />
        {on ? `Checking daily at ${String(effHour).padStart(2, "0")}:00` : "Set up daily checks"}
        <ChevronDown size={12} strokeWidth={2.2}
          style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform .15s ease" }} />
      </button>

      {open && (
        <div className="mt-2 rounded-xl p-3.5 space-y-3"
          style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input type="checkbox" checked={on} className="mt-0.5"
              onChange={(e) => save.mutate({ on: e.target.checked })} />
            <span className="min-w-0">
              <span className="block text-[13px] font-semibold text-theme">
                Check these books every day
              </span>
              <span className="block text-[11.5px]" style={{ color: "var(--text-muted)" }}>
                Nordavix runs the same checks once a day on the open period and tells
                you only when something new turns up. Nothing is written to QuickBooks.
              </span>
            </span>
          </label>

          {on && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
              <label className="block">
                <span className="block text-[10px] font-bold uppercase tracking-wider mb-1"
                  style={{ color: "var(--text-muted)" }}>Check at</span>
                <select value={effHour}
                  onChange={(e) => { const h = Number(e.target.value); setHour(h); save.mutate({ h }) }}
                  className="w-full rounded-lg px-2 py-1.5 text-[12.5px] outline-none"
                  style={{ background: "var(--surface-2)", border: "1px solid var(--border)", color: "var(--text)" }}>
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="block text-[10px] font-bold uppercase tracking-wider mb-1"
                  style={{ color: "var(--text-muted)" }}>Timezone</span>
                <input value={effTz}
                  onChange={(e) => setTz(e.target.value)}
                  onBlur={(e) => save.mutate({ z: e.target.value.trim() || browserTz })}
                  spellCheck={false}
                  className="w-full rounded-lg px-2 py-1.5 text-[12.5px] outline-none"
                  style={{ background: "var(--surface-2)", border: "1px solid var(--border)", color: "var(--text)" }} />
                <span className="block text-[10.5px] mt-1" style={{ color: "var(--text-muted)" }}>
                  Detected {browserTz}
                </span>
              </label>
            </div>
          )}

          {save.error ? (
            <p className="text-[11.5px]" style={{ color: "var(--danger)" }}>
              {saveError(save.error)}
            </p>
          ) : null}
        </div>
      )}
    </div>
  )
}

/** The continuous-close rail.
 *
 *  One card, stacked, laid out for 360px rather than a horizontal strip
 *  squeezed into it — the previous version wrapped its own status line onto
 *  three and read as an afterthought. Top to bottom: is it watching, when did
 *  it last look, what has it caught, and the schedule.
 */
function ContinuousRail({ m, scanning, recent, reduce, onOpen, periodEnd, onCheckNow, checking }: {
  m?: GlMonitoring; scanning: boolean; recent: GlFinding[]
  reduce: boolean; onOpen: (id: string) => void
  /** The CURRENT month. Everything in this rail is about the month happening
   *  now — never the period selected for the close. */
  periodEnd: string
  /** Run the watch's own check, against the current month. Separate from Risk
   *  Radar's Scan, which runs against the month being closed. */
  onCheckNow: () => void
  checking: boolean
}) {
  // Whether the daily watch is switched on — the dot only breathes when it is.
  const { data: autopilot } = useQuery({
    queryKey: ["autopilot"], queryFn: autopilotApi.getState, staleTime: 5 * 60_000,
  })
  const enabled = !!autopilot?.config?.continuous_enabled
  return (
    <motion.div layout={!reduce}
      transition={{ type: "spring", stiffness: 340, damping: 32 }}
      className="rounded-xl overflow-hidden"
      style={{ background: "var(--surface)", border: "1px solid var(--border)",
               boxShadow: "var(--card-shadow)" }}>
      {/* A slow breath, not a blink. 2.4s and a shallow opacity range: this is
          on screen all day next to money, so it has to read as "alive" from
          the corner of the eye and never compete with a figure. */}
      <style>{"@keyframes ndvx-beat{0%,100%{transform:scale(1);opacity:.45}50%{transform:scale(2.1);opacity:0}}"}</style>
      <MonitoringHead m={m} scanning={scanning} enabled={enabled} reduce={reduce}
        periodEnd={periodEnd} onCheckNow={onCheckNow} checking={checking} />
      <RecentlyCaught recent={recent} reduce={reduce} onOpen={onOpen} />
      <div className="px-4 py-3" style={{ borderTop: "1px solid var(--border)" }}>
        <ContinuousSettings />
      </div>
    </motion.div>
  )
}

/** "2026-08-31" → "Aug". Same hand-split reason as monthLabel. */
function shortMonth(iso: string): string {
  const m = iso.split("-")[1]
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                 "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  return names[Number(m) - 1] ?? iso
}

/** "2026-08-31" → "August 2026". Split by hand: `new Date(iso)` reads a bare
 *  YYYY-MM-DD as UTC midnight, which is the previous month west of Greenwich. */
function monthLabel(iso: string): string {
  const [y, m] = iso.split("-")
  const names = ["January", "February", "March", "April", "May", "June",
                 "July", "August", "September", "October", "November", "December"]
  return `${names[Number(m) - 1] ?? m} ${y}`
}

/** Whether the books are being watched, and the proof.
 *
 *  The honest form of "real-time monitoring": a clock the reader can check
 *  beats an adjective they have to trust, and it survives a partner asking how
 *  it works. Shown in every state, including the clean one — "we looked and
 *  nothing is wrong" only reassures if something says it.
 *
 *  A scan that crashed or is still running NEVER reads as a clean bill of
 *  health. Findings mean nothing until the check has finished.
 */
function MonitoringHead({ m, scanning, enabled, reduce, periodEnd, onCheckNow, checking }: {
  m?: GlMonitoring; scanning: boolean; enabled: boolean; reduce: boolean
  periodEnd: string; onCheckNow: () => void; checking: boolean
}) {
  // Re-render on a timer so "12 minutes ago" stays true between refetches. A
  // stale clock is worse than no clock.
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 30_000)
    return () => clearInterval(id)
  }, [])

  if (!m || !m.ever_scanned) {
    return (
      <div className="px-4 py-3.5" style={{ borderBottom: "1px solid var(--border)" }}>
        <div className="flex items-center gap-2 mb-1">
          <ScanSearch size={14} strokeWidth={1.9} style={{ color: "var(--text-muted)" }} />
          <span className="text-[12.5px] font-semibold text-theme">Continuous close</span>
        </div>
        <p className="text-[11.5px]" style={{ color: "var(--text-muted)" }}>
          Not watching <span className="text-theme font-medium">{monthLabel(periodEnd)}</span> yet.
          Turn it on below and Nordavix checks these books every day.
        </p>
        {/* Without this the first proof it works is tomorrow morning. */}
        <button onClick={onCheckNow} disabled={checking}
          className="mt-2 inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold transition-colors hover:bg-[var(--surface-2)] disabled:opacity-50"
          style={{ color: "var(--text-2)", border: "1px solid var(--border)" }}>
          {checking ? <Spinner className="h-3 w-3" /> : <RefreshCw size={11} strokeWidth={2.2} />}
          Check {shortMonth(periodEnd)} now
        </button>
      </div>
    )
  }

  const inFlight = scanning || (m.ok == null && !m.checked_at)
  const failed = m.ok === false
  const ago = agoLabel(m.checked_at)
  const dotColor = failed ? "var(--warn)" : "var(--green)"
  // Alive while WATCHING, not only while a scan is in flight. A scan takes
  // seconds a day; the other 86,000 the dot was static and the feature looked
  // switched off. Slow and low-contrast on purpose — this sits on screen all
  // day beside financial data and must never pull the eye off a number.
  const beating = enabled && !failed && !inFlight

  return (
    <div className="px-4 py-3.5" style={{ borderBottom: "1px solid var(--border)" }}>
      <div className="flex items-center gap-2">
        <span className="relative inline-flex h-2 w-2">
          {/* A scan in flight pings fast; a live watch breathes. Both are
              suppressed under prefers-reduced-motion — the colour and the label
              already carry the state, the movement is decoration. */}
          {inFlight && !reduce && (
            <span className="absolute inline-flex h-full w-full rounded-full animate-ping"
              style={{ background: dotColor, opacity: 0.6 }} />
          )}
          {beating && !reduce && (
            <span className="absolute inline-flex h-full w-full rounded-full"
              style={{ background: dotColor, animation: "ndvx-beat 2.4s ease-in-out infinite" }} />
          )}
          <span className="relative inline-flex rounded-full h-2 w-2" style={{ background: dotColor }} />
        </span>
        <span className="text-[12.5px] font-semibold text-theme">
          {inFlight ? "Checking now" : failed ? "Last check didn't finish"
            : enabled ? "Continuous close · on" : "Continuous close"}
        </span>
        {!!m.new_last_check && !inFlight && !failed && (
          <span className="ml-auto inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide"
            style={{ background: "var(--green-subtle)", color: "var(--green)",
                     border: "1px solid var(--green)" }}>
            {m.new_last_check} new
          </span>
        )}
        {/* The watch's OWN check, against the current month. Separate from Risk
            Radar's Scan, which runs on the month being closed — one button for
            two different periods was the whole confusion. */}
        <button onClick={onCheckNow} disabled={checking || inFlight}
          title={`Check ${monthLabel(periodEnd)} now`}
          className={`${m.new_last_check ? "" : "ml-auto"} inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] font-semibold transition-colors hover:bg-[var(--surface-2)] disabled:opacity-50`}
          style={{ color: "var(--text-muted)", border: "1px solid var(--border)" }}>
          {checking || inFlight
            ? <Spinner className="h-2.5 w-2.5" />
            : <RefreshCw size={10} strokeWidth={2.2} />}
          Check now
        </button>
      </div>

      {/* WHICH MONTH. Every number under this line is scoped to one period,
          and the rail used to imply that and never say it — "checks this
          period" reads as a fact about a month you have to guess. */}
      <p className="text-[11px] mt-0.5" style={{ color: "var(--text-muted)" }}>
        {inFlight ? "Reading " : failed ? "Was reading " : "Tracking "}
        <span className="text-theme font-medium">{monthLabel(periodEnd)}</span>
        {/* "the month in progress" means the CLOSE in progress — the other
            feature's month. This one is today's real month, whatever period
            the close happens to be on, so say exactly that. */}
        <span> · live, today&apos;s month</span>
      </p>

      {failed ? (
        <p className="text-[11.5px] mt-1.5" style={{ color: "var(--warn)" }}>
          {m.error || "The scan stopped before it finished — findings may be incomplete."}
        </p>
      ) : inFlight ? (
        <p className="text-[11.5px] mt-1.5" style={{ color: "var(--text-muted)" }}>
          Reading this period's ledger…
        </p>
      ) : (
        /* One fact per line. The rail has 360px, not a banner's width, and a
           status that wraps mid-sentence reads as broken. */
        <dl className="mt-2 space-y-1">
          <Stat label="Last checked" value={ago ?? "—"} strong />
          {!!m.transactions_reviewed && (
            <Stat label="Transactions reviewed" value={m.transactions_reviewed.toLocaleString()} />
          )}
          {m.checks_this_period > 0 && (
            <Stat label={`Checks in ${shortMonth(periodEnd)}`}
              value={String(m.checks_this_period)} />
          )}
        </dl>
      )}
    </div>
  )
}

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[11.5px] truncate" style={{ color: "var(--text-muted)" }}>{label}</dt>
      <dd className={`text-[11.5px] tabular-nums shrink-0 ${strong ? "font-semibold" : ""}`}
        style={{ color: strong ? "var(--text)" : "var(--text-2)" }}>{value}</dd>
    </div>
  )
}

/** What the watch has turned up, newest first.
 *
 *  Ordered by first_seen_at — when Nordavix FIRST saw it, which survives the
 *  re-scan that replaces open findings on every run. created_at would claim
 *  everything arrived at the last scan and the whole pane would read as noise.
 */
function RecentlyCaught({ recent, reduce, onOpen }: {
  recent: GlFinding[]; reduce: boolean; onOpen: (id: string) => void
}) {
  return (
    <div>
      <div className="px-4 pt-3 pb-1.5 flex items-center gap-2">
        <History size={13} strokeWidth={1.9} style={{ color: "var(--text-muted)" }} />
        <h2 className="text-[10px] font-bold uppercase tracking-wider"
          style={{ color: "var(--text-muted)" }}>Recently caught</h2>
      </div>

      {recent.length === 0 ? (
        <p className="px-4 pb-3 text-[11.5px]" style={{ color: "var(--text-muted)" }}>
          Nothing caught yet for this period.
        </p>
      ) : (
        <ul className="pb-1">
          <AnimatePresence initial={false}>
            {recent.map((f, i) => {
              const when = agoLabel(f.first_seen_at)
              const dot = f.severity === "high" ? "var(--green)"
                : f.severity === "low" ? "var(--text-muted)" : "#8a6326"
              return (
                <motion.li key={f.id} layout={!reduce}
                  initial={reduce ? false : { opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduce ? undefined : { opacity: 0, height: 0 }}
                  transition={{ duration: 0.18, delay: reduce ? 0 : Math.min(i, 5) * 0.02 }}>
                  <button onClick={() => onOpen(f.id)}
                    className="w-full flex items-start gap-2 px-4 py-1.5 text-left transition-colors hover:bg-[var(--surface-2)]">
                    <span className="h-1.5 w-1.5 rounded-full shrink-0 mt-1.5"
                      style={{ background: dot }} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[12px] text-theme leading-snug line-clamp-2">
                        {f.title}
                      </span>
                      <span className="block text-[10.5px] mt-0.5" style={{ color: "var(--text-muted)" }}>
                        {/* When Nordavix first saw it — the time-to-detection
                            story, and the reason first_seen_at exists. */}
                        {when ? `${when} · ` : ""}{f.vendor}
                      </span>
                    </span>
                  </button>
                </motion.li>
              )
            })}
          </AnimatePresence>
        </ul>
      )}
    </div>
  )
}

/** "12 minutes ago" from an ISO stamp. Coarse on purpose: a clock that claims
 *  seconds invites someone to check it against theirs. */
function agoLabel(iso?: string | null): string | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  const mins = Math.floor((Date.now() - t) / 60000)
  if (mins < 1)  return "just now"
  if (mins === 1) return "1 minute ago"
  if (mins < 60) return `${mins} minutes ago`
  const hrs = Math.round(mins / 60)
  if (hrs === 1) return "1 hour ago"
  if (hrs < 24) return `${hrs} hours ago`
  const days = Math.round(hrs / 24)
  return days === 1 ? "yesterday" : `${days} days ago`
}

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

// The accrual preview for a missing recurring item — Dr the expense account the
// vendor usually hits, Cr an accrued-liability placeholder the preparer picks in
// Adjustments. A faithful mirror of the server's build_accrual_entry.
function accrualPreview(f: GlFinding): ProposedEntry {
  const amt = Math.abs(Number(f.amount) || 0).toFixed(2)
  const expense = { account_qbo_id: f.suggested_account_id, account_number: null, account_name: f.suggested_account_name || "Expense account" }
  const accrued = { account_qbo_id: null, account_number: null, account_name: "Accrued liabilities (select account)" }
  return {
    id: `preview-${f.id}`, source: "gl_accuracy", source_ref: f.id, period_end: f.period_end,
    description: `Accrue ${f.vendor} — recurring ${f.suggested_account_name || "expense"} missing this period`,
    lines: [{ ...expense, debit: amt, credit: "0.00" }, { ...accrued, debit: "0.00", credit: amt }],
    memo: null, confidence: f.severity, status: "open", saved_at: null,
    rationale: `${f.vendor} recurs in most recent months (~${amt}) but has no entry this period; accrue the expected charge. Choose the accrued-liability account before posting.`,
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

  // The month continuous close tracks. Comes from the server so the client's
  // clock can't disagree with the sweep's about which month is "current".
  const monitoringPeriod = data?.monitoring_period ?? activePeriod

  // Continuous close's own check, against the CURRENT month — distinct from
  // Risk Radar's Scan below, which runs on the period being closed. Same
  // endpoint, deliberately different period.
  const watchMut = useMutation({
    mutationFn: () => glAccuracyApi.scan(monitoringPeriod),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["gl-accuracy", "findings", activePeriod] })
    },
  })

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
  const high = open.filter((f) => f.severity === "high").length
  const medium = open.length - high
  const dollars = open.filter((f) => f.action_kind !== "flag").reduce((s, f) => s + Math.abs(Number(f.amount) || 0), 0)
  const shown = items.filter((f) => filter === "all" || (f.status === "open" && f.severity === filter))

  // Declared after `items` on purpose: it reads it, and a const cannot be read
  // above its own declaration — the build catches that, the browser would not
  // until the page rendered.
  // The eight most recently first-seen findings drive the "Recently caught"
  // pane. first_seen_at, not created_at — the scan replaces open findings on
  // every run, so created_at would say everything arrived at the last scan.
  const recentlyCaught = [...items]
    .filter((f) => f.first_seen_at)
    .sort((a, b) => (b.first_seen_at ?? "").localeCompare(a.first_seen_at ?? ""))
    .slice(0, 8)
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
  const selectHigh = () => setSelected(new Set(open.filter((f) => f.severity === "high" && f.action_kind !== "flag").map((f) => f.id)))

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
            <h1 className="text-lg font-bold text-theme leading-tight">Risk Radar</h1>
            <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
              {/* WHICH MONTH. Risk Radar checks the month being CLOSED — the one
                  in the picker. Continuous close, in the rail, tracks the month
                  in progress. Two features, two months; naming both is the only
                  way the page stops being ambiguous. */}
              Checking <span className="text-theme font-semibold">{activePeriod ? monthLabel(activePeriod) : "—"}</span>
              <span> · the close in progress</span>
              {scanned?.period === activePeriod
                ? <> · swept <span className="text-theme font-semibold">{scanned.total.toLocaleString()} entries</span> and your full chart of accounts.</>
                : <>. Deterministic, evidence-first, and never writes to QuickBooks.</>}
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
            {data && items.length > 0
              ? `Re-check ${activePeriod ? shortMonth(activePeriod) : ""}`.trim()
              : `Check ${activePeriod ? shortMonth(activePeriod) : ""}`.trim()}
          </Button>
        </div>
      </div>

      {err && (
        <div className="rounded-xl px-4 py-3 text-[12px] mb-4"
          style={{ background: "var(--danger-subtle)", color: "var(--danger)", border: "1px solid var(--danger-border)" }}>
          {err} <span style={{ color: "var(--text-muted)" }}>Retry when ready.</span>
        </div>
      )}

      {/* Page split. LEFT is this month's GL accuracy review — the working
          surface, and it gets the room. RIGHT is the continuous-close rail:
          is it watching, when did it last look, what has it caught. Two
          questions that belong side by side and not stacked, because the
          answer to the second is what makes you trust the first.

          The rail sticks while the findings list scrolls, so the live clock
          stays on screen through a long review. Below xl it drops underneath
          — a 360px rail beside a findings list needs a desk, not a phone. */}
      <div className="flex flex-col xl:flex-row gap-5 items-start">
      <div className="flex-1 min-w-0 w-full">

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
            /* The findings list, with rows springing in and leaving to the
               left so accepting one reads as the item departing rather than
               the list snapping shut. */
            <div className="space-y-2">
              <AnimatePresence initial={false}>
                {shown.map((f) => (
                  <motion.div key={f.id} layout={!reduce}
                    initial={reduce ? false : { opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={reduce ? undefined : { opacity: 0, x: -12, height: 0, marginBottom: 0 }}
                    transition={{ duration: 0.18 }}>
                    <FindingCard f={f} open={openId === f.id} canReview={canReview} reduce={reduce}
                      selectable checked={selected.has(f.id)} onCheck={() => toggleSelect(f.id)}
                      onToggle={() => setOpenId(openId === f.id ? null : f.id)}
                      onChanged={() => qc.invalidateQueries({ queryKey: ["gl-accuracy", "findings", activePeriod] })}
                      onGoAdjustments={() => navigate("/app/adjustments")} />
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          )}
        </>
      )}

      </div>

      <aside className="w-full xl:w-[360px] xl:shrink-0 xl:sticky xl:top-5 space-y-3">
        <ContinuousRail m={data?.monitoring} scanning={false}
          recent={recentlyCaught} reduce={reduce} onOpen={(id) => setOpenId(id)}
          periodEnd={monitoringPeriod}
          onCheckNow={() => watchMut.mutate()} checking={watchMut.isPending} />
      </aside>
      </div>
    </Shell>
  )
}

// ── Finding card (collapsed row + expanded review) ─────────────────────────

function FindingCard({ f, open, active, canReview, reduce, selectable, checked, onCheck, onToggle, onChanged, onGoAdjustments }: {
  f: GlFinding; open: boolean; canReview: boolean; reduce: boolean
  /** Selected in the left column while its detail shows on the right. Marks the
   *  row without expanding it — in split view the body lives in the other pane. */
  active?: boolean
  selectable?: boolean; checked?: boolean; onCheck?: () => void
  onToggle: () => void; onChanged: () => void; onGoAdjustments: () => void
}) {
  const qc = useQueryClient()
  const isOpen = f.status === "open"
  const isMisc = f.kind === "misclassification"
  const isFlag = f.action_kind === "flag"   // review-only: acknowledge, not a JE
  const dot = f.severity === "high" ? "var(--green)" : f.severity === "low" ? "var(--text-muted)" : "#8a6326"
  // In split view the row is selected but not expanded — its body is in the
  // other pane. A left rule and a lifted surface say "this is the one you're
  // reading" without duplicating the content.
  const selectedStyle = active
    ? { background: "var(--surface)", borderColor: "var(--green)",
        boxShadow: "var(--card-shadow)" }
    : undefined

  const acceptMut = useMutation({
    mutationFn: () => glAccuracyApi.accept(f.id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["adjustments"] }); onChanged() },
  })
  const ackMut = useMutation({
    mutationFn: () => glAccuracyApi.acknowledge(f.id),
    onSuccess: onChanged,
  })
  const dismissMut = useMutation({
    mutationFn: () => glAccuracyApi.dismiss(f.id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["memory", "account-context"] }); onChanged() },
  })
  const busy = acceptMut.isPending || dismissMut.isPending || ackMut.isPending

  const statusChip =
    f.status === "in_adjustments" ? { label: "In Adjustments", bg: "var(--green-subtle)", color: "var(--green)" }
    : f.status === "dismissed" ? { label: "Confirmed correct", bg: "var(--surface-2)", color: "var(--text-muted)" }
    : f.status === "acknowledged" ? { label: "Reviewed", bg: "var(--surface-2)", color: "var(--text-muted)" }
    : null

  return (
    <div className="rounded-xl overflow-hidden transition-colors"
      style={{ background: "var(--surface)",
               border: `1px solid ${open || active ? "var(--green)" : "var(--border)"}`,
               // A left rule marks the row being read in the other pane —
               // present enough to find at a glance, quiet enough not to
               // compete with the detail itself.
               borderLeftWidth: active ? 3 : 1,
               boxShadow: "var(--card-shadow)", opacity: isOpen ? 1 : 0.72,
               ...(selectedStyle ?? {}) }}>
      <div onClick={onToggle} className="flex items-center gap-2.5 px-3.5 py-3 cursor-pointer">
        {selectable && isOpen && !isFlag && (
          <input type="checkbox" checked={!!checked}
            onClick={(e) => e.stopPropagation()} onChange={onCheck}
            className="shrink-0 h-3.5 w-3.5 cursor-pointer" style={{ accentColor: "var(--green)" }}
            aria-label={`Select ${f.vendor} for bulk accept`} />
        )}
        <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: dot }} title={f.severity === "high" ? "High severity" : f.severity === "low" ? "Low severity" : "Medium severity"} />
        <span className="text-sm font-semibold text-theme shrink-0" style={{ minWidth: 72 }}>{f.vendor}</span>
        {isMisc ? (
          <span className="text-[12px] flex-1 min-w-0 truncate" style={{ color: "var(--text-muted)" }}>
            <span style={{ textDecoration: "line-through" }}>{f.posted_account_name || "—"}</span>{" "}
            <ArrowRight size={12} strokeWidth={2} style={{ display: "inline", verticalAlign: "-2px" }} />{" "}
            <span className="text-theme">{f.suggested_account_name || "—"}</span>
          </span>
        ) : (
          <span className="text-[12px] flex-1 min-w-0 truncate text-theme">{f.title}</span>
        )}
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
                  {[f.txn_type, f.txn_number ? `#${f.txn_number}` : null, f.txn_date ? formatDate(f.txn_date) : null].filter(Boolean).join(" · ") || f.vendor}
                  {f.memo ? <span style={{ color: "var(--text-muted)" }}> · {f.memo}</span> : null}
                </div>
                {f.posted_account_id && (
                  <div className="text-[12px] mt-0.5">Booked to <span style={{ color: "#9b3d37" }}>{f.posted_account_name || f.posted_account_id}</span> · <span className="tabular-nums">{fmtUsd(f.amount)}</span></div>
                )}
              </div>

              {/* Zone 2 + 3 — evidence + why. Misclassification shows the auditable
                  tally; other detectors show their plain-English detail. */}
              {isMisc ? (
                <>
                  <EvidenceBar f={f} />
                  <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                    Statistical pattern, not a prediction — {Math.round((f.dominant_count / Math.max(1, f.total_count)) * 100)}% of this vendor's spend goes there. Nordavix never writes to QuickBooks.
                  </p>
                </>
              ) : (
                f.detail && <p className="text-[12.5px] text-theme">{f.detail}</p>
              )}

              {/* Zone 4 — the fix + actions, OR the resolved receipt */}
              {isOpen ? (
                isFlag ? (
                  <div className="flex items-center gap-2 pt-0.5">
                    <button onClick={() => ackMut.mutate()} disabled={busy}
                      className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-bold text-white disabled:opacity-50"
                      style={{ background: "var(--green)" }}>
                      {ackMut.isPending ? <Spinner className="h-3.5 w-3.5" /> : <Check size={13} strokeWidth={2.6} />}
                      Mark reviewed
                    </button>
                    {canReview && (
                      <button onClick={() => dismissMut.mutate()} disabled={busy}
                        className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-semibold disabled:opacity-50"
                        style={{ border: "1px solid var(--border-strong)", color: "var(--text-2)" }}>
                        <ThumbsUp size={13} strokeWidth={2} /> Not an issue
                      </button>
                    )}
                  </div>
                ) : (
                  <>
                    {isMisc && <ProposedEntryCard entry={reclassPreview(f)} preview />}
                    {f.action_kind === "accrual" && <ProposedEntryCard entry={accrualPreview(f)} preview />}
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
                )
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
                  <p className="text-[12px] text-theme">{isMisc
                    ? <>What Nordavix knows — <span style={{ color: "var(--text-muted)" }}>{f.vendor} → {f.posted_account_name || f.posted_account_id} is correct. I won't flag this pairing again.</span></>
                    : <span style={{ color: "var(--text-muted)" }}>{f.status === "acknowledged" ? "Reviewed and handled." : "Marked not an issue."}</span>}
                  </p>
                </div>
              )}
              {f.finding_key && (
                <div style={{ borderTop: "1px solid var(--border)", marginTop: 6, paddingTop: 12 }}>
                  <RelatedPanel nodeType="finding" nodeId={f.finding_key} periodEnd={f.period_end} />
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
        <span className="text-sm font-semibold text-theme">Running the full risk sweep…</span></div>
      <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>Checking vendor coding, recurring charges, duplicates, suspense accounts and balance-sheet sanity.</p>
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
        We ran every Risk Radar check — vendor coding, duplicates, missing accruals, suspense accounts and balance-sheet sanity — across {total ? `all ${total.toLocaleString()} entries` : "every entry"} and your full chart of accounts. Nothing needs attention.
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
        Run a sweep: Nordavix checks vendor coding, recurring charges, duplicates, suspense / catch-all accounts and balance-sheet sanity across this period and your full chart of accounts. It only reads — never writes to QuickBooks.
      </p>
      <Button size="sm" loading={busy} disabled={!hasPeriod} onClick={onRun} icon={<Sparkles size={14} strokeWidth={2} />}>
        Run accuracy check
      </Button>
    </div></Card>
  )
}

// ── Shell / Card ───────────────────────────────────────────────────────────

function Shell({ children }: { children: React.ReactNode }) {
  // 880px was right for one reading column and is not enough for a column plus
  // a rail — it left the rail wrapping its own status line onto three. The page
  // has two things to show at once now, so it takes the width to show them.
  return (
    <div className="flex flex-col h-full overflow-y-auto" style={{ background: "var(--bg)" }}>
      <div className="flex-1 px-4 sm:px-8 py-5 max-w-[880px] xl:max-w-[1420px] w-full mx-auto">
        {children}
      </div>
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
