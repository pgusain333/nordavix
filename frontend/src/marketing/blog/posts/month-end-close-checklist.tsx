/**
 * Blog post — month-end close checklist.
 * Target keyword: "month-end close checklist" (high-volume CPA query)
 */
import { Link } from "react-router-dom"
import type { BlogPostMeta } from "@/marketing/blog/types"

export const meta: BlogPostMeta = {
  slug:        "month-end-close-checklist",
  title:       "The complete month-end close checklist (2026 edition)",
  description: "A step-by-step month-end close checklist for controllers and CPAs — bank reconciliations, AR/AP, accruals, intercompany, flux analysis, and the executive package. Free template inside.",
  date:        "2026-05-30",
  readingTime: "9 min read",
  category:    "Close process",
  excerpt:     "Every controller has a close checklist. Most of them are wrong — they confuse what's done with what's actually been verified. Here's the version we'd hand to a new senior on day one.",
}

export function Body() {
  return (
    <article className="prose prose-slate max-w-none">
      <p className="lead">
        Every controller has a month-end close checklist taped above their monitor.
        Most of them are wrong — they confuse what&apos;s <em>done</em> with what&apos;s
        actually been <em>verified</em>. This is the checklist we&apos;d hand a new
        senior accountant on day one of a real close, with the order, the gating
        rules, and the gotchas that aren&apos;t in textbooks.
      </p>
      <p>
        One checklist, but every seat runs it toward a different goal — speed,
        accuracy, or scale. For that view, see{" "}
        <Link to="/blog/month-end-close-cfo-controller-outsourced-accounting" className="text-[var(--green)] underline">
          how CFOs, controllers, and outsourced accounting teams each approach the close
        </Link>.
      </p>

      <h2>Why most checklists fail</h2>
      <p>
        A typical month-end checklist looks like a flat list of tasks: reconcile bank,
        post depreciation, calculate accruals, etc. The problem is that real close work
        has <strong>dependencies</strong> — you can&apos;t do flux analysis on numbers
        that aren&apos;t reconciled, and you can&apos;t book intercompany eliminations
        until both sides have their balances locked. A flat list lets you check things
        off in the wrong order and miss material misstatements.
      </p>
      <p>
        The version below is organized into five stages, each gating the next. You
        can&apos;t move to stage 3 until stage 2 is fully reviewed. That&apos;s the
        single biggest change most teams need.
      </p>

      <h2>Stage 1 — Cut-off and data sync (Day 1–2 after period end)</h2>
      <p>
        Before any reconciliation work begins, the source-of-truth data has to be
        frozen. Anything that touches GL after cut-off creates a moving target.
      </p>
      <ul>
        <li><strong>Confirm hard cut-off with operations.</strong> Last invoice issued, last bill posted, last bank deposit. Document the exact timestamp.</li>
        <li><strong>Sync trial balance from QuickBooks (or your GL).</strong> Pull TrialBalance, GeneralLedger, ProfitAndLoss, Aged Receivables, and Aged Payables. Snapshot them so you can prove what was open at cut-off.</li>
        <li><strong>Verify the TB ties internally.</strong> Assets = Liabilities + Equity + (Revenue − Expense). If it doesn&apos;t, fix it before anything else — every downstream check assumes a balanced TB.</li>
        <li><strong>Lock period for posting.</strong> In QBO, set the closing date password. New posts after this point get flagged.</li>
      </ul>

      <h2>Stage 2 — Reconciliations (Day 2–4)</h2>
      <p>
        Every balance-sheet account needs a documented tie-out between the GL balance
        and an external source. The rule of thumb: if you can&apos;t name what you
        ticked the balance to, it isn&apos;t reconciled.
      </p>
      <ol>
        <li>
          <strong>Cash / Bank.</strong> Tie GL balance to the bank statement, with
          an OS/IT reconciliation for outstanding deposits and uncleared checks. Any
          item older than 90 days needs a written reason.
        </li>
        <li>
          <strong>Accounts Receivable.</strong> Tie GL AR to the aging detail. Sum
          of aging buckets must equal GL exactly. Any difference means the aging
          is broken — fix it before booking bad-debt reserves.
        </li>
        <li>
          <strong>Accounts Payable.</strong> Same — tie GL AP to the aging detail.
          Watch for vendor credits sitting in &quot;0–30&quot; that should net.
        </li>
        <li>
          <strong>Prepaids.</strong> Schedule each prepaid item with vendor, start
          date, term, and monthly amortization. GL prepaid balance must equal the sum
          of unamortized portions.
        </li>
        <li>
          <strong>Fixed assets.</strong> Roll-forward: opening + additions − disposals
          − depreciation = closing. Run the depreciation schedule.
        </li>
        <li>
          <strong>Accrued liabilities.</strong> Every accrual needs a schedule with
          vendor, period covered, and reversal date. Reversals from prior month must
          be confirmed before posting new accruals.
        </li>
        <li>
          <strong>Loans / debt.</strong> Tie GL to the lender statement; document
          interest accrual.
        </li>
        <li>
          <strong>Intercompany.</strong> Each IC account must net against the matching
          account on the counterparty&apos;s books. If they don&apos;t tie, the
          difference is a real issue, not a rounding problem. (We wrote more on this in
          {" "}<Link to="/blog/intercompany-consolidation-quickbooks" className="text-[var(--green)] underline">our intercompany guide</Link>.)
        </li>
        <li>
          <strong>Equity.</strong> Verify retained earnings rolled forward from prior
          period plus current month net income matches the new RE balance.
        </li>
      </ol>
      <p>
        <strong>Maker/checker enforcement:</strong> Whoever prepares the reconciliation
        cannot be the one who approves it. This isn&apos;t bureaucracy — it&apos;s the
        single most effective control against rounding errors and reversed entries.
      </p>

      <h2>Stage 3 — Flux analysis (Day 4–5)</h2>
      <p>
        Once balances are reconciled, the next question is: <em>why did they change?</em>
        Flux analysis compares this period to a baseline (last month or last year)
        and explains every material movement.
      </p>
      <ul>
        <li>
          <strong>Set a materiality threshold</strong> based on your business — common
          choices are 5% of the account balance OR $10k absolute, whichever is greater.
        </li>
        <li>
          <strong>For every account exceeding threshold,</strong> pull the top
          transactions driving the variance and write a one-paragraph explanation that
          a reviewer can verify without re-doing your work.
        </li>
        <li>
          <strong>Watch for offsetting movements.</strong> A $50k increase in Marketing
          paired with a $50k decrease in Consulting Fees may just be a reclass — call it
          out so the CFO doesn&apos;t chase a phantom budget overrun.
        </li>
        <li>
          <strong>Flag the absent variance.</strong> Account that should have moved
          (e.g. depreciation that didn&apos;t post) but didn&apos;t is just as material
          as one that did.
        </li>
      </ul>

      <h2>Stage 4 — Consolidation and elimination (Day 5–6, multi-entity only)</h2>
      <p>
        If you&apos;re running multiple entities, eliminations come AFTER each entity&apos;s
        reconciliations and flux are signed off — not before. The order matters.
      </p>
      <ul>
        <li><strong>Confirm both sides of every IC pair tie.</strong> If A owes B $50k but B shows $48k receivable, fix the $2k before consolidating.</li>
        <li><strong>Book elimination JEs in the consolidation file</strong> (not in the underlying entities&apos; QBOs).</li>
        <li><strong>Generate the consolidated TB</strong> with eliminations applied, then re-verify A = L + E.</li>
      </ul>

      <h2>Stage 5 — Reporting and lock (Day 6–7)</h2>
      <ul>
        <li><strong>Generate financial package:</strong> IS, BS, CF, KPI dashboard, AI-narrated executive summary.</li>
        <li><strong>Variance commentary review</strong> — CFO/owner reviews and asks questions BEFORE you lock.</li>
        <li><strong>Lock period in GL.</strong> No more posts to closed periods without admin reopen.</li>
        <li><strong>Roll forward openings</strong> for next month: ending balances of every recon become next month&apos;s openings.</li>
        <li><strong>Document what changed and why</strong> in the close memo so next month&apos;s preparer has context.</li>
      </ul>

      <h2>The close checklist nobody writes down</h2>
      <p>
        Beyond the technical steps, the things that actually break close timelines are
        organizational:
      </p>
      <ul>
        <li>Operations doesn&apos;t close their books before you close yours.</li>
        <li>The CFO&apos;s questions on flux come AFTER you&apos;ve already locked.</li>
        <li>Prior-month reconciliations weren&apos;t actually approved — they were marked done.</li>
        <li>Intercompany pairs were classified wrong, so eliminations don&apos;t net.</li>
        <li>The team didn&apos;t agree on what &quot;material&quot; means.</li>
      </ul>
      <p>
        Most of these go away when the close runs in a tool that enforces order — you
        can&apos;t close a period until the prior one is closed, can&apos;t consolidate
        until both sides are reconciled, can&apos;t approve work you prepared. That&apos;s
        what we built into {" "}<Link to="/solutions" className="text-[var(--green)] underline">Nordavix</Link>:
        a sequential close gate, maker/checker as a default, AI commentary that doesn&apos;t
        wait for you to ask, and the elimination report that surfaces mismatches before
        they hide in consolidation.
      </p>

      <h2>Free download</h2>
      <p>
        You can copy this checklist into Notion, Asana, or wherever you track close
        tasks. If you&apos;d rather work in a tool that already enforces the order and
        does the reconciliations + flux + consolidation for you, {" "}
        <Link to="/sign-up" className="text-[var(--green)] underline font-semibold">
          start a free Nordavix workspace
        </Link>.
      </p>
    </article>
  )
}
