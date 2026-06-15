/**
 * ProposedEntryCard — one AI-proposed adjusting journal entry, rendered in
 * context (recon drawer / flux variance / bank worksheet) and in the
 * Adjustments queue. Shows the drafted JE lines, the rationale, and the
 * actions that move it through review:
 *
 *   Copy JE  → clipboard (paste into QuickBooks)   — always available
 *   Approve  → reviewer marks it the right entry   — reviewer+, open only → Approved
 *   Dismiss  → not applicable                      — open / accepted
 *
 * Posting is NOT a per-card action: once approved + saved, the batch
 * "Check posted in QBO" reads QuickBooks and marks entries posted (and reopens
 * the affected recons). That keeps the per-card flow to a single confirm —
 * Approve — and the Posted state verified against QBO, never set by hand.
 *
 * Nordavix never writes to QBO; these only record review state. Mutations patch
 * the shared ["adjustments"] cache optimistically (instant) and reconcile on
 * settle, so every surface (inline + queue) updates together with no wait.
 */
import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, Copy, Lock, Sparkles, ThumbsDown } from "lucide-react"

import {
  adjustmentsApi,
  formatJeForClipboard,
  type AdjustmentAccount,
  type ProposedEntry,
  type ProposedEntryLine,
  type ProposedEntryList,
} from "../api"
import { optimisticAdjust, patchAdjustments } from "../optimistic"

