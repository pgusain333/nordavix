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
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { motion, AnimatePresence } from "framer-motion"
import { formatDate } from "@/core/lib/dates"
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
  ShieldAlert,
} from "lucide-react"
import { api, type TrialBalance } from "@/modules/flux/api"
import { useQboConnection } from "@/modules/flux/hooks"
import { UploadFlow } from "@/modules/flux/components/UploadFlow"
import { Button, Spinner } from "@/core/ui/components"
import { workspaceApi } from "@/modules/workspace/api"

export function ConnectionsPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [uploadOpen, setUploadOpen] = useState(false)
  const [qboError, setQboError] = useState<string | null>(null)
  const [qboLoading, setQboLoading] = useState(false)

  // QBO connection status — localStorage-cached for instant render on refresh.
  const { data: qbo, isLoading: qboLoadingQuery } = useQboConnection()

  // Current user's role — used to gate the "Connect QuickBooks" + "Reconnect"
  // buttons. Non-admins still see the connection STATUS (so they know whether
  // their company is wired up), but can't initiate or change the connection.
  // Backend enforces the same rule via require_role("admin") on the
  // /connect-url and /oauth/connect endpoints, so even if someone bypassed
  // the UI gate the API would 403 them.
  const { data: me } = useQuery({
    queryKey: ["workspace-me"],
    queryFn:  workspaceApi.getMe,
    staleTime: 60_000,
  })
  const isAdmin = me?.role === "admin"

  // The admins list — surfaced in the non-admin "ask your admin" callout so
  // the user knows exactly who to ping in Slack/email. Only loaded for
  // non-admins to avoid an extra request when admin is viewing.
  // listMembers() unwraps the {members: [...]} response server-side and
  // returns the array directly — so we filter on `members` not
  // `members.members`. (Local `tsc --noEmit` missed this; the production
  // `tsc -b` build in CI caught it because it ignores tsbuildinfo
  // shortcuts and re-typechecks from scratch.)
  const { data: members = [] } = useQuery({
    queryKey: ["workspace-members"],
    queryFn:  workspaceApi.listMembers,
    staleTime: 60_000,
    enabled: !!me && !isAdmin,
  })
  const admins = members.filter((m) => m.role === "admin")

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
          className="lg:hidden"
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
                    Realm {qbo.realm_id} · connected {formatDate(qbo.connected_at)}
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
              {/* Connect / Reconnect actions are admin-only — these flows
                  authorize Nordavix to read the entire company's books.
                  Non-admins see only a connection-status indicator. */}
              {isAdmin && (qbo ? (
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
              ))}
            </div>
          </div>

          {/* Non-admin + not-connected: "ask your admin" callout with the
              actual admin name(s) so the user knows who to contact. */}
          {!isAdmin && !qbo && !qboLoadingQuery && (
            <div className="px-5 py-4 flex items-start gap-3"
              style={{ borderTop: "1px solid var(--border)", background: "var(--surface-2)" }}>
              <ShieldAlert size={16} strokeWidth={1.8}
                className="mt-0.5 shrink-0" style={{ color: "#b45309" }} />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-theme mb-0.5">
                  QuickBooks isn't connected yet
                </p>
                <p className="text-[11px] leading-relaxed" style={{ color: "var(--text-2)" }}>
                  Connecting QBO grants Nordavix permission to read your
                  company's books, so only an admin can set it up.{" "}
                  {admins.length > 0 ? (
                    <>Reach out to{" "}
                      {admins.slice(0, 3).map((a, i) => (
                        <span key={a.id}>
                          <a href={`mailto:${a.email}`}
                            className="font-medium underline underline-offset-2"
                            style={{ color: "var(--green)" }}>
                            {a.display_name || a.email}
                          </a>
                          {i < Math.min(admins.length, 3) - 1 ? ", " : ""}
                          {i === Math.min(admins.length, 3) - 2 && admins.length <= 3 ? " or " : ""}
                        </span>
                      ))}
                      {admins.length > 3 ? ` (and ${admins.length - 3} other admin${admins.length - 3 === 1 ? "" : "s"})` : ""}
                      {" "}to set it up.
                    </>
                  ) : (
                    <>Ask the admin on your workspace to set it up.</>
                  )}
                </p>
              </div>
            </div>
          )}

          {/* Non-admin + connected: read-only confirmation, no actions. */}
          {!isAdmin && qbo && (
            <div className="px-5 py-3 flex items-center gap-2 flex-wrap"
              style={{ borderTop: "1px solid var(--border)", background: "var(--surface-2)" }}>
              <CheckCircle2 size={12} strokeWidth={2} style={{ color: "var(--green)" }} />
              <span className="text-[11px]" style={{ color: "var(--text-2)" }}>
                Your workspace is connected to QuickBooks. Ready to{" "}
                <button onClick={() => navigate("/app/reconciliations")}
                  className="font-medium underline underline-offset-2"
                  style={{ color: "var(--green)" }}>
                  start a reconciliation
                </button>
                {" "}or{" "}
                <button onClick={() => navigate("/app/flux")}
                  className="font-medium underline underline-offset-2"
                  style={{ color: "var(--green)" }}>
                  run a flux analysis
                </button>.
              </span>
            </div>
          )}

          {/* Admin + connected: same call-to-action footer as before. */}
          {isAdmin && qbo && (
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

// Type augmentation so existing UploadFlow props remain backwards-compatible.
declare module "@/modules/flux/components/UploadFlow" {
  interface UploadFlowProps {
    forceSource?: "upload" | "qbo"
  }
}
