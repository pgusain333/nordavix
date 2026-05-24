/**
 * Post-login dashboard — animated, theme-aware.
 * Framer Motion staggered entrance, animated counters, smooth transitions.
 */
import { useEffect, useRef, useState } from "react"
import { useUser, useOrganization, useOrganizationList } from "@clerk/clerk-react"
import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { motion, AnimatePresence } from "framer-motion"
import {
  BarChart3,
  CheckCircle2,
  AlertTriangle,
  Sparkles,
  ArrowRight,
  Upload,
  Zap,
  TrendingUp,
  Building2,
  X,
} from "lucide-react"
import { api } from "@/modules/flux/api"
import { Button } from "@/core/ui/components"
import { cn } from "@/core/ui/utils"

// ── Helpers ────────────────────────────────────────────────────────────────────

function getGreeting(name: string): string {
  const hour = new Date().getHours()
  const first = name.split(" ")[0]
  if (hour < 12) return `Good morning, ${first}.`
  if (hour < 17) return `Good afternoon, ${first}.`
  return `Good evening, ${first}.`
}

function formatDate(): string {
  return new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  })
}

// ── Animated counter hook ──────────────────────────────────────────────────────

function useCountUp(target: number, duration = 800) {
  const [val, setVal] = useState(0)
  const raf = useRef<number>(0)

  useEffect(() => {
    if (target === 0) { setVal(0); return }
    const start = performance.now()
    const tick = (now: number) => {
      const p = Math.min((now - start) / duration, 1)
      const ease = 1 - Math.pow(1 - p, 3)
      setVal(Math.round(target * ease))
      if (p < 1) raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [target, duration])

  return val
}

// ── Animation variants ─────────────────────────────────────────────────────────

const fadeUp = {
  hidden:  { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.45, ease: "easeOut" as const } },
}

const stagger = {
  hidden:  {},
  visible: { transition: { staggerChildren: 0.08, delayChildren: 0.1 } },
}

const TB_STATUS_COLORS: Record<string, { bg: string; dot: string; text: string }> = {
  pending:          { bg: "var(--surface-2)", dot: "var(--border-strong)", text: "var(--text-muted)" },
  processing:       { bg: "#fef3c7",          dot: "#f59e0b",              text: "#92400e" },
  parsed:           { bg: "#dbeafe",          dot: "#3b82f6",              text: "#1d4ed8" },
  ready_for_review: { bg: "#dbeafe",          dot: "#3b82f6",              text: "#1d4ed8" },
  generating:       { bg: "#fef3c7",          dot: "#f59e0b",              text: "#92400e" },
  complete:         { bg: "var(--green-subtle)", dot: "var(--green)", text: "var(--green)" },
  error:            { bg: "#fee2e2",          dot: "#dc2626",              text: "#b91c1c" },
}

const TB_STATUS_LABELS: Record<string, string> = {
  pending:          "Pending upload",
  processing:       "Processing…",
  parsed:           "Ready to review",
  ready_for_review: "In review",
  generating:       "AI generating…",
  complete:         "Complete",
  error:            "Error",
}

// ── Main component ─────────────────────────────────────────────────────────────

export function DashboardHome() {
  const { user } = useUser()
  const { organization } = useOrganization()
  const navigate  = useNavigate()

  // Solo users (no Clerk org) see a persistent "create workspace" CTA on dashboard,
  // even after they dismissed WorkspaceGate. Dismissible per session.
  const [orgBannerDismissed, setOrgBannerDismissed] = useState(
    () => sessionStorage.getItem("org_banner_dismissed") === "1"
  )
  const [showOrgModal, setShowOrgModal] = useState(false)
  const showOrgBanner = !organization && !orgBannerDismissed

  function dismissOrgBanner() {
    sessionStorage.setItem("org_banner_dismissed", "1")
    setOrgBannerDismissed(true)
  }

  const { data: trialBalances = [], isLoading } = useQuery({
    queryKey: ["trial-balances"],
    queryFn:  api.listTrialBalances,
    staleTime: 30_000,
  })

  const displayName = user?.fullName ?? user?.firstName ?? "there"
  const total      = trialBalances.length
  const complete   = trialBalances.filter(tb => tb.status === "complete").length
  const inReview   = trialBalances.filter(tb => ["ready_for_review","parsed"].includes(tb.status)).length
  const generating = trialBalances.filter(tb => ["generating","processing"].includes(tb.status)).length
  const progressPct = total > 0 ? Math.round((complete / total) * 100) : 0

  const recentTBs = [...trialBalances].slice(0, 6)

  return (
    <div className="flex flex-col h-full overflow-y-auto" style={{ background: "var(--bg)" }}>

      {/* ── Hero header ─────────────────────────────────────────────────────── */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
        className="relative overflow-hidden px-4 sm:px-8 pt-6 sm:pt-8 pb-4 sm:pb-6"
        style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}
      >
        {/* Subtle gradient orb */}
        <div className="pointer-events-none absolute -top-16 -right-16 h-48 w-48 rounded-full opacity-[0.06]"
          style={{ background: "radial-gradient(circle, var(--green) 0%, transparent 70%)" }} />

        <div className="flex flex-col gap-2">
          <div className="flex items-start justify-between gap-2">
            <h1 className="text-lg sm:text-2xl font-bold tracking-tight text-theme leading-tight" style={{ wordBreak: "break-word" }}>
              {getGreeting(displayName)}
            </h1>
            {total > 0 && (
              <motion.div
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.3, duration: 0.4 }}
                className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold shrink-0"
                style={{ background: "var(--green-subtle)", color: "var(--green)" }}
              >
                <TrendingUp size={11} strokeWidth={2} />
                <span className="hidden sm:inline">Close cycle active</span>
                <span className="sm:hidden">Active</span>
              </motion.div>
            )}
          </div>
          <p className="text-xs sm:text-sm" style={{ color: "var(--text-muted)" }}>{formatDate()}</p>
        </div>
      </motion.div>

      <div className="flex-1 px-4 sm:px-8 py-6 max-w-5xl w-full mx-auto space-y-5">

        {/* ── Create-workspace CTA (solo users only) ───────────────────────── */}
        <AnimatePresence>
          {showOrgBanner && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.3 }}
              className="rounded-xl p-4 sm:p-5 flex items-start gap-3"
              style={{
                background: "var(--green-subtle)",
                border: "1px solid var(--green)",
              }}
            >
              <div className="h-9 w-9 rounded-lg flex items-center justify-center shrink-0"
                style={{ background: "var(--green)", color: "#fff" }}>
                <Building2 size={18} strokeWidth={1.8} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-theme">Set up your workspace</p>
                <p className="text-xs mt-0.5" style={{ color: "var(--text-2)" }}>
                  Create a named workspace for your firm — invite teammates, share analyses, and keep client work organized.
                </p>
                <div className="flex items-center gap-2 mt-3">
                  <button
                    onClick={() => setShowOrgModal(true)}
                    className="rounded-lg px-3 py-1.5 text-xs font-semibold text-white inline-flex items-center gap-1.5 transition-opacity hover:opacity-90"
                    style={{ background: "var(--green)" }}
                  >
                    Create workspace
                    <ArrowRight size={12} strokeWidth={2} />
                  </button>
                  <button
                    onClick={dismissOrgBanner}
                    className="text-xs font-medium px-2 py-1.5 transition-colors"
                    style={{ color: "var(--text-muted)" }}
                  >
                    Maybe later
                  </button>
                </div>
              </div>
              <button
                onClick={dismissOrgBanner}
                className="shrink-0 h-7 w-7 rounded-md flex items-center justify-center transition-colors"
                style={{ color: "var(--text-muted)" }}
                aria-label="Dismiss"
              >
                <X size={14} strokeWidth={1.8} />
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Stat cards ──────────────────────────────────────────────────────── */}
        <motion.div
          variants={stagger}
          initial="hidden"
          animate="visible"
          className="grid grid-cols-2 lg:grid-cols-4 gap-4"
        >
          <StatCard
            icon={<BarChart3 size={20} strokeWidth={1.6} />}
            iconColor="var(--text-muted)"
            label="Progress"
            value={total > 0 ? progressPct : null}
            suffix="%"
            sub={total > 0 ? `${complete} of ${total} complete` : "No runs yet"}
            accentColor="var(--green)"
          />
          <StatCard
            icon={<AlertTriangle size={20} strokeWidth={1.6} />}
            iconColor="#f59e0b"
            label="In Review"
            value={inReview || null}
            sub={inReview === 1 ? "1 run needs review" : inReview > 1 ? `${inReview} runs need review` : "Nothing pending"}
            accentColor="#f59e0b"
          />
          <StatCard
            icon={<Sparkles size={20} strokeWidth={1.6} />}
            iconColor="var(--green)"
            label="AI Running"
            value={generating || null}
            sub={generating > 0 ? "Narratives in progress" : "All caught up"}
            accentColor="var(--green)"
            pulse={generating > 0}
          />
          <StatCard
            icon={<CheckCircle2 size={20} strokeWidth={1.6} />}
            iconColor="var(--green)"
            label="Complete"
            value={complete || null}
            sub={complete === 1 ? "1 run finalized" : complete > 1 ? `${complete} finalized` : "None yet"}
            accentColor="var(--green)"
          />
        </motion.div>

        {/* ── Progress bar ────────────────────────────────────────────────────── */}
        {total > 0 && (
          <motion.div
            variants={fadeUp}
            initial="hidden"
            animate="visible"
            transition={{ delay: 0.35 }}
            className="rounded-xl p-5"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-semibold text-theme">Close Cycle Progress</span>
              <span className="text-sm font-bold tabular-nums" style={{ color: "var(--green)" }}>
                {progressPct}%
              </span>
            </div>
            <div className="h-2 rounded-full overflow-hidden" style={{ background: "var(--border)" }}>
              <motion.div
                className="h-full rounded-full"
                style={{ background: "var(--green)" }}
                initial={{ width: 0 }}
                animate={{ width: `${progressPct}%` }}
                transition={{ delay: 0.5, duration: 0.9, ease: [0.25, 0.46, 0.45, 0.94] }}
              />
            </div>
            <div className="flex items-center gap-5 mt-3">
              {[
                { color: "var(--green)", label: `${complete} Complete` },
                { color: "#f59e0b",      label: `${inReview} In review` },
                { color: "var(--border-strong)", label: `${total - complete - inReview} Pending` },
              ].map(({ color, label }) => (
                <span key={label} className="flex items-center gap-1.5 text-xs" style={{ color: "var(--text-muted)" }}>
                  <span className="h-2 w-2 rounded-full" style={{ background: color }} />
                  {label}
                </span>
              ))}
            </div>
          </motion.div>
        )}

        {/* ── Recent Flux Runs ─────────────────────────────────────────────────── */}
        <motion.div
          variants={fadeUp}
          initial="hidden"
          animate="visible"
          transition={{ delay: 0.45 }}
          className="rounded-xl overflow-hidden"
          style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}
        >
          <div className="flex items-center justify-between px-5 py-4"
            style={{ borderBottom: "1px solid var(--border)" }}>
            <h2 className="text-sm font-semibold text-theme">Flux Analysis Runs</h2>
            <Button variant="ghost" size="sm" onClick={() => navigate("/app/flux")}
              className="gap-1 text-xs">
              View all <ArrowRight size={13} strokeWidth={1.6} />
            </Button>
          </div>

          {isLoading ? (
            <div className="flex flex-col gap-2 p-5">
              {[1,2,3].map(i => (
                <div key={i} className="h-10 rounded-lg animate-pulse" style={{ background: "var(--surface-2)" }} />
              ))}
            </div>
          ) : recentTBs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-14 px-6 text-center">
              <div className="h-12 w-12 rounded-2xl flex items-center justify-center mb-4"
                style={{ background: "var(--surface-2)" }}>
                <BarChart3 size={22} strokeWidth={1.6} style={{ color: "var(--text-muted)" }} />
              </div>
              <p className="text-sm font-semibold text-theme mb-1">No flux runs yet</p>
              <p className="text-xs leading-relaxed max-w-xs" style={{ color: "var(--text-muted)" }}>
                Upload a trial balance or connect QuickBooks to generate AI-powered variance commentary.
              </p>
              <Button size="sm" className="mt-5" onClick={() => navigate("/app/flux")}>
                Start first run
              </Button>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs font-medium" style={{ borderBottom: "1px solid var(--border)", color: "var(--text-muted)" }}>
                  <th className="text-left px-5 py-2.5">Name</th>
                  <th className="text-left px-3 py-2.5">Period</th>
                  <th className="text-left px-3 py-2.5">Status</th>
                  <th className="px-5 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {recentTBs.map((tb, i) => {
                  const s = TB_STATUS_COLORS[tb.status] ?? TB_STATUS_COLORS.pending
                  return (
                    <motion.tr
                      key={tb.id}
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 0.5 + i * 0.06, duration: 0.3 }}
                      className={cn("cursor-pointer transition-colors")}
                      style={i < recentTBs.length - 1 ? { borderBottom: "1px solid var(--border)" } : {}}
                      onClick={() => navigate(`/app/flux/${tb.id}`)}
                      onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-2)")}
                      onMouseLeave={e => (e.currentTarget.style.background = "")}
                    >
                      <td className="px-5 py-3 font-medium text-theme">{tb.name}</td>
                      <td className="px-3 py-3 tabular-nums text-xs" style={{ color: "var(--text-2)" }}>
                        {new Date(tb.period_current).toLocaleDateString("en-US", { month: "short", year: "numeric" })}
                      </td>
                      <td className="px-3 py-3">
                        <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold"
                          style={{ background: s.bg, color: s.text }}>
                          <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.dot }} />
                          {TB_STATUS_LABELS[tb.status] ?? tb.status}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-right">
                        <ArrowRight size={14} strokeWidth={1.6} style={{ color: "var(--text-muted)", display: "inline" }} />
                      </td>
                    </motion.tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </motion.div>

        {/* ── Quick Actions ────────────────────────────────────────────────────── */}
        <motion.div
          variants={fadeUp}
          initial="hidden"
          animate="visible"
          transition={{ delay: 0.55 }}
          className="rounded-xl p-5"
          style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}
        >
          <h2 className="text-sm font-semibold text-theme mb-4">Quick Actions</h2>
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => navigate("/app/flux")} icon={<Upload size={15} strokeWidth={1.6} />}>
              Upload Trial Balance
            </Button>
            <Button variant="outline" onClick={() => navigate("/app/flux?connect=qbo")}
              icon={<Zap size={15} strokeWidth={1.6} />}>
              Connect QuickBooks
            </Button>
          </div>
        </motion.div>

      </div>

      {/* ── Create-workspace modal (rendered at root so it overlays cleanly) ── */}
      <AnimatePresence>
        {showOrgModal && (
          <CreateOrgModal
            onClose={() => setShowOrgModal(false)}
            onCreated={() => {
              setShowOrgModal(false)
              dismissOrgBanner()
            }}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

// ── CreateOrgModal ────────────────────────────────────────────────────────────

interface CreateOrgModalProps {
  onClose: () => void
  onCreated: () => void
}

function CreateOrgModal({ onClose, onCreated }: CreateOrgModalProps) {
  const { createOrganization, isLoaded } = useOrganizationList()
  const [name, setName] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !createOrganization || !isLoaded) return
    setError(null)
    setSubmitting(true)
    try {
      await createOrganization({ name: name.trim() })
      onCreated()
    } catch {
      setError("Could not create workspace. Try a different name?")
      setSubmitting(false)
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{ background: "rgba(0,0,0,0.5)" }}
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 10 }}
        transition={{ duration: 0.22, ease: "easeOut" }}
        className="w-full max-w-md rounded-2xl p-6"
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          boxShadow: "0 24px 64px rgba(0,0,0,0.35)",
        }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 mb-5">
          <div className="h-10 w-10 rounded-lg flex items-center justify-center shrink-0"
            style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
            <Building2 size={20} strokeWidth={1.8} />
          </div>
          <div className="flex-1">
            <h2 className="text-base font-semibold text-theme">Create your workspace</h2>
            <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
              Name your firm or team. You can rename it later.
            </p>
          </div>
          <button
            onClick={onClose}
            className="h-7 w-7 rounded-md flex items-center justify-center transition-colors"
            style={{ color: "var(--text-muted)" }}
          >
            <X size={15} strokeWidth={1.8} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--text-2)" }}>
            Workspace name
          </label>
          <input
            type="text"
            autoFocus
            placeholder="e.g. Acme Accounting, Smith CPA"
            value={name}
            onChange={e => setName(e.target.value)}
            disabled={submitting}
            className="w-full rounded-lg px-3 py-2.5 text-sm outline-none transition-all"
            style={{
              background: "var(--surface-2)",
              border: "1px solid var(--border-strong)",
              color: "var(--text)",
            }}
            onFocus={e => (e.currentTarget.style.borderColor = "var(--green)")}
            onBlur={e => (e.currentTarget.style.borderColor = "var(--border-strong)")}
          />
          {error && (
            <p className="text-xs mt-2" style={{ color: "#dc2626" }}>{error}</p>
          )}
          <button
            type="submit"
            disabled={!name.trim() || submitting || !isLoaded}
            className="mt-4 w-full flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            style={{ background: "var(--green)" }}
          >
            {submitting ? "Creating…" : (
              <>
                Create workspace
                <ArrowRight size={14} strokeWidth={1.8} />
              </>
            )}
          </button>
        </form>
      </motion.div>
    </motion.div>
  )
}

