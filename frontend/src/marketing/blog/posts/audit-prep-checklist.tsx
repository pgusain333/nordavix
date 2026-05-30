/**
 * Blog post — audit prep checklist.
 * Target keyword: "audit prep checklist" + "PBC list" + "year-end audit
 *                  preparation" — high-intent for CPAs prepping clients.
 */
import { Link } from "react-router-dom"
import type { BlogPostMeta } from "@/marketing/blog/types"

export const meta: BlogPostMeta = {
  slug:        "audit-prep-checklist",
  title:       "Audit prep: the binder a Big-4 auditor wishes you'd hand over",
  description: "Year-end audit prep checklist for controllers and CPAs — the PBC items that actually get asked for, organized the way auditors test, with the documentation auditors don't have to re-request three times.",
  date:        "2026-05-29",
  readingTime: "11 min read",
  category:    "Audit",
  excerpt:     "Every audit gets longer because someone couldn't find the rec, the schedule, or the signed-off variance commentary. Here's the binder structure that makes your auditor's life — and yours — about 40% easier.",
}

export function Body() {
  return (
    <article>
      <p className="lead">
        Every external audit gets longer because someone on the client side
        can&apos;t find the reconciliation, the schedule, or the signed-off
        variance commentary the auditor asked for last Tuesday. This isn&apos;t
        an audit-team problem — it&apos;s a documentation problem. The version
        below is the PBC binder structure that, when your auditor opens it, cuts
        their testing time by about 40% and your back-and-forth by even more.
      </p>

      <h2>What auditors actually want</h2>
      <p>
        The mental model most controllers carry — &quot;the auditor wants
        everything&quot; — is wrong. Auditors want a small, specific set of
        items per account, organized by what they&apos;re going to test. The
        big four buckets are:
      </p>
      <ol>
        <li><strong>Existence + valuation evidence</strong> for every material balance-sheet account.</li>
        <li><strong>Roll-forward support</strong> for accounts where the year-end balance depends on a prior period (PPE, debt, equity, retained earnings).</li>
        <li><strong>Cut-off support</strong> for revenue, AR, AP, and accruals around year-end.</li>
        <li><strong>Variance commentary</strong> for any material P&amp;L line that moved YoY.</li>
      </ol>
      <p>
        Everything else they request — meeting minutes, contracts, debt
        covenants, related-party schedules — fills out the audit narrative but
        isn&apos;t the bulk of testing. The four buckets above are 70% of the
        time.
      </p>

      <h2>The binder structure that works</h2>
      <p>
        Whether you use a shared folder, a workpaper tool, or a physical binder,
        organize it by audit-area mirroring the auditor&apos;s testing program:
      </p>

      <h3>00 — Financials and trial balance</h3>
      <ul>
        <li>Year-end balance sheet, income statement, statement of cash flows (PDF + Excel).</li>
        <li>Trial balance at year-end (Excel with formulas intact, not flattened).</li>
        <li>Adjusted trial balance with year-end AJEs separately identified.</li>
        <li>Reconciliation between TB and FS line items.</li>
      </ul>

      <h3>01 — Cash and equivalents</h3>
      <ul>
        <li>Bank reconciliation for each account at year-end (per <Link to="/blog/bank-reconciliation-quickbooks">our bank rec guide</Link>).</li>
        <li>Year-end bank statements (every account, even if zero).</li>
        <li>Outstanding-check list with aging.</li>
        <li>Bank confirmation letters (auditors usually send these directly, but the controller approves the list of accounts to confirm).</li>
        <li>Restricted-cash schedule and supporting agreement.</li>
      </ul>

      <h3>02 — Accounts receivable</h3>
      <ul>
        <li>Year-end AR aging detail tied to GL balance.</li>
        <li>Reconciliation of aging to GL (sum of buckets = GL exactly).</li>
        <li>Allowance for doubtful accounts calculation with policy.</li>
        <li>Subsequent collections schedule through audit fieldwork date (proves AR is collectible).</li>
        <li>Sample of customer invoices for selection testing.</li>
        <li>AR confirmation letter list with addresses.</li>
      </ul>

      <h3>03 — Inventory (if applicable)</h3>
      <ul>
        <li>Year-end inventory count sheets with location, item, quantity, unit cost, extension.</li>
        <li>Count team sign-off + observation memo.</li>
        <li>Reconciliation between physical count and perpetual records.</li>
        <li>Lower-of-cost-or-NRV analysis.</li>
        <li>Slow-moving / obsolete reserve calculation.</li>
      </ul>

      <h3>04 — Prepaids and other current assets</h3>
      <ul>
        <li>Schedule of each prepaid item: vendor, original amount, term, monthly amortization, year-end remaining balance.</li>
        <li>Supporting invoices for prepaid items over the materiality threshold.</li>
        <li>Total ties to GL balance.</li>
      </ul>

      <h3>05 — Property, plant, and equipment</h3>
      <ul>
        <li>Roll-forward: opening + additions − disposals − depreciation = closing.</li>
        <li>Full fixed-asset schedule by asset, with acquisition date, cost, useful life, accumulated depreciation, NBV.</li>
        <li>Supporting invoices for current-year additions.</li>
        <li>Disposal calculations + gain/loss.</li>
        <li>Capitalization policy.</li>
        <li>Impairment analysis if any triggering events.</li>
      </ul>

      <h3>06 — Intangibles / goodwill (if applicable)</h3>
      <ul>
        <li>Roll-forward of each intangible class.</li>
        <li>Amortization calculation.</li>
        <li>Goodwill impairment test or qualitative assessment.</li>
      </ul>

      <h3>07 — Accounts payable + accrued liabilities</h3>
      <ul>
        <li>Year-end AP aging detail tied to GL.</li>
        <li>Reconciliation of aging to GL.</li>
        <li>Search for unrecorded liabilities — list of subsequent-period payments with supporting invoices, identifying any that should have been accrued.</li>
        <li>Accrual schedule per account (bonus, vacation, rent, utilities, etc.) with calculation methodology.</li>
        <li>Vendor confirmation letter list (often a sample, not all).</li>
      </ul>

      <h3>08 — Debt + interest</h3>
      <ul>
        <li>Roll-forward of every loan / line of credit: opening + draws − payments + interest accrued = closing.</li>
        <li>Year-end lender statements.</li>
        <li>Loan agreements + amendments.</li>
        <li>Covenant compliance calculation with supporting numbers.</li>
        <li>Interest expense schedule.</li>
      </ul>

      <h3>09 — Equity</h3>
      <ul>
        <li>Retained-earnings roll-forward (prior RE + net income − dividends/distributions = current RE).</li>
        <li>Capital activity schedule (stock issued, repurchased, options granted/exercised).</li>
        <li>Stock-based compensation schedule + Black-Scholes inputs if applicable.</li>
        <li>Board minutes authorizing material capital actions.</li>
      </ul>

      <h3>10 — Revenue</h3>
      <ul>
        <li>Revenue recognition policy (5-step ASC 606 narrative).</li>
        <li>Sample of customer contracts demonstrating the policy.</li>
        <li>Cut-off testing population — last 5 invoices of the year + first 5 of next year, with shipping/service-delivery dates.</li>
        <li>Deferred revenue roll-forward + breakdown by performance obligation.</li>
      </ul>

      <h3>11 — Operating expenses</h3>
      <ul>
        <li>Variance commentary (YoY) for every material P&amp;L line — per <Link to="/blog/flux-analysis-guide">our flux analysis guide</Link>.</li>
        <li>Supporting documentation for unusual or non-recurring items.</li>
      </ul>

      <h3>12 — Taxes</h3>
      <ul>
        <li>Tax provision calculation (current + deferred).</li>
        <li>Federal and state return-to-provision reconciliations.</li>
        <li>Effective tax rate reconciliation.</li>
        <li>Sales/use tax accrual.</li>
        <li>Payroll tax liabilities + filings.</li>
      </ul>

      <h3>13 — Intercompany + related parties</h3>
      <ul>
        <li>List of all related-party entities + nature of relationship.</li>
        <li>Intercompany balance schedule at year-end with eliminations (see <Link to="/blog/intercompany-consolidation-quickbooks">the IC consolidation guide</Link>).</li>
        <li>Related-party transaction schedule (amounts + nature).</li>
        <li>Disclosure documentation.</li>
      </ul>

      <h3>14 — Subsequent events</h3>
      <ul>
        <li>Subsequent-events memo summarizing material events between year-end and report date.</li>
        <li>Board minutes from year-end through report date.</li>
      </ul>

      <h3>15 — Risk + commitments</h3>
      <ul>
        <li>Legal letter (auditor sends; client lists pending litigation).</li>
        <li>Operating lease + finance lease schedules (ASC 842 obligations).</li>
        <li>Material commitments (purchase obligations, guarantees).</li>
        <li>Insurance schedule.</li>
      </ul>

      <h2>What separates a great binder from a passable one</h2>
      <p>
        Auditors don&apos;t talk about it, but they remember the clients who
        make their lives easy. Three things separate a binder that gets a
        &quot;thank you&quot; from one that gets &quot;can you also send…&quot;
        emails for two weeks:
      </p>
      <ol>
        <li>
          <strong>Every reconciliation ties to the GL exactly.</strong> Not
          &quot;close enough&quot; — exactly. The two-cent variance is what an
          auditor learns to chase, and chasing it costs them an hour.
        </li>
        <li>
          <strong>Every schedule has a clear footing/reference</strong> to its
          GL account and a sign-off (preparer + reviewer, with dates). Auditors
          test maker/checker — a schedule with one signature is a red flag.
        </li>
        <li>
          <strong>Cross-references work.</strong> The bank rec references the
          GL trial balance line number. The fixed-asset roll-forward references
          the FA schedule sheet. The roll-forward sheet shows where the additions
          tie to invoices in the supporting-docs folder.
        </li>
      </ol>

      <h2>The hidden cost of a bad audit prep</h2>
      <p>
        The most expensive part of audit isn&apos;t the firm&apos;s hours — it&apos;s
        the controller&apos;s time. A poorly prepped audit costs the controller
        80–150 hours of back-and-forth across 6–10 weeks. A well-prepped audit
        costs maybe 30–40. That delta is essentially a month of senior accountant
        productivity reclaimed.
      </p>
      <p>
        The other hidden cost: management letter comments. Auditors are required
        to report material weaknesses or significant deficiencies they observe.
        A messy audit gives them a longer list to choose from. A clean one gives
        them very little.
      </p>

      <h2>The role of close discipline</h2>
      <p>
        Most audit prep happens in November and December for a calendar-year
        audit. But the binder above is really 11 months of close discipline plus
        4 weeks of consolidation. If every monthly close has signed reconciliations,
        variance commentary, and complete schedules, year-end is just rolling
        them up. If monthly close is sloppy, no amount of year-end prep saves you.
      </p>
      <p>
        That&apos;s the principle behind {" "}<Link to="/solutions">Nordavix</Link>:
        every close should produce audit-quality documentation as a byproduct,
        not as a separate scramble. Reconciliations are signed each month. Variance
        commentary is written each month. Roll-forwards happen automatically. By
        December, the audit binder is mostly assembled — you just need to add the
        legal letters and the subsequent events memo.
      </p>

      <h2>Free download (sort of)</h2>
      <p>
        The 15-section structure above is the checklist. Copy it into a folder
        structure (Drive, SharePoint, Box, whatever) and you have the binder
        skeleton. If you want a tool that&apos;s already generating those reconciliations
        and roll-forwards each month — and that exports them as audit-ready PDFs —
        {" "}<Link to="/sign-up"><strong>start a free Nordavix workspace</strong></Link>.
      </p>
    </article>
  )
}
