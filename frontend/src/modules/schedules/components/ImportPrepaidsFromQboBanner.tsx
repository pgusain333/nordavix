/**
 * ImportPrepaidsFromQboBanner — first-month onboarding helper.
 *
 * Appears on PrepaidsPage when the user has selected a prepaid asset
 * GL account and has ZERO existing schedule items for that account
 * (i.e. they're just starting). Offers to pull the last 12 months of
 * GL transactions hitting that account and bulk-create a
 * SchedulePrepaid per debit, with sensible defaults the user can
 * refine afterward.
 *
 * Flow:
 *   1) Click "Import from QBO" → calls the preview endpoint
 *   2) Modal shows the proposed item list with a clear "Import N items"
 *      button (or "Cancel" to bail)
 *   3) On confirm → calls the real import endpoint, invalidates the
 *      items list, closes the modal
 *
 * Dedup is server-side (existing items on the same account with
 * matching description+amount+start_date are skipped), so re-running
 * the import doesn't duplicate. The banner stays visible until the
 * user has items in this account — once items exist it disappears
 * to avoid clutter; they can still re-import via a smaller secondary
 * button if needed.
 */
import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { motion, AnimatePresence } from "framer-motion"
import { Download, X, AlertCircle, CheckCircle2 } from "lucide-react"

import { Button, Spinner } from "@/core/ui/components"
import { formatDate } from "@/core/lib/dates"
import { schedulesApi } from "@/modules/schedules/api"
import type { PrepaidImportPreview } from "@/modules/schedules/api"

interface Props {
  /** Selected prepaid asset GL account on the page filter. Banner is
   *  hidden when null/empty — there's nothing to import against. */
  qboAccountId: string
  /** Existing item count for this account. The banner shows as a big
   *  CTA when this is 0 (first-month onboarding) and as a smaller
   *  secondary action when > 0 (additional imports of new txns). */
  existingItemCount: number
}

