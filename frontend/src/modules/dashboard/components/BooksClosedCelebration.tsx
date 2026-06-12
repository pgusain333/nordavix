/**
 * BooksClosedCelebration — the "moment of pride" screen that fires
 * the instant a controller closes a period.
 *
 * Why this exists: traditional close software shows a green toast and
 * moves on. We turn the same moment into a designed, branded card the
 * controller is naturally inclined to screenshot + share. Every share
 * is a free marketing impression — the user's screenshot is our sales
 * page.
 *
 * The card is designed to be screenshottable in three senses:
 *   1. One message, one number — "MAY 2026 IS CLOSED" is the headline,
 *      stats are supporting evidence, not the lede.
 *   2. Self-explanatory out of context — a stranger seeing the
 *      screenshot in a Slack DM still gets it.
 *   3. Branded but not loud — the wordmark sits at the bottom like a
 *      magazine credit, not a watermark.
 *
 * The Save Image button uses html2canvas via dynamic import so the
 * library (~25 KB) is only fetched the moment the user clicks save —
 * doesn't bloat the main bundle.
 */
import { useEffect, useRef, useState } from "react"
import { AnimatePresence, motion } from "framer-motion"
import { CheckCircle2, Download, X } from "lucide-react"
import { Button, Spinner } from "@/core/ui/components"

interface Stats {
  reconsTied:    number
  totalAccounts: number
  aiAssisted:    number
  /** Total reconciling items ticked across every account — the
   *  concrete "work done" number we actually track. Was "auditReady"
   *  earlier but that's a feature we haven't built yet. */
  itemsMatched:  number
}

interface Props {
  /** Open/close toggle from the parent. */
  open:        boolean
  /** Human-readable month label, e.g. "May 2026". */
  monthLabel:  string
  /** ISO period_end the close was for, e.g. "2026-05-31". Used in the
   *  downloaded filename so screenshots are dateable. */
  periodEnd:   string
  /** Stats captured at the moment of close. */
  stats:       Stats
  /** First name (or full name) of the user who closed. Personalizes
   *  the "Nice work, ___." line. */
  userName?:   string | null
  /** Workspace / company name shown above the headline. Anchors the
   *  card to the specific company so screenshots aren't anonymous. */
  companyName?: string | null
  /** Called when the user dismisses the card. */
  onClose:     () => void
}

