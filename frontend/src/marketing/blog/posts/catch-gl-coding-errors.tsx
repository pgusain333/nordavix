/**
 * Blog post — catching GL coding errors / misclassified transactions at month-end.
 * Primary: "GL coding errors". Cluster: "misclassified transactions", "general
 * ledger errors", "find duplicate payments", "missing accrual", "journal entry
 * review", "month-end anomaly detection", "does QuickBooks flag errors".
 * Product tie-in: Risk Radar (the five deterministic detectors), evidence-first
 * findings, confirm-first, Adjustments interlink, read-only QuickBooks.
 */
import { Link } from "react-router-dom"
import type { BlogPostMeta } from "@/marketing/blog/types"

export const meta: BlogPostMeta = {
  slug:        "catch-gl-coding-errors",
  title:       "How to Catch GL Coding Errors Before They Reach Your Financials",
  description: "Misclassified expenses, duplicate payments, missing accruals, and round-dollar plugs hide in the general ledger and survive the close. The five coding errors worth hunting every month — and how to catch all of them with evidence, not a sample.",
  date:        "2026-06-15",
  readingTime: "11 min read",
  category:    "Audit",
  excerpt:     "Sampling catches the errors you happen to look at. The ones that reach the board deck are the ones nobody looked at. Here are the five GL coding errors worth hunting every month — and how to find all of them with a tally you can defend, not a hunch.",
  faq: [
    {
      question: "What are GL coding errors?",
      answer:
        "GL coding errors are transactions posted to the wrong general-ledger account or with the wrong attributes — a vendor expensed to the wrong category, a duplicate bill, a missing recurring charge, a large entry with no description, or a round-number journal-entry plug. They don't break the trial balance (it still balances), which is exactly why they survive the close and surface later in budgets, audits, or board decks.",
    },
    {
      question: "How do you find misclassified transactions at month-end?",
      answer:
        "The reliable way is to compare each vendor's coding this period against its own history: if a vendor posts to one account 11 of its last 12 times and this month went somewhere else, that entry is worth a look. Doing this by eye across thousands of lines is impossible, so most teams sample — which only catches what they happen to open. Software can compare every transaction to the vendor's habit deterministically and surface only the ones that break the pattern.",
    },
    {
      question: "Can AI detect accounting errors reliably?",
      answer:
        "It depends on how the AI is used. A black-box model that 'thinks' an entry looks wrong is hard to trust and impossible to defend to an auditor. The reliable approach is deterministic: the accusation is arithmetic (this vendor posts here 92% of the time; this entry didn't), with the counts shown so a human can audit the logic in one glance. Use AI for labeling and explanation, never for the accusation itself.",
    },
    {
      question: "Does QuickBooks flag duplicate or miscoded entries?",
      answer:
        "Not in any systematic way. QuickBooks Online warns on a duplicate bill number at entry time and has basic rules, but it does not review the whole ledger at month-end for vendors coded against their own history, missing recurring charges, large unsupported entries, or round-dollar journal-entry plugs. That review is either done by hand or by close software layered on top of QuickBooks.",
    },
    {
      question: "What's the difference between flux analysis and coding-error detection?",
      answer:
        "Flux analysis works at the account-balance level — it asks why an account's balance moved versus prior period or budget. Coding-error detection works at the transaction level — it asks whether individual entries are in the right place, duplicated, missing, or unsupported. They're complementary: flux tells you a balance looks off; coding-error detection often tells you which specific entries caused it.",
    },
  ],
}

