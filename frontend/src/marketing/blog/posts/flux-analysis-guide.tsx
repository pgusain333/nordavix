/**
 * Blog post — flux analysis guide.
 * Target keyword: "flux analysis" + "variance analysis for controllers" +
 *                  "balance sheet flux analysis"
 */
import { Link } from "react-router-dom"
import type { BlogPostMeta } from "@/marketing/blog/types"

export const meta: BlogPostMeta = {
  slug:        "flux-analysis-guide",
  title:       "Flux analysis: a controller's working guide (with examples)",
  description: "What flux analysis actually is, how to run it month over month, the materiality thresholds that work, and the commentary patterns that survive audit. Plain-English guide for working controllers.",
  date:        "2026-05-31",
  readingTime: "10 min read",
  category:    "Flux analysis",
  excerpt:     "Most flux templates are bloat. The ones that actually catch issues focus on three things — the right comparison period, sensible materiality, and commentary that names the cause. Here's the working version.",
}

export function Body() {
  return (
    <article>
      <p className="lead">
        Flux analysis is one of those things every controller is expected to do and
        almost no textbook explains well. The templates floating around online are
        bloated; the audit firm versions assume you already know the answer; and
        the actual conversation a CFO wants to have is &quot;what changed and why,
        in two sentences.&quot; Here&apos;s a working version that gets you there
        without 40 hours of spreadsheet work.
      </p>

      <h2>What flux analysis actually is</h2>
      <p>
        Flux analysis (sometimes called variance analysis) compares this period&apos;s
        financials to a baseline — usually last month, last quarter, or the same
        period last year — and writes a one-line explanation for every account
        that moved materially. The goal is to surface the <em>story</em> of the
        period: what the business actually did differently, and where the books
        might be wrong.
      </p>
      <p>
        It runs on both the income statement and the balance sheet, and the
        questions are different on each:
      </p>
      <ul>
        <li><strong>Income statement flux</strong> answers: did revenue grow? Did margins compress? Did a non-recurring expense distort the period?</li>
        <li><strong>Balance sheet flux</strong> answers: did working capital move? Did anything settle that shouldn&apos;t have? Did accruals or prepaids drift?</li>
      </ul>
      <p>
        A good flux process produces both. Most companies only do the IS, then
        get blindsided by a BS issue at year-end audit.
      </p>

      <h2>Picking the right comparison period</h2>
      <p>
        The baseline you compare against changes what the analysis tells you.
        The three sensible choices:
      </p>
      <ol>
        <li>
          <strong>Month over month (MoM).</strong> Best for operational management
          — &quot;what happened last month vs the month before.&quot; Useful for
          spotting seasonal expense spikes and one-time items.
        </li>
        <li>
          <strong>Year over year (YoY) same month.</strong> Best for cutting
          through seasonality. May 2026 vs May 2025 tells you whether the business
          actually grew, not just whether you sold more last month.
        </li>
        <li>
          <strong>Actual vs budget.</strong> The version a CFO usually wants. But
          this requires a budget, and many small/mid-size companies don&apos;t
          run a real one. Skip if you don&apos;t have a credible budget.
        </li>
      </ol>
      <p>
        Best practice for monthly close is to run MoM <em>and</em> YoY in parallel
        — they catch different things. The MoM column catches data quality issues
        (a missing accrual jumps the next month), the YoY column catches business
        trends.
      </p>

      <h2>Setting materiality — the threshold that decides what gets explained</h2>
      <p>
        Without a materiality threshold, flux analysis becomes &quot;write a sentence
        about every account that moved by $1.&quot; That&apos;s not analysis, it&apos;s
        bureaucracy. A working threshold:
      </p>
      <aside className="callout">
        <strong>Explain anything that&apos;s either:</strong>
        <ul>
          <li>≥ 10% of the prior period AND ≥ $10,000 absolute, OR</li>
          <li>≥ $50,000 absolute regardless of percentage.</li>
        </ul>
      </aside>
      <p>
        The first rule catches material proportional moves on small accounts; the
        second catches large absolute moves on big accounts that would otherwise
        get masked by their size. Tune the dollar floors to your business — a
        $50k threshold is wrong for a $5M company and equally wrong for a $500M
        one.
      </p>
      <p>
        One more rule that gets missed: <strong>explain absent variance too.</strong>
        Depreciation that should have moved but didn&apos;t is just as material as
        one that did. An unchanged AR balance in a month where you billed twice
        as much is a data error, not a sign of stable collections.
      </p>

      <h2>The commentary that survives audit (and a CFO&apos;s skim)</h2>
      <p>
        Most flux commentary is useless because it just restates the variance.
        &quot;Marketing increased by $30k&quot; is what we can already see; the
        question is <em>why</em>. Good flux commentary follows a simple template:
      </p>
      <aside className="callout">
        <strong>What changed</strong> + <strong>why</strong> + <strong>where the
        evidence is</strong> in one or two sentences.
      </aside>
      <p>Bad version:</p>
      <blockquote>
        Marketing expenses increased $32,400 (24%) due to higher spending.
      </blockquote>
      <p>Good version:</p>
      <blockquote>
        Marketing increased $32,400 (24%) driven by the Q2 trade-show booth
        and content campaign launching May 1 — confirmed via the {" "}
        <em>Marketing Activity Plan</em> approved by Sarah K. on April 15. No
        recurring impact expected after July.
      </blockquote>
      <p>
        The second one names the cause, points to the documentation, and tells
        the reviewer what to expect next month. The first one tells them nothing
        they couldn&apos;t see in the trial balance themselves.
      </p>

      <h2>The flux process, end to end</h2>
      <ol>
        <li>
          <strong>Sync the current period&apos;s trial balance</strong> from your
          GL. Confirm A = L + E + (Rev − Exp) before anything else; if it
          doesn&apos;t tie, flux is meaningless.
        </li>
        <li>
          <strong>Pull the comparison period&apos;s TB</strong> at the same level
          of detail. Same account map, same sign convention.
        </li>
        <li>
          <strong>Compute the variance per account</strong> (this − prior, $ and
          %). Sort descending by absolute value.
        </li>
        <li>
          <strong>Apply your materiality threshold</strong> to filter to the
          accounts that need explanation.
        </li>
        <li>
          <strong>For each material account, pull the top 5–10 transactions</strong>
          driving the variance. The biggest journal entries hitting the account
          this period are almost always the answer.
        </li>
        <li>
          <strong>Write commentary</strong> using the template above. Two sentences,
          name the cause, point to evidence.
        </li>
        <li>
          <strong>Reviewer signs off.</strong> Maker/checker — same rule as
          reconciliation. The preparer shouldn&apos;t approve their own work.
        </li>
      </ol>

      <h2>Where AI helps (and where it doesn&apos;t)</h2>
      <p>
        Modern AI commentary tools (we built one into {" "}<Link to="/solutions">Nordavix</Link>&apos;s
        flux module) shine on step 6 — drafting the commentary. Given the variance,
        the prior period balance, and the top 10 transactions, an LLM writes a
        first-draft explanation that&apos;s usually 80% there. The preparer
        edits, the reviewer approves. Saves 30 minutes per account on a 40-account
        chart.
      </p>
      <p>
        Where AI does NOT help: deciding the materiality threshold (that&apos;s a
        business judgment), or knowing that a $25k variance is &quot;just a
        reclass&quot; because last month you booked the wrong account (that&apos;s
        institutional memory). Keep humans in those loops.
      </p>

      <h2>Balance sheet flux — the version everyone skips</h2>
      <p>
        Most teams only do flux on the P&amp;L. That&apos;s a mistake. The balance
        sheet is where data quality issues hide because nothing forces you to
        look at an unreconciled accrual or a drifting prepaid until year-end
        audit catches it. A quick BS flux every month is the single best
        unforced-error preventer in close.
      </p>
      <p>
        What to look for on the BS specifically:
      </p>
      <ul>
        <li>
          <strong>AR / AP</strong> that grew faster than revenue / cost of revenue
          — could mean a billing or vendor-payment issue.
        </li>
        <li>
          <strong>Prepaids</strong> that didn&apos;t amortize — schedule not being
          rolled.
        </li>
        <li>
          <strong>Accruals</strong> that don&apos;t reverse next month — accrual
          was wrong or the reversal got missed.
        </li>
        <li>
          <strong>Intercompany</strong> that doesn&apos;t tie the other side&apos;s
          books — a real consolidation issue. (We wrote up {" "}<Link to="/blog/intercompany-consolidation-quickbooks">the consolidation version of this</Link> separately.)
        </li>
        <li>
          <strong>Cash</strong> that&apos;s out by more than a few hundred from
          the bank statement — bank rec is broken or there&apos;s an outstanding
          item you don&apos;t know about.
        </li>
      </ul>

      <h2>The 80/20 of flux for small teams</h2>
      <p>
        If you&apos;re a one-person finance function or close-time is tight, here&apos;s
        the version that catches 80% of the value with 20% of the effort:
      </p>
      <ol>
        <li>One page — IS lines only — MoM variance + 1-line commentary.</li>
        <li>For every variance &gt; 10% AND &gt; $10k: explain.</li>
        <li>BS spot check: scan the top 10 BS accounts, flag anything that moved more than expected.</li>
        <li>Send it to the CFO Friday after close. Take their questions Monday.</li>
      </ol>
      <p>
        That&apos;s real flux analysis. The 40-page workpaper is for audit. The
        2-page narrative is for running the business.
      </p>

      <h2>Tools that do this without the spreadsheet</h2>
      <p>
        We built {" "}<Link to="/solutions">Nordavix&apos;s flux module</Link> around exactly this
        workflow — pull both periods from QBO, auto-flag material variances,
        AI-draft the commentary with the supporting transactions inline, push
        the result to a reviewer for approval. The whole process that used to be
        a 4–8 hour Excel exercise compresses into about 45 minutes.
      </p>
      <p>
        If you want to try it on your next close,{" "}
        <Link to="/sign-up"><strong>start a free workspace</strong></Link> and
        connect a QBO. Free during beta.
      </p>
    </article>
  )
}
