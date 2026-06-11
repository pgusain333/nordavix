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
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query"
import { motion, AnimatePresence } from "framer-motion"
import { formatDate, formatDateLong, formatDateTime } from "@/core/lib/dates"
import { useDemoMode } from "@/core/demo/DemoModeProvider"
import {
  RefreshCw,
  AlertTriangle,
  AlertCircle,
  Lightbulb,
  CheckCircle2,
  Search,
  Eye,
  X,
  Trash2,
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
  ArrowLeft,
  ArrowRight,
  RotateCcw,
} from "lucide-react"
import { Button, Spinner } from "@/core/ui/components"
import { DatePicker } from "@/core/ui/DatePicker"
import {
  reconsApi,
  type Overview,
  type OverviewAccount,
  type SubledgerDetail,
  type AccountReviewStatus,
  type ReconcilingItem,
  type EvidenceVerification,
} from "@/modules/recons/api"
import { workspaceApi } from "@/modules/workspace/api"
import { useUserNames } from "@/modules/workspace/hooks"
import { apiClient } from "@/core/api/client"
import { AgenticRunningOverlay } from "@/modules/recons/components/AgenticRunningOverlay"
import { TrialBalanceCheckCard } from "@/modules/recons/components/TrialBalanceCheckCard"
import {
  AccountDetailDrawer,
  readDrawerAcctFromHash,
} from "@/modules/recons/components/AccountDetailDrawer"
import { useQboConnection } from "@/modules/flux/hooks"
import { useSelectedPeriodDefault } from "@/core/hooks/useSelectedPeriod"
import { InitialRecordingSuggestionsPanel } from "@/modules/schedules/components/InitialRecordingSuggestionsPanel"
import { SchedulePeriodJesPanel } from "@/modules/schedules/components/SchedulePeriodJesPanel"
import { BankReconWorksheet } from "@/modules/recons/components/BankReconWorksheet"
import {
  PrepaidSuggestionsPanel,
  prepaidTxnId,
} from "@/modules/schedules/components/PrepaidSuggestionsPanel"
import {
  AccrualSuggestionsPanel,
  accrualTxnId,
} from "@/modules/schedules/components/AccrualSuggestionsPanel"
import {
  ScheduleLinePanel,
  lineTxnId,
} from "@/modules/schedules/components/ScheduleLinePanel"
import { schedulesApi, type ScheduleLineSuggestion } from "@/modules/schedules/api"

// ── Formatting helpers ─────────────────────────────────────────────────────

/** Human label for the recon's ReconcilingItem.txn_type field, given a
 * generic schedule line item from FA/Lease/Loan. Used for the badge in
 * the SL build-up so the user sees what they checked. */
function labelForScheduleLine(kind: "fixed_asset" | "lease" | "loan", s: ScheduleLineSuggestion): string {
  const human = kind === "fixed_asset" ? "FA" : kind === "lease" ? "Lease" : "Loan"
  const pretty = s.line_kind.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  return `${human} · ${pretty}`
}

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
  Bank:                       "#4e6e8e",
  "Credit Card":              "#6e70a6",
  AR:                         "#4fa07a",
  AP:                         "#c79a52",
  "Fixed Assets":             "#0ea5e9",
  "Other Current Assets":     "#14b8a6",
  "Other Assets":             "#06b6d4",
  "Other Current Liabilities":"#ec4899",
  "Long Term Liabilities":    "#d946ef",
  Equity:                     "#6e70a6",
}

// Credit-natural account groups. For these, GL balances are stored
// signed-negative in our convention (liabilities + equity show in
// parentheses on the dashboard, e.g. AP = "($60,371)"). QBO's
// GeneralLedger report, however, returns each transaction's
// `subt_nat_amount` in the account's NATURAL sign — meaning a credit
// posted to a liability comes back POSITIVE (because credit is the
// natural direction for a liability).
//
// If we summed those raw amounts directly against the signed opening
// balance, the variance would move the wrong way: -371 (opening) +
// 60000 (credit invoice raw amount) = +59,629, when the right answer
// is -371 + (-60,000) = -60,371. So for these account groups we flip
// the sign of QBO reconciling items at sum + display time.
//
// Asset accounts (Bank, AR, Fixed Assets, Other Current Assets, Other
// Assets) are debit-natural — QBO's raw amounts already line up with
// our signed balances and no flip is needed.
const CREDIT_NATURAL_GROUPS = new Set([
  "Credit Card", "AP",
  "Other Current Liabilities", "Long Term Liabilities", "Equity",
])

function isCreditNatural(groupLabel: string): boolean {
  return CREDIT_NATURAL_GROUPS.has(groupLabel)
}

/** Pretty label for a schedule-backed account's subledger base line, keyed by
 *  the backend's schedule_type. */
const SCHEDULE_TYPE_LABEL: Record<string, string> = {
  prepaid:            "prepaid",
  accrual:            "accrual",
  fixed_asset_cost:   "fixed-asset",
  fixed_asset_accdep: "fixed-asset (accum. dep.)",
  lease_liability:    "lease",
  lease_rou:          "lease (ROU)",
  loan:               "loan",
}

/**
 * Recompute KPI totals from the patched accounts array. Matches the
 * backend formula exactly: signed sums + variance = gl − subledger.
 * Lets the top KPI cards stay live after any optimistic per-account
 * patch (subledger save, bulk status flip) without waiting for a
 * server refetch.
 */
function recomputeTotals(
  accounts: OverviewAccount[],
): { gl: string; subledger: string; variance: string } {
  const gl  = accounts.reduce((s, a) => s + (parseFloat(a.gl_balance)        || 0), 0)
  const sub = accounts.reduce((s, a) => s + (parseFloat(a.subledger_balance) || 0), 0)
  return {
    gl:        gl.toFixed(2),
    subledger: sub.toFixed(2),
    variance:  (gl - sub).toFixed(2),
  }
}

// ── Main component ─────────────────────────────────────────────────────────

