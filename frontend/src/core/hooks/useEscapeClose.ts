/**
 * useEscapeClose — wire a modal or drawer's close handler to the
 * Escape key. One line per modal: `useEscapeClose(onClose)`.
 *
 * Why a hook and not inline: every modal in the app needs this and
 * the boilerplate (add listener, cleanup, capture phase) is identical.
 * Centralizing it keeps the keybinding consistent everywhere — there
 * was a real bug class where some modals closed on Escape and others
 * didn't, and users couldn't predict which would.
 */
import { useEffect } from "react"

export function useEscapeClose(onClose: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return
    function handler(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation()
        onClose()
      }
    }
    // Capture phase so a modal-inside-a-modal still closes the inner
    // one first (the last-mounted listener fires first in capture).
    window.addEventListener("keydown", handler, true)
    return () => window.removeEventListener("keydown", handler, true)
  }, [onClose, enabled])
}
