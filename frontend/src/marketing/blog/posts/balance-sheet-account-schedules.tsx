/**
 * Blog post — the pillar guide for the Schedules module.
 * Primary: "balance sheet account schedules". Cluster: "supporting schedules
 * accounting", "subledger vs general ledger", "roll-forward schedule",
 * "accounting schedules prepaid fixed asset lease loan", "what is a subledger".
 * Product tie-in: the Schedules module (5 types) + the schedule-as-subledger
 * recon interlink — the module's wow moment.
 *
 * Interlinks: prepaid-expense-amortization-schedule (the prepaid deep dive),
 * balance-sheet-reconciliation + checklist (the tie-out), flux-analysis-guide
 * (the offset account drives the expense line), catch-gl-coding-errors (the AI
 * scan), month-end-close-checklist (where schedules sit in the close).
 */
import { Link } from "react-router-dom"
import type { BlogPostMeta } from "@/marketing/blog/types"

export const meta: BlogPostMeta = {
  slug:        "balance-sheet-account-schedules",
  title:       "Balance Sheet Account Schedules: The Subledgers Behind a Clean Month-End Close",
  description: "Balance sheet account schedules explained — what prepaid, accrual, fixed-asset, lease, and loan schedules are, the journal entries they drive, the roll-forward that ties them out, and how each one becomes the subledger that reconciles its GL account.",
  date:        "2026-06-20",
  readingTime: "12 min read",
  category:    "Close process",
  excerpt:     "Every balance-sheet account needs a schedule, and every schedule is really a subledger waiting to reconcile itself. Here's how prepaids, accruals, fixed assets, leases, and loans actually work — the math, the journal entries, the roll-forward — and the one design idea that turns five spreadsheets into a close that ties out on its own.",
  faq: [
    {
      question: "What is a balance sheet account schedule?",
      answer:
        "A balance sheet account schedule is the supporting workpaper that backs up a single general-ledger balance — a prepaid amortization schedule, an accrual listing, a fixed-asset register, a lease schedule, a loan amortization table. It carries the line-item detail (who, how much, over what period), computes each period's movement, and produces an ending balance that should equal the GL account it supports. That ending balance is what you reconcile against.",
    },
    {
      question: "What is the difference between a subledger and the general ledger?",
      answer:
        "The general ledger holds one summarized balance per account — the control total. A subledger holds the itemized detail behind that total, and the detail must add up to it. QuickBooks keeps subledgers for you on AR (the aging) and AP, but it does not keep one for prepaids, accruals, fixed assets, leases, or loans. For those accounts the schedule you build is the subledger — which is exactly why a missing or stale schedule is the most common balance-sheet reconciliation failure.",
    },
    {
      question: "Which balance sheet accounts need a supporting schedule?",
      answer:
        "Any account whose balance is the sum of items that change on a known pattern rather than transaction by transaction: prepaid expenses, accrued liabilities, fixed assets and accumulated depreciation, right-of-use lease assets and lease liabilities, and loans or notes payable. Cash ties to the bank statement and AR/AP tie to their agings, so those use external sources rather than a built schedule — but the five accounts above have no external source, so the schedule is the source.",
    },
    {
      question: "What is a roll-forward schedule in accounting?",
      answer:
        "A roll-forward proves this period's balance from last period's: beginning balance (last period's approved close) + additions − this period's recognition (amortization, depreciation, or expense) − payments = ending balance. It anchors every period to the prior signed-off number so an old error can't ride forward unnoticed, and the ending balance becomes next period's beginning — an unbroken chain across the whole year.",
    },
    {
      question: "How do account schedules connect to reconciliations?",
      answer:
        "The schedule's ending balance is the subledger figure in the reconciliation. The recon compares the GL balance to that schedule balance: if they match, the account is reconciled; if they don't, the difference is a real, explainable variance — a missed amortization entry, an unrecorded payment, an asset booked to the wrong account. You fix it in the schedule or with a journal entry, not by plugging the recon. In Nordavix the schedule's ending balance feeds the reconciliation automatically the moment you commit it.",
    },
  ],
}