export function BooksClosedCelebration({
  open, monthLabel, periodEnd, stats, userName, companyName, onClose,
}: Props) {
  // Ref to the card itself — html2canvas captures from this node.
  const cardRef = useRef<HTMLDivElement>(null)
  const [savingImage, setSavingImage] = useState(false)

  // Escape to close. Aria-modal so screen readers know to trap focus.
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open, onClose])

  /**
   * Capture the card as a PNG and prompt download. html2canvas is
   * dynamically imported here so the library isn't pulled into the
   * main bundle — only the user who clicks Save pays the ~25 KB cost,
   * and only once per session (browser caches the chunk).
   *
   * Scale 2 so the saved image looks crisp on retina + LinkedIn's
   * compression doesn't reduce it to mush.
   */
  async function handleSaveImage() {
    if (!cardRef.current || savingImage) return
    setSavingImage(true)
    try {
      const { default: html2canvas } = await import("html2canvas")
      const canvas = await html2canvas(cardRef.current, {
        // Match our app's bg so transparent edges blend instead of
        // showing a checkerboard.
        backgroundColor: getComputedStyle(document.body).getPropertyValue("--bg") || "#F7F5F0",
        scale: 2,
        useCORS: true,
        logging: false,
      })
      canvas.toBlob((blob) => {
        if (!blob) return
        const url  = URL.createObjectURL(blob)
        const a    = document.createElement("a")
        // Dateable filename so screenshots in a Downloads folder
        // are easy to find later.
        a.href     = url
        a.download = `nordavix-${periodEnd}-closed.png`
        a.click()
        URL.revokeObjectURL(url)
      }, "image/png")
    } catch (err) {
      // html2canvas can fail on cross-origin assets we don't control.
      // Soft-fail: log + let the user dismiss; no need for a banner.
      console.warn("Save image failed:", err)
    } finally {
      // Tiny delay so the "saving…" state is visible — prevents the
      // spinner from flashing for users on fast machines.
      setTimeout(() => setSavingImage(false), 400)
    }
  }

  /**
   * Open LinkedIn's share composer with pre-filled copy. LinkedIn
   * doesn't support attaching an image via URL params, so we tell the
   * user to upload the PNG they just saved. The pre-fill at least
   * carries the message + the Nordavix link.
   */
  function handleShareLinkedIn() {
    const url  = "https://nordavix.com"
    const text = `Just closed ${monthLabel} books in Nordavix 🎯  ${stats.reconsTied}/${stats.totalAccounts} accounts tied, ${stats.aiAssisted} AI-assisted, ${stats.itemsMatched} items matched. Highly recommend if you're tired of week-long closes.`
    const linkedin = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}&summary=${encodeURIComponent(text)}`
    window.open(linkedin, "_blank", "noopener,noreferrer,width=600,height=600")
  }

  // Derived: AI assist percentage (rounded), used for the "Nordavix
  // did the heavy lifting" callout when the AI was responsible for
  // most of the work.
  const aiPct = stats.totalAccounts > 0
    ? Math.round((stats.aiAssisted / stats.totalAccounts) * 100)
    : 0

  // First name only for the personal greeting — last name in the
  // screenshot would feel formal and discourage sharing.
  const firstName = userName?.split(" ")[0]?.trim() || null

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop — subtle dim, click to dismiss */}
          <motion.div
            key="bc-backdrop"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-40"
            style={{ background: "rgba(15, 23, 42, 0.5)", backdropFilter: "blur(4px)" }}
            onClick={onClose}
          />

          {/* Centered card */}
          <motion.div
            key="bc-dialog"
            initial={{ opacity: 0, scale: 0.94, y: 8 }}
            animate={{ opacity: 1, scale: 1,    y: 0 }}
            exit={{    opacity: 0, scale: 0.94, y: 8 }}
            transition={{ duration: 0.32, ease: [0.32, 0.72, 0, 1] }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="books-closed-headline"
            className="fixed inset-0 z-50 flex items-center justify-center px-4 py-6 pointer-events-none"
          >
            <div className="w-full max-w-[480px] pointer-events-auto">
              {/* The actual screenshottable card. Keep its layout +
                  styles inline-friendly so html2canvas captures them
                  without surprises (avoid CSS variables in critical
                  visual properties since html2canvas's resolution of
                  var(...) can be inconsistent across browsers). */}
              <div
                ref={cardRef}
                className="rounded-3xl overflow-hidden"
                style={{
                  background: "#FFFFFF",
                  border: "1px solid #EDECEA",
                  boxShadow: "0 24px 60px -12px rgba(14,17,18,0.18), 0 8px 24px -6px rgba(14,17,18,0.08)",
                }}
              >
                {/* Top accent strip — brand green, hints at the
                    Nordavix wordmark color without overpowering. */}
                <div style={{ height: 4, background: "linear-gradient(90deg, #2E7A55 0%, #4FA07A 50%, #2E7A55 100%)" }} />

                {/* Card body */}
                <div className="px-8 sm:px-10 pt-9 sm:pt-10 pb-8">
                  {/* Eyebrow: company + status */}
                  <div className="flex items-center justify-between mb-7">
                    <p className="text-[10.5px] font-semibold uppercase tracking-[0.18em]"
                      style={{ color: "#6B6966" }}>
                      {companyName || "Workspace"}
                    </p>
                    <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider"
                      style={{ background: "rgba(46, 122, 85, 0.10)", color: "#2E7A55" }}>
                      <CheckCircle2 size={11} strokeWidth={2.4} />
                      Closed
                    </span>
                  </div>

                  {/* Headline */}
                  <h2
                    id="books-closed-headline"
                    className="text-3xl sm:text-[40px] font-bold leading-[1.05] tracking-tight"
                    style={{ color: "#0E1112" }}
                  >
                    {monthLabel.toUpperCase()}
                    <span style={{ color: "#2E7A55" }}> books</span>
                    <br />
                    are closed.
                  </h2>

                  {/* AI-impact lede — only shown when AI carried real
                      weight; otherwise we'd be claiming credit for
                      manual work the controller did. */}
                  {aiPct >= 25 && (
                    <p className="mt-3 text-[13px] leading-relaxed" style={{ color: "#4A4946" }}>
                      AI prepared <strong style={{ color: "#0E1112" }}>{aiPct}%</strong>{" "}
                      of the reconciliations.
                    </p>
                  )}

                  {/* Stats row */}
                  <div className="mt-7 grid grid-cols-3 gap-2 sm:gap-3">
                    <StatTile value={stats.reconsTied}   total={stats.totalAccounts} label="Accounts tied" />
                    <StatTile value={stats.aiAssisted}                                label="AI-assisted"  />
                    <StatTile value={stats.itemsMatched}                              label="Items matched" />
                  </div>

                  {/* Personal line */}
                  {firstName && (
                    <p className="mt-6 text-[13px] italic" style={{ color: "#4A4946" }}>
                      Nice work, {firstName}.
                    </p>
                  )}

                  {/* Wordmark footer — magazine-credit style. The dot
                      after "nordavix" is the brand mark; deliberately
                      kept small so it's recognizable in a screenshot
                      without screaming "ad." */}
                  <div className="mt-8 pt-5 flex items-center justify-between"
                    style={{ borderTop: "1px solid #EDECEA" }}>
                    <span className="text-[15px] font-bold tracking-tight"
                      style={{ color: "#0E1112" }}>
                      nordavix<span style={{ color: "#2E7A55" }}>.</span>
                    </span>
                    <span className="text-[10.5px]" style={{ color: "#8C8B88" }}>
                      Closed in Nordavix
                    </span>
                  </div>
                </div>
              </div>

              {/* Action row — sits OUTSIDE the captured card so it's
                  not in the screenshot. */}
              <div className="mt-5 flex items-center justify-between gap-3 flex-wrap">
                <button
                  onClick={onClose}
                  className="text-[12px] font-medium hover:underline"
                  style={{ color: "var(--text-muted)" }}>
                  <span className="inline-flex items-center gap-1">
                    <X size={11} strokeWidth={2} />
                    Dismiss
                  </span>
                </button>

                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    icon={savingImage ? <Spinner className="h-3 w-3" /> : <Download size={12} strokeWidth={1.8} />}
                    onClick={handleSaveImage}
                    disabled={savingImage}>
                    {savingImage ? "Saving…" : "Save image"}
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleShareLinkedIn}>
                    Share on LinkedIn
                  </Button>
                </div>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}

// ── Stat tile ──────────────────────────────────────────────────────────

function StatTile({ value, total, label }: {
  value:  number
  total?: number
  label:  string
}) {
  return (
    <div
      className="rounded-xl px-3 py-3 text-center"
      style={{ background: "#F7F5F0", border: "1px solid #EDECEA" }}
    >
      <div className="text-2xl sm:text-[28px] font-bold tabular-nums leading-none"
        style={{ color: "#0E1112" }}>
        {value}
        {total !== undefined && (
          <span className="text-[14px] font-semibold ml-0.5" style={{ color: "#8C8B88" }}>
            /{total}
          </span>
        )}
      </div>
      <div className="text-[10px] font-semibold uppercase tracking-wider mt-1.5"
        style={{ color: "#6B6966" }}>
        {label}
      </div>
    </div>
  )
}
