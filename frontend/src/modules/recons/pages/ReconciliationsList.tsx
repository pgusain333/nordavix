/**
 * Per-type list view used by both AR and AP pages.
 *
 * Header row: search, sort, filter buttons.
 * Body: nested per-reconciliation card that expands into a per-customer/vendor table.
 */
import { useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { motion, AnimatePresence } from "framer-motion"
import { formatDate } from "@/core/lib/dates"
import {
  Search,
  ArrowRight,
  Sparkles,
  ChevronDown,
  ChevronUp,
  AlertCircle,
  RefreshCw,
  Plus,
  CheckCircle2,
  Filter,
} from "lucide-react"
import { Button, Spinner } from "@/core/ui/components"
import { humanize } from "@/core/ui/utils"
import { reconsApi, type ReconType, type Reconciliation, type ReconciliationItem, type RiskLevel } from "@/modules/recons/api"
import { useQboConnection } from "@/modules/flux/hooks"

interface Props {
  title:    string
  subtitle: string
  type:     ReconType
}

const fmtMoney = (s: string | number) => {
  const n = typeof s === "string" ? parseFloat(s) : s
  return `$${(Number.isFinite(n) ? n : 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
}

const RISK_TONE: Record<RiskLevel, { bg: string; fg: string }> = {
  low:    { bg: "var(--green-subtle)", fg: "var(--green)" },
  medium: { bg: "#fef3c7",             fg: "#92400e" },
  high:   { bg: "#fee2e2",             fg: "#b91c1c" },
}

export function ReconciliationsList({ title, subtitle, type }: Props) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [expanded, setExpanded] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [riskFilter, setRiskFilter] = useState<"all" | RiskLevel>("all")

  const { data: recons = [], isLoading } = useQuery({
    queryKey: ["recons-list", type],
    queryFn:  () => reconsApi.listReconciliations(type),
    refetchInterval: (q) => {
      const list = q.state.data
      if (!list) return false
      return list.some(r => r.status === "syncing" || r.status === "computing") ? 5_000 : false
    },
  })

  const { data: qbo } = useQboConnection()

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return recons.filter(r => !q || r.name.toLowerCase().includes(q))
  }, [recons, search])

  return (
    <div className="flex flex-col h-full overflow-y-auto" style={{ background: "var(--bg)" }}>
      {/* Header */}
      <div className="px-4 sm:px-8 pt-6 pb-4"
        style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-lg sm:text-2xl font-bold text-theme">{title}</h1>
            <p className="text-xs sm:text-sm mt-1" style={{ color: "var(--text-muted)" }}>{subtitle}</p>
          </div>
          <NewReconButton type={type} qboConnected={!!qbo} />
        </div>

        <div className="mt-4 flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[180px] max-w-xs">
            <Search size={14} strokeWidth={1.8} className="absolute left-2.5 top-1/2 -translate-y-1/2"
              style={{ color: "var(--text-muted)" }} />
            <input
              value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Search reconciliations…"
              className="w-full rounded-lg pl-8 pr-3 py-1.5 text-sm outline-none"
              style={{ background: "var(--surface-2)", border: "1px solid var(--border)", color: "var(--text)" }}
            />
          </div>

          <div className="flex items-center gap-1 rounded-lg p-0.5"
            style={{ background: "var(--surface-2)" }}>
            <Filter size={12} strokeWidth={1.8} className="mx-2" style={{ color: "var(--text-muted)" }} />
            {(["all", "high", "medium", "low"] as const).map(f => (
              <button
                key={f}
                className="px-2.5 py-1 rounded-md text-xs font-medium transition-colors"
                style={riskFilter === f
                  ? { background: "var(--surface)", color: "var(--text)", boxShadow: "var(--card-shadow)" }
                  : { color: "var(--text-muted)" }}
                onClick={() => setRiskFilter(f)}
              >
                {f === "all" ? "All risk" : `${f.charAt(0).toUpperCase()}${f.slice(1)}`}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex-1 px-4 sm:px-8 py-6 max-w-7xl w-full mx-auto space-y-4">
        {!qbo && (
          <div className="rounded-xl p-4 flex items-start gap-3"
            style={{ background: "#fef3c7", border: "1px solid #f59e0b" }}>
            <AlertCircle size={18} style={{ color: "#92400e" }} className="shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-semibold" style={{ color: "#92400e" }}>QuickBooks isn't connected</p>
              <p className="text-xs mt-0.5" style={{ color: "#92400e" }}>
                Connect QuickBooks to start a {type} reconciliation. Customer/vendor balances, aging, and transactions all flow from QBO.
              </p>
            </div>
            <Button size="sm" onClick={() => navigate("/app/flux?connect=qbo")}>Connect</Button>
          </div>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Spinner className="h-6 w-6" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-xl p-12 text-center"
            style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
            <p className="text-sm font-medium text-theme mb-1">
              {search ? "No reconciliations match your search." : `No ${type} reconciliations yet.`}
            </p>
            {!search && qbo && (
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                Start one above to pull live data from QuickBooks.
              </p>
            )}
          </div>
        ) : (
          filtered.map((r) => (
            <ReconCard
              key={r.id}
              recon={r}
              expanded={expanded === r.id}
              onToggle={() => setExpanded((p) => p === r.id ? null : r.id)}
              onSync={() => qc.invalidateQueries({ queryKey: ["recons-list", type] })}
              riskFilter={riskFilter}
              navigate={navigate}
            />
          ))
        )}
      </div>
    </div>
  )
}

// ── New reconciliation button + modal (delegated to dashboard component) ─────

function NewReconButton({ type, qboConnected }: { type: ReconType; qboConnected: boolean }) {
  const navigate = useNavigate()
  return (
    <Button
      icon={<Plus size={14} strokeWidth={1.8} />}
      size="sm"
      disabled={!qboConnected}
      onClick={() => navigate(`/app/reconciliations?new=${type}`)}
      title={qboConnected ? `Start a new ${type} reconciliation` : "Connect QuickBooks first"}
    >
      New {type}
    </Button>
  )
}

// ── Card: collapsed reconciliation header + expandable item table ────────────

interface CardProps {
  recon:       Reconciliation
  expanded:    boolean
  onToggle:    () => void
  onSync:      () => void
  riskFilter:  "all" | RiskLevel
  navigate:    (path: string) => void
}

function ReconCard({ recon, expanded, onToggle, onSync, riskFilter, navigate }: CardProps) {
  // Detail only fetched when expanded
  const { data: detail, isLoading } = useQuery({
    queryKey: ["recon-detail", recon.id],
    queryFn:  () => reconsApi.getReconciliation(recon.id),
    enabled:  expanded,
    refetchInterval: expanded && (recon.status === "syncing" || recon.status === "computing") ? 5_000 : false,
  })

  const resync = useMutation({
    mutationFn: () => reconsApi.resyncReconciliation(recon.id),
    onSuccess: () => onSync(),
  })

  const items = useMemo(() => {
    if (!detail) return [] as ReconciliationItem[]
    if (riskFilter === "all") return detail.items
    return detail.items.filter(i => i.risk_level === riskFilter)
  }, [detail, riskFilter])

  return (
    <motion.div
      layout
      className="rounded-xl overflow-hidden"
      style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}
    >
      {/* Header row */}
      <button onClick={onToggle}
        className="w-full px-5 py-3 flex items-center gap-3 text-left"
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "")}
      >
        <span className="h-2 w-2 rounded-full shrink-0"
          style={{ background:
            recon.status === "approved"  ? "var(--green)" :
            recon.status === "error"     ? "#dc2626" :
            recon.status === "in_review" ? "#3b82f6" :
            "#f59e0b"
          }}
        />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-theme truncate">{recon.name}</p>
          <p className="text-[11px] mt-0.5" style={{ color: "var(--text-muted)" }}>
            Period {formatDate(recon.period_end)} · {humanize(recon.status, { in_review: "In review" })}
          </p>
        </div>
        <div className="hidden sm:flex items-center gap-4 text-right">
          <Stat label="GL"        v={recon.gl_total} />
          <Stat label="Subledger" v={recon.subledger_total} />
          <Stat label="Diff" v={recon.difference} tone={Math.abs(parseFloat(recon.difference)) > 100 ? "#dc2626" : undefined} />
        </div>
        {expanded ? <ChevronUp size={14} strokeWidth={1.8} /> : <ChevronDown size={14} strokeWidth={1.8} />}
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            style={{ borderTop: "1px solid var(--border)" }}
          >
            {recon.ai_summary && (
              <div className="px-5 py-3 flex items-start gap-2"
                style={{ background: "var(--surface-2)", borderBottom: "1px solid var(--border)" }}>
                <Sparkles size={14} strokeWidth={1.8} style={{ color: "var(--green)" }} className="shrink-0 mt-0.5" />
                <p className="text-sm text-theme leading-snug">{recon.ai_summary}</p>
              </div>
            )}

            <div className="px-5 py-2 flex items-center gap-2 flex-wrap"
              style={{ borderBottom: "1px solid var(--border)" }}>
              <Button
                size="sm" variant="outline"
                icon={<RefreshCw size={12} strokeWidth={1.8} />}
                onClick={() => resync.mutate()}
                loading={resync.isPending}
              >
                Re-sync
              </Button>
              <Button
                size="sm" variant="outline"
                icon={<ArrowRight size={12} strokeWidth={1.8} />}
                onClick={() => navigate(`/app/reconciliations/${recon.id}`)}
              >
                Open detail
              </Button>
            </div>

            {isLoading ? (
              <div className="flex items-center justify-center py-10">
                <Spinner className="h-5 w-5" />
              </div>
            ) : items.length === 0 ? (
              <p className="text-sm text-center py-10" style={{ color: "var(--text-muted)" }}>
                {detail && detail.items.length > 0
                  ? "No rows match this risk filter."
                  : "No items synced yet. Re-sync if QuickBooks just finished."}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead style={{ background: "var(--surface-2)" }}>
                    <tr className="text-[11px] font-semibold uppercase tracking-wide"
                      style={{ color: "var(--text-muted)" }}>
                      <th className="text-left px-5 py-2.5">{
                        recon.recon_type === "AP" ? "Vendor" :
                        recon.recon_type === "AR" ? "Customer" :
                        "Account"
                      }</th>
                      <th className="text-right px-3 py-2.5">GL</th>
                      <th className="text-right px-3 py-2.5">Subledger</th>
                      <th className="text-right px-3 py-2.5">Difference</th>
                      <th className="text-right px-3 py-2.5">Aging</th>
                      <th className="text-left px-3 py-2.5">Risk</th>
                      <th className="text-left px-3 py-2.5">Status</th>
                      <th className="text-left px-5 py-2.5">AI Commentary</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it) => {
                      const tone = RISK_TONE[it.risk_level]
                      const totalAging =
                        parseFloat(it.aging_61_90) + parseFloat(it.aging_over_90)
                      return (
                        <tr key={it.id}
                          className="cursor-pointer transition-colors"
                          style={{ borderBottom: "1px solid var(--border)" }}
                          onClick={() => navigate(`/app/reconciliations/${recon.id}?item=${it.id}`)}
                          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
                          onMouseLeave={(e) => (e.currentTarget.style.background = "")}
                        >
                          <td className="px-5 py-2.5">
                            <div className="text-sm font-medium text-theme truncate max-w-[200px]" title={it.entity_name}>
                              {it.entity_name}
                            </div>
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{fmtMoney(it.gl_balance)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{fmtMoney(it.subledger_balance)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums font-medium"
                            style={{ color: Math.abs(parseFloat(it.difference)) > 100 ? "#dc2626" : "var(--text-2)" }}>
                            {fmtMoney(it.difference)}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-xs"
                            style={{ color: totalAging > 0 ? "#dc2626" : "var(--text-muted)" }}>
                            {totalAging > 0 ? fmtMoney(totalAging) : "—"}
                          </td>
                          <td className="px-3 py-2.5">
                            <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase"
                              style={{ background: tone.bg, color: tone.fg }}>
                              {it.risk_level}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-xs capitalize"
                            style={{ color: it.status === "approved" ? "var(--green)" : "var(--text-muted)" }}>
                            {it.status === "approved" && <CheckCircle2 size={12} className="inline mr-1" />}
                            {it.status}
                          </td>
                          <td className="px-5 py-2.5 max-w-[280px]">
                            <p className="text-xs truncate" style={{ color: "var(--text-2)" }} title={it.ai_commentary ?? ""}>
                              {it.ai_commentary ?? <span style={{ color: "var(--text-muted)" }}>—</span>}
                            </p>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

function Stat({ label, v, tone }: { label: string; v: string; tone?: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>{label}</p>
      <p className="text-sm font-medium tabular-nums" style={{ color: tone ?? "var(--text)" }}>{fmtMoney(v)}</p>
    </div>
  )
}
