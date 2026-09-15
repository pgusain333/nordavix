/**
 * How a selection anywhere in the app reaches the Copilot.
 *
 * Select-to-ask covers every screen at once instead of one mount point at a
 * time — including the screens nobody thought to instrument. But the right
 * destination depends on where you are: on a reconciliation or a flux drawer
 * there is already an ask bar that knows WHICH account you are looking at, and
 * routing you to the full Copilot page would throw that context away and make
 * you restate it. Which is the exact round trip this whole feature exists to
 * delete.
 *
 * So the bar registers while it is mounted, and a selection goes to it when one
 * is there and to the Copilot page when one isn't. A module-level count rather
 * than context because the publisher (a floating affordance mounted in the app
 * shell) and the subscriber (a bar deep inside a drawer) have no useful common
 * ancestor, and threading a provider between them to move one string would be
 * more machinery than the problem.
 */

export const ASK_EVENT = "ndvx:ask"

let mounted = 0

/** Call from an AskBar's mount effect; the returned function unregisters. */
export function registerAskBar(): () => void {
  mounted += 1
  return () => { mounted = Math.max(0, mounted - 1) }
}

/** Is an ask bar on screen to receive a selection? */
export function hasAskBar(): boolean {
  return mounted > 0
}

/**
 * Hand a selection to the ask bar on this screen.
 *
 * Returns false when there is none, so the caller can fall back to the full
 * Copilot page instead of silently swallowing the click.
 *
 * Deliberately PRE-FILLS rather than sending. A highlighted "14,368" is not a
 * question, and spending an answer on an ambiguous prompt teaches people the
 * feature guesses. One tap saves the copying; the user still says what they
 * want to know.
 */
export function askAbout(text: string): boolean {
  if (!hasAskBar() || typeof window === "undefined") return false
  window.dispatchEvent(new CustomEvent(ASK_EVENT, { detail: { text } }))
  return true
}
