/**
 * ImportScheduleFromQboBanner — generic onboarding helper for Accruals,
 * Fixed Assets, and Loans. The Prepaid case has its own dedicated
 * banner (ImportPrepaidsFromQboBanner.tsx) — that one shipped first and
 * we left it alone to avoid risk on a known-working surface.
 *
 * Pattern matches the prepaid banner exactly:
 *   - Renders only when a qbo_account_id is selected on the page filter
 *   - Big blue CTA when existingItemCount === 0; subtler secondary
 *     when items exist (additional imports of new GL txns)
 *   - Click → preview → modal with proposed items + lookback control
 *     → Confirm → real import → invalidate the list query
 *
 * Each schedule type passes its own `config` prop with the right copy,
 * defaults, query key, and preview-table column renderers.
 */
import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { motion, AnimatePresence } from "framer-motion"
import { Download, X, AlertCircle, CheckCircle2 } from "lucide-react"

import { Button, Spinner } from "@/core/ui/components"

// ── Per-type configuration ────────────────────────────────────────────

export interface ImportBannerConfig<Preview, Result> {
  /** Singular noun used in copy: "accrual" | "fixed asset" | "loan". */
  noun:        string
  /** Plural noun: "accruals" | "fixed assets" | "loans". */
  nounPlural:  string
  /** Default lookback in months for the initial preview. */
  defaultLookback: number
  /** Which lookback chips show in the modal. */
  lookbackChoices: number[]
  /** One-line description in the banner subheading. */
  blurb:       string
  /** One-line hint at the bottom of the preview modal. */
  defaultsHint: string
  /** React-Query key prefix for invalidation on import success. */
  queryKey:    readonly unknown[]
  /** Preview fetcher (preview_only: true). */
  preview:     (qboAccountId: string, lookbackMonths: number) => Promise<Preview>
  /** Real import (preview_only: false). */
  doImport:    (qboAccountId: string, lookbackMonths: number) => Promise<Result>
  /** Render the preview table — type-specific columns. */
  renderTable: (preview: Preview) => React.ReactNode
  /** Read `would_create` off the preview union (it's the same field on all 3). */
  wouldCreate: (p: Preview) => number
  /** Read `skipped` off the preview. */
  skipped:     (p: Preview) => number
  /** Read item count off the preview (for the "Nothing to import" empty state). */
  itemCount:   (p: Preview) => number
}

interface Props<Preview, Result> {
  /** Selected GL account on the page filter. Banner hidden when null/empty. */
  qboAccountId:      string
  /** Items already on this page (account). Affects "first-time" vs "additional" copy. */
  existingItemCount: number
  /** Per-type config. */
  config:            ImportBannerConfig<Preview, Result>
}

export function ImportScheduleFromQboBanner<Preview, Result>({
  qboAccountId, existingItemCount, config,
}: Props<Preview, Result>) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lookbackMonths, setLookbackMonths] = useState(config.defaultLookback)

  const previewMut = useMutation({
    mutationFn: () => config.preview(qboAccountId, lookbackMonths),
    onSuccess: (data) => { setPreview(data); setError(null); setOpen(true) },
    onError:   (e: unknown) => {
      const msg = (e as { response?: { data?: { detail?: string } } }).response?.data?.detail
      setError(msg ?? `Couldn't preview the import — try again.`)
    },
  })

  const importMut = useMutation({
    mutationFn: () => config.doImport(qboAccountId, lookbackMonths),
    onSuccess: () => {
      setOpen(false); setPreview(null); setError(null)
      qc.invalidateQueries({ queryKey: config.queryKey })
    },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { detail?: string } } }).response?.data?.detail
      setError(msg ?? "Import failed — try again.")
    },
  })

  if (!qboAccountId) return null
  const isFirstTime = existingItemCount === 0

  return (
    <>
      <motion.div
        initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}
        className="rounded-xl overflow-hidden"
        style={{
          background: isFirstTime ? "rgba(29, 78, 216, 0.04)" : "var(--surface)",
          border: `1px solid ${isFirstTime ? "rgba(29, 78, 216, 0.30)" : "var(--border)"}`,
        }}>
        <div className="px-4 py-3 flex items-center gap-3 flex-wrap">
          <span className="h-7 w-7 rounded-lg inline-flex items-center justify-center shrink-0"
            style={{ background: "rgba(29, 78, 216, 0.12)", color: "#1d4ed8" }}>
            <Download size={13} strokeWidth={2} />
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold" style={{ color: "var(--text)" }}>
              {isFirstTime
                ? `First time using Nordavix for ${config.nounPlural}? Import what's already in QBO.`
                : `Import additional ${config.nounPlural} from QBO`}
            </p>
            <p className="text-[11px] mt-0.5" style={{ color: "var(--text-muted)" }}>
              {config.blurb.replace("{lookback}", String(lookbackMonths))}
            </p>
          </div>
          {error && (
            <span className="text-[11px]" style={{ color: "#b91c1c" }}>{error}</span>
          )}
          <Button size="sm" variant={isFirstTime ? undefined : "outline"}
            onClick={() => previewMut.mutate()} loading={previewMut.isPending} disabled={previewMut.isPending}>
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
            lookbackChoices={config.lookbackChoices}
            noun={config.noun}
            defaultsHint={config.defaultsHint}
            wouldCreate={config.wouldCreate(preview)}
            skippedCount={config.skipped(preview)}
            itemCount={config.itemCount(preview)}
            table={config.renderTable(preview)}
            onLookbackChange={(n) => { setLookbackMonths(n); previewMut.mutate() }}
            onConfirm={() => importMut.mutate()}
            onClose={() => { if (!importMut.isPending) { setOpen(false); setPreview(null); setError(null) } }}
          />
        )}
      </AnimatePresence>
    </>
  )
}


