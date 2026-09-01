/**
 * ProposedEntryCard — one AI-proposed adjusting journal entry, rendered in
 * context (recon drawer / flux variance / bank worksheet) and in the
 * Adjustments queue. Shows the drafted JE lines, the rationale, and the
 * actions that move it through review:
 *
 *   Copy JE  → clipboard (paste into QuickBooks)   — always available
 *   Approve  → reviewer marks it the right entry   — reviewer+, open only → Approved
 *   Reopen   → pull an approved entry back to open  — reviewer+, any approved (even saved)
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
import { AnimatePresence, motion, useReducedMotion } from "framer-motion"
import { Check, Copy, Lock, RotateCcw, Sparkles, ThumbsDown } from "lucide-react"

import { MOTION, EASE } from "@/core/motion"
import {
  adjustmentsApi,
  formatJeForClipboard,
  type AdjustmentAccount,
  type ProposedEntry,
  type ProposedEntryLine,
  type ProposedEntryList,
} from "../api"
import { optimisticAdjust, patchAdjustments } from "../optimistic"

/** A review action: appears and leaves with the state that warrants it, and
 *  gives under the press. Shared so Approve, Reopen and Don't-book move
 *  identically — three buttons on one row with three different feels is what
 *  makes an interface feel assembled rather than designed. */
function actionMotion(reduce: boolean | null) {
  return {
    initial: reduce ? false : { opacity: 0, scale: 0.94 },
    animate: { opacity: 1, scale: 1 },
    exit: reduce ? { opacity: 0 } : { opacity: 0, scale: 0.94 },
    whileTap: reduce ? undefined : { scale: 0.96 },
    transition: { duration: MOTION.FAST, ease: EASE.OUT },
  } as const
}

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

/** Matches the server's floor. Short enough not to be a chore, long enough
 *  that a stray keystroke isn't a reason. */
const MIN_REASON = 3

/** The reasons a proposed entry actually gets passed on, offered as one tap.
 *  They are a starting point, not a closed list — the field stays editable,
 *  because "below materiality" and "below materiality, but watch it next month"
 *  are different records. */
