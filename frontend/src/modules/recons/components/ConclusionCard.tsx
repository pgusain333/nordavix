/**
 * How this reconciliation was concluded — the working paper frozen at sign-off.
 *
 * Everything else on this screen is LIVE: the GL balance is re-read from
 * QuickBooks on every render, so what an approval appears to say can change
 * after it was signed. This card is the one place showing the numbers as they
 * actually stood when someone put their name to them, and where each of those
 * numbers came from.
 *
 * The distinction that matters for an AI-prepared reconciliation: a figure a
 * model produced and a figure a person entered are different kinds of evidence,
 * and a model's suggestion nobody confirmed is different again from one a
 * preparer accepted. Those are labelled, not blended.
 *
 * Renders nothing until an account has been approved at least once.
 */
import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Brain, ChevronDown, FileCheck2, History, TrendingUp, User } from "lucide-react"

import { reconsApi } from "@/modules/recons/api"
import type { ConclusionItem, ReconConclusion } from "@/modules/recons/api"
import { formatDateTime } from "@/core/lib/dates"

const fmt = (v: string | null) =>
  v == null
    ? "—"
    : (parseFloat(v) || 0).toLocaleString("en-US", {
        style: "currency", currency: "USD", minimumFractionDigits: 2,
      })

const ORIGIN_LABEL: Record<ConclusionItem["origin"], string> = {
  system: "Pulled",
  human:  "Entered",
  ai:     "AI",
}
const ORIGIN_STYLE: Record<ConclusionItem["origin"], { bg: string; fg: string }> = {
  system: { bg: "rgba(84, 88, 138, 0.10)",  fg: "#54588a" },
  human:  { bg: "rgba(79, 160, 122, 0.12)", fg: "#3d7f60" },
  ai:     { bg: "rgba(139, 92, 246, 0.12)", fg: "#6d3fc4" },
}

function OriginTag({ origin }: { origin: ConclusionItem["origin"] }) {
  const s = ORIGIN_STYLE[origin]
  return (
    <span
      className="inline-flex items-center rounded px-1.5 py-px text-[9px] font-bold uppercase tracking-wider shrink-0"
      style={{ background: s.bg, color: s.fg }}
    >
      {ORIGIN_LABEL[origin]}
    </span>
  )
}

/** One side of the reconciliation, with its source spelled out. */
function Side({
  label, amount, source, origin, asOf,
}: {
  label: string
  amount: string | null
  source?: string | null
  origin?: ConclusionItem["origin"]
  asOf?: string | null
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[12px] font-semibold" style={{ color: "var(--text)" }}>{label}</span>
          {origin && <OriginTag origin={origin} />}
        </div>
        {(source || asOf) && (
          <div className="text-[10.5px] leading-snug mt-px" style={{ color: "var(--text-muted)" }}>
            {source}
            {asOf && <> · as at {formatDateTime(asOf)}</>}
          </div>
        )}
      </div>
      <span className="text-[12.5px] font-semibold tabular-nums shrink-0" style={{ color: "var(--text)" }}>
        {fmt(amount)}
      </span>
    </div>
  )
}

function ConclusionBody({ c }: { c: ReconConclusion }) {
  const items = c.items || []
  const aiAccepted = c.ai_basis?.accepted_by

  return (
    <div className="space-y-1">
      <Side
        label="General ledger"
        amount={c.gl_balance}
        source={c.gl_source}
        origin="system"
        asOf={c.gl_as_of}
      />
      <Side
        label="Subledger"
        amount={c.subledger_total}
        origin={c.subledger_origin}
        source={
          c.subledger_evidence_id
            ? "Supported by an attached document"
            : c.subledger_origin === "ai"
              ? "Prepared by Nordavix AI"
              : null
        }
      />

      <div
        className="flex items-center justify-between gap-3 pt-2 mt-1"
        style={{ borderTop: "1px solid var(--border)" }}
      >
        <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
          Difference
        </span>
        <span
          className="text-[12.5px] font-bold tabular-nums"
          style={{ color: c.reconciled ? "#3d7f60" : "#8a6326" }}
        >
          {fmt(c.variance)}
        </span>
      </div>

      {/* What explained the difference, and who put each piece there. */}
      {items.length > 0 && (
        <div className="pt-2">
          <div className="text-[10px] font-bold uppercase tracking-wider mb-1" style={{ color: "var(--text-muted)" }}>
            Reconciling items ({items.length})
          </div>
          <ul className="space-y-1">
            {items.slice(0, 12).map((it, i) => (
              <li key={i} className="flex items-start justify-between gap-2">
                <span className="flex items-start gap-1.5 min-w-0">
                  <OriginTag origin={it.origin} />
                  <span
                    className="text-[11.5px] leading-snug truncate"
                    style={{
                      color: it.cleared === false ? "var(--text-muted)" : "var(--text)",
                      textDecoration: it.cleared === false ? "line-through" : undefined,
                    }}
                    title={it.note || it.label}
                  >
                    {it.label || "item"}
                  </span>
                </span>
                <span className="text-[11.5px] tabular-nums shrink-0" style={{ color: "var(--text-2)" }}>
                  {fmt(it.amount)}
                </span>
              </li>
            ))}
          </ul>
          {items.length > 12 && (
            <div className="text-[10.5px] mt-1" style={{ color: "var(--text-muted)" }}>
              + {items.length - 12} more in the working paper
            </div>
          )}
        </div>
      )}

      {/* An AI-prepared conclusion is only as good as the person who accepted
          it — say who that was rather than presenting the output on its own. */}
      {c.ai_basis && (
        <div
          className="flex items-start gap-1.5 rounded-md px-2 py-1.5 mt-2 text-[11px] leading-snug"
          style={{ background: "rgba(139, 92, 246, 0.07)", color: "#5b21b6" }}
        >
          <Brain size={12} strokeWidth={2} className="shrink-0 mt-px" />
          <span>
            Prepared by Nordavix AI
            {aiAccepted && c.approved_by_name ? <>, accepted by <strong>{c.approved_by_name}</strong></> : null}.
            The balances above are the ones it worked from.
          </span>
        </div>
      )}

      <div className="flex items-center gap-1.5 pt-2 text-[10.5px]" style={{ color: "var(--text-muted)" }}>
        <User size={11} strokeWidth={2} className="shrink-0" />
        <span>
          {c.prepared_by_name && <>Prepared by {c.prepared_by_name} · </>}
          Approved by {c.approved_by_name || "—"}
          {c.approved_at && <> on {formatDateTime(c.approved_at)}</>}
        </span>
      </div>
      {c.content_hash && (
        <div className="text-[9.5px] font-mono pt-px" style={{ color: "var(--text-muted)" }}>
          {c.content_hash.slice(0, 16)}…
        </div>
      )}
    </div>
  )
}