// ── Figure 1: the roll-forward waterfall ────────────────────────────────────
// Pure SVG, theme-aware via CSS vars. Beginning + additions − recognition =
// ending, drawn as a floating-bar waterfall — the single idea every schedule
// shares. Numbers tell a small story: a $30k prepaid book, +$12k new policy
// added mid-period, −$7k amortized, = $35k carried to the recon.
function RollForwardFigure() {
  // Value → y. Baseline ($0) at 230, top of chart (~$45k headroom) at 40.
  const yFor = (v: number) => 230 - (v / 45000) * 190
  const begin = 30000, add = 12000, amort = 7000
  const peak = begin + add            // 42,000
  const end = peak - amort            // 35,000
  // Column centers (4 slots across x 70→650).
  const cx = [142.5, 287.5, 432.5, 577.5]
  const BW = 70
  return (
    <figure style={{ margin: "1.8em 0" }}>
      <svg viewBox="0 0 680 290" role="img"
        aria-label="Waterfall chart: beginning balance $30,000 plus additions $12,000 minus amortization $7,000 equals ending balance $35,000, which feeds the reconciliation as the subledger"
        style={{ width: "100%", height: "auto", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12 }}>
        {/* baseline */}
        <line x1="48" y1="230" x2="650" y2="230" stroke="var(--border-strong)" strokeWidth="1" />
        {/* faint reference gridlines */}
        {[15000, 30000, 45000].map((v) => (
          <g key={v}>
            <line x1="48" y1={yFor(v)} x2="650" y2={yFor(v)} stroke="var(--border)" strokeWidth="1" strokeDasharray="3 5" />
            <text x="42" y={yFor(v) + 4} textAnchor="end" fontSize="10" fill="var(--text-muted)"
              fontFamily="JetBrains Mono, monospace">${v / 1000}k</text>
          </g>
        ))}

        {/* connectors at each running balance */}
        <line x1={cx[0] + BW / 2} y1={yFor(begin)} x2={cx[1] - BW / 2} y2={yFor(begin)} stroke="var(--border-strong)" strokeWidth="1.2" strokeDasharray="2 3" />
        <line x1={cx[1] + BW / 2} y1={yFor(peak)}  x2={cx[2] - BW / 2} y2={yFor(peak)}  stroke="var(--border-strong)" strokeWidth="1.2" strokeDasharray="2 3" />
        <line x1={cx[2] + BW / 2} y1={yFor(end)}   x2={cx[3] - BW / 2} y2={yFor(end)}   stroke="var(--border-strong)" strokeWidth="1.2" strokeDasharray="2 3" />

        {/* bars */}
        {/* Beginning — full bar 0 → 30k */}
        <rect x={cx[0] - BW / 2} y={yFor(begin)} width={BW} height={230 - yFor(begin)} rx="3" fill="#8aa399" />
        {/* + Additions — floating 30k → 42k */}
        <rect x={cx[1] - BW / 2} y={yFor(peak)}  width={BW} height={yFor(begin) - yFor(peak)} rx="3" fill="var(--green)" />
        {/* − Amortization — floating 42k → 35k */}
        <rect x={cx[2] - BW / 2} y={yFor(peak)}  width={BW} height={yFor(end) - yFor(peak)} rx="3" fill="#c79a52" />
        {/* = Ending — full bar 0 → 35k */}
        <rect x={cx[3] - BW / 2} y={yFor(end)}   width={BW} height={230 - yFor(end)} rx="3" fill="var(--green)" />

        {/* labels */}
        {[
          { x: cx[0], top: "Beginning", val: "$30,000" },
          { x: cx[1], top: "+ Additions", val: "+ $12,000" },
          { x: cx[2], top: "− Amortization", val: "− $7,000" },
          { x: cx[3], top: "= Ending", val: "$35,000" },
        ].map((l, i) => (
          <g key={i}>
            <text x={l.x} y={250} textAnchor="middle" fontSize="11" fill="var(--text-muted)">{l.top}</text>
            <text x={l.x} y={267} textAnchor="middle" fontSize="12.5" fontWeight="700"
              fill={i === 3 ? "var(--green)" : i === 2 ? "#8a6326" : "var(--text-2)"}>{l.val}</text>
          </g>
        ))}
      </svg>
      <figcaption style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 8, textAlign: "center" }}>
        Every schedule, regardless of type, is this one shape: opening balance, plus what came in,
        minus what was recognized or paid, equals the ending balance you reconcile.
      </figcaption>
    </figure>
  )
}

