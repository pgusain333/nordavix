/**
 * Blog post — a fully worked flux analysis example.
 * Primary: "flux analysis example". Cluster: "flux analysis", "what is flux
 * analysis in accounting", "fluctuation analysis accounting", "balance sheet
 * flux analysis", "flux analysis in accounting".
 * Pairs with the conceptual /blog/flux-analysis-guide (cross-linked).
 */
import { Link } from "react-router-dom"
import type { BlogPostMeta } from "@/marketing/blog/types"

export const meta: BlogPostMeta = {
  slug:        "flux-analysis-example",
  title:       "Flux Analysis Example: A Full Worked Walk-Through (2026)",
  description: "A complete flux analysis example with real numbers — build the variance table, set a materiality threshold, investigate the movements, and write commentary a reviewer can trust. Free template inside.",
  date:        "2026-06-08",
  readingTime: "10 min read",
  category:    "Flux analysis",
  excerpt:     "Most flux analysis guides explain the theory. This one works a real example end to end — the variance table, the threshold, the investigation, and the exact commentary — so you can copy the pattern on your next close.",
  faq: [
    {
      question: "What is flux analysis in accounting?",
      answer:
        "Flux (fluctuation) analysis compares each account between two periods — month-over-month or year-over-year — and explains every material change. The goal isn't to restate the number that moved; it's to say WHY it moved, with evidence, so a reviewer can sign off without redoing the work.",
    },
    {
      question: "How do you calculate a flux / variance percentage?",
      answer:
        "Variance $ = current period − prior period. Variance % = variance $ ÷ prior period. A negative prior or near-zero base makes the percentage misleading, so always read the dollar change and the percentage together.",
    },
    {
      question: "What materiality threshold should I use for flux analysis?",
      answer:
        "A common rule is to flag any line that moves by both a dollar amount AND a percentage — for example, at least $10,000 and at least 5%. Set the dollar figure relative to your company's size, and always sanity-check margins and ratios even when individual lines fall under the threshold.",
    },
    {
      question: "Is flux analysis the same as fluctuation analysis?",
      answer:
        "Yes — \"flux analysis\" is just shorthand for fluctuation analysis. Both mean the same period-over-period variance review of the income statement and balance sheet during the close.",
    },
  ],
}

