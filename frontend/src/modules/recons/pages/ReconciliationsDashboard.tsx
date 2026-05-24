/**
 * Reconciliations Dashboard.
 *
 * - KPI cards across the top
 * - Recent reconciliations table
 * - Recent activity feed
 * - AI insights side panel
 * - Quick-start CTA to spin up a new AR/AP reconciliation
 */
import { useEffect, useState } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { motion, AnimatePresence } from "framer-motion"
import {
  Scale,
  CheckCircle2,
  AlertTriangle,
  Sparkles,
  ArrowRight,
  Plus,
  Activity,
  X,
  RefreshCw,
  TrendingUp,
} from "lucide-react"
import { Button, Spinner } from "@/core/ui/components"
import { reconsApi, type ReconType } from "@/modules/recons/api"
import { api as fluxApi } from "@/modules/flux/api"

const fadeUp = {
  hidden:  { opacity: 0, y: 14 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.35, ease: "easeOut" as const } },
}
const stagger = { hidden: {}, visible: { transition: { staggerChildren: 0.06, delayChildren: 0.05 } } }

const fmtMoney = (s: string | number) => {
  const n = typeof s === "string" ? parseFloat(s) : s
  return `$${(Number.isFinite(n) ? n : 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
}

const STATUS_TONE: Record<string, { bg: string; fg: string; dot: string }> = {
  pending:    { bg: "var(--surface-2)",     fg: "var(--text-muted)", dot: "var(--border-strong)" },
  syncing:    { bg: "#fef3c7",              fg: "#92400e",           dot: "#f59e0b" },
  computing:  { bg: "#fef3c7",              fg: "#92400e",           dot: "#f59e0b" },
  in_review:  { bg: "#dbeafe",              fg: "#1d4ed8",           dot: "#3b82f6" },
  approved:   { bg: "var(--green-subtle)",  fg: "var(--green)",      dot: "var(--green)" },
  error:      { bg: "#fee2e2",              fg: "#b91c1c",           dot: "#dc2626" },
}

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  syncing: "Syncing…",
  computing: "Computing…",
  in_review: "Ready to review",
  approved: "Approved",
  error: "Error",
}

export function ReconciliationsDashboard() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const [showCreate, setShowCreate] = useState<ReconType | null>(null)

  // Deep-link: ?new=AR | AP | BANK | CC opens the create modal on mount
  useEffect(() => {
    const n = searchParams.get("new") as ReconType | null
    if (n && ["AR", "AP", "BANK", "CC", "OTHER"].includes(n)) {
      setShowCreate(n)
      const sp = new URLSearchParams(searchParams)
      sp.delete("new")
      setSearchParams(sp, { replace: true })
    }
  }, [searchParams, setSearchParams])

  // Pull dashboard + QBO connection in parallel
  const { data: dash, isLoading } = useQuery({
    queryKey: ["recons-dashboard"],
    queryFn:  reconsApi.getDashboard,
    // Only poll when something is actively syncing — otherwise the dashboard
    // is fully cache-driven and refreshes on mount / mutation invalidations.
    refetchInterval: (q) => {
      const d = q.state.data
      if (!d) return false
      const live = d.recent.some(r => r.status === "syncing" || r.status === "computing")
      return live ? 5_000 : false
    },
    staleTime: 30_000,
  })
  const { data: qbo } = useQuery({
    queryKey: ["qbo-connection"],
    queryFn:  fluxApi.getQboConnection,
    staleTime: 60_000,
  })

  function gotoRecon(id: string) { navigate(`/app/reconciliations/${id}`) }

  return (
    <div className="flex flex-col h-full overflow-y-auto" style={{ background: "var(--bg)" }}>
      {/* Hero */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: "easeOut" }}
        className="relative overflow-hidden px-4 sm:px-8 pt-6 sm:pt-8 pb-4 sm:pb-6"
        style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}
      >
        <div className="pointer-events-none absolute -top-16 -right-16 h-48 w-48 rounded-full opacity-[0.06]"
          style={{ background: "radial-gradient(circle, var(--green) 0%, transparent 70%)" }} />
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <h1 className="text-lg sm:text-2xl font-bold tracking-tight text-theme leading-tight">
              Reconciliations
            </h1>
            <p className="text-xs sm:text-sm mt-1" style={{ color: "var(--text-muted)" }}>
              QuickBooks-synced AR / AP reconciliations with aging, risk scoring, and AI commentary.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              icon={<Plus size={14} strokeWidth={1.8} />}
              onClick={() => setShowCreate("AP")}
              disabled={!qbo}
              title={qbo ? "Start an AP reconciliation" : "Connect QuickBooks first"}
            >
              New AP
            </Button>
            <Button
              size="sm"
              icon={<Plus size={14} strokeWidth={1.8} />}
              onClick={() => setShowCreate("AR")}
              disabled={!qbo}
              title={qbo ? "Start an AR reconciliation" : "Connect QuickBooks first"}
            >
              New AR
            </Button>
          </div>
        </div>
      </motion.div>

      <div className="flex-1 px-4 sm:px-8 py-6 max-w-7xl w-full mx-auto space-y-6">

        {/* QBO required banner */}
        {!qbo && (
          <motion.div
            initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}
            className="rounded-xl p-4 flex items-start gap-3"
            style={{ background: "#fef3c7", border: "1px solid #f59e0b" }}
          >
            <AlertTriangle size={18} style={{ color: "#92400e" }} className="shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold" style={{ color: "#92400e" }}>QuickBooks isn't connected</p>
              <p className="text-xs mt-0.5" style={{ color: "#92400e" }}>
                Reconciliations pull customer/vendor balances, aging, and transactions from QBO.
                Connect QuickBooks to start your first reconciliation.
              </p>
            </div>
            <Button size="sm" onClick={() => navigate("/app/flux?connect=qbo")}>
              Connect QuickBooks
            </Button>
          </motion.div>
        )}

        {/* KPI cards */}
        <motion.div variants={stagger} initial="hidden" animate="visible"
          className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <KpiCard
            icon={<Scale size={20} strokeWidth={1.6} />}
            label="Total reconciliations"
            value={dash?.stats.total ?? 0}
            accent="var(--text-muted)"
          />
          <KpiCard
            icon={<CheckCircle2 size={20} strokeWidth={1.6} />}
            label="Completed"
            value={dash?.stats.completed ?? 0}
            accent="var(--green)"
          />
          <KpiCard
            icon={<TrendingUp size={20} strokeWidth={1.6} />}
            label="Pending review"
            value={dash?.stats.pending_review ?? 0}
            accent="#3b82f6"
          />
          <KpiCard
            icon={<AlertTriangle size={20} strokeWidth={1.6} />}
            label="High-risk accounts"
            value={dash?.stats.high_risk_accounts ?? 0}
            accent="#dc2626"
          />
        </motion.div>

        <motion.div variants={stagger} initial="hidden" animate="visible"
          className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <SecondaryCard
            label="Unresolved difference"
            value={dash ? fmtMoney(dash.stats.unresolved_difference) : "$0"}
            hint="Across open reconciliations"
            tone="#92400e"
          />
          <SecondaryCard
            label="Aging > 60 days"
            value={dash ? fmtMoney(dash.stats.overdue_aging_total) : "$0"}
            hint="Sum of subledger 61-90 + >90 buckets"
            tone="#dc2626"
          />
          <SecondaryCard
            label="Workspace status"
            value={isLoading ? "Loading…" : dash?.stats.pending_review ? "Action needed" : "Up to date"}
            hint={isLoading ? "" : dash?.stats.pending_review ? `${dash.stats.pending_review} reconciliation(s) need review` : "No open reconciliations require review"}
            tone={dash?.stats.pending_review ? "#1d4ed8" : "var(--green)"}
          />
        </motion.div>

        {/* AI insights panel */}
        <motion.div variants={fadeUp} initial="hidden" animate="visible"
          className="rounded-xl overflow-hidden"
          style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}
        >
          <div className="flex items-center gap-2 px-5 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
            <Sparkles size={14} strokeWidth={1.8} style={{ color: "var(--green)" }} />
            <h2 className="text-sm font-semibold text-theme">AI Insights</h2>
          </div>
          <div className="p-5 space-y-2.5">
            {(dash?.ai_insights ?? []).map((line, i) => (
              <div key={i} className="flex items-start gap-2 text-sm">
                <span className="mt-1.5 h-1.5 w-1.5 rounded-full shrink-0" style={{ background: "var(--green)" }} />
                <span className="text-theme leading-snug">{line}</span>
              </div>
            ))}
            {!dash?.ai_insights?.length && (
              <p className="text-sm" style={{ color: "var(--text-muted)" }}>No insights yet — they appear once reconciliations have data.</p>
            )}
          </div>
        </motion.div>

        {/* Recent table + activity feed */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <motion.div variants={fadeUp} initial="hidden" animate="visible" className="lg:col-span-2">
            <div className="rounded-xl overflow-hidden"
              style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
              <div className="flex items-center gap-2 px-5 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
                <h2 className="text-sm font-semibold text-theme flex-1">Recent reconciliations</h2>
                <button
                  className="text-xs font-medium flex items-center gap-1 transition-opacity hover:opacity-80"
                  style={{ color: "var(--text-2)" }}
                  onClick={() => navigate("/app/reconciliations/ar")}
                >
                  View AR <ArrowRight size={12} strokeWidth={1.8} />
                </button>
              </div>
              {(!dash || dash.recent.length === 0) ? (
                <div className="p-10 text-center">
                  <div className="mx-auto h-12 w-12 rounded-full flex items-center justify-center mb-3"
                    style={{ background: "var(--surface-2)" }}>
                    <Scale size={22} strokeWidth={1.5} style={{ color: "var(--text-muted)" }} />
                  </div>
                  <p className="text-sm font-medium text-theme mb-1">No reconciliations yet</p>
                  <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                    Click <b>New AR</b> or <b>New AP</b> above to pull live data from QuickBooks.
                  </p>
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[11px] font-semibold uppercase tracking-wide"
                      style={{ color: "var(--text-muted)", borderBottom: "1px solid var(--border)" }}>
                      <th className="text-left px-5 py-2.5">Name</th>
                      <th className="text-left px-3 py-2.5">Type</th>
                      <th className="text-right px-3 py-2.5">Difference</th>
                      <th className="text-left px-3 py-2.5">Status</th>
                      <th className="px-5 py-2.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {dash.recent.map((r) => {
                      const tone = STATUS_TONE[r.status]
                      return (
                        <tr key={r.id}
                          className="cursor-pointer transition-colors"
                          style={{ borderBottom: "1px solid var(--border)" }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
                          onMouseLeave={(e) => (e.currentTarget.style.background = "")}
                          onClick={() => gotoRecon(r.id)}
                        >
                          <td className="px-5 py-3">
                            <div className="text-sm font-medium text-theme">{r.name}</div>
                            <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                              {new Date(r.period_end).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                            </div>
                          </td>
                          <td className="px-3 py-3 text-xs" style={{ color: "var(--text-2)" }}>{r.recon_type}</td>
                          <td className="px-3 py-3 text-right tabular-nums text-sm font-medium"
                            style={{ color: Math.abs(parseFloat(r.difference)) > 100 ? "#dc2626" : "var(--text-2)" }}>
                            {fmtMoney(r.difference)}
                          </td>
                          <td className="px-3 py-3">
                            <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold"
                              style={{ background: tone.bg, color: tone.fg }}>
                              <span className="h-1.5 w-1.5 rounded-full" style={{ background: tone.dot }} />
                              {STATUS_LABEL[r.status] ?? r.status}
                            </span>
                          </td>
                          <td className="px-5 py-3 text-right">
                            <ArrowRight size={14} strokeWidth={1.6} style={{ color: "var(--text-muted)" }} />
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </motion.div>

          {/* Activity feed */}
          <motion.div variants={fadeUp} initial="hidden" animate="visible">
            <div className="rounded-xl overflow-hidden h-full"
              style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
              <div className="flex items-center gap-2 px-5 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
                <Activity size={14} strokeWidth={1.8} style={{ color: "var(--text-muted)" }} />
                <h2 className="text-sm font-semibold text-theme">Recent activity</h2>
              </div>
              <div className="px-3 py-2 max-h-[400px] overflow-y-auto">
                {(dash?.activity ?? []).length === 0 ? (
                  <p className="text-xs text-center py-8" style={{ color: "var(--text-muted)" }}>No activity yet.</p>
                ) : (
                  <ul>
                    {dash!.activity.map((a, i) => (
                      <li key={i}
                        className="px-2 py-2 rounded-md cursor-pointer transition-colors"
                        onClick={() => gotoRecon(a.recon_id)}
                        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
                        onMouseLeave={(e) => (e.currentTarget.style.background = "")}
                      >
                        <div className="flex items-start gap-2">
                          <ActivityKindIcon kind={a.kind} />
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-medium text-theme truncate">{a.recon_name}</p>
                            <p className="text-[11px] truncate" style={{ color: "var(--text-muted)" }}>{a.summary}</p>
                            <p className="text-[10px] mt-0.5" style={{ color: "var(--text-muted)" }}>
                              {new Date(a.happened_at).toLocaleString()}
                            </p>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </motion.div>
        </div>
      </div>

      {/* New reconciliation modal */}
      <AnimatePresence>
        {showCreate && (
          <CreateReconModal
            initialType={showCreate}
            onClose={() => setShowCreate(null)}
            onCreated={(id) => {
              setShowCreate(null)
              qc.invalidateQueries({ queryKey: ["recons-dashboard"] })
              navigate(`/app/reconciliations/${id}`)
            }}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

// ── KPI card ─────────────────────────────────────────────────────────────────

interface KpiProps {
  icon:   React.ReactNode
  label:  string
  value:  number
  accent: string
}
function KpiCard({ icon, label, value, accent }: KpiProps) {
  return (
    <motion.div variants={fadeUp}
      className="rounded-xl p-4"
      style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}
    >
      <div className="flex items-start justify-between gap-2">
        <span style={{ color: accent }}>{icon}</span>
      </div>
      <p className="text-[11px] uppercase tracking-wide mt-2" style={{ color: "var(--text-muted)" }}>{label}</p>
      <p className="text-2xl font-bold tabular-nums text-theme mt-1">{value}</p>
    </motion.div>
  )
}

interface SecondaryProps {
  label: string
  value: string
  hint:  string
  tone:  string
}
function SecondaryCard({ label, value, hint, tone }: SecondaryProps) {
  return (
    <motion.div variants={fadeUp}
      className="rounded-xl p-4"
      style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}
    >
      <p className="text-[11px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>{label}</p>
      <p className="text-xl font-bold tabular-nums mt-1" style={{ color: tone }}>{value}</p>
      {hint && <p className="text-[11px] mt-1" style={{ color: "var(--text-muted)" }}>{hint}</p>}
    </motion.div>
  )
}

function ActivityKindIcon({ kind }: { kind: string }) {
  const map: Record<string, { icon: React.ReactNode; color: string }> = {
    created:        { icon: <Plus size={12} />,        color: "var(--text-muted)" },
    synced:         { icon: <RefreshCw size={12} />,   color: "#3b82f6" },
    approved:       { icon: <CheckCircle2 size={12} />,color: "var(--green)" },
    noted:          { icon: <Activity size={12} />,    color: "var(--text-2)" },
    assigned:       { icon: <Activity size={12} />,    color: "#1d4ed8" },
    ai_commentary:  { icon: <Sparkles size={12} />,    color: "var(--green)" },
  }
  const m = map[kind] ?? map.created
  return (
    <span className="h-5 w-5 rounded-full flex items-center justify-center shrink-0"
      style={{ background: "var(--surface-2)", color: m.color }}>
      {m.icon}
    </span>
  )
}

// ── Create modal ─────────────────────────────────────────────────────────────

interface CreateProps {
  initialType: ReconType
  onClose:     () => void
  onCreated:   (id: string) => void
}
function CreateReconModal({ initialType, onClose, onCreated }: CreateProps) {
  const [reconType, setReconType] = useState<ReconType>(initialType)
  const today = new Date().toISOString().slice(0, 10)
  const [periodEnd, setPeriodEnd] = useState<string>(today)
  const defaultName = `${reconType} ${today.slice(0,7)}`
  const [name, setName] = useState<string>(defaultName)
  const [error, setError] = useState<string | null>(null)

  const create = useMutation({
    mutationFn: () => reconsApi.createReconciliation({ name: name.trim() || defaultName, recon_type: reconType, period_end: periodEnd }),
    onSuccess: (r) => onCreated(r.id),
    onError: (e: unknown) => {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setError(detail ?? "Could not create reconciliation. Make sure QuickBooks is connected.")
    },
  })

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{ background: "rgba(0,0,0,0.5)" }}
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 10 }}
        transition={{ duration: 0.22, ease: "easeOut" }}
        className="w-full max-w-md rounded-2xl p-6"
        style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "0 24px 64px rgba(0,0,0,0.35)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 mb-5">
          <div className="h-10 w-10 rounded-lg flex items-center justify-center shrink-0"
            style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
            <Scale size={20} strokeWidth={1.8} />
          </div>
          <div className="flex-1">
            <h2 className="text-base font-semibold text-theme">New reconciliation</h2>
            <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
              Nordavix will pull the matching aging report from QuickBooks and compute differences.
            </p>
          </div>
          <button onClick={onClose} className="h-7 w-7 rounded-md flex items-center justify-center"
            style={{ color: "var(--text-muted)" }}>
            <X size={15} strokeWidth={1.8} />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2 mb-4">
          {(["AR", "AP", "BANK", "CC"] as ReconType[]).map((t) => (
            <button
              key={t}
              onClick={() => { setReconType(t); setName(`${t} ${periodEnd.slice(0,7)}`) }}
              className="px-3 py-2 rounded-lg text-sm font-medium transition-all"
              style={reconType === t
                ? { background: "var(--green)", color: "#fff", borderColor: "var(--green)" }
                : { background: "var(--surface-2)", color: "var(--text-2)", border: "1px solid var(--border)" }}
            >
              {t === "BANK" ? "Bank" : t === "CC" ? "Credit card" : t}
            </button>
          ))}
        </div>

        <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--text-2)" }}>Name</label>
        <input
          value={name} onChange={(e) => setName(e.target.value)}
          className="w-full rounded-lg px-3 py-2 text-sm outline-none mb-3"
          style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }}
        />

        <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--text-2)" }}>Period end</label>
        <input
          type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)}
          className="w-full rounded-lg px-3 py-2 text-sm outline-none"
          style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }}
        />

        {error && <p className="text-xs mt-2" style={{ color: "#dc2626" }}>{error}</p>}

        <button
          onClick={() => create.mutate()}
          disabled={create.isPending}
          className="w-full mt-5 flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          style={{ background: "var(--green)" }}
        >
          {create.isPending ? <Spinner className="h-4 w-4" /> : <Sparkles size={14} strokeWidth={1.8} />}
          {create.isPending ? "Pulling from QuickBooks…" : "Create + sync"}
        </button>
      </motion.div>
    </motion.div>
  )
}
