/**
 * ConfirmDialog — in-app replacement for native window.confirm().
 *
 * A small, theme-aware modal matching FeedbackDialog's motion + chrome:
 * single AnimatePresence wrapper, blurred backdrop, Escape + backdrop-click
 * to cancel. Use for any destructive or expensive action that needs a
 * "are you sure?" gate — instead of the jarring grey browser dialog.
 *
 * Body accepts ReactNode so callers can pass a formatted explanation
 * (lead line + bullet list) rather than a wall of "\n" text.
 */
import { useEffect, type ReactNode } from "react"
import { AnimatePresence, motion } from "framer-motion"
import { AlertTriangle, HelpCircle } from "lucide-react"
import { Button } from "@/core/ui/components"
import { MOTION, EASE } from "@/core/motion"

interface Props {
  open:          boolean
  title:         string
  body?:         ReactNode
  confirmLabel?: string
  cancelLabel?:  string
  variant?:      "default" | "danger"
  loading?:      boolean
  onConfirm:     () => void
  onCancel:      () => void
}

export function ConfirmDialog({
  open, title, body, confirmLabel = "Confirm", cancelLabel = "Cancel",
  variant = "default", loading = false, onConfirm, onCancel,
}: Props) {
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !loading) onCancel()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, loading, onCancel])

  const danger = variant === "danger"

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="cd-backdrop"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: MOTION.DEFAULT }}
            onClick={() => { if (!loading) onCancel() }}
            className="fixed inset-0 z-50"
            style={{ background: "rgba(0, 0, 0, 0.55)", backdropFilter: "blur(2px)" }}
          />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
            <motion.div
              key="cd-dialog"
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.97, y: 6 }}
              transition={{ duration: MOTION.DEFAULT, ease: EASE.OUT }}
              role="dialog" aria-modal="true"
              className="pointer-events-auto w-full max-w-md rounded-2xl overflow-hidden"
              style={{ background: "var(--surface)", border: "1px solid var(--border-strong)", boxShadow: "var(--card-shadow-hover)" }}
            >
              <div className="p-5">
                <div className="flex items-start gap-3">
                  <div className="shrink-0 flex items-center justify-center rounded-full"
                    style={{
                      width: 34, height: 34,
                      background: danger ? "var(--danger-subtle)" : "var(--green-subtle)",
                    }}>
                    {danger
                      ? <AlertTriangle size={17} strokeWidth={2} style={{ color: "var(--danger)" }} />
                      : <HelpCircle size={17} strokeWidth={2} style={{ color: "var(--green)" }} />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <h2 className="text-[15px] font-semibold" style={{ color: "var(--text)", margin: 0, letterSpacing: "-0.01em" }}>
                      {title}
                    </h2>
                    {body && (
                      <div className="text-[12.5px] mt-1.5 leading-relaxed" style={{ color: "var(--text-2)" }}>
                        {body}
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-end gap-2 px-5 py-3"
                style={{ background: "var(--surface-2)", borderTop: "1px solid var(--border)" }}>
                <Button size="sm" variant="ghost" onClick={onCancel} disabled={loading}>
                  {cancelLabel}
                </Button>
                <Button
                  size="sm"
                  variant={danger ? "destructive" : "default"}
                  loading={loading}
                  onClick={onConfirm}
                >
                  {confirmLabel}
                </Button>
              </div>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  )
}

export default ConfirmDialog
