/**
 * Blog post — balance sheet reconciliation checklist + template.
 * Primary: "balance sheet reconciliation checklist". Cluster: "which balance
 * sheet accounts need to be reconciled", "monthly balance sheet reconciliations",
 * "how to reconcile balance sheet accounts", "reconciling balance sheet accounts".
 * Supports the cornerstone /blog/balance-sheet-reconciliation (cross-linked).
 */
import { Link } from "react-router-dom"
import type { BlogPostMeta } from "@/marketing/blog/types"

export const meta: BlogPostMeta = {
  slug:        "balance-sheet-reconciliation-checklist",
  title:       "The Balance Sheet Reconciliation Checklist (+ Free Template) 2026",
  description: "A month-end balance sheet reconciliation checklist: which accounts to reconcile, what each one ties to, how often, and a copy-paste roll-forward + sign-off template. Built for controllers on QuickBooks.",
  date:        "2026-06-08",
  readingTime: "8 min read",
  category:    "Reconciliation",
  excerpt:     "Which balance sheet accounts actually need reconciling, what each one ties to, and the order to do them in — as a checklist you can run every month, plus a roll-forward and sign-off template you can copy.",
  faq: [
    {
      question: "Which balance sheet accounts need to be reconciled?",
      answer:
        "Every account with a balance — not just cash. Assets: bank/cash, accounts receivable, prepaids, inventory, fixed assets/accumulated depreciation, and other receivables. Liabilities: accounts payable, accrued liabilities, payroll liabilities, credit cards, sales/other taxes payable, deferred revenue, loans/debt, and intercompany. Equity: common stock, additional paid-in capital, distributions/dividends, and retained earnings. Income statement accounts aren't reconciled — they're reviewed with flux analysis.",
    },
    {
      question: "How often should you reconcile balance sheet accounts?",
      answer:
        "Reconcile the active, higher-risk accounts (cash, AR, AP, accruals, payroll, credit cards) every month as part of the close. Slower-moving accounts (fixed assets, long-term debt, equity) can be reconciled monthly too, but at minimum quarterly. The rule: any account that moves, or that an auditor will sample, gets a monthly tie-out.",
    },
    {
      question: "What should a balance sheet reconciliation include?",
      answer:
        "The GL balance, the independent source it ties to, any reconciling items with explanations, a roll-forward (opening + activity = closing) where relevant, and a preparer/reviewer sign-off. If you can't name what you ticked the balance to, it isn't reconciled.",
    },
    {
      question: "What's the difference between a reconciliation and a roll-forward?",
      answer:
        "A reconciliation ties the GL balance to an external source at a point in time. A roll-forward proves the change over the period: opening balance + additions − reductions = closing balance. Schedule-based accounts (prepaids, fixed assets, debt, accruals) use a roll-forward; statement-based accounts (cash, credit cards) tie to a statement.",
    },
  ],
}

