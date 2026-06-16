/**
 * "Mark recurring" — captures a reconciling item as a confirm-first Client Memory
 * fact (Slice C). Shown on manual reconciling items in the build-up (deposits in
 * transit, outstanding checks, unposted JEs — the timing differences that recur).
 *
 * Creates a SUGGESTED fact only; a reviewer confirms it in Settings → Memory,
 * after which next period's recon SUGGESTS it (never auto-adds). Self-contained:
 * owns its popover, mutation, and saved state so the host build-up stays simple.
 */
import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Repeat, Check } from "lucide-react"
import { reconsApi, type ReconcilingItem } from "@/modules/recons/api"

// The item's memo is the human label, but schedule-sourced memos carry a
// period-specific suffix ("… · unamortized as of 4/30"); keep the leading,
// stable part as the default recurring label.
function defaultLabel(item: ReconcilingItem): string {
  const base = (item.memo || item.txn_type || "Recurring item").split(" · ")[0].trim()
  return base.slice(0, 120)
}

export function MarkRecurringButton({ qboAccountId, periodEnd, accountName, item }: {
  qboAccountId: string
  periodEnd:    string
  accountName?: string
  item:         ReconcilingItem
}) {
  const [open, setOpen] = useState(false)
  const [label, setLabel] = useState(() => defaultLabel(item))
  const [saved, setSaved] = useState(false)
  const qc = useQueryClient()

  const mut = useMutation({
    mutationFn: () => reconsApi.saveRecurringReconcilingItem(qboAccountId, {
      period_end: periodEnd,
      label: label.trim(),
      txn_type: item.txn_type,
      amount: item.amount,
      entity: item.entity,
      account_name: accountName,
    }),
    // Refresh the Settings → Memory badge — a new suggested fact was created.
    onSuccess: () => { setSaved(true); setOpen(false); void qc.invalidateQueries({ queryKey: ["memory-facts"] }) },
  })

  if (saved) {
    return (
      <span className="inline-flex items-center gap-0.5 text-[9px] font-bold uppercase px-1 py-0.5 rounded"
        title="Saved as a suggestion — confirm it in Settings → Memory"
        style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
        <Check size={10} strokeWidth={2.6} /> Saved
      </span>
    )
  }

  return (
    <span className="relative inline-block">
      <button type="button" title="Mark as recurring (learn for future periods)"
        onClick={() => setOpen((o) => !o)}
        className="h-5 w-5 inline-flex items-center justify-center rounded"
        style={{ color: "var(--text-muted)" }}>
        <Repeat size={11} strokeWidth={1.8} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-1 w-60 rounded-lg p-2.5"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
            <p className="text-[10px] font-semibold uppercase tracking-wide mb-1" style={{ color: "var(--text-muted)" }}>
              Mark recurring
            </p>
            <input
              value={label} onChange={(e) => setLabel(e.target.value)} autoFocus
              placeholder="Label (e.g. In-transit deposits)"
              className="w-full rounded-md px-2 py-1 text-[12px] outline-none mb-1.5"
              style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }}
              onKeyDown={(e) => { if (e.key === "Enter" && label.trim() && !mut.isPending) mut.mutate() }}
            />
            {mut.isError && (
              <p className="text-[10px] mb-1" style={{ color: "var(--danger)" }}>
                Couldn't save — try again.
              </p>
            )}
            <div className="flex items-center gap-1.5">
              <button type="button" disabled={!label.trim() || mut.isPending}
                onClick={() => mut.mutate()}
                className="rounded-md px-2.5 py-1 text-[11px] font-bold text-white disabled:opacity-50"
                style={{ background: "var(--green)" }}>
                {mut.isPending ? "Saving…" : "Save"}
              </button>
              <button type="button" onClick={() => setOpen(false)}
                className="rounded-md px-2 py-1 text-[11px] font-semibold"
                style={{ border: "1px solid var(--border-strong)", color: "var(--text-2)" }}>
                Cancel
              </button>
            </div>
            <p className="text-[9px] mt-1.5" style={{ color: "var(--text-muted)" }}>
              Creates a suggestion — a reviewer confirms it in Settings → Memory before it's offered next period.
            </p>
          </div>
        </>
      )}
    </span>
  )
}
