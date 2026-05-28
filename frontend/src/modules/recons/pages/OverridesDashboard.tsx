/**
 * Manual Overrides Dashboard — reviewer's QC list.
 *
 * Every account where a user has entered a manual subledger value (instead
 * of using the QBO default) shows up here. A reviewer can:
 *   - See who entered the value, when, and for what period
 *   - See how many evidence docs are attached
 *   - Click in to approve / flag / clear (subject to maker-checker rules)
 *
 * Lives at /app/reconciliations/overrides — siblings of the main recons page.
 */
import { useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import {
  AlertTriangle, ArrowLeft, CheckCircle2, FileText, Paperclip, Search, Sparkles, User, XCircle,
} from "lucide-react"
import { Spinner } from "@/core/ui/components"
import { formatDate } from "@/core/lib/dates"
import {
  reconsApi,
  type OverrideEntry,
  type AccountReviewStatus,
} from "@/modules/recons/api"

function fmtMoney(s: string | number | null): string {
  if (s === null || s === undefined) return "—"
  const n = typeof s === "string" ? parseFloat(s) : s
  if (!Number.isFinite(n)) return "—"
  const abs = `$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
  return n < 0 ? `(${abs})` : abs
}

function fmtDate(s: string | null): string {
  return formatDate(s) || "—"
}

const STATUS_COLORS: Record<AccountReviewStatus, { bg: string; fg: string }> = {
  pending:  { bg: "var(--surface-2)",    fg: "var(--text-muted)" },
  reviewed: { bg: "#dbeafe",             fg: "#1d4ed8" },
  approved: { bg: "var(--green-subtle)", fg: "var(--green)" },
  flagged:  { bg: "#fee2e2",             fg: "#b91c1c" },
}

export function OverridesDashboard() {
  const navigate = useNavigate()
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<AccountReviewStatus | "all">("all")

  const { data: overrides, isLoading } = useQuery({
    queryKey: ["recon-overrides", "all-periods"],
    queryFn:  () => reconsApi.listOverrides(),
  })

  const filtered = useMemo(() => {
    if (!overrides) return [] as OverrideEntry[]
    const q = search.trim().toLowerCase()
    return overrides.filter((o) => {
      if (statusFilter !== "all" && o.status !== statusFilter) return false
      if (q) {
        const blob = `${o.qbo_account_id} ${o.subledger_source ?? ""}`.toLowerCase()
        if (!blob.includes(q)) return false
      }
      return true
    })
  }, [overrides, search, statusFilter])

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: overrides?.length ?? 0, pending: 0, reviewed: 0, approved: 0, flagged: 0 }
    overrides?.forEach((o) => { c[o.status] = (c[o.status] ?? 0) + 1 })
    return c
  }, [overrides])

  return (
    <div className="flex flex-col h-full overflow-y-auto" style={{ background: "var(--bg)" }}>
      <div
        className="px-4 sm:px-8 pt-5 sm:pt-7 pb-4"
        style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}
      >
        <button
          onClick={() => navigate("/app/reconciliations")}
          className="text-xs inline-flex items-center gap-1 mb-3 transition-opacity hover:opacity-70"
          style={{ color: "var(--text-muted)" }}
        >
          <ArrowLeft size={12} strokeWidth={1.8} />
          Back to Reconciliations
        </button>
        <h1 style={{
          fontSize: "clamp(22px, 5vw, 28px)",
          fontWeight: 700, lineHeight: 1.2, letterSpacing: "-0.01em",
          color: "var(--text)", margin: 0,
        }}>
          Manual subledger overrides
        </h1>
        <p className="text-xs sm:text-sm mt-1.5" style={{ color: "var(--text-muted)" }}>
          Every account+period where the GL was reconciled against a user-entered subledger value (vs the QuickBooks default).
          Reviewers triage from here and verify against the attached evidence.
        </p>
      </div>

      <div className="flex-1 px-4 sm:px-8 py-5 max-w-7xl w-full mx-auto space-y-5">
        {isLoading ? (
          <div className="py-16 flex items-center justify-center"><Spinner className="h-6 w-6" /></div>
        ) : (overrides?.length ?? 0) === 0 ? (
          <div className="rounded-xl p-12 text-center"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
            <FileText size={26} strokeWidth={1.5} style={{ color: "var(--text-muted)" }} className="mx-auto mb-3" />
            <p className="text-base font-semibold text-theme mb-1">No manual overrides yet</p>
            <p className="text-sm max-w-md mx-auto" style={{ color: "var(--text-muted)" }}>
              When someone enters a subledger value for an account (e.g. a bank statement total),
              it'll appear here for review.
            </p>
          </div>
        ) : (
          <>
            {/* Status filter pills */}
            <div className="flex items-center gap-2 flex-wrap">
              {(["all", "pending", "reviewed", "approved", "flagged"] as const).map((s) => {
                const active = statusFilter === s
                const meta = s === "all" ? { bg: "var(--surface-2)", fg: "var(--text)" } : STATUS_COLORS[s]
                return (
                  <button
                    key={s}
                    onClick={() => setStatusFilter(s)}
                    className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-all"
                    style={{
                      background: active ? meta.bg : "var(--surface)",
                      color:      active ? meta.fg : "var(--text-muted)",
                      border:     `1px solid ${active ? "transparent" : "var(--border)"}`,
                    }}
                  >
                    {s === "all" ? "All" : s[0].toUpperCase() + s.slice(1)}
                    <span className="text-[10px] opacity-70">{counts[s] ?? 0}</span>
                  </button>
                )
              })}
              <div className="relative ml-auto max-w-xs flex-1 min-w-[180px]">
                <Search size={14} strokeWidth={1.8} className="absolute left-2.5 top-1/2 -translate-y-1/2"
                  style={{ color: "var(--text-muted)" }} />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search account ID or source…"
                  className="w-full rounded-lg pl-8 pr-3 py-1.5 text-sm outline-none"
                  style={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    color: "var(--text)",
                  }}
                />
              </div>
            </div>

            {/* Table */}
            <div className="rounded-xl overflow-hidden"
              style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
              {filtered.length === 0 ? (
                <div className="py-12 text-center">
                  <p className="text-sm font-medium text-theme mb-1">No overrides match your filters.</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr style={{ background: "var(--surface-2)", borderBottom: "1px solid var(--border)" }}>
                        {[
                          { label: "Account ID", w: "110px" },
                          { label: "Period", w: "100px" },
                          { label: "Subledger total", w: "130px", right: true },
                          { label: "Source", w: "auto" },
                          { label: "Evidence", w: "90px" },
                          { label: "AI verify", w: "130px" },
                          { label: "Entered", w: "120px" },
                          { label: "Status", w: "110px" },
                        ].map((h, i) => (
                          <th key={i}
                            className="text-[10px] font-semibold uppercase tracking-wide px-3 py-2.5"
                            style={{
                              color: "var(--text-muted)",
                              textAlign: h.right ? "right" : "left",
                              width: h.w,
                            }}>
                            {h.label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map((o, i) => {
                        const meta = STATUS_COLORS[o.status] ?? STATUS_COLORS.pending
                        return (
                          <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                            <td className="px-3 py-2.5 font-mono text-xs" style={{ color: "var(--text-2)" }}>
                              {o.qbo_account_id}
                            </td>
                            <td className="px-3 py-2.5 text-xs" style={{ color: "var(--text-2)" }}>
                              {o.period_end}
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums text-sm font-medium text-theme">
                              {fmtMoney(o.subledger_total)}
                            </td>
                            <td className="px-3 py-2.5 text-xs" style={{ color: "var(--text-2)" }}>
                              {o.subledger_source || <span style={{ color: "#b91c1c", fontStyle: "italic" }}>No source noted</span>}
                            </td>
                            <td className="px-3 py-2.5 text-xs">
                              {o.evidence_count > 0 ? (
                                <span className="inline-flex items-center gap-1" style={{ color: "var(--green)" }}>
                                  <Paperclip size={11} strokeWidth={1.8} />
                                  {o.evidence_count} file{o.evidence_count === 1 ? "" : "s"}
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1" style={{ color: "#b91c1c" }}>
                                  <AlertTriangle size={11} strokeWidth={1.8} />
                                  Missing
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2.5 text-xs">
                              {o.verification_state === "match" && (
                                <span className="inline-flex items-center gap-1" style={{ color: "var(--green)" }}>
                                  <CheckCircle2 size={11} strokeWidth={2} /> AI-verified
                                </span>
                              )}
                              {o.verification_state === "mismatch" && (
                                <span className="inline-flex items-center gap-1" style={{ color: "#b91c1c" }}>
                                  <XCircle size={11} strokeWidth={2} /> AI mismatch
                                </span>
                              )}
                              {o.verification_state === "unknown" && (
                                <span className="inline-flex items-center gap-1" style={{ color: "#92400e" }}>
                                  <AlertTriangle size={11} strokeWidth={1.8} /> Low confidence
                                </span>
                              )}
                              {o.verification_state === "unverified" && (
                                <span className="inline-flex items-center gap-1" style={{ color: "var(--text-muted)" }}>
                                  <Sparkles size={11} strokeWidth={1.8} /> Not run
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2.5 text-xs" style={{ color: "var(--text-muted)" }}>
                              <div className="inline-flex items-center gap-1">
                                <User size={10} strokeWidth={1.8} />
                                {fmtDate(o.subledger_entered_at)}
                              </div>
                            </td>
                            <td className="px-3 py-2.5">
                              <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold"
                                style={{ background: meta.bg, color: meta.fg }}>
                                {o.status === "approved" && <CheckCircle2 size={9} strokeWidth={2.2} />}
                                {o.status[0].toUpperCase() + o.status.slice(1)}
                              </span>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="px-4 py-2.5 text-[11px]" style={{ borderTop: "1px solid var(--border)", background: "var(--surface-2)", color: "var(--text-muted)" }}>
                Showing {filtered.length} of {overrides?.length ?? 0} overrides.
                Items marked <span style={{ color: "#b91c1c", fontWeight: 600 }}>Missing</span> have no supporting document attached.
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
