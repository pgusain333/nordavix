/**
 * Blog post — the definitive prepaid amortization guide.
 * Primary: "prepaid expense amortization schedule". Cluster: "prepaid
 * amortization schedule excel", "prepaid expenses journal entry",
 * "amortization of prepaid expenses", "prepaid insurance journal entry",
 * "prepaid expense reconciliation".
 * Product tie-in: Schedules module + the Nordavix-vs-QuickBooks match panel.
 */
import { Link } from "react-router-dom"
import type { BlogPostMeta } from "@/marketing/blog/types"

export const meta: BlogPostMeta = {
  slug:        "prepaid-expense-amortization-schedule",
  title:       "Prepaid Expense Amortization Schedule: The Worked Example Every Controller Should Steal",
  description: "How to build a prepaid expense amortization schedule that actually ties to the balance sheet — straight-line vs days-based math, a fully worked insurance example, the 7 errors auditors find, and when to retire the spreadsheet.",
  date:        "2026-06-12",
  readingTime: "11 min read",
  category:    "Close process",
  excerpt:     "Every prepaid schedule starts as a tidy spreadsheet tab and ends as the reconciling item nobody can explain. Here's the math done right — straight-line vs days-based, a fully worked example, and the exact point where Excel stops being the cheap option.",
  faq: [
    {
      question: "What is a prepaid expense amortization schedule?",
      answer:
        "It's the supporting workpaper that tracks every payment you made in advance — insurance, software, rent deposits — and releases the cost to expense over the period it covers. Each month it answers two questions: how much expense do I recognize this period, and what unamortized balance should remain on the balance sheet? The total of all unamortized balances must equal the prepaid expenses line in the general ledger.",
    },
    {
      question: "What is the journal entry to amortize a prepaid expense?",
      answer:
        "Debit the expense account, credit prepaid expenses. For a $24,000 annual insurance policy amortized straight-line, the monthly entry is: Dr Insurance Expense $2,000 / Cr Prepaid Insurance $2,000. The original payment was Dr Prepaid Insurance $24,000 / Cr Cash $24,000 — the amortization entries release that asset to the P&L over the coverage period.",
    },
    {
      question: "Should prepaid amortization be straight-line or days-based?",
      answer:
        "Straight-line (total ÷ number of months) is simpler and fine when coverage starts on the 1st. Days-based (total ÷ days of coverage × days in the month) is more accurate for mid-month start dates and uneven months, and it's what removes the small first-month and last-month plugs that straight-line creates. Pick one method, document it, and apply it consistently.",
    },
    {
      question: "Is there a materiality threshold for capitalizing prepaids?",
      answer:
        "GAAP doesn't set a dollar threshold — it's a policy choice grounded in materiality. Many small and mid-size companies expense anything under a fixed floor (commonly somewhere between $500 and $5,000 depending on size) and capitalize the rest. Write the threshold into your accounting policy and apply it consistently; a documented policy is exactly what an auditor wants to see.",
    },
    {
      question: "How do you reconcile prepaid expenses at month-end?",
      answer:
        "Compare the schedule's total unamortized balance to the prepaid expenses balance in the GL. They must match. If the GL is higher, you likely missed an amortization entry or booked a new payment to the asset without adding it to the schedule. If the schedule is higher, an entry the schedule expects hasn't been posted yet — a timing item that clears once you post it.",
    },
  ],
}