// ── StatCard ──────────────────────────────────────────────────────────────────

interface StatCardProps {
  icon:        React.ReactNode
  iconColor:   string
  label:       string
  value:       number | null
  suffix?:     string
  sub:         string
  accentColor: string
  pulse?:      boolean
}

function StatCard({ icon, iconColor, label, value, suffix = "", sub, accentColor, pulse }: StatCardProps) {
  const counted = useCountUp(value ?? 0, 900)

  return (
    <motion.div
      variants={fadeUp}
      whileHover={{ y: -2, transition: { duration: 0.2 } }}
      className="rounded-xl p-5 cursor-default"
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        boxShadow: "var(--card-shadow)",
        transitionProperty: "box-shadow",
        transitionDuration: "0.2s",
      }}
      onMouseEnter={e => ((e.currentTarget as HTMLDivElement).style.boxShadow = "var(--card-shadow-hover)")}
      onMouseLeave={e => ((e.currentTarget as HTMLDivElement).style.boxShadow = "var(--card-shadow)")}
    >
      <div className="flex items-start justify-between mb-3">
        <div className="h-9 w-9 rounded-xl flex items-center justify-center"
          style={{ background: "var(--surface-2)", color: iconColor }}>
          {pulse ? (
            <span className="relative flex h-9 w-9 items-center justify-center">
              <span className="absolute inline-flex h-full w-full rounded-full opacity-30 animate-ping"
                style={{ background: accentColor }} />
              <span className="relative" style={{ color: iconColor }}>{icon}</span>
            </span>
          ) : icon}
        </div>
      </div>

      <div className="text-2xl font-bold tracking-tight tabular-nums text-theme">
        {value === null ? (
          <span style={{ color: "var(--border-strong)" }}>—</span>
        ) : (
          <>{counted}{suffix}</>
        )}
      </div>
      <p className="text-[11px] mt-1 leading-snug" style={{ color: "var(--text-muted)" }}>{sub}</p>
      <p className="text-[10px] font-semibold uppercase tracking-wider mt-2.5" style={{ color: "var(--text-muted)" }}>
        {label}
      </p>
    </motion.div>
  )
}
