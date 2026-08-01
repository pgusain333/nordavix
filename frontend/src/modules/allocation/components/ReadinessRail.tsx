/**
 * ReadinessRail — "can this client be run", parked beside the work.
 *
 * It used to sit at the top of a single Setup page, which meant it scrolled away
 * the moment you started editing the thing it was complaining about. Now setup is
 * several screens, so the answer travels with you: whatever you're editing, the
 * rail on the right says whether the client can be run yet and what's still
 * missing.
 *
 * Every blocker is a link to the screen that resolves it. A checklist you can't
 * act on is just a list of complaints.
 */
import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "react-router-dom"
import {
  AlertTriangle, ArrowRight, CheckCircle2, Play, XCircle,
} from "lucide-react"
import { Spinner } from "@/core/ui"
import { allocationApi } from "../api"

/**
 * The backend states a fix as a path fragment ("setup/spaces"). Setup used to be
 * one page with tabs; each fragment is now its own route, so the mapping is a
 * strip — kept as a function so a new blocker code can't silently land nowhere.
 */
export function routeForFix(fix: string): string {
  const leaf = fix.replace(/^setup\/?/, "")
  const KNOWN = [
    "eligibility", "pools", "accounts", "spaces", "employees", "settings", "payroll",
  ]
  return KNOWN.includes(leaf) ? `/allocation/${leaf}` : "/allocation/eligibility"
}

interface Props {
  periodEnd: string
}

export function ReadinessRail({ periodEnd }: Props) {
  const navigate = useNavigate()

  const { data, isLoading } = useQuery({
    queryKey: ["allocation", "readiness", periodEnd],
    queryFn:  () => allocationApi.getReadiness(periodEnd),
    staleTime: 15_000,
  })

  const Count = ({ label, value, to, muted }: {
    label: string; value: string | number; to: string; muted?: boolean
  }) => (
    <Link to={to} className="flex items-baseline justify-between gap-2 py-1 hover:opacity-70 transition-opacity">
      <span className="text-[11.5px]" style={{ color: "var(--text-muted)" }}>{label}</span>
      <span className="text-[12px] tabular-nums font-medium"
        style={{ color: muted ? "var(--text-muted)" : "var(--text-2)" }}>{value}</span>
    </Link>
  )

  return (
    <div className="rounded-xl overflow-hidden"
      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>

      {isLoading || !data ? (
        <div className="flex items-center gap-2 px-4 py-5 text-xs" style={{ color: "var(--text-muted)" }}>
          <Spinner className="h-4 w-4" /> Checking readiness…
        </div>
      ) : (
        <>
          <div className="px-4 pt-4 pb-3.5">
            <div className="flex items-center gap-2">
              {data.ready
                ? <CheckCircle2 size={17} strokeWidth={2} style={{ color: "var(--positive)" }} />
                : <XCircle size={17} strokeWidth={2} style={{ color: "var(--danger)" }} />}
              <span className="text-[13.5px] font-semibold text-theme">
                {data.ready ? "Ready to run" : "Not ready to run"}
              </span>
            </div>
            <p className="text-[11px] mt-1" style={{ color: "var(--text-muted)" }}>
              {data.ready
                ? "Every driver this client's pools need is on file."
                : `${data.blockers.length} thing${data.blockers.length === 1 ? "" : "s"} to resolve first.`}
            </p>

            {data.ready && (
              <button onClick={() => navigate("/allocation/runs")}
                className="mt-3 w-full inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-[12.5px] font-medium transition-opacity hover:opacity-90"
                style={{ background: "var(--green)", color: "#fff" }}>
                <Play size={13} strokeWidth={2} /> Run this month
              </button>
            )}
          </div>

          {data.blockers.length > 0 && (
            <div className="px-4 py-3" style={{ borderTop: "1px solid var(--border)" }}>
              <p className="text-[10.5px] font-semibold uppercase tracking-wide mb-1.5"
                style={{ color: "var(--text-muted)" }}>
                Blocking
              </p>
              <ul className="space-y-2">
                {data.blockers.map((b) => (
                  <li key={b.code}>
                    <Link to={routeForFix(b.fix)}
                      className="flex items-start gap-2 group hover:opacity-80 transition-opacity">
                      <XCircle size={12} strokeWidth={2} className="mt-[3px] shrink-0"
                        style={{ color: "var(--danger)" }} />
                      <span className="text-[11.5px] leading-snug" style={{ color: "var(--text)" }}>
                        {b.message}
                        <span className="inline-flex items-center gap-0.5 ml-1 font-medium whitespace-nowrap"
                          style={{ color: "var(--green)" }}>
                          Fix <ArrowRight size={10} strokeWidth={2.2} />
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {data.warnings.length > 0 && (
            <div className="px-4 py-3" style={{ borderTop: "1px solid var(--border)" }}>
              <p className="text-[10.5px] font-semibold uppercase tracking-wide mb-1.5"
                style={{ color: "var(--text-muted)" }}>
                Worth checking
              </p>
              <ul className="space-y-2">
                {data.warnings.map((w) => (
                  <li key={w.code}>
                    <Link to={routeForFix(w.fix)}
                      className="flex items-start gap-2 hover:opacity-80 transition-opacity">
                      <AlertTriangle size={12} strokeWidth={2} className="mt-[3px] shrink-0"
                        style={{ color: "var(--warn)" }} />
                      <span className="text-[11.5px] leading-snug" style={{ color: "var(--text-2)" }}>
                        {w.message}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* What's on file. "not required" is stated rather than left blank —
              an occupancy-only client shouldn't read zero employees as a gap. */}
          <div className="px-4 py-2.5" style={{ borderTop: "1px solid var(--border)" }}>
            <Count label="Cost pools" value={data.counts.pools} to="/allocation/pools" />
            <Count label="Accounts mapped" value={data.counts.mapped_accounts} to="/allocation/accounts" />
            <Count
              label={data.requires.occupancy ? "Spaces" : "Spaces (not required)"}
              value={data.counts.spaces} to="/allocation/spaces"
              muted={!data.requires.occupancy} />
            <Count
              label={data.requires.payroll ? "Employees" : "Employees (not required)"}
              value={data.counts.employees} to="/allocation/employees"
              muted={!data.requires.payroll} />
          </div>
        </>
      )}
    </div>
  )
}
