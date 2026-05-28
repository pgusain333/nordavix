/**
 * Tri-state header checkbox used by the schedule-suggestions panels.
 *
 *   selected = 0           → unchecked
 *   0 < selected < total   → indeterminate (visual: dash)
 *   selected === total     → checked
 *
 * Click semantics match every other "select all" checkbox in the app
 * (Tasks, Recons account list, Flux variances): clicking when
 * partially-selected promotes to "all selected"; clicking when all-
 * selected clears the whole panel.
 */
import { useEffect, useRef } from "react"

interface Props {
  total:    number
  selected: number
  disabled?: boolean
  onChange: (nextChecked: boolean) => void
  title?:   string
}

export function BulkSelectCheckbox({ total, selected, disabled, onChange, title }: Props) {
  const ref = useRef<HTMLInputElement>(null)

  const allChecked  = total > 0 && selected === total
  const someChecked = selected > 0 && selected < total

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = someChecked
  }, [someChecked])

  return (
    <input
      ref={ref}
      type="checkbox"
      checked={allChecked}
      disabled={disabled || total === 0}
      onChange={(e) => {
        // Indeterminate + click → "select all". Unchecked + click →
        // "select all". Checked + click → "clear all". (Matches the
        // pattern used elsewhere in the app.)
        onChange(allChecked ? false : true)
        // Stop the native checkbox from also bubbling to the row click.
        e.stopPropagation()
      }}
      className="h-3.5 w-3.5 rounded cursor-pointer"
      style={{ accentColor: "var(--green)" }}
      title={title ?? (
        allChecked  ? "Clear all"   :
        someChecked ? "Select all"  :
                      "Select all"
      )}
    />
  )
}