export function ReconciliationsDashboard() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  // Seed period from /reconciliations/period/:periodEnd (preferred)
  // or fall back to ?period=YYYY-MM-DD (legacy) when navigated from the
  // dashboard's month-end tracker.
  const { periodEnd: routePeriodEnd } = useParams<{ periodEnd?: string }>()
  // Cross-app default: the dashboard writes the user's selected month to
  // localStorage and every other app reads from it. URL params still win
  // so deep-links + bookmarks aren't overridden.
  const fallback = useSelectedPeriodDefault(defaultPeriodEnd())
  const initialPeriod = (() => {
    if (routePeriodEnd && /^\d{4}-\d{2}-\d{2}$/.test(routePeriodEnd)) return routePeriodEnd
    const sp = new URLSearchParams(window.location.search).get("period")
    return sp && /^\d{4}-\d{2}-\d{2}$/.test(sp) ? sp : fallback
  })()
  const [periodEnd, setPeriodEnd] = useState<string>(initialPeriod)

  // Keep the URL and the picker in sync — when the user changes the
  // period selector in the header, push the new path so refresh / bookmark
  // / browser back-button all do the right thing.
  useEffect(() => {
    if (routePeriodEnd !== periodEnd) {
      navigate(`/app/reconciliations/period/${periodEnd}`, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodEnd])
  const [search, setSearch] = useState("")
  const [groupFilter, setGroupFilter] = useState<string>("all")
  const [showOnlyVariance, setShowOnlyVariance] = useState(false)
  /** Status bucket the user is currently looking at. "open" = pending or
   *  flagged (the close-in-progress queue). "reviewed" / "approved" are
   *  done buckets. "all" shows everything. When you approve a row in
   *  "open" it disappears from the list and shows up under "approved" — */
  const [statusBucket, setStatusBucket] = useState<"open" | "reviewed" | "approved" | "all">("open")
  const [drawerAccount, setDrawerAccount] = useState<OverviewAccount | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  /** Account currently shown in the right-side drawer. Drawer is now
   *  the only drill-in path — inline accordion was removed. URL hash
   *  keeps the selection alive across refreshes. */
  const [drawerAcctId, setDrawerAcctId] = useState<string | null>(() => readDrawerAcctFromHash())

  // KPI sticky-on-scroll: tracks the page's scroll position so the top
  // KPI cards collapse to a compact horizontal bar once the user has
  // scrolled past ~140px. Keeps the numbers visible while reviewing
  // the long account list without eating real estate.
  const pageScrollRef = useRef<HTMLDivElement>(null)
  const [isKpiCompact, setIsKpiCompact] = useState(false)
  useEffect(() => {
    const el = pageScrollRef.current
    if (!el) return
    let rafId: number | null = null
    // Hysteresis + rAF debounce — fixes a flicker where the compact ↔
    // full swap would flap when the user scrolled at the threshold. By
    // requiring the user to cross BACK below 40px to re-expand (vs
    // entering compact at >80px), we get a 40px dead zone that
    // eliminates the flap. rAF debounce coalesces wheel notches into
    // one state update per frame so the AnimatePresence swap fires
    // at most once per refresh tick.
    const onScroll = () => {
      if (rafId !== null) return
      rafId = requestAnimationFrame(() => {
        rafId = null
        const y = el.scrollTop
        setIsKpiCompact((prev) => {
          if (prev && y < 40) return false
          if (!prev && y > 80) return true
          return prev
        })
      })
    }
    el.addEventListener("scroll", onScroll, { passive: true })
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId)
      el.removeEventListener("scroll", onScroll)
    }
  }, [])
  /** Set of qbo_account_ids the user has checked for bulk actions */
  const [selected, setSelected] = useState<Set<string>>(new Set())
  /** "Synced N accounts at HH:MM" — banner that fades out after a few seconds */
  const [syncMsg, setSyncMsg] = useState<string | null>(null)

  const { data: qbo } = useQboConnection()

  // Current user's role — gates the visibility of Approve / Reviewed / Flag
  // buttons in the bulk toolbar (preparers don't see them).
  const { data: me } = useQuery({
    queryKey: ["workspace-me"],
    queryFn:  workspaceApi.getMe,
    staleTime: 60_000,
  })
  const canReview = me?.role === "admin" || me?.role === "reviewer"
  const isAdmin = me?.role === "admin"

  // GET /overview is now a pure DB read (~50ms) — no QBO calls. Auto-fire
  // on mount and on every period change so navigation is instant. The
  // backend returns `synced: false` for periods that have never been
  // synced; the UI shows the "Sync from QuickBooks" CTA in that case.
  // POST /sync (handleSync below) is the only thing that hits QBO.
  const { data: overview, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ["recons-overview", periodEnd],
    queryFn:  () => reconsApi.getOverview(periodEnd),
    enabled:  !!qbo,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  })

  // Closed-period flag flows through from /overview. When true, the entire
  // dashboard goes read-only — bulk actions hidden, status chips frozen,
  // inline forms collapsed, banner shown.
  // Demo mode makes the whole dashboard read-only too (the backend also blocks
  // writes); the closed-period *banner* below stays keyed to a real close.
  const { isDemo } = useDemoMode()
  const isClosed = overview?.is_closed === true || isDemo
  const closedByName = useUserNames([overview?.closed_by])[overview?.closed_by ?? ""]

  // Sequential-close gate (mirrored on the backend in /admin/close-period).
  // Pull the same tracker the main dashboard uses to surface earlier
  // unclosed months as blockers (the whole dashboard goes read-only
  // when any prior month is still open).
  const { data: tracker } = useQuery({
    queryKey: ["period-tracker"],
    queryFn:  reconsApi.listPeriodTracker,
    staleTime: 60_000,
    enabled:  !!qbo,
  })
  const priorBlockers = useMemo(() => {
    if (!tracker?.periods) return [] as { label: string; period_end: string; unapproved: number }[]
    return tracker.periods
      .filter((p) => p.period_end < periodEnd)
      .filter((p) => p.status !== "closed" && p.status !== "complete")
      .map((p) => {
        const unapproved = (p.counts.pending ?? 0) + (p.counts.reviewed ?? 0) + (p.counts.flagged ?? 0)
        return { label: p.label, period_end: p.period_end, unapproved }
      })
  }, [tracker, periodEnd])

  // Close-period AND reopen-period both live on the main dashboard's
  // Month-End Close Progress card now — they're the single source of
  // truth for period lifecycle. The recons dashboard surfaces the
  // closed-state read-only banner but no longer owns either action.

  // Agentic mode — AI runs as a preparer across every open account in
  // the period. One-shot per click (no background scheduling). On
  // success, invalidate the overview so the table reflects the new
  // statuses and store the result for the post-run banner.
  const [agenticResult, setAgenticResult] = useState<import("@/modules/recons/api").AgenticResult | null>(null)
  const runAgenticMut = useMutation({
    mutationFn: () => reconsApi.runAgenticPrep(periodEnd),
    onSuccess: (data) => {
      setAgenticResult(data)
      qc.invalidateQueries({ queryKey: ["recons-overview", periodEnd] })
      qc.invalidateQueries({ queryKey: ["period-tracker"] })
      // The agentic run may have drafted proposed adjusting entries — refresh
      // the inline cards + Adjustments queue so they appear without a reload.
      qc.invalidateQueries({ queryKey: ["adjustments"] })
    },
    onError: (err: unknown) => {
      const ex = err as { response?: { data?: { detail?: string } }; message?: string }
      setSyncMsg(`Agentic preparer failed: ${ex.response?.data?.detail ?? ex.message ?? "Unknown error"}`)
    },
  })

  // Per-row Agentic — runs the same engine on ONE account. Used
  // by the per-row "Run AI" button. Variables (= qbo_account_id)
  // double as the row identity for disabling the button while
  // its own request is in flight (rowAgenticMut.variables === a.qbo_id).
  const rowAgenticMut = useMutation({
    mutationFn: async (qboAccountId: string) =>
      reconsApi.runAgenticPrepForAccount(periodEnd, qboAccountId),
    onSuccess: (data) => {
      // Patch the overview cache so the new ai_commentary shows
      // up immediately without waiting for a refetch. The result
      // shape mirrors the bulk runner so we surface the same
      // banner text.
      qc.invalidateQueries({ queryKey: ["recons-overview", periodEnd] })
      qc.invalidateQueries({ queryKey: ["adjustments"] })
      const account = data.accounts[0]
      if (account) {
        setSyncMsg(`AI ${account.action} on ${account.account_name}. ${account.reason}`)
      }
    },
    onError: (err: unknown) => {
      const ex = err as { response?: { data?: { detail?: string } }; message?: string }
      setSyncMsg(`Per-row AI failed: ${ex.response?.data?.detail ?? ex.message ?? "Unknown error"}`)
    },
  })

  /**
   * Per-row QBO sync — refreshes just THIS account's GL balance from
   * QBO and patches the overview cache in place. Avoids triggering
   * the full /sync action when the user just wants one row updated.
   */
  const rowSyncMut = useMutation({
    mutationFn: (qboAccountId: string) => reconsApi.syncOneAccount(qboAccountId, periodEnd),
    onSuccess: (data) => {
      // Patch only the synced row's gl_balance + recompute variance =
      // gl - subledger_balance so the overview stays internally
      // consistent without a refetch. The full invalidate happens on
      // the next user-driven action (period change, Sync All, etc.).
      qc.setQueryData<Overview | undefined>(["recons-overview", periodEnd], (old) => {
        if (!old) return old
        return {
          ...old,
          accounts: old.accounts.map((a) => {
            if (a.qbo_id !== data.qbo_account_id) return a
            const gl = parseFloat(data.gl_balance) || 0
            const sub = parseFloat(a.subledger_balance) || 0
            const reopened = (data as { reopened?: boolean }).reopened
            return {
              ...a,
              gl_balance:  data.gl_balance,
              variance:    (gl - sub).toFixed(2),
              // Re-syncing an approved account re-opened it server-side —
              // reflect that immediately so the row leaves the approved state.
              review_status: reopened ? "reviewed" as const : a.review_status,
            }
          }),
        }
      })
      setSyncMsg((data as { reopened?: boolean }).reopened
        ? `${data.account_name} resynced and re-opened for review (was approved).`
        : `${data.account_name} resynced from QuickBooks.`)
    },
    onError: (err: unknown) => {
      const ex = err as { response?: { data?: { detail?: string } }; message?: string }
      setSyncMsg(`Sync failed: ${ex.response?.data?.detail ?? ex.message ?? "Unknown error"}`)
    },
  })

  function triggerRowAgentic(a: OverviewAccount) {
    // Confirm before overwriting existing AI commentary, per user spec.
    if (a.ai_commentary) {
      const ok = window.confirm(
        `${a.account_name} already has AI analysis.\n\n` +
        "Re-running will pull fresh QuickBooks transactions and overwrite " +
        "the existing commentary with a new one. Existing manual reconciling " +
        "items and the prepared/approved status are NOT affected.\n\nContinue?",
      )
      if (!ok) return
    }
    rowAgenticMut.mutate(a.qbo_id)
  }

  // Cooperative cancel: signals the backend to stop after its current
  // account, commits cleanly, and returns the partial result via the
  // already-pending runAgenticMut. The original request resolves
  // normally — onSuccess still fires with whatever got processed.
  const cancelAgenticMut = useMutation({
    mutationFn: () => reconsApi.cancelAgenticPrep(periodEnd),
    onError: (err: unknown) => {
      const ex = err as { response?: { data?: { detail?: string } }; message?: string }
      setSyncMsg(`Could not signal stop: ${ex.response?.data?.detail ?? ex.message ?? "Unknown error"}`)
    },
  })

  async function handleAgenticRun() {
    if (runAgenticMut.isPending) return
    const ok = confirm(
      `Run AI Agentic Preparer on every open account in ${periodEnd}?\n\n` +
      "What it does:\n" +
      "  • Pulls each open account's period transactions from QuickBooks.\n" +
      "  • Ties subledger to GL where the math works (includes all period " +
      "transactions and marks the account Prepared).\n" +
      "  • For accounts that don't tie, asks Claude to write 2-3 likely " +
      "reasons into the row's notes — leaves status unchanged.\n\n" +
      "What it WON'T touch:\n" +
      "  • Accounts already Approved.\n" +
      "  • Accounts with a manual subledger override.\n\n" +
      "Continue?",
    )
    if (!ok) return
    setAgenticResult(null)
    await runAgenticMut.mutateAsync().catch(() => { /* error handled in onError */ })
  }

  // Reset AI agentic work — clears subledger / items / commentary on
  // every account AI touched, sets them back to pending. Used when the
  // user wants to switch from AI-prepared back to manual reconciliation.
  const resetAgenticMut = useMutation({
    mutationFn: () => reconsApi.resetAgenticPrep(periodEnd),
    onSuccess: (data) => {
      setAgenticResult(null)
      setSyncMsg(data.message)
      qc.invalidateQueries({ queryKey: ["recons-overview", periodEnd] })
      qc.invalidateQueries({ queryKey: ["period-tracker"] })
    },
    onError: (err: unknown) => {
      const ex = err as { response?: { data?: { detail?: string } }; message?: string }
      setSyncMsg(`Reset failed: ${ex.response?.data?.detail ?? ex.message ?? "Unknown error"}`)
    },
  })

  async function handleAgenticReset() {
    if (resetAgenticMut.isPending) return
    const ok = confirm(
      `Reset AI's work on every account in ${periodEnd}?\n\n` +
      "Clears the AI-prepared subledger, reconciling items, AI commentary, " +
      "and resets status back to pending on every row AI touched.\n\n" +
      "Doesn't affect human-prepared rows. After reset, each row goes back " +
      "to showing opening (rolled forward from prior period) + variance, " +
      "and you can reconcile manually via the inline form.\n\n" +
      "Continue?",
    )
    if (!ok) return
    await resetAgenticMut.mutateAsync().catch(() => { /* error handled in onError */ })
  }

  // True when any account on the dashboard has an ai_commentary field —
  // i.e., AI has done work on this period. Drives the visibility of
  // the Reset AI button.
  const hasAgenticWork = useMemo(
    () => (overview?.accounts ?? []).some((a) => a.ai_commentary),
    [overview],
  )


  // POST /sync mutation — pulls fresh data from QBO and persists snapshots.
  // On success we feed the returned overview straight into the query cache
  // so the table updates without a second GET roundtrip.
  const syncMut = useMutation({
    mutationFn: () => reconsApi.syncPeriod(periodEnd),
    onSuccess: (data) => {
      qc.setQueryData(["recons-overview", periodEnd], data)
      const n = data.accounts.length
      const when = new Date().toLocaleTimeString()
      const r = data.reflagged ?? 0
      setSyncMsg(
        r > 0
          ? `Synced ${n} account${n === 1 ? "" : "s"} at ${when}. ${r} approved account${r === 1 ? "" : "s"} moved back to review — the balances changed, so the sign-off no longer ties out.`
          : `Synced ${n} account${n === 1 ? "" : "s"} from QuickBooks at ${when}.`,
      )
      // Reverted rows changed status server-side — refresh the close tracker too.
      if (r > 0) qc.invalidateQueries({ queryKey: ["period-tracker"] })
    },
    onError: (err: unknown) => {
      const ex = err as { response?: { data?: { detail?: string } }; message?: string }
      setSyncMsg(`Sync failed: ${ex.response?.data?.detail ?? ex.message ?? "Unknown error"}`)
    },
  })
  async function handleSync() {
    setSyncMsg(null)
    await syncMut.mutateAsync().catch(() => { /* error handled in onError */ })
  }

  // Period Excel export — calls /api/exports/period?period_end=...
  // Returns the multi-sheet close-package workbook. Parses the
  // Content-Disposition for the canonical filename so downloads land
  // as e.g. "Acme_close_2026-04-30.xlsx" instead of a generic name.
  const exportPeriodMut = useMutation({
    mutationFn: async () => {
      const res = await apiClient.get<Blob>("/api/exports/period", {
        params:       { period_end: periodEnd },
        responseType: "blob",
      })
      let filename = `nordavix_close_${periodEnd}.xlsx`
      const cd = res.headers?.["content-disposition"] as string | undefined
      if (cd) {
        const m = cd.match(/filename="?([^"]+)"?/i)
        if (m && m[1]) filename = m[1]
      }
      const url = URL.createObjectURL(new Blob([res.data]))
      const a = document.createElement("a")
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
    },
    onError: async (err: unknown) => {
      // With responseType:"blob" axios returns the error body as a Blob,
      // so the usual `response.data.detail` is empty. Read the Blob as
      // text and try to JSON-parse the FastAPI HTTPException payload.
      const ex = err as {
        response?: { data?: Blob | { detail?: string }; statusText?: string }
        message?: string
      }
      let detail: string | null = null
      const data = ex.response?.data
      if (data instanceof Blob) {
        try {
          const text = await data.text()
          const parsed = JSON.parse(text) as { detail?: string }
          detail = parsed.detail ?? null
        } catch { /* not JSON — leave detail null */ }
      } else if (data && typeof data === "object" && "detail" in data) {
        detail = (data as { detail?: string }).detail ?? null
      }
      setSyncMsg(`Excel export failed: ${detail ?? ex.response?.statusText ?? ex.message ?? "Unknown error"}`)
    },
  })

  // Auto-dismiss banner after 4 seconds
  useEffect(() => {
    if (!syncMsg) return
    const t = setTimeout(() => setSyncMsg(null), 4_000)
    return () => clearTimeout(t)
  }, [syncMsg])

  // Auto-sync flow — when the user clicks "Start month-end close" on the
  // main dashboard tracker for a not-yet-started month, that link tags
  // the URL with ?autosync=1. On arrival here we kick off the sync once
  // (per period), then strip the param so a refresh doesn't re-fire.
  // Guard on qbo + !overview so we don't pile on a sync if data's
  // already cached locally. ALSO skip when sequential-close gate is
  // blocking — the user shouldn't be doing any work on this period.
  const didAutoSyncRef = useRef<string | null>(null)
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search)
    if (sp.get("autosync") !== "1") return
    if (!qbo) return
    if (didAutoSyncRef.current === periodEnd) return
    // Wait for the tracker to load before deciding — otherwise the
    // blocker check below would always see []. When tracker fetches,
    // the effect re-runs.
    if (tracker === undefined) return
    // Sequential-close gate: if an earlier month is open, skip the
    // autosync entirely. The blocker banner will render instead.
    if (priorBlockers.length > 0) {
      // Still strip the ?autosync= param so a refresh doesn't keep
      // re-triggering this branch unnecessarily.
      sp.delete("autosync")
      const qs = sp.toString()
      navigate(`/app/reconciliations/period/${periodEnd}${qs ? "?" + qs : ""}`, { replace: true })
      didAutoSyncRef.current = periodEnd
      return
    }
    if (overview?.synced) {
      // Already synced for this period — no need to autosync; just
      // strip the param so a refresh doesn't keep re-triggering.
      sp.delete("autosync")
      const qs = sp.toString()
      navigate(`/app/reconciliations/period/${periodEnd}${qs ? "?" + qs : ""}`, { replace: true })
      didAutoSyncRef.current = periodEnd
      return
    }
    didAutoSyncRef.current = periodEnd
    handleSync().finally(() => {
      const sp2 = new URLSearchParams(window.location.search)
      sp2.delete("autosync")
      const qs = sp2.toString()
      navigate(`/app/reconciliations/period/${periodEnd}${qs ? "?" + qs : ""}`, { replace: true })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qbo, periodEnd, overview, tracker, priorBlockers.length])

  // Clear bulk selection when the period changes — those rows belong to a
  // different period now.
  useEffect(() => { setSelected(new Set()) }, [periodEnd])

  // Auto-close the drawer when the period goes from unlocked → locked.
  // Avoids showing an editable detail panel on a frozen period.
  useEffect(() => {
    if (isClosed) {
      setDrawerAcctId(null)
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
    mutationFn: (v: { id: string; status: AccountReviewStatus; preserve?: boolean }) =>
      reconsApi.updateAccountReviewStatus(v.id, periodEnd, v.status, undefined, v.preserve),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ["recons-overview", periodEnd] })
      const prev = qc.getQueryData<Overview>(["recons-overview", periodEnd])
      if (prev) {
        const nowIso = new Date().toISOString()
        const patched = prev.accounts.map((a) => {
          if (a.qbo_id !== v.id) return a
          if (v.status === "pending" && !v.preserve) {
            // Full reset — mirror the bulk reset + backend clear: start over.
            return {
              ...a,
              review_status:        v.status,
              reviewed_at:          null,
              subledger_is_manual:  false,
              subledger_balance:    a.gl_balance,
              subledger_source:     "",
              reconciling_items:    [],
              variance:             "0.00",
              subledger_entered_at: null,
            }
          }
          // "Reset to open" (preserve) just unlocks — keep subledger + items so
          // the preparer doesn't lose their work; only flip status + clear the
          // reviewed stamp. Forward transitions also fall through here.
          return {
            ...a,
            review_status: v.status,
            reviewed_at:   v.status === "pending" ? null : nowIso,
          }
        })
        qc.setQueryData<Overview>(["recons-overview", periodEnd], {
          ...prev,
          accounts: patched,
          totals: recomputeTotals(patched),
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

  /** Patch the overview cache for one account so the dashboard figures
   *  (per-row subledger/variance + the KPI strip) update INSTANTLY — used
   *  both by the live tick preview (before any network call) and by the
   *  mutation's onSuccess (to reconcile with the server result). */
  const patchOverviewCache = useCallback(
    (qboId: string, total: number | null, source: string | null, items?: ReconcilingItem[]) => {
      const prev = qc.getQueryData<Overview>(["recons-overview", periodEnd])
      if (!prev) return
      const patched = prev.accounts.map((a) =>
        a.qbo_id === qboId
          ? {
              ...a,
              subledger_is_manual: total !== null,
              subledger_balance:   total !== null ? String(total) : a.gl_balance,
              subledger_source:    total !== null ? (source ?? a.subledger_source) : a.subledger_source,
              reconciling_items:   items ?? a.reconciling_items,
              variance:            total !== null
                                    ? String((parseFloat(a.gl_balance) - total).toFixed(2))
                                    : "0.00",
              subledger_entered_at: total !== null ? new Date().toISOString() : null,
            }
          : a,
      )
      qc.setQueryData<Overview>(["recons-overview", periodEnd], {
        ...prev,
        accounts: patched,
        totals: recomputeTotals(patched),
      })
    },
    [qc, periodEnd],
  )

  /** Manual subledger override — used by the inline editor below. */
  const subledgerMut = useMutation({
    mutationFn: (v: {
      qboId: string
      total: number | null
      source: string | null
      items?: ReconcilingItem[]
      /** When true, do NOT collapse the inline form — used by the
          tick-driven auto-save so the user can keep checking items
          and watching the cards update without losing their place. */
      autoSave?: boolean
    }) =>
      reconsApi.setSubledgerOverride(v.qboId, periodEnd, v.total, v.source, v.items),
    onSuccess: (_data, v) => {
      // Explicit saves (Save button, Clear override) close the drawer.
      // Auto-saves leave it open so the user can keep ticking.
      if (!v.autoSave) setDrawerAcctId(null)
      // Reconcile the cache with the saved result. (For ticks this usually
      // matches what the live preview already painted — it's idempotent.)
      patchOverviewCache(v.qboId, v.total, v.source, v.items)
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
        const patched = prev.accounts.map((a) => {
          if (!ids.has(a.qbo_id)) return a
          if (status === "pending") {
            // Reset wipes the work so the next preparer starts clean.
            // Matches the backend bulk-status endpoint behaviour.
            return {
              ...a,
              review_status:        status,
              reviewed_at:          null,
              subledger_is_manual:  false,
              subledger_balance:    a.gl_balance,  // reverts display to GL until next pull
              subledger_source:     "",
              reconciling_items:    [],
              variance:             "0.00",
              subledger_entered_at: null,
            }
          }
          return { ...a, review_status: status, reviewed_at: nowIso }
        })
        qc.setQueryData<Overview>(["recons-overview", periodEnd], {
          ...prev,
          accounts: patched,
          totals: recomputeTotals(patched),
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

  // Strict variance gate: an account with non-zero |variance| cannot be
  // moved to Prepared or Approved. 1¢ tolerance to absorb floating-point
  // rounding (Decimal-on-server returns string; parseFloat occasionally
  // lands at 0.0000000000001 etc). Per the close-process rule: a recon
  // is only "done" when SL ties to GL exactly, or the gap is documented
  // as a reconciling item that ZEROS the variance.
  const VARIANCE_TOLERANCE = 0.01
  const selectedAccountsWithVariance = useMemo(() => {
    if (!overview) return [] as OverviewAccount[]
    return overview.accounts.filter(
      (a) => selected.has(a.qbo_id)
          && Math.abs(parseFloat(a.variance) || 0) > VARIANCE_TOLERANCE,
    )
  }, [overview, selected])
  const blockedByVariance = selectedAccountsWithVariance.length > 0
  const blockedTooltip = blockedByVariance
    ? `${selectedAccountsWithVariance.length} selected account${selectedAccountsWithVariance.length === 1 ? "" : "s"} still have a non-zero variance. Clear it (post the missing JEs in QBO + re-sync, or add a reconciling item) before marking prepared or approving.`
    : ""

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

  // Split GL into three sides — Assets, Liabilities, Equity — using
  // signed sums then flipping the credit-natural sides at the end.
  //
  // The earlier version used Math.abs() per row, which broke for
  // contra-accounts: Owner's Draw (a +debit on an Equity-typed account)
  // got added to equity instead of subtracted, and the same logic
  // dropped contra-assets (Accumulated Depreciation, a credit balance
  // on Fixed Assets) entirely via Math.max(0, gl). Both bugs combined
  // to produce visible drift in the trial-balance check.
  //
  // Signed-sum-then-negate gets every contra-account right in both
  // directions.
  const breakdown = useMemo(() => {
    let assetsSigned = 0   // debit-natural side; sum as-is
    let liabSigned   = 0   // credit-natural side; negate at the end
    let equitySigned = 0   // credit-natural side; negate at the end
    for (const a of overview?.accounts ?? []) {
      const gl = parseFloat(a.gl_balance) || 0
      if (a.group_label === "Equity") {
        equitySigned += gl
      } else if (isCreditNatural(a.group_label)) {
        liabSigned += gl
      } else {
        assetsSigned += gl
      }
    }
    return {
      assets:      assetsSigned,
      liabilities: -liabSigned,
      equity:      -equitySigned,
    }
  }, [overview])

  function openSubledger(a: OverviewAccount) {
    setDrawerAccount(a)
  }
  // Variance-reasons mode removed from the subledger drawer per user
  // feedback — the drawer is subledger-detail only now.

  return (
    <div
      ref={pageScrollRef}
      className="flex flex-col h-full overflow-y-auto"
      style={{
        background: "var(--bg)",
        // When the detail drawer is open on desktop it sets
        // --detail-drawer-width on <body>. We pad the page by that
        // width so the dashboard cards + accounts table stay visible
        // alongside the drawer instead of disappearing under it. The
        // transition matches the drawer's spring feel so things land
        // together. Mobile leaves the var unset, so padding stays 0.
        paddingRight: "var(--detail-drawer-width, 0px)",
        // Match the drawer's ease + duration so the page and the
        // panel slide into place as one motion.
        transition: "padding-right 320ms cubic-bezier(0.4, 0, 0.2, 1)",
      }}>
      {/* AI-working overlay — covers the page while the agentic preparer
          runs. Includes a Stop button that signals cooperative cancel
          to the backend (current account commits, then the run exits). */}
      {/* Same overlay fires for BOTH the bulk Agentic run AND any
          single-row Run AI click — the user expects the same "AI is
          working" feedback no matter how they triggered it. Per-row
          runs don't have a Stop button (they're short, atomic, and
          the backend can't safely cancel mid-prompt). */}
      <AgenticRunningOverlay
        open={runAgenticMut.isPending || rowAgenticMut.isPending}
        periodLabel={periodEnd}
        cancelling={cancelAgenticMut.isPending}
        onStop={runAgenticMut.isPending ? () => cancelAgenticMut.mutate() : undefined}
      />

      {/* ── Header (compact: tighter padding, icon-only back, sized to
              line up with the action buttons on the right) ─────────────── */}
      <div
        className="px-4 sm:px-8 pt-3 sm:pt-4 pb-3"
        style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}
      >
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 min-w-0">
            {/* Icon-only back — same affordance as Flux Dashboard for
                visual parity across the two close-workflow pages. */}
            <button
              onClick={() => navigate("/app/reconciliations")}
              className="flex items-center justify-center h-7 w-7 rounded-md transition-colors hover:bg-[var(--surface-2)]"
              style={{ color: "var(--text-muted)" }}
              title="Back to the month list"
              aria-label="Back to reconciliations"
            >
              <ArrowLeft size={15} strokeWidth={1.8} />
            </button>
            <div className="min-w-0">
              <h1
                className="lg:hidden"
                style={{
                  fontSize: "clamp(16px, 3vw, 20px)",
                  fontWeight: 700,
                  lineHeight: 1.15,
                  letterSpacing: "-0.01em",
                  color: "var(--text)",
                  margin: 0,
                }}
              >
                Reconciliations
              </h1>
              <p className="text-[11px] mt-0.5 truncate" style={{ color: "var(--text-muted)" }}>
                Live snapshot of every BS account · pulled from QuickBooks at your chosen period end.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap w-full sm:w-auto">
            {/* DatePicker is sized via triggerClassName so its h-[26px]
                lines up with size="sm" Button height — pre-existing
                "Period end" label dropped to save vertical space. */}
            <DatePicker
              value={periodEnd}
              onChange={setPeriodEnd}
              disabled={!qbo}
              className="inline-block"
              triggerClassName="inline-flex items-center gap-1.5 h-[26px] px-2.5 text-xs rounded-md outline-none transition-colors hover:bg-[var(--surface)]"
            />
            <Button
              size="sm"
              variant="outline"
              icon={<RefreshCw size={14} strokeWidth={1.8} className={syncMut.isPending ? "animate-spin" : undefined} />}
              onClick={handleSync}
              disabled={!qbo || syncMut.isPending}
              title="Re-pull from QuickBooks"
            >
              <span className="hidden sm:inline">{syncMut.isPending ? "Syncing…" : "Sync"}</span>
            </Button>
            {/* Period Excel export — builds the multi-sheet close package
                workbook for this period (cover · reconciliations · all
                5 schedules · 90-day audit log). Same endpoint as
                Settings → Data exports, just with the period pre-filled
                from the dashboard's date picker so the user doesn't
                have to pick it twice. */}
            <Button
              size="sm"
              variant="outline"
              icon={<Download size={14} strokeWidth={1.8} />}
              loading={exportPeriodMut.isPending}
              onClick={() => exportPeriodMut.mutate()}
              title="Download the close package for this period as Excel (.xlsx)"
            >
              <span className="hidden sm:inline">{exportPeriodMut.isPending ? "Building…" : "Excel"}</span>
            </Button>
            {/* Agentic Mode — AI acts as preparer on every open account.
                One-shot per click; gated to a synced, unlocked period. */}
            <AgenticModeToggle
              running={runAgenticMut.isPending}
              disabled={!qbo || !overview?.synced || isClosed || syncMut.isPending}
              onClick={handleAgenticRun}
            />
            {/* Reset AI — only shown when AI has actually done work on
                this period (any row with ai_commentary). Lets the user
                switch from AI-prepared back to manual reconciliation
                without per-row editing. */}
            {hasAgenticWork && !isClosed && (
              <Button
                size="sm"
                variant="outline"
                icon={<RotateCcw size={14} strokeWidth={1.8} className={resetAgenticMut.isPending ? "animate-spin" : undefined} />}
                onClick={handleAgenticReset}
                disabled={resetAgenticMut.isPending}
                title="Clear all AI-prepared subledger values, items, and commentary for this period — switches back to manual reconciliation"
                style={{ borderColor: "#8a6326", color: "#8a6326" }}
              >
                <span className="hidden sm:inline">{resetAgenticMut.isPending ? "Resetting…" : "Reset AI"}</span>
              </Button>
            )}
            {/* Close + Reopen both live on the main dashboard's
                Month-End Close Progress card. When this period is
                closed, the read-only banner below tells the user
                where to go. */}
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
              style={confirmClear ? { borderColor: "#9b3d37", color: "#9b3d37" } : undefined}
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
              background: syncMsg.startsWith("Sync failed") ? "#f4e9e7" : "var(--green-subtle)",
              color:      syncMsg.startsWith("Sync failed") ? "#9b3d37" : "var(--green)",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <CheckCircle2 size={12} strokeWidth={1.8} />
            <span className="flex-1">{syncMsg}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Ingest-integrity banner — our parse of QuickBooks' trial balance didn't
          tie out (debits ≠ credits) on the last sync, so some balances may be
          incomplete. Blocks period close; surfaced here so the user re-syncs. */}
      {overview?.sync_health?.tb_balanced === false && (
        <div className="px-4 sm:px-8 py-2.5 text-xs font-medium flex items-center gap-2"
          style={{ background: "#f7eeec", color: "#86332e", borderBottom: "1px solid #ecd7d3" }}>
          <AlertTriangle size={14} strokeWidth={2} className="shrink-0" />
          <span className="flex-1">
            QuickBooks data didn't fully tie out on the last sync
            {overview.sync_health.tb_diff
              ? ` (off by $${Math.abs(parseFloat(overview.sync_health.tb_diff)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`
              : ""}
            {" "}— some balances may be incomplete, and the books can't be closed
            until this is resolved. Re-sync before relying on this period.
          </span>
          <Button size="sm" variant="outline" loading={syncMut.isPending} onClick={handleSync}>
            <RefreshCw size={11} strokeWidth={2} /> Re-sync
          </Button>
        </div>
      )}

      {/* Agentic run-result banner — appears after the AI preparer
          finishes. Shows the prepared/analyzed/skipped counts and
          lets the user dismiss. Stays until dismissed so they can
          read what the AI did. */}
      <AnimatePresence>
        {agenticResult && (
          <AgenticResultBanner
            result={agenticResult}
            onDismiss={() => setAgenticResult(null)}
          />
        )}
      </AnimatePresence>

      {/* Full-width content — the table is the star here, no need to
          constrain to max-w-7xl. On ultra-wide displays this lets all
          the variance columns breathe without horizontal scroll. */}
      <div className="flex-1 px-4 sm:px-6 py-4 w-full space-y-4">

        {/* QBO required banner */}
        {!qbo && (
          <div
            className="rounded-xl p-4 flex items-start gap-3"
            style={{ background: "#f4eddf", border: "1px solid #c79a52" }}
          >
            <AlertTriangle size={18} style={{ color: "#7a5622" }} className="shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold" style={{ color: "#7a5622" }}>QuickBooks isn't connected</p>
              <p className="text-xs mt-0.5" style={{ color: "#7a5622" }}>
                The Reconciliations dashboard pulls all your GL accounts and subledger balances live from QuickBooks.
                Connect to get started.
              </p>
            </div>
            <Button size="sm" onClick={() => navigate("/app/connections")}>
              Connect QuickBooks
            </Button>
          </div>
        )}

        {qbo && overview && overview.synced === false && !isFetching && priorBlockers.length === 0 && (
          <div
            className="rounded-xl p-8 text-center"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}
          >
            <div className="h-14 w-14 mx-auto rounded-full flex items-center justify-center mb-4"
              style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
              <RefreshCw size={26} strokeWidth={1.6} />
            </div>
            <p className="text-base font-semibold text-theme mb-1">
              Start reconciliations for{" "}
              {(() => {
                try { return new Date(periodEnd + "T00:00:00").toLocaleDateString(undefined, { month: "long", year: "numeric" }) }
                catch { return periodEnd }
              })()}
            </p>
            <p className="text-sm max-w-md mx-auto mb-5" style={{ color: "var(--text-muted)" }}>
              Sync pulls every balance-sheet account from QuickBooks at <span className="font-mono">{periodEnd}</span> —
              the GL balances, subledger composition, and prior-period roll-forward — so you can start ticking
              off accounts. After the first sync, switching between months in this workspace is instant; only an
              explicit Sync re-pulls from QuickBooks.
            </p>
            <Button size="sm" icon={<RefreshCw size={14} strokeWidth={1.8} />} loading={syncMut.isPending} onClick={handleSync}>
              Sync from QuickBooks
            </Button>
          </div>
        )}

        {/* ── Prior-period gate ────────────────────────────────────────
            Sequential close: this period is locked until every earlier
            month is fully approved + closed. We don't just show a
            banner — we BLOCK the rest of the dashboard so users can't
            do work on this period while earlier ones are still open.
            The block applies to every role; admins, reviewers, and
            preparers all see the same locked screen with click-to-go
            links to the blocking periods. */}
        {!isClosed && priorBlockers.length > 0 && (
          <div className="rounded-xl overflow-hidden"
            style={{
              background: "linear-gradient(135deg, rgba(199, 154, 82, 0.08) 0%, var(--surface) 100%)",
              border: "1px solid #c79a52",
              boxShadow: "var(--card-shadow)",
            }}>
            <div className="flex items-start gap-4 p-5">
              <div className="h-12 w-12 rounded-full flex items-center justify-center shrink-0"
                style={{ background: "rgba(199, 154, 82, 0.18)", border: "2px solid #c79a52" }}>
                <Lock size={20} strokeWidth={2} style={{ color: "#8a6326" }} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-wider mb-0.5"
                  style={{ color: "#8a6326" }}>
                  Locked — close earlier months first
                </p>
                <h3 className="text-lg sm:text-xl font-bold text-theme leading-tight">
                  {periodEnd} can't be opened yet
                </h3>
                <p className="text-xs mt-2" style={{ color: "var(--text-2)" }}>
                  Month-end close runs in order. Every earlier month must have all
                  accounts approved before you can reconcile {periodEnd}. Finish
                  the period{priorBlockers.length === 1 ? "" : "s"} below first:
                </p>
                <ul className="text-sm mt-3 space-y-1.5">
                  {priorBlockers.slice(0, 8).map((b) => (
                    <li key={b.period_end}>
                      <button
                        onClick={() => navigate(`/app/reconciliations/period/${b.period_end}`)}
                        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md font-medium transition-colors hover:bg-[rgba(199, 154, 82,0.10)]"
                        style={{ color: "#8a6326", border: "1px solid #fcd34d" }}
                      >
                        <span className="font-semibold">{b.label}</span>
                        <span className="text-xs" style={{ color: "#7a5622", opacity: 0.85 }}>
                          {b.unapproved > 0
                            ? `${b.unapproved} open account${b.unapproved === 1 ? "" : "s"}`
                            : "no work started"}
                        </span>
                        <ArrowRight size={12} strokeWidth={1.8} />
                      </button>
                    </li>
                  ))}
                  {priorBlockers.length > 8 && (
                    <li className="text-xs px-3" style={{ color: "#7a5622", opacity: 0.7 }}>
                      + {priorBlockers.length - 8} more
                    </li>
                  )}
                </ul>
                <p className="text-[10px] mt-3 italic" style={{ color: "var(--text-muted)" }}>
                  Why? Sequential close is a standard accounting compliance rule —
                  it prevents skipping a month or back-dating activity. The same
                  gate runs server-side when an admin tries to close a period out of order.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* ── Books-closed banner — prominent, locks the dashboard ── */}
        {overview?.is_closed === true && (
          <div className="rounded-xl overflow-hidden"
            style={{
              background: "linear-gradient(135deg, var(--surface-2) 0%, var(--surface) 100%)",
              border: "1px solid var(--border-strong)",
              boxShadow: "var(--card-shadow)",
            }}>
            <div className="flex items-center gap-4 p-5">
              <div className="h-12 w-12 rounded-full flex items-center justify-center shrink-0"
                style={{
                  background: "rgba(199, 154, 82, 0.15)",
                  border: "2px solid #c79a52",
                }}>
                <Lock size={20} strokeWidth={2} style={{ color: "#8a6326" }} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-wider mb-0.5"
                  style={{ color: "#8a6326" }}>
                  Books closed
                </p>
                <h3 className="text-lg sm:text-xl font-bold text-theme leading-tight">
                  Period {overview.period_end} is locked
                </h3>
                <p className="text-xs mt-1" style={{ color: "var(--text-2)" }}>
                  Closed by <span className="font-semibold text-theme">{closedByName || "an admin"}</span>
                  {overview.closed_at && (
                    <> on {formatDateLong(overview.closed_at)}</>
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
                // Reopen lives on the dashboard's Month-End Close
                // Progress card now. Send the admin there with one click.
                <Button
                  size="sm"
                  variant="outline"
                  icon={<Unlock size={12} strokeWidth={1.8} />}
                  onClick={() => navigate("/app")}
                  style={{ borderColor: "#c79a52", color: "#8a6326" }}
                  title="Go to the dashboard to reopen this period">
                  Reopen on dashboard
                </Button>
              )}
            </div>
            <div className="px-5 py-2 flex items-center gap-2 flex-wrap"
              style={{ borderTop: "1px solid var(--border)", background: "var(--surface-2)" }}>
              <CheckCircle2 size={12} strokeWidth={2} style={{ color: "var(--green)" }} />
              <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                {overview.accounts.length} account{overview.accounts.length === 1 ? "" : "s"} reconciled
                · Assets {fmtMoney(breakdown.assets)}
                · Liab {fmtMoney(breakdown.liabilities)}
                · Equity {fmtMoney(breakdown.equity)}
                · Variance {fmtMoney(overview.totals.variance)}
              </span>
            </div>
          </div>
        )}

        {/* Hide the entire dashboard body when sequential-close gate
            blocks this period or the period has never been synced.
            For never-synced periods the "Sync from QuickBooks" CTA
            above is the only actionable thing. */}
        {qbo && overview?.synced && priorBlockers.length === 0 && (
          <>
            {/* KPI strip — reconciliation-focused metrics across all
                synced accounts. GL ↔ Subledger ↔ Variance is the core
                reconciliation question; the progress card pairs the
                dollars with the workflow status (X of Y approved).
                The financial-sides breakdown (Assets / Liab / Equity)
                moved into the Sync Verification accordion below. */}
            {(() => {
              // Reconciliation progress derived from the same account list
              // the table uses. Approved-only / total / pct triple drives
              // the progress card.
              const approvedCount = overview?.accounts.filter((a) => a.review_status === "approved").length ?? 0
              const totalCount    = overview?.accounts.length ?? 0
              const progressPct   = totalCount > 0 ? Math.round((approvedCount / totalCount) * 100) : 0
              const varianceVal   = parseFloat(overview?.totals.variance ?? "0")
              const varianceTone  = Math.abs(varianceVal) > 0.5 ? "#9b3d37" : "var(--green)"
              return (
                <div className="sticky top-0 z-20 -mx-4 sm:-mx-5 px-4 sm:px-5 pt-1 pb-2"
                  style={{ background: "var(--bg)" }}>
                  {/* Default mode="sync" (no `mode` prop) lets the
                      exiting + entering motion.divs animate
                      concurrently — avoids the brief gap that
                      mode="wait" creates at the scroll boundary, which
                      surfaced as a visible flicker. */}
                  <AnimatePresence initial={false}>
                    {isKpiCompact ? (
                      <motion.div
                        key="kpi-compact"
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        transition={{ duration: 0.16, ease: "easeOut" }}
                        className="rounded-lg flex items-center gap-3 sm:gap-5 px-4 py-2.5 overflow-x-auto"
                        style={{
                          background: "var(--surface)",
                          border: "1px solid var(--border)",
                          boxShadow: "0 4px 12px rgba(0,0,0,0.06)",
                        }}>
                        <KpiInline label="GL"  value={fmtMoney(overview?.totals.gl ?? 0)} tone="var(--text)" />
                        <KpiInline label="SL"  value={fmtMoney(overview?.totals.subledger ?? 0)} tone="var(--text)" />
                        <KpiInline label="Var" value={fmtMoney(overview?.totals.variance ?? 0)} tone={varianceTone}
                          badge={Math.abs(varianceVal) > 0.5
                            ? `${varianceCount} off`
                            : "Reconciled"} />
                        <div className="ml-auto flex items-center gap-2 shrink-0">
                          <span className="text-[11px] font-semibold tabular-nums" style={{ color: progressPct === 100 ? "var(--green)" : "var(--text)" }}>
                            {approvedCount}/{totalCount}
                          </span>
                          <div className="h-1.5 w-20 rounded-full overflow-hidden" style={{ background: "var(--surface-2)" }}>
                            <motion.div className="h-full"
                              initial={{ width: 0 }}
                              animate={{ width: `${progressPct}%` }}
                              transition={{ duration: 0.4, ease: "easeOut" }}
                              style={{ background: progressPct === 100 ? "var(--green)" : "var(--text-muted)" }} />
                          </div>
                          <span className="text-[10px] hidden sm:inline" style={{ color: "var(--text-muted)" }}>
                            {progressPct}%
                          </span>
                        </div>
                      </motion.div>
                    ) : (
                      <motion.div
                        key="kpi-full"
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        transition={{ duration: 0.16, ease: "easeOut" }}
                        className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                        <Kpi label="GL balance"        value={fmtMoney(overview?.totals.gl ?? 0)}        tone="var(--text)"
                          sub="signed sum across synced accounts" />
                        <Kpi label="Subledger balance" value={fmtMoney(overview?.totals.subledger ?? 0)} tone="var(--text)"
                          sub="signed sum across subledgers" />
                        <Kpi label="Variance"          value={fmtMoney(overview?.totals.variance ?? 0)}
                          tone={varianceTone}
                          sub={varianceCount > 0
                            ? `${varianceCount} account${varianceCount === 1 ? "" : "s"} off`
                            : `${totalCount} account${totalCount === 1 ? "" : "s"} · all reconciled`} />
                        <Kpi label="Reconciliation progress"
                          value={`${approvedCount} / ${totalCount}`}
                          tone={progressPct === 100 ? "var(--green)" : "var(--text)"}
                          sub={`${progressPct}% approved`} />
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )
            })()}

            {/* Trial-Balance Check — proves the QBO sync is internally
                consistent. Assets − (L+E) MUST equal YTD Net Income from
                the P&L. If those two match, the books are in balance and
                you can trust everything else on this page. If they
                don't, something's missing from the sync (unposted JE,
                gap in the P&L pull, wrong fiscal year, …) and the
                user should re-sync before doing reconciliation work.
                Financial-side cards (Assets / Liab / Equity / Implied NI)
                live inside the accordion body alongside the equation. */}
            {overview?.tb_check && (
              <TrialBalanceCheckCard check={overview.tb_check} breakdown={breakdown} />
            )}

            {/* Status buckets — clicking Approve on a row moves it from
                Open to Approved, so the close-in-progress queue stays
                clean. Default lands on Open so reviewers immediately see
                "what's left to do" for the period. */}
            <div className="flex items-center gap-1 flex-wrap rounded-lg p-1"
              style={{ background: "var(--surface-2)", border: "1px solid var(--border)", width: "fit-content" }}>
              {([
                { key: "open",     label: "Open",     fg: "#9b3d37", bg: "#f7eeec" },
                { key: "reviewed", label: "Prepared", fg: "#3c5a76", bg: "#e9eef3" },
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
                        ? `${bucketCounts.approved} approved · ${bucketCounts.reviewed} prepared.`
                        : "Try clearing the search or switching the status bucket."}
                  </p>
                </div>
              ) : (
                <>
                  {/* Bulk-action toolbar — only when rows are selected */}
                  {selected.size > 0 && (
                    <>
                    <div className="px-4 py-2 flex items-center gap-2 flex-wrap"
                      style={{
                        background: blockedByVariance ? "#f7eeec" : "var(--green-subtle)",
                        borderBottom: "1px solid var(--border)",
                      }}>
                      <span className="text-[11px] font-semibold"
                        style={{ color: blockedByVariance ? "#86332e" : "var(--green)" }}>
                        {selected.size} selected
                      </span>
                      {/* Mark prepared — open to all roles. Preparers'
                          actual workflow IS marking accounts prepared
                          (maker side of maker/checker). Backend role
                          gate matches: reviewed is open, approved +
                          flagged stay reviewer/admin only.
                          Variance gate: blocked when ANY selected
                          account has |variance| > 1¢. A recon can only
                          progress when SL ties to GL or the gap is
                          documented via a reconciling item that
                          zeros it. */}
                      <Button size="sm" variant="outline" icon={<Eye size={11} strokeWidth={1.8} />}
                        loading={bulkStatusMut.isPending}
                        disabled={blockedByVariance}
                        onClick={() => bulkStatusMut.mutate("reviewed")}
                        title={blockedByVariance ? blockedTooltip : undefined}
                      >
                        Mark prepared
                      </Button>
                      {canReview && (
                        <>
                          <Button size="sm" icon={<CheckCircle2 size={11} strokeWidth={1.8} />}
                            loading={bulkStatusMut.isPending}
                            disabled={blockedByVariance}
                            onClick={() => bulkStatusMut.mutate("approved")}
                            title={blockedByVariance ? blockedTooltip : undefined}
                          >
                            Approve
                          </Button>
                          {/* Flag is informational ("needs reviewer attention")
                              and not blocked by variance — flagging is exactly
                              the right move when variance won't clear easily. */}
                          <Button size="sm" variant="outline" icon={<AlertTriangle size={11} strokeWidth={1.8} />}
                            loading={bulkStatusMut.isPending}
                            onClick={() => bulkStatusMut.mutate("flagged")}
                            style={{ borderColor: "#ecd7d3", color: "#9b3d37" }}
                          >
                            Flag
                          </Button>
                        </>
                      )}
                      {!canReview && (
                        <span className="text-[11px] italic" style={{ color: "var(--text-muted)" }}>
                          A reviewer needs to approve or flag selected accounts.
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
                    {blockedByVariance && (
                      <div className="px-4 py-2 text-[11px] flex items-start gap-2"
                        style={{ background: "#f7eeec", color: "#86332e", borderBottom: "1px solid #ecd7d3" }}>
                        <AlertTriangle size={12} strokeWidth={2} className="shrink-0 mt-px" />
                        <span>
                          <span className="font-semibold">Variance must be zero before approval.</span>{" "}
                          {selectedAccountsWithVariance.length} selected{" "}
                          {selectedAccountsWithVariance.length === 1 ? "account is" : "accounts are"} still out of balance.
                          Post the missing JE in QuickBooks (the Schedules &gt; Scan GL banners suggest the entries),
                          click Re-sync, or add a reconciling item that explains the gap. Once variance hits zero,
                          Mark prepared and Approve unlock automatically.
                        </span>
                      </div>
                    )}
                    </>
                  )}

                  <div className="overflow-x-auto">
                  <table className="w-full min-w-[920px] text-sm">
                    <thead>
                      <tr style={{
                        background: "var(--surface-2)",
                        borderBottom: "1px solid var(--border)",
                      }}>
                        <th className="px-3 py-1.5 text-center" style={{ width: 32 }}>
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
                            className="text-[10px] font-semibold uppercase tracking-wide px-3 py-1.5 whitespace-nowrap"
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
                        // Drawer is the only drill-in path now — clicking
                        // a row opens the right-side panel (or bottom
                        // sheet on mobile). Inline accordion is gone.
                        const isDrawerOpen = drawerAcctId === a.qbo_id
                        return (
                          <Fragment key={a.qbo_id}>
                          <tr
                            onClick={() => setDrawerAcctId(isDrawerOpen ? null : a.qbo_id)}
                            style={{
                              borderBottom: "1px solid var(--border)",
                              cursor: "pointer",
                              background: isSelected
                                ? "var(--green-subtle)"
                                : isDrawerOpen
                                  ? "var(--surface-2)"
                                  : status === "approved"
                                    ? "rgba(79, 160, 122, 0.04)"
                                    : "transparent",
                            }}
                            className="transition-colors"
                            onMouseEnter={(e) => { if (!isSelected && !isDrawerOpen) (e.currentTarget as HTMLElement).style.background = "var(--surface-2)" }}
                            onMouseLeave={(e) => {
                              if (!isSelected && !isDrawerOpen) {
                                (e.currentTarget as HTMLElement).style.background =
                                  status === "approved" ? "rgba(79, 160, 122, 0.04)" : ""
                              }
                            }}
                          >
                            <td className="px-3 py-1.5 text-center" onClick={(e) => e.stopPropagation()}>
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
                            <td className="px-3 py-1.5 font-mono text-xs" style={{ color: "var(--text-2)" }}>
                              {a.account_number || "—"}
                            </td>
                            <td className="px-3 py-1.5">
                              <span className="text-sm font-medium text-theme">{a.account_name}</span>
                            </td>
                            <td className="px-3 py-1.5">
                              <span className="inline-flex items-center gap-1 text-[11px] font-medium">
                                <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
                                <span style={{ color: "var(--text-2)" }}>{a.group_label}</span>
                              </span>
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums text-sm text-theme">
                              {fmtMoney(a.gl_balance)}
                            </td>
                            <td className="px-3 py-1.5 text-right text-sm tabular-nums whitespace-nowrap" style={{ color: "var(--text-2)" }}>
                              {/* inline-flex keeps the Roll-fwd / manual pill
                                  on the SAME line as the balance — without
                                  it the pill wraps below on narrow columns
                                  and doubles the row height. */}
                              <span className="inline-flex items-center justify-end gap-1.5">
                                <span>{fmtMoney(a.subledger_balance)}</span>
                                {a.subledger_is_manual && (
                                  <span className="inline-block h-1.5 w-1.5 rounded-full"
                                    style={{ background: "var(--green)" }}
                                    title="Subledger saved for this period" />
                                )}
                                {!a.subledger_is_manual && a.subledger_is_rollforward && (
                                  <span className="inline-flex items-center text-[9px] font-bold uppercase tracking-wide px-1 py-0.5 rounded"
                                    style={{
                                      background: "rgba(78, 110, 142, 0.15)",
                                      color: "#3c5a76",
                                    }}
                                    title={`Rolled forward from prior close subledger (${a.rollforward_from}). Open the row to tick reconciling items.`}>
                                    Roll fwd
                                  </span>
                                )}
                              </span>
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums text-sm font-medium"
                              style={{ color: hasVariance ? "#9b3d37" : "var(--green)" }}>
                              {hasVariance ? fmtMoney(a.variance) : "—"}
                            </td>
                            <td className="px-3 py-1.5 text-center" onClick={(e) => e.stopPropagation()}>
                              <AttachmentsCell files={a.evidence_files ?? []} />
                            </td>
                            <td className="px-3 py-1.5" onClick={(e) => e.stopPropagation()}>
                              <div className="inline-flex items-center gap-1.5">
                                <StatusChip
                                  status={status}
                                  disabled={isClosed}
                                  onChange={(next) => setStatusMut.mutate({ id: a.qbo_id, status: next })}
                                />
                                {/* AI-prepared badge — appears on any row the
                                    agentic preparer touched. Click the row to
                                    expand and read the full AI Commentary card. */}
                                {a.ai_commentary && (
                                  <span
                                    className="inline-flex items-center justify-center h-5 w-5 rounded-full"
                                    style={{
                                      background: "var(--green-subtle)",
                                      border: "1px solid var(--green)",
                                      color: "var(--green)",
                                    }}
                                    title={
                                      `AI-prepared · Confidence: ${a.ai_commentary.confidence} · ` +
                                      `Recommendation: ${a.ai_commentary.recommendation}. ` +
                                      `Click the row for the full AI Commentary.`
                                    }
                                  >
                                    <Sparkles size={10} strokeWidth={2} />
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="px-3 py-1.5" onClick={(e) => e.stopPropagation()}>
                              <div className="flex items-center justify-end gap-1.5">
                                {/* Per-row QBO sync — icon-only to keep the
                                    action cluster compact. Hidden on
                                    closed periods (no edits). */}
                                {!isClosed && (
                                  <button
                                    onClick={() => {
                                      // Approved accounts are frozen in Nordavix.
                                      // Re-syncing is the only thing that calls
                                      // QBO again and it re-opens the account —
                                      // confirm before clearing the approval.
                                      if (a.review_status === "approved") {
                                        const ok = window.confirm(
                                          `${a.account_name} is approved.\n\nRe-syncing pulls fresh data from ` +
                                          `QuickBooks and re-opens it for review (its approval will be cleared).\n\nContinue?`,
                                        )
                                        if (!ok) return
                                      }
                                      rowSyncMut.mutate(a.qbo_id)
                                    }}
                                    disabled={rowSyncMut.isPending && rowSyncMut.variables === a.qbo_id}
                                    className="inline-flex items-center justify-center rounded-md h-6 w-6 transition-colors"
                                    style={{
                                      color: "var(--text-2)",
                                      border: "1px solid var(--border-strong)",
                                      background: "var(--surface)",
                                    }}
                                    title={a.review_status === "approved"
                                      ? "Re-sync from QuickBooks (re-opens this approved account for review)"
                                      : "Sync this account's GL balance from QuickBooks"}
                                    onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--green)")}
                                    onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--border-strong)")}
                                  >
                                    {rowSyncMut.isPending && rowSyncMut.variables === a.qbo_id ? (
                                      <Spinner className="h-3 w-3" />
                                    ) : (
                                      <RefreshCw size={11} strokeWidth={1.8} />
                                    )}
                                  </button>
                                )}
                                {/* Per-row Agentic — open to all roles.
                                    Hidden when period is closed (no edits
                                    possible). Confirms before overwriting
                                    existing ai_commentary. `whitespace-nowrap`
                                    keeps icon + label on one line even when
                                    the table is narrow; `shrink-0` stops the
                                    flex container from squeezing it. */}
                                {!isClosed && (
                                  <button
                                    onClick={() => triggerRowAgentic(a)}
                                    disabled={rowAgenticMut.isPending && rowAgenticMut.variables === a.qbo_id}
                                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors whitespace-nowrap shrink-0"
                                    style={{
                                      color: a.ai_commentary ? "var(--green)" : "var(--text-2)",
                                      border: `1px solid ${a.ai_commentary ? "var(--green)" : "var(--border-strong)"}`,
                                      background: a.ai_commentary ? "var(--green-subtle)" : "var(--surface)",
                                    }}
                                    title={a.ai_commentary
                                      ? "Re-run AI on this account (overwrites existing analysis)"
                                      : "Run AI on this account: pulls QBO transactions + structured analysis"}
                                  >
                                    {rowAgenticMut.isPending && rowAgenticMut.variables === a.qbo_id ? (
                                      <Spinner className="h-3 w-3" />
                                    ) : (
                                      <Sparkles size={11} strokeWidth={1.8} />
                                    )}
                                    Run AI
                                  </button>
                                )}
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
                                {/* Variance button removed per user direction
                                    — the inline accordion already surfaces
                                    transactions/reconciling-items for the
                                    account; the standalone Variance drawer
                                    was redundant. */}
                                {/* "Download PDF" — available once the row is
                                    Prepared (reviewed) or Approved so the user
                                    can pull a working-paper file for either
                                    state. Prepared exports carry a DRAFT
                                    watermark; approved exports are clean. */}
                                {(status === "approved" || status === "reviewed") && (
                                  <DownloadReconButton
                                    qboAccountId={a.qbo_id}
                                    periodEnd={periodEnd}
                                    accountName={a.account_name}
                                  />
                                )}
                              </div>
                            </td>
                          </tr>
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
            periodEnd={periodEnd}
            onClose={() => setDrawerAccount(null)}
          />
        )}
      </AnimatePresence>

      {/* The manual-subledger editor now opens inline as an expanded row
          inside the table (see InlineSubledgerForm). No modal needed. */}

      {/* Right-side detail drawer. Picked when the user toggles "Drawer"
          mode above the table. Embeds the same InlineSubledgerForm the
          inline accordion uses — so the deep workflow (subledger build-
          up, reconciling items, evidence, AI commentary) is 1:1 with no
          drift risk. Sticky footer at the bottom holds the maker/checker
          actions (Mark prepared / Approve / Re-open). */}
      <AccountDetailDrawer
        account={
          drawerAcctId
            ? filteredAccounts.find((a) => a.qbo_id === drawerAcctId) ?? null
            : null
        }
        accounts={filteredAccounts}
        periodEnd={periodEnd}
        // Lock the drawer when the period is closed OR the specific
        // account is already approved. Approved rows are signed off —
        // opening one should never auto-save changes underneath the
        // user. To edit an approved row they must click "Reopen" in
        // the footer first, which flips status back to pending.
        readOnly={isClosed}
        onNavigate={(a) => setDrawerAcctId(a.qbo_id)}
        onClose={() => setDrawerAcctId(null)}
        renderBankBody={(a) => (
          <BankReconWorksheet
            key={a.qbo_id}
            qboAccountId={a.qbo_id}
            periodEnd={periodEnd}
            glBalance={a.gl_balance}
            readOnly={isClosed || a.review_status === "approved" || a.review_status === "reviewed"}
          />
        )}
        renderReconcileBody={(a, section) => (
          <InlineSubledgerForm
            // key={qbo_id} forces a fresh mount when the user navigates
            // Next/Prev between accounts in the drawer. Without it the
            // form retained the PREVIOUS account's selectedItemMap,
            // computed a wrong subledger off the new account's GL +
            // old items, and the next tick auto-saved that garbage
            // back to the server — visible as phantom variances on
            // rows the user only "clicked through".
            key={a.qbo_id}
            account={a}
            periodEnd={periodEnd}
            saving={subledgerMut.isPending}
            // Lock the form once it's Approved OR Prepared (reviewed). A prepared
            // recon is frozen — the preparer can't change entries; their only
            // move is "Reset to open" in the footer (until a reviewer approves).
            readOnly={isClosed || a.review_status === "approved" || a.review_status === "reviewed"}
            // Distinct from readOnly — the form uses this to show the
            // right banner copy. "books closed" wins when both apply
            // since reopening the row alone wouldn't unlock anything.
            periodClosed={isClosed}
            // The form stays mounted across tab swaps — the section
            // prop just toggles visibility of sub-sections via CSS.
            // No remount, no query refetch, no state loss.
            visibleSection={section}
            hideHeader
            hideFooter
            onSave={(total, source, items) => {
              // Defense in depth: even if a stale form somehow tries
              // to save against an approved row, refuse the write.
              if (a.review_status === "approved" || a.review_status === "reviewed") return
              subledgerMut.mutate({ qboId: a.qbo_id, total, source, items })
              // Guard above already blocked Approved + Prepared, so this row is
              // still Pending/Flagged → promote it to Prepared (the maker step).
              setStatusMut.mutate({ id: a.qbo_id, status: "reviewed" })
            }}
            onAutoSave={(total, source, items) => {
              if (a.review_status === "approved" || a.review_status === "reviewed") return
              subledgerMut.mutate({
                qboId: a.qbo_id, total, source, items, autoSave: true,
              })
            }}
            onPreview={(total) => {
              // Instant, network-free: paint the dashboard figures the moment
              // a row is ticked. We deliberately DON'T pass items here — leaving
              // the cached reconciling_items as the server's copy keeps the
              // debounced onAutoSave's "matches server" gate honest, so the
              // real persist still fires a beat later.
              if (a.review_status === "approved" || a.review_status === "reviewed") return
              patchOverviewCache(a.qbo_id, total, "Saving…")
            }}
            onClear={() => {
              if (a.review_status === "approved" || a.review_status === "reviewed") return
              subledgerMut.mutate({ qboId: a.qbo_id, total: null, source: null, items: [] })
            }}
            onClose={() => setDrawerAcctId(null)}
          />
        )}
        renderFooter={(a, ctx) => (
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-1.5 text-[10.5px]"
              style={{ color: "var(--text-muted)" }}>
              <span className="font-semibold uppercase tracking-wider">Status</span>
              <span className="px-1.5 py-0.5 rounded font-bold uppercase tracking-wider"
                style={{
                  background:
                    a.review_status === "approved" ? "rgba(79, 160, 122, 0.12)" :
                    a.review_status === "reviewed" ? "rgba(78, 110, 142, 0.12)" :
                    a.review_status === "flagged"  ? "rgba(176, 86, 78, 0.12)"  :
                                                     "var(--surface-2)",
                  color:
                    a.review_status === "approved" ? "#2e7a55" :
                    a.review_status === "reviewed" ? "#3c5a76" :
                    a.review_status === "flagged"  ? "#9b3d37" :
                                                     "var(--text-muted)",
                }}>
                {a.review_status}
              </span>
            </div>
            {!isClosed && (
              <div className="flex items-center gap-1.5 flex-wrap">
                {/* Per-row AI: same handler as the row-level Run AI button. */}
                <Button
                  size="sm"
                  variant="outline"
                  icon={<Sparkles size={12} strokeWidth={1.8} />}
                  loading={rowAgenticMut.isPending && rowAgenticMut.variables === a.qbo_id}
                  onClick={() => triggerRowAgentic(a)}
                  title={a.ai_commentary
                    ? "Re-run AI (overwrites existing analysis)"
                    : "Run AI on this account"}>
                  {a.ai_commentary ? "Re-run AI" : "Run AI"}
                </Button>
                {/* Re-open: only when row has been signed off — and only for
                    reviewers/admins. A preparer can't reopen an approved
                    reconciliation (the backend enforces this too). */}
                {a.review_status === "approved" && canReview && (
                  <Button
                    size="sm"
                    variant="outline"
                    icon={<RotateCcw size={12} strokeWidth={1.8} />}
                    loading={setStatusMut.isPending}
                    onClick={() => setStatusMut.mutate({ id: a.qbo_id, status: "pending" })}>
                    Re-open
                  </Button>
                )}
                {/* Mark prepared: when row is in the open queue.
                    Two-layer gate:
                      1) Variance gate — disabled when |variance| > 1¢
                         so a row can never be marked prepared while
                         still out of balance.
                      2) Suggestions-viewed gate — when AI has surfaced
                         per-account schedule suggestions (prepaid /
                         accrual / FA / lease / loan), the user must
                         open the Suggestions tab at least once before
                         we let them mark prepared or approve. The
                         drawer body shows a purple callout pushing
                         them to that tab while the gate is active. */}
                {(() => {
                  const rowVarianceBlocked = Math.abs(parseFloat(a.variance) || 0) > VARIANCE_TOLERANCE
                  const suggestionsUnreviewed = ctx.hasSuggestions && !ctx.hasViewedSuggestionsTab
                  const disabled = rowVarianceBlocked || suggestionsUnreviewed
                  const tooltip = rowVarianceBlocked
                    ? "Variance must be cleared before marking prepared. Post the missing JE in QuickBooks (Schedules > Scan GL suggests entries), re-sync, or add a reconciling item that zeros the gap."
                    : suggestionsUnreviewed
                    ? "Open the Suggestions tab first — auto-detected schedule entries are waiting for review."
                    : undefined
                  return (
                    <>
                      {(a.review_status === "pending" || a.review_status === "flagged") && (
                        <Button
                          size="sm"
                          variant="outline"
                          icon={<CheckCircle2 size={12} strokeWidth={1.8} />}
                          loading={setStatusMut.isPending}
                          disabled={disabled}
                          onClick={() => setStatusMut.mutate({ id: a.qbo_id, status: "reviewed" })}
                          title={tooltip}>
                          Mark prepared
                        </Button>
                      )}
                      {/* Prepared state. The preparer's ONLY move is to send it
                          back to Open to edit — and only before approval (this
                          whole block is gone once the row is Approved). Approval
                          itself is the reviewer's/admin's job, so it's gated to
                          canReview (a preparer can't self-approve their work). */}
                      {a.review_status === "reviewed" && (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            icon={<RotateCcw size={12} strokeWidth={1.8} />}
                            loading={setStatusMut.isPending}
                            onClick={() => setStatusMut.mutate({ id: a.qbo_id, status: "pending", preserve: true })}
                            title="Unlock for editing — sends this reconciliation back to Open, keeping your ticked items and subledger. Only available before a reviewer approves it.">
                            Reset to open
                          </Button>
                          {canReview && (
                            <Button
                              size="sm"
                              icon={<ShieldCheck size={12} strokeWidth={1.8} />}
                              loading={setStatusMut.isPending}
                              disabled={disabled}
                              onClick={() => setStatusMut.mutate({ id: a.qbo_id, status: "approved" })}
                              title={tooltip}>
                              Approve
                            </Button>
                          )}
                        </>
                      )}
                    </>
                  )
                })()}
              </div>
            )}
          </div>
        )}
      />
    </div>
  )
}

// ── StatusChip ──────────────────────────────────────────────────────────────
// Clickable dropdown-style chip. Click to cycle to the next status, or
// shift-click to skip back. Inline flow — no modal, no page navigation.

// Two-step maker/checker flow:
//   Pending → Prepared (preparer ticked reconciling items + clicked
//   "Reconcile") → Approved (reviewer/admin signed off). The underlying
//   API status stays "reviewed" so existing rows + audit log keep their
//   meaning; the UI just relabels it as "Prepared" to match how the
//   maker/checker workflow reads in finance teams.
const STATUS_META: Record<AccountReviewStatus, { label: string; bg: string; fg: string }> = {
  pending:  { label: "Pending",  bg: "var(--surface-2)",     fg: "var(--text-muted)" },
  reviewed: { label: "Prepared", bg: "#e9eef3",              fg: "#3c5a76" },
  approved: { label: "Approved", bg: "var(--green-subtle)",  fg: "var(--green)" },
  flagged:  { label: "Flagged",  bg: "#f4e9e7",              fg: "#9b3d37" },
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
    mismatch: { bg: "#f7eeec",             fg: "#9b3d37",      border: "#ecd7d3",             Icon: AlertCircle },
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
        Confidence: {v.confidence} · Verified {formatDateTime(v.verified_at)}
      </p>
    </div>
  )
}

// ── Inline subledger form ───────────────────────────────────────────────────
// Replaces the old modal — opens as an expandable row inside the table so
// the user keeps the surrounding context (other accounts, KPIs, period
// selector) visible while reconciling. Same fields: amount, source,
// roll-forward, variance preview, reconciling items, evidence + verify.

/**
 * When this form is embedded inside the right-side drawer, each
 * "section" maps to a tab. Setting `visibleSection` filters which
 * sections render at all (via CSS, so state and queries stay alive
 * across tab switches — the form is mounted once, not per-tab).
 *
 * `null` / "all" → render every section (the original accordion mode).
 */
type FormSection = "items" | "suggestions" | "evidence" | "ai"

function InlineSubledgerForm({
  account, periodEnd, saving, readOnly = false, periodClosed = false,
  onSave, onClear, onClose, onAutoSave, onPreview,
  visibleSection, hideHeader, hideFooter,
}: {
  account: OverviewAccount
  periodEnd: string
  saving: boolean
  /** True when no mutations are allowed at all — either the period is
   *  closed OR this individual row is approved. Disables every input. */
  readOnly?: boolean
  /** True ONLY when the period itself is locked (admin closed the
   *  books). Used to pick the right read-only banner copy: a closed
   *  period shows "books are closed" (needs admin to reopen the
   *  period), while a still-open period with an approved row shows
   *  "account is approved" (the row can be reopened individually).
   *  Without this, the banner can't tell which case it's in. */
  periodClosed?: boolean
  onSave: (total: number, source: string | null, items: ReconcilingItem[]) => void
  onClear: () => void
  onClose: () => void
  /** Auto-save fires (debounced) whenever the user ticks/unticks a
      reconciling item or adds/edits/removes a manual one — so the
      top KPI cards reflect the new state without an explicit save.
      Does NOT bump status to "reviewed" (only the Save button does). */
  onAutoSave?: (total: number, source: string | null, items: ReconcilingItem[]) => void
  /** Instant (non-debounced, network-free) preview: fires the moment the
      ticked selection changes so the dashboard figures update spontaneously.
      The parent uses it to optimistically patch the overview cache (figures
      only — not reconciling_items, so the debounced save still fires). */
  onPreview?: (total: number) => void
  /** Drawer-mode tab filter: when set, only sections matching this tab
   *  render (others stay mounted but display:none so state survives).
   *  Undefined = stack all sections vertically (inline-accordion mode). */
  visibleSection?: FormSection
  /** Drawer mode shows the account name + close in its own header so
   *  the form's internal header is redundant. */
  hideHeader?: boolean
  /** Drawer mode owns the sticky action footer (Mark prepared / Approve)
   *  so the form's internal Save / Clear footer is redundant. */
  hideFooter?: boolean
}) {
  // Helper: show this section's div based on visibleSection filter.
  // Returns inline style — sections always mount, just toggle visibility.
  const sectionStyle = (s: FormSection): React.CSSProperties =>
    !visibleSection || visibleSection === s ? {} : { display: "none" }
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

  // Schedule-backed accounts: the authoritative subledger BALANCE computed
  // from the Nordavix schedule (prepaid/accrual/FA/lease/loan). When present
  // it becomes the build-up's base line (the subledger auto-pulls the schedule
  // balance) instead of the rolled-forward opening — and the individual
  // schedule entries are NOT added to the reconciling items; they stay in the
  // Suggestions tab as reference. The user reconciles GL differences on top.
  const scheduleSubQuery = useQuery({
    queryKey: ["recon-schedule-subledger", account.qbo_id, periodEnd],
    queryFn:  () => reconsApi.getScheduleSubledger(account.qbo_id, periodEnd),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  })
  const scheduleSub = scheduleSubQuery.data
  // "Settled" = success OR error. Saves wait on this (not just `data`) so a
  // failed/erroring schedule-subledger fetch can't PERMANENTLY block saving —
  // on error we fall back to the rolled-forward opening, like a normal account.
  const scheduleSubSettled = scheduleSubQuery.isSuccess || scheduleSubQuery.isError

  // Transactions posted to this account in the closing period — these are
  // the candidates the user picks from to explain GL-vs-subledger variance.
  // For Retained Earnings accounts, we pass include_ytd_ni=true so the
  // backend prepends a synthetic row representing current-period net
  // income from the P&L. Ticking that row closes the variance caused by
  // QBO auto-rolling profit into RE.
  const isRetainedEarnings = (account as { is_retained_earnings?: boolean }).is_retained_earnings === true
  const { data: periodEntries, isLoading: entriesLoading } = useQuery({
    queryKey: ["recon-period-entries", account.qbo_id, periodEnd, isRetainedEarnings],
    queryFn:  () => reconsApi.getPeriodEntries(account.qbo_id, periodEnd, { includeYtdNi: isRetainedEarnings }),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  })

  // Pre-select any items the user previously saved on this override so the
  // selection round-trips cleanly. Map txn_id → ReconcilingItem.
  const [selectedItemMap, setSelectedItemMap] = useState<Record<string, ReconcilingItem>>(() => {
    const m: Record<string, ReconcilingItem> = {}
    // Only TICKED items belong in the selection map. Persisted open items
    // (cleared === false) are the un-ticked entries we record for the PDF —
    // keep them OUT so they don't render as ticked; they're re-derived at
    // save time from the live period entries. Synthetic "schedule-" items
    // (from the old auto-flow) are also dropped — the schedule balance is now
    // the build-up's base line, so keeping them would double-count.
    for (const it of account.reconciling_items ?? []) {
      if (it.cleared === false) continue
      if (it.txn_id.startsWith("schedule-")) continue
      m[it.txn_id] = it
    }
    return m
  })
  const selectedItemsRef = useRef(selectedItemMap)
  selectedItemsRef.current = selectedItemMap
  // Guards the one-time "persist the schedule base to the saved subledger"
  // auto-save per (account, period) — see the auto-save effect.
  const baseSyncedRef = useRef<string>("")

  // ── Schedule reference data (prepaid/accrual/FA/lease/loan) ────────
  //
  // The 5 per-account schedule endpoints power the Suggestions-tab panels,
  // which now render the schedule lines as REFERENCE (what makes up the
  // schedule balance). They are NOT auto-added to the reconciling items —
  // the subledger auto-pulls its value from the authoritative schedule
  // BALANCE (the `scheduleSub` query above), shown as the build-up's base
  // line. The user reconciles GL differences on top by ticking real GL
  // entries from the Items table. React Query shares cache with the panels.
  const scheduleQueries = useQueries({
    queries: [
      {
        queryKey: ["schedules", "prepaid", "suggestions", account.qbo_id, periodEnd],
        queryFn:  () => schedulesApi.getPrepaidSuggestions(account.qbo_id, periodEnd),
        staleTime: 60_000,
      },
      {
        queryKey: ["schedules", "accrual", "suggestions", account.qbo_id, periodEnd],
        queryFn:  () => schedulesApi.getAccrualSuggestions(account.qbo_id, periodEnd),
        staleTime: 60_000,
      },
      {
        queryKey: ["schedules", "fixed_asset", "suggestions", account.qbo_id, periodEnd],
        queryFn:  () => schedulesApi.getFixedAssetSuggestions(account.qbo_id, periodEnd),
        staleTime: 60_000,
      },
      {
        queryKey: ["schedules", "lease", "suggestions", account.qbo_id, periodEnd],
        queryFn:  () => schedulesApi.getLeaseSuggestions(account.qbo_id, periodEnd),
        staleTime: 60_000,
      },
      {
        queryKey: ["schedules", "loan", "suggestions", account.qbo_id, periodEnd],
        queryFn:  () => schedulesApi.getLoanSuggestions(account.qbo_id, periodEnd),
        staleTime: 60_000,
      },
    ],
  })

  /** True when any schedule has at least one item for this account —
   *  drives the UI's "schedule-backed" treatment (pre-selected schedule
   *  lines, the expected-JEs reference card, re-labeled help banner). */
  const isScheduleBacked =
    (scheduleQueries[0].data?.items?.length ?? 0) > 0
    || (scheduleQueries[1].data?.items?.length ?? 0) > 0
    || (scheduleQueries[2].data?.items?.length ?? 0) > 0
    || (scheduleQueries[3].data?.items?.length ?? 0) > 0
    || (scheduleQueries[4].data?.items?.length ?? 0) > 0

  // External resync: when something outside the form changes the row's
  // review_status (most commonly: Reset to pending, which clears the
  // backend's reconciling_items array via the optimistic patch), reset
  // the form's local selectedItemMap to match the new account state so
  // the ticks disappear immediately without requiring close + reopen.
  //
  // Also resync on account.qbo_id change — when the drawer navigates
  // Next/Prev between accounts the parent now passes key={qbo_id} so
  // the form remounts. This effect is the belt-and-suspenders for any
  // case the parent re-uses the form across accounts without a key.
  useEffect(() => {
    const m: Record<string, ReconcilingItem> = {}
    // Skip persisted open items (cleared === false) and legacy "schedule-"
    // synthetics — ticked GL/manual items only.
    for (const it of account.reconciling_items ?? []) {
      if (it.cleared === false) continue
      if (it.txn_id.startsWith("schedule-")) continue
      m[it.txn_id] = it
    }
    setSelectedItemMap(m)
    // Only resync on identity / status change — re-running every render
    // would clobber the user's in-flight ticks before the debounced
    // save fires. The auto-save effect below is content-gated so we
    // don't need a "skip first" counter anymore.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.qbo_id, account.review_status])

  function toggleItem(item: ReconcilingItem) {
    // Reconciling items are the GL transactions the user ticks to explain a
    // variance. For schedule-backed accounts the subledger base auto-pulls the
    // schedule balance, so ticking here only adjusts GL differences on top.
    setSelectedItemMap((prev) => {
      const next = { ...prev }
      if (next[item.txn_id]) delete next[item.txn_id]
      else next[item.txn_id] = item
      return next
    })
  }

  const selectedItems = Object.values(selectedItemMap)
  // Liability/equity accounts are credit-natural: GL balance is stored
  // signed-negative ("($60,371)"), but QBO returns each transaction's
  // amount in its account-natural sign (a credit on a liability comes
  // back POSITIVE). To make the build-up math work — opening + items
  // = closing, in the same sign convention as the GL balance — we
  // flip the sign of QBO items on credit-natural accounts. Manual
  // items entered by the user already use signed convention (the form
  // labels the field "Amount (± signed)") so they're not flipped.
  const flipSign = isCreditNatural(account.group_label) ? -1 : 1
  const signedAmount = (it: ReconcilingItem): number => {
    const raw = parseFloat(it.amount) || 0
    return it.txn_id.startsWith("manual-") ? raw : flipSign * raw
  }
  // Schedule-sourced lines live in the build-up's base (the auto-pulled schedule
  // balance), so they never count in the reconciling-items sum — guard against
  // any stray legacy "schedule-" item double-counting.
  const selectedSum = selectedItems
    .filter((it) => !it.txn_id.startsWith("schedule-"))
    .reduce((n, it) => n + signedAmount(it), 0)

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
  // Opening = the canonical rolled-forward value the backend computes
  // (prior period's reconciled subledger → prior period's GL snapshot →
  // $0). We use that field directly so the form ALWAYS shows opening =
  // prior close, never the current saved subledger. The old client-side
  // fallback to `account.subledger_balance` was visibly wrong for AI-
  // prepared rows: AI saves the closing as subledger_balance, then the
  // form treated that closing as the opening + re-added items on top.
  const openingBalance = parseFloat(
    account.rollforward_opening_balance
    ?? prior?.subledger_total
    ?? "0"
  )

  // For SCHEDULE-BACKED accounts the build-up's base is the schedule's
  // authoritative computed balance (auto-pulled from the backend), NOT the
  // rolled-forward opening — the individual schedule entries are deliberately
  // not listed/ticked here (they live in the Suggestions tab as reference).
  // sl_signed is already in the GL's signed convention, so it's used directly
  // (no flipSign). Ticked reconciling items adjust GL differences on top.
  // Falls back to the rolled-forward opening before the schedule query loads
  // (or for non-schedule accounts).
  const scheduleBaseBalance =
    isScheduleBacked && scheduleSub?.subledger_balance != null
      ? parseFloat(scheduleSub.subledger_balance)
      : null
  const baseBalance = scheduleBaseBalance ?? openingBalance
  const computedSubledger = baseBalance + selectedSum
  // Label for the build-up's base line when it's a schedule balance.
  const scheduleBaseLabel = scheduleBaseBalance != null
    ? `Per Nordavix ${SCHEDULE_TYPE_LABEL[scheduleSub?.schedule_type ?? ""] ?? "schedule"} schedule`
    : null

  // Auto-save: when the user ticks an item (or edits the manual list)
  // debounce 500ms and push to the backend so the top KPI cards (which
  // read from the overview snapshot) refresh immediately.
  //
  // Content-gated: we only auto-save when the form's items DIFFER from
  // what the server already has. That prevents the classic phantom-save
  // bug — on mount, the resync effect calls setSelectedItemMap with a
  // new object reference (same items). The reference change triggers
  // THIS effect, but the items match the server, so we skip the write
  // and the saved subledger stays intact. Same protection for any
  // future code path that re-syncs items from the server.
  //
  // Hashing keeps the comparison cheap even with many items: same set
  // of (txn_id, amount, memo) tuples → no save needed.
  //
  // The persisted payload is the FULL picture: ticked items (cleared:true)
  // PLUS the un-ticked current-period entries (cleared:false). The un-ticked
  // ones surface as "open items" in the PDF — they're the unreconciled gap.
  // Open items are NEVER part of the subledger math: computedSubledger uses
  // ticked items only, and the backend skips cleared:false when summing.
  // Schedule-backed accounts skip open-item derivation: the schedule balance is
  // the subledger base, so an un-ticked GL row isn't an "unreconciled gap" — it
  // just matches the schedule. Only explicitly-ticked GL differences are saved.
  const buildSavePayload = (): ReconcilingItem[] => {
    const sel = selectedItemsRef.current
    const ticked = Object.values(sel).map((it) => ({ ...it, cleared: true }))
    const open = isScheduleBacked
      ? []
      : (periodEntries?.rows ?? [])
          .filter((r) => !sel[r.txn_id])
          .map((r) => ({ ...r, cleared: false }))
    return [...ticked, ...open]
  }
  useEffect(() => {
    if (readOnly || !onAutoSave) return
    // Wait for the schedule balance to RESOLVE (success or error) before any
    // save — otherwise a schedule-backed account could persist the rolled-
    // forward fallback base (often $0) before scheduleSub loads. Keying off
    // "settled" (not just data) means an erroring fetch can't block saves
    // forever; it just falls back to the opening, like a normal account.
    if (!scheduleSubSettled) return
    const hash = (items: ReconcilingItem[]) => items
      .map((it) => `${it.txn_id}:${it.amount}:${it.memo ?? ""}:${it.cleared === false ? "0" : "1"}`)
      .sort()
      .join("|")
    const currentHash = hash(buildSavePayload())
    const serverHash  = hash(account.reconciling_items ?? [])
    // For schedule-backed accounts the subledger base auto-pulls the schedule
    // balance, which isn't a "reconciling item" — so persist it once per
    // (account, period) when the saved subledger doesn't yet match it. Without
    // this, a never-prepared schedule account would tie in the drawer but show
    // a variance on the dashboard (which reads the saved subledger_total).
    const baseKey = `${account.qbo_id}__${periodEnd}`
    const savedSub = parseFloat(account.subledger_balance ?? "0")
    const baseNeedsPersist =
      scheduleBaseBalance != null
      && baseSyncedRef.current !== baseKey
      && Math.abs(computedSubledger - savedSub) > 0.005
    if (currentHash === serverHash && !baseNeedsPersist) return  // nothing to save
    if (baseNeedsPersist) baseSyncedRef.current = baseKey

    const handle = setTimeout(() => {
      const itemsList = buildSavePayload()
      const tickedCount = itemsList.filter((it) => it.cleared !== false).length
      const openCount   = itemsList.length - tickedCount
      const source = itemsList.length === 0
        ? (scheduleBaseLabel ? scheduleBaseLabel : "Auto-saved (no reconciling items)")
        : `Auto-saved ${tickedCount} reconciling item${tickedCount === 1 ? "" : "s"}`
          + (openCount > 0 ? ` · ${openCount} open` : "")
      onAutoSave(computedSubledger, source, itemsList)
    }, 500)
    return () => clearTimeout(handle)
    // We deliberately omit `computedSubledger` from the deps because
    // it changes whenever `prior` resolves — and a prior-query result
    // changing should NOT trigger a save. The save body reads the
    // current computedSubledger at fire time from the ref-backed live
    // closure, so it'll pick up whatever the latest value is. periodEntries
    // is included so newly-loaded open items get persisted once known.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedItemMap, account.reconciling_items, readOnly, onAutoSave, isScheduleBacked, periodEntries, scheduleSub, scheduleSubSettled])

  // Live preview — INSTANT and network-free. The moment the ticked selection
  // changes, paint the dashboard's per-row subledger/variance and KPI strip
  // optimistically. The debounced auto-save above persists the same numbers a
  // beat later; this just removes the wait so the figures move spontaneously.
  // Gated on a real edit (payload differs from the server) so merely OPENING
  // the drawer never flips a row — same protection as the auto-save effect.
  useEffect(() => {
    if (readOnly || !onPreview) return
    if (!scheduleSubSettled) return  // wait for the schedule base to settle (see auto-save)
    const hash = (items: ReconcilingItem[]) => items
      .map((it) => `${it.txn_id}:${it.amount}:${it.memo ?? ""}:${it.cleared === false ? "0" : "1"}`)
      .sort()
      .join("|")
    if (hash(buildSavePayload()) === hash(account.reconciling_items ?? [])) return
    onPreview(computedSubledger)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedItemMap, computedSubledger, account.reconciling_items, scheduleSub, scheduleSubSettled])

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
      style={{ borderLeftColor: readOnly ? "#c79a52" : "var(--green)" }}>
      {!hideHeader && (
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-wide"
              style={{ color: readOnly ? "#8a6326" : "var(--green)" }}>
              {readOnly ? "Locked period · view only" : "Manual subledger"} · {periodEnd}
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
      )}

      {/* Read-only banner — explains WHY nothing's clickable.
          readOnly fires for two distinct reasons; the copy needs to
          match the actual cause or the user gets misled (the period
          isn't necessarily closed just because the row is approved).
            (a) periodClosed         — admin locked the whole period.
                Reopen lives on the dashboard's close-progress card.
            (b) account approved but period open — row was signed off
                but the period is still active. The row can be
                reopened individually from the drawer footer. */}
      {readOnly && (
        <div className="rounded-md px-3 py-2 mb-3 flex items-center gap-2 text-[11px]"
          style={{ background: "rgba(199, 154, 82, 0.10)", border: "1px solid rgba(199, 154, 82, 0.40)", color: "#7a5622" }}>
          <Lock size={11} strokeWidth={2} />
          <span>
            {periodClosed ? (
              <>
                The books for {periodEnd} are closed. You can review every reconciling
                item and attachment, but editing is locked until an admin reopens the
                period from the dashboard.
              </>
            ) : account.review_status === "reviewed" ? (
              <>
                This reconciliation is marked <b>Prepared</b> — entries are locked so
                the numbers can't change while it's waiting for review. To edit, click{" "}
                <b>Reset to open</b> in the footer (only possible before a reviewer
                approves it).
              </>
            ) : (
              <>
                This account is approved — editing is locked. Only a reviewer or admin
                can <b>Reopen</b> it (in the footer) to make changes.
              </>
            )}
          </span>
        </div>
      )}

      {/* ── AI Commentary card ────────────────────────────────────────
          Appears when the agentic preparer tied this row out. Tabular
          layout: confidence + recommendation pills, narrative paragraph,
          then the deterministic checks list with pass/warn/fail status
          per row. The reviewer reads this BEFORE the build-up form,
          decides whether to trust the AI's work, then approves (or
          edits + saves to override). */}
      <div style={sectionStyle("ai")}>
        {account.ai_commentary && (
          <AiCommentaryCard commentary={account.ai_commentary} />
        )}
        {!account.ai_commentary && visibleSection === "ai" && (
          <div className="rounded-lg px-4 py-6 text-center text-[12px]"
            style={{ background: "var(--surface)", border: "1px dashed var(--border)", color: "var(--text-muted)" }}>
            No AI commentary yet for this account. Run Agentic Mode from the
            account row actions to generate a narrative + check list.
          </div>
        )}
      </div>

      {/* ── Suggestions group (prepaid / accrual / FA / lease / loan) ── */}
      <div style={sectionStyle("suggestions")}>

      {/* Help banner — explains what populates this tab. Only renders in
          drawer mode (visibleSection !== undefined) so the inline
          accordion stays uncluttered. */}
      {visibleSection === "suggestions" && (
        <div className="rounded-md px-3 py-2 mb-3 text-[11px] flex items-start gap-2"
          style={{
            background: isScheduleBacked ? "var(--green-subtle)" : "var(--surface)",
            border: `1px ${isScheduleBacked ? "solid" : "dashed"} ${isScheduleBacked ? "var(--green)" : "var(--border-strong)"}`,
            color: isScheduleBacked ? "var(--green)" : "var(--text-muted)",
          }}>
          <Sparkles size={12} strokeWidth={1.8} style={{ color: isScheduleBacked ? "var(--green)" : "var(--green)", marginTop: 2, flexShrink: 0 }} />
          <span>
            {isScheduleBacked ? (
              <>
                <strong style={{ color: "var(--green)" }}>Nordavix Schedules backs this account's subledger.</strong>{" "}
                The subledger auto-pulls the schedule's balance — shown as the
                base line in the build-up — so nothing here is auto-added or
                needs ticking. The lines below are for reference (what makes up
                that balance). To reconcile a GL difference, tick the real
                posted entries from the QuickBooks list in the Items tab. Edit
                the amounts in the Schedules module.
              </>
            ) : (
              <>
                <strong style={{ color: "var(--text)" }}>What's here:</strong>{" "}
                line items the Schedules module would track for this
                account + period — prepaid amortization, accrual / reversal
                deltas, fixed-asset depreciation, lease and loan postings.
                Empty if no schedules touch this account.
              </>
            )}
          </span>
        </div>
      )}

      {/* ── Initial-recording suggestions (FIRST-MONTH JE reminders) ──
          Aggregates inception-flavored line items across all 5 schedule
          types whose start/origination date falls in this period — and
          renders the Dr/Cr JE the user needs to POST IN QUICKBOOKS so
          the GL recognizes the BS amount that Nordavix's subledger
          build-up is already counting. Without this, the recon shows a
          variance the user can't reconcile away (SL has the prepaid /
          asset / liability but GL doesn't yet).
          Renders nothing if no items start in this period. */}
      <InitialRecordingSuggestionsPanel
        qboAccountId={account.qbo_id}
        periodEnd={periodEnd}
      />

      {/* ── Prepaids schedule suggestions ────────────────────────────
          When this account has prepaid items committed in the Schedules
          module, surface them here as selectable subledger components.
          Each toggle add/removes a synthetic ReconcilingItem from the
          shared selectedItemMap — so the recon's existing SL build-up
          math picks up the change without any logic changes. Renders
          nothing if there are no prepaids for this (account, period). */}
      <PrepaidSuggestionsPanel
        qboAccountId={account.qbo_id}
        periodEnd={periodEnd}
        selectedIds={new Set(Object.keys(selectedItemMap))}
        // Reference-only for schedule-backed accounts: the lines make up the
        // auto-pulled base, so they aren't tickable here (that would double-count).
        readOnly={readOnly || isScheduleBacked}
        onToggle={(s, nextChecked) => {
          const id = prepaidTxnId(s)
          setSelectedItemMap((prev) => {
            const next = { ...prev }
            if (nextChecked) {
              next[id] = {
                txn_id:     id,
                txn_type:   "Prepaid amortization",
                txn_number: s.reference ?? "",
                txn_date:   s.start_date,
                amount:     s.unamortized_at_period_end,
                memo:       `${s.description} · unamortized as of ${periodEnd}`,
                entity:     s.vendor ?? "",
              }
            } else {
              delete next[id]
            }
            return next
          })
        }}
        onBulkSet={(suggestions, nextChecked) => {
          setSelectedItemMap((prev) => {
            const next = { ...prev }
            for (const s of suggestions) {
              const id = prepaidTxnId(s)
              if (nextChecked) {
                next[id] = {
                  txn_id:     id,
                  txn_type:   "Prepaid amortization",
                  txn_number: s.reference ?? "",
                  txn_date:   s.start_date,
                  amount:     s.unamortized_at_period_end,
                  memo:       `${s.description} · unamortized as of ${periodEnd}`,
                  entity:     s.vendor ?? "",
                }
              } else {
                delete next[id]
              }
            }
            return next
          })
        }}
      />

      {/* Accruals schedule suggestions — per-period DELTA line items.
          Each accrual emits up to two lines (accrual + reversal); the
          recon's existing build-up math (opening + selected sums)
          handles the lifecycle without any plumbing here. */}
      <AccrualSuggestionsPanel
        qboAccountId={account.qbo_id}
        periodEnd={periodEnd}
        selectedIds={new Set(Object.keys(selectedItemMap))}
        readOnly={readOnly || isScheduleBacked}
        onToggle={(s, nextChecked) => {
          const id = accrualTxnId(s)
          setSelectedItemMap((prev) => {
            const next = { ...prev }
            if (nextChecked) {
              next[id] = {
                txn_id:     id,
                txn_type:   s.line_kind === "accrual" ? "Accrual" : "Accrual reversal",
                txn_number: s.reference ?? "",
                txn_date:   s.line_date,
                amount:     s.amount,  // signed: + for accrual, − for reversal
                memo:       `${s.description} · ${s.line_kind === "accrual" ? "accrued" : "reversed"} ${s.line_date}`,
                entity:     s.vendor ?? "",
              }
            } else {
              delete next[id]
            }
            return next
          })
        }}
        onBulkSet={(suggestions, nextChecked) => {
          setSelectedItemMap((prev) => {
            const next = { ...prev }
            for (const s of suggestions) {
              const id = accrualTxnId(s)
              if (nextChecked) {
                next[id] = {
                  txn_id:     id,
                  txn_type:   s.line_kind === "accrual" ? "Accrual" : "Accrual reversal",
                  txn_number: s.reference ?? "",
                  txn_date:   s.line_date,
                  amount:     s.amount,
                  memo:       `${s.description} · ${s.line_kind === "accrual" ? "accrued" : "reversed"} ${s.line_date}`,
                  entity:     s.vendor ?? "",
                }
              } else {
                delete next[id]
              }
            }
            return next
          })
        }}
      />

      {/* Fixed Asset / Lease / Loan schedule suggestions — same
          delta-line model as accruals, rendered via a single generic
          ScheduleLinePanel. Each panel renders nothing if the
          account isn't mapped to any schedule item of that type. */}
      {(["fixed_asset", "lease", "loan"] as const).map((kind) => (
        <ScheduleLinePanel
          key={kind}
          scheduleKind={kind}
          qboAccountId={account.qbo_id}
          periodEnd={periodEnd}
          selectedIds={new Set(Object.keys(selectedItemMap))}
          readOnly={readOnly || isScheduleBacked}
          onToggle={(s, scheduleKind, nextChecked) => {
            const id = lineTxnId(scheduleKind, s)
            setSelectedItemMap((prev) => {
              const next = { ...prev }
              if (nextChecked) {
                next[id] = {
                  txn_id:     id,
                  txn_type:   labelForScheduleLine(scheduleKind, s),
                  txn_number: s.reference ?? "",
                  txn_date:   s.line_date,
                  amount:     s.amount,
                  memo:       `${s.description} · ${s.line_kind.replace(/_/g, " ")} ${s.line_date}`,
                  entity:     s.vendor ?? "",
                }
              } else {
                delete next[id]
              }
              return next
            })
          }}
          onBulkSet={(suggestions, scheduleKind, nextChecked) => {
            setSelectedItemMap((prev) => {
              const next = { ...prev }
              for (const s of suggestions) {
                const id = lineTxnId(scheduleKind, s)
                if (nextChecked) {
                  next[id] = {
                    txn_id:     id,
                    txn_type:   labelForScheduleLine(scheduleKind, s),
                    txn_number: s.reference ?? "",
                    txn_date:   s.line_date,
                    amount:     s.amount,
                    memo:       `${s.description} · ${s.line_kind.replace(/_/g, " ")} ${s.line_date}`,
                    entity:     s.vendor ?? "",
                  }
                } else {
                  delete next[id]
                }
              }
              return next
            })
          }}
        />
      ))}

      </div>{/* end Suggestions group */}

      {/* ── Items group (variance strip · build-up · reconciling table) ── */}
      <div style={sectionStyle("items")}>

      {/* ── Compact variance strip ───────────────────────────────────
          Source of truth for what the strip displays:
            * While the user hasn't touched the items (read-only rows,
              first-time opens, approved/prepared rows opened to view),
              show the SAVED subledger so this strip agrees with the
              dashboard row 1:1. Otherwise the strip would show phantom
              variance for accounts where the subledger came from AI,
              manual override, AR/AP aging, or GL fallback — none of
              which produce opening + items math that ties.
            * As soon as the user ticks/unticks anything, switch to
              the LIVE computed value so they can watch the closing
              approach GL as they work.
          Detecting "user is editing" reuses the same content hash the
          auto-save effect uses, so the two surfaces stay consistent. */}
      {(() => {
        const gl = parseFloat(account.gl_balance)

        // Hash both sides to detect divergence — matches auto-save logic.
        const hashItems = (items: ReconcilingItem[]) => items
          .map((it) => `${it.txn_id}:${it.amount}:${it.memo ?? ""}`)
          .sort()
          .join("|")
        const userIsEditing =
          hashItems(selectedItems) !== hashItems(account.reconciling_items ?? [])

        const savedSubledger = parseFloat(account.subledger_balance || "0")
        // For schedule-backed accounts the live computed value (schedule base +
        // ticked GL differences) IS the authoritative subledger, so show it
        // immediately — even before the auto-save persists it to the dashboard.
        const displaySubledger = (scheduleBaseBalance != null || userIsEditing)
          ? computedSubledger : savedSubledger
        const variance = gl - displaySubledger
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
              background: tiedOut ? "var(--green-subtle)" : "rgba(155, 61, 55, 0.10)",
              border: `1px solid ${tiedOut ? "var(--green)" : "rgba(155, 61, 55, 0.40)"}`,
            }}>
            <Metric label="GL" value={fmtMoney(account.gl_balance)} />
            <Metric label="Subledger" value={fmtMoney(displaySubledger)} />
            <div className="inline-flex items-center gap-1.5 whitespace-nowrap">
              {tiedOut && <CheckCircle2 size={13} strokeWidth={2.2} style={{ color: "var(--green)" }} />}
              <span className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                {tiedOut ? "Reconciled" : "Variance (GL − Sub)"}
              </span>
              <span className="text-sm font-bold tabular-nums"
                style={{ color: hasGap ? "#b0564e" : "var(--green)" }}>
                {fmtMoney(variance)}
              </span>
            </div>
          </div>
        )
      })()}

      {/* ── Subledger build-up (NOW the first thing under the variance
          strip, by user request: "Sub ledger build should be above
          reconciling items section"). Opening balance is the rolled-
          forward prior-period close; each reconciling item the preparer
          ticks below shows up here as a line so they can watch the
          closing total tie out to GL in real time. */}
      <SubledgerBuildup
        openingBalance={baseBalance}
        scheduleBaseLabel={scheduleBaseLabel}
        prior={prior}
        selectedItems={selectedItems}
        selectedSum={selectedSum}
        computedSubledger={computedSubledger}
        flipSign={flipSign}
        readOnly={readOnly}
        onUntickItem={(it) => toggleItem(it)}
        onEditManual={(it) => startEditManualItem(it)}
        onDeleteManual={(id) => deleteManualItem(id)}
      />

      {/* ── Reconciling items table (now BELOW the build-up so the
          preparer's eye flows: see opening → tick items here → see
          closing total update above). Pulled live from QBO via
          /period-entries. Plus a manual-add form for items not yet
          in QBO (outstanding bank checks, deposits in transit, JEs). */}
      {/* For schedule-backed accounts (Prepaid / Accrual / FA / Lease /
          Loan), show the expected per-period JEs from the schedule as a
          REFERENCE card — then the regular QBO GL-txn table below it, like
          every other account. The subledger auto-pulls the schedule BALANCE
          (the build-up's base line); these entries aren't ticked. Tick the
          real GL rows below only to explain a difference vs the schedule. */}
      {isScheduleBacked && (
        <SchedulePeriodJesPanel
          qboAccountId={account.qbo_id}
          periodEnd={periodEnd}
        />
      )}

      <div className="mb-4">
        <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
          <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
            Reconciling items — current-period activity from QuickBooks
            {(periodEntries?.rows.length ?? 0) > 0 && ` · ${periodEntries!.rows.length}`}
          </span>
          {!readOnly && (
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
          )}
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
            <div className="w-36">
              <span className="text-[9px] font-semibold uppercase tracking-wide block mb-1"
                style={{ color: "var(--text-muted)" }}>Date</span>
              <DatePicker value={manualDate} onChange={setManualDate} compact className="block w-full" />
            </div>
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
                    {/* Select-all checkbox in the header. Three states:
                          - none of the rows ticked → unchecked
                          - all rows ticked         → checked
                          - some ticked             → indeterminate
                        Click toggles all on / all off based on whether
                        any are currently selected. */}
                    <th className="w-8 px-2 py-2 text-center">
                      {(() => {
                        const rows = periodEntries!.rows
                        const ticked = rows.filter((r) => !!selectedItemMap[r.txn_id]).length
                        const allChecked  = ticked === rows.length && rows.length > 0
                        const someChecked = ticked > 0 && ticked < rows.length
                        return (
                          <input
                            type="checkbox"
                            checked={allChecked}
                            disabled={readOnly}
                            ref={(el) => { if (el) el.indeterminate = someChecked }}
                            title={allChecked ? "Untick all items" : "Tick all items"}
                            onChange={() => {
                              if (readOnly) return
                              setSelectedItemMap((prev) => {
                                const next = { ...prev }
                                if (allChecked) {
                                  // Untick: drop every QBO-pulled row from the map.
                                  // Keep manual items intact — they're user-added,
                                  // not "select all" toggleable.
                                  for (const r of rows) delete next[r.txn_id]
                                } else {
                                  // Tick: add every row to the map.
                                  for (const r of rows) next[r.txn_id] = r
                                }
                                return next
                              })
                            }}
                          />
                        )
                      })()}
                    </th>
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
                        onClick={() => !readOnly && toggleItem(r)}
                        className={readOnly ? "transition-colors" : "cursor-pointer transition-colors"}
                        style={{
                          borderTop: "1px solid var(--border)",
                          background: checked ? "var(--green-subtle)" : "transparent",
                          cursor: readOnly ? "default" : "pointer",
                        }}>
                        <td className="px-2 py-2 text-center">
                          <input type="checkbox" checked={checked}
                            disabled={readOnly}
                            onChange={() => !readOnly && toggleItem(r)}
                            onClick={(e) => e.stopPropagation()} />
                        </td>
                        <td className="px-2 py-2 text-theme">{r.txn_type}</td>
                        <td className="px-2 py-2 font-mono" style={{ color: "var(--text-2)" }}>{r.txn_number || "—"}</td>
                        <td className="px-2 py-2" style={{ color: "var(--text-2)" }}>{r.txn_date ? formatDate(r.txn_date) : "—"}</td>
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

      {/* The full subledger build-up rendering moved to the top of this
          form (above the reconciling-items table) — see SubledgerBuildup
          component near the top of the body. We dropped the redundant
          blue "Rolled forward from prior period" card that used to live
          here: that information is already on the Opening balance line
          inside the build-up ("Rolled forward from <date>"). */}

      </div>{/* end Items group */}

      {/* ── Evidence group (source notes + supporting evidence + AI verify) ── */}
      <div style={sectionStyle("evidence")}>

      {/* ── Lower two-column area: entry fields | evidence ────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="space-y-3">
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                Source / notes (optional)
              </span>
              <input
                type="text"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder="e.g. Bank of America statement 4/30/26"
                disabled={readOnly}
                className="w-full rounded-lg px-3 py-2 mt-1 text-sm outline-none"
                style={{
                  background: "var(--surface-2)",
                  border: "1px solid var(--border-strong)",
                  color: "var(--text)",
                  opacity: readOnly ? 0.6 : 1,
                  cursor: readOnly ? "not-allowed" : "text",
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
                    style={{ color: "#9b3d37" }}>
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
                            style={{ color: "#9b3d37" }}>
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

              {/* Upload trigger — hidden when the period is locked. The
                  list of already-attached files above stays visible
                  (read-only access to source documents). */}
              {!readOnly && (
                <>
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
                </>
              )}
              {uploadError && (
                <p className="text-[11px]" style={{ color: "#9b3d37" }}>{uploadError}</p>
              )}
            </div>
          </div>{/* end RIGHT column (evidence + AI verify) */}
        </div>{/* end grid */}

      </div>{/* end Evidence group */}

      {/* Footer action bar — entirely suppressed on locked periods.
          The Close button at the top is the only way out in read-only
          mode (and that one's safe — it just collapses the accordion). */}
      {!hideFooter && !readOnly && (
        <div className="flex items-center justify-between gap-2 mt-4 pt-3"
          style={{ borderTop: "1px solid var(--border)" }}>
          {account.subledger_is_manual ? (
            <button
              type="button"
              onClick={onClear}
              disabled={saving}
              className="text-[11px] font-medium underline-offset-2 hover:underline"
              style={{ color: "#9b3d37" }}
            >
              Clear override
            </button>
          ) : <span />}
          <div className="flex items-center gap-2">
            {/* Two-step maker/checker hint — only shown when the row will
                actually promote (i.e. it's still Pending/Flagged). Once
                Prepared, the button still re-saves but doesn't downgrade. */}
            {(account.review_status === "pending" || account.review_status === "flagged") && (
              <span className="text-[10px] hidden sm:inline" style={{ color: "var(--text-muted)" }}>
                Saves + marks <span className="font-semibold" style={{ color: "#3c5a76" }}>Prepared</span>
                {" "}— a reviewer signs off after.
              </span>
            )}
            <Button size="sm" variant="ghost" type="button" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            {/* "Reconcile" replaces the old "Save subledger" copy — it now
                both persists the override AND moves the row to Prepared
                (the maker side of maker/checker). Reviewer/admin still
                has to flip it to Approved separately. Bound at the
                call-site so the status bump only happens for non-approved
                rows (won't downgrade an already-approved one). */}
            <Button size="sm" type="submit" loading={saving}
              icon={<CheckCircle2 size={13} strokeWidth={2} />}>
              Reconcile
            </Button>
          </div>
        </div>
      )}
    </form>
  )
}

// ── Subledger build-up subcomponent ─────────────────────────────────────────
// Extracted so the form body can swap its position without dragging 100+
// lines of JSX along. Renders the opening balance (rolled forward, with
// the date inline so the redundant blue card up top is no longer needed),
// each selected reconciling item, the running subtotal, and the closing
// total. Pure presentation — all state lives in the parent form.

function SubledgerBuildup({
  openingBalance, scheduleBaseLabel, prior, selectedItems, selectedSum, computedSubledger, flipSign,
  readOnly = false, onUntickItem, onEditManual, onDeleteManual,
}: {
  openingBalance:    number
  // When set, the base line IS the authoritative schedule balance (auto-pulled)
  // — render this label instead of the "Opening balance / rolled forward" copy.
  scheduleBaseLabel?: string | null
  // `prior` widened to also accept undefined so it matches what useQuery
  // hands back before the request resolves. Renders the same "no prior"
  // copy whether it's null or undefined.
  prior:             { period_end: string; subledger_total: string; subledger_source: string | null; status: AccountReviewStatus; evidence_count: number } | null | undefined
  selectedItems:     ReconcilingItem[]
  selectedSum:       number
  computedSubledger: number
  // Sign-flip multiplier for QBO items on credit-natural accounts.
  // 1 for assets (debit-natural — no flip needed), −1 for AP/CC/
  // liability/equity (QBO returns credits as positive, we display as
  // negative to match the signed GL balance). Manual items are NOT
  // flipped — they're entered by the user in signed convention.
  flipSign:          number
  // When true the build-up renders without untick / edit / delete
  // affordances on each line — pure view for locked periods.
  readOnly?:         boolean
  onUntickItem:      (it: ReconcilingItem) => void
  onEditManual:      (it: ReconcilingItem) => void
  onDeleteManual:    (id: string) => void
}) {
  return (
    <div className="rounded-xl mb-4 overflow-hidden"
      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <div className="px-4 py-2 flex items-center justify-between"
        style={{ borderBottom: "1px solid var(--border)", background: "var(--surface-2)" }}>
        <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
          Monthly activity
        </span>
        <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
          Opening + activity = closing
        </span>
      </div>
      <div className="px-4 py-3 space-y-1.5 text-sm">
        {/* Base line. For schedule-backed accounts this is the authoritative
            schedule balance (auto-pulled, with a green "Schedule" tag). For
            every other account it's the rolled-forward prior close. */}
        <div className="flex items-center justify-between">
          <span style={{ color: "var(--text-2)" }}>
            {scheduleBaseLabel ? (
              <>
                {scheduleBaseLabel}
                <span className="ml-1.5 text-[9px] font-bold uppercase px-1 py-0.5 rounded"
                  style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
                  auto-pulled
                </span>
              </>
            ) : (
              <>
                Opening balance
                <span className="ml-1.5 text-[10px]" style={{ color: "var(--text-muted)" }}>
                  {prior
                    ? `Rolled forward from ${prior.period_end}`
                    : "From dashboard (set books-start in onboarding to anchor properly)"}
                </span>
              </>
            )}
          </span>
          <span className="tabular-nums font-semibold text-theme">{fmtMoney(openingBalance)}</span>
        </div>

        {/* Per-item lines (collapsible if very long) */}
        {selectedItems.length === 0 ? (
          <p className="text-[11px] py-1.5 italic" style={{ color: "var(--text-muted)" }}>
            {scheduleBaseLabel
              ? "Subledger ties to the schedule. Tick a GL entry in the table below only to explain a difference vs the schedule."
              : "No reconciling items selected. Tick QBO entries in the table below or use “Add manual item”."}
          </p>
        ) : (
          <ul className="space-y-0.5 max-h-48 overflow-y-auto">
            {selectedItems.map((it) => {
              const isManual = it.txn_id.startsWith("manual-")
              // Schedule-sourced items (prepaid/accrual/FA/lease/loan) carry a
              // provenance badge but are freely untickable — they come in
              // pre-selected, not locked.
              const isSchedule = it.txn_id.startsWith("schedule-")
              // Signed effective amount. For QBO items on a credit-
              // natural account this is the NEGATIVE of the raw QBO
              // amount (so a credit invoice on AP shows here as
              // "−$60,000" — reducing the signed balance further
              // negative, which matches what the closing total does).
              // Manual items already in signed convention, no flip.
              const amt = (isManual ? 1 : flipSign) * (parseFloat(it.amount) || 0)
              return (
                <li key={it.txn_id}
                  className="flex items-center gap-2 py-1 px-1 text-xs rounded"
                  style={{ background: "transparent" }}>
                  <span style={{ color: amt >= 0 ? "var(--green)" : "#b0564e" }}>
                    {amt >= 0 ? "+" : "−"}
                  </span>
                  {isManual && (
                    <span className="text-[9px] font-bold uppercase px-1 py-0.5 rounded"
                      style={{ background: "rgba(199, 154, 82, 0.15)", color: "#c79a52" }}>
                      Manual
                    </span>
                  )}
                  {isSchedule && (
                    <span className="text-[9px] font-bold uppercase px-1 py-0.5 rounded"
                      style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
                      Schedule
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
                    style={{ color: amt >= 0 ? "var(--green)" : "#b0564e" }}>
                    {amt >= 0 ? "+" : ""}{fmtMoney(amt)}
                  </span>
                  {readOnly ? null : isManual ? (
                    <>
                      <button type="button"
                        onClick={() => onEditManual(it)}
                        className="h-5 w-5 inline-flex items-center justify-center rounded"
                        title="Edit"
                        style={{ color: "var(--text-muted)" }}>
                        <Edit2 size={11} strokeWidth={1.8} />
                      </button>
                      <button type="button"
                        onClick={() => onDeleteManual(it.txn_id)}
                        className="h-5 w-5 inline-flex items-center justify-center rounded"
                        title="Delete"
                        style={{ color: "#b0564e" }}>
                        <X size={12} strokeWidth={1.8} />
                      </button>
                    </>
                  ) : (
                    <button type="button"
                      onClick={() => onUntickItem(it)}
                      className="h-5 w-5 inline-flex items-center justify-center rounded"
                      title={isSchedule
                        ? "Untick this schedule line (re-tick it any time in the Suggestions tab)"
                        : "Untick from selection"}
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
              style={{ color: selectedSum >= 0 ? "var(--green)" : "#b0564e" }}>
              {selectedSum >= 0 ? "+" : ""}{fmtMoney(selectedSum)}
            </span>
          </div>
        )}
      </div>

      {/* Closing line — the computed subledger total */}
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
  )
}

// ── Attachments cell ────────────────────────────────────────────────────────
// ── AiCommentaryCard ────────────────────────────────────────────────────────
// Renders the structured commentary the agentic preparer writes onto
// every successfully-tied row. Lays out as:
//   1. Pill row: Confidence (high/med/low) · Recommendation (approve/review/...)
//   2. Narrative — 2-3 sentence AI summary in plain English
//   3. Checks table — Check name · Status pill · Detail
// Mirrors the structure of the PDF section so a reviewer sees the same
// shape on screen and on the audit working paper.

function AiCommentaryCard({ commentary }: {
  commentary: import("@/modules/recons/api").AiCommentary
}) {
  const conf = commentary.confidence
  const rec = commentary.recommendation
  const confColor = conf === "high" ? "var(--green)" : conf === "medium" ? "#8a6326" : "#9b3d37"
  const confBg    = conf === "high" ? "var(--green-subtle)"
                    : conf === "medium" ? "rgba(199, 154, 82, 0.10)"
                    : "rgba(155, 61, 55, 0.08)"
  const recLabel = rec === "approve"     ? "Approve as-is"
                 : rec === "review"      ? "Review flagged items before approving"
                 : rec === "investigate" ? "Investigate before approving"
                 : rec

  const statusMeta = {
    pass: { fg: "var(--green)",     bg: "var(--green-subtle)",      label: "✓ Pass" },
    warn: { fg: "#8a6326",          bg: "rgba(199, 154, 82, 0.12)", label: "⚠ Warn" },
    fail: { fg: "#9b3d37",          bg: "rgba(155, 61, 55, 0.10)",  label: "✕ Fail" },
  } as const

  return (
    <div className="rounded-xl mb-3 overflow-hidden"
      style={{ background: "var(--surface)", border: "1px solid var(--green)" }}>
      {/* Pill row */}
      <div className="px-4 py-2.5 flex items-center gap-3 flex-wrap"
        style={{ background: confBg, borderBottom: "1px solid var(--green)" }}>
        <span className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide"
          style={{ color: confColor }}>
          <Sparkles size={12} strokeWidth={2} /> AI Commentary
        </span>
        <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase"
          style={{ background: "var(--surface)", color: confColor, border: `1px solid ${confColor}` }}>
          Confidence: {conf}
        </span>
        <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase"
          style={{ background: "var(--surface)", color: confColor, border: `1px solid ${confColor}` }}>
          {recLabel}
        </span>
        <span className="ml-auto text-[10px] italic" style={{ color: "var(--text-muted)" }}>
          Generated {(() => {
            try { return formatDateTime(commentary.generated_at) }
            catch { return commentary.generated_at }
          })()}
        </span>
      </div>

      {/* Headline — one-line reviewer verdict */}
      {commentary.headline && (
        <p className="px-4 pt-3 text-[12.5px] font-semibold leading-snug" style={{ color: "var(--text)" }}>
          {commentary.headline}
        </p>
      )}

      {/* Narrative */}
      {commentary.narrative && (
        <p className="px-4 py-3 text-[12px] leading-relaxed" style={{ color: "var(--text-2)" }}>
          {commentary.narrative}
        </p>
      )}

      {/* Items to review — reconciling items the AI thinks look unrelated,
          out-of-period, or doubtful. This is the "think like an accountant"
          layer: each flag says what's wrong and what to do. */}
      {commentary.item_flags && commentary.item_flags.length > 0 && (
        <div className="px-4 pb-3" style={{ borderTop: "1px solid var(--border)" }}>
          <div className="flex items-center gap-1.5 mt-3 mb-2 text-[10px] font-bold uppercase tracking-wider"
            style={{ color: "#8a6326" }}>
            <AlertTriangle size={12} strokeWidth={2} /> Items to review ({commentary.item_flags.length})
          </div>
          <div className="space-y-2">
            {commentary.item_flags.map((f, i) => {
              const sevColor = f.severity === "high" ? "#9b3d37" : f.severity === "medium" ? "#8a6326" : "var(--text-muted)"
              return (
                <div key={i} className="rounded-lg p-2.5"
                  style={{ background: "rgba(199, 154, 82, 0.06)", border: "1px solid rgba(199, 154, 82, 0.30)" }}>
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-[12px] font-semibold leading-snug" style={{ color: "var(--text)" }}>{f.label}</span>
                    {f.amount && (
                      <span className="text-[12px] font-semibold tabular-nums shrink-0" style={{ color: "var(--text)" }}>
                        {fmtMoney(parseFloat(f.amount) || 0)}
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] mt-1 leading-snug" style={{ color: "var(--text-2)" }}>
                    <span className="font-semibold uppercase text-[9px] tracking-wider mr-1" style={{ color: sevColor }}>{f.severity}</span>
                    {f.reason}
                  </p>
                  {f.action && (
                    <p className="text-[11px] mt-1 leading-snug font-medium" style={{ color: "var(--green)" }}>
                      → {f.action}
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Recommended actions */}
      {commentary.recommendations && commentary.recommendations.length > 0 && (
        <div className="px-4 pb-3" style={{ borderTop: "1px solid var(--border)" }}>
          <div className="flex items-center gap-1.5 mt-3 mb-2 text-[10px] font-bold uppercase tracking-wider"
            style={{ color: "var(--green)" }}>
            <Lightbulb size={12} strokeWidth={2} /> Recommended actions
          </div>
          <ul className="space-y-1.5">
            {commentary.recommendations.map((r, i) => (
              <li key={i} className="flex items-start gap-2 text-[12px] leading-snug" style={{ color: "var(--text)" }}>
                <span className="inline-flex items-center justify-center h-4 w-4 rounded-full text-[9px] font-bold shrink-0 mt-0.5"
                  style={{ background: "var(--green-subtle)", color: "var(--green)" }}>{i + 1}</span>
                {r}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Checks table */}
      {commentary.checks.length > 0 && (
        <div className="overflow-hidden" style={{ borderTop: "1px solid var(--border)" }}>
          <table className="w-full text-[11px]">
            <thead>
              <tr style={{ background: "var(--surface-2)" }}>
                <th className="text-left px-3 py-2 font-semibold w-44" style={{ color: "var(--text-muted)" }}>Check</th>
                <th className="text-left px-3 py-2 font-semibold w-20" style={{ color: "var(--text-muted)" }}>Status</th>
                <th className="text-left px-3 py-2 font-semibold" style={{ color: "var(--text-muted)" }}>Detail</th>
              </tr>
            </thead>
            <tbody>
              {commentary.checks.map((c, idx) => {
                const meta = statusMeta[c.status] ?? statusMeta.pass
                return (
                  <tr key={`${c.name}-${idx}`} style={{ borderTop: "1px solid var(--border)" }}>
                    <td className="px-3 py-2 font-medium" style={{ color: "var(--text)" }}>{c.name}</td>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold whitespace-nowrap"
                        style={{ background: meta.bg, color: meta.fg }}>
                        {meta.label}
                      </span>
                    </td>
                    <td className="px-3 py-2" style={{ color: "var(--text-2)" }}>{c.detail}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}


// ── AgenticModeToggle ───────────────────────────────────────────────────────
// Visual toggle that triggers the AI agentic preparer for the focused
// period. Renders like a pill switch (off → green when on) so the user
// reads it as a "mode" rather than a plain action button — matching
// the user's request. One-shot per click: while running, the pill
// pulses; on completion, returns to the off state and the parent
// shows a results banner.

function AgenticModeToggle({ running, disabled, onClick }: {
  running:  boolean
  disabled: boolean
  onClick:  () => void
}) {
  const label = running ? "Preparing…" : "Agentic Mode"
  // Disabled tooltip text varies based on why it's disabled.
  const title = running
    ? "AI preparer is running — typical 5-15s per period"
    : disabled
      ? "Sync the period from QuickBooks first; AI runs on synced, unlocked periods only."
      : "Run the AI agentic preparer on every open account in this period (one-shot)."

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || running}
      title={title}
      className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold transition-all"
      style={{
        background: running ? "var(--green)" : disabled ? "var(--surface-2)" : "var(--surface)",
        color:      running ? "#ffffff" : disabled ? "var(--text-muted)" : "var(--green)",
        border:     `1.5px solid ${running ? "var(--green)" : disabled ? "var(--border-strong)" : "var(--green)"}`,
        opacity:    disabled && !running ? 0.55 : 1,
        cursor:     disabled || running ? "not-allowed" : "pointer",
        boxShadow:  running ? "0 0 0 3px rgba(94, 176, 137, 0.15)" : "none",
      }}
    >
      <Sparkles
        size={12} strokeWidth={2}
        className={running ? "animate-pulse" : undefined}
      />
      {label}
    </button>
  )
}


// ── AgenticResultBanner ─────────────────────────────────────────────────────
// Post-run summary banner with counts + a per-account breakdown drawer.
// Stays mounted until the user dismisses it so they can see exactly
// what the AI did (and re-read it after refreshing the page in their
// head). Click "View details" → expand the per-account list with
// reasons / gap_before / gap_after.

function AgenticResultBanner({ result, onDismiss }: {
  result:    import("@/modules/recons/api").AgenticResult
  onDismiss: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const totalTouched = result.prepared + result.analyzed + result.skipped + result.failed
  const isError = result.failed > 0 || (result.prepared === 0 && result.analyzed === 0 && result.skipped > 0)
  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.22 }}
      style={{
        background: isError ? "#f4eddf" : "var(--green-subtle)",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div className="px-4 sm:px-8 py-2.5">
        <div className="flex items-center gap-3 flex-wrap">
          <Sparkles size={14} strokeWidth={1.8}
            style={{ color: isError ? "#7a5622" : "var(--green)" }} />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold"
              style={{ color: isError ? "#7a5622" : "var(--green)" }}>
              Agentic Preparer · {totalTouched} account{totalTouched === 1 ? "" : "s"} reviewed
            </p>
            <p className="text-[11px] mt-0.5" style={{ color: "var(--text-2)" }}>
              <b>{result.prepared}</b> auto-prepared
              {" · "}<b>{result.analyzed}</b> AI-analyzed (needs human review)
              {" · "}<b>{result.skipped}</b> skipped
              {result.failed > 0 && (<> {" · "}<b style={{ color: "#9b3d37" }}>{result.failed} failed</b></>)}
              {" · "}{(result.duration_ms / 1000).toFixed(1)}s
            </p>
          </div>
          <button
            onClick={() => setExpanded((x) => !x)}
            className="text-[11px] font-semibold underline-offset-2 hover:underline"
            style={{ color: isError ? "#7a5622" : "var(--green)" }}
          >
            {expanded ? "Hide details" : "View details"}
          </button>
          <button
            onClick={onDismiss}
            className="h-5 w-5 inline-flex items-center justify-center rounded transition-opacity hover:opacity-70"
            style={{ color: isError ? "#7a5622" : "var(--green)" }}
            title="Dismiss"
          >
            <X size={13} strokeWidth={2} />
          </button>
        </div>
        <AnimatePresence>
          {expanded && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.18 }}
              className="overflow-hidden"
            >
              <div className="mt-3 rounded-lg overflow-hidden"
                style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
                <table className="w-full text-[11px] min-w-[600px]">
                  <thead>
                    <tr style={{ background: "var(--surface-2)" }}>
                      <th className="text-left px-3 py-2 font-semibold" style={{ color: "var(--text-muted)" }}>Account</th>
                      <th className="text-left px-3 py-2 font-semibold" style={{ color: "var(--text-muted)" }}>Action</th>
                      <th className="text-left px-3 py-2 font-semibold" style={{ color: "var(--text-muted)" }}>What happened</th>
                      <th className="text-right px-3 py-2 font-semibold" style={{ color: "var(--text-muted)" }}>Items</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.accounts.map((a) => {
                      const tone = a.action === "prepared" ? "var(--green)"
                                  : a.action === "analyzed" ? "#3c5a76"
                                  : "#7a5622"
                      const bg = a.action === "prepared" ? "var(--green-subtle)"
                                : a.action === "analyzed" ? "#e9eef3"
                                : "#f4eddf"
                      return (
                        <tr key={a.qbo_account_id + a.account_name}
                          style={{ borderTop: "1px solid var(--border)" }}>
                          <td className="px-3 py-2 text-theme">
                            {a.account_number && (
                              <span className="font-mono text-[10px] mr-1" style={{ color: "var(--text-muted)" }}>
                                {a.account_number}
                              </span>
                            )}
                            {a.account_name}
                          </td>
                          <td className="px-3 py-2">
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase"
                              style={{ background: bg, color: tone }}>
                              {a.action}
                            </span>
                          </td>
                          <td className="px-3 py-2" style={{ color: "var(--text-2)" }}>
                            {a.reason}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums" style={{ color: "var(--text-muted)" }}>
                            {a.items_added > 0 ? a.items_added : "—"}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  )
}


// ── DownloadReconButton ─────────────────────────────────────────────────────
// Triggers a per-account reconciliation PDF download. Shown only on
// approved rows (the parent gates with `status === "approved"`).
// The PDF includes GL/Subledger/Variance, the full reconciling-items
// build-up, prepared/approved trail, notes, and attachment list — an
// audit-style working paper for the one account in this period.

function DownloadReconButton({ qboAccountId, periodEnd, accountName }: {
  qboAccountId: string
  periodEnd: string
  accountName: string
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!error) return
    const t = setTimeout(() => setError(null), 4_000)
    return () => clearTimeout(t)
  }, [error])

  async function handleClick() {
    if (pending) return
    setPending(true)
    setError(null)
    try {
      await reconsApi.downloadAccountPdf(qboAccountId, periodEnd, accountName)
    } catch (e: unknown) {
      setError((e as Error).message)
    } finally {
      setPending(false)
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={pending}
      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors"
      style={{
        color: error ? "#9b3d37" : "var(--green)",
        border: `1px solid ${error ? "#ecd7d3" : "var(--green)"}`,
        background: error ? "#f7eeec" : "var(--green-subtle)",
        opacity: pending ? 0.6 : 1,
        cursor: pending ? "wait" : "pointer",
      }}
      title={error ?? "Download the audit-ready reconciliation PDF for this account"}
    >
      <Download size={11} strokeWidth={1.8} />
      {pending ? "…" : error ? "Failed" : "PDF"}
    </button>
  )
}


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

function Kpi({ label, value, tone, sub }:
  { label: string; value: string; tone: string; sub?: string }
) {
  return (
    <div className="rounded-xl p-4"
      style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
      <p className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>{label}</p>
      <p className="text-xl sm:text-2xl font-bold tabular-nums mt-1" style={{ color: tone }}>{value}</p>
      {sub && <p className="text-[10px] mt-1" style={{ color: "var(--text-muted)" }}>{sub}</p>}
    </div>
  )
}

/**
 * Compact inline KPI used by the sticky condensed KPI bar. Single row,
 * tight typography — pairs a label, value, and an optional pill badge.
 */
function KpiInline({
  label, value, tone, badge,
}: { label: string; value: string; tone: string; badge?: string }) {
  return (
    <div className="flex items-baseline gap-1.5 shrink-0">
      <span className="text-[10px] font-bold uppercase tracking-wider"
        style={{ color: "var(--text-muted)" }}>{label}</span>
      <span className="text-sm font-bold tabular-nums" style={{ color: tone }}>{value}</span>
      {badge && (
        <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
          style={{ background: tone === "#9b3d37" ? "#f7eeec" : "var(--green-subtle)",
                   color: tone === "#9b3d37" ? "#9b3d37" : "var(--green)" }}>
          {badge}
        </span>
      )}
    </div>
  )
}

// ── Sync verification card ────────────────────────────────────────────────────
// A balanced GL must hold:
//
//   Assets − Liabilities − Equity = Net Income (YTD)
//
// We sum the three sides from the synced per-account balances (using
// each account's QBO type to classify it), then pull YTD Net Income
// from QBO's own ProfitAndLoss report. If our implied NI matches QBO's
// reported NI, the math ties out and the sync is good. If not, the
// gap tells you the size of the sync problem.
//
// Rendered as an accordion: the header (always visible) shows the
// status pill so the user sees the verdict at a glance. Clicking
// expands the equation + verdict for the full breakdown. Default
// collapsed so it doesn't dominate the dashboard once verified.


// ── Detail drawer (subledger + variance share one drawer for context) ───────

interface DrawerProps {
  account:     OverviewAccount
  periodEnd:   string
  onClose:     () => void
}

function DetailDrawer({ account, periodEnd, onClose }: DrawerProps) {
  const variance = parseFloat(account.variance)
  const hasVariance = Math.abs(variance) >= 0.5

  const { data: subledger, isLoading: subLoading } = useQuery<SubledgerDetail>({
    queryKey: ["recon-subledger", account.qbo_id, periodEnd],
    queryFn:  () => reconsApi.getAccountSubledger(account.qbo_id, periodEnd),
  })

  // Variance-reasons tab was removed (user request: drop the
  // "Variance reasons" option from this drawer). Subledger is the
  // only mode now.

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
                  style={{ background: "#f4eddf", color: "#7a5622" }}
                  title="Subledger value was entered manually">
                  Manual subledger
                </span>
              )}
            </div>
            <h3 className="text-base font-semibold text-theme truncate">{account.account_name}</h3>
            <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
              GL {fmtMoney(account.gl_balance)} · Subledger {fmtMoney(account.subledger_balance)}
              {hasVariance && (
                <> · <span style={{ color: "#9b3d37" }}>Variance {fmtMoney(account.variance)}</span></>
              )}
            </p>
          </div>
          <button onClick={onClose}
            className="h-8 w-8 rounded-md flex items-center justify-center transition-colors"
            style={{ color: "var(--text-muted)" }}>
            <X size={16} strokeWidth={1.8} />
          </button>
        </div>

        {/* Body — subledger detail only. The old tab strip + Variance
            reasons mode was removed per user feedback. */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <SubledgerBody subledger={subledger} loading={subLoading} />
        </div>
      </motion.aside>
    </>
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
                    style={{ color: parseFloat(r["61_90"] ?? "0") > 0 ? "#7a5622" : "inherit" }}>
                    {fmtMoney(r["61_90"] ?? "0")}
                  </td>
                  <td className="text-right py-2 px-1 tabular-nums"
                    style={{ color: parseFloat(r.over_90 ?? "0") > 0 ? "#9b3d37" : "inherit" }}>
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
                  style={{ color: totals.a61_90 > 0 ? "#7a5622" : "var(--text)" }}>
                  {fmtMoney(totals.a61_90)}
                </td>
                <td className="text-right py-2 px-1 tabular-nums font-bold"
                  style={{ color: totals.over90 > 0 ? "#9b3d37" : "var(--text)" }}>
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

// VarianceBody removed — was the rendering for the "Variance reasons"
// tab inside DetailDrawer, which the user removed.