export function Body() {
  return (
    <article>
      <p className="lead">
        Most explanations of flux analysis stop at the theory. This one works a
        real example end to end — the variance table, the materiality threshold,
        the investigation, and the exact commentary — so you can copy the pattern
        on your next month-end close. (For the concepts behind it, see our{" "}
        <Link to="/blog/flux-analysis-guide" className="text-[var(--green)] underline">
          flux analysis guide
        </Link>.)
      </p>

      <h2>What flux analysis is, in one sentence</h2>
      <p>
        Flux (fluctuation) analysis compares each account between two periods and
        explains <em>why</em> every material number moved — not just that it moved.
        Done well, it&apos;s the layer that turns a trial balance into something a
        CFO, owner, or auditor can actually trust.
      </p>

      <h2>The setup for our example</h2>
      <p>
        Meet a small product company closing May against April. We&apos;ll set a
        materiality threshold of <strong>$10,000 AND 5%</strong> — a line has to
        clear both to get flagged. (Both matters: a 200% jump on a $400 account is
        noise, and a 2% move on revenue can still be six figures.)
      </p>

      <h2>Step 1 — Build the variance table</h2>
      <p>
        Pull the current and prior period for every P&amp;L line, then compute the
        dollar and percentage change:
      </p>
      <table>
        <thead>
          <tr><th>Account</th><th>April</th><th>May</th><th>Δ $</th><th>Δ %</th></tr>
        </thead>
        <tbody>
          <tr><td>Revenue</td><td>820,000</td><td>905,000</td><td>+85,000</td><td>+10.4%</td></tr>
          <tr><td>COGS</td><td>295,000</td><td>360,000</td><td>+65,000</td><td>+22.0%</td></tr>
          <tr><td><strong>Gross profit</strong></td><td>525,000</td><td>545,000</td><td>+20,000</td><td>+3.8%</td></tr>
          <tr><td>Salaries &amp; wages</td><td>210,000</td><td>214,000</td><td>+4,000</td><td>+1.9%</td></tr>
          <tr><td>Marketing</td><td>48,000</td><td>96,000</td><td>+48,000</td><td>+100%</td></tr>
          <tr><td>Software / SaaS</td><td>22,000</td><td>23,500</td><td>+1,500</td><td>+6.8%</td></tr>
          <tr><td>Professional fees</td><td>12,000</td><td>41,000</td><td>+29,000</td><td>+241.7%</td></tr>
          <tr><td>Rent</td><td>30,000</td><td>30,000</td><td>0</td><td>0%</td></tr>
          <tr><td><strong>Operating income</strong></td><td>203,000</td><td>140,500</td><td>−62,500</td><td>−30.8%</td></tr>
        </tbody>
      </table>

      <h2>Step 2 — Flag what&apos;s material</h2>
      <p>
        Apply the threshold ($10k <em>and</em> 5%). Four lines clear it:
        <strong> Revenue, COGS, Marketing, and Professional fees.</strong> Salaries
        ($4k / 1.9%), Software ($1.5k / 6.8% — dollars too small), and Rent (flat)
        don&apos;t need commentary.
      </p>
      <aside className="callout">
        <strong>Read the ratios, not just the lines.</strong> Gross profit only
        moved 3.8% — under threshold — so a line-level filter skips it. But gross
        <em> margin</em> fell from 64.0% to 60.2%: COGS grew 22% while revenue grew
        only 10%. That margin compression is the most important story on the page,
        and a naive threshold would have missed it. Always cross-check margins and
        key ratios.
      </aside>

      <h2>Step 3 — Investigate and write the commentary</h2>
      <p>
        For each flagged line, find the drivers (pull the transactions behind the
        change) and write an explanation a reviewer can verify without re-doing
        your work. The test of good commentary: it answers <em>why</em>, quantifies
        the driver, and flags whether it repeats.
      </p>

      <h3>Revenue — +$85,000 (+10.4%)</h3>
      <p>
        Two new enterprise customers went live mid-month, adding ~$72k of recurring
        revenue; the remaining ~$13k is seasonal uplift in the existing base. Both
        new logos are annual contracts, so the lift is recurring going forward.
      </p>

      <h3>COGS — +$65,000 (+22.0%)</h3>
      <p>
        Outpaced revenue and drove the margin compression above. Drivers: ~$40k
        from the higher volume tied to the two new customers (recurring), plus a
        ~$25k one-time inbound-freight surcharge from a delayed shipment. The
        recurring piece is expected; the $25k surcharge does not repeat.
      </p>

      <h3>Marketing — +$48,000 (+100%)</h3>
      <p>
        Two drivers: a $30k trade-show sponsorship (one-time, Q2 only) and an $18k
        paid-search campaign launched this month (ongoing, ~$18k/month from here).
        Splitting one-time from recurring is the whole point — without it, someone
        will forecast $96k of marketing every month.
      </p>

      <h3>Professional fees — +$29,000 (+241.7%)</h3>
      <p>
        Entirely one-time: $21k legal and $8k accounting for the seller-financing
        round that closed in May. Reverts to the ~$12k baseline next month.
      </p>

      <aside className="callout">
        <strong>Weak vs. strong commentary.</strong><br />
        ❌ &quot;Marketing increased by $48,000.&quot; (restates the number)<br />
        ✅ &quot;Marketing rose $48k (+100%): $30k trade-show sponsorship (one-time)
        and an $18k paid-search launch (~$18k/mo recurring).&quot;
      </aside>

      <h2>A balance sheet flux example</h2>
      <p>
        Flux isn&apos;t just for the P&amp;L. Run the same comparison on the balance
        sheet — and tie the movements back to the income statement as a cross-check:
      </p>
      <table>
        <thead>
          <tr><th>Account</th><th>April</th><th>May</th><th>Δ $</th><th>Δ %</th></tr>
        </thead>
        <tbody>
          <tr><td>Cash</td><td>612,000</td><td>548,000</td><td>−64,000</td><td>−10.5%</td></tr>
          <tr><td>Accounts receivable</td><td>410,000</td><td>520,000</td><td>+110,000</td><td>+26.8%</td></tr>
          <tr><td>Inventory</td><td>180,000</td><td>240,000</td><td>+60,000</td><td>+33.3%</td></tr>
          <tr><td>Accounts payable</td><td>240,000</td><td>198,000</td><td>−42,000</td><td>−17.5%</td></tr>
        </tbody>
      </table>
      <p>
        <strong>AR +$110k</strong> ties cleanly to the two enterprise deals invoiced
        at month-end (consistent with the revenue story) — but it pushed DSO up, so
        watch collections. <strong>Inventory +$60k</strong> is a deliberate stock
        build for Q3. <strong>Cash −$64k</strong> reconciles to the AP pay-down
        (−$42k) plus the inventory build. Each balance-sheet move should trace to a
        real driver — if one doesn&apos;t, you&apos;ve found an error worth chasing.
        (Tie-outs on these accounts belong in your{" "}
        <Link to="/blog/balance-sheet-reconciliation" className="text-[var(--green)] underline">
          balance sheet reconciliations
        </Link>.)
      </p>

      <h2>The flux analysis template (copy this)</h2>
      <p>
        The reusable structure is just seven columns:
      </p>
      <ul>
        <li><strong>Account</strong> · <strong>Prior</strong> · <strong>Current</strong> · <strong>Δ $</strong> · <strong>Δ %</strong> · <strong>Material? (Y/N)</strong> · <strong>Explanation</strong></li>
      </ul>
      <p>And every explanation follows the same one-line formula:</p>
      <aside className="callout">
        <strong>[Driver]</strong> caused <strong>[account]</strong> to move
        <strong> $X (Y%)</strong> — <strong>[one-time / recurring]</strong> —
        <strong> [evidence: the transactions or event]</strong>.
      </aside>

      <h2>Five mistakes that make flux useless</h2>
      <ol>
        <li><strong>Restating the number</strong> instead of explaining the cause.</li>
        <li><strong>Percentages on a tiny base</strong> — a 300% jump on a $200 line is noise.</li>
        <li><strong>Missing offsetting moves</strong> — a $50k reclass between two accounts nets to zero in reality but looks like two big swings.</li>
        <li><strong>The absent variance</strong> — an expected move that <em>didn&apos;t</em> happen (e.g. depreciation that never posted) is just as material as one that did.</li>
        <li><strong>Not splitting one-time from recurring</strong>, which quietly breaks everyone&apos;s forecast.</li>
      </ol>

      <h2>Doing this automatically</h2>
      <p>
        The slow part isn&apos;t the math — it&apos;s pulling the transactions behind
        each variance and drafting the &quot;why.&quot; {" "}
        <Link to="/solutions" className="text-[var(--green)] underline">Nordavix</Link>{" "}
        does both: it builds the variance table from your QuickBooks data, pulls the
        transactions driving each material movement, and writes a first-draft
        explanation, so your review starts at &quot;is this right?&quot; instead of
        &quot;what happened?&quot; See it alongside the{" "}
        <Link to="/blog/month-end-close-checklist" className="text-[var(--green)] underline">
          full month-end close checklist
        </Link>, or{" "}
        <Link to="/sign-up" className="text-[var(--green)] underline font-semibold">
          start a free workspace
        </Link>{" "}and run it on your next close.
      </p>

      <h2>Frequently asked questions</h2>

      <h3>What is flux analysis in accounting?</h3>
      <p>
        Flux (fluctuation) analysis compares each account between two periods —
        month-over-month or year-over-year — and explains every material change. The
        goal isn&apos;t to restate the number that moved; it&apos;s to say why it
        moved, with evidence, so a reviewer can sign off without redoing the work.
      </p>

      <h3>How do you calculate a flux / variance percentage?</h3>
      <p>
        Variance $ = current period − prior period. Variance % = variance $ ÷ prior
        period. A negative prior or near-zero base makes the percentage misleading,
        so always read the dollar change and the percentage together.
      </p>

      <h3>What materiality threshold should I use for flux analysis?</h3>
      <p>
        A common rule is to flag any line that moves by both a dollar amount AND a
        percentage — for example, at least $10,000 and at least 5%. Set the dollar
        figure relative to your company&apos;s size, and always sanity-check margins
        and ratios even when individual lines fall under the threshold.
      </p>

      <h3>Is flux analysis the same as fluctuation analysis?</h3>
      <p>
        Yes — &quot;flux analysis&quot; is just shorthand for fluctuation analysis.
        Both mean the same period-over-period variance review of the income statement
        and balance sheet during the close.
      </p>
    </article>
  )
}
