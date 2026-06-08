/**
 * Blog post — bank reconciliation in QuickBooks.
 * Primary: "how to do a bank reconciliation in quickbooks (online)".
 * Cluster: "bank reconciliation quickbooks", "qbo reconciliation",
 *          "bank reconciliation in quickbooks online", "...desktop".
 */
import { Link } from "react-router-dom"
import type { BlogPostMeta } from "@/marketing/blog/types"

export const meta: BlogPostMeta = {
  slug:        "bank-reconciliation-quickbooks",
  title:       "How to Do a Bank Reconciliation in QuickBooks Online (2026)",
  description: "Step-by-step bank reconciliation in QuickBooks Online (QBO): the right cut-off, matching cleared transactions, handling outstanding items, what to do when it won't balance, and an audit-ready workpaper.",
  date:        "2026-05-30",
  readingTime: "9 min read",
  category:    "Reconciliation",
  excerpt:     "Bank rec is the first reconciliation anyone learns and the one most controllers still get wrong. Here's the version that ties cleanly, holds up under audit, and doesn't leave you chasing $0.32 differences at 11pm.",
  lastModified: "2026-06-08",
  faq: [
    {
      question: "How do you do a bank reconciliation in QuickBooks Online?",
      answer:
        "Go to Banking → Reconcile, choose the account, and enter the statement's ending balance and date. Tick every transaction that appears on the bank statement, leave uncleared items (deposits in transit, outstanding checks) unchecked, and make sure the difference reads $0.00 before clicking Finish. Then save the Reconciliation Report and attach the bank statement as evidence.",
    },
    {
      question: "How do you reconcile a checking account in QBO?",
      answer:
        "It's the same Reconcile workflow: pick the checking account, match the cleared deposits and payments to the statement, and resolve any leftover difference — usually a changed beginning balance, a modified cleared transaction, or unbooked bank fees — before you finish.",
    },
    {
      question: "Why won't my bank reconciliation balance in QuickBooks?",
      answer:
        "The difference is almost always one of five things: a changed beginning balance, a cleared transaction that was edited or deleted after the fact (run the Reconciliation Discrepancy Report), duplicate or missing bank-feed transactions, unbooked bank fees or interest, or foreign-currency revaluation.",
    },
    {
      question: "Is reconciling in QuickBooks Desktop different from QuickBooks Online?",
      answer:
        "The screens differ but the method is identical: tie the GL cash balance to the statement using cleared items plus outstanding deposits and checks. In both, you'll find it under Banking → Reconcile.",
    },
  ],
}

