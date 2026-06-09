/**
 * ProposedEntryCard — one AI-proposed adjusting journal entry, rendered in
 * context (recon drawer / flux variance / bank worksheet) and in the
 * Adjustments queue. Shows the drafted JE lines, the rationale, and the
 * actions that move it through review:
 *
 *   Copy JE     → clipboard (paste into QuickBooks)   — always available
 *   Approve     → reviewer marks it the right entry    — reviewer+, open only
 *   Mark posted → human booked it in QBO               — open / accepted
 *   Dismiss     → not applicable                       — open / accepted
 *
 * Nordavix never writes to QBO; these only record review state. Mutations
 * invalidate the shared ["adjustments"] cache so every surface (inline +
 * queue) updates together.
 */
import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Check, Copy, Sparkles, ThumbsDown } from "lucide-react"

import { adjustmentsApi, formatJeForClipboard, type ProposedEntry } from "../api"

function money(s: string): string {
  const n = parseFloat(s) || 0
  if (n === 0) return ""
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const CONFIDENCE: Record<string, { label: string; bg: string; color: string }> = {
  high:   { label: "High confidence",   bg: "var(--green-subtle)",        color: "var(--green)" },
  medium: { label: "Medium confidence", bg: "rgba(217,119,6,0.10)",       color: "#b45309" },
  low:    { label: "Low confidence",    bg: "var(--surface-2)",           color: "var(--text-muted)" },
}

const STATUS_BADGE: Record<string, { label: string; bg: string; color: string }> = {
  accepted:  { label: "Approved", bg: "var(--green-subtle)",  color: "var(--green)" },
  posted:    { label: "Posted",   bg: "rgba(37,99,235,0.10)", color: "#1d4ed8" },
  dismissed: { label: "Dismissed", bg: "var(--surface-2)",    color: "var(--text-muted)" },
}

interface Props {
  entry:      ProposedEntry
  canReview?: boolean
  readOnly?:  boolean
}

export function ProposedEntryCard({ entry, canReview, readOnly }: Props) {
  const qc = useQueryClient()
  const [copied, setCopied] = useState(false)

  const invalidate = () => qc.invalidateQueries({ queryKey: ["adjustments"] })
  const acceptMut  = useMutation({ mutationFn: () => adjustmentsApi.accept(entry.id),     onSuccess: invalidate })
  const dismissMut = useMutation({ mutationFn: () => adjustmentsApi.dismiss(entry.id),    onSuccess: invalidate })
  const postedMut  = useMutation({ mutationFn: () => adjustmentsApi.markPosted(entry.id), onSuccess: invalidate })
  const busy = acceptMut.isPending || dismissMut.isPending || postedMut.isPending

  const totalDr = entry.lines.reduce((s, l) => s + (parseFloat(l.debit) || 0), 0)
  const totalCr = entry.lines.reduce((s, l) => s + (parseFloat(l.credit) || 0), 0)
  const balanced = Math.abs(totalDr - totalCr) < 0.01

  const conf = CONFIDENCE[entry.confidence] ?? CONFIDENCE.medium
  const badge = STATUS_BADGE[entry.status]
  const isOpen = entry.status === "open"
  const dimmed = entry.status === "dismissed"

  async function copy() {
    try {
      await navigator.clipboard.writeText(formatJeForClipboard(entry))
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch { /* clipboard blocked — no-op */ }
  }

  const showApprove = isOpen && canReview && !readOnly
  const showPosted  = (isOpen || entry.status === "accepted") && !readOnly
  const showDismiss = (isOpen || entry.status === "accepted") && !readOnly

  return (
    <div
      className="rounded-xl overflow-hidden"
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        opacity: dimmed ? 0.6 : 1,
      }}
    >
      {/* Header — AI marker + confidence + status */}
      <div
        className="px-3 py-2 flex items-center gap-2 flex-wrap"
        style={{ background: "rgba(124,58,237,0.06)", borderBottom: "1px solid var(--border)" }}
      >
        <Sparkles size={13} strokeWidth={2} style={{ color: "#7c3aed" }} />
        <p className="text-[11px] font-semibold text-theme flex-1 min-w-0 truncate">
          {entry.description}
        </p>
        <span
          className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
          style={{ background: conf.bg, color: conf.color }}
        >
          {conf.label}
        </span>
        {badge && (
          <span
            className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
            style={{ background: badge.bg, color: badge.color }}
          >
            {badge.label}
          </span>
        )}
      </div>

      {/* JE lines */}
      <table className="w-full text-[11px]">
        <thead>
          <tr style={{ background: "var(--surface-2)" }}>
            <th className="text-left px-3 py-1 font-semibold" style={{ color: "var(--text-muted)" }}>Account</th>
            <th className="text-right px-3 py-1 font-semibold" style={{ color: "var(--text-muted)", width: 110 }}>Debit</th>
            <th className="text-right px-3 py-1 font-semibold" style={{ color: "var(--text-muted)", width: 110 }}>Credit</th>
          </tr>
        </thead>
        <tbody>
          {entry.lines.map((l, i) => {
            const isCredit = (parseFloat(l.credit) || 0) > 0
            return (
              <tr key={i} style={{ borderTop: "1px solid var(--border)" }}>
                <td className="px-3 py-1 text-theme" style={{ paddingLeft: isCredit ? 24 : 12 }}>
                  {l.account_number ? (
                    <span className="font-mono text-[10px] mr-1" style={{ color: "var(--text-muted)" }}>
                      {l.account_number}
                    </span>
                  ) : null}
                  {l.account_name}
                </td>
                <td className="px-3 py-1 text-right tabular-nums font-semibold"
                  style={{ color: l.debit && parseFloat(l.debit) ? "var(--text)" : "var(--text-muted)" }}>
                  {money(l.debit)}
                </td>
                <td className="px-3 py-1 text-right tabular-nums font-semibold"
                  style={{ color: l.credit && parseFloat(l.credit) ? "var(--text)" : "var(--text-muted)" }}>
                  {money(l.credit)}
                </td>
              </tr>
            )
          })}
          <tr style={{ borderTop: "2px solid var(--border-strong, var(--border))" }}>
            <td className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
              Total
            </td>
            <td className="px-3 py-1 text-right tabular-nums font-bold" style={{ color: balanced ? "var(--text)" : "#b91c1c" }}>
              {totalDr.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </td>
            <td className="px-3 py-1 text-right tabular-nums font-bold" style={{ color: balanced ? "var(--text)" : "#b91c1c" }}>
              {totalCr.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </td>
          </tr>
        </tbody>
      </table>

      {/* Rationale + memo */}
      {(entry.rationale || entry.memo) && (
        <div className="px-3 py-2" style={{ borderTop: "1px solid var(--border)" }}>
          {entry.rationale && (
            <p className="text-[10px] leading-snug" style={{ color: "var(--text-muted)" }}>
              {entry.rationale}
            </p>
          )}
          {entry.memo && (
            <p className="text-[10px] mt-1 italic" style={{ color: "var(--text-muted)" }}>
              Memo: {entry.memo}
            </p>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="px-3 py-2 flex items-center gap-2 flex-wrap" style={{ borderTop: "1px solid var(--border)" }}>
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold transition-colors"
          style={{ background: "var(--surface-2)", color: "var(--text)" }}
        >
          {copied ? <Check size={12} strokeWidth={2.4} /> : <Copy size={12} strokeWidth={2} />}
          {copied ? "Copied" : "Copy JE"}
        </button>

        <div className="flex-1" />

        {showDismiss && (
          <button
            type="button"
            onClick={() => dismissMut.mutate()}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold transition-colors disabled:opacity-50"
            style={{ background: "transparent", color: "var(--text-muted)" }}
          >
            <ThumbsDown size={12} strokeWidth={2} />
            Dismiss
          </button>
        )}
        {showPosted && (
          <button
            type="button"
            onClick={() => postedMut.mutate()}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold transition-colors disabled:opacity-50"
            style={{ background: "var(--surface-2)", color: "var(--text)" }}
          >
            Mark posted
          </button>
        )}
        {showApprove && (
          <button
            type="button"
            onClick={() => acceptMut.mutate()}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-bold transition-colors disabled:opacity-50"
            style={{ background: "var(--green)", color: "white" }}
          >
            <Check size={12} strokeWidth={2.6} />
            Approve
          </button>
        )}
      </div>
    </div>
  )
}
