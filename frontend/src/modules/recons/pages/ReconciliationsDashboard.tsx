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
import { Fragment, useEffect, useMemo, useRef, useState } from "react"
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
  Upload,
  Plus,
  Edit2,
  FileText,
  Download,
  ShieldCheck,
  Lock,
  Unlock,
} from "lucide-react"
import { Button, Spinner } from "@/core/ui/components"
import {
  reconsApi,
  type Overview,
  type OverviewAccount,
  type SubledgerDetail,
  type VarianceDetail,
  type AccountReviewStatus,
  type ReconcilingItem,
  type EvidenceVerification,
} from "@/modules/recons/api"
import { workspaceApi } from "@/modules/workspace/api"
import { useUserNames } from "@/modules/workspace/hooks"
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
  // Seed period from ?period=YYYY-MM-DD when the user navigated here
  // from the dashboard's month-end tracker.
  const initialPeriod = (() => {
    const sp = new URLSearchParams(window.location.search).get("period")
    return sp && /^\d{4}-\d{2}-\d{2}$/.test(sp) ? sp : defaultPeriodEnd()
  })()
  const [periodEnd, setPeriodEnd] = useState<string>(initialPeriod)
  const [search, setSearch] = useState("")
  const [groupFilter, setGroupFilter] = useState<string>("all")
  const [showOnlyVariance, setShowOnlyVariance] = useState(false)
  /** Status bucket the user is currently looking at. "open" = pending or
   *  flagged (the close-in-progress queue). "reviewed" / "approved" are
   *  done buckets. "all" shows everything. When you approve a row in
   *  "open" it disappears from the list and shows up under "approved" — */
  const [statusBucket, setStatusBucket] = useState<"open" | "reviewed" | "approved" | "all">("open")
  const [drawerAccount, setDrawerAccount] = useState<OverviewAccount | null>(null)
  const [drawerMode, setDrawerMode] = useState<"subledger" | "variance">("subledger")
  const [confirmClear, setConfirmClear] = useState(false)
  /** qbo_account_id of the row currently expanded inline (null = all collapsed). */
  const [expandedAccountId, setExpandedAccountId] = useState<string | null>(null)
  /** Set of qbo_account_ids the user has checked for bulk actions */
  const [selected, setSelected] = useState<Set<string>>(new Set())
  /** "Synced N accounts at HH:MM" — banner that fades out after a few seconds */
  const [syncMsg, setSyncMsg] = useState<string | null>(null)

  const { data: qbo } = useQuery({
    queryKey: ["qbo-connection"],
    queryFn:  fluxApi.getQboConnection,
    staleTime: 60_000,
  })

  // Current user's role — gates the visibility of Approve / Reviewed / Flag
  // buttons in the bulk toolbar (preparers don't see them).
  const { data: me } = useQuery({
    queryKey: ["workspace-me"],
    queryFn:  workspaceApi.getMe,
    staleTime: 60_000,
  })
  const canReview = me?.role === "admin" || me?.role === "reviewer"
  const isAdmin = me?.role === "admin"

  // Manual-fetch only. We never auto-pull from QBO on mount or period change —
  // every sync is an explicit user action. `enabled: false` keeps the query
  // dormant; handleSync() drives it via refetch().
  const { data: overview, isFetching, refetch, dataUpdatedAt } = useQuery({
    queryKey: ["recons-overview", periodEnd],
    queryFn:  () => reconsApi.getOverview(periodEnd),
    enabled:  false,
    staleTime: Infinity,
  })

  // Closed-period flag flows through from /overview. When true, the entire
  // dashboard goes read-only — bulk actions hidden, status chips frozen,
  // inline forms collapsed, banner shown.
  const isClosed = overview?.is_closed === true
  const closedByName = useUserNames([overview?.closed_by])[overview?.closed_by ?? ""]
  const allApproved = !!overview && overview.accounts.length > 0
    && overview.accounts.every((a) => a.review_status === "approved")

  const closeMut = useMutation({
    mutationFn: () => reconsApi.closePeriod(periodEnd),
    onSuccess: () => {
      setSyncMsg(`Period ${periodEnd} closed. Books are now locked.`)
      qc.invalidateQueries({ queryKey: ["recons-overview", periodEnd] })
      qc.invalidateQueries({ queryKey: ["closed-periods"] })
    },
    onError: (err: unknown) => {
      const ex = err as { response?: { data?: { detail?: string } }; message?: string }
      setSyncMsg(`Sync failed: ${ex.response?.data?.detail ?? ex.message ?? "Could not close period"}`)
    },
  })

  const reopenMut = useMutation({
    mutationFn: () => reconsApi.reopenPeriod(periodEnd),
    onSuccess: () => {
      setSyncMsg(`Period ${periodEnd} reopened.`)
      qc.invalidateQueries({ queryKey: ["recons-overview", periodEnd] })
      qc.invalidateQueries({ queryKey: ["closed-periods"] })
    },
    onError: (err: unknown) => {
      const ex = err as { response?: { data?: { detail?: string } }; message?: string }
      setSyncMsg(`Sync failed: ${ex.response?.data?.detail ?? ex.message ?? "Could not reopen period"}`)
    },
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

  // Clear bulk selection when the period changes — those rows belong to a
  // different period now.
  useEffect(() => { setSelected(new Set()) }, [periodEnd])

  // Auto-collapse any expanded inline form when the period goes from
  // unlocked → locked. Avoids showing an editable form on a frozen period.
  useEffect(() => {
    if (isClosed) {
      setExpandedAccountId(null)
      setSelected(new Set())
    }
  }, [isClosed])

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

  /**
   * Per-row status flip (used inline + when no rows are selected).
   *
   * The overview query is manual-sync only (`enabled: false`, `staleTime: Infinity`),
   * so a plain `invalidateQueries` after the mutation does nothing — the
   * cache stays stale until the user clicks Sync. Instead we optimistically
   * patch the cached overview the moment the mutation fires so the row
   * jumps to its new bucket immediately; rollback on error.
   */
  const setStatusMut = useMutation({
    mutationFn: (v: { id: string; status: AccountReviewStatus }) =>
      reconsApi.updateAccountReviewStatus(v.id, periodEnd, v.status),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ["recons-overview", periodEnd] })
      const prev = qc.getQueryData<Overview>(["recons-overview", periodEnd])
      if (prev) {
        const nowIso = new Date().toISOString()
        qc.setQueryData<Overview>(["recons-overview", periodEnd], {
          ...prev,
          accounts: prev.accounts.map((a) =>
            a.qbo_id === v.id
              ? {
                  ...a,
                  review_status: v.status,
                  reviewed_at: v.status === "pending" ? null : nowIso,
                }
              : a,
          ),
        })
      }
      return { prev }
    },
    onError: (err: unknown, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["recons-overview", periodEnd], ctx.prev)
      const ex = err as { response?: { data?: { detail?: string } }; message?: string }
      // Surface maker/checker rejection (403) clearly via the sync banner —
      // it's the same channel the user already watches for errors.
      setSyncMsg(`Status update failed: ${ex.response?.data?.detail ?? ex.message ?? "Unknown"}`)
    },
  })

  /** Manual subledger override — used by the inline editor below. */
  const subledgerMut = useMutation({
    mutationFn: (v: {
      qboId: string
      total: number | null
      source: string | null
      items?: ReconcilingItem[]
    }) =>
      reconsApi.setSubledgerOverride(v.qboId, periodEnd, v.total, v.source, v.items),
    onSuccess: (_data, v) => {
      setExpandedAccountId(null)
      // Optimistic patch so the manual badge / value flips immediately.
      const prev = qc.getQueryData<Overview>(["recons-overview", periodEnd])
      if (prev) {
        qc.setQueryData<Overview>(["recons-overview", periodEnd], {
          ...prev,
          accounts: prev.accounts.map((a) =>
            a.qbo_id === v.qboId
              ? {
                  ...a,
                  subledger_is_manual: v.total !== null,
                  subledger_balance:   v.total !== null ? String(v.total) : a.gl_balance,
                  subledger_source:    v.total !== null ? (v.source ?? a.subledger_source) : a.subledger_source,
                  reconciling_items:   v.items ?? [],
                  variance:            v.total !== null
                                        ? String((parseFloat(a.gl_balance) - v.total).toFixed(2))
                                        : "0.00",
                  subledger_entered_at: v.total !== null ? new Date().toISOString() : null,
                }
              : a,
          ),
        })
      }
    },
  })

  /** Bulk status flip for all selected accounts. */
  const bulkStatusMut = useMutation({
    mutationFn: (status: AccountReviewStatus) =>
      reconsApi.bulkUpdateAccountReviewStatus(periodEnd, status, Array.from(selected)),
    onMutate: async (status) => {
      await qc.cancelQueries({ queryKey: ["recons-overview", periodEnd] })
      const prev = qc.getQueryData<Overview>(["recons-overview", periodEnd])
      if (prev) {
        const ids = selected
        const nowIso = new Date().toISOString()
        qc.setQueryData<Overview>(["recons-overview", periodEnd], {
          ...prev,
          accounts: prev.accounts.map((a) =>
            ids.has(a.qbo_id)
              ? {
                  ...a,
                  review_status: status,
                  reviewed_at: status === "pending" ? null : nowIso,
                }
              : a,
          ),
        })
      }
      return { prev }
    },
    onSuccess: () => setSelected(new Set()),
    onError: (err: unknown, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["recons-overview", periodEnd], ctx.prev)
      const ex = err as { response?: { data?: { detail?: string } }; message?: string }
      setSyncMsg(`Bulk update failed: ${ex.response?.data?.detail ?? ex.message ?? "Unknown"}`)
    },
  })

  // Counts per status bucket — used for the tab labels and for filtering.
  const bucketCounts = useMemo(() => {
    const c = { open: 0, reviewed: 0, approved: 0, all: overview?.accounts.length ?? 0 }
    overview?.accounts.forEach((a) => {
      if (a.review_status === "approved") c.approved++
      else if (a.review_status === "reviewed") c.reviewed++
      else c.open++  // pending and flagged
    })
    return c
  }, [overview])

  function inBucket(a: OverviewAccount): boolean {
    if (statusBucket === "all") return true
    if (statusBucket === "approved") return a.review_status === "approved"
    if (statusBucket === "reviewed") return a.review_status === "reviewed"
    // "open" = pending or flagged (whatever the close team still needs to act on)
    return a.review_status === "pending" || a.review_status === "flagged"
  }

  // Filtered + searched account list
  const filteredAccounts = useMemo(() => {
    if (!overview) return [] as OverviewAccount[]
    const q = search.trim().toLowerCase()
    return overview.accounts.filter((a) => {
      if (!inBucket(a)) return false
      if (groupFilter !== "all" && a.group_label !== groupFilter) return false
      if (showOnlyVariance && Math.abs(parseFloat(a.variance)) < 0.5) return false
      if (q && !(a.account_name.toLowerCase().includes(q) || a.account_number.toLowerCase().includes(q))) return false
      return true
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview, search, groupFilter, showOnlyVariance, statusBucket])

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
            {isAdmin && (
              isClosed ? (
                <Button
                  size="sm"
                  variant="outline"
                  icon={<Unlock size={14} strokeWidth={1.8} />}
                  loading={reopenMut.isPending}
                  onClick={() => reopenMut.mutate()}
                  style={{ borderColor: "#f59e0b", color: "#b45309" }}
                  title="Reopen the books for this period — admins can edit again"
                >
                  <span className="hidden sm:inline">Reopen books</span>
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  icon={<Lock size={14} strokeWidth={1.8} />}
                  loading={closeMut.isPending}
                  disabled={!allApproved}
                  onClick={() => {
                    if (confirm(`Close the books for ${periodEnd}? Once locked, reviewers and preparers can't edit anything for this period.`)) {
                      closeMut.mutate()
                    }
                  }}
                  title={allApproved
                    ? "Lock the period so nobody can edit it anymore"
                    : "All accounts must be approved before you can close the period"}
                >
                  <span className="hidden sm:inline">Close period</span>
                </Button>
              )
            )}
            <Button
              size="sm"
              variant="outline"
              icon={<ShieldCheck size={14} strokeWidth={1.8} />}
              onClick={() => navigate("/app/reconciliations/overrides")}
              title="Review every manual subledger value entered for any account"
            >
              <span className="hidden sm:inline">Overrides</span>
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

        {/* ── Books-closed banner — prominent, locks the dashboard ── */}
        {isClosed && overview && (
          <div className="rounded-xl overflow-hidden"
            style={{
              background: "linear-gradient(135deg, var(--surface-2) 0%, var(--surface) 100%)",
              border: "1px solid var(--border-strong)",
              boxShadow: "var(--card-shadow)",
            }}>
            <div className="flex items-center gap-4 p-5">
              <div className="h-12 w-12 rounded-full flex items-center justify-center shrink-0"
                style={{
                  background: "rgba(245, 158, 11, 0.15)",
                  border: "2px solid #f59e0b",
                }}>
                <Lock size={20} strokeWidth={2} style={{ color: "#b45309" }} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-wider mb-0.5"
                  style={{ color: "#b45309" }}>
                  Books closed
                </p>
                <h3 className="text-lg sm:text-xl font-bold text-theme leading-tight">
                  Period {overview.period_end} is locked
                </h3>
                <p className="text-xs mt-1" style={{ color: "var(--text-2)" }}>
                  Closed by <span className="font-semibold text-theme">{closedByName || "an admin"}</span>
                  {overview.closed_at && (
                    <> on {new Date(overview.closed_at).toLocaleDateString(undefined, {
                      year: "numeric", month: "long", day: "numeric",
                    })}</>
                  )}.
                  All reconciliations are frozen — reviewers and preparers can view but not edit.
                </p>
                {overview.closed_notes && (
                  <p className="text-xs mt-1.5 italic" style={{ color: "var(--text-muted)" }}>
                    "{overview.closed_notes}"
                  </p>
                )}
              </div>
              {isAdmin && (
                <Button
                  size="sm"
                  variant="outline"
                  icon={<Unlock size={12} strokeWidth={1.8} />}
                  loading={reopenMut.isPending}
                  onClick={() => reopenMut.mutate()}
                  style={{ borderColor: "#f59e0b", color: "#b45309" }}>
                  Reopen
                </Button>
              )}
            </div>
            <div className="px-5 py-2 flex items-center gap-2 flex-wrap"
              style={{ borderTop: "1px solid var(--border)", background: "var(--surface-2)" }}>
              <CheckCircle2 size={12} strokeWidth={2} style={{ color: "var(--green)" }} />
              <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                {overview.accounts.length} account{overview.accounts.length === 1 ? "" : "s"} approved
                · Total GL {fmtMoney(overview.totals.gl)}
                · Variance {fmtMoney(overview.totals.variance)}
              </span>
            </div>
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

            {/* Status buckets — clicking Approve on a row moves it from
                Open to Approved, so the close-in-progress queue stays
                clean. Default lands on Open so reviewers immediately see
                "what's left to do" for the period. */}
            <div className="flex items-center gap-1 flex-wrap rounded-lg p-1"
              style={{ background: "var(--surface-2)", border: "1px solid var(--border)", width: "fit-content" }}>
              {([
                { key: "open",     label: "Open",     fg: "#b91c1c", bg: "#fef2f2" },
                { key: "reviewed", label: "Reviewed", fg: "#1d4ed8", bg: "#dbeafe" },
                { key: "approved", label: "Approved", fg: "var(--green)", bg: "var(--green-subtle)" },
                { key: "all",      label: "All",      fg: "var(--text)", bg: "var(--surface)" },
              ] as const).map((b) => {
                const active = statusBucket === b.key
                const count = bucketCounts[b.key]
                return (
                  <button
                    key={b.key}
                    onClick={() => { setStatusBucket(b.key); setSelected(new Set()) }}
                    className="inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-all"
                    style={{
                      background: active ? b.bg   : "transparent",
                      color:      active ? b.fg   : "var(--text-muted)",
                    }}
                  >
                    {b.label}
                    <span className="text-[10px] tabular-nums opacity-80">
                      {count}
                    </span>
                  </button>
                )
              })}
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
                      : statusBucket === "open" && bucketCounts.open === 0
                        ? "All open items cleared for this period."
                        : "No accounts match your filters."}
                  </p>
                  <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                    {overview?.accounts.length === 0
                      ? "Try a different period end, or sync again."
                      : statusBucket === "open" && bucketCounts.open === 0
                        ? `${bucketCounts.approved} approved · ${bucketCounts.reviewed} reviewed.`
                        : "Try clearing the search or switching the status bucket."}
                  </p>
                </div>
              ) : (
                <>
                  {/* Bulk-action toolbar — only when rows are selected */}
                  {selected.size > 0 && (
                    <div className="px-4 py-2 flex items-center gap-2 flex-wrap"
                      style={{ background: "var(--green-subtle)", borderBottom: "1px solid var(--border)" }}>
                      <span className="text-[11px] font-semibold" style={{ color: "var(--green)" }}>
                        {selected.size} selected
                      </span>
                      {canReview && (
                        <>
                          <Button size="sm" icon={<CheckCircle2 size={11} strokeWidth={1.8} />}
                            loading={bulkStatusMut.isPending}
                            onClick={() => bulkStatusMut.mutate("approved")}
                          >
                            Approve
                          </Button>
                          <Button size="sm" variant="outline" icon={<Eye size={11} strokeWidth={1.8} />}
                            loading={bulkStatusMut.isPending}
                            onClick={() => bulkStatusMut.mutate("reviewed")}
                          >
                            Mark reviewed
                          </Button>
                          <Button size="sm" variant="outline" icon={<AlertTriangle size={11} strokeWidth={1.8} />}
                            loading={bulkStatusMut.isPending}
                            onClick={() => bulkStatusMut.mutate("flagged")}
                            style={{ borderColor: "#fecaca", color: "#b91c1c" }}
                          >
                            Flag
                          </Button>
                        </>
                      )}
                      {!canReview && (
                        <span className="text-[11px] italic" style={{ color: "var(--text-muted)" }}>
                          Ask a reviewer to approve / flag selected accounts.
                        </span>
                      )}
                      <Button size="sm" variant="ghost"
                        loading={bulkStatusMut.isPending}
                        onClick={() => bulkStatusMut.mutate("pending")}
                      >
                        Reset to pending
                      </Button>
                      <button
                        onClick={() => setSelected(new Set())}
                        className="ml-auto text-[11px] font-medium"
                        style={{ color: "var(--text-muted)" }}
                      >
                        Clear selection
                      </button>
                    </div>
                  )}

                  <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr style={{
                        background: "var(--surface-2)",
                        borderBottom: "1px solid var(--border)",
                      }}>
                        <th className="px-3 py-2.5 text-center" style={{ width: 32 }}>
                          <input
                            type="checkbox"
                            aria-label="Select all visible"
                            checked={filteredAccounts.length > 0 && filteredAccounts.every((a) => selected.has(a.qbo_id))}
                            ref={(el) => {
                              if (!el) return
                              const someChecked = filteredAccounts.some((a) => selected.has(a.qbo_id))
                              const allChecked  = filteredAccounts.every((a) => selected.has(a.qbo_id))
                              el.indeterminate = someChecked && !allChecked
                            }}
                            onChange={() => {
                              const allChecked = filteredAccounts.every((a) => selected.has(a.qbo_id))
                              if (allChecked) {
                                const next = new Set(selected)
                                filteredAccounts.forEach((a) => next.delete(a.qbo_id))
                                setSelected(next)
                              } else {
                                const next = new Set(selected)
                                filteredAccounts.forEach((a) => next.add(a.qbo_id))
                                setSelected(next)
                              }
                            }}
                          />
                        </th>
                        {[
                          { label: "Account No.", w: "100px" },
                          { label: "Account", w: "auto" },
                          { label: "Type", w: "130px" },
                          { label: "GL Balance", w: "120px", right: true },
                          { label: "Subledger", w: "120px", right: true },
                          { label: "Variance", w: "120px", right: true },
                          { label: "Attachments", w: "100px", center: true },
                          { label: "Status", w: "120px" },
                          { label: "", w: "120px" },
                        ].map((h, i) => (
                          <th
                            key={i}
                            className="text-[10px] font-semibold uppercase tracking-wide px-3 py-2.5"
                            style={{
                              color: "var(--text-muted)",
                              textAlign: h.right ? "right" : h.center ? "center" : "left",
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
                        const isSelected = selected.has(a.qbo_id)
                        const status = a.review_status
                        const isExpanded = expandedAccountId === a.qbo_id
                        return (
                          <Fragment key={a.qbo_id}>
                          <tr
                            onClick={() => !isClosed && setExpandedAccountId(isExpanded ? null : a.qbo_id)}
                            style={{
                              borderBottom: isExpanded ? "none" : "1px solid var(--border)",
                              cursor: isClosed ? "default" : "pointer",
                              background: isSelected
                                ? "var(--green-subtle)"
                                : isExpanded
                                  ? "var(--surface-2)"
                                  : status === "approved"
                                    ? "rgba(16, 185, 129, 0.04)"
                                    : "transparent",
                            }}
                            className="transition-colors"
                            onMouseEnter={(e) => { if (!isSelected && !isExpanded) (e.currentTarget as HTMLElement).style.background = "var(--surface-2)" }}
                            onMouseLeave={(e) => {
                              if (!isSelected && !isExpanded) {
                                (e.currentTarget as HTMLElement).style.background =
                                  status === "approved" ? "rgba(16, 185, 129, 0.04)" : ""
                              }
                            }}
                          >
                            <td className="px-3 py-2.5 text-center" onClick={(e) => e.stopPropagation()}>
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => {
                                  const next = new Set(selected)
                                  if (next.has(a.qbo_id)) next.delete(a.qbo_id)
                                  else next.add(a.qbo_id)
                                  setSelected(next)
                                }}
                                aria-label={`Select ${a.account_name}`}
                              />
                            </td>
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
                            <td className="px-3 py-2.5 text-right text-sm tabular-nums" style={{ color: "var(--text-2)" }}>
                              {fmtMoney(a.subledger_balance)}
                              {a.subledger_is_manual && (
                                <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle"
                                  style={{ background: "var(--green)" }}
                                  title="Subledger saved for this period" />
                              )}
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums text-sm font-medium"
                              style={{ color: hasVariance ? "#dc2626" : "var(--green)" }}>
                              {hasVariance ? fmtMoney(a.variance) : "—"}
                            </td>
                            <td className="px-3 py-2.5 text-center" onClick={(e) => e.stopPropagation()}>
                              <AttachmentsCell files={a.evidence_files ?? []} />
                            </td>
                            <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                              <StatusChip
                                status={status}
                                disabled={isClosed}
                                onChange={(next) => setStatusMut.mutate({ id: a.qbo_id, status: next })}
                              />
                            </td>
                            <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
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
                          {/* Inline expanded form — opens beneath the clicked row
                              instead of a modal. Same fields as before. */}
                          <AnimatePresence initial={false}>
                            {isExpanded && (
                              <motion.tr
                                key={`${a.qbo_id}-expanded`}
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                transition={{ duration: 0.15 }}
                                style={{ borderBottom: "1px solid var(--border)" }}
                              >
                                <td colSpan={10} style={{ padding: 0, background: "var(--surface-2)" }}>
                                  <motion.div
                                    initial={{ height: 0 }}
                                    animate={{ height: "auto" }}
                                    exit={{ height: 0 }}
                                    transition={{ duration: 0.2, ease: "easeOut" }}
                                    style={{ overflow: "hidden" }}
                                  >
                                    <InlineSubledgerForm
                                      account={a}
                                      periodEnd={periodEnd}
                                      saving={subledgerMut.isPending}
                                      onSave={(total, source, items) =>
                                        subledgerMut.mutate({ qboId: a.qbo_id, total, source, items })
                                      }
                                      onClear={() =>
                                        subledgerMut.mutate({ qboId: a.qbo_id, total: null, source: null, items: [] })
                                      }
                                      onClose={() => setExpandedAccountId(null)}
                                    />
                                  </motion.div>
                                </td>
                              </motion.tr>
                            )}
                          </AnimatePresence>
                          </Fragment>
                        )
                      })}
                    </tbody>
                  </table>
                  </div>
                </>
              )}

              <div className="px-4 py-2.5 flex items-center justify-between flex-wrap gap-2"
                style={{ borderTop: "1px solid var(--border)", background: "var(--surface-2)" }}>
                <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                  Showing {filteredAccounts.length} of {overview?.accounts.length ?? 0} accounts
                  {overview?.period_end ? ` as of ${overview.period_end}` : ""}
                  {lastSynced ? ` · ${lastSynced}` : ""}
                  {overview ? ` · ${overview.accounts.filter(a => a.review_status === "approved").length} approved` : ""}.
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

      {/* The manual-subledger editor now opens inline as an expanded row
          inside the table (see InlineSubledgerForm). No modal needed. */}
    </div>
  )
}