const DISMISS_REASONS = [
  "Below materiality",
  "Already booked in QuickBooks",
  "Client will correct at source",
  "Treatment is correct as posted",
  "Duplicate of another entry",
]

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
  const reduce = useReducedMotion()
  const [copied, setCopied] = useState(false)

  // Approve → Approved tab; Dismiss → Dismissed. Both patch the shared cache
  // optimistically so the card moves the instant it's clicked (no round-trip
  // wait), rolling back if the server rejects.
  const acceptMut  = useMutation({
    mutationFn: () => adjustmentsApi.accept(entry.id),
    ...optimisticAdjust(qc, (e) => e.id === entry.id, { status: "accepted" }),
  })
  // Dismiss takes a reason and the server refuses a blank one. A decision not
  // to book something the product found outlives whoever made it: it is what
  // the passed-adjustments total is built from, what a reviewer re-reads, and
  // what an examiner asks about.
  const [dismissing, setDismissing] = useState(false)
  const [reason, setReason] = useState("")
  const dismissMut = useMutation({
    mutationFn: (why: string) => adjustmentsApi.dismiss(entry.id, why),
    ...optimisticAdjust(qc, (e) => e.id === entry.id, { status: "dismissed" }),
    onSuccess: () => { setDismissing(false); setReason("") },
  })
  // Reopen → Open tab. Un-approves an accepted entry so its accounts can be
  // re-pointed, then re-approved. Works even on a saved entry — reopening pulls
  // it back out of the batch, so clear saved_at optimistically too (the lock
  // badge drops in the same paint). Like accept/dismiss.
  const reopenMut  = useMutation({
    mutationFn: () => adjustmentsApi.reopen(entry.id),
    ...optimisticAdjust(qc, (e) => e.id === entry.id, { status: "open", saved_at: null }),
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
  const busy = acceptMut.isPending || dismissMut.isPending || reopenMut.isPending

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
  // Reopen un-approves: accepted → open, so the account can be changed and the
  // entry re-approved. Reviewer/admin only; works even on a saved entry (it's
  // pulled back out of the batch).
  const showReopen = entry.status === "accepted" && !readOnly && !!canReview

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

      {/* Why it wasn't booked — the record, once the decision is made. */}
      <AnimatePresence initial={false}>
      {entry.status === "dismissed" && entry.dismiss_reason && (
        <motion.div key="reason"
          initial={reduce ? false : { height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
          transition={{ duration: MOTION.DEFAULT, ease: EASE.OUT }}
          style={{ overflow: "hidden" }}>
          <div className="px-3 py-2" style={{ borderTop: "1px solid var(--border)" }}>
            <p className="text-[10px] leading-snug" style={{ color: "var(--text-2)" }}>
              <span className="font-semibold">Not booked — </span>{entry.dismiss_reason}
            </p>
          </div>
        </motion.div>
      )}
      </AnimatePresence>

      {/* Asking why, before it's gone. Inline rather than a modal: the entry
          being judged stays on screen while the reason is written, and the
          panel grows out of the card rather than appearing on top of it. */}
      <AnimatePresence initial={false}>
      {dismissing && !preview && (
        <motion.div key="why"
          initial={reduce ? false : { height: 0, opacity: 0 }}
          animate={{
            height: "auto", opacity: 1,
            transition: reduce ? { duration: 0 } : {
              height:  { duration: MOTION.DEFAULT, ease: EASE.OUT },
              opacity: { duration: MOTION.FAST, delay: 0.04 },
            },
          }}
          exit={reduce ? { opacity: 0 } : {
            height: 0, opacity: 0,
            transition: { height: { duration: MOTION.FAST, ease: EASE.OUT }, opacity: { duration: 0.08 } },
          }}
          style={{ overflow: "hidden" }}>
        <div className="px-3 py-2.5" style={{ borderTop: "1px solid var(--border)", background: "var(--surface-2)" }}>
          <p className="text-[10.5px] font-semibold mb-1.5" style={{ color: "var(--text)" }}>
            Why isn't this being booked?
          </p>
          <div className="flex flex-wrap gap-1 mb-1.5">
            {DISMISS_REASONS.map((r, i) => (
              <motion.button
                key={r}
                type="button"
                initial={reduce ? false : { opacity: 0, y: -3 }}
                animate={{ opacity: 1, y: 0 }}
                whileTap={reduce ? undefined : { scale: 0.95 }}
                transition={{ duration: MOTION.FAST, ease: EASE.OUT, delay: reduce ? 0 : i * 0.025 }}
                onClick={() => setReason(r)}
                className="rounded-full px-2 py-0.5 text-[10px]"
                style={{
                  background: reason === r ? "var(--green-subtle)" : "var(--surface)",
                  color:      reason === r ? "var(--green)" : "var(--text-muted)",
                  border:     `1px solid ${reason === r ? "transparent" : "var(--border)"}`,
                  transition: reduce ? "none" : "background .12s, color .12s, border-color .12s",
                }}
              >
                {r}
              </motion.button>
            ))}
          </div>
          <input
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") { setDismissing(false); setReason("") }
              if (e.key === "Enter" && reason.trim().length >= MIN_REASON) dismissMut.mutate(reason.trim())
            }}
            placeholder="Or write your own — this is kept with the close record"
            maxLength={500}
            className="w-full rounded-lg px-2.5 py-1.5 text-[11.5px] outline-none"
            style={{ background: "var(--surface)", border: "1px solid var(--border-strong)", color: "var(--text)" }}
          />
          <div className="flex items-center gap-2 mt-2">
            <button
              type="button"
              onClick={() => { setDismissing(false); setReason("") }}
              className="rounded-md px-2 py-1 text-[11px] font-semibold"
              style={{ color: "var(--text-muted)" }}
            >
              Cancel
            </button>
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => dismissMut.mutate(reason.trim())}
              disabled={reason.trim().length < MIN_REASON || dismissMut.isPending}
              className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-bold transition-colors disabled:opacity-40"
              style={{ background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border-strong)" }}
            >
              <ThumbsDown size={12} strokeWidth={2.2} />
              {dismissMut.isPending ? "Recording…" : "Don't book it"}
            </button>
          </div>
          {dismissMut.isError && (
            <p className="text-[10px] mt-1.5" style={{ color: "#8a6326" }}>
              Couldn't record that — try again.
            </p>
          )}
        </div>
        </motion.div>
      )}
      </AnimatePresence>

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

        {/* Every action gives way slightly under the press — the cheapest
            possible signal that the click landed, before the card animates
            out of the queue. */}
        <AnimatePresence initial={false} mode="popLayout">
        {showReopen && (
          <motion.button
            key="reopen"
            type="button"
            {...actionMotion(reduce)}
            onClick={() => reopenMut.mutate()}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold transition-colors disabled:opacity-50"
            style={{ background: "var(--surface-2)", color: "var(--text)" }}
            title="Reopen this approved entry to change an account, then re-approve"
          >
            <RotateCcw size={12} strokeWidth={2} />
            Reopen
          </motion.button>
        )}
        {showDismiss && !dismissing && (
          <motion.button
            key="dismiss"
            type="button"
            {...actionMotion(reduce)}
            onClick={() => setDismissing(true)}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold transition-colors disabled:opacity-50"
            style={{ background: "transparent", color: "var(--text-muted)" }}
          >
            <ThumbsDown size={12} strokeWidth={2} />
            Don't book
          </motion.button>
        )}
        {showApprove && (
          <motion.button
            key="approve"
            type="button"
            {...actionMotion(reduce)}
            onClick={() => acceptMut.mutate()}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-bold transition-colors disabled:opacity-50"
            style={{ background: "var(--green)", color: "white" }}
          >
            <Check size={12} strokeWidth={2.6} />
            Approve
          </motion.button>
        )}
        </AnimatePresence>
      </div>
      )}
    </div>
  )
}
