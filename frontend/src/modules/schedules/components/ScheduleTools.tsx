/**
 * Schedule tools — the "what belongs on this schedule that isn't here yet?"
 * surface.
 *
 * These used to be two cards in a permanently sticky 320px right rail: import
 * from QuickBooks, and let AI scan the GL. Between them they held a fifth of
 * the page for work that happens once at setup and occasionally after — and
 * they squeezed the items table into 876px, which is less than any of the five
 * schedules needs, so every page scrolled horizontally all the time.
 *
 * Three pieces replace it:
 *
 *   ToolsButton    a header control that opens the tools in a slide-over, so
 *                  they stay one click away and occupy nothing
 *   ToolsDrawer    the slide-over itself; the existing cards go in unchanged
 *   FindingsStrip  one thin line above the table, and ONLY when there is
 *                  something to say
 *
 * The strip is the point. A permanent "Scan GL for prepaids" button asks the
 * user to remember to go looking; a strip that reads "3 transactions look like
 * prepaids" tells them what was found. Zero findings renders zero pixels.
 *
 * It costs nothing to show: candidates come from the LIST endpoint, which
 * reads what a previous scan already stored and never re-runs the detector.
 * Running a scan stays an explicit click, which is the trigger model this
 * feature was designed with — the strip surfaces the result of that decision
 * rather than reversing it.
 */
import { useEffect, type ReactNode } from "react"
import { AnimatePresence, motion } from "framer-motion"
import { ChevronRight, Sparkles, Wrench, X } from "lucide-react"
import { Button } from "@/core/ui/components"

// ── Header trigger ───────────────────────────────────────────────────────────

export function ToolsButton({ onClick, badge }: { onClick: () => void; badge?: number }) {
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={onClick}
      icon={<Wrench size={14} strokeWidth={2} />}
      title="Import from QuickBooks, or scan the ledger for items you're missing"
    >
      Find items
      {!!badge && badge > 0 && (
        <span
          className="ml-1.5 inline-flex items-center justify-center rounded-full px-1.5 h-[15px] text-[10px] font-bold"
          style={{ background: "var(--green)", color: "white" }}
        >
          {badge}
        </span>
      )}
    </Button>
  )
}

// ── Slide-over ───────────────────────────────────────────────────────────────

export function ToolsDrawer({
  open, onClose, title, children,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
}) {
  // Escape closes. A drawer that traps the user is worse than a rail.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onClose])

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="fixed inset-0 z-40"
            style={{ background: "rgba(14, 17, 18, 0.28)" }}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={onClose}
          />
          <motion.aside
            className="fixed right-0 top-0 bottom-0 z-50 w-full sm:w-[420px] flex flex-col"
            style={{ background: "var(--surface)", borderLeft: "1px solid var(--border-strong)" }}
            initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }}
            transition={{ type: "tween", duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            role="dialog" aria-modal="true" aria-label={title}
          >
            <div className="px-4 py-3 flex items-center gap-2 shrink-0"
              style={{ borderBottom: "1px solid var(--border)" }}>
              <Sparkles size={14} strokeWidth={1.9} style={{ color: "var(--green)" }} />
              <h2 className="text-sm font-semibold flex-1" style={{ color: "var(--text)" }}>
                {title}
              </h2>
              <button onClick={onClose} aria-label="Close"
                className="h-7 w-7 inline-flex items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-2)]"
                style={{ color: "var(--text-muted)" }}>
                <X size={14} strokeWidth={2} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-4">{children}</div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  )
}

// ── Findings strip ───────────────────────────────────────────────────────────

/**
 * One line above the table. Renders nothing when there is nothing to report,
 * which is the whole design: a screen that only speaks when it has something
 * to say gets believed when it does.
 */
export function FindingsStrip({
  count, noun, periodLabel, onReview, onScan, scanned, scanning,
}: {
  /** Open candidates a previous scan already found. */
  count: number
  /** "prepaid" / "accrual" — pluralised for the message. */
  noun: string
  /** e.g. "February 2026". */
  periodLabel: string
  onReview: () => void
  /** Omit to hide the scan affordance entirely (schedule types with no detector). */
  onScan?: () => void
  /** Whether this period has been scanned at all. */
  scanned: boolean
  scanning?: boolean
}) {
  if (count > 0) {
    return (
      <button
        onClick={onReview}
        className="w-full rounded-lg px-3 py-2 flex items-center gap-2 text-left transition-opacity hover:opacity-90"
        style={{ background: "var(--green-subtle)", border: "1px solid rgba(46, 122, 85, 0.28)" }}
      >
        <Sparkles size={13} strokeWidth={2} style={{ color: "var(--green)" }} className="shrink-0" />
        <span className="text-[12.5px] flex-1" style={{ color: "var(--text)" }}>
          <strong>{count} transaction{count === 1 ? "" : "s"}</strong> in {periodLabel}{" "}
          {count === 1
            ? `looks like a ${noun} that isn't`
            : `look like ${noun}s that aren't`} on this schedule.
        </span>
        <span className="text-[11px] font-bold inline-flex items-center gap-0.5 shrink-0"
          style={{ color: "var(--green)" }}>
          Review <ChevronRight size={11} strokeWidth={2.6} />
        </span>
      </button>
    )
  }

  // Scanned and clean — say so once, quietly. Silence here reads as "the
  // feature didn't run", which is the thing that makes people stop trusting it.
  if (scanned) {
    return (
      <p className="text-[11.5px] px-1" style={{ color: "var(--text-muted)" }}>
        Nothing missed in {periodLabel} — the ledger was scanned and every{" "}
        {noun} it found is already here.
      </p>
    )
  }

  if (!onScan) return null

  return (
    <button
      onClick={onScan}
      disabled={scanning}
      className="text-[11.5px] px-1 inline-flex items-center gap-1.5 transition-opacity hover:opacity-80 disabled:opacity-60"
      style={{ color: "var(--text-muted)" }}
    >
      <Sparkles size={12} strokeWidth={2} style={{ color: "var(--green)" }} />
      {scanning
        ? `Scanning ${periodLabel}…`
        : `Scan ${periodLabel} for ${noun}s you may have missed`}
    </button>
  )
}
