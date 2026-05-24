/**
 * Connections — single place to set up data sources for the workspace.
 *
 *   - QuickBooks OAuth (connect / show connected company / disconnect)
 *   - Manual Trial Balance upload (embeds the existing UploadFlow wizard)
 *
 * Once a TB is created here, the user is navigated to the Flux Analysis
 * page to view results. Reconciliations on the other hand pull data
 * directly from QBO (no manual upload needed).
 */
import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { motion, AnimatePresence } from "framer-motion"
import {
  Zap,
  Upload,
  Building2,
  CheckCircle2,
  ArrowRight,
  Plug,
  Plus,
  AlertCircle,
  ChevronUp,
  Sparkles,
  BarChart3,
} from "lucide-react"
import { api, type TrialBalance } from "@/modules/flux/api"
import { UploadFlow } from "@/modules/flux/components/UploadFlow"
import { Button, Spinner } from "@/core/ui/components"

export function ConnectionsPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [uploadOpen, setUploadOpen] = useState(false)
  const [qboFluxOpen, setQboFluxOpen] = useState(false)
  const [qboError, setQboError] = useState<string | null>(null)
  const [qboLoading, setQboLoading] = useState(false)

  // QBO connection status
  const { data: qbo, isLoading: qboLoadingQuery } = useQuery({
    queryKey: ["qbo-connection"],
    queryFn:  api.getQboConnection,
    staleTime: 60_000,
  })

  async function connectQbo() {
    setQboError(null)
    setQboLoading(true)
    try {
      const url = await api.getQboConnectUrl()
      window.location.href = url
    } catch (e: unknown) {
      const ex = e as { response?: { status?: number; data?: { detail?: string } }; message?: string }
      const detail = ex.response?.data?.detail ?? ex.message ?? "Unknown error"
      setQboError(`Could not reach QuickBooks: ${detail}`)
      setQboLoading(false)
    }
  }

  function handleTbComplete(tb: TrialBalance) {
    qc.invalidateQueries({ queryKey: ["trial-balances"] })
    navigate(`/app/flux/${tb.id}`)
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto" style={{ background: "var(--bg)" }}>
      {/* Header */}
      <div
        className="px-4 sm:px-8 pt-6 sm:pt-8 pb-4 sm:pb-6"
        style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}
      >
        <h1
          style={{
            fontSize: "clamp(22px, 5.5vw, 28px)",
            fontWeight: 700,
            lineHeight: 1.2,
            letterSpacing: "-0.01em",
            color: "var(--text)",
            margin: 0,
          }}
        >
          Connections
        </h1>
        <p className="text-xs sm:text-sm mt-2" style={{ color: "var(--text-muted)" }}>
          Connect QuickBooks for automated reconciliations + variance analysis, or upload a trial balance file manually.
        </p>
      </div>

      <div className="flex-1 px-4 sm:px-8 py-6 max-w-5xl w-full mx-auto space-y-5">

        {/* ── QuickBooks card ──────────────────────────────────────────────── */}
        <motion.div
          initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, ease: "easeOut" }}
          className="rounded-xl overflow-hidden"
          style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}
        >
          <div className="p-5 flex items-start gap-4">
            <div className="h-11 w-11 rounded-lg flex items-center justify-center shrink-0"
              style={{ background: "#deebff", color: "#2c5282" }}>
              <Zap size={22} strokeWidth={1.8} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-base font-semibold text-theme">QuickBooks Online</h2>
                {qboLoadingQuery ? (
                  <Spinner className="h-3 w-3" />
                ) : qbo ? (
                  <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold"
                    style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
                    <CheckCircle2 size={10} strokeWidth={2.2} />
                    Connected
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
                    style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}>
                    Not connected
                  </span>
                )}
              </div>

              {qbo ? (
                <div className="mt-2 space-y-0.5">
                  <p className="text-xs flex items-center gap-1.5" style={{ color: "var(--text-2)" }}>
                    <Building2 size={11} strokeWidth={1.8} />
                    {qbo.company}
                  </p>
                  <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                    Realm {qbo.realm_id} · connected {new Date(qbo.connected_at).toLocaleDateString()}
                  </p>
                </div>
              ) : (
                <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
                  Connect QuickBooks Online to pull trial balances, AR / AP aging, and customer + vendor data on demand.
                </p>
              )}

              {qboError && (
                <p className="text-[11px] mt-2 flex items-start gap-1.5" style={{ color: "#dc2626" }}>
                  <AlertCircle size={11} strokeWidth={1.8} className="mt-0.5 shrink-0" />
                  {qboError}
                </p>
              )}
            </div>

            <div className="shrink-0 flex items-center gap-2">
              {qbo ? (
                <Button
                  size="sm"
                  variant="outline"
                  icon={<Plug size={12} strokeWidth={1.8} />}
                  onClick={connectQbo}
                  loading={qboLoading}
                  title="Re-authorize the QBO connection"
                >
                  Reconnect
                </Button>
              ) : (
                <Button
                  size="sm"
                  icon={<Zap size={12} strokeWidth={1.8} />}
                  onClick={connectQbo}
                  loading={qboLoading}
                >
                  Connect QuickBooks
                </Button>
              )}
            </div>
          </div>

          {qbo && (
            <div className="px-5 py-3 flex items-center gap-2 flex-wrap"
              style={{ borderTop: "1px solid var(--border)", background: "var(--surface-2)" }}>
              <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                Now you can:
              </span>
              <button
                onClick={() => navigate("/app/reconciliations")}
                className="text-[11px] font-medium inline-flex items-center gap-1 transition-opacity hover:opacity-80"
                style={{ color: "var(--green)" }}
              >
                Start a reconciliation
                <ArrowRight size={11} strokeWidth={1.8} />
              </button>
            </div>
          )}
        </motion.div>

        {/* ── Run Flux Analysis from QBO (only when QBO is connected) ──────── */}
        {qbo && (
          <motion.div
            initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, delay: 0.03, ease: "easeOut" }}
            className="rounded-xl overflow-hidden"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}
          >
            <button
              onClick={() => setQboFluxOpen(o => !o)}
              className="w-full p-5 flex items-start gap-4 text-left transition-colors"
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--surface-2)" }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "" }}
            >
              <div className="h-11 w-11 rounded-lg flex items-center justify-center shrink-0"
                style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
                <BarChart3 size={22} strokeWidth={1.8} />
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="text-base font-semibold text-theme">Run Flux Analysis from QuickBooks</h2>
                <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
                  Pull both periods from your QBO TrialBalance report directly. No upload needed.
                </p>
              </div>
              <div className="shrink-0 flex items-center gap-2">
                <Button
                  size="sm"
                  variant={qboFluxOpen ? "outline" : "default"}
                  icon={qboFluxOpen ? <ChevronUp size={12} strokeWidth={1.8} /> : <Sparkles size={12} strokeWidth={1.8} />}
                >
                  {qboFluxOpen ? "Hide" : "New from QBO"}
                </Button>
              </div>
            </button>

            <AnimatePresence initial={false}>
              {qboFluxOpen && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.22, ease: "easeOut" }}
                  style={{ borderTop: "1px solid var(--border)" }}
                >
                  <div className="p-5">
                    <QboFluxForm onComplete={handleTbComplete} onCancel={() => setQboFluxOpen(false)} />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}

        {/* ── Trial Balance Upload card ────────────────────────────────────── */}
        <motion.div
          initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, delay: 0.05, ease: "easeOut" }}
          className="rounded-xl overflow-hidden"
          style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}
        >
          <button
            onClick={() => setUploadOpen(o => !o)}
            className="w-full p-5 flex items-start gap-4 text-left transition-colors"
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--surface-2)" }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "" }}
          >
            <div className="h-11 w-11 rounded-lg flex items-center justify-center shrink-0"
              style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
              <Upload size={22} strokeWidth={1.8} />
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-base font-semibold text-theme">Trial Balance Upload</h2>
              <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
                Upload an Excel or CSV trial balance to run a flux analysis. Supports QBO &quot;Compare Trial Balance&quot; exports out of the box.
              </p>
            </div>
            <div className="shrink-0 flex items-center gap-2">
              <Button
                size="sm"
                variant={uploadOpen ? "outline" : "default"}
                icon={uploadOpen ? <ChevronUp size={12} strokeWidth={1.8} /> : <Plus size={12} strokeWidth={1.8} />}
              >
                {uploadOpen ? "Hide" : "New upload"}
              </Button>
            </div>
          </button>

          <AnimatePresence initial={false}>
            {uploadOpen && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.22, ease: "easeOut" }}
                style={{ borderTop: "1px solid var(--border)" }}
              >
                <div className="p-5">
                  <UploadFlow
                    onComplete={handleTbComplete}
                    qboConnected={!!qbo}
                    forceSource="upload"
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>

        {/* Footer tip */}
        <div className="text-center pt-2">
          <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
            Looking for existing analyses? Head to{" "}
            <button onClick={() => navigate("/app/flux")} className="underline hover:opacity-80" style={{ color: "var(--green)" }}>
              Flux Analysis
            </button>
            {" · "}
            <button onClick={() => navigate("/app/reconciliations")} className="underline hover:opacity-80" style={{ color: "var(--green)" }}>
              Reconciliations
            </button>
            .
          </p>
        </div>
      </div>
    </div>
  )
}