// ── Inline figure: the amortization staircase ──────────────────────────────
// Pure SVG, theme-aware via CSS vars — shows the $24,000 policy bleeding down
// to zero over 12 months while expense recognizes evenly.
function AmortizationFigure() {
  // 13 balance points (month 0 → 12), $24k → $0 straight-line.
  const pts = Array.from({ length: 13 }, (_, i) => ({
    x:   64 + i * (560 / 12),
    bal: 24000 - 2000 * i,
  }))
  const yFor = (bal: number) => 36 + (1 - bal / 24000) * 168
  return (
    <figure style={{ margin: "1.8em 0" }}>
      <svg viewBox="0 0 680 280" role="img"
        aria-label="Chart: a $24,000 prepaid insurance balance amortizing to zero over 12 months, $2,000 of expense recognized each month"
        style={{ width: "100%", height: "auto", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12 }}>
        {/* axes */}
        <line x1="64" y1="204" x2="640" y2="204" stroke="var(--border-strong)" strokeWidth="1" />
        <line x1="64" y1="36"  x2="64"  y2="204" stroke="var(--border-strong)" strokeWidth="1" />
        {/* y labels */}
        {[24000, 12000, 0].map((v) => (
          <g key={v}>
            <text x="56" y={yFor(v) + 4} textAnchor="end" fontSize="11"
              fill="var(--text-muted)" fontFamily="JetBrains Mono, monospace">${v / 1000}k</text>
            <line x1="64" y1={yFor(v)} x2="640" y2={yFor(v)} stroke="var(--border)" strokeWidth="1" strokeDasharray="3 4" />
          </g>
        ))}
        {/* balance staircase */}
        {pts.slice(0, -1).map((p, i) => {
          const next = pts[i + 1]
          return (
            <g key={i}>
              <line x1={p.x} y1={yFor(p.bal)} x2={next.x} y2={yFor(p.bal)} stroke="var(--green)" strokeWidth="2.5" />
              <line x1={next.x} y1={yFor(p.bal)} x2={next.x} y2={yFor(next.bal)} stroke="var(--green)" strokeWidth="2.5" />
            </g>
          )
        })}
        {/* monthly expense bars */}
        {pts.slice(0, -1).map((p, i) => (
          <rect key={`b-${i}`} x={p.x + 6} y={210} width={(560 / 12) - 12} height={26}
            rx="3" fill="var(--green)" opacity="0.22" />
        ))}
        <text x="64" y="262" fontSize="11" fill="var(--text-muted)" fontFamily="JetBrains Mono, monospace">
          MONTH 1
        </text>
        <text x="640" y="262" textAnchor="end" fontSize="11" fill="var(--text-muted)" fontFamily="JetBrains Mono, monospace">
          MONTH 12
        </text>
        <text x="352" y="262" textAnchor="middle" fontSize="11" fill="var(--text-2)" fontFamily="JetBrains Mono, monospace">
          ▆ = $2,000 EXPENSE / MO · STAIRCASE = UNAMORTIZED BALANCE
        </text>
      </svg>
      <figcaption style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 8, textAlign: "center" }}>
        The whole idea in one picture: the asset steps down, the expense fills in — and at every
        step, schedule balance = balance-sheet balance.
      </figcaption>
    </figure>
  )
}

