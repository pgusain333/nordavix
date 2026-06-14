/**
 * Client Memory — Settings section.
 *
 * Shows the conventions Nordavix has learned for this workspace from the
 * preparer's corrections (slice 1: which offset account the firm books for an
 * account's adjustments). Confirm-first: a suggested fact does nothing until a
 * reviewer confirms it; only then does the AI apply it on future runs.
 *
 *   Suggested → [Confirm] makes it active · [Dismiss] rejects it
 *   Active    → applied by the AI · [Forget] (dismiss) to stop using it
 *
 * Reviewer+ can confirm/dismiss; everyone can view. Each fact shows how many
 * times the correction was seen and (on expand) the underlying edits.
 */
import { useState } from "react"
import { useOrganization } from "@clerk/clerk-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { motion, AnimatePresence } from "framer-motion"
import {
  Brain, CheckCircle2, X, Sparkles, ChevronDown, ShieldCheck, AlertTriangle,
} from "lucide-react"
import { Spinner } from "@/core/ui/components"
import { workspaceApi } from "@/modules/workspace/api"
import { memoryApi, type MemoryFact } from "@/modules/memory/api"

function fmtWhen(iso: string | null): string {
  if (!iso) return ""
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
  } catch {
    return ""
  }
}

export function MemorySection() {
  const { organization } = useOrganization()
  const qc = useQueryClient()

  const { data: me } = useQuery({
    queryKey: ["workspace-me"],
    queryFn:  workspaceApi.getMe,
    staleTime: 10 * 60_000,
    enabled:  !!organization,
  })
  const canManage = me?.role === "admin" || me?.role === "reviewer"

  const { data, isLoading, isError } = useQuery({
    queryKey: ["memory-facts"],
    queryFn:  () => memoryApi.listFacts(),
    enabled:  !!organization,
  })

  const [actionErr, setActionErr] = useState<string | null>(null)
  const onActionError = () =>
    setActionErr("Couldn't update — you may not have permission, or the connection hiccuped. Try again.")
  const confirm = useMutation({
    mutationFn: (id: string) => memoryApi.confirmFact(id),
    onSuccess: () => { setActionErr(null); qc.invalidateQueries({ queryKey: ["memory-facts"] }) },
    onError: onActionError,
  })
  const dismiss = useMutation({
    mutationFn: (id: string) => memoryApi.dismissFact(id),
    onSuccess: () => { setActionErr(null); qc.invalidateQueries({ queryKey: ["memory-facts"] }) },
    onError: onActionError,
  })
  // Only the row whose action is in flight is disabled — not every row.
  const pendingId = confirm.isPending ? confirm.variables : dismiss.isPending ? dismiss.variables : null

  if (!organization) {
    return (
      <Card>
        <div className="p-6">
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>
            Select a workspace to see what Nordavix has learned.
          </p>
        </div>
      </Card>
    )
  }

  const facts = data?.items ?? []
  const suggested = facts.filter((f) => f.status === "suggested")
  const active = facts.filter((f) => f.status === "active")

  return (
    <div className="space-y-5">
      {/* Intro / how it works */}
      <Card>
        <CardHeader
          icon={Brain}
          title="Client memory"
          desc="Nordavix learns this client's conventions from your corrections and applies the ones you confirm — so the AI gets more right each month."
        />
        <div className="px-6 pb-5 pt-1">
          <div className="rounded-lg px-3.5 py-2.5 text-[12px] inline-flex items-start gap-2"
            style={{ background: "var(--green-subtle)", color: "var(--green)", border: "1px solid var(--green)" }}>
            <ShieldCheck size={14} strokeWidth={2} className="mt-0.5 shrink-0" />
            <span>
              Confirm-first — a learned convention never changes the AI's output until you confirm it here.
              Everything stays editable, and it's private to this client.
            </span>
          </div>
        </div>
      </Card>

      {isError && (
        <div className="rounded-xl px-4 py-3 text-[12px] flex items-start gap-2"
          style={{ background: "var(--warn-subtle)", color: "var(--warn)", border: "1px solid var(--warn-border)" }}>
          <AlertTriangle size={14} strokeWidth={2} className="mt-0.5 shrink-0" />
          <span>Couldn't load client memory — it may still be finishing its deploy. Your data is safe.</span>
        </div>
      )}

      {actionErr && (
        <div className="rounded-xl px-4 py-3 text-[12px] flex items-start gap-2"
          style={{ background: "var(--danger-subtle)", color: "var(--danger)", border: "1px solid var(--danger-border)" }}>
          <AlertTriangle size={14} strokeWidth={2} className="mt-0.5 shrink-0" />
          <span>{actionErr}</span>
        </div>
      )}

      {/* The loading/empty/list block is hidden on a fetch error so the error
          banner above isn't contradicted by a false "nothing learned yet". */}
      {isError ? null : isLoading && !data ? (
        <Card>
          <div className="p-6 flex items-center gap-3">
            <Spinner className="h-5 w-5" />
            <span className="text-sm" style={{ color: "var(--text-muted)" }}>Loading what Nordavix has learned…</span>
          </div>
        </Card>
      ) : facts.length === 0 ? (
        <Card>
          <div className="px-6 py-10 text-center">
            <Brain size={26} strokeWidth={1.5} className="mx-auto mb-2" style={{ color: "var(--text-muted)" }} />
            <p className="text-sm font-medium" style={{ color: "var(--text-2)" }}>Nothing learned yet</p>
            <p className="text-[12px] mt-1 max-w-md mx-auto" style={{ color: "var(--text-muted)" }}>
              As you edit AI-proposed adjusting entries — for example re-pointing the offset account —
              Nordavix spots the pattern and suggests it here for you to confirm.
            </p>
          </div>
        </Card>
      ) : (
        <>
          {suggested.length > 0 && (
            <Card>
              <CardHeader
                icon={Sparkles}
                title={`Suggested · ${suggested.length}`}
                desc="Patterns Nordavix noticed in your edits. Confirm the ones you want it to apply."
              />
              <div className="p-4 pt-2 space-y-2.5">
                {suggested.map((f) => (
                  <FactRow
                    key={f.id} fact={f} canManage={canManage}
                    onConfirm={() => confirm.mutate(f.id)}
                    onDismiss={() => dismiss.mutate(f.id)}
                    busy={pendingId === f.id}
                  />
                ))}
              </div>
            </Card>
          )}

          <Card>
            <CardHeader
              icon={CheckCircle2}
              title={`Confirmed conventions · ${active.length}`}
              desc="Active rules the AI applies on this client's reconciliations and adjusting entries."
            />
            <div className="p-4 pt-2">
              {active.length === 0 ? (
                <p className="text-[12px] px-2 py-4 text-center" style={{ color: "var(--text-muted)" }}>
                  No confirmed conventions yet. Confirm a suggestion above to start teaching the AI.
                </p>
              ) : (
                <div className="space-y-2.5">
                  {active.map((f) => (
                    <FactRow
                      key={f.id} fact={f} canManage={canManage} active
                      onDismiss={() => dismiss.mutate(f.id)}
                      busy={pendingId === f.id}
                    />
                  ))}
                </div>
              )}
            </div>
          </Card>
        </>
      )}
    </div>
  )
}

