/**
 * Blog category metadata — single source for the chip color, icon,
 * gradient header, and hex accent of each category. Used by:
 *   - BlogIndex (filter chips, card top-accent, hero badge)
 *   - BlogPostPage (header gradient, breadcrumb tone)
 *
 * Adding a new category: just add it to CATEGORIES below. The chip
 * order in the UI follows declaration order here.
 */
import {
  Workflow, ArrowLeftRight, Brain, GitCompareArrows,
  Banknote, ShieldCheck, BookOpen,
  type LucideIcon,
} from "lucide-react"

export interface CategoryMeta {
  /** The string used in blog post `meta.category` — must match exactly. */
  label:    string
  /** Solid color used for the chip text + card accent stripe. Hex so
   *  it works inside SVG gradients without CSS var lookups. */
  color:    string
  /** Subtle fill used as the chip background. */
  bg:       string
  /** Lucide icon component shown on cards + the header. */
  icon:     LucideIcon
  /** Two-color gradient used as the cover-pattern background on
   *  cards + the post header. */
  gradient: [string, string]
}

export const CATEGORIES: CategoryMeta[] = [
  {
    label:    "Close process",
    color:    "#2E7A55",
    bg:       "rgba(62, 143, 102, 0.10)",
    icon:     Workflow,
    gradient: ["#2E7A55", "#7FB89B"],
  },
  {
    label:    "Consolidation",
    color:    "#1D4ED8",
    bg:       "rgba(29, 78, 216, 0.10)",
    icon:     ArrowLeftRight,
    gradient: ["#1D4ED8", "#3B82F6"],
  },
  {
    label:    "AI",
    color:    "#7C3AED",
    bg:       "rgba(124, 58, 237, 0.10)",
    icon:     Brain,
    gradient: ["#7C3AED", "#A78BFA"],
  },
  {
    label:    "Flux analysis",
    color:    "#B45309",
    bg:       "rgba(180, 83, 9, 0.10)",
    icon:     GitCompareArrows,
    gradient: ["#B45309", "#F59E0B"],
  },
  {
    label:    "Reconciliation",
    color:    "#0E7490",
    bg:       "rgba(14, 116, 144, 0.10)",
    icon:     Banknote,
    gradient: ["#0E7490", "#22D3EE"],
  },
  {
    label:    "Audit",
    color:    "#BE185D",
    bg:       "rgba(190, 24, 93, 0.10)",
    icon:     ShieldCheck,
    gradient: ["#BE185D", "#F472B6"],
  },
]

const FALLBACK: CategoryMeta = {
  label:    "General",
  color:    "#4B5563",
  bg:       "rgba(75, 85, 99, 0.10)",
  icon:     BookOpen,
  gradient: ["#4B5563", "#9CA3AF"],
}

/**
 * Look up a category by its label. Returns the FALLBACK for unknown
 * categories so the UI never breaks on a typo or a new label that
 * wasn't added here.
 */
export function getCategoryMeta(label: string): CategoryMeta {
  return CATEGORIES.find((c) => c.label === label) ?? FALLBACK
}
