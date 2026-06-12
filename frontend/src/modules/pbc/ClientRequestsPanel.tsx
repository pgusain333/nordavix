/**
 * ClientRequestsPanel — "Request from client" inside the recon drawer's
 * Evidence tab. Create a magic-link document request, see every request
 * for this (account, period) with live status, resend or cancel.
 *
 * Files the client uploads arrive as ordinary evidence on this same
 * account + period — this panel is just the request lifecycle.
 */
import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Mail, Plus, RefreshCw, X } from "lucide-react"
import { Spinner } from "@/core/ui/components"
import { ErrorBoundary } from "@/core/ui/ErrorBoundary"
import { pbcApi } from "@/modules/pbc/api"

const STATUS_META: Record<string, { label: string; fg: string; bg: string }> = {
  pending:   { label: "Waiting on client", fg: "#8a6326",         bg: "rgba(199,154,82,0.12)" },
  fulfilled: { label: "Received",          fg: "var(--green)",    bg: "var(--green-subtle)" },
  expired:   { label: "Expired",           fg: "var(--text-muted)", bg: "var(--surface-2)" },
  cancelled: { label: "Cancelled",         fg: "var(--text-muted)", bg: "var(--surface-2)" },
}
const FALLBACK_META = { label: "Sent", fg: "var(--text-muted)", bg: "var(--surface-2)" }

/** Belt-and-suspenders: this panel is a non-critical add-on to the recon
 *  drawer. If it ever throws, it must NEVER take the whole reconciliation
 *  screen down with it — contain the error to a quiet one-line notice. */
export function ClientRequestsPanel(props: {
  qboAccountId: string
  periodEnd: string
  accountLabel?: string
  readOnly?: boolean
}) {
  return (
    <ErrorBoundary
      label="client requests"
      fallback={
        <div className="rounded-lg p-3 text-[11px]"
          style={{ background: "var(--surface-2)", border: "1px solid var(--border)", color: "var(--text-muted)" }}>
          Client requests couldn't load right now. Your reconciliation is unaffected — reload to try again.
        </div>
      }
    >
      <ClientRequestsPanelInner {...props} />
    </ErrorBoundary>
  )
}