// ── Inline mockup: a Risk Radar finding with its evidence tally ─────────────
function FindingFigure() {
  return (
    <figure style={{ margin: "1.8em 0" }}>
      <svg viewBox="0 0 680 250" role="img"
        aria-label="A flagged finding card: AWS posted to Office Expense, with an evidence bar showing 11 of the vendor's last 12 entries went to Hosting and only this one went elsewhere — plus Accept and Dismiss actions."
        style={{ width: "100%", height: "auto", background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 12 }}>
        {/* card */}
        <rect x="20" y="20" width="640" height="210" rx="14" fill="var(--surface)" stroke="var(--border-strong)" strokeWidth="1.5" />
        {/* header row */}
        <circle cx="44" cy="52" r="5" fill="var(--green)" />
        <text x="60" y="57" fontSize="15" fontWeight="700" fill="var(--text)">AWS</text>
        <text x="120" y="57" fontSize="13" fill="var(--text-2)">
          <tspan textDecoration="line-through" fill="var(--text-muted)">Office Expense</tspan>
          <tspan dx="8">→</tspan>
          <tspan dx="8" fill="var(--text)">6010 · Hosting</tspan>
        </text>
        <text x="640" y="57" textAnchor="end" fontSize="14" fontWeight="700"
          fill="var(--text)" fontFamily="JetBrains Mono, monospace">$2,400</text>

        {/* evidence label */}
        <text x="44" y="92" fontSize="10" letterSpacing="0.5" fill="var(--text-muted)">EVIDENCE</text>
        {/* evidence bar */}
        <rect x="44" y="100" width="592" height="34" rx="7" fill="var(--surface-2)" stroke="var(--border)" />
        <rect x="44" y="100" width="497" height="34" rx="7" fill="var(--green)" opacity="0.92" />
        <text x="60" y="121" fontSize="12" fontWeight="600" fill="#fff">11 → Hosting</text>
        <rect x="545" y="100" width="91" height="34" rx="7" fill="var(--danger-subtle)" stroke="var(--danger-border)" />
        <text x="590" y="121" textAnchor="middle" fontSize="11" fontWeight="600" fill="var(--danger)">1 · this one</text>

        {/* footnote */}
        <text x="44" y="158" fontSize="12" fill="var(--text-2)">
          92% of this vendor&apos;s spend goes to Hosting — this entry didn&apos;t. Statistical pattern, not a guess.
        </text>

        {/* actions */}
        <rect x="44" y="178" width="232" height="36" rx="9" fill="var(--green)" />
        <text x="160" y="201" textAnchor="middle" fontSize="13" fontWeight="700" fill="#fff">Accept · post to Adjustments</text>
        <rect x="288" y="178" width="120" height="36" rx="9" fill="var(--surface)" stroke="var(--border-strong)" />
        <text x="348" y="201" textAnchor="middle" fontSize="13" fontWeight="600" fill="var(--text-2)">This is right</text>
        <text x="640" y="201" textAnchor="end" fontSize="11" fill="var(--text-muted)"
          fontFamily="JetBrains Mono, monospace">never writes to QuickBooks</text>
      </svg>
      <figcaption style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 8, textAlign: "center" }}>
        A finding states the claim, shows the literal tally behind it, and proposes the fix — so the reviewer approves evidence, not a hunch.
      </figcaption>
    </figure>
  )
}