// ── QBO-driven flux form (no file upload) ────────────────────────────────────

interface QboFluxFormProps {
  onComplete: (tb: TrialBalance) => void
  onCancel:   () => void
}

function QboFluxForm({ onComplete, onCancel }: QboFluxFormProps) {
  const todayIso = new Date().toISOString().slice(0, 10)
  // Default current period = today, prior = 1 year ago. User adjusts as needed.
  const oneYearAgo = (() => {
    const d = new Date(); d.setFullYear(d.getFullYear() - 1)
    return d.toISOString().slice(0, 10)
  })()

  const [name,        setName]        = useState(`Flux ${todayIso.slice(0, 7)}`)
  const [periodCur,   setPeriodCur]   = useState(todayIso)
  const [periodPrior, setPeriodPrior] = useState(oneYearAgo)
  const [threshold,   setThreshold]   = useState("5000")
  const [error,       setError]       = useState<string | null>(null)

  const run = useMutation({
    mutationFn: () => api.createTrialBalanceFromQbo({
      name: name.trim() || `Flux ${todayIso.slice(0, 7)}`,
      period_current: periodCur,
      period_prior:   periodPrior,
      materiality_threshold: Number(threshold) || 5000,
    }),
    onSuccess: onComplete,
    onError: (e: unknown) => {
      const ex = e as { response?: { data?: { detail?: string } }; message?: string }
      setError(ex.response?.data?.detail ?? ex.message ?? "Could not pull from QBO.")
    },
  })

  return (
    <div className="space-y-4">
      <p className="text-xs" style={{ color: "var(--text-muted)" }}>
        Nordavix will pull two TrialBalance reports from your QuickBooks Online
        account (one per period), merge them by account, and run AI commentary
        for material variances.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Analysis name">
          <input value={name} onChange={(e) => setName(e.target.value)} className="form-input" />
        </Field>
        <Field label="Materiality threshold ($)">
          <input value={threshold} onChange={(e) => setThreshold(e.target.value)} type="number" min="0" className="form-input" />
        </Field>
        <Field label="Current period end">
          <input value={periodCur} onChange={(e) => setPeriodCur(e.target.value)} type="date" className="form-input" />
        </Field>
        <Field label="Prior period end">
          <input value={periodPrior} onChange={(e) => setPeriodPrior(e.target.value)} type="date" className="form-input" />
        </Field>
      </div>

      {error && (
        <p className="text-xs flex items-start gap-1.5" style={{ color: "#dc2626" }}>
          <AlertCircle size={11} strokeWidth={1.8} className="mt-0.5 shrink-0" />
          {error}
        </p>
      )}

      <div className="flex items-center gap-2 flex-wrap pt-1">
        <Button
          onClick={() => run.mutate()}
          loading={run.isPending}
          icon={<Sparkles size={14} strokeWidth={1.8} />}
        >
          {run.isPending ? "Pulling from QuickBooks…" : "Run analysis"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={run.isPending}>
          Cancel
        </Button>
      </div>

      <style>{`
        .form-input {
          width: 100%;
          background: var(--surface-2);
          border: 1px solid var(--border-strong);
          color: var(--text);
          border-radius: 8px;
          padding: 8px 10px;
          font-size: 13px;
          outline: none;
          transition: border-color 0.15s;
        }
        .form-input:focus { border-color: var(--green); }
      `}</style>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[11px] font-medium mb-1 block" style={{ color: "var(--text-2)" }}>{label}</span>
      {children}
    </label>
  )
}

// Type augmentation so existing UploadFlow props remain backwards-compatible.
declare module "@/modules/flux/components/UploadFlow" {
  interface UploadFlowProps {
    forceSource?: "upload" | "qbo"
  }
}