function ClientRequestsPanelInner({ qboAccountId, periodEnd, accountLabel, readOnly }: {
  qboAccountId: string
  periodEnd: string
  accountLabel?: string
  readOnly?: boolean
}) {
  const qc = useQueryClient()
  const key = ["pbc-requests", qboAccountId, periodEnd]
  const { data: requests = [] } = useQuery({
    queryKey: key,
    queryFn: () => pbcApi.listRequests({ qbo_account_id: qboAccountId, period_end: periodEnd }),
    staleTime: 30_000,
  })

  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState("")
  const [title, setTitle] = useState("")
  const [note, setNote] = useState("")
  const [err, setErr] = useState<string | null>(null)

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: key })
    void qc.invalidateQueries({ queryKey: ["pbc-requests"] })
  }

  const createMut = useMutation({
    mutationFn: () => pbcApi.createRequest({
      qbo_account_id: qboAccountId,
      period_end: periodEnd,
      title: title.trim(),
      note: note.trim() || undefined,
      account_label: accountLabel,
      recipient_email: email.trim(),
    }),
    onSuccess: () => { setOpen(false); setEmail(""); setTitle(""); setNote(""); setErr(null); invalidate() },
    onError: (e: unknown) => {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setErr(detail ?? "Could not send the request. Try again.")
    },
  })
  const remindMut = useMutation({ mutationFn: pbcApi.remindRequest, onSettled: invalidate })
  const cancelMut = useMutation({ mutationFn: pbcApi.cancelRequest, onSettled: invalidate })

  const defaultTitle = `${accountLabel ?? "Account"} — ${new Date(periodEnd + "T00:00:00")
    .toLocaleDateString(undefined, { month: "long", year: "numeric" })} statement`

  const canSend = title.trim().length >= 3 && email.includes("@")

  // This panel lives inside the recon drawer's <form onSubmit={save}>. Without
  // this guard, pressing Enter in a field would submit THAT form and flip the
  // account to Prepared. Swallow Enter here and route it to "send" instead.
  const onFieldKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault()
      if (canSend && !createMut.isPending) createMut.mutate()
    }
  }

  return (
    <div className="rounded-lg p-3 space-y-2.5"
      style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider inline-flex items-center gap-1.5"
          style={{ color: "var(--text-muted)" }}>
          <Mail size={11} strokeWidth={2} /> Client requests
        </p>
        {!readOnly && !open && (
          <button
            type="button"
            onClick={() => { setOpen(true); if (!title) setTitle(defaultTitle) }}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold transition-opacity hover:opacity-90"
            style={{ background: "var(--green)", color: "white" }}
          >
            <Plus size={11} strokeWidth={2.4} /> Request from client
          </button>
        )}
      </div>

      {/* Inline create form — no modal hop; the drawer is the context */}
      {open && (
        <div className="rounded-lg p-3 space-y-2"
          style={{ background: "var(--surface)", border: "1px solid var(--border-strong)" }}>
          <input
            value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={onFieldKey}
            placeholder="What do you need? e.g. March 2026 Chase bank statement"
            className="w-full rounded-md px-2.5 py-1.5 text-xs outline-none"
            style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }}
          />
          <input
            value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={onFieldKey} type="email"
            placeholder="Client's email address"
            className="w-full rounded-md px-2.5 py-1.5 text-xs outline-none"
            style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }}
          />
          <textarea
            value={note} onChange={(e) => setNote(e.target.value)} rows={2}
            placeholder="Optional note to the client…"
            className="w-full rounded-md px-2.5 py-1.5 text-xs outline-none resize-none"
            style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }}
          />
          {err && <p className="text-[11px] font-medium" style={{ color: "#9b3d37" }}>{err}</p>}
          <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={() => { setOpen(false); setErr(null) }}
              className="text-[11px] font-semibold px-2 py-1" style={{ color: "var(--text-muted)" }}>
              Cancel
            </button>
            <button
              type="button"
              onClick={() => createMut.mutate()}
              disabled={createMut.isPending || !canSend}
              className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] font-bold transition-opacity hover:opacity-90 disabled:opacity-50"
              style={{ background: "var(--green)", color: "white" }}
            >
              {createMut.isPending ? <Spinner className="h-3 w-3" /> : <Mail size={11} strokeWidth={2.2} />}
              Send magic link
            </button>
          </div>
          <p className="text-[10px]" style={{ color: "var(--text-muted)" }}>
            The client gets a secure upload link — no account needed. Files land
            here as evidence automatically. Link expires in 14 days.
          </p>
        </div>
      )}

      {/* Request list */}
      {requests.length === 0 && !open && (
        <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
          No requests yet — ask the client for a statement or invoice and it
          lands here as evidence, untouched by your inbox.
        </p>
      )}
      {(Array.isArray(requests) ? requests : []).map((r) => {
        // Defensive: never let an unexpected status or missing files array
        // throw — that would blank the whole recon screen.
        const meta = STATUS_META[r.status] ?? FALLBACK_META
        const fileCount = Array.isArray(r.files) ? r.files.length : 0
        return (
          <div key={r.id} className="rounded-lg px-3 py-2 flex items-center gap-2.5 flex-wrap"
            style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
            <div className="flex-1 min-w-[140px]">
              <p className="text-xs font-semibold truncate" style={{ color: "var(--text)" }} title={r.title}>
                {r.title}
              </p>
              <p className="text-[10.5px] mt-0.5 truncate" style={{ color: "var(--text-muted)" }}>
                {r.recipient_email}
                {fileCount > 0 && ` · ${fileCount} file${fileCount === 1 ? "" : "s"} received`}
              </p>
            </div>
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap"
              style={{ color: meta.fg, background: meta.bg }}>
              {meta.label}
            </span>
            {!readOnly && r.status === "pending" && (
              <>
                <button type="button" title="Resend the email (mints a fresh link)"
                  onClick={() => remindMut.mutate(r.id)} disabled={remindMut.isPending}
                  className="h-6 w-6 rounded-md inline-flex items-center justify-center hover:bg-[var(--surface-2)]"
                  style={{ color: "var(--text-muted)" }}>
                  <RefreshCw size={11} strokeWidth={2} className={remindMut.isPending ? "animate-spin" : ""} />
                </button>
                <button type="button" title="Cancel this request"
                  onClick={() => cancelMut.mutate(r.id)} disabled={cancelMut.isPending}
                  className="h-6 w-6 rounded-md inline-flex items-center justify-center hover:bg-[var(--surface-2)]"
                  style={{ color: "var(--text-muted)" }}>
                  <X size={11} strokeWidth={2} />
                </button>
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}