// ── Figure 2: schedule → subledger → reconciliation ─────────────────────────
// The module's wow moment, drawn as a three-node flow. The schedule's ending
// balance becomes the subledger, which auto-feeds the recon's tie-out.
function SubledgerFlowFigure() {
  return (
    <figure style={{ margin: "1.8em 0" }}>
      <svg viewBox="0 0 680 230" role="img"
        aria-label="Flow diagram: a schedule's ending balance is committed as the subledger, which auto-feeds the reconciliation where GL equals SL and the variance is zero"
        style={{ width: "100%", height: "auto", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12 }}>
        <defs>
          <marker id="bsas-arrow" markerWidth="9" markerHeight="9" refX="6" refY="3" orient="auto" markerUnits="strokeWidth">
            <path d="M0,0 L6,3 L0,6 Z" fill="var(--text-muted)" />
          </marker>
        </defs>

        {/* Box A — Schedule */}
        <g>
          <rect x="22" y="58" width="184" height="104" rx="12" fill="var(--surface-2)" stroke="var(--border)" strokeWidth="1" />
          <text x="114" y="84" textAnchor="middle" fontSize="10.5" fontWeight="700" letterSpacing="0.8"
            fill="var(--text-muted)" fontFamily="JetBrains Mono, monospace">SCHEDULE</text>
          <text x="114" y="108" textAnchor="middle" fontSize="12.5" fill="var(--text-2)">Prepaid workpaper</text>
          <text x="114" y="138" textAnchor="middle" fontSize="18" fontWeight="700" fill="var(--text)">$35,000</text>
          <text x="114" y="153" textAnchor="middle" fontSize="9.5" fill="var(--text-muted)">ending balance</text>
        </g>

        {/* A → B */}
        <line x1="206" y1="110" x2="252" y2="110" stroke="var(--text-muted)" strokeWidth="1.6" markerEnd="url(#bsas-arrow)" />
        <text x="229" y="100" textAnchor="middle" fontSize="9" fill="var(--text-muted)"
          fontFamily="JetBrains Mono, monospace">commit</text>

        {/* Box B — Subledger */}
        <g>
          <rect x="256" y="58" width="184" height="104" rx="12" fill="rgba(46,122,85,0.08)" stroke="var(--green)" strokeWidth="1.4" />
          <text x="348" y="84" textAnchor="middle" fontSize="10.5" fontWeight="700" letterSpacing="0.8"
            fill="var(--green)" fontFamily="JetBrains Mono, monospace">SUBLEDGER</text>
          <text x="348" y="110" textAnchor="middle" fontSize="12" fill="var(--text-2)">The schedule</text>
          <text x="348" y="127" textAnchor="middle" fontSize="12" fill="var(--text-2)">is the subledger</text>
          <text x="348" y="150" textAnchor="middle" fontSize="9.5" fill="var(--text-muted)">no re-keying, no second tab</text>
        </g>

        {/* B → C */}
        <line x1="440" y1="110" x2="486" y2="110" stroke="var(--text-muted)" strokeWidth="1.6" markerEnd="url(#bsas-arrow)" />
        <text x="463" y="100" textAnchor="middle" fontSize="9" fill="var(--text-muted)"
          fontFamily="JetBrains Mono, monospace">feeds</text>

        {/* Box C — Reconciliation */}
        <g>
          <rect x="490" y="58" width="168" height="104" rx="12" fill="var(--surface-2)" stroke="var(--border)" strokeWidth="1" />
          <text x="574" y="84" textAnchor="middle" fontSize="10.5" fontWeight="700" letterSpacing="0.8"
            fill="var(--text-muted)" fontFamily="JetBrains Mono, monospace">RECONCILIATION</text>
          <text x="574" y="106" textAnchor="middle" fontSize="11.5" fill="var(--text-2)">GL $35,000</text>
          <text x="574" y="122" textAnchor="middle" fontSize="11.5" fill="var(--text-2)">SL $35,000</text>
          <text x="574" y="148" textAnchor="middle" fontSize="13" fontWeight="700" fill="var(--green)">Variance $0 ✓</text>
        </g>

        {/* footer caption strip */}
        <text x="340" y="200" textAnchor="middle" fontSize="11" fill="var(--text-muted)">
          A real gap here is an honest variance to investigate — never a spreadsheet typo to chase.
        </text>
      </svg>
      <figcaption style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 8, textAlign: "center" }}>
        The whole point of building the schedule: its ending balance <em>is</em> the reconciliation's
        subledger, so the tie-out is done before you start.
      </figcaption>
    </figure>
  )
}