export function Body() {
  return (
    <article>
      <p className="lead">
        A miscoded transaction doesn&apos;t break anything. The trial balance
        still balances; the close still finishes; the financials still print.
        That&apos;s precisely why GL coding errors are dangerous — they pass every
        check that looks for <em>imbalance</em>, and then surface three months
        later in a budget-vs-actual that makes no sense, or in an audit sample,
        or in a board deck you&apos;ve already presented. This is a guide to
        catching them while they&apos;re still cheap to fix: at month-end, with
        evidence instead of a hunch.
      </p>

      <h2>Why coding errors survive the close</h2>
      <p>
        Every standard close control hunts for <strong>imbalance</strong> — does
        the GL tie to the subledger, does the bank reconcile, does the trial
        balance net to zero. A coding error trips none of them. Booking a $2,400
        AWS bill to Office Expense instead of Hosting keeps the books perfectly
        balanced; it just puts the cost in the wrong place on the P&amp;L. So the
        error sails through reconciliation and lands in your financials looking
        completely legitimate.
      </p>
      <p>
        The traditional defense is review — a controller eyeballing the GL detail.
        But the math is brutal: a small company posts thousands of lines a month,
        and a human can meaningfully scan a few dozen. So review becomes{" "}
        <strong>sampling</strong>, and sampling, by definition, only catches the
        errors you happen to open. The ones that reach the board deck are the ones
        nobody opened. QuickBooks won&apos;t save you here either — it warns on a
        duplicate bill number at entry, but it does not sweep the whole ledger at
        month-end looking for entries coded against their own history.
      </p>

      <h2>The five coding errors worth hunting every month</h2>
      <p>
        You don&apos;t need to check everything — you need to check the handful of
        patterns that account for most real misstatements. Each of these is{" "}
        <strong>deterministic</strong>: you can define it precisely and test every
        transaction against it, no judgment call required to surface the candidate.
      </p>
      <table>
        <thead>
          <tr><th>The signal</th><th>What it catches</th><th>Why it matters</th></tr>
        </thead>
        <tbody>
          <tr>
            <td><strong>Misclassified vendor</strong></td>
            <td>A vendor coded to an account that breaks its own strong history (posts to Hosting 11 of 12 times, this one went to Office Expense)</td>
            <td>Wrong P&amp;L geography — distorts margins, budgets, and department reporting</td>
          </tr>
          <tr>
            <td><strong>Missing recurring item</strong></td>
            <td>A charge that arrives almost every month is absent this period</td>
            <td>Understated expense — usually a missing accrual that should be booked</td>
          </tr>
          <tr>
            <td><strong>Duplicate payment</strong></td>
            <td>The same vendor and amount booked twice in a short window across two different transactions</td>
            <td>Double-counted expense and, often, cash actually paid twice</td>
          </tr>
          <tr>
            <td><strong>Large entry, no memo</strong></td>
            <td>A material entry posted with a blank description</td>
            <td>Unsupported by definition — the audit finding writing itself</td>
          </tr>
          <tr>
            <td><strong>Round-dollar journal entry</strong></td>
            <td>A manual JE for a suspiciously round number (an exact multiple of $1,000)</td>
            <td>Often an estimate or plug that needs real support before close</td>
          </tr>
        </tbody>
      </table>
      <p>
        Notice what these have in common: none of them require an opinion to{" "}
        <em>find</em>. A vendor either broke its posting habit or it didn&apos;t.
        An entry either has a memo or it doesn&apos;t. That&apos;s the whole trick
        to catching coding errors at scale — define the pattern precisely enough
        that a machine can check all of it, then let a human judge only the
        handful that surface.
      </p>

      <h2>Manual review vs. a deterministic radar</h2>
      <p>
        The difference between sampling and sweeping isn&apos;t effort — it&apos;s
        coverage, and coverage is the entire game.
      </p>
      <table>
        <thead>
          <tr><th></th><th>Manual review (eyeball / sample)</th><th>Deterministic sweep</th></tr>
        </thead>
        <tbody>
          <tr><td>Coverage</td><td>A few dozen lines you chose</td><td>Every transaction in the period</td></tr>
          <tr><td>Consistency</td><td>Varies by reviewer, time of day, fatigue</td><td>Same rules applied every month</td></tr>
          <tr><td>Evidence</td><td>&ldquo;This looks off to me&rdquo;</td><td>The literal tally — 11 of 12 went elsewhere</td></tr>
          <tr><td>Speed</td><td>Hours of scrolling GL detail</td><td>Seconds, automatically after each sync</td></tr>
          <tr><td>What it costs to be wrong</td><td>Reputation, restated numbers</td><td>Tuned for low false positives; you still confirm each one</td></tr>
        </tbody>
      </table>

      <h2>Evidence, not a guess (the part that earns trust)</h2>
      <p>
        Here is where most &ldquo;AI bookkeeping&rdquo; tools lose accountants:
        they surface a finding the user can&apos;t verify. &ldquo;Our model thinks
        this entry is wrong&rdquo; is not something you can defend to a reviewer,
        let alone an auditor. The fix is to make the accusation <strong>arithmetic
        and visible</strong>. Don&apos;t say &ldquo;this looks misclassified&rdquo;
        — show that this vendor posted to Hosting on 11 of its last 12 transactions
        and this one didn&apos;t, and put that tally on the screen.
      </p>
      <FindingFigure />
      <p>
        This is the principle worth stealing whether you build it yourself or buy
        it: <strong>the detection should be deterministic; AI, if used at all,
        belongs on the labeling and the explanation — never the accusation.</strong>{" "}
        A finding you can audit in one glance is one a preparer will act on and a
        reviewer will trust. A black-box score is one everybody learns to ignore.
        (The same evidence-first logic underpins good{" "}
        <Link to="/blog/flux-analysis-guide">flux analysis</Link> — explain the
        variance with the transactions that caused it, not an adjective.)
      </p>

      <h2>A manual version you can run this month</h2>
      <p>
        You don&apos;t need software to start. If you have an hour and a GL export,
        here&apos;s a defensible pass:
      </p>
      <ol>
        <li><strong>Build a vendor-by-account pivot</strong> over the last 6–12 months. For each vendor, eyeball its dominant account. Any current-month entry to a different account is a misclassification candidate.</li>
        <li><strong>List vendors that bill almost every month</strong>, then check which are missing this period. Each absence is a possible missing accrual.</li>
        <li><strong>Sort the period by vendor + amount</strong> and scan for the same vendor and amount appearing twice within a week — duplicate-payment candidates.</li>
        <li><strong>Filter entries over your materiality threshold with a blank memo.</strong> Every one needs support before you sign off.</li>
        <li><strong>Filter manual journal entries to exact thousands.</strong> Confirm each round-dollar entry is backed by a real calculation, not a plug.</li>
      </ol>
      <p>
        Do this once and two things happen: you&apos;ll catch real errors, and
        you&apos;ll feel exactly how unscalable it is by hand. That tension — the
        review is valuable but impossible to do completely — is the whole reason
        to automate it. (It pairs naturally with a structured{" "}
        <Link to="/blog/month-end-close-checklist">month-end close checklist</Link>{" "}
        and the{" "}
        <Link to="/blog/maker-checker-accounting-controls">maker-checker controls</Link>{" "}
        that decide who gets to approve the fix.)
      </p>

      <h2>How Nordavix does it — the Risk Radar</h2>
      <p>
        Nordavix runs all five checks above automatically, on a read-only
        connection to QuickBooks, as a feature called the{" "}
        <strong>Risk Radar</strong>. The design choices are deliberate, and they
        map exactly to the principles in this post:
      </p>
      <ul>
        <li><strong>Deterministic, never a guess.</strong> Every flag is arithmetic — the vendor&apos;s own tally, the duplicate pair, the missing month — shown on the finding so you can audit the logic instantly.</li>
        <li><strong>It runs itself.</strong> The sweep fires automatically after each QuickBooks sync, so findings are waiting before anyone clicks anything. No extra AI spend — the detection is pure logic.</li>
        <li><strong>Confirm-first, and it never writes to QuickBooks.</strong> Accept a flag and Nordavix drafts the correcting entry into an Adjustments queue for a human to review and post; nothing is ever pushed to your books automatically.</li>
        <li><strong>It learns.</strong> Dismiss a finding as correct and that vendor-and-account pairing is never flagged again — the radar gets quieter and sharper the more you use it.</li>
      </ul>
      <p>
        The result is the coverage of a full-ledger sweep with the defensibility
        of a hand review: every transaction checked, only the real exceptions
        surfaced, each one backed by evidence and gated behind a human approval.
        It&apos;s the second set of eyes a small team never has time to be.
      </p>

      <aside className="callout">
        <strong>See it on your own books (free in beta):</strong> Nordavix
        connects to QuickBooks read-only and runs the Risk Radar across your
        general ledger — misclassified vendors, missing accruals, duplicates,
        unsupported entries, and round-dollar plugs, each with the evidence
        behind it.{" "}
        <Link to="/sign-up">Start a workspace</Link> or see the full{" "}
        <Link to="/solutions">close platform</Link>. Read-only, confirm-first,
        and it never touches your QuickBooks data.
      </aside>

      <h2>FAQ</h2>
      <h3>What are GL coding errors?</h3>
      <p>
        Transactions posted to the wrong general-ledger account or with the wrong
        attributes — a vendor expensed to the wrong category, a duplicate bill, a
        missing recurring charge, a large entry with no description, or a
        round-number journal-entry plug. They don&apos;t break the trial balance,
        which is why they survive the close and surface later in budgets, audits,
        or board decks.
      </p>
      <h3>How do you find misclassified transactions at month-end?</h3>
      <p>
        Compare each vendor&apos;s coding this period against its own history: a
        vendor that posts to one account 11 of its last 12 times and suddenly went
        elsewhere is worth a look. Doing that by eye across thousands of lines is
        impossible, so teams sample — software can compare every transaction to the
        vendor&apos;s habit and surface only the ones that break the pattern.
      </p>
      <h3>Can AI detect accounting errors reliably?</h3>
      <p>
        Only if the accusation is deterministic and visible. A black-box model that
        &ldquo;thinks&rdquo; an entry is wrong is impossible to defend; an
        arithmetic rule that shows its tally (this vendor posts here 92% of the
        time; this entry didn&apos;t) is auditable in one glance. Use AI for
        labeling and explanation, not for the accusation itself.
      </p>
      <h3>Does QuickBooks flag duplicate or miscoded entries?</h3>
      <p>
        Not systematically. QuickBooks Online warns on a duplicate bill number at
        entry time, but it does not review the whole ledger at month-end for
        vendors coded against their own history, missing recurring charges, large
        unsupported entries, or round-dollar journal-entry plugs. That review is
        done by hand or by{" "}
        <Link to="/blog/best-quickbooks-month-end-close-software">close software
        layered on top of QuickBooks</Link>.
      </p>
      <h3>What&apos;s the difference between flux analysis and coding-error detection?</h3>
      <p>
        Flux analysis works at the account-balance level — why a balance moved
        versus prior period or budget. Coding-error detection works at the
        transaction level — whether individual entries are in the right place,
        duplicated, missing, or unsupported. Flux tells you a balance looks off;
        coding-error detection often tells you which entries caused it.
      </p>
    </article>
  )
}
