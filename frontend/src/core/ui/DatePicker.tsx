/**
 * DatePicker — drop-in replacement for `<input type="date">`.
 *
 * Native date inputs render differently per OS/browser (Chrome on
 * Mac vs Windows vs Safari vs mobile) and the chunky default UI
 * was inconsistent with the rest of our compact form controls.
 * This custom picker keeps the same value contract (ISO YYYY-MM-DD
 * strings in/out) so callers don't change anything else.
 *
 * Features:
 *   • Compact trigger button — formatted date + small calendar icon
 *   • Calendar popover with framer-motion entrance (120ms easeOut)
 *   • Prev / next month navigation + "Today" shortcut
 *   • Today highlighted with green outline, selected with solid green
 *   • Outside-month days hidden for a cleaner grid
 *   • Outside-click + Escape both close the picker
 *   • Optional min / max date constraints (disable days outside range)
 *   • Theme-aware via CSS variables
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { AnimatePresence, motion } from "framer-motion"
import { Calendar, ChevronLeft, ChevronRight, ChevronDown } from "lucide-react"
import { formatDate } from "@/core/lib/dates"

interface Props {
  /** ISO YYYY-MM-DD, or empty string for unset. */
  value:    string
  onChange: (iso: string) => void
  /** Inclusive min / max in YYYY-MM-DD. */
  min?:     string
  max?:     string
  disabled?:boolean
  placeholder?: string
  /** Wrapper element class — defaults to `relative inline-block`. */
  className?: string
  /** Wrapper element style. */
  style?:   React.CSSProperties
  /** Override the trigger button's CSS — falls back to the form-input look. */
  triggerClassName?: string
  triggerStyle?:    React.CSSProperties
  /** Compact mode: smaller padding + min-width: 0 so it fits tight cells. */
  compact?: boolean
}

const DOW_LABELS = ["S", "M", "T", "W", "T", "F", "S"]
const MONTH_LABELS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]

function pad2(n: number): string { return n.toString().padStart(2, "0") }
function toIso(y: number, m: number, d: number): string {
  return `${y}-${pad2(m + 1)}-${pad2(d)}`
}
function fromIso(s: string): { y: number; m: number; d: number } | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  const [y, m, d] = s.split("-").map(Number)
  return { y, m: m - 1, d }
}
function fmtDisplay(iso: string): string {
  // App-wide standard: MM-DD-YYYY (US, unambiguous when copy-pasted).
  return formatDate(iso) || iso
}
function daysInMonth(y: number, m: number): number { return new Date(y, m + 1, 0).getDate() }
function isSameDate(a: { y: number; m: number; d: number }, b: { y: number; m: number; d: number }): boolean {
  return a.y === b.y && a.m === b.m && a.d === b.d
}

