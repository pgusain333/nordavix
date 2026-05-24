/**
 * Reconciliations Dashboard — single-screen live overview.
 *
 * Layout:
 *   [Header]   Title + Period selector + Sync + Clear data
 *   [KPI strip] 4 cards summarizing totals + variance
 *   [AI insights] (only when there's something interesting)
 *   [Main table] EVERY balance-sheet account from QBO with:
 *      Account # | Name | Type | GL Balance | Subledger | Variance | Actions
 *      grouped by type, sortable, searchable, filterable
 *      per-row buttons: View subledger | View variance | Generate AI
 *
 * Two side drawers slide in from the right for drill-in:
 *   - SubledgerDetailDrawer (per-account subledger composition)
 *   - VarianceDetailDrawer  (transactions causing the GL-vs-subledger gap)
 *
 * All data is pulled LIVE from QuickBooks on each period change — no
 * persistence overhead, always fresh.
 */
import { useEffect, useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { motion, AnimatePresence } from "framer-motion"
import {
  RefreshCw,
  AlertTriangle,
  AlertCircle,
  CheckCircle2,
  Search,
  Eye,
  GitCompareArrows,
  X,
  Trash2,
  Zap,
  ExternalLink,
  Sparkles,
} from "lucide-react"
import { Button, Spinner } from "@/core/ui/components"
import {
  reconsApi,
  type OverviewAccount,
  type SubledgerDetail,
  type VarianceDetail,
} from "@/modules/recons/api"
import { api as fluxApi } from "@/modules/flux/api"

// ── Formatting helpers ─────────────────────────────────────────────────────

function fmtMoney(s: string | number, withSign = false): string {
  const n = typeof s === "string" ? parseFloat(s) : s
  if (!Number.isFinite(n)) return "$0"
  const abs = `$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
  if (n === 0) return abs
  if (n < 0) return `(${abs})`
  return withSign ? `+${abs}` : abs
}

function defaultPeriodEnd(): string {
  // Default: last day of previous month — common close period
  const d = new Date()
  d.setDate(0)  // last day of previous month
  return d.toISOString().slice(0, 10)
}

const GROUP_COLORS: Record<string, string> = {
  Bank:                       "#3b82f6",
  "Credit Card":              "#8b5cf6",
  AR:                         "#10b981",
  AP:                         "#f59e0b",
  "Fixed Assets":             "#0ea5e9",
  "Other Current Assets":     "#14b8a6",
  "Other Assets":             "#06b6d4",
  "Other Current Liabilities":"#ec4899",
  "Long Term Liabilities":    "#d946ef",
  Equity:                     "#a855f7",
}

// ── Main component ─────────────────────────────────────────────────────────

export function ReconciliationsDashboard() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [periodEnd, setPeriodEnd] = useState<string>(defaultPeriodEnd())
  const [search, setSearch] = useState("")
  const [groupFilter, setGroupFilter] = useState<string>("all")
  const [showOnlyVariance, setShowOnlyVariance] = useState(false)
  const [drawerAccount, setDrawerAccount] = useState<OverviewAccount | null>(null)
  const [drawerMode, setDrawerMode] = useState<"subledger" | "variance">("subledger")
  const [confirmClear, setConfirmClear] = useState(false)
  /** "Synced N accounts at HH:MM" — banner that fades out after a few seconds */
  const [syncMsg, setSyncMsg] = useState<string | null>(null)

  const { data: qbo } = useQuery({
    queryKey: ["qbo-connection"],
    queryFn:  fluxApi.getQboConnection,
    staleTime: 60_000,
  })

  // Manual-fetch only. We never auto-pull from QBO on mount or period change —
  // every sync is an explicit user action. `enabled: false` keeps the query
  // dormant; handleSync() drives it via refetch().
  const { data: overview, isFetching, refetch, dataUpdatedAt } = useQuery({
    queryKey: ["recons-overview", periodEnd],
    queryFn:  () => reconsApi.getOverview(periodEnd),
    enabled:  false,
    staleTime: Infinity,
  })

  async function handleSync() {
    setSyncMsg(null)
    const result = await refetch()
    if (result.error) {
      const ex = result.error as { response?: { data?: { detail?: string } }; message?: string }
      setSyncMsg(`Sync failed: ${ex.response?.data?.detail ?? ex.message ?? "Unknown error"}`)
    } else {
      const n = result.data?.accounts.length ?? 0
      setSyncMsg(`Synced ${n} account${n === 1 ? "" : "s"} from QuickBooks at ${new Date().toLocaleTimeString()}.`)
    }
  }

  // Auto-dismiss banner after 4 seconds
  useEffect(() => {
    if (!syncMsg) return
    const t = setTimeout(() => setSyncMsg(null), 4_000)
    return () => clearTimeout(t)
  }, [syncMsg])

  // Human-readable "last synced" indicator
  const lastSynced = useMemo(() => {
    if (!dataUpdatedAt) return null
    const seconds = Math.floor((Date.now() - dataUpdatedAt) / 1000)
    if (seconds < 60) return `Synced ${seconds}s ago`
    if (seconds < 3600) return `Synced ${Math.floor(seconds / 60)}m ago`
    return `Synced ${Math.floor(seconds / 3600)}h ago`
  }, [dataUpdatedAt])

  const clearMut = useMutation({
    mutationFn: () => reconsApi.clearSyncedData(),
    onSuccess: () => {
      setConfirmClear(false)
      qc.invalidateQueries({ queryKey: ["recons-overview"] })
    },
    onError: () => setConfirmClear(false),
  })

  // Filtered + searched account list
  const filteredAccounts = useMemo(() => {
    if (!overview) return [] as OverviewAccount[]
    const q = search.trim().toLowerCase()
    return overview.accounts.filter((a) => {
      if (groupFilter !== "all" && a.group_label !== groupFilter) return false
      if (showOnlyVariance && Math.abs(parseFloat(a.variance)) < 0.5) return false
      if (q && !(a.account_name.toLowerCase().includes(q) || a.account_number.toLowerCase().includes(q))) return false
      return true
    })
  }, [overview, search, groupFilter, showOnlyVariance])

  const groupOptions = useMemo(() => {
    const set = new Set<string>()
    overview?.accounts.forEach((a) => set.add(a.group_label))
    return Array.from(set).sort()
  }, [overview])

  const varianceCount = useMemo(() => {
    return overview?.accounts.filter((a) => Math.abs(parseFloat(a.variance)) >= 0.5).length ?? 0
  }, [overview])

  function openSubledger(a: OverviewAccount) {
    setDrawerAccount(a)
    setDrawerMode("subledger")
  }
  function openVariance(a: OverviewAccount) {
    setDrawerAccount(a)
    setDrawerMode("variance")
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto" style={{ background: "var(--bg)" }}>
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div
        className="px-4 sm:px-8 pt-5 sm:pt-7 pb-4"
        style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}
      >
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <h1
              style={{
                fontSize: "clamp(22px, 5vw, 28px)",
                fontWeight: 700,
                lineHeight: 1.2,
                letterSpacing: "-0.01em",
                color: "var(--text)",
                margin: 0,
              }}
            >
              Reconciliations
            </h1>
            <p className="text-xs sm:text-sm mt-1.5" style={{ color: "var(--text-muted)" }}>
              Live snapshot of every balance-sheet account — pulled from QuickBooks at your chosen period end.
            </p>
          </div>

          <div className="flex items-end gap-2 flex-wrap">
            <label className="flex flex-col">
              <span className="text-[10px] font-semibold uppercase tracking-wide mb-1" style={{ color: "var(--text-muted)" }}>
                Period end
              </span>
              <input
                type="date"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
                disabled={!qbo}
                className="rounded-lg px-3 py-1.5 text-sm outline-none"
                style={{
                  background: "var(--surface-2)",
                  border: "1px solid var(--border-strong)",
                  color: "var(--text)",
                }}
              />
            </label>
            <Button
              size="sm"
              variant="outline"
              icon={<RefreshCw size={14} strokeWidth={1.8} className={isFetching ? "animate-spin" : undefined} />}
              onClick={handleSync}
              disabled={!qbo || isFetching}
              title="Re-pull from QuickBooks"
            >
              <span className="hidden sm:inline">{isFetching ? "Syncing…" : "Sync"}</span>
            </Button>
            <Button
              size="sm"
              variant="outline"
              icon={<Trash2 size={14} strokeWidth={1.8} />}
              onClick={() => confirmClear ? clearMut.mutate() : setConfirmClear(true)}
              loading={clearMut.isPending}
              style={confirmClear ? { borderColor: "#dc2626", color: "#dc2626" } : undefined}
              title="Wipe all cached reconciliation data (the QBO connection stays)"
            >
              <span className="hidden sm:inline">
                {confirmClear ? "Confirm clear?" : "Clear data"}
              </span>
            </Button>
          </div>
        </div>
      </div>

      {/* Sync-status banner (only shows when there's something to say) */}
      <AnimatePresence>
        {syncMsg && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="px-4 sm:px-8 py-2 text-xs font-medium flex items-center gap-2"
            style={{
              background: syncMsg.startsWith("Sync failed") ? "#fee2e2" : "var(--green-subtle)",
              color:      syncMsg.startsWith("Sync failed") ? "#b91c1c" : "var(--green)",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <CheckCircle2 size={12} strokeWidth={1.8} />
            <span className="flex-1">{syncMsg}</span>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex-1 px-4 sm:px-8 py-5 max-w-7xl w-full mx-auto space-y-5">

        {/* QBO required banner */}
        {!qbo && (
          <div
            className="rounded-xl p-4 flex items-start gap-3"
            style={{ background: "#fef3c7", border: "1px solid #f59e0b" }}
          >
            <AlertTriangle size={18} style={{ color: "#92400e" }} className="shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold" style={{ color: "#92400e" }}>QuickBooks isn't connected</p>
              <p className="text-xs mt-0.5" style={{ color: "#92400e" }}>
                The Reconciliations dashboard pulls all your GL accounts and subledger balances live from QuickBooks.
                Connect to get started.
              </p>
            </div>
            <Button size="sm" onClick={() => navigate("/app/connections")}>
              Connect QuickBooks
            </Button>
          </div>
        )}

        {qbo && !overview && !isFetching && (
          <div
            className="rounded-xl p-8 text-center"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}
          >
            <div className="h-14 w-14 mx-auto rounded-full flex items-center justify-center mb-4"
              style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
              <RefreshCw size={26} strokeWidth={1.6} />
            </div>
            <p className="text-base font-semibold text-theme mb-1">Ready to sync</p>
            <p className="text-sm max-w-md mx-auto mb-5" style={{ color: "var(--text-muted)" }}>
              Pick a period end above and click Sync to pull every balance sheet account from QuickBooks.
              Nordavix never auto-syncs — you stay in control of when data is fetched.
            </p>
            <Button size="sm" icon={<RefreshCw size={14} strokeWidth={1.8} />} onClick={handleSync}>
              Sync from QuickBooks
            </Button>
          </div>
        )}

        {qbo && (overview || isFetching) && (
          <>
            {/* KPI strip */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <Kpi label="Total GL"               value={fmtMoney(overview?.totals.gl ?? 0)}        tone="var(--text)" />
              <Kpi label="Total subledger"        value={fmtMoney(overview?.totals.subledger ?? 0)} tone="var(--text)" />
              <Kpi label="Net variance"           value={fmtMoney(overview?.totals.variance ?? 0)}
                tone={Math.abs(parseFloat(overview?.totals.variance ?? "0")) > 0.5 ? "#dc2626" : "var(--green)"} />
              <Kpi label="Accounts with variance" value={String(varianceCount)} tone="var(--text)" />
            </div>

            {/* Filters */}
            <div className="flex items-center gap-2 flex-wrap">
              <div className="relative flex-1 min-w-[180px] max-w-xs">
                <Search size={14} strokeWidth={1.8} className="absolute left-2.5 top-1/2 -translate-y-1/2"
                  style={{ color: "var(--text-muted)" }} />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search account name or #…"
                  className="w-full rounded-lg pl-8 pr-3 py-1.5 text-sm outline-none"
                  style={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    color: "var(--text)",
                  }}
                />
              </div>
              <select
                value={groupFilter}
                onChange={(e) => setGroupFilter(e.target.value)}
                className="rounded-lg px-3 py-1.5 text-sm outline-none"
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  color: "var(--text)",
                }}
              >
                <option value="all">All account types</option>
                {groupOptions.map((g) => (
                  <option key={g} value={g}>{g}</option>
                ))}
              </select>
              <label className="flex items-center gap-1.5 text-xs cursor-pointer select-none" style={{ color: "var(--text-2)" }}>
                <input
                  type="checkbox"
                  checked={showOnlyVariance}
                  onChange={(e) => setShowOnlyVariance(e.target.checked)}
                />
                Variances only
              </label>
            </div>

            {/* Main table */}
            <div className="rounded-xl overflow-hidden"
              style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
              {isFetching && !overview ? (
                <div className="py-16 flex items-center justify-center">
                  <Spinner className="h-6 w-6" />
                </div>
              ) : filteredAccounts.length === 0 ? (
                <div className="py-12 text-center">
                  <p className="text-sm font-medium text-theme mb-1">
                    {overview?.accounts.length === 0
                      ? "QuickBooks didn't return any balance-sheet accounts for this period."
                      : "No accounts match your filters."}
                  </p>
                  <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                    {overview?.accounts.length === 0
                      ? "Try a different period end, or sync again."
                      : "Try clearing the search or changing the type filter."}
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr style={{
                        background: "var(--surface-2)",
                        borderBottom: "1px solid var(--border)",
                      }}>
                        {[
                          { label: "Account #", w: "90px" },
                          { label: "Account", w: "auto" },
                          { label: "Type", w: "130px" },
                          { label: "GL Balance", w: "120px", right: true },
                          { label: "Subledger", w: "120px", right: true },
                          { label: "Variance", w: "120px", right: true },
                          { label: "", w: "160px" },
                        ].map((h, i) => (
                          <th
                            key={i}
                            className="text-[10px] font-semibold uppercase tracking-wide px-3 py-2.5"
                            style={{
                              color: "var(--text-muted)",
                              textAlign: h.right ? "right" : "left",
                              width: h.w,
                            }}
                          >
                            {h.label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredAccounts.map((a) => {
                        const variance = parseFloat(a.variance)
                        const hasVariance = Math.abs(variance) >= 0.5
                        const color = GROUP_COLORS[a.group_label] ?? "var(--text-muted)"
                        return (
                          <tr key={a.qbo_id}
                            style={{ borderBottom: "1px solid var(--border)" }}
                            className="transition-colors"
                            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
                            onMouseLeave={(e) => (e.currentTarget.style.background = "")}
                          >
                            <td className="px-3 py-2.5 font-mono text-xs" style={{ color: "var(--text-2)" }}>
                              {a.account_number || "—"}
                            </td>
                            <td className="px-3 py-2.5">
                              <span className="text-sm font-medium text-theme">{a.account_name}</span>
                            </td>
                            <td className="px-3 py-2.5">
                              <span className="inline-flex items-center gap-1 text-[11px] font-medium">
                                <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
                                <span style={{ color: "var(--text-2)" }}>{a.group_label}</span>
                              </span>
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums text-sm text-theme">
                              {fmtMoney(a.gl_balance)}
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums text-sm" style={{ color: "var(--text-2)" }}>
                              {fmtMoney(a.subledger_balance)}
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums text-sm font-medium"
                              style={{ color: hasVariance ? "#dc2626" : "var(--green)" }}>
                              {hasVariance ? fmtMoney(a.variance) : "—"}
                            </td>
                            <td className="px-3 py-2.5">
                              <div className="flex items-center justify-end gap-1.5">
                                <button
                                  onClick={() => openSubledger(a)}
                                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors"
                                  style={{
                                    color: "var(--text-2)",
                                    border: "1px solid var(--border-strong)",
                                    background: "var(--surface)",
                                  }}
                                  title="See how this subledger balance was computed"
                                  onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--green)")}
                                  onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--border-strong)")}
                                >
                                  <Eye size={11} strokeWidth={1.8} />
                                  Subledger
                                </button>
                                {hasVariance && (
                                  <button
                                    onClick={() => openVariance(a)}
                                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors"
                                    style={{
                                      color: "#b91c1c",
                                      border: "1px solid #fecaca",
                                      background: "#fef2f2",
                                    }}
                                    title="See transactions likely causing the variance"
                                  >
                                    <GitCompareArrows size={11} strokeWidth={1.8} />
                                    Variance
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="px-4 py-2.5 flex items-center justify-between flex-wrap gap-2"
                style={{ borderTop: "1px solid var(--border)", background: "var(--surface-2)" }}>
                <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                  Showing {filteredAccounts.length} of {overview?.accounts.length ?? 0} accounts
                  {overview?.period_end ? ` as of ${overview.period_end}` : ""}
                  {lastSynced ? ` · ${lastSynced}` : ""}.
                </p>
                <a
                  href="/docs/reconciliations.md"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] inline-flex items-center gap-1 transition-opacity hover:opacity-80"
                  style={{ color: "var(--green)" }}
                >
                  How this works
                  <ExternalLink size={10} strokeWidth={1.8} />
                </a>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── Side drawers ─────────────────────────────────────────────── */}
      <AnimatePresence>
        {drawerAccount && (
          <DetailDrawer
            account={drawerAccount}
            mode={drawerMode}
            periodEnd={periodEnd}
            onClose={() => setDrawerAccount(null)}
            onSwitchMode={(m) => setDrawerMode(m)}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

// ── KPI tile ────────────────────────────────────────────────────────────────

function Kpi({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="rounded-xl p-4"
      style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
      <p className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>{label}</p>
      <p className="text-xl sm:text-2xl font-bold tabular-nums mt-1" style={{ color: tone }}>{value}</p>
    </div>
  )
}

// ── Detail drawer (subledger + variance share one drawer for context) ───────

interface DrawerProps {
  account:     OverviewAccount
  mode:        "subledger" | "variance"
  periodEnd:   string
  onClose:     () => void
  onSwitchMode:(m: "subledger" | "variance") => void
}

function DetailDrawer({ account, mode, periodEnd, onClose, onSwitchMode }: DrawerProps) {
  const variance = parseFloat(account.variance)
  const hasVariance = Math.abs(variance) >= 0.5

  const { data: subledger, isLoading: subLoading } = useQuery<SubledgerDetail>({
    queryKey: ["recon-subledger", account.qbo_id, periodEnd],
    queryFn:  () => reconsApi.getAccountSubledger(account.qbo_id, periodEnd),
    enabled:  mode === "subledger",
  })

  const { data: varianceDetail, isLoading: varLoading } = useQuery<VarianceDetail>({
    queryKey: ["recon-variance", account.qbo_id, periodEnd],
    queryFn:  () => reconsApi.getAccountVariance(account.qbo_id, periodEnd),
    enabled:  mode === "variance",
  })

  return (
    <>
      {/* Backdrop */}
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
        className="fixed inset-0 z-50"
        style={{ background: "rgba(0,0,0,0.45)" }}
        onClick={onClose}
      />
      {/* Panel */}
      <motion.aside
        initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }}
        transition={{ duration: 0.25, ease: "easeOut" }}
        className="fixed top-0 right-0 bottom-0 z-50 w-full sm:w-[480px] lg:w-[560px] flex flex-col"
        style={{ background: "var(--surface)", borderLeft: "1px solid var(--border)" }}
      >
        {/* Header — account number featured prominently so the user can
            cross-reference with the GL or the Flux Analysis screen */}
        <div className="px-5 py-4 flex items-start gap-3"
          style={{ borderBottom: "1px solid var(--border)" }}>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[11px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                {account.group_label}
              </span>
              {account.account_number && (
                <span className="text-[11px] font-mono px-1.5 py-0.5 rounded"
                  style={{ background: "var(--surface-2)", color: "var(--text-2)" }}>
                  Acct No. {account.account_number}
                </span>
              )}
            </div>
            <h3 className="text-base font-semibold text-theme truncate">{account.account_name}</h3>
            <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
              GL {fmtMoney(account.gl_balance)} · Subledger {fmtMoney(account.subledger_balance)}
              {hasVariance && (
                <> · <span style={{ color: "#dc2626" }}>Variance {fmtMoney(account.variance)}</span></>
              )}
            </p>
          </div>
          <button onClick={onClose}
            className="h-8 w-8 rounded-md flex items-center justify-center transition-colors"
            style={{ color: "var(--text-muted)" }}>
            <X size={16} strokeWidth={1.8} />
          </button>
        </div>

        {/* Mode tabs */}
        <div className="px-5 pt-3 pb-1 flex items-center gap-1"
          style={{ borderBottom: "1px solid var(--border)" }}>
          <ModeTab active={mode === "subledger"} onClick={() => onSwitchMode("subledger")}
            icon={<Eye size={12} strokeWidth={1.8} />} label="Subledger detail" />
          <ModeTab active={mode === "variance"} onClick={() => onSwitchMode("variance")}
            icon={<GitCompareArrows size={12} strokeWidth={1.8} />}
            label="Variance reasons"
            badge={hasVariance ? "!" : undefined} />
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {mode === "subledger" ? (
            <SubledgerBody subledger={subledger} loading={subLoading} />
          ) : (
            <VarianceBody
              variance={varianceDetail}
              loading={varLoading}
              expectedVariance={account.variance}
            />
          )}
        </div>
      </motion.aside>
    </>
  )
}

function ModeTab({ active, onClick, icon, label, badge }:
  { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; badge?: string }
) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors"
      style={{
        color: active ? "var(--text)" : "var(--text-muted)",
        borderBottom: `2px solid ${active ? "var(--green)" : "transparent"}`,
        marginBottom: "-1px",
      }}
    >
      {icon}
      {label}
      {badge && (
        <span className="inline-flex items-center justify-center h-4 min-w-[16px] px-1 rounded-full text-[9px] font-bold"
          style={{ background: "#fee2e2", color: "#b91c1c" }}>
          {badge}
        </span>
      )}
    </button>
  )
}

function SubledgerBody({ subledger, loading }: { subledger?: SubledgerDetail; loading: boolean }) {
  if (loading) {
    return <div className="py-12 flex items-center justify-center"><Spinner className="h-5 w-5" /></div>
  }
  if (!subledger) return null
  const isAging = subledger.account?.account_type === "Accounts Receivable" || subledger.account?.account_type === "Accounts Payable"

  return (
    <div className="space-y-3">
      <div className="rounded-lg p-3 flex items-start gap-2"
        style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
        <Sparkles size={12} strokeWidth={1.8} style={{ color: "var(--green)" }} className="shrink-0 mt-0.5" />
        <p className="text-xs leading-snug text-theme">{subledger.source}</p>
      </div>

      {subledger.rows.length === 0 ? (
        <div className="py-8 text-center">
          <CheckCircle2 size={24} strokeWidth={1.6} style={{ color: "var(--text-muted)" }} className="mx-auto mb-2" />
          <p className="text-sm font-medium text-theme">No subledger rows for this period.</p>
          <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
            QuickBooks returned no detail rows. The account balance still ties to the GL.
          </p>
        </div>
      ) : isAging ? (() => {
        // Compute aging totals for the footer row
        const totals = subledger.rows.reduce((acc, r) => ({
          current: acc.current + parseFloat(r.current ?? "0"),
          a1_30:   acc.a1_30   + parseFloat(r["1_30"] ?? "0"),
          a31_60:  acc.a31_60  + parseFloat(r["31_60"] ?? "0"),
          a61_90:  acc.a61_90  + parseFloat(r["61_90"] ?? "0"),
          over90:  acc.over90  + parseFloat(r.over_90 ?? "0"),
          total:   acc.total   + parseFloat(r.total ?? "0"),
        }), { current: 0, a1_30: 0, a31_60: 0, a61_90: 0, over90: 0, total: 0 })
        return (
          <table className="w-full text-xs">
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                <th className="text-left py-2 px-2 font-semibold" style={{ color: "var(--text-muted)" }}>Entity</th>
                <th className="text-right py-2 px-1 font-semibold" style={{ color: "var(--text-muted)" }}>Current</th>
                <th className="text-right py-2 px-1 font-semibold" style={{ color: "var(--text-muted)" }}>1-30</th>
                <th className="text-right py-2 px-1 font-semibold" style={{ color: "var(--text-muted)" }}>31-60</th>
                <th className="text-right py-2 px-1 font-semibold" style={{ color: "var(--text-muted)" }}>61-90</th>
                <th className="text-right py-2 px-1 font-semibold" style={{ color: "var(--text-muted)" }}>&gt; 90</th>
                <th className="text-right py-2 px-2 font-semibold" style={{ color: "var(--text)" }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {subledger.rows.map((r, i) => (
                <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td className="py-2 px-2 text-theme font-medium">{r.label}</td>
                  <td className="text-right py-2 px-1 tabular-nums">{fmtMoney(r.current ?? "0")}</td>
                  <td className="text-right py-2 px-1 tabular-nums">{fmtMoney(r["1_30"] ?? "0")}</td>
                  <td className="text-right py-2 px-1 tabular-nums">{fmtMoney(r["31_60"] ?? "0")}</td>
                  <td className="text-right py-2 px-1 tabular-nums"
                    style={{ color: parseFloat(r["61_90"] ?? "0") > 0 ? "#92400e" : "inherit" }}>
                    {fmtMoney(r["61_90"] ?? "0")}
                  </td>
                  <td className="text-right py-2 px-1 tabular-nums"
                    style={{ color: parseFloat(r.over_90 ?? "0") > 0 ? "#dc2626" : "inherit" }}>
                    {fmtMoney(r.over_90 ?? "0")}
                  </td>
                  <td className="text-right py-2 px-2 tabular-nums font-semibold text-theme">
                    {fmtMoney(r.total ?? "0")}
                  </td>
                </tr>
              ))}
            </tbody>
            {/* Footer totals — sum every aging bucket so the user can spot-check */}
            <tfoot>
              <tr style={{ background: "var(--surface-2)", borderTop: "2px solid var(--border-strong)" }}>
                <td className="py-2 px-2 font-bold text-theme">Total ({subledger.rows.length})</td>
                <td className="text-right py-2 px-1 tabular-nums font-bold text-theme">{fmtMoney(totals.current)}</td>
                <td className="text-right py-2 px-1 tabular-nums font-bold text-theme">{fmtMoney(totals.a1_30)}</td>
                <td className="text-right py-2 px-1 tabular-nums font-bold text-theme">{fmtMoney(totals.a31_60)}</td>
                <td className="text-right py-2 px-1 tabular-nums font-bold"
                  style={{ color: totals.a61_90 > 0 ? "#92400e" : "var(--text)" }}>
                  {fmtMoney(totals.a61_90)}
                </td>
                <td className="text-right py-2 px-1 tabular-nums font-bold"
                  style={{ color: totals.over90 > 0 ? "#dc2626" : "var(--text)" }}>
                  {fmtMoney(totals.over90)}
                </td>
                <td className="text-right py-2 px-2 tabular-nums font-bold text-theme">{fmtMoney(totals.total)}</td>
              </tr>
            </tfoot>
          </table>
        )
      })() : (() => {
        const total = subledger.rows.reduce((n, r) => n + parseFloat(r.amount ?? r.total ?? "0"), 0)
        return (
          <table className="w-full text-xs">
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                <th className="text-left py-2 px-2 font-semibold" style={{ color: "var(--text-muted)" }}>Type</th>
                <th className="text-left py-2 px-2 font-semibold" style={{ color: "var(--text-muted)" }}>#</th>
                <th className="text-left py-2 px-2 font-semibold" style={{ color: "var(--text-muted)" }}>Date</th>
                <th className="text-right py-2 px-2 font-semibold" style={{ color: "var(--text)" }}>Amount</th>
                <th className="text-left py-2 px-2 font-semibold" style={{ color: "var(--text-muted)" }}>Memo</th>
              </tr>
            </thead>
            <tbody>
              {subledger.rows.map((r, i) => (
                <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td className="py-2 px-2 text-theme">{r.txn_type || r.label}</td>
                  <td className="py-2 px-2 font-mono" style={{ color: "var(--text-2)" }}>{r.txn_number || "—"}</td>
                  <td className="py-2 px-2" style={{ color: "var(--text-2)" }}>{r.txn_date || "—"}</td>
                  <td className="text-right py-2 px-2 tabular-nums font-medium text-theme">{fmtMoney(r.amount ?? "0")}</td>
                  <td className="py-2 px-2 truncate max-w-[180px]" style={{ color: "var(--text-muted)" }}>{r.memo || "—"}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ background: "var(--surface-2)", borderTop: "2px solid var(--border-strong)" }}>
                <td className="py-2 px-2 font-bold text-theme" colSpan={3}>Total ({subledger.rows.length} txns)</td>
                <td className="text-right py-2 px-2 tabular-nums font-bold text-theme">{fmtMoney(total)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        )
      })()}
    </div>
  )
}

function VarianceBody({ variance, loading, expectedVariance }:
  { variance?: VarianceDetail; loading: boolean; expectedVariance: string }
) {
  if (loading) {
    return <div className="py-12 flex items-center justify-center"><Spinner className="h-5 w-5" /></div>
  }
  if (!variance) return null

  const sum = variance.rows.reduce((n, r) => n + (parseFloat(r.amount) || 0), 0)
  const expected = parseFloat(expectedVariance) || 0
  const diff = sum - expected
  const inSync = Math.abs(diff) < 1

  return (
    <div className="space-y-3">
      <div className="rounded-lg p-3 flex items-start gap-2"
        style={{ background: "#fef2f2", border: "1px solid #fecaca" }}>
        <AlertCircle size={12} strokeWidth={1.8} style={{ color: "#b91c1c" }} className="shrink-0 mt-0.5" />
        <p className="text-xs leading-snug" style={{ color: "#b91c1c" }}>{variance.source}</p>
      </div>

      {variance.rows.length === 0 ? (
        <div className="py-8 text-center">
          <Zap size={24} strokeWidth={1.6} style={{ color: "var(--text-muted)" }} className="mx-auto mb-2" />
          <p className="text-sm font-medium text-theme">No transactions found in the last 90 days.</p>
          <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
            The gap may be from older activity. Widen the window or check the GL directly.
          </p>
        </div>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <th className="text-left py-2 px-2 font-semibold" style={{ color: "var(--text-muted)" }}>Type</th>
              <th className="text-left py-2 px-2 font-semibold" style={{ color: "var(--text-muted)" }}>#</th>
              <th className="text-left py-2 px-2 font-semibold" style={{ color: "var(--text-muted)" }}>Date</th>
              <th className="text-left py-2 px-2 font-semibold" style={{ color: "var(--text-muted)" }}>Entity</th>
              <th className="text-right py-2 px-2 font-semibold" style={{ color: "var(--text)" }}>Amount</th>
              <th className="text-left py-2 px-2 font-semibold" style={{ color: "var(--text-muted)" }}>Memo</th>
            </tr>
          </thead>
          <tbody>
            {variance.rows.map((r, i) => {
              const flagged = r.flag === "no_entity_ref"
              return (
                <tr key={i} style={{
                  borderBottom: "1px solid var(--border)",
                  background: flagged ? "rgba(245, 158, 11, 0.08)" : "transparent",
                }}
                  title={flagged ? "Journal entry without a customer/vendor ref — likely cause of the gap" : ""}
                >
                  <td className="py-2 px-2 text-theme">{r.txn_type}</td>
                  <td className="py-2 px-2 font-mono" style={{ color: "var(--text-2)" }}>{r.txn_number || "—"}</td>
                  <td className="py-2 px-2" style={{ color: "var(--text-2)" }}>{r.txn_date || "—"}</td>
                  <td className="py-2 px-2 truncate max-w-[110px]" style={{ color: "var(--text-2)" }}>
                    {r.entity || (flagged ? <span style={{ color: "#92400e", fontStyle: "italic" }}>no ref</span> : "—")}
                  </td>
                  <td className="text-right py-2 px-2 tabular-nums font-medium text-theme">{fmtMoney(r.amount)}</td>
                  <td className="py-2 px-2 truncate max-w-[160px]" style={{ color: "var(--text-muted)" }}>{r.memo || "—"}</td>
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr style={{ background: "var(--surface-2)", borderTop: "2px solid var(--border-strong)" }}>
              <td className="py-2 px-2 font-bold text-theme" colSpan={4}>Sum of activity (last 90 days)</td>
              <td className="text-right py-2 px-2 tabular-nums font-bold text-theme">{fmtMoney(sum)}</td>
              <td />
            </tr>
            <tr style={{ background: "var(--surface-2)" }}>
              <td className="py-1.5 px-2 text-xs" style={{ color: "var(--text-muted)" }} colSpan={4}>
                GL variance for this account
              </td>
              <td className="text-right py-1.5 px-2 tabular-nums text-xs" style={{ color: "var(--text-2)" }}>
                {fmtMoney(expectedVariance)}
              </td>
              <td />
            </tr>
            <tr style={{
              background: inSync ? "var(--green-subtle)" : "#fef2f2",
              borderTop: "1px solid var(--border)",
            }}>
              <td className="py-2 px-2 text-xs font-semibold"
                style={{ color: inSync ? "var(--green)" : "#b91c1c" }} colSpan={4}>
                {inSync ? "Activity ties to the variance" : "Activity does not tie — unexplained gap"}
              </td>
              <td className="text-right py-2 px-2 tabular-nums font-bold"
                style={{ color: inSync ? "var(--green)" : "#b91c1c" }}>
                {inSync
                  ? <CheckCircle2 size={14} strokeWidth={2} className="inline" />
                  : fmtMoney(diff)
                }
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      )}
    </div>
  )
}
