/**
 * Blog category metadata — single source for the chip color, icon,
 * gradient header, and hex accent of each category. Used by:
 *   - BlogIndex (filter chips, card top-accent, hero badge)
 *   - BlogPostPage (header accents, breadcrumb tone)
 *
 * Palette: the brand's "finance editorial" system — every category is a
 * muted, low-chroma tone from the pine family (no rainbow). Color carries
 * taxonomy, never decoration; on cream cards each reads as a quiet accent.
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
    color:    "#2E7A55",                       // brand green
    bg:       "rgba(46, 122, 85, 0.10)",
    icon:     Workflow,
    gradient: ["#2E7A55", "#7FB89B"],
  },
  {
    label:    "Reconciliation",
    color:    "#2F6B66",                       // pine-teal
    bg:       "rgba(47, 107, 102, 0.10)",
    icon:     Banknote,
    gradient: ["#2F6B66", "#6FA8A1"],
  },
  {
    label:    "Flux analysis",
    color:    "#96702F",                       // muted ochre
    bg:       "rgba(150, 112, 47, 0.10)",
    icon:     GitCompareArrows,
    gradient: ["#96702F", "#C9A45C"],
  },
  {
    label:    "AI",
    color:    "#5F7019",                       // deep olive (the AI accent family)
    bg:       "rgba(95, 112, 25, 0.10)",
    icon:     Brain,
    gradient: ["#5F7019", "#9CC4AD"],
  },
  {
    label:    "Consolidation",
    color:    "#3C5A76",                       // muted slate
    bg:       "rgba(60, 90, 118, 0.10)",
    icon:     ArrowLeftRight,
    gradient: ["#3C5A76", "#8FA9BF"],
  },
  {
    label:    "Audit",
    color:    "#7A4A52",                       // muted wine
    bg:       "rgba(122, 74, 82, 0.10)",
    icon:     ShieldCheck,
    gradient: ["#7A4A52", "#B58791"],
  },
]

const FALLBACK: CategoryMeta = {
  label:    "General",
  color:    "#5C6660",
  bg:       "rgba(92, 102, 96, 0.10)",
  icon:     BookOpen,
  gradient: ["#5C6660", "#9AA59E"],
}

/**
 * Look up a category by its label. Returns the FALLBACK for unknown
 * categories so the UI never breaks on a typo or a new label that
 * wasn't added here.
 */
export function getCategoryMeta(label: string): CategoryMeta {
  return CATEGORIES.find((c) => c.label === label) ?? FALLBACK
}
