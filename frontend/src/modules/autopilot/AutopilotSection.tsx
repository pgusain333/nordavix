/**
 * Close Autopilot — the "wow" agentic setting.
 *
 * One screen, three moments:
 *   1. HERO        — Autopilot's live state (on/off, next run, "Run now"),
 *                    a pine band that reads like the product's flagship.
 *   2. SETUP       — the one-time configuration. Master switch, the day of
 *                    the month it runs, flux on/off, and the DELIBERATE
 *                    client-evidence-email question (default OFF — the firm
 *                    often already has the statements, so we never email a
 *                    client unless the admin explicitly turns it on and
 *                    supplies an address).
 *   3. HISTORY     — a timeline of recent runs with per-step results.
 *
 * Config + "Run now" are admin-only (matches the backend's require_role).
 * While a run is in flight the GET endpoint reports running=true, which
 * drives a live banner + 2.5s polling so the timeline fills in by itself.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { useOrganization } from "@clerk/clerk-react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { motion, AnimatePresence, useReducedMotion } from "framer-motion"
import {
  Rocket, Sparkles, RefreshCw, TrendingUp, Mail, Send,
  CheckCircle2, AlertTriangle, ShieldCheck, Clock, Play, Zap, Bot,
  type LucideIcon,
} from "lucide-react"
import { Spinner } from "@/core/ui/components"
import { workspaceApi, hasPower } from "@/modules/workspace/api"
import { useQboConnection } from "@/modules/flux/hooks"
import {
  autopilotApi, type AutopilotRun, type AutopilotRunResults, type AutopilotState,
} from "@/modules/autopilot/api"

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"]
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}

function fmtRunTime(iso: string | null): string {
  if (!iso) return "—"
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    })
  } catch {
    return "—"
  }
}

// ── Root ─────────────────────────────────────────────────────────────────────

export function AutopilotSection() {
  const { organization } = useOrganization()
  const qc = useQueryClient()
  const reduce = useReducedMotion()

  // Form + UI state — declared BEFORE the queries on purpose. The autopilot
  // query's refetchInterval closure reads `pollUntil`, and React Query can
  // evaluate that closure during query setup (synchronously, this render), so
  // the binding must already exist — otherwise it's a temporal-dead-zone crash
  // ("Cannot access 'pollUntil' before initialization") on every render.
  const [enabled, setEnabled]   = useState(false)
  const [runDay,  setRunDay]    = useState(1)
  const [runFlux, setRunFlux]   = useState(true)
  const [runReview, setRunReview]     = useState(true)
  const [attachReports, setAttachReports] = useState(false)
  const [sendPbc, setSendPbc]   = useState(false)
  const [pbcEmail, setPbcEmail] = useState("")
  const [savedAt, setSavedAt]   = useState<number | null>(null)
  const [formErr, setFormErr]   = useState<string | null>(null)
  const [runErr,  setRunErr]    = useState<string | null>(null)
  // Bridges the window between "Run now" returning and the background task
  // inserting the running row, so the live poll starts even before the GET
  // reports running=true. Epoch-ms; polling stays on while now < pollUntil.
  const [pollUntil, setPollUntil] = useState(0)

  const { data: me } = useQuery({
    queryKey: ["workspace-me"],
    queryFn:  workspaceApi.getMe,
    staleTime: 10 * 60_000,
    enabled:  !!organization,
  })
  // Admins, or anyone an admin has granted the "Run Close Autopilot" power,
  // can configure + run it. (Name kept as isAdmin since that's what the
  // controls below gate on — it now means "can operate autopilot".)
  const isAdmin = me?.role === "admin" || hasPower(me, "autopilot")

  // A run starts by syncing the period from QuickBooks, so it can't run until
  // QBO is connected. We gate the "Run now" button on this (the backend also
  // enforces it — this just makes the requirement visible instead of a failed
  // run). Treat "still loading" as connected so we never flash a false block.
  const { data: qbo, isLoading: qboLoading } = useQboConnection()
  const qboConnected = qboLoading || !!qbo

  const { data: state, isLoading, isError } = useQuery({
    queryKey: ["autopilot"],
    queryFn:  autopilotApi.getState,
    enabled:  !!organization,
    // Poll while a run is in flight (or during the post-trigger bridge) so the
    // timeline fills in live.
    refetchInterval: (q) => ((q.state.data?.running || pollUntil > Date.now()) ? 2500 : false),
  })

  // Saved config from the server (drives the form seed below).
  const cfg = state?.config

  const dirty = useMemo(() => {
    if (!cfg) return enabled || sendPbc || runFlux !== true || runReview !== true || attachReports || runDay !== 1 || pbcEmail !== ""
    return (
      enabled !== cfg.enabled ||
      runDay !== cfg.run_day ||
      runFlux !== cfg.run_flux ||
      runReview !== cfg.run_review ||
      attachReports !== cfg.attach_reports ||
      sendPbc !== cfg.send_pbc_requests ||
      pbcEmail.trim() !== (cfg.pbc_recipient_email ?? "")
    )
  }, [cfg, enabled, runDay, runFlux, runReview, attachReports, sendPbc, pbcEmail])

  // Seed the form from the saved config. First appearance always seeds; after
  // that we only adopt a NEW server version when the form has no unsaved edits,
  // so neither the 2.5s poll nor a concurrent edit in another tab can silently
  // wipe what this admin is typing.
  const seededRef = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    if (!cfg) return
    const stamp = cfg.updated_at
    if (seededRef.current === undefined || (!dirty && stamp !== seededRef.current)) {
      setEnabled(cfg.enabled)
      setRunDay(cfg.run_day)
      setRunFlux(cfg.run_flux)
      setRunReview(cfg.run_review)
      setAttachReports(cfg.attach_reports)
      setSendPbc(cfg.send_pbc_requests)
      setPbcEmail(cfg.pbc_recipient_email ?? "")
      seededRef.current = stamp
    }
  }, [cfg, dirty])

  useEffect(() => {
    if (!savedAt) return
    const t = setTimeout(() => setSavedAt(null), 2500)
    return () => clearTimeout(t)
  }, [savedAt])

  // Once the GET reports a live run, the running flag drives polling — clear
  // the bridge so a finished run never lingers as "Starting…".
  useEffect(() => {
    if (state?.running) setPollUntil(0)
  }, [state?.running])

  const save = useMutation({
    mutationFn: () =>
      autopilotApi.saveConfig({
        enabled,
        run_day: runDay,
        run_flux: runFlux,
        run_review: runReview,
        attach_reports: attachReports,
        send_pbc_requests: sendPbc,
        pbc_recipient_email: sendPbc ? pbcEmail.trim() : null,
      }),
    onSuccess: (saved) => {
      // A config save doesn't change runs/next_period/running, so the snappy
      // cache merge is authoritative — no extra round-trip needed.
      qc.setQueryData(["autopilot"], (old: AutopilotState | undefined) =>
        old ? { ...old, config: saved } : old,
      )
      setSavedAt(Date.now())
    },
    onError: (e: unknown) => {
      const ax = e as { response?: { data?: { detail?: string } } }
      setFormErr(ax?.response?.data?.detail ?? "Could not save. Try again?")
    },
  })

  const run = useMutation({
    mutationFn: autopilotApi.runNow,
    onSuccess: () => {
      setRunErr(null)
      setPollUntil(Date.now() + 30_000)  // bridge until the running row appears
      qc.invalidateQueries({ queryKey: ["autopilot"] })
    },
    onError: (e: unknown) => {
      const ax = e as { response?: { data?: { detail?: string } } }
      setRunErr(ax?.response?.data?.detail ?? "Could not start a run.")
    },
  })

  function handleSave() {
    setFormErr(null)
    if (sendPbc && !pbcEmail.trim()) {
      setFormErr("Add the client's email address to enable automatic evidence requests.")
      return
    }
    save.mutate()
  }

  if (!organization) {
    return (
      <Card>
        <div className="p-6">
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>
            Select a workspace to set up Close Autopilot.
          </p>
        </div>
      </Card>
    )
  }
  // Only block on the very first load (no data yet AND not errored). If the
  // request fails, fall through and render the setup UI with an inline notice
  // rather than hanging on a spinner.
  if (isLoading && !state && !isError) {
    return (
      <Card>
        <div className="p-6 flex items-center gap-3">
          <Spinner className="h-5 w-5" />
          <span className="text-sm" style={{ color: "var(--text-muted)" }}>Loading Close Autopilot…</span>
        </div>
      </Card>
    )
  }

  const running = !!state?.running
  // True from clicking "Run now" until the GET first reports the running row.
  const starting = run.isPending || (!running && pollUntil > Date.now())
  const isOn = !!cfg?.enabled
  const nextLabel = state?.next_period_label ?? null
  const lastRun = state?.runs?.[0] ?? null

  return (
    <div className="space-y-5">
      {isError && (
        <div className="rounded-xl px-4 py-3 text-[12px] flex items-start gap-2"
          style={{ background: "var(--warn-subtle)", color: "var(--warn)", border: "1px solid var(--warn-border)" }}>
          <AlertTriangle size={14} strokeWidth={2} className="mt-0.5 shrink-0" />
          <span>
            Couldn't load your saved Autopilot settings — the Autopilot service may still be
            finishing its deploy (database migration <strong>045</strong>). You can review the setup
            below; once the service is reachable, your saved configuration and run history will appear.
          </span>
        </div>
      )}

      {/* ── 1 · HEADER — compact, light module bar (matches other modules) ── */}
      <div className="rounded-2xl"
        style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
        <div className="p-4 sm:p-5">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="flex items-start gap-3 min-w-0">
              <span className="h-9 w-9 rounded-lg flex items-center justify-center shrink-0"
                style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
                <Rocket size={17} strokeWidth={1.8} />
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-base sm:text-lg font-bold leading-tight text-theme">Close Autopilot</h2>
                  <StatusPill on={isOn} running={running} />
                </div>
                <p className="text-[12px] mt-1 leading-relaxed max-w-xl" style={{ color: "var(--text-muted)" }}>
                  {running
                    ? "Running your close right now — syncing, preparing, and analysing. A digest lands the moment it finishes."
                    : isOn
                      ? <>Each month Autopilot syncs QuickBooks, prepares every reconciliation, runs flux{cfg?.send_pbc_requests ? ", emails your client for missing statements," : ""} and sends you a digest — unattended.</>
                      : "Turn one switch on and your month-end close runs itself — sync, AI preparation, flux, and a digest in your inbox. Set it up once below."}
                </p>
              </div>
            </div>

            {/* Run now — disabled until QuickBooks is connected (a run begins by
                syncing the period from QBO). */}
            {isAdmin && (
              <button
                onClick={() => run.mutate()}
                disabled={running || starting || !qboConnected}
                title={!qboConnected ? "Connect QuickBooks first — Autopilot syncs the period from QBO." : undefined}
                className="shrink-0 inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-[13px] font-bold transition-all disabled:cursor-not-allowed"
                style={{
                  background: (running || starting || !qboConnected) ? "var(--surface-2)" : "var(--green)",
                  color: (running || starting || !qboConnected) ? "var(--text-muted)" : "#fff",
                  border: (running || starting || !qboConnected) ? "1px solid var(--border)" : "1px solid transparent",
                }}
              >
                {(running || starting) ? <Spinner className="h-4 w-4" /> : <Play size={14} strokeWidth={2.4} />}
                {running ? "Running…" : starting ? "Starting…" : "Run now"}
              </button>
            )}
          </div>

          {/* live status strip */}
          <div className="mt-3.5 flex items-center gap-x-4 gap-y-1.5 flex-wrap text-[12px]" style={{ color: "var(--text-muted)" }}>
            {isOn && cfg && (
              <span className="inline-flex items-center gap-1.5">
                <Clock size={13} strokeWidth={1.8} style={{ color: "var(--green)" }} />
                Runs on the <strong style={{ color: "var(--text)" }}>{ordinal(cfg.run_day)}</strong> of each month
              </span>
            )}
            {nextLabel ? (
              <span className="inline-flex items-center gap-1.5">
                <Zap size={13} strokeWidth={1.8} style={{ color: "var(--green)" }} />
                Next close: <strong style={{ color: "var(--text)" }}>{nextLabel}</strong>
              </span>
            ) : isOn ? (
              <span className="inline-flex items-center gap-1.5">
                <CheckCircle2 size={13} strokeWidth={1.8} style={{ color: "var(--green)" }} />
                Every finished month is closed — nothing pending
              </span>
            ) : null}
            {lastRun && (
              <span className="inline-flex items-center gap-1.5">
                Last run: <strong style={{ color: "var(--text)" }}>{lastRun.period_label}</strong> · {fmtRunTime(lastRun.finished_at ?? lastRun.started_at)}
              </span>
            )}
          </div>

          {runErr && (
            <div className="mt-3.5 rounded-lg px-3 py-2 text-[12px] inline-flex items-start gap-1.5"
              style={{ background: "var(--danger-subtle)", color: "var(--danger)", border: "1px solid var(--danger-border)" }}>
              <AlertTriangle size={13} strokeWidth={2} className="mt-0.5 shrink-0" />
              {runErr}
            </div>
          )}

          {/* QBO precondition — explains the disabled "Run now" button. Only for
              operators (the button is theirs) and only once we know it's absent. */}
          {isAdmin && !qboConnected && (
            <div className="mt-3.5 rounded-lg px-3 py-2 text-[12px] flex items-start gap-1.5"
              style={{ background: "var(--warn-subtle)", color: "var(--warn)", border: "1px solid var(--warn-border)" }}>
              <AlertTriangle size={13} strokeWidth={2} className="mt-0.5 shrink-0" />
              <span>
                Connect QuickBooks from the <strong>Connections</strong> page before
                running — Autopilot starts by syncing the period from QuickBooks.
              </span>
            </div>
          )}

          <AnimatePresence>
            {running && (
              <motion.div
                initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                transition={reduce ? { duration: 0 } : { duration: 0.22, ease: "easeOut" }}
                className="overflow-hidden"
              >
                <div className="mt-3.5 h-1 rounded-full overflow-hidden" style={{ background: "var(--surface-2)" }}>
                  {/* Indeterminate progress sweep — respects prefers-reduced-motion:
                      reduced-motion users get a static partial bar, not an infinite loop. */}
                  <motion.div
                    className="h-full rounded-full"
                    style={{ background: "var(--green)", width: "40%" }}
                    animate={reduce ? { x: "80%" } : { x: ["-100%", "260%"] }}
                    transition={reduce ? { duration: 0 } : { repeat: Infinity, duration: 1.6, ease: "easeInOut" }}
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* ── 2 · WHAT IT DOES + SETUP ────────────────────────────────── */}
      <Card>
        <CardHeader
          icon={Sparkles}
          title="How your close runs"
          desc="Autopilot chains the same engines you use by hand — in order, every month, with no clicks."
        />
        <div className="px-6 pb-2">
          <Stepper sendPbc={sendPbc} runFlux={runFlux} runReview={runReview} />
        </div>

        <div className="px-6 pb-6 pt-2 space-y-5" style={{ borderTop: "1px solid var(--border)" }}>
          {!isAdmin && (
            <div className="rounded-lg px-3.5 py-2.5 text-[12px] inline-flex items-center gap-1.5 mt-5"
              style={{ background: "var(--surface-2)", color: "var(--text-muted)", border: "1px solid var(--border)" }}>
              <ShieldCheck size={13} strokeWidth={2} />
              Only workspace admins can change Autopilot. You can view the settings and history below.
            </div>
          )}

          <div className="mt-5">
            <SetupToggle
              label="Enable Close Autopilot"
              hint="The master switch. When on, Autopilot runs your close automatically each month on the day you choose."
              value={enabled}
              onChange={setEnabled}
              disabled={!isAdmin}
              emphasis
            />
          </div>

          {/* Reveal the rest only when enabled — keeps setup focused. */}
          <AnimatePresence initial={false}>
            {enabled && (
              <motion.div
                initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.22, ease: "easeOut" }}
                className="overflow-hidden"
              >
                <div className="space-y-5 pt-1">
                  {/* Run day */}
                  <FieldGroup title="When to run">
                    <div className="rounded-lg p-3.5" style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
                      <div className="flex items-center justify-between gap-3 flex-wrap">
                        <div className="min-w-0">
                          <p className="text-sm font-medium" style={{ color: "var(--text)" }}>Day of the month</p>
                          <p className="text-[11px] mt-0.5" style={{ color: "var(--text-muted)" }}>
                            On this day, Autopilot closes the most recent finished month. Early in the month is typical, so the prior month is fully settled.
                          </p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>Run on the</span>
                          <select
                            value={runDay}
                            disabled={!isAdmin}
                            aria-label="Day of the month to run Autopilot"
                            onChange={(e) => setRunDay(Number(e.target.value))}
                            className="rounded-lg px-2.5 py-1.5 text-sm font-semibold outline-none disabled:opacity-60"
                            style={{ background: "var(--surface)", border: "1px solid var(--border-strong)", color: "var(--text)" }}
                          >
                            {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                              <option key={d} value={d}>{ordinal(d)}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                    </div>
                  </FieldGroup>

                  {/* Flux + AI Close Review */}
                  <FieldGroup title="What to include">
                    <SetupToggle
                      label="Run flux analysis"
                      hint="Build the month's flux (vs. same month last year) and AI-comment the material variances."
                      value={runFlux}
                      onChange={setRunFlux}
                      disabled={!isAdmin}
                    />
                    <SetupToggle
                      label="Run AI Close Review"
                      hint="After flux, the AI reviewing-partner checks reconciliation hygiene, completeness and anomalies — exceptions land in your digest."
                      value={runReview}
                      onChange={setRunReview}
                      disabled={!isAdmin}
                    />
                  </FieldGroup>

                  {/* THE deliberate evidence-email question */}
                  <FieldGroup title="Client evidence requests">
                    <div className="rounded-xl p-4"
                      style={{
                        background: sendPbc ? "var(--green-subtle)" : "var(--surface-2)",
                        border: `1px solid ${sendPbc ? "var(--green)" : "var(--border)"}`,
                        transition: "background .2s, border-color .2s",
                      }}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-start gap-3 min-w-0">
                          <span className="h-8 w-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
                            style={{ background: "var(--surface)", color: sendPbc ? "var(--green)" : "var(--text-muted)" }}>
                            <Mail size={15} strokeWidth={1.8} />
                          </span>
                          <div className="min-w-0">
                            <p className="text-sm font-semibold" style={{ color: "var(--text)" }}>
                              Email my client for missing statements
                            </p>
                            <p className="text-[12px] mt-1 leading-relaxed" style={{ color: "var(--text-muted)" }}>
                              When a bank or credit-card account has <strong>no statement on file</strong>, Autopilot sends your client a secure upload link.
                              <br />
                              <span style={{ color: "var(--text-2)" }}>
                                Off by default — you often already have the statements, so we never email a client unless you turn this on. Saves their inbox and your AI/email budget.
                              </span>
                            </p>
                          </div>
                        </div>
                        <SwitchOnly value={sendPbc} onChange={setSendPbc} disabled={!isAdmin} ariaLabel="Email my client for missing statements" />
                      </div>

                      <AnimatePresence initial={false}>
                        {sendPbc && (
                          <motion.div
                            initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                            transition={{ duration: 0.2, ease: "easeOut" }}
                            className="overflow-hidden"
                          >
                            <div className="mt-3.5 pt-3.5" style={{ borderTop: "1px solid var(--green)" }}>
                              <label className="block text-[11px] font-semibold mb-1.5" style={{ color: "var(--text-2)" }}>
                                Send requests to
                              </label>
                              <input
                                type="email"
                                value={pbcEmail}
                                disabled={!isAdmin}
                                onChange={(e) => setPbcEmail(e.target.value)}
                                placeholder="client@company.com"
                                className="w-full rounded-lg px-3 py-2 text-sm outline-none disabled:opacity-60"
                                style={{ background: "var(--surface)", border: "1px solid var(--border-strong)", color: "var(--text)" }}
                              />
                              <p className="text-[11px] mt-1.5" style={{ color: "var(--text-muted)" }}>
                                Your client receives a branded magic-link to upload the statement — no Nordavix account needed.
                              </p>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  </FieldGroup>

                  {/* Digest extras */}
                  <FieldGroup title="Digest">
                    <SetupToggle
                      label="Attach Financial Package PDF"
                      hint="Attach the period's Income Statement, Balance Sheet and Cash Flow (from the synced books) to the digest email your team receives."
                      value={attachReports}
                      onChange={setAttachReports}
                      disabled={!isAdmin}
                    />
                  </FieldGroup>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {formErr && (
            <div className="rounded-lg px-3 py-2.5 text-[12px] inline-flex items-start gap-1.5"
              style={{ background: "var(--danger-subtle)", color: "var(--danger)", border: "1px solid var(--danger-border)" }}>
              <AlertTriangle size={13} strokeWidth={2} className="mt-0.5 shrink-0" />
              {formErr}
            </div>
          )}

          {isAdmin && (
            <div className="flex items-center gap-3 pt-1">
              <button
                onClick={handleSave}
                disabled={save.isPending || !dirty}
                className="inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ background: "var(--green)" }}
              >
                {save.isPending ? <Spinner className="h-4 w-4" /> : <CheckCircle2 size={15} strokeWidth={2.2} />}
                {save.isPending ? "Saving…" : cfg ? "Save changes" : "Save Autopilot setup"}
              </button>
              {savedAt && (
                <motion.span
                  initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }}
                  className="text-[12px] inline-flex items-center gap-1 font-medium" style={{ color: "var(--green)" }}>
                  <CheckCircle2 size={13} strokeWidth={2.5} /> Saved
                </motion.span>
              )}
              {!dirty && cfg && !savedAt && (
                <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>All changes saved</span>
              )}
            </div>
          )}
        </div>
      </Card>

      {/* ── 3 · HISTORY ─────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          icon={Clock}
          title="Run history"
          desc="The last twelve Autopilot runs, with what each one did."
        />
        <div className="p-6 pt-5">
          {(!state?.runs || state.runs.length === 0) ? (
            <div className="rounded-xl px-4 py-8 text-center"
              style={{ background: "var(--surface-2)", border: "1px dashed var(--border-strong)" }}>
              <Bot size={26} strokeWidth={1.5} className="mx-auto mb-2" style={{ color: "var(--text-muted)" }} />
              <p className="text-sm font-medium" style={{ color: "var(--text-2)" }}>No runs yet</p>
              <p className="text-[12px] mt-1" style={{ color: "var(--text-muted)" }}>
                {isAdmin ? "Save your setup and hit “Run now” to see Autopilot work — or wait for its scheduled day." : "Autopilot runs will appear here once it's set up."}
              </p>
            </div>
          ) : (
            <RunTimeline runs={state.runs} />
          )}
        </div>
      </Card>
    </div>
  )
}

// ── Hero bits ─────────────────────────────────────────────────────────────────

function StatusPill({ on, running }: { on: boolean; running: boolean }) {
  if (running) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider"
        style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping" style={{ background: "var(--green)" }} />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full" style={{ background: "var(--green)" }} />
        </span>
        Running
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider"
      style={{ background: on ? "var(--green-subtle)" : "var(--surface-2)", color: on ? "var(--green)" : "var(--text-muted)" }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: on ? "var(--green)" : "var(--text-muted)" }} />
      {on ? "On" : "Off"}
    </span>
  )
}

// The "what happens" visual. Steps dim when not part of the run; optional
// steps that are off show a "Not included" badge.
function Stepper({ sendPbc, runFlux, runReview }: { sendPbc: boolean; runFlux: boolean; runReview: boolean }) {
  const steps: { icon: LucideIcon; label: string; sub: string; active: boolean; optional?: boolean }[] = [
    { icon: RefreshCw,   label: "Sync",     sub: "QuickBooks balances & aging",          active: true },
    { icon: Bot,         label: "Prepare",  sub: "AI agentic preparer on every account", active: true },
    { icon: TrendingUp,  label: "Flux",     sub: "Variance analysis + AI commentary",    active: runFlux,   optional: true },
    { icon: ShieldCheck, label: "Review",   sub: "AI reviewing-partner checks",          active: runReview, optional: true },
    { icon: Mail,        label: "Evidence", sub: "Email client for missing statements",  active: sendPbc,   optional: true },
    { icon: Send,        label: "Digest",   sub: "Summary email to your team",           active: true },
  ]
  return (
    // Mobile: a 2-column grid so all five steps are fully visible at once
    // (the old single horizontal-scroll row cut the later cards off-screen).
    // sm+: the original horizontal row, scrollable if it overflows.
    <div className="grid grid-cols-2 gap-2 sm:flex sm:items-stretch sm:overflow-x-auto sm:pb-1" style={{ scrollbarWidth: "none" }}>
      {steps.map((s, i) => {
        const Icon = s.icon
        return (
          <div key={s.label} className="rounded-xl p-3 sm:min-w-[140px] sm:flex-1"
            style={{
              background: s.active ? "var(--green-subtle)" : "var(--surface-2)",
              border: `1px solid ${s.active ? "var(--green)" : "var(--border)"}`,
              opacity: s.active ? 1 : 0.6,
              transition: "all .2s",
            }}>
            <div className="flex items-center gap-2">
              <span className="h-7 w-7 rounded-lg flex items-center justify-center shrink-0"
                style={{ background: "var(--surface)", color: s.active ? "var(--green)" : "var(--text-muted)" }}>
                <Icon size={14} strokeWidth={1.8} />
              </span>
              <span className="text-[10px] font-bold uppercase tracking-wider"
                style={{ color: s.active ? "var(--green)" : "var(--text-muted)" }}>
                {i + 1} · {s.label}
              </span>
            </div>
            <p className="text-[11px] mt-1.5 leading-snug" style={{ color: "var(--text-muted)" }}>{s.sub}</p>
            {!s.active && s.optional && (
              <span className="inline-flex items-center mt-1.5 rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider"
                style={{ border: "1px solid var(--border-strong)", color: "var(--text-muted)" }}>
                Not included
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Run timeline ──────────────────────────────────────────────────────────────

const STATUS_META: Record<AutopilotRun["status"], { label: string; bg: string; fg: string }> = {
  completed: { label: "Completed",       bg: "var(--positive-subtle)", fg: "var(--positive)" },
  partial:   { label: "Needs attention", bg: "var(--warn-subtle)",     fg: "var(--warn)" },
  running:   { label: "Running",          bg: "var(--info-subtle)",     fg: "var(--info)" },
  failed:    { label: "Failed",           bg: "var(--danger-subtle)",   fg: "var(--danger)" },
}

function resultChips(r: AutopilotRunResults): string[] {
  const out: string[] = []
  if (r.synced && r.accounts_total != null) out.push(`${r.accounts_total} accounts synced`)
  if (r.prepared) out.push(`${r.prepared} reconciliations prepared`)
  if (r.ai_analyzed) out.push(`${r.ai_analyzed} AI-analysed`)
  if (r.flux_created && r.flux_material != null) out.push(`${r.flux_material} material flux variances`)
  if (r.flux_ai_queued) out.push(`${r.flux_ai_queued} variance commentary`)
  if (r.pbc_sent) out.push(`${r.pbc_sent} statements requested`)
  if (r.review_exceptions != null) out.push(`${r.review_exceptions} review exception${r.review_exceptions === 1 ? "" : "s"}`)
  if (r.reports_attached) out.push("Financial Package attached")
  return out
}

function RunTimeline({ runs }: { runs: AutopilotRun[] }) {
  return (
    <div className="space-y-2.5">
      {runs.map((r) => {
        // Unknown status falls back to the neutral "needs attention" style, never
        // "completed" — an unmapped failure must not read as success.
        const meta = STATUS_META[r.status] ?? STATUS_META.partial
        const chips = resultChips(r.results || {})
        const errs = r.results?.errors ?? []
        return (
          <div key={r.id} className="rounded-xl p-4"
            style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="text-sm font-bold" style={{ color: "var(--text)" }}>{r.period_label}</span>
                <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
                  style={{ background: meta.bg, color: meta.fg }}>
                  {r.status === "running" && <Spinner className="h-2.5 w-2.5" />}
                  {meta.label}
                </span>
                <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded"
                  style={{ background: "var(--surface)", color: "var(--text-muted)" }}>
                  {r.triggered_by === "manual" ? "Manual" : "Scheduled"}
                </span>
              </div>
              <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                {fmtRunTime(r.finished_at ?? r.started_at)}
              </span>
            </div>

            {chips.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap mt-2.5">
                {chips.map((c) => (
                  <span key={c} className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px]"
                    style={{ background: "var(--surface)", color: "var(--text-2)", border: "1px solid var(--border)" }}>
                    <CheckCircle2 size={10} strokeWidth={2.4} style={{ color: "var(--green)" }} />
                    {c}
                  </span>
                ))}
              </div>
            )}

            {errs.length > 0 && (
              <div className="mt-2.5 rounded-lg px-3 py-2"
                style={{ background: "var(--danger-subtle)", border: "1px solid var(--danger-border)" }}>
                <p className="text-[11px] font-semibold inline-flex items-center gap-1" style={{ color: "var(--danger)" }}>
                  <AlertTriangle size={11} strokeWidth={2} />
                  {errs.length} step{errs.length !== 1 ? "s" : ""} need attention
                </p>
                <ul className="mt-1 space-y-0.5">
                  {errs.slice(0, 4).map((e, i) => (
                    <li key={i} className="text-[11px]" style={{ color: "var(--danger)" }}>· {e}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Local primitives (match the Settings look, tuned for this section) ──────────

function Card({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-2xl"
      style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
      {children}
    </section>
  )
}

function CardHeader({ icon: Icon, title, desc }: { icon: LucideIcon; title: string; desc: string }) {
  return (
    <div className="px-6 py-5" style={{ borderBottom: "1px solid var(--border)" }}>
      <div className="flex items-start gap-3">
        <span className="h-9 w-9 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
          <Icon size={17} strokeWidth={1.8} />
        </span>
        <div className="flex-1 min-w-0">
          <h2 className="text-base font-bold text-theme leading-tight">{title}</h2>
          <p className="text-xs sm:text-[13px] mt-1" style={{ color: "var(--text-muted)" }}>{desc}</p>
        </div>
      </div>
    </div>
  )
}

function FieldGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-[11px] font-bold uppercase tracking-wider mb-2" style={{ color: "var(--text-muted)" }}>{title}</h3>
      <div className="space-y-1.5">{children}</div>
    </div>
  )
}

function SwitchOnly({ value, onChange, disabled, ariaLabel }: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean; ariaLabel?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-label={ariaLabel}
      onClick={() => !disabled && onChange(!value)}
      disabled={disabled}
      className="relative h-5 w-9 rounded-full transition-colors shrink-0 mt-0.5 disabled:opacity-60 disabled:cursor-not-allowed"
      style={{ background: value ? "var(--green)" : "var(--border-strong)" }}
    >
      <motion.span
        className="absolute top-0.5 h-4 w-4 rounded-full bg-white shadow"
        animate={{ x: value ? 18 : 2 }}
        transition={{ type: "spring", stiffness: 500, damping: 30 }}
      />
    </button>
  )
}

function SetupToggle({
  label, hint, value, onChange, disabled, emphasis,
}: {
  label: string; hint?: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean; emphasis?: boolean
}) {
  return (
    <label
      className={`flex items-start justify-between gap-3 rounded-lg p-3.5 transition-colors ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}
      style={{
        background: emphasis && value ? "var(--green-subtle)" : "var(--surface-2)",
        border: `1px solid ${emphasis && value ? "var(--green)" : "var(--border)"}`,
      }}
    >
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold" style={{ color: "var(--text)" }}>{label}</p>
        {hint && <p className="text-[11px] mt-0.5 leading-relaxed" style={{ color: "var(--text-muted)" }}>{hint}</p>}
      </div>
      <SwitchOnly value={value} onChange={onChange} disabled={disabled} ariaLabel={label} />
    </label>
  )
}
