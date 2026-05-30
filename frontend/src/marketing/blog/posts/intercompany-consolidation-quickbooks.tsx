/**
 * Blog post — intercompany consolidation in QuickBooks.
 * Target keyword: "intercompany consolidation quickbooks"
 *                  + "how to consolidate financial statements in quickbooks"
 */
import { Link } from "react-router-dom"
import type { BlogPostMeta } from "@/marketing/blog/types"

export const meta: BlogPostMeta = {
  slug:        "intercompany-consolidation-quickbooks",
  title:       "Intercompany consolidation in QuickBooks: a working guide",
  description: "QuickBooks has no real intercompany or consolidation feature. Here's how multi-entity teams actually handle IC accounts, eliminations, and consolidated reporting without buying a six-figure ERP.",
  date:        "2026-05-29",
  readingTime: "11 min read",
  category:    "Consolidation",
  excerpt:     "QuickBooks has no real intercompany or consolidation feature — yet hundreds of multi-entity groups run on it anyway. Here's exactly how they pull it off without spending six figures on an ERP.",
}

export function Body() {
  return (
    <article className="prose prose-slate max-w-none">
      <p className="lead">
        QuickBooks Online — even the Advanced tier — has no native intercompany
        or consolidation feature. You can&apos;t pair an IC account in one company
        file with the matching account in another. You can&apos;t generate a
        consolidated trial balance. You can&apos;t book elimination journal entries
        across entities. And yet hundreds of multi-entity holding groups, family
        offices, and CPA firms run on QuickBooks anyway. Here&apos;s how.
      </p>

      <h2>What &quot;intercompany&quot; actually means</h2>
      <p>
        Intercompany (IC) accounting is what happens when two related entities
        transact with each other — a parent lending to a subsidiary, a sister
        company buying services from another sister, an owner-controlled
        investment between affiliates. Every IC transaction creates a matched
        pair on both books:
      </p>
      <ul>
        <li>Entity A records a <strong>receivable</strong> from Entity B</li>
        <li>Entity B records a <strong>payable</strong> to Entity A</li>
      </ul>
      <p>
        From a consolidation perspective, those two balances are economically the
        same dollar — it&apos;s the group owing itself. So when you produce
        consolidated financial statements, you <strong>eliminate</strong> both:
        the receivable from A&apos;s assets and the payable from B&apos;s
        liabilities. The group&apos;s consolidated balance sheet shouldn&apos;t
        show debt that the group owes itself.
      </p>

      <h2>The QuickBooks gap</h2>
      <p>
        Here&apos;s what QBO doesn&apos;t do that real consolidation requires:
      </p>
      <ol>
        <li>
          <strong>No cross-company account linking.</strong> Each QBO company file is
          siloed. You can&apos;t declare &quot;account 2150 in EntityA file is the
          counterparty of account 1450 in EntityB file.&quot;
        </li>
        <li>
          <strong>No consolidated trial balance.</strong> Even Advanced&apos;s
          Multi-Entity Reporting just lets you VIEW each entity&apos;s P&amp;L
          alongside the others. It doesn&apos;t sum, doesn&apos;t eliminate, doesn&apos;t
          produce real consolidated FS.
        </li>
        <li>
          <strong>No elimination journal entry support.</strong> An elim JE only exists
          in the consolidation file — there&apos;s nowhere in QBO that&apos;s
          conceptually a &quot;consolidation entity.&quot;
        </li>
        <li>
          <strong>No IC mismatch detection.</strong> If A says it&apos;s owed $50k
          from B and B&apos;s books show $48k payable, nothing in QBO catches the
          $2k difference. You only find it when the consolidated balance sheet
          fails to balance.
        </li>
      </ol>
      <p>
        Multi-entity groups solve this with one of three approaches.
      </p>

      <h2>Approach 1 — Excel + monthly Sisyphus</h2>
      <p>
        The most common approach. After each entity closes its books, the controller
        exports each TB to Excel, builds a consolidation worksheet with an
        eliminations column, manually identifies IC pairs, and books the elims by
        hand. The consolidated TB is the SUM minus the ELIMS column.
      </p>
      <p>
        <strong>What works:</strong> Cheap, flexible, no software to buy. Works for
        groups up to a handful of entities if the controller is disciplined.
      </p>
      <p>
        <strong>What breaks:</strong> Anyone who&apos;s done this knows. The elim
        column drifts month over month. IC pairs get miscoded. A new sub gets added
        and forgotten. The CFO opens the consolidated BS and finds it&apos;s out by
        $30k with no audit trail to chase. By month 6, the workbook has 14 tabs and
        only one person knows which formula points where.
      </p>

      <h2>Approach 2 — Six-figure ERP migration</h2>
      <p>
        NetSuite, Sage Intacct, Workday Adaptive. These products have real
        multi-entity / consolidation modules that handle everything QuickBooks
        doesn&apos;t.
      </p>
      <p>
        <strong>What works:</strong> Once you&apos;re live, the consolidation is
        truly automated.
      </p>
      <p>
        <strong>What breaks:</strong> NetSuite implementations regularly run six
        figures and 6–12 months. For a $5M–$50M group with a CPA-led finance team,
        that&apos;s a lot of money and time to solve one workflow. Plus you lose
        the QBO ecosystem your bookkeepers actually understand.
      </p>

      <h2>Approach 3 — Keep QuickBooks, add a thin consolidation layer</h2>
      <p>
        This is the path most modern multi-entity groups take. Each entity keeps
        its books in QBO (which the bookkeepers know and like), and a separate
        tool sits on top to handle the IC and consolidation work — pulling each
        entity&apos;s TB via QBO&apos;s API, matching IC accounts across entities,
        running eliminations, and producing a consolidated TB and FS that&apos;s
        always reconciled to the underlying entity books.
      </p>
      <p>
        The advantage over Excel: the IC pairs and elims are stored in a database,
        not in formulas. Cross-entity mismatches are caught automatically. The
        consolidated TB updates when any entity&apos;s data changes. There&apos;s
        an audit trail of every elim.
      </p>
      <p>
        The advantage over NetSuite: cost. A tool sitting on top of QBO costs a
        fraction of an ERP migration because it isn&apos;t replacing your GL.
      </p>

      <h2>How we built it at Nordavix</h2>
      <p>
        Our {" "}<Link to="/solutions" className="text-[var(--green)] underline">consolidation module</Link>
        {" "} is exactly approach 3. Each related entity is its own Nordavix
        workspace connected to its own QBO. A user who&apos;s a member of both
        workspaces can:
      </p>
      <ul>
        <li>
          <strong>Auto-detect IC accounts</strong> in each entity. Pattern matching
          on common naming conventions (&quot;Intercompany Payable&quot;, &quot;Due
          to Parent&quot;, &quot;Loan from Subsidiary&quot;) plus an AI fallback
          for accounts with non-standard names.
        </li>
        <li>
          <strong>Pair them across entities.</strong> &quot;EntityA&apos;s account
          2150 is the matching account for EntityB&apos;s account 1450.&quot; The
          pair is stored symmetrically — both entities see the link.
        </li>
        <li>
          <strong>Run the eliminations report.</strong> For each pair at the chosen
          period end, both sides&apos; balance + the diff. Pairs net cleanly are
          marked &quot;Matched&quot;; mismatched pairs flag for investigation
          before consolidation.
        </li>
        <li>
          <strong>Generate the consolidated trial balance.</strong> Sums all
          entities&apos; TBs by FS category (Assets / Liabilities / Equity /
          Revenue / Expenses), applies the elimination amount per paired IC
          account. Export to Excel for workpaper distribution.
        </li>
      </ul>

      <h2>The IC mismatch problem nobody talks about</h2>
      <p>
        The hardest part of intercompany isn&apos;t the elimination — it&apos;s
        the mismatch. Two entities almost never agree on their IC balances on the
        first attempt because:
      </p>
      <ul>
        <li>One side accrued, the other didn&apos;t.</li>
        <li>The wire posted in EntityA on the 31st but EntityB&apos;s bank received it on the 1st.</li>
        <li>A reclass was made on one side without telling the other.</li>
        <li>Different cut-offs were used.</li>
      </ul>
      <p>
        In Excel-driven consolidation, these mismatches hide. The total elim looks
        right and the consolidated BS balances within a few thousand dollars, so
        nobody investigates. In a real consolidation tool, the per-pair view
        surfaces the exact mismatch and the dollar amount — and you can drill into
        each side&apos;s transactions to find the difference.
      </p>

      <h2>Should you stay on QuickBooks?</h2>
      <p>
        For groups up to ~10 entities with revenue under ~$100M, QuickBooks +
        a consolidation layer is the right answer. The cost is a fraction of an
        ERP, the bookkeepers stay productive, and you get real consolidation
        outputs. Above that size, the limits of QBO itself (transaction volume,
        permission granularity) start to bind and an ERP becomes the right move.
      </p>
      <p>
        If you&apos;re in the &quot;stay on QBO + add consolidation&quot; bucket
        and want to see how it works in practice,{" "}
        <Link to="/sign-up" className="text-[var(--green)] underline font-semibold">
          start a free workspace
        </Link>{" "}
        and connect one of your entities. The auto-detect + pairing flow takes
        about five minutes to demo end to end.
      </p>
    </article>
  )
}