// ── Preview dialog ────────────────────────────────────────────────────

function PreviewDialog({
  importing, error, lookbackMonths, lookbackChoices, noun, defaultsHint,
  wouldCreate, skippedCount, itemCount, table,
  onLookbackChange, onConfirm, onClose,
}: {
  preview:          unknown
  importing:        boolean
  error:            string | null
  lookbackMonths:   number
  lookbackChoices:  number[]
  noun:             string
  defaultsHint:     string
  wouldCreate:      number
  skippedCount:     number
  itemCount:        number
  table:            React.ReactNode
  onLookbackChange: (n: number) => void
  onConfirm:        () => void
  onClose:          () => void
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.6)" }}
      onClick={onClose}>
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
        className="rounded-2xl max-w-3xl w-full max-h-[88vh] flex flex-col"
        style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>

        <div className="px-6 py-4 flex items-start justify-between gap-3"
          style={{ borderBottom: "1px solid var(--border)" }}>
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-theme">Import {noun}s from QuickBooks</h3>
            <p className="text-[11px] mt-0.5" style={{ color: "var(--text-muted)" }}>
              {wouldCreate} {wouldCreate === 1 ? "item" : "items"} ready to import
              {skippedCount > 0 && (
                <>{" · "}<span style={{ color: "#b45309" }}>{skippedCount} skipped (already exist)</span></>
              )}
            </p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--surface-2)]" disabled={importing}>
            <X size={16} strokeWidth={1.8} style={{ color: "var(--text-muted)" }} />
          </button>
        </div>

        <div className="px-6 py-3 flex items-center gap-3 flex-wrap"
          style={{ background: "var(--surface-2)", borderBottom: "1px solid var(--border)" }}>
          <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
            Look back
          </span>
          {lookbackChoices.map((m) => (
            <button key={m} type="button" onClick={() => onLookbackChange(m)} disabled={importing}
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
            Adjust the lookback window if older items aren't showing.
          </span>
        </div>

        <div className="flex-1 overflow-y-auto">
          {itemCount === 0 ? (
            <div className="py-12 px-6 text-center">
              <p className="text-sm font-semibold text-theme mb-1">Nothing to import</p>
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                No new {noun} transactions were found on this account in the last {lookbackMonths} months
                that aren't already in Nordavix. Try widening the lookback above.
              </p>
            </div>
          ) : table}
        </div>

        <div className="px-6 py-3 flex items-center justify-between gap-2 flex-wrap"
          style={{ borderTop: "1px solid var(--border)", background: "var(--surface-2)" }}>
          <div className="flex items-center gap-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
            {error ? (
              <span className="inline-flex items-center gap-1" style={{ color: "#b91c1c" }}>
                <AlertCircle size={11} strokeWidth={2} />{error}
              </span>
            ) : itemCount > 0 ? (
              <span className="inline-flex items-center gap-1">
                <CheckCircle2 size={11} strokeWidth={2} />{defaultsHint}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={onClose} disabled={importing}>Cancel</Button>
            {itemCount > 0 && (
              <Button size="sm" loading={importing} onClick={onConfirm}>
                {importing
                  ? "Importing…"
                  : <>{importing ? <Spinner className="h-3 w-3" /> : <Download size={11} strokeWidth={2} />} Import {wouldCreate} {wouldCreate === 1 ? "item" : "items"}</>}
              </Button>
            )}
          </div>
        </div>
      </motion.div>
    </motion.div>
  )
}


// ── Shared table helpers ──────────────────────────────────────────────

// Renamed `Th` to `ImportTh` so the pages can keep their existing
// per-page Th helpers without name collision. The pages also already
// import formatDate from @/core/lib/dates; we don't re-export it.
export function ImportTh({ children, right }: { children?: React.ReactNode; right?: boolean }) {
  return (
    <th className={`px-3 py-2 text-[10px] font-semibold uppercase tracking-wide ${right ? "text-right" : "text-left"}`}
      style={{ color: "var(--text-muted)" }}>
      {children}
    </th>
  )
}

export function importMoneyFmt(s: string | null | undefined): string {
  const n = parseFloat(s ?? "0") || 0
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