export function Body() {
  return (
    <article>
      <p className="lead">
        Bank reconciliation in QuickBooks looks simple — match the GL balance to
        the bank statement. In practice, almost every close has at least one bank
        rec that doesn&apos;t tie, and the chase eats hours. Here&apos;s how to do a
        bank reconciliation in QuickBooks Online (QBO) the right way, step by step —
        the exact order, the gotchas, and what to do when it refuses to balance.
        The same workflow reconciles a checking, savings, or credit-card account.
      </p>

      <h2>What &quot;reconciled&quot; actually means</h2>
      <p>
        A bank account is reconciled when three numbers agree:
      </p>
      <ol>
        <li>The <strong>GL cash balance</strong> per QuickBooks as of period end.</li>
        <li>The <strong>statement ending balance</strong> from the bank statement.</li>
        <li>The <strong>adjusted balance</strong> = statement ending + outstanding deposits − outstanding checks + bank errors.</li>
      </ol>
      <p>
        When (1) and (3) match to the penny, you&apos;re reconciled. The outstanding
        items are the bridge between what your books say and what the bank confirms.
      </p>

      <h2>The right cut-off</h2>
      <p>
        Always reconcile to the bank&apos;s statement period end, not to your
        own month-end if they differ. If your fiscal month ends May 31 but your
        bank statement runs May 5 to June 4, you&apos;ll do a sub-reconciliation
        from June 1 to May 31 to bridge to your close period. Many controllers
        skip this and reconcile to whatever the statement says — then wonder why
        the GL doesn&apos;t tie to the cash on the BS.
      </p>
      <aside className="callout">
        <strong>Rule of thumb:</strong> Your GL cash balance at period end MUST
        equal your bank balance at period end PLUS outstanding deposits MINUS
        outstanding checks. Anything else and you&apos;re lying to your BS.
      </aside>

      <h2>How to do a bank reconciliation in QuickBooks Online (step by step)</h2>
      <ol>
        <li>
          <strong>Get the statement.</strong> Download the PDF + a CSV/QFX if
          your bank exports one. The CSV makes downstream matching faster, but
          the PDF is the source of truth — it&apos;s what an auditor will ask for.
        </li>
        <li>
          <strong>Open Reconcile in QBO.</strong> Banking → Reconcile → pick the
          account → enter the statement ending balance and ending date from the
          PDF. QBO will pull every uncleared transaction posted to the GL through
          that date.
        </li>
        <li>
          <strong>Match every transaction</strong> in the QBO list that appears
          on the statement. QBO shows them in two columns (deposits, payments) —
          click each one that cleared. The running difference at the bottom right
          should approach zero as you go.
        </li>
        <li>
          <strong>Leave un-cleared transactions un-checked.</strong> Those are
          your outstanding items — deposits in transit (you booked them, the bank
          hasn&apos;t cleared them yet) and outstanding checks (issued but
          uncashed). They&apos;ll appear on next month&apos;s statement.
        </li>
        <li>
          <strong>Difference should be $0.00.</strong> If it&apos;s not, stop —
          don&apos;t click Finish. See the troubleshooting section below.
        </li>
        <li>
          <strong>Click Finish + run the Reconciliation Report.</strong> Save the
          report as PDF + attach the bank statement PDF to the period&apos;s
          working papers.
        </li>
      </ol>
      <p>
        <strong>On QuickBooks Desktop?</strong> The screens look different, but the
        method is identical — Banking → Reconcile, enter the statement ending
        balance, tick the cleared items, and leave outstanding deposits and checks
        unchecked until they clear next month.
      </p>

      <h2>When it doesn&apos;t tie — the troubleshooting decision tree</h2>
      <p>
        If the difference is anything other than $0.00, work through these in
        order. The cause is almost always one of these five:
      </p>

      <h3>1. Beginning balance is wrong</h3>
      <p>
        The most common cause. QBO&apos;s &quot;Beginning balance&quot; is what
        you ended last month&apos;s reconciliation at. If someone deleted or
        modified a prior-period cleared transaction, the beginning balance shifts
        without warning. Compare QBO&apos;s beginning balance to the bank&apos;s
        starting balance on the statement — if they differ, find what changed
        in last month&apos;s reconciliation.
      </p>

      <h3>2. A cleared transaction was modified or deleted post-reconciliation</h3>
      <p>
        Run QBO&apos;s Reconciliation Discrepancy Report (Reports → For my
        Accountant → Reconciliation Discrepancy). It lists every transaction
        that was modified or deleted AFTER a reconciliation cleared it. Find
        the rogue change, recreate the entry correctly, re-mark cleared.
      </p>

      <h3>3. Duplicate or missing transactions</h3>
      <p>
        Common with bank feed downloads. If a deposit appears in both the bank
        feed and a manual entry, you&apos;ll see double on the GL. Search QBO
        by amount + date for the deposits / payments showing on the statement
        but not in the reconcile screen — they&apos;re probably hiding under a
        different account or duplicated.
      </p>

      <h3>4. Bank fees, interest, returned items not yet booked</h3>
      <p>
        Bank statements include items the bookkeeper hasn&apos;t booked yet —
        wire fees, monthly account fees, interest earned, NSF returns. Each
        needs a journal entry into the right expense / income account before
        the reconciliation can tie.
      </p>

      <h3>5. Foreign currency revaluation</h3>
      <p>
        If the account is in a non-functional currency, the GL balance at
        period end reflects the spot rate at period end, but each transaction
        was booked at its transaction-date rate. The difference is FX
        revaluation, booked through a Realized/Unrealized FX Gain account. QBO
        Advanced handles this automatically if you have multi-currency on; QBO
        Essentials does not.
      </p>

      <h2>Outstanding items that have aged too long</h2>
      <p>
        Outstanding checks &gt; 90 days are a problem. Either the check is lost
        and needs to be voided + reissued, or the payee never deposited it. Some
        states have escheatment laws — uncashed checks above a threshold revert
        to the state after a defined period. Document your policy and stick to
        it; auditors look for stale items.
      </p>
      <p>
        Outstanding deposits in transit &gt; 5 business days are even worse — a
        deposit that hasn&apos;t cleared in a week is probably either reversed,
        misposted, or never made. Investigate immediately.
      </p>

      <h2>The audit-defensible bank reconciliation</h2>
      <p>
        A bank reconciliation that holds up under audit has six things attached
        as evidence:
      </p>
      <ol>
        <li><strong>The QBO Reconciliation Report</strong> for the period.</li>
        <li><strong>The bank statement PDF</strong> covering the same period.</li>
        <li><strong>A list of outstanding items</strong> with date, payee, amount, and explanation for any &gt; 30 days.</li>
        <li><strong>Sign-off by preparer + reviewer</strong> (different people — maker/checker).</li>
        <li><strong>Cross-reference</strong> to the GL trial balance to prove the GL cash equals what&apos;s on the BS.</li>
        <li><strong>Notes on any unusual items</strong> — large wire ins, NSF returns, fraud-related activity.</li>
      </ol>
      <p>
        Most controllers attach (1) and (2). The (3)–(6) items are what
        separates a reconciliation from a real workpaper.
      </p>

      <h2>Multi-bank-account reality</h2>
      <p>
        Real companies have 4–10 bank accounts: operating, payroll, savings,
        merchant deposit, FX, sometimes ESCROW. Each one needs its own
        reconciliation, attached evidence, and aging review. The process is the
        same; the volume is the problem. This is exactly the friction that drove
        us to build the {" "}<Link to="/solutions">Nordavix reconciliations module</Link> —
        a single dashboard showing every account&apos;s reconciliation status,
        balance, and outstanding-item aging, so you can spot the broken one
        without opening each individually.
      </p>

      <h2>Beyond bank — the same pattern for every BS account</h2>
      <p>
        Bank reconciliation is the template every other reconciliation follows.
        You&apos;re always doing the same thing: tie the GL to an external
        source, document the bridging items, get sign-off. The accounts change
        — credit cards, AR (tie to aging), AP (tie to vendor statements),
        prepaids (tie to amortization schedule), accruals (tie to invoices /
        timesheets), fixed assets (tie to depreciation schedule), debt (tie to
        lender statement) — but the discipline is identical.
      </p>
      <p>
        For the full method that applies to every account, see our {" "}
        <Link to="/blog/balance-sheet-reconciliation">balance sheet reconciliation guide</Link>,
        and {" "}
        <Link to="/blog/month-end-close-checklist">the full month-end close checklist</Link>.
      </p>

      <h2>Tools that do this without the manual matching</h2>
      <p>
        Bank reconciliation in 2026 doesn&apos;t need to involve clicking 400
        boxes in QBO every month. Tools that pull both the GL and the bank
        feed automatically — and that surface the un-matched items as a
        worklist — turn this from a 90-minute monthly chore into a 10-minute
        review.
      </p>
      <p>
        {" "}<Link to="/solutions">Nordavix</Link> sits on top of your QBO and
        does exactly that for every balance-sheet account, not just bank. The
        single workspace shows you which recs are open, which are mismatched,
        and what the outstanding items look like. {" "}
        <Link to="/sign-up"><strong>Start a free workspace</strong></Link> and try
        it on your next close — free during beta.
      </p>

      <h2>Frequently asked questions</h2>

      <h3>How do you do a bank reconciliation in QuickBooks Online?</h3>
      <p>
        Go to Banking → Reconcile, choose the account, and enter the
        statement&apos;s ending balance and date. Tick every transaction that
        appears on the bank statement, leave uncleared items (deposits in transit,
        outstanding checks) unchecked, and make sure the difference reads $0.00
        before clicking Finish. Then save the Reconciliation Report and attach the
        bank statement as evidence.
      </p>

      <h3>How do you reconcile a checking account in QBO?</h3>
      <p>
        It&apos;s the same Reconcile workflow: pick the checking account, match the
        cleared deposits and payments to the statement, and resolve any leftover
        difference — usually a changed beginning balance, a modified cleared
        transaction, or unbooked bank fees — before you finish.
      </p>

      <h3>Why won&apos;t my bank reconciliation balance in QuickBooks?</h3>
      <p>
        The difference is almost always one of five things: a changed beginning
        balance, a cleared transaction that was edited or deleted after the fact
        (run the Reconciliation Discrepancy Report), duplicate or missing bank-feed
        transactions, unbooked bank fees or interest, or foreign-currency
        revaluation.
      </p>

      <h3>Is reconciling in QuickBooks Desktop different from QuickBooks Online?</h3>
      <p>
        The screens differ but the method is identical: tie the GL cash balance to
        the statement using cleared items plus outstanding deposits and checks. In
        both, you&apos;ll find it under Banking → Reconcile.
      </p>
    </article>
  )
}