export function Body() {
  return (
    <article>
      <p className="lead">
        A balance sheet reconciliation checklist answers three questions every
        month: which accounts to reconcile, what each one ties to, and in what
        order. Here&apos;s the version you can run every close — plus a roll-forward
        and sign-off template you can copy. (For the why and how behind it, see the
        full{" "}
        <Link to="/blog/balance-sheet-reconciliation" className="text-[var(--green)] underline">
          balance sheet reconciliation guide
        </Link>.)
      </p>

      <h2>Which balance sheet accounts need to be reconciled?</h2>
      <p>
        Short answer: <strong>every account that carries a balance</strong> — not
        just cash. Income-statement accounts aren&apos;t reconciled; they&apos;re
        explained with{" "}
        <Link to="/blog/flux-analysis-example" className="text-[var(--green)] underline">
          flux analysis
        </Link>. Here&apos;s what each balance-sheet account ties to:
      </p>
      <table>
        <thead>
          <tr><th>Account</th><th>Ties to (independent source)</th><th>Cadence</th></tr>
        </thead>
        <tbody>
          <tr><td>Cash / bank</td><td>Bank statement + outstanding-item list</td><td>Monthly</td></tr>
          <tr><td>Accounts receivable</td><td>AR aging detail</td><td>Monthly</td></tr>
          <tr><td>Prepaid expenses</td><td>Amortization schedule</td><td>Monthly</td></tr>
          <tr><td>Inventory</td><td>Inventory sub-ledger / count</td><td>Monthly</td></tr>
          <tr><td>Fixed assets &amp; accum. depreciation</td><td>Fixed-asset roll-forward + depreciation schedule</td><td>Monthly / quarterly</td></tr>
          <tr><td>Accounts payable</td><td>AP aging detail / vendor statements</td><td>Monthly</td></tr>
          <tr><td>Accrued liabilities</td><td>Accrual schedule (with reversals)</td><td>Monthly</td></tr>
          <tr><td>Payroll liabilities</td><td>Payroll provider reports</td><td>Monthly</td></tr>
          <tr><td>Credit cards</td><td>Card statement + outstanding items</td><td>Monthly</td></tr>
          <tr><td>Sales / other taxes payable</td><td>Tax filings / liability reports</td><td>Monthly</td></tr>
          <tr><td>Deferred revenue</td><td>Deferred-revenue / contract schedule</td><td>Monthly</td></tr>
          <tr><td>Loans / debt</td><td>Lender statement + amortization schedule</td><td>Monthly / quarterly</td></tr>
          <tr><td>Intercompany</td><td>Counterparty&apos;s matching account</td><td>Monthly</td></tr>
          <tr><td>Equity / retained earnings</td><td>Prior RE + current net income − distributions</td><td>Monthly</td></tr>
        </tbody>
      </table>

      <h2>The monthly checklist (in order)</h2>
      <p>
        Order matters — later steps assume earlier ones are done. Reconcile in this
        sequence:
      </p>
      <ol>
        <li><strong>Freeze the data.</strong> Confirm cut-off and sync/snapshot the trial balance so balances can&apos;t move under you.</li>
        <li><strong>Verify the TB ties:</strong> Assets = Liabilities + Equity. Fix any imbalance before reconciling anything.</li>
        <li><strong>Cash &amp; credit cards.</strong> Tie to statements; list outstanding deposits and checks. (See the{" "}
          <Link to="/blog/bank-reconciliation-quickbooks" className="text-[var(--green)] underline">QuickBooks bank reconciliation walk-through</Link>.)</li>
        <li><strong>AR and AP.</strong> Tie the GL to the aging detail to the penny; investigate any difference before booking reserves.</li>
        <li><strong>Schedule-based accounts.</strong> Prepaids, fixed assets, accruals, debt, deferred revenue — each needs a roll-forward (below).</li>
        <li><strong>Payroll &amp; taxes payable.</strong> Tie to provider reports and filings.</li>
        <li><strong>Intercompany.</strong> Net each account against the counterparty&apos;s matching account; a difference is a real issue, not rounding.</li>
        <li><strong>Equity &amp; retained earnings.</strong> Confirm RE rolled forward = prior RE + net income − distributions.</li>
        <li><strong>Sign off.</strong> Preparer and a different reviewer (maker/checker) on every account.</li>
      </ol>

      <h2>The roll-forward template (copy this)</h2>
      <p>
        Schedule-based accounts (prepaids, fixed assets, accruals, debt, deferred
        revenue) reconcile with a roll-forward — prove the movement, not just the
        ending number:
      </p>
      <aside className="callout">
        <strong>Opening balance</strong> (= last period&apos;s closing)<br />
        <strong>+ Additions</strong> (new prepaids, asset purchases, new accruals)<br />
        <strong>− Reductions</strong> (amortization, disposals, payments, reversals)<br />
        <strong>= Closing balance</strong> — which must equal the GL balance.
      </aside>
      <p>
        If the closing roll-forward doesn&apos;t equal the GL, the difference is a
        reconciling item: name it, explain it, and resolve it before sign-off.
      </p>

      <h2>The sign-off template</h2>
      <p>Every reconciliation that holds up under audit records:</p>
      <ul>
        <li><strong>Account + period</strong> and the GL balance reconciled.</li>
        <li><strong>The source</strong> it was tied to (statement, aging, schedule).</li>
        <li><strong>Reconciling items</strong> with date, amount, and a one-line explanation.</li>
        <li><strong>Prepared by</strong> (name + date) and <strong>Reviewed/approved by</strong> — a <em>different</em> person.</li>
        <li><strong>Evidence attached</strong> — the statement, aging, or schedule PDF.</li>
      </ul>

      <h2>Copy the checklist — or stop maintaining it by hand</h2>
      <p>
        You can paste this into Notion, Excel, or your close tracker and tick it
        every month. Or let it run itself:{" "}
        <Link to="/solutions" className="text-[var(--green)] underline">Nordavix</Link>{" "}
        sits on top of QuickBooks and turns this checklist into a live dashboard —
        every balance-sheet account, its tie-out status, reconciling items, opening
        balances rolled forward automatically, and maker/checker sign-off built in.
        It&apos;s the same discipline as the{" "}
        <Link to="/blog/month-end-close-checklist" className="text-[var(--green)] underline">
          month-end close checklist
        </Link>, without the spreadsheet upkeep.{" "}
        <Link to="/sign-up" className="text-[var(--green)] underline font-semibold">
          Start a free workspace
        </Link>{" "}and try it on your next close.
      </p>

      <h2>Frequently asked questions</h2>

      <h3>Which balance sheet accounts need to be reconciled?</h3>
      <p>
        Every account with a balance — not just cash. Assets (bank, AR, prepaids,
        inventory, fixed assets, other receivables), liabilities (AP, accrued
        liabilities, payroll liabilities, credit cards, taxes payable, deferred
        revenue, loans/debt, intercompany), and equity (common stock, APIC,
        distributions, retained earnings). Income-statement accounts aren&apos;t
        reconciled — they&apos;re reviewed with flux analysis.
      </p>

      <h3>How often should you reconcile balance sheet accounts?</h3>
      <p>
        Reconcile active, higher-risk accounts (cash, AR, AP, accruals, payroll,
        credit cards) every month. Slower-moving accounts (fixed assets, long-term
        debt, equity) monthly if you can, quarterly at minimum. Anything that moves,
        or that an auditor will sample, gets a monthly tie-out.
      </p>

      <h3>What should a balance sheet reconciliation include?</h3>
      <p>
        The GL balance, the independent source it ties to, reconciling items with
        explanations, a roll-forward where relevant, and a preparer/reviewer
        sign-off. If you can&apos;t name what you ticked the balance to, it
        isn&apos;t reconciled.
      </p>

      <h3>What&apos;s the difference between a reconciliation and a roll-forward?</h3>
      <p>
        A reconciliation ties the GL balance to an external source at a point in
        time. A roll-forward proves the change over the period: opening + additions
        − reductions = closing. Schedule-based accounts use a roll-forward;
        statement-based accounts tie to a statement.
      </p>
    </article>
  )
}