export function ConclusionCard({
  qboAccountId, periodEnd,
}: { qboAccountId: string; periodEnd: string }) {
  const [showHistory, setShowHistory] = useState(false)

  const { data } = useQuery({
    queryKey: ["recon-conclusions", qboAccountId, periodEnd],
    queryFn: () => reconsApi.listAccountConclusions(qboAccountId, periodEnd),
    enabled: !!qboAccountId && !!periodEnd,
  })

  const all = data?.conclusions ?? []
  if (all.length === 0) return null   // never approved — nothing frozen yet

  const active = all.find((c) => c.status === "active")
  const prior = all.filter((c) => c.status === "superseded")
  const current = active ?? all[0]
  const drift = data?.drift

  return (
    <div
      className="rounded-xl overflow-hidden"
      style={{ background: "var(--surface)", border: "1px solid var(--border-strong)" }}
    >
      <div
        className="flex items-center gap-1.5 px-3.5 py-2"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <FileCheck2 size={13} strokeWidth={1.8} style={{ color: "var(--text-2)" }} />
        <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: "var(--text-2)" }}>
          How this was concluded
        </span>
        {!active && (
          <span
            className="ml-auto rounded px-1.5 py-px text-[9px] font-bold uppercase tracking-wider"
            style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}
          >
            Reopened
          </span>
        )}
      </div>

      <div className="px-3.5 py-3">
        {/* The whole reason the snapshot is kept. The account is live; the
            sign-off is not — when they disagree, say so instead of quietly
            showing today's numbers as the approved ones. */}
        {active && drift?.drifted && (
          <div
            className="flex items-start gap-1.5 rounded-md px-2 py-1.5 mb-2.5 text-[11px] leading-snug"
            style={{ background: "rgba(199, 154, 82, 0.10)", color: "#8a6326" }}
          >
            <TrendingUp size={12} strokeWidth={2} className="shrink-0 mt-px" />
            <span>
              This account has moved since it was approved
              {drift.gl_changed_by && <> — GL by <strong>{fmt(drift.gl_changed_by)}</strong></>}
              {drift.subledger_changed_by && <>, subledger by <strong>{fmt(drift.subledger_changed_by)}</strong></>}
              . The figures below are the ones that were signed.
            </span>
          </div>
        )}

        <ConclusionBody c={current} />

        {prior.length > 0 && (
          <div className="mt-3 pt-2" style={{ borderTop: "1px solid var(--border)" }}>
            <button
              type="button"
              onClick={() => setShowHistory((v) => !v)}
              className="flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-wider transition-opacity hover:opacity-70"
              style={{ color: "var(--text-muted)" }}
            >
              <History size={11} strokeWidth={2} />
              {prior.length} earlier sign-off{prior.length === 1 ? "" : "s"}
              <ChevronDown
                size={12}
                strokeWidth={2}
                style={{
                  transform: showHistory ? "rotate(180deg)" : undefined,
                  transition: "transform 140ms ease",
                }}
              />
            </button>
            {showHistory && (
              <div className="mt-2 space-y-3">
                {prior.map((c) => (
                  <div
                    key={c.id}
                    className="rounded-lg px-2.5 py-2"
                    style={{ background: "var(--surface-2)", opacity: 0.92 }}
                  >
                    <div className="text-[10px] font-bold uppercase tracking-wider mb-1" style={{ color: "var(--text-muted)" }}>
                      Superseded{c.superseded_at && <> {formatDateTime(c.superseded_at)}</>}
                    </div>
                    <ConclusionBody c={c} />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