// ── StatusChip ──────────────────────────────────────────────────────────────
// Clickable dropdown-style chip. Click to cycle to the next status, or
// shift-click to skip back. Inline flow — no modal, no page navigation.

const STATUS_META: Record<AccountReviewStatus, { label: string; bg: string; fg: string }> = {
  pending:  { label: "Pending",  bg: "var(--surface-2)",     fg: "var(--text-muted)" },
  reviewed: { label: "Reviewed", bg: "#dbeafe",              fg: "#1d4ed8" },
  approved: { label: "Approved", bg: "var(--green-subtle)",  fg: "var(--green)" },
  flagged:  { label: "Flagged",  bg: "#fee2e2",              fg: "#b91c1c" },
}
const STATUS_CYCLE: AccountReviewStatus[] = ["pending", "reviewed", "approved", "flagged"]

function StatusChip({ status, onChange, disabled }:
  { status: AccountReviewStatus; onChange: (next: AccountReviewStatus) => void; disabled?: boolean }
) {
  const m = STATUS_META[status] ?? STATUS_META.pending
  const next = STATUS_CYCLE[(STATUS_CYCLE.indexOf(status) + 1) % STATUS_CYCLE.length]
  return (
    <button
      onClick={() => !disabled && onChange(next)}
      disabled={disabled}
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold transition-all"
      style={{
        background: m.bg, color: m.fg,
        opacity: disabled ? 0.6 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
      title={disabled ? "Period is locked — admin must reopen to change status" : `Click to set → ${STATUS_META[next].label}`}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: m.fg }} />
      {m.label}
    </button>
  )
}

