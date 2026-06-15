/**
 * OverflowMenu — a compact "⋯ more actions" dropdown.
 *
 * Keeps a toolbar uncluttered: primary actions stay inline, secondary ones
 * collapse behind this. Closes on outside-click, Escape, or item selection
 * (each item receives a `close` callback via the render-prop). Theme-aware
 * and motion-matched to the rest of the app.
 */
import { useEffect, useRef, useState, type ReactNode } from "react"
import { AnimatePresence, motion } from "framer-motion"
import { MoreHorizontal } from "lucide-react"
import { MOTION, EASE } from "@/core/motion"

export function OverflowMenu({
  children, title = "More actions",
}: {
  children: (close: () => void) => ReactNode
  title?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setOpen(false) }
    document.addEventListener("mousedown", onDoc)
    window.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDoc)
      window.removeEventListener("keydown", onKey)
    }
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <button
        type="button" onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu" aria-expanded={open} title={title}
        className="flex items-center justify-center h-[26px] w-[26px] rounded-md transition-colors hover:bg-[var(--surface-2)]"
        style={{ border: "1px solid var(--border)", color: "var(--text-2)" }}
      >
        <MoreHorizontal size={15} strokeWidth={2} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: MOTION.FAST, ease: EASE.OUT }}
            className="absolute right-0 mt-1.5 z-40 min-w-[190px] rounded-xl overflow-hidden py-1"
            style={{ background: "var(--surface)", border: "1px solid var(--border-strong)", boxShadow: "var(--card-shadow-hover)" }}
          >
            {children(() => setOpen(false))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export function OverflowMenuItem({
  icon, label, onClick, danger = false, disabled = false,
}: {
  icon?: ReactNode
  label: ReactNode
  onClick: () => void
  danger?: boolean
  disabled?: boolean
}) {
  return (
    <button
      type="button" role="menuitem" disabled={disabled} onClick={onClick}
      className="w-full flex items-center gap-2.5 px-3 py-2 text-[12.5px] text-left transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      style={{ color: danger ? "var(--danger)" : "var(--text-2)", background: "transparent" }}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.background = "var(--surface-2)" }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent" }}
    >
      {icon && <span className="shrink-0 inline-flex">{icon}</span>}
      <span className="flex-1">{label}</span>
    </button>
  )
}

export default OverflowMenu
