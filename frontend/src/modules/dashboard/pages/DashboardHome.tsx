/**
 * Post-login dashboard — "Good morning, [Name]." style.
 * Shows close progress, open variances, AI-generated count, and recent flux runs.
 */
import { useUser } from "@clerk/clerk-react"
import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import {
  BarChart3,
  CheckCircle2,
  AlertTriangle,
  Sparkles,
  Clock,
  ArrowRight,
  Upload,
  Zap,
} from "lucide-react"
import { api } from "@/modules/flux/api"
import { Button } from "@/core/ui/components"
import { cn } from "@/core/ui/utils"

function getGreeting(name: string): string {
  const hour = new Date().getHours()
  const first = name.split(" ")[0]
  if (hour < 12) return `Good morning, ${first}.`
  if (hour < 17) return `Good afternoon, ${first}.`
  return `Good evening, ${first}.`
}

function formatDate(): string {
  return new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  })
}

const TB_STATUS_COLORS: Record<string, string> = {
  pending:          "bg-ink-100",
  processing:       "bg-material-light",
  parsed:           "bg-blue-50",
  ready_for_review: "bg-blue-50",
  generating:       "bg-material-light",
  complete:         "bg-green-50",
  error:            "bg-unfav-light",
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

export function DashboardHome() {
  const { user } = useUser()
  const navigate = useNavigate()

  const { data: trialBalances = [], isLoading } = useQuery({
    queryKey: ["trial-balances"],
    queryFn:  () => api.listTrialBalances(),
    staleTime: 30_000,
  })

  const displayName = user?.fullName ?? user?.firstName ?? "there"

  // Derived stats
  const total      = trialBalances.length
  const complete   = trialBalances.filter((tb) => tb.status === "complete").length
  const inReview   = trialBalances.filter((tb) =>
    ["ready_for_review", "parsed"].includes(tb.status)
  ).length
  const generating = trialBalances.filter((tb) =>
    ["generating", "processing"].includes(tb.status)
  ).length

  const progressPct = total > 0 ? Math.round((complete / total) * 100) : 0

  const recentTBs = [...trialBalances].slice(0, 6)

  return (
    <div className="flex flex-col h-full overflow-y-auto bg-ink-50">
      {/* Header */}
      <div className="bg-white border-b border-ink-100 px-8 pt-8 pb-6">
        <p className="text-2xl font-semibold text-ink tracking-tight">
          {getGreeting(displayName)}
        </p>
        <p className="text-sm text-ink-400 mt-1">{formatDate()}</p>
      </div>

      <div className="flex-1 px-8 py-6 space-y-6 max-w-5xl w-full mx-auto">

        {/* Stat Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            icon={<BarChart3 size={22} strokeWidth={1.6} className="text-ink-400" />}
            label="Close Progress"
            value={total > 0 ? `${progressPct}%` : "—"}
            sub={total > 0 ? `${complete} of ${total} complete` : "No runs yet"}
            accent="green"
          />
          <StatCard
            icon={<AlertTriangle size={22} strokeWidth={1.6} className="text-material" />}
            label="In Review"
            value={inReview > 0 ? String(inReview) : "—"}
            sub={inReview === 1 ? "1 run needs review" : `${inReview} runs need review`}
            accent="amber"
          />
          <StatCard
            icon={<Sparkles size={22} strokeWidth={1.6} className="text-green" />}
            label="AI Generating"
            value={generating > 0 ? String(generating) : "—"}
            sub={generating > 0 ? "Narratives in progress" : "All caught up"}
            accent="neutral"
          />
          <StatCard
            icon={<CheckCircle2 size={22} strokeWidth={1.6} className="text-green" />}
            label="Complete"
            value={String(complete)}
            sub={complete === 1 ? "1 run finalized" : `${complete} runs finalized`}
            accent="green"
          />
        </div>

        {/* Progress bar */}
        {total > 0 && (
          <div className="bg-white rounded-lg border border-ink-100 shadow-card p-5">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-medium text-ink">Close Cycle Progress</span>
              <span className="text-sm font-semibold text-ink">{progressPct}%</span>
            </div>
            <div className="h-2 rounded-full bg-ink-100 overflow-hidden">
              <div
                className="h-full rounded-full bg-green transition-all duration-700"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <div className="flex items-center gap-4 mt-3 text-xs text-ink-400">
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-green" />
                {complete} Complete
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-material" />
                {inReview} In review
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-ink-200" />
                {total - complete - inReview} Pending
              </span>
            </div>
          </div>
        )}

        {/* Recent Flux Runs */}
        <div className="bg-white rounded-lg border border-ink-100 shadow-card">
          <div className="flex items-center justify-between px-5 py-4 border-b border-ink-100">
            <h2 className="text-sm font-semibold text-ink">Flux Analysis Runs</h2>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate("/app/flux")}
              className="gap-1"
            >
              View all
              <ArrowRight size={14} strokeWidth={1.6} />
            </Button>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="flex items-center gap-2 text-sm text-ink-400">
                <Clock size={16} strokeWidth={1.6} className="animate-spin" />
                Loading…
              </div>
            </div>
          ) : recentTBs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
              <div className="h-12 w-12 rounded-full bg-ink-50 flex items-center justify-center mb-3">
                <BarChart3 size={22} strokeWidth={1.6} className="text-ink-400" />
              </div>
              <p className="text-sm font-medium text-ink mb-1">No flux runs yet</p>
              <p className="text-xs text-ink-400 max-w-xs leading-relaxed">
                Upload a trial balance or connect QuickBooks to generate your first AI-powered flux commentary.
              </p>
              <div className="flex gap-2 mt-4">
                <Button
                  size="sm"
                  onClick={() => navigate("/app/flux")}
                >
                  Start first run
                </Button>
              </div>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-100 text-xs text-ink-400 font-medium">
                  <th className="text-left px-5 py-2.5">Name</th>
                  <th className="text-left px-3 py-2.5">Period</th>
                  <th className="text-left px-3 py-2.5">Status</th>
                  <th className="text-right px-5 py-2.5"></th>
                </tr>
              </thead>
              <tbody>
                {recentTBs.map((tb, i) => (
                  <tr
                    key={tb.id}
                    className={cn(
                      "hover:bg-ink-50 transition-colors cursor-pointer",
                      i < recentTBs.length - 1 && "border-b border-ink-100"
                    )}
                    onClick={() => navigate(`/app/flux/${tb.id}`)}
                  >
                    <td className="px-5 py-3 font-medium text-ink">{tb.name}</td>
                    <td className="px-3 py-3 text-ink-600 tabular-nums">
                      {new Date(tb.period_current).toLocaleDateString("en-US", {
                        month: "short", year: "numeric"
                      })}
                    </td>
                    <td className="px-3 py-3">
                      <span className={cn(
                        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium",
                        TB_STATUS_COLORS[tb.status] ?? "bg-ink-100",
                        tb.status === "complete" ? "text-green-600" :
                        tb.status === "error" ? "text-unfav" :
                        ["generating", "processing"].includes(tb.status) ? "text-material" :
                        "text-ink-600"
                      )}>
                        <span className={cn(
                          "h-1.5 w-1.5 rounded-full",
                          tb.status === "complete" ? "bg-green" :
                          tb.status === "error" ? "bg-unfav" :
                          ["generating", "processing"].includes(tb.status) ? "bg-material" :
                          "bg-ink-400"
                        )} />
                        {TB_STATUS_LABELS[tb.status] ?? tb.status}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-right">
                      <ArrowRight size={14} strokeWidth={1.6} className="text-ink-400 inline" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Quick Actions */}
        <div className="bg-white rounded-lg border border-ink-100 shadow-card p-5">
          <h2 className="text-sm font-semibold text-ink mb-4">Quick Actions</h2>
          <div className="flex flex-wrap gap-3">
            <Button
              size="default"
              onClick={() => navigate("/app/flux")}
              icon={<Upload size={16} strokeWidth={1.6} />}
            >
              Upload Trial Balance
            </Button>
            <Button
              variant="outline"
              size="default"
              onClick={() => navigate("/app/flux?connect=qbo")}
              icon={<Zap size={16} strokeWidth={1.6} />}
            >
              Connect QuickBooks
            </Button>
          </div>
        </div>

      </div>
    </div>
  )
}

// ── StatCard ──────────────────────────────────────────────────────────────────

interface StatCardProps {
  icon:   React.ReactNode
  label:  string
  value:  string
  sub:    string
  accent: "green" | "amber" | "neutral"
}

function StatCard({ icon, label, value, sub, accent }: StatCardProps) {
  return (
    <div className="bg-white rounded-lg border border-ink-100 shadow-card p-5">
      <div className="flex items-start justify-between mb-3">
        <div className="h-9 w-9 rounded-lg bg-ink-50 flex items-center justify-center">
          {icon}
        </div>
        {accent === "green" && value !== "—" && (
          <span className="text-[10px] font-semibold text-green uppercase tracking-wider">
            On track
          </span>
        )}
      </div>
      <p className="text-2xl font-semibold text-ink tracking-tight tabular-nums">{value}</p>
      <p className="text-xs text-ink-400 mt-1">{sub}</p>
      <p className="text-[11px] font-medium text-ink-600 mt-2 uppercase tracking-wider">{label}</p>
    </div>
  )
}
