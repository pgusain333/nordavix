/**
 * Books-setup wizard — anchors the roll-forward chain.
 *
 * One-time onboarding step that asks for:
 *   1. The books start date (first period the company reconciles).
 *   2. The opening subledger balance per balance-sheet account, seeded
 *      from the GL on (books_start − 1 day) and editable so the user
 *      can correct any accounts where GL didn't match the real
 *      subledger on day one.
 *
 * On commit:
 *   - `tenants.books_start_date` is set and locked.
 *   - One AccountReviewStatus row per account is written at
 *     period_end = books_start − 1 day with the entered opening.
 *   - From here on, every period rolls forward from these openings.
 */
import { useEffect, useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useMutation, useQuery } from "@tanstack/react-query"
import { ArrowLeft, ArrowRight, CheckCircle2, AlertTriangle, Search } from "lucide-react"
import { Button, Spinner } from "@/core/ui/components"
import { DatePicker } from "@/core/ui/DatePicker"
import { reconsApi, type SeedPreviewAccount } from "@/modules/recons/api"
import { useQboConnection } from "@/modules/flux/hooks"
import { toISODate } from "@/core/lib/dates"

/**
 * Coerce any error shape (axios, fetch, raw Error, plain object) into a
 * safe string for React rendering. Never throws; never returns an object.
 * Handles FastAPI's 422 validation array format specifically so we don't
 * surface a useless "Request failed with status code 422" — we show the
 * actual field that's missing/invalid.
 */
function extractErrorMessage(err: unknown): string {
  if (!err) return "Unknown error."
  if (typeof err === "string") return err
  const e = err as {
    response?: { data?: { detail?: unknown }; status?: number }
    message?: unknown
    config?: { url?: string }
  }
  const detail = e.response?.data?.detail
  if (typeof detail === "string") return detail
  // FastAPI 422 — detail is an array of validation errors
  if (Array.isArray(detail)) {
    const parts = detail
      .map((d) => {
        const loc = Array.isArray((d as { loc?: unknown[] }).loc)
          ? ((d as { loc: unknown[] }).loc).join(".")
          : ""
        const msg = typeof (d as { msg?: unknown }).msg === "string"
          ? (d as { msg: string }).msg
          : "invalid"
        return loc ? `${loc}: ${msg}` : msg
      })
      .filter(Boolean)
    if (parts.length > 0) {
      const status = e.response?.status
      return `${status ?? ""} ${parts.join("; ")}`.trim()
    }
  }
  if (typeof e.message === "string") {
    const url = e.config?.url ? ` (${e.config.url})` : ""
    return `${e.message}${url}`
  }
  try {
    return JSON.stringify(err)
  } catch {
    return "Unknown error."
  }
}