// ── Fact row ────────────────────────────────────────────────────────────────

function FactRow({
  fact, canManage, active, onConfirm, onDismiss, busy,
}: {
  fact: MemoryFact
  canManage: boolean
  active?: boolean
  onConfirm?: () => void
  onDismiss?: () => void
  busy?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [evidence, setEvidence] = useState<Awaited<ReturnType<typeof memoryApi.getEvidence>> | null>(null)
  const [loadingEv, setLoadingEv] = useState(false)
  const seen = fact.provenance?.seen ?? fact.confidence
  const fromNum = (fact.value?.from_account_number as string) || ""
  const fromName = (fact.value?.from_account_name as string) || ""

  async function toggle() {
    const next = !open
    setOpen(next)
    if (next && !evidence) {
      setLoadingEv(true)
      try { setEvidence(await memoryApi.getEvidence(fact.id)) }
      catch { /* leave null — the summary below still shows */ }
      finally { setLoadingEv(false) }
    }
  }

  return (
    <div className="rounded-xl" style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
      <div className="flex items-start justify-between gap-3 p-3.5">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold" style={{ color: "var(--text)" }}>{fact.title}</p>
          <div className="flex items-center gap-2 mt-1 flex-wrap text-[11px]" style={{ color: "var(--text-muted)" }}>
            <span className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5"
              style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
              Seen {seen}×
            </span>
            {fromNum || fromName ? (
              <span>was: {[fromNum, fromName].filter(Boolean).join(" · ")}</span>
            ) : null}
            {active && fact.confirmed_at && <span>· confirmed {fmtWhen(fact.confirmed_at)}</span>}
            <button onClick={toggle} className="inline-flex items-center gap-0.5 hover:underline"
              style={{ color: "var(--green)" }}>
              Why <ChevronDown size={11} strokeWidth={2.4} className="transition-transform" style={{ transform: open ? "rotate(180deg)" : "none" }} />
            </button>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {!active && canManage && (
            <button
              onClick={onConfirm} disabled={busy}
              className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-[12px] font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              style={{ background: "var(--green)" }}
            >
              <CheckCircle2 size={13} strokeWidth={2.4} /> Confirm
            </button>
          )}
          {canManage && (
            <button
              onClick={onDismiss} disabled={busy}
              title={active ? "Stop applying this convention" : "Dismiss this suggestion"}
              className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[12px] font-semibold transition-colors disabled:opacity-50"
              style={{ border: "1px solid var(--border-strong)", color: "var(--text-2)" }}
            >
              <X size={13} strokeWidth={2.4} /> {active ? "Forget" : "Dismiss"}
            </button>
          )}
        </div>
      </div>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="px-3.5 pb-3.5 pt-0" style={{ borderTop: "1px solid var(--border)" }}>
              <p className="text-[11px] mt-2.5 mb-1.5 font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                Learned from these edits
              </p>
              {loadingEv ? (
                <div className="flex items-center gap-2 py-2"><Spinner className="h-3.5 w-3.5" /><span className="text-[11px]" style={{ color: "var(--text-muted)" }}>Loading…</span></div>
              ) : evidence && evidence.signals.length > 0 ? (
                <ul className="space-y-1">
                  {evidence.signals.map((s) => (
                    <li key={s.id} className="text-[11px]" style={{ color: "var(--text-2)" }}>
                      {fmtWhen(s.period_end)} · changed{" "}
                      <span className="font-medium">{accLabel(s.before)}</span> →{" "}
                      <span className="font-medium" style={{ color: "var(--green)" }}>{accLabel(s.after)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                  Seen {seen}× across this client's adjusting entries.
                </p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function accLabel(acc: Record<string, unknown> | undefined): string {
  if (!acc) return "—"
  const num = (acc.account_number as string) || ""
  const name = (acc.account_name as string) || ""
  return [num, name].filter(Boolean).join(" · ") || "—"
}

// ── Local primitives (match the Settings look) ────────────────────────────────

function Card({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-2xl"
      style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
      {children}
    </section>
  )
}

function CardHeader({ icon: Icon, title, desc }: { icon: typeof Brain; title: string; desc: string }) {
  return (
    <div className="px-6 py-5" style={{ borderBottom: "1px solid var(--border)" }}>
      <div className="flex items-start gap-3">
        <span className="h-9 w-9 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
          <Icon size={17} strokeWidth={1.8} />
        </span>
        <div className="flex-1 min-w-0">
          <h2 className="text-base font-bold text-theme leading-tight">{title}</h2>
          <p className="text-xs sm:text-[13px] mt-1" style={{ color: "var(--text-muted)" }}>{desc}</p>
        </div>
      </div>
    </div>
  )
}
