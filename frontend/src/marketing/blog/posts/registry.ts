/**
 * Blog post registry — single source of truth for the blog index and
 * the /blog/:slug route. Add new posts here, import them in the array,
 * and they appear in the index automatically (sorted by date desc).
 *
 * Why a hand-maintained list and not a glob: gives the import graph
 * a deterministic shape so Vite tree-shakes unused posts and the
 * order is explicit.
 */
import type { BlogPostModule } from "@/marketing/blog/types"

import * as fluxAnalysisGuide               from "@/marketing/blog/posts/flux-analysis-guide"
import * as fluxAnalysisExample             from "@/marketing/blog/posts/flux-analysis-example"
import * as balanceSheetReconciliationChecklist from "@/marketing/blog/posts/balance-sheet-reconciliation-checklist"
import * as monthEndCloseIsBroken           from "@/marketing/blog/posts/month-end-close-is-broken"
import * as balanceSheetReconciliation      from "@/marketing/blog/posts/balance-sheet-reconciliation"
import * as bankReconciliationQuickbooks    from "@/marketing/blog/posts/bank-reconciliation-quickbooks"
import * as auditPrepChecklist              from "@/marketing/blog/posts/audit-prep-checklist"
import * as monthEndCloseChecklist          from "@/marketing/blog/posts/month-end-close-checklist"
import * as monthEndCloseSoftware           from "@/marketing/blog/posts/month-end-close-software"
import * as intercompanyConsolidationQbo    from "@/marketing/blog/posts/intercompany-consolidation-quickbooks"
import * as aiAccounting2026                from "@/marketing/blog/posts/ai-in-accounting-2026"
import * as prepaidAmortizationSchedule     from "@/marketing/blog/posts/prepaid-expense-amortization-schedule"
import * as makerCheckerControls            from "@/marketing/blog/posts/maker-checker-accounting-controls"

const RAW_POSTS: BlogPostModule[] = [
  prepaidAmortizationSchedule     as BlogPostModule,
  makerCheckerControls            as BlogPostModule,
  fluxAnalysisGuide               as BlogPostModule,
  fluxAnalysisExample             as BlogPostModule,
  balanceSheetReconciliationChecklist as BlogPostModule,
  monthEndCloseIsBroken           as BlogPostModule,
  balanceSheetReconciliation      as BlogPostModule,
  bankReconciliationQuickbooks    as BlogPostModule,
  auditPrepChecklist              as BlogPostModule,
  monthEndCloseChecklist          as BlogPostModule,
  monthEndCloseSoftware           as BlogPostModule,
  intercompanyConsolidationQbo    as BlogPostModule,
  aiAccounting2026                as BlogPostModule,
]

/**
 * All posts, sorted newest first. Stable sort so two posts with the
 * same date keep their declaration order.
 */
export const POSTS: BlogPostModule[] = [...RAW_POSTS].sort(
  (a, b) => b.meta.date.localeCompare(a.meta.date),
)

export function findPostBySlug(slug: string): BlogPostModule | undefined {
  return POSTS.find((p) => p.meta.slug === slug)
}