export function DatePicker({ value, onChange, min, max, disabled, placeholder, className, style, triggerClassName, triggerStyle, compact }: Props) {
  const today = new Date()
  const todayTriple = { y: today.getFullYear(), m: today.getMonth(), d: today.getDate() }
  const selected = fromIso(value)
  // `min` / `max` are kept as ISO strings — comparisons happen in
  // pickDay / pickToday / isDisabledDay via direct string compare.

  // Calendar's currently-displayed month — independent of `value` so the
  // user can browse months without changing their selection.
  const [view, setView] = useState<{ y: number; m: number }>(() =>
    selected ? { y: selected.y, m: selected.m } : { y: todayTriple.y, m: todayTriple.m },
  )
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Re-anchor view to the selected date whenever the picker opens (and
  // selected exists). Useful when the value changes externally.
  useEffect(() => {
    if (open && selected) setView({ y: selected.y, m: selected.m })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, value])

  // Outside-click + Escape close
  useEffect(() => {
    if (!open) return
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onClick)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onClick)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  // Build the grid: leading blanks for the first day of the month +
  // each day of the month. We use 7 columns; row count varies (4-6).
  const cells = useMemo(() => {
    const first = new Date(view.y, view.m, 1).getDay() // 0..6, Sun..Sat
    const days = daysInMonth(view.y, view.m)
    const arr: ({ d: number } | null)[] = []
    for (let i = 0; i < first; i++) arr.push(null)
    for (let d = 1; d <= days; d++) arr.push({ d })
    return arr
  }, [view])

  function navMonth(delta: number) {
    setView((v) => {
      const total = v.y * 12 + v.m + delta
      return { y: Math.floor(total / 12), m: ((total % 12) + 12) % 12 }
    })
  }
  function pickDay(d: number) {
    const iso = toIso(view.y, view.m, d)
    // Respect min/max guard
    if ((min && iso < min) || (max && iso > max)) return
    onChange(iso)
    setOpen(false)
  }
  function pickToday() {
    const iso = toIso(todayTriple.y, todayTriple.m, todayTriple.d)
    if ((min && iso < min) || (max && iso > max)) {
      // Today is out of range — just jump the view to today's month without selecting
      setView({ y: todayTriple.y, m: todayTriple.m })
      return
    }
    onChange(iso)
    setView({ y: todayTriple.y, m: todayTriple.m })
    setOpen(false)
  }
  function isDisabledDay(y: number, m: number, d: number): boolean {
    const iso = toIso(y, m, d)
    if (min && iso < min) return true
    if (max && iso > max) return true
    return false
  }

  const triggerLabel = value ? fmtDisplay(value) : (placeholder ?? "Pick a date")

  // Trigger button styles: a clean default that callers can override or
  // merge into via triggerClassName / triggerStyle. Compact mode shrinks
  // padding + drops the min-width for tight inline cells.
  const defaultTriggerClass = compact
    ? "inline-flex items-center gap-1.5 w-full rounded-md px-2 py-1.5 text-xs outline-none transition-colors hover:bg-[var(--surface)]"
    : "inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm outline-none transition-colors hover:bg-[var(--surface)]"
  const defaultTriggerStyle: React.CSSProperties = {
    background: "var(--surface-2)",
    border: "1px solid var(--border-strong)",
    color: "var(--text)",
    opacity: disabled ? 0.5 : 1,
    cursor: disabled ? "not-allowed" : "pointer",
    minWidth: compact ? 0 : 160,
  }

  return (
    <div ref={ref} className={`relative ${className ?? "inline-block"}`} style={style}>
      <button
        type="button"
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        className={triggerClassName ?? defaultTriggerClass}
        style={{ ...defaultTriggerStyle, ...(triggerStyle ?? {}) }}
        aria-label="Pick a date"
      >
        <Calendar size={compact ? 12 : 13} strokeWidth={1.8} style={{ color: "var(--text-muted)" }} />
        <span className={value ? "truncate" : "italic truncate"} style={{ color: value ? "var(--text)" : "var(--text-muted)" }}>
          {triggerLabel}
        </span>
        <ChevronDown
          size={compact ? 10 : 12} strokeWidth={1.8}
          className="ml-auto transition-transform shrink-0"
          style={{ color: "var(--text-muted)", transform: open ? "rotate(180deg)" : "rotate(0)" }}
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.96 }}
            animate={{ opacity: 1, y: 0,  scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.96 }}
            transition={{ duration: 0.12, ease: "easeOut" }}
            className="absolute top-full left-0 mt-1.5 z-30 rounded-xl p-2.5 origin-top-left"
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border-strong)",
              boxShadow: "0 10px 32px -8px rgba(0,0,0,0.30), 0 4px 8px -2px rgba(0,0,0,0.10)",
              minWidth: 252,
            }}
          >
            {/* Header: prev | month-year | next | Today */}
            <div className="flex items-center justify-between mb-2">
              <button type="button" onClick={() => navMonth(-1)}
                className="h-7 w-7 inline-flex items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-2)]"
                style={{ color: "var(--text-2)" }}
                aria-label="Previous month">
                <ChevronLeft size={14} strokeWidth={2} />
              </button>
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-semibold text-theme tabular-nums">
                  {MONTH_LABELS[view.m]} {view.y}
                </span>
              </div>
              <button type="button" onClick={() => navMonth(1)}
                className="h-7 w-7 inline-flex items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-2)]"
                style={{ color: "var(--text-2)" }}
                aria-label="Next month">
                <ChevronRight size={14} strokeWidth={2} />
              </button>
            </div>

            {/* Day-of-week header */}
            <div className="grid grid-cols-7 gap-1 mb-1">
              {DOW_LABELS.map((d, i) => (
                <div key={i} className="text-center text-[9px] font-bold uppercase tracking-wider py-0.5"
                  style={{ color: "var(--text-muted)" }}>
                  {d}
                </div>
              ))}
            </div>

            {/* Day grid */}
            <div className="grid grid-cols-7 gap-1">
              {cells.map((c, i) => {
                if (!c) return <div key={i} />
                const isToday    = isSameDate(todayTriple, { y: view.y, m: view.m, d: c.d })
                const isSelected = selected ? isSameDate(selected, { y: view.y, m: view.m, d: c.d }) : false
                const dis        = isDisabledDay(view.y, view.m, c.d)
                return (
                  <button key={i} type="button"
                    onClick={() => !dis && pickDay(c.d)}
                    disabled={dis}
                    className="h-8 w-8 rounded-md text-[12px] font-medium transition-all tabular-nums"
                    style={
                      isSelected ? {
                        background: "var(--green)",
                        color: "white",
                        boxShadow: "0 1px 3px rgba(0,0,0,0.15)",
                      } : isToday ? {
                        background: "transparent",
                        color: "var(--green)",
                        border: "1.5px solid var(--green)",
                        fontWeight: 700,
                      } : dis ? {
                        background: "transparent",
                        color: "var(--text-muted)",
                        opacity: 0.35,
                        cursor: "not-allowed",
                      } : {
                        background: "transparent",
                        color: "var(--text)",
                        cursor: "pointer",
                      }
                    }
                    onMouseEnter={(e) => {
                      if (!isSelected && !dis) (e.currentTarget as HTMLElement).style.background = "var(--surface-2)"
                    }}
                    onMouseLeave={(e) => {
                      if (!isSelected && !dis) (e.currentTarget as HTMLElement).style.background = "transparent"
                    }}
                  >
                    {c.d}
                  </button>
                )
              })}
            </div>

            {/* Footer: Today shortcut */}
            <div className="flex items-center justify-between mt-2 pt-2 text-[11px]"
              style={{ borderTop: "1px solid var(--border)" }}>
              <button type="button" onClick={pickToday}
                className="px-2 py-1 rounded-md font-medium transition-colors hover:bg-[var(--surface-2)]"
                style={{ color: "var(--green)" }}>
                Today
              </button>
              {value && (
                <button type="button" onClick={() => { onChange(""); setOpen(false) }}
                  className="px-2 py-1 rounded-md transition-colors hover:bg-[var(--surface-2)]"
                  style={{ color: "var(--text-muted)" }}>
                  Clear
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
