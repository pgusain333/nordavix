/**
 * The NDVX Copilot mark and wordmark.
 *
 * Extracted because it now appears in two places — the full Copilot page and
 * the ask bar on every detail view — and a brand that is defined twice drifts.
 * The gradient, the radius and the glyph live here once.
 *
 * `size` drives everything: the box, the glyph and the corner radius scale
 * together, so the mark reads the same at 20px in a drawer header as it does
 * at 56px in the page hero.
 */
import { Sparkles } from "lucide-react"

export function CopilotMark({ size = 24, className = "" }: { size?: number; className?: string }) {
  return (
    <span
      className={`inline-flex items-center justify-center shrink-0 ${className}`}
      style={{
        height: size,
        width: size,
        // Radius tracks the box so the silhouette is constant across sizes —
        // a fixed radius reads as a circle when small and a square when large.
        borderRadius: Math.max(5, Math.round(size * 0.29)),
        background:
          "linear-gradient(145deg, var(--green), color-mix(in srgb, var(--green) 60%, #0a0f0d))",
        color: "#fff",
        boxShadow: "0 1px 2px rgba(12,38,32,0.18)",
      }}
      aria-hidden
    >
      <Sparkles size={Math.round(size * 0.54)} strokeWidth={1.8} />
    </span>
  )
}

/** Mark + wordmark, locked up. `muted` drops the wordmark to secondary ink for
 *  headers where the brand should be present without competing with content. */
export function CopilotWordmark({
  size = 20,
  muted = false,
}: {
  size?: number
  muted?: boolean
}) {
  return (
    <span className="inline-flex items-center gap-2 min-w-0">
      <CopilotMark size={size} />
      <span
        className="font-bold tracking-tight whitespace-nowrap"
        style={{
          fontSize: Math.max(11, Math.round(size * 0.62)),
          letterSpacing: "-0.01em",
          color: muted ? "var(--text-2)" : "var(--text)",
        }}
      >
        NDVX <span style={{ fontWeight: 500, color: "var(--text-muted)" }}>Copilot</span>
      </span>
    </span>
  )
}
