/**
 * Skeleton — placeholder block shown while content is loading. Avoids
 * the "flash of empty page" pattern where a card/table area renders
 * blank for 200-800 ms before data arrives.
 *
 * Pattern: same shape + roughly the same size as the real content
 * that's about to replace it, with a subtle pulse so the user knows
 * the page is alive (not frozen).
 *
 * The Block variant is for plain rectangles (KPI cards, image
 * placeholders). The Row variant is for table rows — fixed height,
 * staggered widths so it looks like real data.
 *
 * Uses CSS vars throughout — theme-aware automatically.
 */
import { type CSSProperties } from "react"

interface SkeletonBlockProps {
  /** CSS width — string ("100%", "120px") or number (treated as px). */
  width?:  string | number
  /** CSS height — same. */
  height?: string | number
  /** Border radius. Defaults to 6 px. */
  radius?: string | number
  /** Extra class names. */
  className?: string
  /** Inline style overrides. */
  style?:  CSSProperties
}

export function SkeletonBlock({
  width  = "100%",
  height = 16,
  radius = 6,
  className = "",
  style,
}: SkeletonBlockProps) {
  const w = typeof width  === "number" ? `${width}px`  : width
  const h = typeof height === "number" ? `${height}px` : height
  const r = typeof radius === "number" ? `${radius}px` : radius
  return (
    <span
      className={`skeleton-pulse inline-block ${className}`}
      style={{
        width: w, height: h, borderRadius: r,
        background: "var(--surface-2)",
        ...style,
      }}
    />
  )
}

/**
 * SkeletonRow — a staggered set of blocks emulating a table row.
 * Pass `columns` as an array of widths; each becomes one cell.
 */
export function SkeletonRow({
  columns = ["20%", "40%", "20%", "20%"],
  height  = 14,
}: { columns?: string[]; height?: number }) {
  return (
    <div className="flex items-center gap-3 py-2.5">
      {columns.map((w, i) => (
        <SkeletonBlock key={i} width={w} height={height} />
      ))}
    </div>
  )
}

/**
 * SkeletonTable — repeats SkeletonRow N times. The pulse animation is
 * staggered by row index so it reads as content streaming in.
 */
export function SkeletonTable({
  rows = 5,
  columns = ["20%", "40%", "20%", "20%"],
}: { rows?: number; columns?: string[] }) {
  return (
    <div className="px-4">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{ animationDelay: `${i * 80}ms` }}>
          <SkeletonRow columns={columns} />
        </div>
      ))}
    </div>
  )
}

/**
 * SkeletonCard — one card-shaped placeholder, the app's most common container.
 */
export function SkeletonCard({
  rows = 4,
  columns = ["24%", "38%", "18%", "14%"],
  header = true,
}: { rows?: number; columns?: string[]; header?: boolean }) {
  return (
    <div className="rounded-xl overflow-hidden"
      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      {header && (
        <div className="px-4 py-3 flex items-center gap-3"
          style={{ borderBottom: "1px solid var(--border)" }}>
          <SkeletonBlock width={140} height={13} />
          <span className="flex-1" />
          <SkeletonBlock width={72} height={13} />
        </div>
      )}
      <div className="py-2">
        <SkeletonTable rows={rows} columns={columns} />
      </div>
    </div>
  )
}

/**
 * SkeletonPage — the whole page shape: a stat strip, then a card of rows.
 *
 * Exists because adoption is the hard part. The primitives above have been in
 * the repo since early on and most pages still showed a centred spinner — a
 * spinner is one line and hand-assembling a page skeleton is twenty, so the
 * spinner kept winning. This is the one line.
 *
 * Why it matters: a spinner says *wait* and gives no clue what is coming; a
 * skeleton says *here it comes* and shows the shape, so the same 600ms reads
 * as roughly half as long. In a data-heavy tool that perceived speed is most
 * of what "premium" means.
 */
export function SkeletonPage({
  stats = 4,
  cards = 1,
  rows = 5,
  columns,
}: { stats?: number; cards?: number; rows?: number; columns?: string[] }) {
  return (
    <div className="space-y-4" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading</span>
      {stats > 0 && (
        <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${stats}, minmax(0,1fr))` }}>
          {Array.from({ length: stats }).map((_, i) => (
            <div key={i} className="rounded-xl px-4 py-3.5"
              style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
              <SkeletonBlock width="55%" height={10} />
              <div className="mt-2"><SkeletonBlock width="42%" height={22} /></div>
            </div>
          ))}
        </div>
      )}
      {Array.from({ length: cards }).map((_, i) => (
        <SkeletonCard key={i} rows={rows} columns={columns} />
      ))}
    </div>
  )
}