export function Body() {
  return (
    <article>
      <p className="lead">
        Open any controller's close folder and you'll find the same five tabs:
        prepaids, accruals, fixed assets, leases, loans. They're the schedules
        behind the balance sheet — and they're where the close quietly goes
        wrong, because each one is really a <strong>subledger</strong> that
        nobody told the spreadsheet it was supposed to be. This guide explains
        what these schedules are, the journal entries each one drives, the
        roll-forward that ties them out, and the single design idea that turns
        five fragile tabs into a close that reconciles itself.
      </p>

      <h2>What is a balance sheet account schedule?</h2>
      <p>
        A balance sheet account schedule is the supporting workpaper that backs
        up one general-ledger balance with itemized detail. The GL line says{" "}
        <em>"Prepaid Expenses: $35,000."</em> The schedule says <em>which</em>{" "}
        prepaids — the insurance policy, the annual software contract, the
        deposit — how much of each remains, and how that $35,000 will release to
        the income statement over the coming months. The same pattern repeats
        across the balance sheet:
      </p>
      <ul>
        <li><strong>Prepaid expenses</strong> → a list of upfront payments amortizing over their service periods.</li>
        <li><strong>Accrued liabilities</strong> → expenses incurred but not yet paid, each due to reverse when the bill arrives.</li>
        <li><strong>Fixed assets</strong> → a register of capitalized purchases depreciating over their useful lives.</li>
        <li><strong>Leases</strong> → lease commitments, with optional ASC 842 right-of-use asset and liability.</li>
        <li><strong>Loans</strong> → term debt with an amortization table splitting each payment into interest and principal.</li>
      </ul>
      <p>
        In every case the schedule does three jobs: it holds the detail, it
        computes this period's movement, and it produces an ending balance that{" "}
        <em>must</em> equal the GL account it supports. That last sentence is the
        entire reason schedules exist — and it's also the definition of a
        subledger.
      </p>

      <h2>Subledger vs. general ledger: the distinction that makes schedules matter</h2>
      <p>
        The general ledger keeps one number per account — the control balance.
        A <strong>subledger</strong> keeps the itemized detail behind that
        number, and the detail has to add up to it. The relationship is the
        whole game:
      </p>
      <table>
        <thead>
          <tr><th>General ledger</th><th>Subledger</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>One summarized balance per account (the control total)</td>
            <td>The line-item detail that sums to that balance</td>
          </tr>
          <tr>
            <td>"Prepaid Expenses: $35,000"</td>
            <td>Insurance $22,000 + software $9,000 + deposit $4,000 = $35,000</td>
          </tr>
          <tr>
            <td>What the financial statements show</td>
            <td>What proves the statements are right</td>
          </tr>
        </tbody>
      </table>
      <p>
        Here's the part most teams miss: QuickBooks keeps some subledgers for
        you and not others. AR has a built-in subledger — the aging detail. AP
        has one too. But QuickBooks does <strong>not</strong> keep a subledger
        for prepaids, accruals, fixed assets, leases, or loans. Those accounts
        carry a balance with no itemized backing inside the GL. So{" "}
        <strong>the schedule you build is the subledger</strong> — there is no
        other. That's why a missing, stale, or mis-summed schedule is the single
        most common balance-sheet reconciliation failure: you're not
        reconciling a sloppy subledger, you're reconciling to one that doesn't
        exist until you build it.
      </p>
      <aside className="callout">
        <strong>The one-line version:</strong> for cash, AR, and AP you{" "}
        <em>reconcile to</em> an external source (the bank, the agings). For
        prepaids, accruals, fixed assets, leases, and loans you <em>build</em>{" "}
        the source — and the schedule is it.
      </aside>

      <h2>The five schedules every month-end close needs</h2>
      <p>
        Each schedule supports a different account and runs a different engine,
        but they all produce the same thing — an ending balance to reconcile.
        Here's the full map:
      </p>
      <table>
        <thead>
          <tr>
            <th>Schedule</th><th>What it tracks</th><th>The engine</th><th>Feeds the recon for…</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><strong>Prepaid expenses</strong></td>
            <td>Payments made upfront for future service periods</td>
            <td>Straight-line or days-based amortization</td>
            <td>Prepaid Expenses (asset)</td>
          </tr>
          <tr>
            <td><strong>Accrued expenses</strong></td>
            <td>Costs incurred but not yet invoiced/paid</td>
            <td>Accrue at period-end, reverse when paid</td>
            <td>Accrued Liabilities</td>
          </tr>
          <tr>
            <td><strong>Fixed assets</strong></td>
            <td>Capitalized purchases above your threshold</td>
            <td>Straight-line depreciation over useful life</td>
            <td>Fixed Assets + Accumulated Depreciation</td>
          </tr>
          <tr>
            <td><strong>Leases</strong></td>
            <td>Operating-lease commitments (ASC 842 optional)</td>
            <td>Payment schedule; ROU asset + liability amortization</td>
            <td>ROU Asset + Lease Liability</td>
          </tr>
          <tr>
            <td><strong>Loans</strong></td>
            <td>Term loans and notes payable</td>
            <td>Amortization table — interest vs. principal each period</td>
            <td>Loan Payable + Interest Expense</td>
          </tr>
        </tbody>
      </table>
      <p>
        Prepaids are the account where this discipline is easiest to see, which
        is why they're worth mastering first — we walk the full math (straight-line
        vs. days-based, a worked insurance example, the seven errors auditors find)
        in the{" "}
        <Link to="/blog/prepaid-expense-amortization-schedule">prepaid expense
        amortization schedule guide</Link>. Everything in this article generalizes
        that pattern to the other four.
      </p>

      <h2>The roll-forward: one diagram that explains all five</h2>
      <p>
        Whatever the engine, every schedule reports its period the same way — a{" "}
        <strong>roll-forward</strong>:
      </p>
      <pre><code>{`Beginning balance      (last period's approved close)
  + Additions          (new prepaids, capitalized assets, new draws)
  − Recognition        (amortization / depreciation / period expense)
  − Payments           (principal paid, disposals)
  = Ending balance     (what you reconcile this period)`}</code></pre>
      <p>
        Drawn as a waterfall, the period's movement reads at a glance — and the
        ending balance is the figure that travels to the reconciliation:
      </p>

      <RollForwardFigure />

      <p>
        Two properties make the roll-forward the backbone of a trustworthy
        close. First, the beginning balance is <em>last period's approved
        number</em> — not the live GL — so an error from three months ago can't
        silently ride forward. Second, this period's ending becomes next
        period's beginning, forming an unbroken chain across the whole year.
        It's the same anchoring logic behind every account in the{" "}
        <Link to="/blog/balance-sheet-reconciliation">balance sheet
        reconciliation process</Link>; schedules just compute the "recognition"
        line for you instead of asking you to type it.
      </p>

      <h2>The journal entries each schedule writes</h2>
      <p>
        A schedule isn't just a balance — it's a sequence of journal entries.
        Each type has a <strong>setup entry</strong> (book it once, when the item
        is recorded) and a <strong>recurring entry</strong> (post it every period
        over the item's life). Knowing both is what lets you draft a complete,
        two-sided entry instead of a one-line stub:
      </p>
      <table>
        <thead>
          <tr><th>Schedule</th><th>Entry</th><th>Debit</th><th>Credit</th></tr>
        </thead>
        <tbody>
          <tr>
            <td rowSpan={2}><strong>Prepaid</strong></td>
            <td>Setup — record the asset</td>
            <td>Prepaid Expenses (BS)</td>
            <td>Cash / the original expense</td>
          </tr>
          <tr>
            <td>Each period — amortize</td>
            <td>Expense (P&amp;L)</td>
            <td>Prepaid Expenses (BS)</td>
          </tr>
          <tr>
            <td rowSpan={2}><strong>Accrual</strong></td>
            <td>Period-end — accrue</td>
            <td>Expense (P&amp;L)</td>
            <td>Accrued Liabilities (BS)</td>
          </tr>
          <tr>
            <td>Next period — reverse</td>
            <td>Accrued Liabilities (BS)</td>
            <td>Expense (P&amp;L)</td>
          </tr>
          <tr>
            <td rowSpan={2}><strong>Fixed asset</strong></td>
            <td>Setup — capitalize</td>
            <td>Fixed Asset (BS)</td>
            <td>Cash / the original expense</td>
          </tr>
          <tr>
            <td>Each period — depreciate</td>
            <td>Depreciation Expense (P&amp;L)</td>
            <td>Accumulated Depreciation (BS)</td>
          </tr>
          <tr>
            <td><strong>Loan</strong></td>
            <td>Each payment — split</td>
            <td>Loan Payable (principal) + Interest Expense</td>
            <td>Cash</td>
          </tr>
          <tr>
            <td><strong>Lease</strong></td>
            <td>Each period (operating)</td>
            <td>Lease Expense (or ROU amort. + interest)</td>
            <td>Cash / Lease Liability</td>
          </tr>
        </tbody>
      </table>
      <p>
        The recurring entry is exactly the "recognition" line of the
        roll-forward — amortization, depreciation, the period's accrual or
        interest. The reason it pays to record the <em>offset</em> account (the
        expense side) on the schedule itself, not at posting time, is that it
        keeps every period's entry hitting the same P&amp;L line. Scatter
        amortization across three different expense accounts and your{" "}
        <Link to="/blog/flux-analysis-guide">flux analysis</Link> on those lines
        becomes meaningless. One offset, every period, forever.
      </p>
      <aside className="callout">
        <strong>Read-only by design:</strong> a schedule drafts the entry and
        tells you exactly what to post — it doesn't reach into your books.
        Nordavix connects to QuickBooks read-only, so you (or your reviewer) post
        the journal entry, then re-sync. The schedule proposes; the human
        disposes.
      </aside>

      <h2>The wow moment: your schedule becomes the reconciliation subledger</h2>
      <p>
        Here's where the work compounds. In a spreadsheet world, the schedule
        and the reconciliation are two separate artifacts: you maintain the
        amortization tab, then you separately open the prepaid reconciliation and
        re-key the schedule's total into the "subledger" box, then you compare it
        to the GL. Two places, two chances to drift, one monthly ritual of
        copying a number from one tab to another.
      </p>
      <p>
        Collapse them. The schedule's ending balance <em>is</em> the
        reconciliation's subledger — so the moment you commit the period's
        roll-forward, the recon already has its subledger figure and the tie-out
        is computed for you:
      </p>

      <SubledgerFlowFigure />

      <p>
        This changes what a variance <em>means</em>. When the schedule feeds the
        recon directly, a non-zero variance can't be a copy-paste mistake or a
        formula that didn't drag down — those failure modes are gone. What's left
        is a real difference between what the GL says and what the schedule
        computes: a missed amortization entry, a new payment coded to the asset
        but never added to the schedule, an asset booked to the wrong account.
        Every one of those is a genuine finding you fix in the schedule or with a
        journal entry — never something you plug to force the recon to zero.
      </p>
      <p>
        Two guardrails make this safe in practice. A committed schedule that
        later changes is flagged <strong>stale</strong>, so the recon never
        silently drifts from the workpaper behind it. And once a reconciliation
        is <strong>approved</strong>, its subledger is frozen as an audit
        record — editing a schedule line in a future period can't reach back and
        manufacture a variance on a closed month. For the full tie-out discipline
        this plugs into, see the{" "}
        <Link to="/blog/balance-sheet-reconciliation-checklist">balance sheet
        reconciliation checklist</Link>.
      </p>

      <h2>AI that drafts the schedule from your general ledger</h2>
      <p>
        The hardest part of schedules isn't the math — it's noticing the item in
        the first place. A 12-month insurance renewal gets coded straight to
        Insurance Expense; a $14,000 laptop fleet hits Office Supplies; a
        December bill for November work never gets accrued. None of these break
        the trial balance, so they survive the close — the same way the{" "}
        <Link to="/blog/catch-gl-coding-errors">GL coding errors that don't
        break the trial balance</Link> do.
      </p>
      <p>
        Nordavix scans your general ledger for exactly these:
      </p>
      <ul>
        <li><strong>Prepaid detection</strong> — payments expensed in full that span future periods and should be capitalized and amortized.</li>
        <li><strong>Capitalization detection</strong> — large expensed purchases that likely belong on the fixed-asset register.</li>
        <li><strong>Missed &amp; unreversed accruals</strong> — period-end costs that should have been accrued, and prior accruals now due to reverse.</li>
      </ul>
      <p>
        Each detection comes with the two journal entries to post — the setup
        reclassification and the recurring recognition — derived from the
        transaction itself. Accept a suggestion and it becomes a real schedule
        item: it joins the roll-forward, contributes to the ending balance, and
        flows into the proposed entries automatically. You're reviewing
        candidates, not hunting for them. (More on where this fits in the broader
        shift: <Link to="/blog/ai-in-accounting-2026">AI in accounting in
        2026</Link>.)
      </p>

      <h2>Spreadsheet schedules vs. a connected module</h2>
      <p>
        None of the math in this article changes in software — straight-line is
        straight-line. What changes is who carries the <em>re-verification</em>{" "}
        cost: every month, someone has to re-prove the tab still foots, still
        sums, still ties to the GL, and still reflects every invoice that hit the
        account. That hour produces nothing new; it just re-certifies last
        month's work.
      </p>
      <table>
        <thead>
          <tr><th>Job</th><th>Spreadsheet tabs</th><th>Connected schedules module</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Compute the period's movement</td>
            <td>Formulas you maintain (and that silently break)</td>
            <td>Computed by the engine — no formula drift</td>
          </tr>
          <tr>
            <td>Feed the reconciliation</td>
            <td>Re-key the total into the recon each month</td>
            <td>Ending balance feeds the recon on commit</td>
          </tr>
          <tr>
            <td>Catch a missed item</td>
            <td>Hope someone notices</td>
            <td>AI scans the GL and proposes it</td>
          </tr>
          <tr>
            <td>Roll to next period</td>
            <td>Copy the tab, repoint references</td>
            <td>Ending becomes next month's beginning, automatically</td>
          </tr>
          <tr>
            <td>Audit trail</td>
            <td>Whatever the last editor remembered to note</td>
            <td>Committed snapshot + approver sign-off, frozen</td>
          </tr>
        </tbody>
      </table>
      <p>
        Excel is the right tool at three prepaids and one loan. Somewhere past
        that — or the first time a mid-month policy, a renewal, and a disposal
        land in the same close — the re-verification cost is the real bill, and
        it's the part software should own. Schedules are one module inside the
        larger close; for the whole sequence they sit in, see the{" "}
        <Link to="/blog/month-end-close-checklist">complete month-end close
        checklist</Link>.
      </p>
      <aside className="callout">
        <strong>The honest pitch:</strong> enter each item once — vendor, amount,
        dates, the expense account it hits — and Nordavix computes every period's
        roll-forward, drafts the journal entries, and pushes the ending balance
        straight into the reconciliation as the subledger.{" "}
        <Link to="/solutions">See how it fits the close</Link>, or{" "}
        <Link to="/sign-up">start a free workspace</Link> and load one schedule
        against your next close — free during beta.
      </aside>

      <h2>Frequently asked questions</h2>

      <h3>What is a balance sheet account schedule?</h3>
      <p>
        The supporting workpaper behind a single GL balance — a prepaid
        amortization schedule, an accrual listing, a fixed-asset register, a
        lease schedule, a loan amortization table. It holds the line-item
        detail, computes each period's movement, and produces an ending balance
        that should equal the GL account it supports. That ending balance is what
        you reconcile against.
      </p>

      <h3>What is the difference between a subledger and the general ledger?</h3>
      <p>
        The general ledger holds one summarized balance per account; the
        subledger holds the itemized detail behind it, and the detail must add up
        to the control total. QuickBooks keeps subledgers on AR and AP but not on
        prepaids, accruals, fixed assets, leases, or loans — so for those
        accounts the schedule you build <em>is</em> the subledger.
      </p>

      <h3>Which balance sheet accounts need a supporting schedule?</h3>
      <p>
        Accounts whose balance is the sum of items that move on a known pattern:
        prepaid expenses, accrued liabilities, fixed assets and accumulated
        depreciation, right-of-use lease assets and liabilities, and loans or
        notes payable. Cash ties to the bank statement and AR/AP tie to their
        agings, so those use external sources rather than a built schedule.
      </p>

      <h3>What is a roll-forward schedule in accounting?</h3>
      <p>
        Beginning balance (last period's approved close) + additions − this
        period's recognition − payments = ending balance. It anchors each period
        to the prior signed-off number so old errors can't ride forward, and the
        ending balance becomes next period's beginning — an unbroken chain across
        the year.
      </p>

      <h3>How do account schedules connect to reconciliations?</h3>
      <p>
        The schedule's ending balance is the subledger figure in the
        reconciliation. The recon compares the GL balance to it: match means
        reconciled; a difference is a real variance you fix in the schedule or
        with a journal entry, never a plug. In Nordavix the ending balance feeds
        the reconciliation automatically the moment you commit the schedule.
      </p>
    </article>
  )
}