export function ImportPrepaidsFromQboBanner({ qboAccountId, existingItemCount }: Props) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<PrepaidImportPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lookbackMonths, setLookbackMonths] = useState(12)

  const previewMut = useMutation({
    mutationFn: () => schedulesApi.previewImportPrepaidFromQbo(qboAccountId, lookbackMonths),
    onSuccess: (data) => { setPreview(data); setError(null); setOpen(true) },
    onError:   (e: unknown) => {
      const msg = (e as { response?: { data?: { detail?: string } } }).response?.data?.detail
      setError(msg ?? "Couldn't preview the import — try again.")
    },
  })

  const importMut = useMutation({
    mutationFn: () => schedulesApi.importPrepaidsFromQbo(qboAccountId, lookbackMonths),
    onSuccess: () => {
      setOpen(false)
      setPreview(null)
      setError(null)
      qc.invalidateQueries({ queryKey: ["schedules", "prepaid"] })
    },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { detail?: string } } }).response?.data?.detail
      setError(msg ?? "Import failed — try again.")
    },
  })

  // Hide entirely if no account is picked yet — the import is account-scoped.
  if (!qboAccountId) return null

  const isFirstTime = existingItemCount === 0

  return (
    <>
      <motion.div
        initial={{ opacity: 0, y: -6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
        className="rounded-xl overflow-hidden"
        style={{
          background: isFirstTime ? "rgba(29, 78, 216, 0.04)" : "var(--surface)",
          border: `1px solid ${isFirstTime ? "rgba(29, 78, 216, 0.30)" : "var(--border)"}`,
        }}
      >
        <div className="px-4 py-3 flex items-center gap-3 flex-wrap">
          <span className="h-7 w-7 rounded-lg inline-flex items-center justify-center shrink-0"
            style={{ background: "rgba(29, 78, 216, 0.12)", color: "#1d4ed8" }}>
            <Download size={13} strokeWidth={2} />
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold" style={{ color: "var(--text)" }}>
              {isFirstTime
                ? "First time using Nordavix for prepaids? Import what's already in QBO."
                : "Import additional prepaids from QBO"}
            </p>
            <p className="text-[11px] mt-0.5" style={{ color: "var(--text-muted)" }}>
              Pulls every debit posted to this account in the last {lookbackMonths} months
              and creates a Nordavix prepaid item for each — vendor, amount, and dates
              pre-filled from the QBO transaction. You can edit the term, method,
              and amounts on each row after import.
            </p>
          </div>
          {error && (
            <span className="text-[11px]" style={{ color: "#b91c1c" }}>
              {error}
            </span>
          )}
          <Button
            size="sm"
            variant={isFirstTime ? undefined : "outline"}
            onClick={() => previewMut.mutate()}
            loading={previewMut.isPending}
            disabled={previewMut.isPending}
          >
            {previewMut.isPending ? "Loading…" : "Import from QBO"}
          </Button>
        </div>
      </motion.div>

      <AnimatePresence>
        {open && preview && (
          <PreviewDialog
            preview={preview}
            importing={importMut.isPending}
            error={importMut.isError ? error : null}
            lookbackMonths={lookbackMonths}
            onLookbackChange={(n) => { setLookbackMonths(n); previewMut.mutate() }}
            onConfirm={() => importMut.mutate()}
            onClose={() => {
              if (importMut.isPending) return
              setOpen(false)
              setPreview(null)
              setError(null)
            }}
          />
        )}
      </AnimatePresence>
    </>
  )
}


// ── Preview dialog ────────────────────────────────────────────────────

function PreviewDialog({
  preview, importing, error, lookbackMonths, onLookbackChange, onConfirm, onClose,
}: {
  preview:          PrepaidImportPreview
  importing:        boolean
  error:            string | null
  lookbackMonths:   number
  onLookbackChange: (n: number) => void
  onConfirm:        () => void
  onClose:          () => void
}) {
  const fmt = (s: string | null | undefined): string => {
    const n = parseFloat(s ?? "0") || 0
    return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.6)" }}
      onClick={onClose}>
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
        className="rounded-2xl max-w-3xl w-full max-h-[88vh] flex flex-col"
        style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>

        {/* Header */}
        <div className="px-6 py-4 flex items-start justify-between gap-3"
          style={{ borderBottom: "1px solid var(--border)" }}>
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-theme">Import prepaids from QuickBooks</h3>
            <p className="text-[11px] mt-0.5" style={{ color: "var(--text-muted)" }}>
              {preview.would_create} {preview.would_create === 1 ? "item" : "items"} ready to import
              {preview.skipped > 0 && (
                <>
                  {" · "}
                  <span style={{ color: "#b45309" }}>{preview.skipped} skipped (already exist)</span>
                </>
              )}
            </p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--surface-2)]"
            disabled={importing}>
            <X size={16} strokeWidth={1.8} style={{ color: "var(--text-muted)" }} />
          </button>
        </div>

        {/* Lookback control */}
        <div className="px-6 py-3 flex items-center gap-3 flex-wrap"
          style={{ background: "var(--surface-2)", borderBottom: "1px solid var(--border)" }}>
          <span className="text-[11px] font-semibold uppercase tracking-wider"
            style={{ color: "var(--text-muted)" }}>
            Look back
          </span>
          {[6, 12, 18, 24].map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => onLookbackChange(m)}
              disabled={importing}
              className="px-2.5 py-1 rounded-md text-[11px] font-semibold transition-all"
              style={{
                background: m === lookbackMonths ? "var(--text)" : "white",
                color:      m === lookbackMonths ? "var(--surface)" : "var(--text-2)",
                border: "1px solid var(--border)",
              }}>
              {m} mo
            </button>
          ))}
          <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
            Adjust the lookback window if some older items aren't showing.
          </span>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {preview.items.length === 0 ? (
            <div className="py-12 px-6 text-center">
              <p className="text-sm font-semibold text-theme mb-1">Nothing to import</p>
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                No new debits were found on this account in the last {lookbackMonths} months
                that aren't already in Nordavix. Try widening the lookback above.
              </p>
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead className="sticky top-0" style={{ background: "var(--surface-2)" }}>
                <tr>
                  <Th>Description</Th>
                  <Th>Vendor</Th>
                  <Th>Invoice date</Th>
                  <Th right>Total</Th>
                  <Th>Coverage</Th>
                </tr>
              </thead>
              <tbody>
                {preview.items.map((it, i) => (
                  <tr key={i} style={{ borderTop: "1px solid var(--border)" }}>
                    <td className="px-3 py-2 text-theme">
                      <div className="font-medium">{it.description}</div>
                      {it.reference && (
                        <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                          Ref: {it.reference}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2" style={{ color: "var(--text-2)" }}>
                      {it.vendor ?? "—"}
                    </td>
                    <td className="px-3 py-2" style={{ color: "var(--text-2)" }}>
                      {it.invoice_date ? formatDate(it.invoice_date) : "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums font-semibold text-theme">
                      {fmt(it.total_amount)}
                    </td>
                    <td className="px-3 py-2 text-[11px]" style={{ color: "var(--text-2)" }}>
                      {it.start_date} → {it.end_date}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 flex items-center justify-between gap-2 flex-wrap"
          style={{ borderTop: "1px solid var(--border)", background: "var(--surface-2)" }}>
          <div className="flex items-center gap-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
            {error ? (
              <span className="inline-flex items-center gap-1" style={{ color: "#b91c1c" }}>
                <AlertCircle size={11} strokeWidth={2} />
                {error}
              </span>
            ) : preview.items.length > 0 ? (
              <span className="inline-flex items-center gap-1">
                <CheckCircle2 size={11} strokeWidth={2} />
                Defaults: 12-month straight-line term from each item's date. Edit individual
                rows after import for non-standard terms.
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={onClose} disabled={importing}>
              Cancel
            </Button>
            {preview.items.length > 0 && (
              <Button size="sm" loading={importing} onClick={onConfirm}>
                {importing
                  ? "Importing…"
                  : <>{importing ? <Spinner className="h-3 w-3" /> : <Download size={11} strokeWidth={2} />} Import {preview.would_create} {preview.would_create === 1 ? "item" : "items"}</>}
              </Button>
            )}
          </div>
        </div>
      </motion.div>
    </motion.div>
  )
}

function Th({ children, right }: { children?: React.ReactNode; right?: boolean }) {
  return (
    <th className={`px-3 py-2 text-[10px] font-semibold uppercase tracking-wide ${right ? "text-right" : "text-left"}`}
      style={{ color: "var(--text-muted)" }}>
      {children}
    </th>
  )
}
