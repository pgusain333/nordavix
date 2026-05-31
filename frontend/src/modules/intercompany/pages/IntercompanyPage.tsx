/**
 * Intercompany — track GL accounts that represent transactions with
 * related entities (parent / sub / sister companies).
 *
 * Layout:
 *   [Header]   Title + period selector + Auto-detect button
 *   [KPI strip] Receivables / Payables / Net Position / # of IC accounts
 *   [Pending]  "X candidate accounts detected" banner when auto-detect
 *              would surface new ones
 *   [Table]    Per IC account: number, name, type, counterparty, kind,
 *              balance, month change, actions (edit, delete, view txns)
 *   [Empty]    Friendly explainer for companies that don't do IC
 *
 * The drawer-style transaction drill-in shares pattern with the
 * reconciliations variance drawer.
 */
import { Fragment, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { motion, AnimatePresence } from "framer-motion"
import {
  ArrowLeft,
  Building2,
  Plus,
  Search,
  Eye,
  Trash2,
  Edit2,
  Wand2,
  Sparkles,
  AlertCircle,
  X,
  Pencil,
  Link2,
  Unlink,
  Download,
  CheckCircle2,
  AlertTriangle,
  CircleSlash,
  Calculator,
  Layers,
} from "lucide-react"
import { Button, Spinner } from "@/core/ui/components"
import { SkeletonTable } from "@/core/ui/Skeleton"
import { DatePicker } from "@/core/ui/DatePicker"
import { useEscapeClose } from "@/core/hooks/useEscapeClose"
import {
  icApi,
  type IcAccount,
  type IcKind,
  type AccessibleCompany,
  type IcPair,
  type EliminationRow,
  type ConsolidatedRow,
} from "@/modules/intercompany/api"
import { useQboConnection } from "@/modules/flux/hooks"

type Tab = "accounts" | "eliminations" | "consolidated"

function fmtMoney(s: string | number | null | undefined): string {
  if (s === null || s === undefined || s === "") return "—"
  const n = typeof s === "string" ? parseFloat(s) : s
  if (!Number.isFinite(n)) return "—"
  if (n === 0) return "$0"
  const abs = `$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
  return n < 0 ? `(${abs})` : abs
}

function defaultPeriodEnd(): string {
  const d = new Date(); d.setDate(0)
  return d.toISOString().slice(0, 10)
}

const KIND_META: Record<IcKind, { label: string; fg: string; bg: string }> = {
  receivable: { label: "Receivable", fg: "var(--green)", bg: "var(--green-subtle)" },
  payable:    { label: "Payable",    fg: "#1d4ed8",      bg: "#dbeafe"             },
  unknown:    { label: "Unknown",    fg: "var(--text-muted)", bg: "var(--surface-2)" },
}

export function IntercompanyPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [tab, setTab] = useState<Tab>("accounts")
  const [periodEnd, setPeriodEnd] = useState<string>(defaultPeriodEnd())
  const [search, setSearch] = useState("")
  const [editingAccount, setEditingAccount] = useState<IcAccount | null>(null)
  const [addingNew, setAddingNew] = useState(false)
  const [drawerAccount, setDrawerAccount] = useState<IcAccount | null>(null)
  // Pair-with picker — opens when user clicks Pair on an unpaired row,
  // or Unpair on a paired one.
  const [pairingAccount, setPairingAccount] = useState<IcAccount | null>(null)

  // Pairs list, keyed by my_qbo_account_id for fast row lookup
  const { data: pairs = [] } = useQuery({
    queryKey: ["intercompany-pairs"],
    queryFn:  () => icApi.listPairs(),
  })
  const pairByAccountId = useMemo(() => {
    const m: Record<string, IcPair> = {}
    for (const p of pairs) m[p.my_qbo_account_id] = p
    return m
  }, [pairs])

  const { data: qbo } = useQboConnection()
  const { data: overview, isLoading } = useQuery({
    queryKey: ["intercompany-overview", periodEnd],
    queryFn:  () => icApi.getOverview(periodEnd),
    enabled:  !!qbo,
    staleTime: 60_000,
  })

  const autoDetectMut = useMutation({
    mutationFn: () => icApi.autoDetect(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["intercompany-overview"] }),
  })

  // AI scan — falls back to Claude when name patterns miss accounts
  // with non-standard naming ("Loan – HoldCo", "Owner Investment – Sub",
  // etc.). Marks high-confidence matches (≥0.6) directly.
  const aiDetectMut = useMutation({
    mutationFn: () => icApi.aiDetect(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["intercompany-overview"] }),
  })

  // Auto-run detection on first visit when there's QBO data but the user
  // hasn't tracked anything yet. Cuts the setup from "Read about IC,
  // click Auto-detect, review results" down to "Page loads, results are
  // already there." Fires once per session.
  const didAutoRunRef = useRef(false)
  useEffect(() => {
    if (didAutoRunRef.current) return
    if (!overview || !qbo) return
    // Only auto-run when: zero marks yet, AND QBO returned candidate accounts.
    if (overview.accounts.length === 0 && overview.detected_pending > 0) {
      didAutoRunRef.current = true
      autoDetectMut.mutate()
    } else {
      didAutoRunRef.current = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview, qbo])

  const filtered = useMemo(() => {
    const list = overview?.accounts ?? []
    const q = search.trim().toLowerCase()
    if (!q) return list
    return list.filter((a) =>
      a.account_name.toLowerCase().includes(q)
      || a.account_number.toLowerCase().includes(q)
      || (a.counterparty?.toLowerCase().includes(q) ?? false)
    )
  }, [overview, search])

  const hasNoIc = !isLoading && overview && overview.accounts.length === 0 && overview.detected_pending === 0

  return (
    <div className="flex flex-col h-full overflow-y-auto" style={{ background: "var(--bg)" }}>
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}
        className="px-4 sm:px-8 pt-6 pb-4"
        style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <button onClick={() => navigate("/app")}
              className="inline-flex items-center gap-1 text-[11px] font-medium mb-2 transition-opacity hover:opacity-70"
              style={{ color: "var(--text-muted)" }}>
              <ArrowLeft size={12} strokeWidth={2} /> Back to dashboard
            </button>
            <h1 style={{
              fontSize: "clamp(20px, 4vw, 24px)", fontWeight: 700,
              letterSpacing: "-0.01em", color: "var(--text)", margin: 0,
            }}>
              Intercompany
            </h1>
            <p className="text-xs sm:text-sm mt-1.5" style={{ color: "var(--text-muted)" }}>
              Flag GL accounts that record transactions with related entities. Balances
              should net to zero against the matching account on the counterparty&apos;s books.
            </p>
          </div>
          <div className="flex items-end gap-2 flex-wrap">
            <div className="flex flex-col">
              <span className="text-[10px] font-semibold uppercase tracking-wide mb-1" style={{ color: "var(--text-muted)" }}>
                Period end
              </span>
              <DatePicker value={periodEnd} onChange={setPeriodEnd} disabled={!qbo} />
            </div>
            <Button size="sm" variant="outline"
              icon={<Wand2 size={14} strokeWidth={1.8} />}
              loading={autoDetectMut.isPending}
              onClick={() => autoDetectMut.mutate()}
              disabled={!qbo}
              title="Scan QBO for accounts whose names look like intercompany (Due to/from, Intercompany, etc.)">
              Auto-detect
            </Button>
            <Button size="sm" variant="outline"
              icon={<Sparkles size={14} strokeWidth={1.8} />}
              loading={aiDetectMut.isPending}
              onClick={() => aiDetectMut.mutate()}
              disabled={!qbo}
              title="Use AI to analyze your whole chart of accounts. Catches accounts with non-standard names (e.g. 'Loan – HoldCo')">
              AI Scan
            </Button>
            <Button size="sm" icon={<Plus size={12} strokeWidth={1.8} />}
              onClick={() => setAddingNew(true)} disabled={!qbo}>
              Mark account
            </Button>
          </div>
        </div>
      </motion.div>

      {/* ── Tabs strip ─────────────────────────────────────────────── */}
      <div className="px-4 sm:px-8" style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
        <div className="flex items-center gap-1 max-w-7xl mx-auto">
          {([
            { id: "accounts",    label: "Accounts",         icon: Building2 },
            { id: "eliminations",label: "Eliminations",     icon: Calculator },
            { id: "consolidated",label: "Consolidated TB",  icon: Layers },
          ] as { id: Tab; label: string; icon: typeof Building2 }[]).map((t) => {
            const Icon = t.icon
            const active = tab === t.id
            return (
              <button key={t.id} onClick={() => setTab(t.id)}
                className="inline-flex items-center gap-1.5 px-3 py-2.5 text-xs font-semibold border-b-2 transition-colors"
                style={{
                  color:        active ? "var(--text)" : "var(--text-muted)",
                  borderColor:  active ? "var(--green)" : "transparent",
                }}>
                <Icon size={13} strokeWidth={1.8} /> {t.label}
              </button>
            )
          })}
        </div>
      </div>

      {tab === "eliminations" && (
        <EliminationsView periodEnd={periodEnd} qboReady={!!qbo} />
      )}
      {tab === "consolidated" && (
        <ConsolidatedView periodEnd={periodEnd} qboReady={!!qbo} />
      )}

      {tab === "accounts" && (
      <div className="flex-1 px-4 sm:px-8 py-5 max-w-7xl w-full mx-auto space-y-5">

        {/* Auto-detect result toast — green when something matched, amber
            "scanned N, matched 0" diagnostic when nothing did so the user
            knows the scanner actually ran. The amber path tells them to
            try AI Scan, which is the natural next step. */}
        <AnimatePresence>
          {autoDetectMut.isSuccess && autoDetectMut.data && (
            <motion.div
              key="auto-toast"
              initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
              className="rounded-lg px-4 py-2.5 text-xs"
              style={
                autoDetectMut.data.added > 0
                  ? { background: "var(--green-subtle)", border: "1px solid var(--green)", color: "var(--green)" }
                  : { background: "#fef3c7", border: "1px solid #f59e0b", color: "#92400e" }
              }>
              {autoDetectMut.data.added > 0 ? (
                <>
                  Marked {autoDetectMut.data.added} new IC account
                  {autoDetectMut.data.added === 1 ? "" : "s"} based on QBO names
                  {autoDetectMut.data.classified > 0 && (
                    <> · auto-classified counterparty for {autoDetectMut.data.classified}</>
                  )}
                  {" "}(scanned {autoDetectMut.data.scanned} balance-sheet accounts).
                </>
              ) : (
                <>
                  Scanned {autoDetectMut.data.scanned} balance-sheet accounts —
                  {autoDetectMut.data.already_marked > 0 && (
                    <> {autoDetectMut.data.already_marked} already tracked,</>
                  )}
                  {" "}none matched IC name patterns. If you have IC accounts under non-standard
                  names, click <strong>AI Scan</strong> instead.
                </>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* AI-detect result toast */}
        <AnimatePresence>
          {aiDetectMut.isSuccess && aiDetectMut.data && (
            <motion.div
              key="ai-toast"
              initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
              className="rounded-lg px-4 py-2.5 text-xs"
              style={
                aiDetectMut.data.added > 0
                  ? { background: "rgba(168, 85, 247, 0.08)", border: "1px solid #a855f7", color: "#7c3aed" }
                  : { background: "#fef3c7", border: "1px solid #f59e0b", color: "#92400e" }
              }>
              {aiDetectMut.data.added > 0 ? (
                <>
                  <Sparkles size={11} strokeWidth={2} className="inline mr-1 -mt-0.5" />
                  AI marked {aiDetectMut.data.added} new IC account
                  {aiDetectMut.data.added === 1 ? "" : "s"} (out of {aiDetectMut.data.ai_candidates} candidate
                  {aiDetectMut.data.ai_candidates === 1 ? "" : "s"}, {aiDetectMut.data.skipped_lowconf} low-confidence).
                  Each row has the AI&apos;s reasoning in notes — review and refine.
                </>
              ) : (
                <>
                  AI scanned {aiDetectMut.data.scanned} accounts and didn&apos;t find anything
                  that looks intercompany. If you know an account IS intercompany, use
                  <strong> Mark account</strong> to flag it manually.
                </>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* QBO not connected */}
        {!qbo && (
          <div className="rounded-xl p-4 flex items-start gap-3"
            style={{ background: "#fef3c7", border: "1px solid #f59e0b" }}>
            <AlertCircle size={18} style={{ color: "#92400e" }} className="shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-semibold" style={{ color: "#92400e" }}>QuickBooks isn&apos;t connected</p>
              <p className="text-xs mt-0.5" style={{ color: "#92400e" }}>
                Connect QuickBooks to surface your GL accounts and let Nordavix auto-detect intercompany ones.
              </p>
            </div>
            <Button size="sm" onClick={() => navigate("/app/connections")}>Connect</Button>
          </div>
        )}

        {/* Pending detection banner */}
        {qbo && overview && overview.detected_pending > 0 && (
          <div className="rounded-xl p-4 flex items-start gap-3"
            style={{ background: "rgba(168, 85, 247, 0.08)", border: "1px solid #a855f7" }}>
            <Wand2 size={18} style={{ color: "#7c3aed" }} className="shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-semibold" style={{ color: "#7c3aed" }}>
                {overview.detected_pending} candidate account{overview.detected_pending === 1 ? "" : "s"} look like IC
              </p>
              <p className="text-xs mt-0.5" style={{ color: "var(--text-2)" }}>
                Click Auto-detect to mark them automatically. You can re-classify or remove them after.
              </p>
            </div>
            <Button size="sm" variant="outline" loading={autoDetectMut.isPending}
              onClick={() => autoDetectMut.mutate()}>
              Run auto-detect
            </Button>
          </div>
        )}

        {/* KPI strip */}
        {qbo && overview && overview.accounts.length > 0 && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Kpi label="IC receivables" value={fmtMoney(overview.totals.receivables)}
              tone="var(--green)" sub="due FROM related entities" />
            <Kpi label="IC payables" value={fmtMoney(overview.totals.payables)}
              tone="#1d4ed8" sub="due TO related entities" />
            <Kpi label="Net position" value={fmtMoney(overview.totals.net)}
              tone={parseFloat(overview.totals.net) >= 0 ? "var(--green)" : "#dc2626"}
              sub={parseFloat(overview.totals.net) >= 0 ? "net receivable" : "net payable"} />
            <Kpi label="Accounts tracked" value={String(overview.accounts.length)}
              tone="var(--text)" sub="across all related entities" />
          </div>
        )}

        {/* Empty state — no IC accounts and nothing auto-detectable */}
        {hasNoIc && (
          <div className="rounded-xl p-10 text-center"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
            <div className="h-14 w-14 mx-auto rounded-full flex items-center justify-center mb-4"
              style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}>
              <Building2 size={26} strokeWidth={1.6} />
            </div>
            <p className="text-base font-semibold text-theme mb-1">
              No intercompany activity detected
            </p>
            <p className="text-sm max-w-md mx-auto mb-5" style={{ color: "var(--text-muted)" }}>
              We couldn&apos;t find any GL accounts that look like intercompany
              (Due to / Due from / IC). If your company doesn&apos;t do intercompany
              accounting, you can ignore this module. Otherwise mark accounts manually below.
            </p>
            <div className="flex items-center justify-center gap-2">
              <Button size="sm" variant="outline" icon={<Wand2 size={14} strokeWidth={1.8} />}
                loading={autoDetectMut.isPending} onClick={() => autoDetectMut.mutate()}>
                Re-scan QBO
              </Button>
              <Button size="sm" icon={<Plus size={12} strokeWidth={1.8} />}
                onClick={() => setAddingNew(true)}>
                Mark an account manually
              </Button>
            </div>
          </div>
        )}

        {/* Search + table */}
        {qbo && overview && overview.accounts.length > 0 && (
          <>
            <div className="flex items-center gap-3 flex-wrap">
              <div className="relative flex-1 min-w-[200px] max-w-md">
                <Search size={14} strokeWidth={1.8}
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
                  style={{ color: "var(--text-muted)" }} />
                <input type="text" value={search} onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search account / counterparty…"
                  className="w-full rounded-lg pl-8 pr-3 py-1.5 text-sm outline-none"
                  style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }} />
              </div>
            </div>

            <div className="rounded-xl overflow-hidden"
              style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[900px]">
                  <thead>
                    <tr style={{ background: "var(--surface-2)", borderBottom: "1px solid var(--border)" }}>
                      {[
                        { label: "Account No.", w: "100px" },
                        { label: "Account",     w: "auto" },
                        { label: "Counterparty",w: "180px" },
                        { label: "Kind",        w: "110px" },
                        { label: "Balance",     w: "120px", right: true },
                        { label: "Change",      w: "120px", right: true },
                        { label: "",            w: "140px" },
                      ].map((h, i) => (
                        <th key={i}
                          className="text-[10px] font-semibold uppercase tracking-wide px-3 py-2.5"
                          style={{ color: "var(--text-muted)", textAlign: h.right ? "right" : "left", width: h.w }}>
                          {h.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((a) => {
                      const kind = KIND_META[a.kind]
                      const change = a.change ? parseFloat(a.change) : 0
                      return (
                        <Fragment key={a.id}>
                          <tr style={{ borderBottom: "1px solid var(--border)" }}>
                            <td className="px-3 py-3 font-mono text-xs" style={{ color: "var(--text-muted)" }}>
                              {a.account_number || "—"}
                            </td>
                            <td className="px-3 py-3">
                              <div className="text-sm font-medium text-theme">{a.account_name}</div>
                              <div className="text-[10px] mt-0.5" style={{ color: "var(--text-muted)" }}>
                                {a.account_type}
                                {a.auto_detected && (
                                  <span className="ml-1.5 text-[9px] font-bold uppercase px-1 py-0.5 rounded"
                                    style={{ background: "rgba(168, 85, 247, 0.15)", color: "#a855f7" }}>
                                    Auto
                                  </span>
                                )}
                              </div>
                              {a.notes && (
                                <div className="text-[11px] italic mt-1" style={{ color: "var(--text-2)" }}>
                                  {a.notes}
                                </div>
                              )}
                            </td>
                            <td className="px-3 py-3 text-xs" style={{ color: "var(--text-2)" }}>
                              {a.counterparty || <span style={{ color: "var(--text-muted)" }}>—</span>}
                            </td>
                            <td className="px-3 py-3">
                              <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold"
                                style={{ background: kind.bg, color: kind.fg }}>
                                {kind.label}
                              </span>
                            </td>
                            <td className="px-3 py-3 text-right tabular-nums text-sm font-semibold text-theme">
                              {fmtMoney(a.gl_balance)}
                            </td>
                            <td className="px-3 py-3 text-right tabular-nums text-xs"
                              style={{ color: change > 0 ? "var(--green)" : change < 0 ? "#dc2626" : "var(--text-muted)" }}>
                              {a.change !== null ? (change >= 0 ? "+" : "") + fmtMoney(a.change) : "—"}
                            </td>
                            <td className="px-3 py-3">
                              <div className="flex items-center justify-end gap-1">
                                {(() => {
                                  const pair = pairByAccountId[a.qbo_account_id]
                                  return pair ? (
                                    <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-semibold"
                                      style={{ background: "var(--green-subtle)", color: "var(--green)" }}
                                      title={`Paired with ${pair.counterparty_label}`}>
                                      <Link2 size={10} strokeWidth={2} />
                                      <span className="hidden lg:inline truncate max-w-[180px]">
                                        {pair.counterparty_label}
                                      </span>
                                      <span className="lg:hidden">Paired</span>
                                    </span>
                                  ) : (
                                    <Button size="sm" variant="outline"
                                      icon={<Link2 size={11} strokeWidth={1.8} />}
                                      onClick={() => setPairingAccount(a)}>
                                      <span className="hidden md:inline">Pair</span>
                                    </Button>
                                  )
                                })()}
                                <Button size="sm" variant="outline"
                                  icon={<Eye size={11} strokeWidth={1.8} />}
                                  onClick={() => setDrawerAccount(a)}>
                                  <span className="hidden md:inline">Txns</span>
                                </Button>
                                <button onClick={() => setEditingAccount(a)}
                                  className="h-7 w-7 rounded-md flex items-center justify-center transition-colors hover:bg-[var(--surface-2)]"
                                  style={{ color: "var(--text-muted)" }} title="Edit">
                                  <Edit2 size={12} strokeWidth={1.8} />
                                </button>
                              </div>
                            </td>
                          </tr>
                        </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
      )}

      {/* Mark/edit modal */}
      <AnimatePresence>
        {(editingAccount || addingNew) && (
          <MarkModal
            existing={editingAccount}
            onClose={() => { setEditingAccount(null); setAddingNew(false) }}
            onSaved={() => {
              setEditingAccount(null); setAddingNew(false)
              qc.invalidateQueries({ queryKey: ["intercompany-overview"] })
            }}
          />
        )}
      </AnimatePresence>

      {/* Pair-with picker modal */}
      <AnimatePresence>
        {pairingAccount && (
          <PairPickerModal
            account={pairingAccount}
            existingPair={pairByAccountId[pairingAccount.qbo_account_id]}
            onClose={() => setPairingAccount(null)}
            onSaved={() => {
              setPairingAccount(null)
              qc.invalidateQueries({ queryKey: ["intercompany-pairs"] })
            }}
          />
        )}
      </AnimatePresence>

      {/* Transactions drawer */}
      <AnimatePresence>
        {drawerAccount && (
          <TransactionsDrawer
            account={drawerAccount}
            periodEnd={periodEnd}
            onClose={() => setDrawerAccount(null)}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

// ── Kpi ────────────────────────────────────────────────────────────────────

function Kpi({ label, value, tone, sub }: { label: string; value: string; tone: string; sub?: string }) {
  return (
    <div className="rounded-xl p-4"
      style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
      <p className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>{label}</p>
      <p className="text-xl sm:text-2xl font-bold tabular-nums mt-1" style={{ color: tone }}>{value}</p>
      {sub && <p className="text-[10px] mt-1" style={{ color: "var(--text-muted)" }}>{sub}</p>}
    </div>
  )
}

// ── MarkModal ──────────────────────────────────────────────────────────────

function MarkModal({ existing, onClose, onSaved }:
  { existing: IcAccount | null; onClose: () => void; onSaved: () => void }
) {
  // Escape closes the modal — standard modal contract across the app.
  useEscapeClose(onClose)

  const qc = useQueryClient()
  const [qboId, setQboId]       = useState(existing?.qbo_account_id ?? "")
  const [counterparty, setCp]   = useState(existing?.counterparty ?? "")
  const [kind, setKind]         = useState<IcKind>(existing?.kind ?? "unknown")
  const [notes, setNotes]       = useState(existing?.notes ?? "")

  // Save (upsert) — optimistic close + invalidate so the modal feels
  // instant. The overview query refetches in the background and lands
  // shortly after. Server rejections are surfaced via the standard
  // axios error path (rare since we validated the inputs client-side).
  const saveMut = useMutation({
    mutationFn: () => icApi.upsertMark({
      qbo_account_id: qboId.trim(),
      counterparty:   counterparty.trim() || null,
      kind,
      notes:          notes.trim() || null,
    }),
    onMutate: () => {
      // Optimistically close the modal so the user isn't staring at
      // a spinner; the parent's onSaved will fire on success too,
      // but we don't want them to think the save is hung.
      onSaved()
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["intercompany-overview"] }),
  })
  // Delete — optimistic remove from the cached list so the row vanishes
  // immediately. Rollback on error restores it.
  const deleteMut = useMutation({
    mutationFn: () => icApi.deleteMark(existing!.id),
    onMutate: async () => {
      if (!existing) return { prev: undefined }
      await qc.cancelQueries({ queryKey: ["intercompany-overview"] })
      const prev = qc.getQueryData<unknown>(["intercompany-overview"])
      // Best-effort optimistic patch: filter the deleted mark out of any
      // list-shaped data on the overview query.
      qc.setQueryData<{ accounts?: IcAccount[] } | undefined>(
        ["intercompany-overview"],
        (old) => {
          if (!old?.accounts) return old
          return { ...old, accounts: old.accounts.filter((a) => a.id !== existing.id) }
        },
      )
      onClose()
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev !== undefined) qc.setQueryData(["intercompany-overview"], ctx.prev)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["intercompany-overview"] }),
  })

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.4)" }}
      onClick={onClose}>
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }}
        transition={{ duration: 0.15 }}
        className="w-full max-w-md rounded-xl p-5 space-y-4"
        style={{ background: "var(--surface)", border: "1px solid var(--border-strong)" }}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-theme">
            {existing ? "Edit IC account" : "Mark account as intercompany"}
          </h3>
          <button onClick={onClose} className="h-7 w-7 rounded-md flex items-center justify-center"
            style={{ color: "var(--text-muted)" }}>
            <X size={14} strokeWidth={1.8} />
          </button>
        </div>

        <label className="block">
          <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
            QBO account ID
          </span>
          <input type="text" value={qboId} onChange={(e) => setQboId(e.target.value)}
            disabled={!!existing}
            placeholder="e.g. 42"
            className="w-full rounded-lg px-3 py-2 mt-1 text-sm outline-none font-mono"
            style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)",
                     opacity: existing ? 0.6 : 1 }} />
          {existing && (
            <p className="text-[10px] mt-1" style={{ color: "var(--text-muted)" }}>
              {existing.account_number} {existing.account_name} · {existing.account_type}
            </p>
          )}
        </label>

        <label className="block">
          <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
            Counterparty (related entity name)
          </span>
          <input type="text" value={counterparty} onChange={(e) => setCp(e.target.value)}
            placeholder="e.g. Acme Holdings LLC"
            className="w-full rounded-lg px-3 py-2 mt-1 text-sm outline-none"
            style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }} />
        </label>

        <label className="block">
          <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
            Kind
          </span>
          <select value={kind} onChange={(e) => setKind(e.target.value as IcKind)}
            className="w-full rounded-lg px-3 py-2 mt-1 text-sm outline-none"
            style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }}>
            <option value="receivable">Receivable (due from related entity)</option>
            <option value="payable">Payable (due to related entity)</option>
            <option value="unknown">Unknown / both</option>
          </select>
        </label>

        <label className="block">
          <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
            Notes (optional)
          </span>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
            className="w-full rounded-lg px-3 py-2 mt-1 text-sm outline-none resize-none"
            style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }} />
        </label>

        {saveMut.error ? (
          <p className="text-xs" style={{ color: "#b91c1c" }}>
            {((saveMut.error as { message?: string })?.message) ?? "Couldn't save."}
          </p>
        ) : null}

        <div className="flex items-center justify-between pt-1">
          {existing ? (
            <Button size="sm" variant="ghost"
              icon={<Trash2 size={11} strokeWidth={1.8} />}
              loading={deleteMut.isPending}
              onClick={() => { if (confirm("Remove this IC mark?")) deleteMut.mutate() }}
              style={{ color: "#b91c1c" }}>
              Remove
            </Button>
          ) : <span />}
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button size="sm" loading={saveMut.isPending}
              disabled={!qboId.trim()}
              onClick={() => saveMut.mutate()}>
              {existing ? "Save changes" : "Mark account"}
            </Button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  )
}

// ── TransactionsDrawer ────────────────────────────────────────────────────

function TransactionsDrawer({ account, periodEnd, onClose }:
  { account: IcAccount; periodEnd: string; onClose: () => void }
) {
  useEscapeClose(onClose)

  const { data, isLoading } = useQuery({
    queryKey: ["intercompany-txns", account.qbo_account_id, periodEnd],
    queryFn:  () => icApi.getTransactions(account.qbo_account_id, periodEnd),
    staleTime: 60_000,
  })

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex justify-end"
      style={{ background: "rgba(0,0,0,0.4)" }}
      onClick={onClose}>
      <motion.div
        initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }}
        transition={{ duration: 0.18, ease: "easeOut" }}
        className="w-full max-w-2xl h-full flex flex-col overflow-hidden"
        style={{ background: "var(--surface)", borderLeft: "1px solid var(--border-strong)" }}
        onClick={(e) => e.stopPropagation()}>

        <div className="px-5 py-4 flex items-center justify-between"
          style={{ borderBottom: "1px solid var(--border)" }}>
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
              IC transactions · {periodEnd}
            </p>
            <h3 className="text-sm font-semibold text-theme mt-0.5 truncate">
              {account.account_number} {account.account_name}
              {account.counterparty && <span style={{ color: "var(--text-muted)" }}> · {account.counterparty}</span>}
            </h3>
          </div>
          <button onClick={onClose} className="h-7 w-7 rounded-md flex items-center justify-center"
            style={{ color: "var(--text-muted)" }}>
            <X size={15} strokeWidth={1.8} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            // Skeleton rows that mimic the real transaction table so
            // the drawer doesn't flash an empty pane while the network
            // request lands. Column widths roughly match the real
            // columns (Type / # / Date / Entity / Memo / Amount).
            <SkeletonTable
              rows={6}
              columns={["12%", "8%", "12%", "18%", "30%", "14%"]}
            />
          ) : !data || data.rows.length === 0 ? (
            <div className="px-6 py-12 text-center text-sm" style={{ color: "var(--text-muted)" }}>
              No transactions posted to this account in {periodEnd.slice(0, 7)}.
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead style={{ background: "var(--surface-2)", position: "sticky", top: 0 }}>
                <tr>
                  {["Type", "#", "Date", "Entity", "Memo", "Amount"].map((h) => (
                    <th key={h} className="text-left px-3 py-2 font-semibold text-[10px] uppercase tracking-wide"
                      style={{ color: "var(--text-muted)", textAlign: h === "Amount" ? "right" : "left" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.txn_id || `${r.txn_type}-${r.txn_number}-${r.txn_date}`}
                    style={{ borderTop: "1px solid var(--border)" }}>
                    <td className="px-3 py-2 text-theme">{r.txn_type}</td>
                    <td className="px-3 py-2 font-mono" style={{ color: "var(--text-2)" }}>{r.txn_number || "—"}</td>
                    <td className="px-3 py-2" style={{ color: "var(--text-2)" }}>{r.txn_date || "—"}</td>
                    <td className="px-3 py-2 truncate max-w-[140px]" style={{ color: "var(--text-2)" }}>{r.entity || "—"}</td>
                    <td className="px-3 py-2 truncate max-w-[200px]" style={{ color: "var(--text-muted)" }}>{r.memo || "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium text-theme">
                      {fmtMoney(r.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ background: "var(--surface-2)", borderTop: "2px solid var(--border-strong)" }}>
                  <td colSpan={5} className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wide"
                    style={{ color: "var(--text-muted)" }}>
                    Period total
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums font-bold text-theme">
                    {fmtMoney(data.total)}
                  </td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      </motion.div>
    </motion.div>
  )
}

// Stub to silence unused imports lint — Pencil reserved for future inline-edit polish.
void Pencil

// ── EliminationsView ──────────────────────────────────────────────────────
//
// Per-pair table showing both sides' period-end balance + the diff. A
// "matched" pair (|diff| ≤ $1) is what we eliminate on consolidation;
// a "mismatch" needs investigation before consolidation.

function EliminationsView({ periodEnd, qboReady }: { periodEnd: string; qboReady: boolean }) {
  const { data, isLoading } = useQuery({
    queryKey: ["intercompany-eliminations", periodEnd],
    queryFn:  () => icApi.getEliminations(periodEnd),
    enabled:  qboReady,
    staleTime: 30_000,
  })

  const [downloading, setDownloading] = useState(false)
  async function handleDownload() {
    if (downloading) return
    setDownloading(true)
    try { await icApi.downloadEliminationsXlsx(periodEnd) }
    finally { setDownloading(false) }
  }

  return (
    <div className="flex-1 px-4 sm:px-8 py-5 max-w-7xl w-full mx-auto space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-base font-bold text-theme">Eliminations</h2>
          <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
            For every paired account: both sides&apos; balance at {periodEnd} and the elimination diff.
            Matched pairs eliminate cleanly; mismatched pairs need investigation.
          </p>
        </div>
        <Button size="sm" variant="outline"
          icon={<Download size={12} strokeWidth={1.8} />}
          loading={downloading} disabled={!data || data.rows.length === 0}
          onClick={handleDownload}>
          Export Excel
        </Button>
      </div>

      {isLoading ? (
        <div className="py-16 flex items-center justify-center"><Spinner /></div>
      ) : !data || data.rows.length === 0 ? (
        <div className="rounded-xl p-10 text-center"
          style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
          <div className="h-14 w-14 mx-auto rounded-full flex items-center justify-center mb-4"
            style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}>
            <Calculator size={26} strokeWidth={1.6} />
          </div>
          <p className="text-base font-semibold text-theme mb-1">No pairs yet</p>
          <p className="text-sm max-w-md mx-auto" style={{ color: "var(--text-muted)" }}>
            Pair an IC account in this workspace with the matching account in another
            connected workspace. Open the Accounts tab → click <strong>Pair</strong> on any row.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <Kpi label="Matched"   value={String(data.totals.matched_count)}   tone="var(--green)" sub="eliminate cleanly" />
            <Kpi label="Mismatch"  value={String(data.totals.mismatch_count)}  tone="#dc2626"      sub="investigate" />
            <Kpi label="To eliminate" value={fmtMoney(data.totals.total_to_eliminate)} tone="var(--text)" sub="matched pairs" />
          </div>

          <div className="rounded-xl overflow-hidden"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[900px]">
                <thead>
                  <tr style={{ background: "var(--surface-2)", borderBottom: "1px solid var(--border)" }}>
                    {[
                      { label: "Status", w: "120px" },
                      { label: "My account",  w: "auto" },
                      { label: "My balance",  w: "130px", right: true },
                      { label: "Counterparty", w: "auto" },
                      { label: "Counterparty balance", w: "150px", right: true },
                      { label: "Diff", w: "130px", right: true },
                    ].map((h, i) => (
                      <th key={i}
                        className="text-[10px] font-semibold uppercase tracking-wide px-3 py-2.5"
                        style={{ color: "var(--text-muted)", textAlign: h.right ? "right" : "left", width: h.w }}>
                        {h.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => <EliminationRowView key={r.pair_group_id} row={r} />)}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function EliminationRowView({ row }: { row: EliminationRow }) {
  const StatusIcon = row.status === "matched" ? CheckCircle2
                    : row.status === "mismatch" ? AlertTriangle : CircleSlash
  const statusColor = row.status === "matched" ? "var(--green)"
                    : row.status === "mismatch" ? "#dc2626" : "var(--text-muted)"
  const statusLabel = row.status === "matched" ? "Matched"
                    : row.status === "mismatch" ? "Mismatch" : "Side missing"
  const diff = parseFloat(row.diff)
  return (
    <tr style={{ borderBottom: "1px solid var(--border)" }}>
      <td className="px-3 py-3">
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold"
          style={{ background: row.status === "matched" ? "var(--green-subtle)" : "var(--surface-2)", color: statusColor }}>
          <StatusIcon size={11} strokeWidth={2} /> {statusLabel}
        </span>
      </td>
      <td className="px-3 py-3 text-sm font-medium text-theme">{row.my_account_label}</td>
      <td className="px-3 py-3 text-right tabular-nums font-semibold text-theme">
        {fmtMoney(row.my_balance)}
      </td>
      <td className="px-3 py-3 text-sm" style={{ color: "var(--text-2)" }}>{row.counterparty_label}</td>
      <td className="px-3 py-3 text-right tabular-nums font-semibold text-theme">
        {fmtMoney(row.counterparty_balance)}
      </td>
      <td className="px-3 py-3 text-right tabular-nums text-sm"
        style={{ color: Math.abs(diff) <= 1 ? "var(--green)" : "#dc2626", fontWeight: 600 }}>
        {fmtMoney(row.diff)}
      </td>
    </tr>
  )
}

// ── ConsolidatedView ───────────────────────────────────────────────────────
//
// Combined TB across the current tenant + every tenant we have at least
// one pair with. The "Elimination" column carries the elim amount for
// paired IC accounts; "Consolidated" = Raw + Elimination.

function ConsolidatedView({ periodEnd, qboReady }: { periodEnd: string; qboReady: boolean }) {
  const { data, isLoading } = useQuery({
    queryKey: ["intercompany-consolidated", periodEnd],
    queryFn:  () => icApi.getConsolidatedTb(periodEnd),
    enabled:  qboReady,
    staleTime: 30_000,
  })

  const [downloading, setDownloading] = useState(false)
  async function handleDownload() {
    if (downloading) return
    setDownloading(true)
    try { await icApi.downloadConsolidatedTbXlsx(periodEnd) }
    finally { setDownloading(false) }
  }

  // Group rows by fs_category for sectioned rendering
  const grouped = useMemo(() => {
    const g: Record<string, ConsolidatedRow[]> = {}
    for (const r of data?.rows ?? []) {
      (g[r.fs_category] ??= []).push(r)
    }
    return g
  }, [data])

  const CAT_ORDER = ["Assets", "Liabilities", "Equity", "Revenue", "Expenses", "Other"]

  return (
    <div className="flex-1 px-4 sm:px-8 py-5 max-w-7xl w-full mx-auto space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-base font-bold text-theme">Consolidated trial balance</h2>
          <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
            All paired entities combined at {periodEnd}, with intercompany balances eliminated.
            {data && data.companies.length > 0 && (
              <>{" · "}<span className="font-medium" style={{ color: "var(--text-2)" }}>
                Entities: {data.companies.map((c) => c.name).join(", ")}
              </span></>
            )}
          </p>
        </div>
        <Button size="sm" variant="outline"
          icon={<Download size={12} strokeWidth={1.8} />}
          loading={downloading} disabled={!data || data.rows.length === 0}
          onClick={handleDownload}>
          Export Excel
        </Button>
      </div>

      {isLoading ? (
        <div className="py-16 flex items-center justify-center"><Spinner /></div>
      ) : !data || data.rows.length === 0 ? (
        <div className="rounded-xl p-10 text-center"
          style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
          <div className="h-14 w-14 mx-auto rounded-full flex items-center justify-center mb-4"
            style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}>
            <Layers size={26} strokeWidth={1.6} />
          </div>
          <p className="text-base font-semibold text-theme mb-1">Nothing to consolidate yet</p>
          <p className="text-sm max-w-md mx-auto" style={{ color: "var(--text-muted)" }}>
            Sync recons in each entity to build the GL snapshot, then pair IC accounts so
            we know what to eliminate. The consolidated view appears here once both are done.
          </p>
        </div>
      ) : (
        <div className="rounded-xl overflow-hidden"
          style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[900px]">
              <thead>
                <tr style={{ background: "var(--surface-2)", borderBottom: "1px solid var(--border)" }}>
                  {[
                    { label: "Company", w: "180px" },
                    { label: "Account", w: "auto" },
                    { label: "Raw",          w: "120px", right: true },
                    { label: "Elimination",  w: "130px", right: true },
                    { label: "Consolidated", w: "140px", right: true },
                  ].map((h, i) => (
                    <th key={i}
                      className="text-[10px] font-semibold uppercase tracking-wide px-3 py-2.5"
                      style={{ color: "var(--text-muted)", textAlign: h.right ? "right" : "left", width: h.w }}>
                      {h.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {CAT_ORDER.filter((cat) => grouped[cat]?.length).map((cat) => {
                  const rows = grouped[cat]
                  const totals = data.totals[cat] ?? { raw: "0", elimination: "0", consolidated: "0" }
                  return (
                    <Fragment key={cat}>
                      <tr style={{ background: "var(--surface-2)" }}>
                        <td colSpan={5}
                          className="px-3 py-2 text-[10px] font-bold uppercase tracking-wider"
                          style={{ color: "var(--text-2)" }}>
                          {cat}
                        </td>
                      </tr>
                      {rows.map((r) => {
                        const elim = parseFloat(r.elimination)
                        return (
                          <tr key={`${r.tenant_id}-${r.qbo_account_id}`}
                            style={{ borderBottom: "1px solid var(--border)" }}>
                            <td className="px-3 py-2.5 text-xs" style={{ color: "var(--text-2)" }}>
                              {r.company_name}
                            </td>
                            <td className="px-3 py-2.5 text-sm text-theme">{r.account_label}</td>
                            <td className="px-3 py-2.5 text-right tabular-nums">{fmtMoney(r.raw_balance)}</td>
                            <td className="px-3 py-2.5 text-right tabular-nums"
                              style={{ color: elim !== 0 ? "#dc2626" : "var(--text-muted)" }}>
                              {elim !== 0 ? fmtMoney(r.elimination) : "—"}
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-theme">
                              {fmtMoney(r.consolidated)}
                            </td>
                          </tr>
                        )
                      })}
                      <tr style={{ background: "var(--surface-2)", borderBottom: "2px solid var(--border-strong)" }}>
                        <td colSpan={2}
                          className="px-3 py-2 text-[11px] font-bold text-right uppercase tracking-wide"
                          style={{ color: "var(--text-2)" }}>
                          Total {cat}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums font-bold text-theme">{fmtMoney(totals.raw)}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-bold" style={{ color: parseFloat(totals.elimination) !== 0 ? "#dc2626" : "var(--text-muted)" }}>
                          {parseFloat(totals.elimination) !== 0 ? fmtMoney(totals.elimination) : "—"}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums font-bold text-theme">{fmtMoney(totals.consolidated)}</td>
                      </tr>
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// ── PairPickerModal ────────────────────────────────────────────────────────
//
// Two-step cascading selection: pick a company you have access to, then
// pick an IC account in that company. Save → POST /pairs which writes
// both halves of the pair in one tx.

function PairPickerModal({ account, existingPair, onClose, onSaved }:
  { account: IcAccount; existingPair: IcPair | undefined;
    onClose: () => void; onSaved: () => void }
) {
  useEscapeClose(onClose)

  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ["intercompany-accessible-companies"],
    queryFn:  () => icApi.listAccessibleCompanies(),
    staleTime: 60_000,
  })

  const [tenantId, setTenantId] = useState<string>("")
  const [cpAccountId, setCpAccountId] = useState<string>("")

  const companies: AccessibleCompany[] = data?.companies ?? []
  const selectedCompany = companies.find((c) => c.tenant_id === tenantId)

  const createMut = useMutation({
    mutationFn: () => icApi.createPair({
      my_qbo_account_id: account.qbo_account_id,
      counterparty_tenant_id: tenantId,
      counterparty_qbo_account_id: cpAccountId,
    }),
    onSuccess: () => onSaved(),
  })

  const deleteMut = useMutation({
    mutationFn: () => icApi.deletePair(existingPair!.pair_group_id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["intercompany-pairs"] })
      onClose()
    },
  })

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.4)" }} onClick={onClose}>
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }}
        transition={{ duration: 0.15 }}
        className="w-full max-w-lg rounded-xl p-5 space-y-4"
        style={{ background: "var(--surface)", border: "1px solid var(--border-strong)" }}
        onClick={(e) => e.stopPropagation()}>

        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-theme">Pair with another company</h3>
            <p className="text-[11px] mt-0.5" style={{ color: "var(--text-muted)" }}>
              Link <span className="font-medium text-theme">{account.account_number} {account.account_name}</span>
              {" "}with the matching IC account in another workspace you have access to.
            </p>
          </div>
          <button onClick={onClose} className="h-7 w-7 rounded-md flex items-center justify-center"
            style={{ color: "var(--text-muted)" }}>
            <X size={14} strokeWidth={1.8} />
          </button>
        </div>

        {existingPair ? (
          <div className="rounded-lg p-4"
            style={{ background: "var(--green-subtle)", border: "1px solid var(--green)" }}>
            <div className="flex items-center gap-2">
              <Link2 size={14} strokeWidth={2} style={{ color: "var(--green)" }} />
              <span className="text-sm font-semibold" style={{ color: "var(--green)" }}>Currently paired</span>
            </div>
            <p className="text-xs mt-1 ml-6" style={{ color: "var(--text-2)" }}>
              {existingPair.counterparty_label}
            </p>
            <div className="mt-3 flex justify-end">
              <Button size="sm" variant="outline"
                icon={<Unlink size={11} strokeWidth={1.8} />}
                loading={deleteMut.isPending}
                onClick={() => { if (confirm("Unpair these accounts? This removes both sides.")) deleteMut.mutate() }}
                style={{ color: "#b91c1c" }}>
                Unpair
              </Button>
            </div>
          </div>
        ) : isLoading ? (
          <div className="py-10 flex items-center justify-center"><Spinner /></div>
        ) : companies.length === 0 ? (
          <div className="rounded-lg p-4 text-center"
            style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
            <p className="text-sm text-theme">No other workspaces available</p>
            <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
              To pair, you need access to at least one other Nordavix workspace.
              Ask an admin of the other entity to add you, or create a workspace for them.
            </p>
          </div>
        ) : (
          <>
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                Counterparty company
              </span>
              <select value={tenantId} onChange={(e) => { setTenantId(e.target.value); setCpAccountId("") }}
                className="w-full rounded-lg px-3 py-2 mt-1 text-sm outline-none"
                style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }}>
                <option value="">Choose a workspace…</option>
                {companies.map((c) => (
                  <option key={c.tenant_id} value={c.tenant_id}>
                    {c.company_name || c.name}
                    {!c.qbo_connected && " (QBO not connected)"}
                  </option>
                ))}
              </select>
            </label>

            {selectedCompany && (
              <label className="block">
                <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                  Matching IC account in {selectedCompany.company_name || selectedCompany.name}
                </span>
                {selectedCompany.ic_accounts.length === 0 ? (
                  <p className="text-xs mt-2 italic" style={{ color: "var(--text-muted)" }}>
                    That workspace hasn&apos;t marked any IC accounts yet. Switch to that workspace
                    and run Auto-detect there first.
                  </p>
                ) : (
                  <select value={cpAccountId} onChange={(e) => setCpAccountId(e.target.value)}
                    className="w-full rounded-lg px-3 py-2 mt-1 text-sm outline-none"
                    style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }}>
                    <option value="">Choose an IC account…</option>
                    {selectedCompany.ic_accounts.map((a) => (
                      <option key={a.qbo_account_id} value={a.qbo_account_id}>
                        {a.account_number} {a.account_name} ({a.kind})
                      </option>
                    ))}
                  </select>
                )}
              </label>
            )}

            {createMut.error ? (
              <p className="text-xs" style={{ color: "#b91c1c" }}>
                {((createMut.error as { message?: string })?.message) ?? "Couldn't pair."}
              </p>
            ) : null}

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
              <Button size="sm"
                disabled={!tenantId || !cpAccountId}
                loading={createMut.isPending}
                onClick={() => createMut.mutate()}>
                Save pair
              </Button>
            </div>
          </>
        )}
      </motion.div>
    </motion.div>
  )
}
