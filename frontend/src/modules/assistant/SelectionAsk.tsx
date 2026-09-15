/**
 * Select anything, ask about it.
 *
 * Highlight a figure, a row, a memo line anywhere in the app and this appears
 * beside it. One handler mounted once in the shell covers every screen at
 * once — including the ones nobody thought to instrument — instead of adding
 * a mount point per surface.
 *
 * Where the selection GOES depends on where you are: to the ask bar on this
 * screen if there is one (it already knows which account you are looking at),
 * otherwise to the full Copilot page. Routing a selection made inside a
 * reconciliation drawer to a blank Copilot would throw away the context and
 * make the user restate it, which is the round trip this feature exists to
 * delete.
 *
 * Three rules keep it from becoming an irritant, which is the failure mode of
 * every selection popover ever shipped:
 *   - It ignores selections inside inputs and editable fields. Someone
 *     selecting text to retype it is not asking a question.
 *   - It ignores selections that are too short to mean anything or long
 *     enough to be a whole paragraph the user is copying.
 *   - It never covers the selection: it sits above it, or below when there
 *     isn't room above.
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { AnimatePresence, motion } from "framer-motion"
import { useNavigate } from "react-router-dom"

import { MOTION } from "@/core/motion"
import { CopilotMark } from "@/modules/assistant/CopilotMark"
import { askAbout } from "@/modules/assistant/askBus"

/** Below this it's a stray double-click; above it the user is copying, not
 *  asking. Both ends measured against what people actually highlight: a figure,
 *  an account name, a sentence of a memo. */
const MIN_CHARS = 2
const MAX_CHARS = 400

const GLIDE = [0.22, 1, 0.36, 1] as const

function isEditable(node: Node | null): boolean {
  let el: HTMLElement | null =
    node instanceof HTMLElement ? node : (node?.parentElement ?? null)
  while (el) {
    const tag = el.tagName
    if (tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable) return true
    el = el.parentElement
  }
  return false
}

export function SelectionAsk() {
  const navigate = useNavigate()
  const [sel, setSel] = useState<{ text: string; x: number; y: number; above: boolean } | null>(null)
  const pillRef = useRef<HTMLDivElement>(null)

  const clear = useCallback(() => setSel(null), [])

  useEffect(() => {
    function read() {
      const s = window.getSelection()
      const text = (s?.toString() ?? "").trim()
      if (!s || s.isCollapsed || text.length < MIN_CHARS || text.length > MAX_CHARS) {
        setSel(null)
        return
      }
      if (isEditable(s.anchorNode) || isEditable(s.focusNode)) {
        setSel(null)
        return
      }
      let rect: DOMRect
      try {
        rect = s.getRangeAt(0).getBoundingClientRect()
      } catch {
        setSel(null)
        return
      }
      if (!rect || (!rect.width && !rect.height)) {
        setSel(null)
        return
      }
      // Above the selection by default; below when there isn't room, so the
      // pill never sits on top of what was highlighted.
      const above = rect.top > 56
      setSel({
        text,
        x: Math.min(Math.max(rect.left + rect.width / 2, 90), window.innerWidth - 90),
        y: above ? rect.top - 8 : rect.bottom + 8,
        above,
      })
    }

    // mouseup/keyup rather than selectionchange: the latter fires on every
    // character of a drag, so the pill would chase the cursor across the row.
    function onUp(e: MouseEvent | KeyboardEvent) {
      if (e.target instanceof Node && pillRef.current?.contains(e.target)) return
      // A tick, so the selection has settled before it's measured.
      window.setTimeout(read, 0)
    }
    function onDown(e: MouseEvent) {
      if (e.target instanceof Node && pillRef.current?.contains(e.target)) return
      setSel(null)
    }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setSel(null) }

    document.addEventListener("mouseup", onUp)
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keyup", onUp)
    document.addEventListener("keydown", onKey)
    window.addEventListener("scroll", clear, true)
    window.addEventListener("resize", clear)
    return () => {
      document.removeEventListener("mouseup", onUp)
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keyup", onUp)
      document.removeEventListener("keydown", onKey)
      window.removeEventListener("scroll", clear, true)
      window.removeEventListener("resize", clear)
    }
  }, [clear])

  function go() {
    if (!sel) return
    const text = sel.text
    setSel(null)
    window.getSelection()?.removeAllRanges()
    // The bar on this screen first — it knows the account. Only fall back to
    // the full page when there is nothing here to receive it.
    if (askAbout(text)) return
    navigate(`/app/assistant?ask=${encodeURIComponent(`About "${text}" — `)}`)
  }

  // Placement goes through framer's OWN x/y rather than a CSS transform, and
  // the animated element is AnimatePresence's direct child. Two bugs came from
  // getting this wrong, and both are worth naming:
  //
  //   - An inline `transform` on a motion element is overwritten the instant
  //     the entrance animation runs, which put the pill on top of the
  //     selection instead of above it.
  //   - Wrapping the motion element in a plain div to carry that transform
  //     fixed the placement and broke the exit: AnimatePresence waits for its
  //     direct child to report exit-complete, and a non-motion child never
  //     does, so the pill stayed on screen forever after being clicked.
  //
  // `x`/`y` in a motion `style` are MotionValues and compose with the animated
  // scale, so one element does both jobs.
  return (
    <AnimatePresence>
      {sel && (
        <motion.div
          key="ask-pill"
          ref={pillRef}
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95, transition: { duration: MOTION.FAST } }}
          transition={{ duration: MOTION.DEFAULT, ease: GLIDE }}
          className="fixed z-[70]"
          style={{
            left: sel.x,
            top: sel.y,
            x: "-50%",
            y: sel.above ? "-100%" : "0%",
          }}
        >
          <button
            onClick={go}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-semibold"
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border-strong)",
              color: "var(--text)",
              boxShadow: "0 6px 20px -6px rgba(12,38,32,0.28)",
            }}
          >
            <CopilotMark size={15} />
            Ask about this
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