function fmtMoney(s: string | number): string {
  const n = typeof s === "string" ? parseFloat(s) : s
  if (!Number.isFinite(n)) return "$0"
  const abs = `$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
  return n < 0 ? `(${abs})` : abs
}

function defaultBooksStart(): string {
  // Default: first of current month — typical "go-live" pick for accountants.
  const d = new Date()
  d.setDate(1)
  return toISODate(d)
}

export function BooksSetupWizard() {
  const navigate = useNavigate()
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [booksStart, setBooksStart] = useState<string>(defaultBooksStart())
  const [editedOpenings, setEditedOpenings] = useState<Record<string, string>>({})
  const [search, setSearch] = useState("")
  // QBO ships standard charts of accounts with placeholders (Mastercard,
  // Visa, etc.) that many clients never use. Default-hide accounts whose
  // GL balance is $0 AND haven't been edited — they're almost always
  // noise on day one. The seed still writes them with $0 in the
  // backend so we have a row in case they're ever used later.
  const [hideZeroBalance, setHideZeroBalance] = useState(true)

  // QBO must be connected before we can pull the seed trial balance.
  // Uses the cached hook so the wizard renders instantly on refresh.
  const { data: qbo } = useQboConnection()

  // Books status — if already seeded we redirect away.
  const { data: status, isLoading: statusLoading } = useQuery({
    queryKey: ["books-status"],
    queryFn:  reconsApi.getBooksStatus,
  })

  useEffect(() => {
    if (status?.seeded) navigate("/app", { replace: true })
  }, [status?.seeded, navigate])

  const {
    data: preview,
    isFetching: previewLoading,
    refetch: refetchPreview,
    error: previewError,
  } = useQuery({
    queryKey: ["seed-preview", booksStart],
    queryFn:  () => reconsApi.getSeedPreview(booksStart),
    enabled:  false,
    retry: false,  // surface the real error instead of retrying silently
  })

  const seedMut = useMutation({
    mutationFn: () => {
      const accounts = (preview?.accounts ?? []).map((a) => ({
        qbo_id:          a.qbo_id,
        opening_balance: editedOpenings[a.qbo_id] ?? a.proposed_opening,
        source_note:     `Seeded ${preview!.seed_date} (GL ${editedOpenings[a.qbo_id] === undefined ? "kept" : "edited"})`,
      }))
      return reconsApi.seedBooks(booksStart, accounts)
    },
    onSuccess: () => {
      // Force the gate query to refetch; redirect happens via useEffect.
      navigate("/app", { replace: true })
    },
  })

  const filteredAccounts = useMemo(() => {
    if (!preview) return [] as SeedPreviewAccount[]
    const q = search.trim().toLowerCase()
    const matchesSearch = (a: SeedPreviewAccount) =>
      !q || a.account_name.toLowerCase().includes(q) || a.account_number.toLowerCase().includes(q)
    return preview.accounts.filter(matchesSearch)
  }, [preview, search])

  // Apply the "hide zero-balance" toggle on top of the search filter.
  // An account stays visible if either its GL balance or its (possibly
  // edited) opening is non-zero — so the user can re-edit an account
  // back down to $0 without it vanishing mid-keystroke.
  const visibleAccounts = useMemo(() => {
    if (!hideZeroBalance) return filteredAccounts
    return filteredAccounts.filter((a) => {
      const gl   = parseFloat(a.proposed_opening) || 0
      const open = parseFloat(editedOpenings[a.qbo_id] ?? a.proposed_opening) || 0
      return gl !== 0 || open !== 0
    })
  }, [filteredAccounts, hideZeroBalance, editedOpenings])

  const hiddenZeroCount = filteredAccounts.length - visibleAccounts.length

  const totalsByGroup = useMemo(() => {
    const map: Record<string, { count: number; total: number }> = {}
    for (const a of preview?.accounts ?? []) {
      const v = parseFloat(editedOpenings[a.qbo_id] ?? a.proposed_opening) || 0
      const g = map[a.group_label] ?? (map[a.group_label] = { count: 0, total: 0 })
      g.count++
      g.total += v
    }
    return map
  }, [preview, editedOpenings])

  if (statusLoading) {
    return <div className="h-full flex items-center justify-center"><Spinner className="h-6 w-6" /></div>
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto" style={{ background: "var(--bg)" }}>
      {/* Header */}
      <div className="px-4 sm:px-8 pt-6 pb-4"
        style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
        <h1 className="text-2xl font-bold text-theme" style={{ letterSpacing: "-0.01em" }}>
          Set up your books
        </h1>
        <p className="text-xs sm:text-sm mt-1.5" style={{ color: "var(--text-muted)" }}>
          Anchor your reconciliations: pick the start date, then confirm or correct the opening subledger
          balance for every balance-sheet account. From here on, each month rolls forward automatically.
        </p>

        {/* Step indicator */}
        <div className="mt-4 flex items-center gap-2 flex-wrap">
          {[
            { n: 1, label: "Start date" },
            { n: 2, label: "Review openings" },
            { n: 3, label: "Confirm & lock" },
          ].map((s, idx, arr) => (
            <div key={s.n} className="flex items-center gap-2">
              <div className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium"
                style={{
                  background: step >= s.n ? "var(--green-subtle)" : "var(--surface-2)",
                  color:      step >= s.n ? "var(--green)" : "var(--text-muted)",
                  border:     `1px solid ${step >= s.n ? "var(--green)" : "var(--border)"}`,
                }}>
                <span className="h-4 w-4 rounded-full inline-flex items-center justify-center text-[10px] font-bold"
                  style={{ background: step >= s.n ? "var(--green)" : "var(--border)", color: "white" }}>
                  {step > s.n ? "✓" : s.n}
                </span>
                {s.label}
              </div>
              {idx < arr.length - 1 && (
                <span style={{ color: "var(--text-muted)" }}>→</span>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="flex-1 px-4 sm:px-8 py-6 max-w-5xl w-full mx-auto">
        {!qbo && (
          <div className="rounded-xl p-4 mb-4 flex items-start gap-3"
            style={{ background: "#f4eddf", border: "1px solid #c79a52" }}>
            <AlertTriangle size={18} style={{ color: "#7a5622" }} className="shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-semibold" style={{ color: "#7a5622" }}>QuickBooks isn't connected</p>
              <p className="text-xs mt-0.5" style={{ color: "#7a5622" }}>
                The wizard pulls a starting trial balance from QuickBooks to seed your openings. Connect first, then come back.
              </p>
            </div>
            <Button size="sm" onClick={() => navigate("/app/connections")}>Connect QuickBooks</Button>
          </div>
        )}

        {/* ── Step 1: Books start date ─────────────────────────────── */}
        {step === 1 && (
          <div className="rounded-xl p-6"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
            <h2 className="text-base font-semibold text-theme mb-2">When do you want to start reconciling?</h2>
            <p className="text-xs mb-4" style={{ color: "var(--text-muted)" }}>
              Pick the first period-end date Nordavix will reconcile. Typically this is the last day of the month before
              your go-live month. We'll pull GL balances as of one day before this date as the proposed openings.
            </p>

            <div className="block max-w-xs">
              <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                Books start date
              </span>
              <div className="mt-1">
                <DatePicker
                  value={booksStart}
                  onChange={setBooksStart}
                  className="block w-full"
                  triggerClassName="inline-flex items-center gap-2 w-full rounded-lg px-3 py-2 text-sm outline-none transition-colors hover:bg-[var(--surface)]"
                />
              </div>
              <p className="text-[10px] mt-1.5" style={{ color: "var(--text-muted)" }}>
                Nordavix will refuse to fetch any data older than this date.
              </p>
            </div>

            <div className="mt-6 flex items-center justify-end">
              <Button
                size="sm"
                icon={<ArrowRight size={14} strokeWidth={1.8} />}
                disabled={!qbo}
                onClick={async () => {
                  // Defensively catch any thrown error so we always advance
                  // to step 2 — the step-2 UI then handles the error state
                  // (showing a Retry button etc.) instead of leaving the
                  // user on a blank screen.
                  try {
                    await refetchPreview()
                  } catch (e) {
                    // eslint-disable-next-line no-console
                    console.error("Seed-preview refetch threw", e)
                  }
                  setStep(2)
                }}
              >
                Pull GL balances
              </Button>
            </div>
          </div>
        )}

        {/* ── Step 2: Review & edit openings ───────────────────────── */}
        {step === 2 && (
          <div className="rounded-xl"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
            <div className="px-5 py-4" style={{ borderBottom: "1px solid var(--border)" }}>
              <h2 className="text-base font-semibold text-theme">Review opening balances</h2>
              <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
                GL trial balance as of {preview?.seed_date || "(loading…)"}. Edit any account where the real
                subledger (bank statement, FA register, prepaid schedule, etc.) doesn't match QBO on day 1.
              </p>
              {/* QBO source banner — tells the user which QuickBooks
                  realm + company the wizard pulled from. Critical
                  for verifying you're connected to the right company,
                  especially across multiple workspaces. */}
              {preview?.qbo_source && (
                <div className="mt-3 inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-[11px]"
                  style={{
                    background: "var(--green-subtle)",
                    border: "1px solid var(--green)",
                    color: "var(--green)",
                  }}>
                  <CheckCircle2 size={12} strokeWidth={2} className="shrink-0" />
                  <span>
                    <span className="font-semibold">Pulled from:</span>{" "}
                    {preview.qbo_source.company_name ?? "(QuickBooks company name unavailable)"}
                    <span className="opacity-70 ml-2 font-mono">
                      realm {preview.qbo_source.realm_id}
                    </span>
                  </span>
                </div>
              )}
              {(preview?.skipped_pl_count ?? 0) > 0 && (
                <p className="text-[11px] mt-2 px-2 py-1.5 rounded inline-block"
                  style={{
                    background: "rgba(78, 110, 142, 0.10)",
                    color: "#3c5a76",
                    border: "1px solid rgba(78, 110, 142, 0.30)",
                  }}>
                  Showing {preview?.accounts.length ?? 0} balance-sheet accounts
                  {preview?.diagnostics?.raw_qbo_account_count !== undefined && (
                    <>{" "}out of {preview.diagnostics.raw_qbo_account_count} returned by QuickBooks
                    </>
                  )}.
                  {" "}{preview!.skipped_pl_count} income / expense / COGS account{preview!.skipped_pl_count === 1 ? "" : "s"}
                  {" "}aren't shown — P&amp;L accounts always start at $0 at the beginning of each fiscal year
                  and don't need an opening balance.
                </p>
              )}
            </div>

            {previewLoading ? (
              <div className="py-16 flex flex-col items-center justify-center gap-2">
                <Spinner className="h-6 w-6" />
                <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                  Pulling trial balance from QuickBooks…
                </p>
              </div>
            ) : previewError ? (
              <div className="py-12 px-6 text-center">
                <AlertTriangle size={28} strokeWidth={1.6} style={{ color: "#9b3d37" }} className="mx-auto mb-3" />
                <p className="text-sm font-semibold text-theme mb-1">Couldn't load from QuickBooks</p>
                <p className="text-xs mb-4 max-w-md mx-auto" style={{ color: "var(--text-muted)" }}>
                  {extractErrorMessage(previewError)}
                </p>
                <div className="flex items-center gap-2 justify-center">
                  <Button size="sm" variant="outline" onClick={() => navigate("/app/connections")}>
                    Check QuickBooks connection
                  </Button>
                  <Button size="sm" onClick={() => refetchPreview()}>
                    Retry
                  </Button>
                </div>
              </div>
            ) : (preview?.accounts.length ?? 0) === 0 ? (
              <div className="py-12 px-6 text-center">
                <AlertTriangle size={28} strokeWidth={1.6} style={{ color: "#c79a52" }} className="mx-auto mb-3" />
                <p className="text-sm font-semibold text-theme mb-1">No balance-sheet accounts in QuickBooks</p>
                <p className="text-xs mb-4 max-w-md mx-auto" style={{ color: "var(--text-muted)" }}>
                  {preview?.warning
                    ?? "QuickBooks returned zero active Bank / AR / AP / Fixed Asset / Other accounts. "
                       + "This usually means a brand-new sandbox or that all accounts are inactive."}
                </p>
                <div className="flex items-center gap-2 justify-center">
                  <Button size="sm" variant="outline" onClick={() => navigate("/app/connections")}>
                    Check connection
                  </Button>
                  <Button size="sm" onClick={() => refetchPreview()}>
                    Retry
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <div className="px-5 py-3 flex items-center gap-2 flex-wrap"
                  style={{ borderBottom: "1px solid var(--border)" }}>
                  <div className="relative flex-1 max-w-xs">
                    <Search size={14} strokeWidth={1.8} className="absolute left-2.5 top-1/2 -translate-y-1/2"
                      style={{ color: "var(--text-muted)" }} />
                    <input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search account…"
                      className="w-full rounded-lg pl-8 pr-3 py-1.5 text-sm outline-none"
                      style={{
                        background: "var(--surface-2)",
                        border: "1px solid var(--border)",
                        color: "var(--text)",
                      }}
                    />
                  </div>
                  <label
                    className="inline-flex items-center gap-1.5 text-[11px] cursor-pointer select-none"
                    style={{ color: "var(--text-2)" }}
                    title="Hides QBO accounts whose GL balance and opening are both $0 — usually unused defaults like Mastercard / Visa from QuickBooks' standard chart"
                  >
                    <input
                      type="checkbox"
                      checked={hideZeroBalance}
                      onChange={(e) => setHideZeroBalance(e.target.checked)}
                      className="h-3.5 w-3.5 rounded"
                      style={{ accentColor: "var(--green)" }}
                    />
                    Hide zero-balance accounts
                  </label>
                  <span className="text-[11px] ml-auto" style={{ color: "var(--text-muted)" }}>
                    {visibleAccounts.length} of {preview?.accounts.length} accounts
                    {hiddenZeroCount > 0 && hideZeroBalance && (
                      <span className="ml-1" style={{ color: "var(--text-muted)" }}>
                        ({hiddenZeroCount} hidden — still seeded at $0)
                      </span>
                    )}
                  </span>
                </div>

                {/* RE + YTD NI callout — explains why the proposed
                    opening for Retained Earnings differs from the raw
                    QBO TB balance. Only renders when at least one RE
                    account was detected and YTD NI was successfully
                    pulled from the P&L. */}
                {preview?.ytd_ni && (preview?.re_accounts_adjusted?.length ?? 0) > 0 && (
                  <div className="mx-5 mt-3 rounded-lg px-3 py-2.5 text-[11px] flex items-start gap-2"
                    style={{ background: "var(--green-subtle)", color: "var(--green)", border: "1px solid var(--green)" }}>
                    <span className="shrink-0 mt-px">✨</span>
                    <span>
                      <span className="font-semibold">
                        Retained Earnings combined with YTD net income from the P&L
                      </span>{" "}
                      ({fmtMoney(preview.ytd_ni)} for{" "}
                      {preview.ytd_ni_period
                        ? `${preview.ytd_ni_period[0]} → ${preview.ytd_ni_period[1]}`
                        : "the YTD period"}). Mid-year QBO TBs show RE at its
                      prior-year-end value only; the current YTD profit sits on
                      the P&L until fiscal-year close. We add it here so the
                      opening equity reflects the true balance as of{" "}
                      {preview.seed_date}. Adjusted: {preview.re_accounts_adjusted?.join(", ")}.
                    </span>
                  </div>
                )}
                {preview?.ytd_ni_error && (preview?.re_accounts_adjusted?.length ?? 0) > 0 && (
                  <div className="mx-5 mt-3 rounded-lg px-3 py-2 text-[11px]"
                    style={{ background: "#f4eddf", color: "#7a5622", border: "1px solid #e8d9b0" }}>
                    Note: Retained Earnings shown at raw GL balance — {preview.ytd_ni_error}{" "}
                    Edit the RE row manually if you need to combine YTD income.
                  </div>
                )}

                <div className="overflow-x-auto" style={{ maxHeight: "55vh" }}>
                  <table className="w-full text-sm">
                    <thead>
                      <tr style={{ background: "var(--surface-2)", position: "sticky", top: 0 }}>
                        <th className="text-left px-3 py-2 text-[10px] font-semibold uppercase tracking-wide"
                          style={{ color: "var(--text-muted)", width: 100 }}>Account No</th>
                        <th className="text-left px-3 py-2 text-[10px] font-semibold uppercase tracking-wide"
                          style={{ color: "var(--text-muted)" }}>Account</th>
                        <th className="text-left px-3 py-2 text-[10px] font-semibold uppercase tracking-wide"
                          style={{ color: "var(--text-muted)", width: 130 }}>Type</th>
                        <th className="text-right px-3 py-2 text-[10px] font-semibold uppercase tracking-wide"
                          style={{ color: "var(--text-muted)", width: 140 }}>GL (proposed)</th>
                        <th className="text-right px-3 py-2 text-[10px] font-semibold uppercase tracking-wide"
                          style={{ color: "var(--text-muted)", width: 160 }}>Opening balance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleAccounts.map((a) => {
                        const edited = editedOpenings[a.qbo_id]
                        const valueToShow = edited ?? a.proposed_opening
                        const wasEdited = edited !== undefined && edited !== a.proposed_opening
                        return (
                          <tr key={a.qbo_id} style={{ borderTop: "1px solid var(--border)" }}>
                            <td className="px-3 py-2 font-mono text-xs" style={{ color: "var(--text-2)" }}>
                              {a.account_number || "—"}
                            </td>
                            <td className="px-3 py-2 text-theme">
                              {a.account_name}
                              {a.combined_with_ytd_ni && (
                                <span className="ml-2 inline-flex items-center gap-1 text-[9px] uppercase font-bold px-1.5 py-0.5 rounded align-middle"
                                  style={{ background: "var(--green-subtle)", color: "var(--green)" }}
                                  title={`GL ${fmtMoney(a.original_gl_balance ?? "0")} + YTD NI ${fmtMoney(a.ytd_ni_added ?? "0")} = ${fmtMoney(a.proposed_opening)}`}>
                                  + YTD NI
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-xs" style={{ color: "var(--text-2)" }}>{a.group_label}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-xs" style={{ color: "var(--text-muted)" }}>
                              {a.combined_with_ytd_ni ? (
                                <div className="leading-tight">
                                  <div>{fmtMoney(a.proposed_opening)}</div>
                                  <div className="text-[9px] mt-0.5" style={{ color: "var(--text-muted)" }}>
                                    {fmtMoney(a.original_gl_balance ?? "0")} <span style={{ color: "var(--green)" }}>+ NI {fmtMoney(a.ytd_ni_added ?? "0")}</span>
                                  </div>
                                </div>
                              ) : (
                                fmtMoney(a.proposed_opening)
                              )}
                            </td>
                            <td className="px-3 py-2 text-right">
                              <div className="inline-flex items-center gap-1">
                                {wasEdited && (
                                  <span className="text-[9px] uppercase font-bold px-1 py-0.5 rounded"
                                    style={{ background: "rgba(199, 154, 82, 0.15)", color: "#c79a52" }}>
                                    edited
                                  </span>
                                )}
                                <input
                                  type="number"
                                  step="0.01"
                                  value={valueToShow}
                                  onChange={(e) =>
                                    setEditedOpenings((prev) => ({ ...prev, [a.qbo_id]: e.target.value }))
                                  }
                                  className="w-32 rounded-md px-2 py-1 text-sm outline-none tabular-nums text-right"
                                  style={{
                                    background: "var(--surface-2)",
                                    border: `1px solid ${wasEdited ? "#c79a52" : "var(--border-strong)"}`,
                                    color: "var(--text)",
                                  }}
                                />
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            <div className="px-5 py-3 flex items-center justify-between gap-2 flex-wrap"
              style={{ borderTop: "1px solid var(--border)", background: "var(--surface-2)" }}>
              <Button size="sm" variant="ghost" icon={<ArrowLeft size={14} strokeWidth={1.8} />}
                onClick={() => setStep(1)}>
                Back
              </Button>
              <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                {Object.keys(editedOpenings).length} of {preview?.accounts.length ?? 0} edited
              </span>
              <Button size="sm" icon={<ArrowRight size={14} strokeWidth={1.8} />}
                onClick={() => setStep(3)}
                disabled={(preview?.accounts.length ?? 0) === 0}>
                Continue
              </Button>
            </div>
          </div>
        )}

        {/* ── Step 3: Confirm & lock ───────────────────────────────── */}
        {step === 3 && (
          <div className="rounded-xl p-6"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
            <h2 className="text-base font-semibold text-theme mb-3">Ready to lock</h2>
            <ul className="text-xs space-y-1.5 mb-4" style={{ color: "var(--text-2)" }}>
              <li>· Books start date: <span className="font-semibold text-theme">{booksStart}</span></li>
              <li>· Opening balances written at: <span className="font-semibold text-theme">{preview?.seed_date}</span></li>
              <li>· Accounts seeded: <span className="font-semibold text-theme">{preview?.accounts.length ?? 0}</span></li>
              <li>· Edited from GL: <span className="font-semibold text-theme">{Object.keys(editedOpenings).length}</span></li>
            </ul>

            {/* Per-group totals */}
            <div className="rounded-lg overflow-hidden mb-4" style={{ border: "1px solid var(--border)" }}>
              <table className="w-full text-xs">
                <thead>
                  <tr style={{ background: "var(--surface-2)" }}>
                    <th className="text-left px-3 py-2 font-semibold" style={{ color: "var(--text-muted)" }}>Group</th>
                    <th className="text-right px-3 py-2 font-semibold" style={{ color: "var(--text-muted)" }}>Accounts</th>
                    <th className="text-right px-3 py-2 font-semibold" style={{ color: "var(--text-muted)" }}>Opening total</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(totalsByGroup).sort().map(([group, v]) => (
                    <tr key={group} style={{ borderTop: "1px solid var(--border)" }}>
                      <td className="px-3 py-1.5 text-theme">{group}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums" style={{ color: "var(--text-2)" }}>{v.count}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums font-medium text-theme">{fmtMoney(v.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
              Once you lock, Nordavix won't let you reconcile any period earlier than {booksStart}.
              Re-opening books is admin-only and on the roadmap.
            </p>

            {seedMut.isError && (
              <p className="text-xs mt-2" style={{ color: "#9b3d37" }}>
                {(seedMut.error as { response?: { data?: { detail?: string } }; message?: string })
                  .response?.data?.detail ?? "Could not save."}
              </p>
            )}

            <div className="mt-5 flex items-center justify-between">
              <Button size="sm" variant="ghost" icon={<ArrowLeft size={14} strokeWidth={1.8} />}
                onClick={() => setStep(2)}>Back</Button>
              <Button size="sm" icon={<CheckCircle2 size={14} strokeWidth={1.8} />}
                loading={seedMut.isPending}
                onClick={() => seedMut.mutate()}>
                Lock books and finish
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