function money(s: string): string {
  const n = parseFloat(s) || 0
  if (n === 0) return ""
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const CONFIDENCE: Record<string, { label: string; bg: string; color: string }> = {
  high:   { label: "High confidence",   bg: "var(--green-subtle)",        color: "var(--green)" },
  medium: { label: "Medium confidence", bg: "rgba(154, 107, 46,0.10)",       color: "#8a6326" },
  low:    { label: "Low confidence",    bg: "var(--surface-2)",           color: "var(--text-muted)" },
}

const STATUS_BADGE: Record<string, { label: string; bg: string; color: string }> = {
  accepted:  { label: "Approved", bg: "var(--green-subtle)",  color: "var(--green)" },
  posted:    { label: "Posted",   bg: "rgba(60, 90, 118,0.10)", color: "#3c5a76" },
  dismissed: { label: "Dismissed", bg: "var(--surface-2)",    color: "var(--text-muted)" },
}

interface Props {
  entry:      ProposedEntry
  canReview?: boolean   // reviewer+ — Approve / Dismiss
  canEdit?:   boolean   // preparer+ — select accounts on the JE lines
  readOnly?:  boolean
  // preview: render the card body ONLY (no Copy/Approve/Dismiss row, no editing).
  // Used by GL Accuracy to show the proposed reclass inside a finding review.
  preview?:   boolean
}

export function ProposedEntryCard({ entry, canReview, canEdit, readOnly, preview }: Props) {
  const qc = useQueryClient()
  const [copied, setCopied] = useState(false)

  // Approve → Approved tab; Dismiss → Dismissed. Both patch the shared cache
  // optimistically so the card moves the instant it's clicked (no round-trip
  // wait), rolling back if the server rejects.
  const acceptMut  = useMutation({
    mutationFn: () => adjustmentsApi.accept(entry.id),
    ...optimisticAdjust(qc, (e) => e.id === entry.id, { status: "accepted" }),
  })
  const dismissMut = useMutation({
    mutationFn: () => adjustmentsApi.dismiss(entry.id),
    ...optimisticAdjust(qc, (e) => e.id === entry.id, { status: "dismissed" }),
  })
  const editMut    = useMutation({
    mutationFn: (lines: ProposedEntryLine[]) => adjustmentsApi.edit(entry.id, { lines }),
    onMutate: async (lines: ProposedEntryLine[]) => {
      await qc.cancelQueries({ queryKey: ["adjustments"] })
      const prev = qc.getQueriesData<ProposedEntryList>({ queryKey: ["adjustments"] })
      patchAdjustments(qc, (e) => e.id === entry.id, { lines })
      return { prev }
    },
    onError: (_e, _v, ctx) => { ctx?.prev?.forEach(([k, d]) => qc.setQueryData(k, d)) },
    onSettled: () => { qc.invalidateQueries({ queryKey: ["adjustments"] }) },
  })
  const busy = acceptMut.isPending || dismissMut.isPending

  // Open drafts let the user re-point any line to a different GL account — the
  // chart for the entry's period feeds the per-line dropdown. Re-pointing keeps
  // the amounts (so the entry still balances); the backend re-validates anyway.
  // Preparer+ can edit (build the entry); the change auto-saves for the
  // reviewer. Approval stays reviewer-only. Falls back to canReview when an
  // older caller hasn't passed canEdit yet.
  const allowEdit = canEdit ?? canReview
  const editable = entry.status === "open" && !readOnly && !preview && !!allowEdit
  const { data: accounts } = useQuery({
    queryKey: ["adjustments", "accounts", entry.period_end],
    queryFn:  () => adjustmentsApi.accounts(entry.period_end),
    enabled:  editable,
    staleTime: 5 * 60_000,
  })

  function acctLabel(a: AdjustmentAccount): string {
    const num = a.account_number ? `${a.account_number} · ` : ""
    return `${num}${a.account_name}${a.account_type ? ` · ${a.account_type}` : ""}`
  }
  function changeAccount(lineIndex: number, qboId: string) {
    const acct = (accounts ?? []).find((a) => a.qbo_account_id === qboId)
    if (!acct) return
    const newLines = entry.lines.map((ln, i) =>
      i === lineIndex
        ? {
            ...ln,
            account_qbo_id: acct.qbo_account_id,
            account_number: acct.account_number,
            account_name:   acct.account_name,
          }
        : ln,
    )
    editMut.mutate(newLines)
  }

  const totalDr = entry.lines.reduce((s, l) => s + (parseFloat(l.debit) || 0), 0)
  const totalCr = entry.lines.reduce((s, l) => s + (parseFloat(l.credit) || 0), 0)
  const balanced = Math.abs(totalDr - totalCr) < 0.01

  const conf = CONFIDENCE[entry.confidence] ?? CONFIDENCE.medium
  const badge = STATUS_BADGE[entry.status]
  const isOpen = entry.status === "open"
  const saved = !!entry.saved_at
  const dimmed = entry.status === "dismissed"

  async function copy() {
    try {
      await navigator.clipboard.writeText(formatJeForClipboard(entry))
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch { /* clipboard blocked — no-op */ }
  }

  const showApprove = isOpen && canReview && !readOnly
  // Saved entries are a locked batch and can't be dismissed. Dismissing is a
  // review decision (mirror of accept) — reviewer/admin only, like the API.
  const showDismiss = (isOpen || entry.status === "accepted") && !readOnly && !saved && !!canReview

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
        style={{ background: "rgba(84, 88, 138,0.06)", borderBottom: "1px solid var(--border)" }}
      >
        <Sparkles size={13} strokeWidth={2} style={{ color: "#54588a" }} />
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
        {saved && (
          <span
            className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
            style={{ background: "var(--green-subtle)", color: "var(--green)" }}
            title="Saved — locked. Part of the finalized batch; can't be edited or dismissed."
          >
            <Lock size={9} strokeWidth={2.6} /> Saved
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
                  {editable && accounts ? (
                    <select
                      value={l.account_qbo_id ?? ""}
                      onChange={(e) => changeAccount(i, e.target.value)}
                      disabled={editMut.isPending}
                      title="Change account"
                      className="w-full max-w-full rounded-md px-1.5 py-1 text-[11px] outline-none transition-colors disabled:opacity-50"
                      style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }}
                    >
                      {/* Keep the current line visible even if it's an unset
                          placeholder, or an account not in this period's chart. */}
                      {(!l.account_qbo_id || !accounts.some((a) => a.qbo_account_id === l.account_qbo_id)) && (
                        <option value={l.account_qbo_id ?? ""}>
                          {l.account_name || "— Select account —"}
                        </option>
                      )}
                      {accounts.map((a) => (
                        <option key={a.qbo_account_id} value={a.qbo_account_id}>
                          {acctLabel(a)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <>
                      {l.account_number ? (
                        <span className="font-mono text-[10px] mr-1" style={{ color: "var(--text-muted)" }}>
                          {l.account_number}
                        </span>
                      ) : null}
                      {l.account_name}
                    </>
                  )}
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
            <td className="px-3 py-1 text-right tabular-nums font-bold" style={{ color: balanced ? "var(--text)" : "#9b3d37" }}>
              {totalDr.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </td>
            <td className="px-3 py-1 text-right tabular-nums font-bold" style={{ color: balanced ? "var(--text)" : "#9b3d37" }}>
              {totalCr.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </td>
          </tr>
        </tbody>
      </table>

      {/* Editing hint */}
      {editable && (
        <p className="px-3 pt-1.5 text-[10px]" style={{ color: "var(--text-muted)" }}>
          Pick a different account from any dropdown to re-point a line before approving.
        </p>
      )}

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

      {/* Actions — suppressed in preview (the host owns the actions) */}
      {!preview && (
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
      )}
    </div>
  )
}