export function Body() {
  return (
    <article>
      <p className="lead">
        Every prepaid schedule starts life as a tidy Excel tab and ends as the
        reconciling item nobody can explain in March. This guide builds the
        schedule properly — the journal entries, straight-line vs days-based
        math, a fully worked example you can copy, the seven errors auditors
        find over and over, and an honest answer to when the spreadsheet stops
        being the cheap option.
      </p>

      <h2>What a prepaid expense actually is (30 seconds of theory)</h2>
      <p>
        You paid cash today for something you'll consume later — a year of
        insurance, an annual software contract, six months of rent. Under
        accrual accounting that payment isn't an expense yet; it's an{" "}
        <strong>asset</strong> (you own future coverage), and it becomes expense
        only as the coverage is used up. The two entries that govern its whole
        life:
      </p>
      <table>
        <thead>
          <tr><th>When</th><th>Entry</th><th>Effect</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Day you pay</td>
            <td>Dr Prepaid Expenses · Cr Cash</td>
            <td>Cash down, asset up — P&amp;L untouched</td>
          </tr>
          <tr>
            <td>Each month after</td>
            <td>Dr Expense · Cr Prepaid Expenses</td>
            <td>Asset bleeds down, expense recognized</td>
          </tr>
        </tbody>
      </table>
      <p>
        The amortization schedule is simply the workpaper that proves the second
        entry is right, every month, for every item — and that the sum of every
        item's remaining balance equals the prepaid line on your balance sheet.
        That last sentence is the entire job. Everything below is technique.
      </p>

      <AmortizationFigure />

      <h2>Straight-line vs days-based: pick deliberately</h2>
      <p>
        <strong>Straight-line</strong> divides the total by the number of months.
        It's what most teams default to, and it's fine — when coverage starts on
        the 1st. The moment a policy starts mid-month, straight-line quietly
        creates a problem: month one gets a full month of expense for half a
        month of coverage, and the final month needs a plug to zero out.
      </p>
      <p>
        <strong>Days-based</strong> divides the total by the days of coverage
        and recognizes exactly the days each month contains. It's the method
        that makes the schedule self-true: no first-month over-recognition, no
        last-month plug, and a defensible answer when an auditor asks why
        February's expense differs from March's.
      </p>
      <aside className="callout">
        <strong>Policy tip:</strong> whichever method you choose, write one
        sentence in your accounting policy ("Prepaids are amortized on a
        days-of-coverage basis from the contract start date") and apply it to
        every item. Consistency is what gets tested — not the method itself.
      </aside>

      <h2>The worked example — copy this pattern</h2>
      <p>
        Meet a $24,000 commercial insurance policy. Paid March 15, 2026; coverage
        runs <strong>March 15, 2026 through March 14, 2027</strong> — 365 days
        of coverage at <strong>$65.75 per day</strong> ($24,000 ÷ 365).
      </p>
      <h3>Step 1 — Book the payment</h3>
      <pre><code>{`03/15/2026   Dr  1400 Prepaid Expenses        24,000.00
             Cr  1000 Operating Cash                     24,000.00
             Memo: D&O policy #88-4417, coverage 3/15/26–3/14/27`}</code></pre>

      <h3>Step 2 — Build the schedule (days-based)</h3>
      <table>
        <thead>
          <tr>
            <th>Month</th><th>Days covered</th><th>Expense</th>
            <th>Cumulative</th><th>Unamortized balance</th>
          </tr>
        </thead>
        <tbody>
          <tr><td>Mar 2026</td><td>17 (Mar 15–31)</td><td>$1,117.81</td><td>$1,117.81</td><td>$22,882.19</td></tr>
          <tr><td>Apr 2026</td><td>30</td><td>$1,972.60</td><td>$3,090.41</td><td>$20,909.59</td></tr>
          <tr><td>May 2026</td><td>31</td><td>$2,038.36</td><td>$5,128.77</td><td>$18,871.23</td></tr>
          <tr><td>⋮</td><td>⋮</td><td>⋮</td><td>⋮</td><td>⋮</td></tr>
          <tr><td>Feb 2027</td><td>28</td><td>$1,841.10</td><td>$23,079.45</td><td>$920.55</td></tr>
          <tr><td>Mar 2027</td><td>14 (Mar 1–14)</td><td>$920.55</td><td>$24,000.00</td><td><strong>$0.00</strong></td></tr>
        </tbody>
      </table>
      <p>
        Notice what days-based buys you: March 2026 recognizes{" "}
        <strong>$1,117.81</strong>, not $2,000 — because you only owned 17 days
        of coverage. And the schedule lands on exactly $0.00 in the final month
        with no plug. (Straight-line would have booked $2,000 in March 2026 —
        overstating expense by $882 in a month where coverage barely started —
        and needed a $2,000 short-month adjustment at the end.)
      </p>

      <h3>Step 3 — Post the monthly entry and tie out</h3>
      <pre><code>{`03/31/2026   Dr  6450 Insurance Expense        1,117.81
             Cr  1400 Prepaid Expenses                    1,117.81
             Memo: D&O #88-4417 — March amortization per schedule`}</code></pre>
      <p>
        Then the single check that makes the schedule worth having: schedule
        unamortized total = GL account 1400 balance. If those two numbers match
        for every month, your prepaid reconciliation is done before it starts.
        (This is the same tie-out logic we walk through in the{" "}
        <Link to="/blog/balance-sheet-reconciliation">balance sheet
        reconciliation guide</Link> — prepaids are just the account where it's
        easiest to get right.)
      </p>

      <h2>Building it in Excel: the column spec</h2>
      <p>If you're staying in a spreadsheet, this is the minimum honest layout — one row per prepaid item:</p>
      <table>
        <thead>
          <tr><th>Column</th><th>What goes in it</th></tr>
        </thead>
        <tbody>
          <tr><td><code>Vendor / Description</code></td><td>"Hartford — D&amp;O policy #88-4417"</td></tr>
          <tr><td><code>GL account</code></td><td>The prepaid asset account it lives in (1400)</td></tr>
          <tr><td><code>Expense account</code></td><td>Where amortization lands (6450) — write it down NOW, not at posting time</td></tr>
          <tr><td><code>Total amount</code></td><td>24,000.00</td></tr>
          <tr><td><code>Start / End date</code></td><td>3/15/2026 · 3/14/2027</td></tr>
          <tr><td><code>Daily rate</code></td><td><code>=Total/(End-Start+1)</code></td></tr>
          <tr><td><code>This-month expense</code></td><td><code>=DailyRate × days of coverage in month</code></td></tr>
          <tr><td><code>Unamortized balance</code></td><td><code>=Total − cumulative expense to date</code></td></tr>
        </tbody>
      </table>
      <p>
        Then a totals row at the bottom whose unamortized sum you compare to the
        GL every month. The formulas are not hard. The discipline is.
      </p>

      <h2>The 7 errors auditors find (in roughly this order)</h2>
      <ol>
        <li>
          <strong>The orphan payment.</strong> A new invoice got coded to 1400
          but never added to the schedule. GL grows, schedule doesn't, and the
          difference sits unexplained until year-end.
        </li>
        <li>
          <strong>The zombie row.</strong> The opposite — a fully amortized item
          still showing a balance because someone stopped updating the tab in
          August.
        </li>
        <li>
          <strong>The missed month.</strong> No amortization entry posted at
          all. The P&amp;L looks great; the balance sheet is quietly wrong.
        </li>
        <li>
          <strong>The first-month plug.</strong> Straight-line on a mid-month
          start, "fixed" later with a manual catch-up nobody documents.
        </li>
        <li>
          <strong>Formula drift.</strong> A row inserted without copying
          formulas; the totals row no longer sums every line. Excel doesn't
          warn you.
        </li>
        <li>
          <strong>The wrong offset.</strong> Amortization booked to a different
          expense account each month, making flux analysis on the expense line
          meaningless. (More on that pain in our{" "}
          <Link to="/blog/flux-analysis-guide">flux analysis guide</Link>.)
        </li>
        <li>
          <strong>No tie-out at all.</strong> A beautiful schedule that nobody
          has compared to the GL since the auditor last asked.
        </li>
      </ol>

      <h2>When the spreadsheet stops being the cheap option</h2>
      <p>
        Excel is the right tool at three prepaids. It's a defensible tool at
        ten. Somewhere past that — or the first time a mid-month policy, a
        renewal, and a true-up land in the same close — the spreadsheet's real
        cost shows up: not the formulas, but the <em>re-verification</em>. Every
        month a human re-derives that the tab still ties, still sums, still
        matches the GL, and still reflects every invoice that hit the account.
        That's an hour that produces nothing new — it just re-proves last
        month's work.
      </p>
      <p>
        This is exactly the shape of work software should own. In{" "}
        <Link to="/solutions">Nordavix</Link>, each prepaid is entered once —
        vendor, amount, coverage dates, expense account — and the platform
        computes days-based amortization every period, proposes the monthly
        journal entry, and pulls the schedule's total straight into the
        reconciliation as the authoritative subledger. The month-end view shows
        the schedule's items on one side, the QuickBooks GL on the other, and a
        tie-out line between them. When you add a new policy mid-month, the
        unposted entry appears as a <em>timing item</em> that clears itself the
        moment you post it — so the difference is always explained, never
        mysterious.
      </p>
      <aside className="callout">
        <strong>The honest pitch:</strong> the math in this article doesn't
        change in software — it's the same days-based amortization. What changes
        is who re-verifies it every month: you, or the system. Nordavix is free
        during beta if you want to compare your tab against it for one close —{" "}
        <Link to="/sign-up">start a workspace</Link>, connect QuickBooks
        (read-only), and load your prepaids.
      </aside>

      <h2>FAQ</h2>
      <h3>What is a prepaid expense amortization schedule?</h3>
      <p>
        It's the supporting workpaper that tracks every payment you made in
        advance and releases the cost to expense over the period it covers.
        Each month it answers two questions: how much expense do I recognize
        this period, and what unamortized balance should remain on the balance
        sheet? The total of all unamortized balances must equal the prepaid
        expenses line in the general ledger.
      </p>
      <h3>What is the journal entry to amortize a prepaid expense?</h3>
      <p>
        Debit the expense account, credit prepaid expenses. For a $24,000 annual
        policy amortized straight-line: Dr Insurance Expense $2,000 / Cr Prepaid
        Insurance $2,000 each month. The original payment was Dr Prepaid
        Insurance $24,000 / Cr Cash $24,000.
      </p>
      <h3>Should amortization be straight-line or days-based?</h3>
      <p>
        Straight-line is simpler and fine when coverage starts on the 1st.
        Days-based is more accurate for mid-month starts and uneven months, and
        removes first/last-month plugs. Pick one, document it, apply it
        consistently.
      </p>
      <h3>Is there a materiality threshold for capitalizing prepaids?</h3>
      <p>
        GAAP sets no dollar threshold — it's a documented policy choice grounded
        in materiality. Many small and mid-size companies expense below a fixed
        floor and capitalize above it. The documentation matters more than the
        number.
      </p>
      <h3>How do you reconcile prepaid expenses at month-end?</h3>
      <p>
        Schedule unamortized total vs GL prepaid balance — they must match. GL
        higher → missed amortization or an orphan payment. Schedule higher → an
        expected entry hasn't been posted yet (a timing item that clears when
        you post it).
      </p>
    </article>
  )
}