// ── AI verification badge ───────────────────────────────────────────────────
// Renders Anthropic's extraction result with a clear match/mismatch verdict
// against the user-entered subledger value. The match check is computed
// server-side at verify time, but we also surface the *live* delta so if
// the user changes the amount after verifying they see it immediately.

function VerificationBadge({
  verification, enteredAmount, valid, onReverify, reverifying,
}: {
  verification:  EvidenceVerification
  enteredAmount: number
  valid:         boolean
  onReverify:    () => void
  reverifying:   boolean
}) {
  const v = verification
  const extracted = v.extracted_balance ? parseFloat(v.extracted_balance) : null
  const liveDiff =
    valid && extracted !== null && Number.isFinite(extracted)
      ? enteredAmount - extracted
      : null
  const liveStatus: "match" | "mismatch" | "unknown" =
    liveDiff === null ? "unknown" : Math.abs(liveDiff) < 1 ? "match" : "mismatch"

  const palette = {
    match:    { bg: "var(--green-subtle)", fg: "var(--green)", border: "var(--green)",        Icon: CheckCircle2 },
    mismatch: { bg: "#fef2f2",             fg: "#b91c1c",      border: "#fecaca",             Icon: AlertCircle },
    unknown:  { bg: "var(--surface)",      fg: "var(--text-muted)", border: "var(--border)",  Icon: AlertTriangle },
  }[liveStatus]
  const Icon = palette.Icon

  return (
    <div className="rounded-md p-2 text-[11px] space-y-1.5"
      style={{ background: palette.bg, border: `1px solid ${palette.border}` }}>
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1 font-semibold" style={{ color: palette.fg }}>
          <Icon size={11} strokeWidth={2} />
          {liveStatus === "match"
            ? "AI-verified: matches entered value"
            : liveStatus === "mismatch"
              ? "AI found a different amount"
              : "AI could not extract a balance"}
        </span>
        <button type="button" onClick={onReverify} disabled={reverifying}
          className="text-[10px] underline-offset-2 hover:underline"
          style={{ color: palette.fg }}>
          {reverifying ? "Re-reading…" : "Re-verify"}
        </button>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
        <span style={{ color: "var(--text-muted)" }}>Found in document</span>
        <span className="tabular-nums text-right font-medium text-theme">
          {extracted !== null ? `$${extracted.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—"}
        </span>
        <span style={{ color: "var(--text-muted)" }}>Statement date</span>
        <span className="text-right text-theme">{v.statement_date || "—"}</span>
        {v.doc_identifier && (
          <>
            <span style={{ color: "var(--text-muted)" }}>Identifier</span>
            <span className="text-right text-theme truncate">{v.doc_identifier}</span>
          </>
        )}
        <span style={{ color: "var(--text-muted)" }}>Doc type</span>
        <span className="text-right text-theme">{v.doc_type.replace(/_/g, " ")}</span>
        {liveDiff !== null && (
          <>
            <span style={{ color: "var(--text-muted)" }}>You entered − document</span>
            <span className="tabular-nums text-right font-semibold" style={{ color: palette.fg }}>
              {liveDiff >= 0 ? "+" : ""}${Math.abs(liveDiff).toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </span>
          </>
        )}
      </div>
      {v.summary && (
        <p className="text-[10px] leading-snug pt-1 italic" style={{ color: "var(--text-muted)", borderTop: "1px dashed var(--border)" }}>
          {v.summary}
        </p>
      )}
      <p className="text-[9px]" style={{ color: "var(--text-muted)" }}>
        Confidence: {v.confidence} · Verified {new Date(v.verified_at).toLocaleString()}
      </p>
    </div>
  )
}

// ── Inline subledger form ───────────────────────────────────────────────────
// Replaces the old modal — opens as an expandable row inside the table so
// the user keeps the surrounding context (other accounts, KPIs, period
// selector) visible while reconciling. Same fields: amount, source,
// roll-forward, variance preview, reconciling items, evidence + verify.

function InlineSubledgerForm({
  account, periodEnd, saving, onSave, onClear, onClose,
}: {
  account: OverviewAccount
  periodEnd: string
  saving: boolean
  onSave: (total: number, source: string | null, items: ReconcilingItem[]) => void
  onClear: () => void
  onClose: () => void
}) {
  // Source label travels with the override row. When rolling forward, we
  // auto-populate with "Rolled forward from <date>" so the reviewer knows
  // where the number came from.
  const [source, setSource] = useState<string>(
    account.subledger_is_manual && account.subledger_source ? account.subledger_source : ""
  )
  const [uploadError, setUploadError] = useState<string | null>(null)
  const qc = useQueryClient()

  // Live list of attached evidence files for this account+period.
  // staleTime keeps the query from refetching on every window-focus /
  // re-render (default behavior was making the items panel flicker
  // constantly while the user was filling out the form).
  const { data: evidence, refetch: refetchEvidence } = useQuery({
    queryKey: ["recon-evidence", account.qbo_id, periodEnd],
    queryFn:  () => reconsApi.listAccountEvidence(account.qbo_id, periodEnd),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  })

  // Prior period's closing subledger (if any) — roll-forward context.
  const { data: prior } = useQuery({
    queryKey: ["recon-prior-override", account.qbo_id, periodEnd],
    queryFn:  () => reconsApi.getPriorOverride(account.qbo_id, periodEnd),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  })

  // Transactions posted to this account in the closing period — these are
  // the candidates the user picks from to explain GL-vs-subledger variance.
  const { data: periodEntries, isLoading: entriesLoading } = useQuery({
    queryKey: ["recon-period-entries", account.qbo_id, periodEnd],
    queryFn:  () => reconsApi.getPeriodEntries(account.qbo_id, periodEnd),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  })

  // Pre-select any items the user previously saved on this override so the
  // selection round-trips cleanly. Map txn_id → ReconcilingItem.
  const [selectedItemMap, setSelectedItemMap] = useState<Record<string, ReconcilingItem>>(() => {
    const m: Record<string, ReconcilingItem> = {}
    for (const it of account.reconciling_items ?? []) m[it.txn_id] = it
    return m
  })
  const selectedItemsRef = useRef(selectedItemMap)
  selectedItemsRef.current = selectedItemMap

  function toggleItem(item: ReconcilingItem) {
    setSelectedItemMap((prev) => {
      const next = { ...prev }
      if (next[item.txn_id]) delete next[item.txn_id]
      else next[item.txn_id] = item
      return next
    })
  }

  const selectedItems = Object.values(selectedItemMap)
  const selectedSum = selectedItems.reduce((n, it) => n + (parseFloat(it.amount) || 0), 0)

  // Subledger is CALCULATED now, not typed: opening (rolled forward from
  // the prior period) ± reconciling items = closing subledger. This
  // anchors the reconciliation to the prior close + activity rather than
  // letting the user type any number that makes the variance disappear.
  //
  // When there's no prior reconciliation yet (first time opening this
  // account), fall back to the dashboard's computed subledger value —
  // that's the AR/AP aging total or the GL fallback the user already
  // sees in the row, so the two views agree from the start. Eventually
  // the seed comes from an onboarding step (books starting date +
  // initial subledger balances) — see the setup-wizard roadmap.
  const openingBalance = prior
    ? parseFloat(prior.subledger_total)
    : parseFloat(account.subledger_balance || "0")
  const computedSubledger = openingBalance + selectedSum

  // Manual reconciling item form — for items that don't exist in QBO yet
  // (outstanding bank checks, deposits in transit, journal entries not
  // posted). Adds straight into selectedItemMap with a synthetic txn_id
  // prefixed "manual-" so the UI can render edit/delete affordances.
  const [showManualForm, setShowManualForm] = useState(false)
  const [editingManualId, setEditingManualId] = useState<string | null>(null)
  const [manualMemo, setManualMemo] = useState("")
  const [manualAmount, setManualAmount] = useState("")
  const [manualDate, setManualDate] = useState(periodEnd)

  function resetManualForm() {
    setManualMemo("")
    setManualAmount("")
    setManualDate(periodEnd)
    setEditingManualId(null)
    setShowManualForm(false)
  }

  function startEditManualItem(item: ReconcilingItem) {
    setEditingManualId(item.txn_id)
    setManualMemo(item.memo || "")
    setManualAmount(item.amount)
    setManualDate(item.txn_date || periodEnd)
    setShowManualForm(true)
  }

  function saveManualItem() {
    const amt = parseFloat(manualAmount)
    if (!Number.isFinite(amt) || amt === 0) return
    const id = editingManualId ?? `manual-${crypto.randomUUID()}`
    const item: ReconcilingItem = {
      txn_id:     id,
      txn_type:   "Manual",
      txn_number: "",
      txn_date:   manualDate || periodEnd,
      amount:     String(amt),
      memo:       manualMemo.trim() || "Manual reconciling item",
      entity:     "",
    }
    setSelectedItemMap((prev) => ({ ...prev, [id]: item }))
    resetManualForm()
  }

  function deleteManualItem(id: string) {
    setSelectedItemMap((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    if (editingManualId === id) resetManualForm()
  }

  // Auto-set the source label when rolling forward so the reviewer sees
  // where the number came from. Only set if the user hasn't typed.
  useEffect(() => {
    if (prior?.subledger_total && !source) {
      setSource(`Rolled forward from ${prior.period_end}`)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prior])

  const uploadMut = useMutation({
    mutationFn: (file: File) => reconsApi.uploadAccountEvidence(account.qbo_id, periodEnd, file),
    onSuccess: () => {
      setUploadError(null)
      refetchEvidence()
      qc.invalidateQueries({ queryKey: ["recons-overview", periodEnd] })
    },
    onError: (err: unknown) => {
      const ex = err as { response?: { data?: { detail?: string } }; message?: string }
      setUploadError(ex.response?.data?.detail ?? ex.message ?? "Upload failed")
    },
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => reconsApi.deleteAccountEvidence(id),
    onSuccess: () => {
      refetchEvidence()
      qc.invalidateQueries({ queryKey: ["recons-overview", periodEnd] })
    },
  })

  // AI verification — extracts the balance/date/doc-type from the uploaded
  // file and compares to what the user typed. Each call costs an Anthropic
  // request so it's strictly on-demand (button click), and the server caches
  // the result on the evidence row.
  const verifyMut = useMutation({
    mutationFn: (id: string) => reconsApi.verifyEvidence(id),
    onSuccess: () => refetchEvidence(),
    onError: (err: unknown) => {
      const ex = err as { response?: { data?: { detail?: string } }; message?: string }
      setUploadError(ex.response?.data?.detail ?? ex.message ?? "Verification failed")
    },
  })

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    uploadMut.mutate(file)
    e.target.value = ""  // allow re-upload of same file
  }

  async function handleDownload(evidenceId: string) {
    const { download_url } = await reconsApi.getEvidenceDownloadUrl(evidenceId)
    window.open(download_url, "_blank", "noopener,noreferrer")
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    // Subledger total = opening balance + sum of selected reconciling items
    // (the computed buildup). The user can't fudge a number to make the
    // variance vanish — they must justify it with explicit items.
    onSave(computedSubledger, source.trim() || null,
      selectedItemsRef.current ? Object.values(selectedItemsRef.current) : [])
  }

  const hasEvidence = (evidence?.length ?? 0) > 0

  return (
    <form onSubmit={submit} className="px-4 sm:px-6 py-4 border-l-4"
      style={{ borderLeftColor: "var(--green)" }}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--green)" }}>
            Manual subledger · {periodEnd}
          </p>
          <p className="text-[11px] mt-0.5" style={{ color: "var(--text-muted)" }}>
            GL balance {fmtMoney(account.gl_balance)} · {account.group_label}
          </p>
        </div>
        <button type="button" onClick={onClose}
          className="h-7 w-7 rounded-md flex items-center justify-center"
          style={{ color: "var(--text-muted)" }}
          title="Collapse">
          <X size={15} strokeWidth={1.8} />
        </button>
      </div>

      {/* ── Compact variance strip ───────────────────────────────────
          Subledger is now a CALCULATED value: opening (rolled forward)
          + sum(reconciling items). The strip just surfaces the math so
          the user can see if there's still a gap to explain. Background
          uses rgba so it tints correctly in both light and dark themes
          (the previous #fef2f2 looked washed out on dark surfaces). */}
      {(() => {
        const gl = parseFloat(account.gl_balance)
        const variance = gl - computedSubledger
        const tiedOut = Math.abs(variance) < 0.5
        const hasGap = !tiedOut
        const Metric = ({ label, value, color }: { label: string; value: string; color?: string }) => (
          <div className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
            <span className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>{label}</span>
            <span className="text-sm font-bold tabular-nums" style={{ color: color ?? "var(--text)" }}>{value}</span>
          </div>
        )
        return (
          <div className="rounded-lg px-3 py-2 mb-3 flex items-center justify-between gap-x-5 gap-y-1 flex-wrap"
            style={{
              // rgba so the tint shows on both light and dark surfaces.
              background: tiedOut ? "var(--green-subtle)" : "rgba(220, 38, 38, 0.10)",
              border: `1px solid ${tiedOut ? "var(--green)" : "rgba(220, 38, 38, 0.40)"}`,
            }}>
            <Metric label="GL" value={fmtMoney(account.gl_balance)} />
            <Metric label="Subledger" value={fmtMoney(computedSubledger)} />
            <div className="inline-flex items-center gap-1.5 whitespace-nowrap">
              {tiedOut && <CheckCircle2 size={13} strokeWidth={2.2} style={{ color: "var(--green)" }} />}
              <span className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                {tiedOut ? "Reconciled" : "Variance (GL − Sub)"}
              </span>
              <span className="text-sm font-bold tabular-nums"
                style={{ color: hasGap ? "#ef4444" : "var(--green)" }}>
                {fmtMoney(variance)}
              </span>
            </div>
          </div>
        )
      })()}

      {/* ── Reconciling items table (wide, just under variance) ─────
          Pulled live from QBO via /period-entries. Selecting items
          closes the variance gap. Persists on the override on save.
          Plus a manual-add form for items not yet in QBO (outstanding
          bank checks, deposits in transit, missing JEs). */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
          <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
            Reconciling items — current-period activity from QuickBooks
            {(periodEntries?.rows.length ?? 0) > 0 && ` · ${periodEntries!.rows.length}`}
          </span>
          <button
            type="button"
            onClick={() => showManualForm ? resetManualForm() : setShowManualForm(true)}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors"
            style={{
              background: showManualForm ? "var(--surface-2)" : "var(--green-subtle)",
              color: "var(--green)",
              border: "1px solid var(--green)",
            }}>
            <Plus size={11} strokeWidth={2} />
            {showManualForm
              ? "Cancel"
              : "Add manual item"}
          </button>
        </div>

        {/* Manual add form — appears as an inline row above the table.
            Used when the item isn't in QBO yet (outstanding check, deposit
            in transit, etc.). Persists with the regular reconciling items. */}
        {showManualForm && (
          <div className="rounded-lg p-3 mb-2 flex items-end gap-2 flex-wrap"
            style={{ background: "var(--surface)", border: "1px dashed var(--green)" }}>
            <label className="flex-1 min-w-[140px]">
              <span className="text-[9px] font-semibold uppercase tracking-wide block mb-1"
                style={{ color: "var(--text-muted)" }}>Memo / description</span>
              <input
                type="text"
                value={manualMemo}
                onChange={(e) => setManualMemo(e.target.value)}
                placeholder="e.g. Outstanding check #1234 to ABC Co"
                className="w-full rounded-md px-2 py-1.5 text-xs outline-none"
                style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }}
              />
            </label>
            <label className="w-32">
              <span className="text-[9px] font-semibold uppercase tracking-wide block mb-1"
                style={{ color: "var(--text-muted)" }}>Amount (± signed)</span>
              <input
                type="number"
                step="0.01"
                value={manualAmount}
                onChange={(e) => setManualAmount(e.target.value)}
                placeholder="-500.00"
                className="w-full rounded-md px-2 py-1.5 text-xs outline-none tabular-nums"
                style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }}
              />
            </label>
            <label className="w-36">
              <span className="text-[9px] font-semibold uppercase tracking-wide block mb-1"
                style={{ color: "var(--text-muted)" }}>Date</span>
              <input
                type="date"
                value={manualDate}
                onChange={(e) => setManualDate(e.target.value)}
                className="w-full rounded-md px-2 py-1.5 text-xs outline-none"
                style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }}
              />
            </label>
            <Button size="sm" type="button" onClick={saveManualItem}
              disabled={!parseFloat(manualAmount) || !manualMemo.trim()}>
              {editingManualId ? "Update" : "Add"}
            </Button>
          </div>
        )}

        {entriesLoading ? (
          <div className="py-3 flex items-center justify-center"><Spinner className="h-4 w-4" /></div>
        ) : (periodEntries?.rows.length ?? 0) === 0 ? (
          <p className="text-[11px] py-3 px-3 rounded-md text-center"
            style={{ color: "var(--text-muted)", background: "var(--surface)", border: "1px dashed var(--border)" }}>
            No transactions posted to this account in the closing month.
            {selectedItems.length > 0 && ` ${selectedItems.length} item(s) carried over from a prior save.`}
          </p>
        ) : (
          <div className="rounded-lg overflow-hidden" style={{ border: "1px solid var(--border)", background: "var(--surface)" }}>
            <div className="max-h-72 overflow-auto">
              <table className="w-full text-xs min-w-[500px]">
                <thead>
                  <tr style={{ background: "var(--surface-2)", position: "sticky", top: 0 }}>
                    <th className="w-8 px-2 py-2"></th>
                    <th className="text-left px-2 py-2 font-semibold" style={{ color: "var(--text-muted)" }}>Type</th>
                    <th className="text-left px-2 py-2 font-semibold" style={{ color: "var(--text-muted)" }}>#</th>
                    <th className="text-left px-2 py-2 font-semibold" style={{ color: "var(--text-muted)" }}>Date</th>
                    <th className="text-left px-2 py-2 font-semibold" style={{ color: "var(--text-muted)" }}>Entity</th>
                    <th className="text-left px-2 py-2 font-semibold" style={{ color: "var(--text-muted)" }}>Memo</th>
                    <th className="text-right px-2 py-2 font-semibold" style={{ color: "var(--text-muted)" }}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {periodEntries!.rows.map((r) => {
                    const checked = !!selectedItemMap[r.txn_id]
                    return (
                      <tr key={r.txn_id}
                        onClick={() => toggleItem(r)}
                        className="cursor-pointer transition-colors"
                        style={{
                          borderTop: "1px solid var(--border)",
                          background: checked ? "var(--green-subtle)" : "transparent",
                        }}>
                        <td className="px-2 py-2 text-center">
                          <input type="checkbox" checked={checked}
                            onChange={() => toggleItem(r)}
                            onClick={(e) => e.stopPropagation()} />
                        </td>
                        <td className="px-2 py-2 text-theme">{r.txn_type}</td>
                        <td className="px-2 py-2 font-mono" style={{ color: "var(--text-2)" }}>{r.txn_number || "—"}</td>
                        <td className="px-2 py-2" style={{ color: "var(--text-2)" }}>{r.txn_date || "—"}</td>
                        <td className="px-2 py-2 truncate max-w-[120px]" style={{ color: "var(--text-2)" }}>{r.entity || "—"}</td>
                        <td className="px-2 py-2 truncate max-w-[180px]" style={{ color: "var(--text-muted)" }}>{r.memo || "—"}</td>
                        <td className="px-2 py-2 text-right tabular-nums font-medium text-theme">{fmtMoney(r.amount)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* ── Wide subledger build-up ────────────────────────────────
          Opening (rolled forward or current dashboard value) ± each
          selected reconciling item = closing subledger. List of items
          included so user sees what makes up the balance; manual items
          carry edit + delete affordances. Pure calculation — the closing
          value flows into the variance strip and the save. */}
      <div className="rounded-xl mb-4 overflow-hidden"
        style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
        <div className="px-4 py-2 flex items-center justify-between"
          style={{ borderBottom: "1px solid var(--border)", background: "var(--surface-2)" }}>
          <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
            Subledger build-up
          </span>
          <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
            Opening ± reconciling items = closing
          </span>
        </div>
        <div className="px-4 py-3 space-y-1.5 text-sm">
          {/* Opening line */}
          <div className="flex items-center justify-between">
            <span style={{ color: "var(--text-2)" }}>
              Opening balance
              <span className="ml-1.5 text-[10px]" style={{ color: "var(--text-muted)" }}>
                {prior
                  ? `Rolled forward from ${prior.period_end}`
                  : "From dashboard (set books-start in onboarding to anchor properly)"}
              </span>
            </span>
            <span className="tabular-nums font-semibold text-theme">{fmtMoney(openingBalance)}</span>
          </div>

          {/* Per-item lines (collapsible if very long) */}
          {selectedItems.length === 0 ? (
            <p className="text-[11px] py-1.5 italic" style={{ color: "var(--text-muted)" }}>
              No reconciling items selected. Tick QBO entries above or use “Add manual item”.
            </p>
          ) : (
            <ul className="space-y-0.5 max-h-48 overflow-y-auto">
              {selectedItems.map((it) => {
                const isManual = it.txn_id.startsWith("manual-")
                const amt = parseFloat(it.amount) || 0
                return (
                  <li key={it.txn_id}
                    className="flex items-center gap-2 py-1 px-1 text-xs rounded"
                    style={{ background: "transparent" }}>
                    <span style={{ color: amt >= 0 ? "var(--green)" : "#ef4444" }}>
                      {amt >= 0 ? "+" : "−"}
                    </span>
                    {isManual && (
                      <span className="text-[9px] font-bold uppercase px-1 py-0.5 rounded"
                        style={{ background: "rgba(245, 158, 11, 0.15)", color: "#f59e0b" }}>
                        Manual
                      </span>
                    )}
                    <span className="flex-1 truncate text-theme">
                      {it.memo || it.txn_type}
                      <span className="ml-1 text-[10px]" style={{ color: "var(--text-muted)" }}>
                        {it.txn_type}{it.txn_number ? ` · #${it.txn_number}` : ""}
                        {it.txn_date ? ` · ${it.txn_date}` : ""}
                      </span>
                    </span>
                    <span className="tabular-nums font-semibold whitespace-nowrap"
                      style={{ color: amt >= 0 ? "var(--green)" : "#ef4444" }}>
                      {amt >= 0 ? "+" : ""}{fmtMoney(amt)}
                    </span>
                    {isManual ? (
                      <>
                        <button type="button"
                          onClick={() => startEditManualItem(it)}
                          className="h-5 w-5 inline-flex items-center justify-center rounded"
                          title="Edit"
                          style={{ color: "var(--text-muted)" }}>
                          <Edit2 size={11} strokeWidth={1.8} />
                        </button>
                        <button type="button"
                          onClick={() => deleteManualItem(it.txn_id)}
                          className="h-5 w-5 inline-flex items-center justify-center rounded"
                          title="Delete"
                          style={{ color: "#ef4444" }}>
                          <X size={12} strokeWidth={1.8} />
                        </button>
                      </>
                    ) : (
                      <button type="button"
                        onClick={() => toggleItem(it)}
                        className="h-5 w-5 inline-flex items-center justify-center rounded"
                        title="Untick from selection"
                        style={{ color: "var(--text-muted)" }}>
                        <X size={12} strokeWidth={1.8} />
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}

          {/* Items subtotal */}
          {selectedItems.length > 0 && (
            <div className="flex items-center justify-between pt-1"
              style={{ borderTop: "1px dashed var(--border)" }}>
              <span style={{ color: "var(--text-2)" }}>
                Items subtotal ({selectedItems.length})
              </span>
              <span className="tabular-nums font-semibold"
                style={{ color: selectedSum >= 0 ? "var(--green)" : "#ef4444" }}>
                {selectedSum >= 0 ? "+" : ""}{fmtMoney(selectedSum)}
              </span>
            </div>
          )}
        </div>

        {/* Closing line — the saved subledger total */}
        <div className="px-4 py-2.5 flex items-center justify-between"
          style={{ borderTop: "2px solid var(--border-strong)", background: "var(--green-subtle)" }}>
          <span className="text-xs font-bold uppercase tracking-wide" style={{ color: "var(--green)" }}>
            = Closing subledger
          </span>
          <span className="tabular-nums text-base font-bold" style={{ color: "var(--green)" }}>
            {fmtMoney(computedSubledger)}
          </span>
        </div>
      </div>

      {/* ── Lower two-column area: entry fields | evidence ────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="space-y-3">
            {/* Roll-forward card — prior period closing auto-flows in as the
                subledger value. The user sees what was rolled forward and
                the input is locked (admin-only to override). */}
            {prior && (
              <div className="rounded-lg p-3 space-y-2"
                style={{ background: "#eff6ff", border: "1px solid #bfdbfe" }}>
                <div className="flex items-center gap-1.5">
                  <ShieldCheck size={11} strokeWidth={1.8} style={{ color: "#1d4ed8" }} />
                  <span className="text-[10px] font-bold uppercase tracking-wide"
                    style={{ color: "#1d4ed8" }}>
                    Rolled forward from prior period
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span style={{ color: "#1e3a8a" }}>Closing as of {prior.period_end}</span>
                  <span className="font-bold tabular-nums" style={{ color: "#1e3a8a" }}>
                    {fmtMoney(prior.subledger_total)}
                  </span>
                </div>
                {prior.subledger_source && (
                  <p className="text-[10px]" style={{ color: "#1e40af" }}>
                    Source: {prior.subledger_source}
                  </p>
                )}
              </div>
            )}

            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                Source / notes (optional)
              </span>
              <input
                type="text"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder="e.g. Bank of America statement 4/30/26"
                className="w-full rounded-lg px-3 py-2 mt-1 text-sm outline-none"
                style={{
                  background: "var(--surface-2)",
                  border: "1px solid var(--border-strong)",
                  color: "var(--text)",
                }}
              />
            </label>

        </div>{/* end LEFT column (build-up + source) */}

        {/* ── RIGHT column: supporting evidence + AI verify ───── */}
        <div className="space-y-3">
          <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-wide"
                  style={{ color: "var(--text-muted)" }}>
                  Supporting evidence
                </span>
                {!hasEvidence && (
                  <span className="text-[10px] font-medium"
                    style={{ color: "#b91c1c" }}>
                    Required for approval
                  </span>
                )}
              </div>

              {/* Attached files list + per-file AI verification */}
              {hasEvidence && (
                <ul className="space-y-1.5">
                  {evidence!.map((f) => {
                    const v = f.verification
                    const verifying = verifyMut.isPending && verifyMut.variables === f.id
                    return (
                      <li key={f.id}
                        className="rounded-md px-2 py-1.5 text-xs space-y-1.5"
                        style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
                        <div className="flex items-center gap-2">
                          <FileText size={12} strokeWidth={1.8} style={{ color: "var(--green)" }} />
                          <span className="flex-1 truncate text-theme">{f.file_name}</span>
                          <span style={{ color: "var(--text-muted)" }}>
                            {Math.round(f.file_size / 1024)} KB
                          </span>
                          <button type="button" onClick={() => handleDownload(f.id)}
                            className="h-6 w-6 inline-flex items-center justify-center rounded"
                            title="Download"
                            style={{ color: "var(--text-muted)" }}>
                            <Download size={11} strokeWidth={1.8} />
                          </button>
                          <button type="button"
                            onClick={() => deleteMut.mutate(f.id)}
                            disabled={deleteMut.isPending}
                            className="h-6 w-6 inline-flex items-center justify-center rounded"
                            title="Remove"
                            style={{ color: "#b91c1c" }}>
                            <X size={12} strokeWidth={1.8} />
                          </button>
                        </div>

                        {/* Verification result — or the trigger button if not yet verified.
                            Pass the computed subledger so the live delta tracks the
                            calculation as the user picks more reconciling items. */}
                        {v ? (
                          <VerificationBadge verification={v} enteredAmount={computedSubledger} valid={true}
                            onReverify={() => verifyMut.mutate(f.id)} reverifying={verifying} />
                        ) : (
                          <button type="button"
                            onClick={() => verifyMut.mutate(f.id)}
                            disabled={verifying}
                            className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition-colors"
                            style={{
                              background: "var(--surface)",
                              border: "1px dashed var(--green)",
                              color: "var(--green)",
                            }}>
                            <Sparkles size={11} strokeWidth={1.8} />
                            {verifying ? "Reading document…" : "Verify with AI"}
                          </button>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}

              {/* Upload trigger */}
              <label className="inline-flex items-center gap-1.5 cursor-pointer rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors"
                style={{
                  background: hasEvidence ? "var(--surface)" : "var(--green-subtle)",
                  color:      hasEvidence ? "var(--text-2)" : "var(--green)",
                  border:     `1px dashed ${hasEvidence ? "var(--border-strong)" : "var(--green)"}`,
                }}>
                <Upload size={12} strokeWidth={1.8} />
                {uploadMut.isPending ? "Uploading…" : hasEvidence ? "Attach another file" : "Attach bank statement / register / schedule"}
                <input type="file" className="hidden" onChange={handleFile}
                  accept=".pdf,.xlsx,.xls,.csv,.png,.jpg,.jpeg"
                  disabled={uploadMut.isPending} />
              </label>
              <p className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                PDF, Excel, CSV or image. Max 15 MB per file.
              </p>
              {uploadError && (
                <p className="text-[11px]" style={{ color: "#b91c1c" }}>{uploadError}</p>
              )}
            </div>
          </div>{/* end RIGHT column (evidence + AI verify) */}
        </div>{/* end grid */}

      <div className="flex items-center justify-between gap-2 mt-4 pt-3"
        style={{ borderTop: "1px solid var(--border)" }}>
        {account.subledger_is_manual ? (
          <button
            type="button"
            onClick={onClear}
            disabled={saving}
            className="text-[11px] font-medium underline-offset-2 hover:underline"
            style={{ color: "#b91c1c" }}
          >
            Clear override
          </button>
        ) : <span />}
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" type="button" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" type="submit" loading={saving}>
            Save subledger
          </Button>
        </div>
      </div>
    </form>
  )
}

// ── Attachments cell ────────────────────────────────────────────────────────
// Shows attachment count + lets the user download files directly from the
// row without expanding it. Single attachment → one click downloads.
// Multiple → tiny dropdown listing all files. Backed by the same signed-URL
// flow as the inline form.

function AttachmentsCell({ files }: { files: import("@/modules/recons/api").OverviewEvidenceFile[] }) {
  const [open, setOpen] = useState(false)
  if (!files || files.length === 0) {
    return <span className="text-xs" style={{ color: "var(--text-muted)" }}>—</span>
  }

  async function downloadOne(id: string) {
    const { download_url } = await reconsApi.getEvidenceDownloadUrl(id)
    window.open(download_url, "_blank", "noopener,noreferrer")
  }

  // Single file — render as a direct download button.
  if (files.length === 1) {
    const f = files[0]
    return (
      <button
        type="button"
        onClick={() => downloadOne(f.id)}
        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors"
        style={{
          color: "var(--green)",
          background: "var(--green-subtle)",
          border: "1px solid var(--green)",
        }}
        title={`Download ${f.file_name}`}
      >
        <Download size={11} strokeWidth={1.8} />
        View
      </button>
    )
  }

  // Multiple — small dropdown menu.
  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors"
        style={{
          color: "var(--green)",
          background: "var(--green-subtle)",
          border: "1px solid var(--green)",
        }}
        title={`${files.length} files attached`}
      >
        <Download size={11} strokeWidth={1.8} />
        {files.length}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-50 min-w-[220px] rounded-lg overflow-hidden"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
            {files.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => { downloadOne(f.id); setOpen(false) }}
                className="w-full px-3 py-2 text-left text-[11px] flex items-center gap-2 transition-colors hover:bg-opacity-100"
                style={{ borderBottom: "1px solid var(--border)", color: "var(--text)" }}
              >
                <FileText size={11} strokeWidth={1.8} style={{ color: "var(--green)" }} />
                <span className="flex-1 truncate">{f.file_name}</span>
                <Download size={10} strokeWidth={1.8} style={{ color: "var(--text-muted)" }} />
              </button>
            ))}
          </div>
        </>
      )}
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
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className="text-[11px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                {account.group_label}
              </span>
              {account.account_number && (
                <span className="text-[11px] font-mono px-1.5 py-0.5 rounded"
                  style={{ background: "var(--surface-2)", color: "var(--text-2)" }}>
                  Acct No. {account.account_number}
                </span>
              )}
              {account.subledger_is_manual && (
                <span className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded"
                  style={{ background: "#fef3c7", color: "#92400e" }}
                  title="Subledger value was entered manually">
                  Manual subledger
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
