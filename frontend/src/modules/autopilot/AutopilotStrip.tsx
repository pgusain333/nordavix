/**
 * Close Autopilot — compact dashboard entry strip.
 *
 * A slim banner pinned near the top of the dashboard so the flagship "run my
 * whole close on its own" feature is one glance + one click away. It mirrors
 * the live state the full page shows (Off / On · next close · Running) but
 * stays a single row — the deep controls live on /app/autopilot.
 *
 * Styled in the app's soft green-wash treatment (green-subtle surface, dark
 * text) — the same accent language as the rest of the dashboard, easy on the
 * eyes, rather than a heavy dark band.
 *
 * Shares the ["autopilot"] query key with AutopilotSection, so moving between
 * the dashboard and the page is a cache hit (no refetch flicker). While a run
 * is in flight it polls every 4s so the "Running…" state clears on its own.
 */
import { useOrganization } from "@clerk/clerk-react"
import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { Rocket, Zap, Clock, ArrowRight, CheckCircle2 } from "lucide-react"
import { autopilotApi } from "@/modules/autopilot/api"
import { workspaceApi, hasPower } from "@/modules/workspace/api"

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

export function AutopilotStrip() {
  const { organization } = useOrganization()
  const navigate = useNavigate()

  const { data: me } = useQuery({
    queryKey: ["workspace-me"],
    queryFn:  workspaceApi.getMe,
    staleTime: 10 * 60_000,
    enabled:  !!organization,
  })
  const canOperate = me?.role === "admin" || hasPower(me, "autopilot")

  const { data: state } = useQuery({
    queryKey: ["autopilot"],
    queryFn:  autopilotApi.getState,
    enabled:  !!organization,
    staleTime: 60_000,
    // Keep the strip honest while a run is mid-flight.
    refetchInterval: (q) => (q.state.data?.running ? 4000 : false),
  })

  // Until the first fetch resolves we render nothing — no skeleton flicker for
  // a one-row banner. (If the endpoint errors we also stay hidden rather than
  // shouting on the dashboard; the nav item is still the durable entry point.)
  if (!organization || !state) return null

  const running  = !!state.running
  const isOn     = !!state.config?.enabled
  const nextLbl  = state.next_period_label
  const lastRun  = state.runs?.[0] ?? null

  // Status pill — sits on a plain surface so it reads against the green wash.
  const pill = running
    ? { label: "Running", fg: "var(--green)", pulse: true }
    : isOn
      ? { label: "On", fg: "var(--green)", pulse: false }
      : { label: "Off", fg: "var(--text-muted)", pulse: false }

  const subtitle = running
    ? "Running your close right now — syncing, preparing, and analysing."
    : isOn
      ? nextLbl
        ? <>Runs your month-end close automatically. Next close: <strong style={{ color: "var(--text)" }}>{nextLbl}</strong>{lastRun ? <> · last run {fmtRunTime(lastRun.finished_at ?? lastRun.started_at)}</> : null}</>
        : <>On — every finished month is closed. Nothing pending.</>
      : "Run your month-end close on its own — sync, AI preparation, flux, and a digest in your inbox."

  const cta = running ? "View" : isOn ? "Open" : canOperate ? "Set up" : "Open"

  return (
    <button
      onClick={() => navigate("/app/autopilot")}
      className="group relative w-full overflow-hidden rounded-xl text-left transition-all active:scale-[0.997]"
      style={{ background: "var(--green-subtle)", border: "1px solid var(--green)", boxShadow: "var(--card-shadow)" }}
    >
      <div className="relative flex items-center gap-3.5 px-4 sm:px-5 py-3.5">
        <span className="h-10 w-10 rounded-xl flex items-center justify-center shrink-0"
          style={{ background: "var(--surface)", border: "1px solid var(--green)", color: "var(--green)" }}>
          <Rocket size={18} strokeWidth={1.9} />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold" style={{ color: "var(--text)" }}>Close Autopilot</span>
            <span className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider"
              style={{ background: "var(--surface)", color: pill.fg, border: "1px solid var(--border)" }}>
              {pill.pulse && (
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping" style={{ background: "var(--green)" }} />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full" style={{ background: "var(--green)" }} />
                </span>
              )}
              {pill.label}
            </span>
          </div>
          <p className="text-[12px] mt-0.5 leading-snug truncate sm:whitespace-normal" style={{ color: "var(--text-muted)" }}>
            {isOn && !running && <Zap size={11} strokeWidth={2} className="inline -mt-0.5 mr-1" style={{ color: "var(--green)" }} />}
            {running && <Clock size={11} strokeWidth={2} className="inline -mt-0.5 mr-1" style={{ color: "var(--green)" }} />}
            {!isOn && !running && <CheckCircle2 size={11} strokeWidth={2} className="inline -mt-0.5 mr-1" style={{ color: "var(--green)" }} />}
            {subtitle}
          </p>
        </div>

        <span className="shrink-0 inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-[12px] font-bold text-white transition-transform group-hover:translate-x-0.5"
          style={{ background: "var(--green)" }}>
          {cta}
          <ArrowRight size={13} strokeWidth={2.4} />
        </span>
      </div>
    </button>
  )
}
