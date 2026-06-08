/**
 * Blog post — "Month-end close is still broken" (beta recruitment).
 * Target keywords: "month-end close" / "why is month-end close so hard" /
 * "month-end close burnout". Job: convert close-weary controllers, CPA
 * firms, and fractional CFOs on QuickBooks into Nordavix beta sign-ups.
 * Founder-voice, opinion + honest invitation — not a how-to guide.
 */
import { Link } from "react-router-dom"
import type { BlogPostMeta } from "@/marketing/blog/types"

export const meta: BlogPostMeta = {
  slug:        "month-end-close-is-broken",
  title:       "Month-End Close Is Still Broken. We're Looking for Firms to Help Fix It.",
  description: "Month-end close hasn't gotten faster in a decade, and it's quietly burning people out. Here's why it stays broken — and how a few beta firms are helping us rebuild it.",
  date:        "2026-06-08",
  readingTime: "6 min read",
  category:    "Close process",
  excerpt:     "The month-end close hasn't gotten meaningfully faster since 2015. It still eats nights, reopens books, and wears people down. Here's why — and an honest invitation to help us build the fix.",
  faq: [
    {
      question: "Why does month-end close take so long?",
      answer:
        "Most of the delay isn't the accounting — it's the coordination. The data lives in QuickBooks, the work happens in spreadsheets, approvals happen over email, and nothing enforces order or remembers what happened last month. Teams spend more time assembling and re-checking the close than actually judging the numbers.",
    },
    {
      question: "How many days should a month-end close take?",
      answer:
        "APQC benchmarks put the median monthly close at about six business days, with top performers under five and the slowest quarter at ten or more. For a small-to-mid company on QuickBooks, three to five business days is a realistic target once reconciliations roll forward and flux is drafted automatically.",
    },
    {
      question: "Can I speed up the close without replacing QuickBooks?",
      answer:
        "Yes. QuickBooks is a fine general ledger; it just doesn't run the close. Tools like Nordavix sit on top of QuickBooks, sync the trial balance, and handle reconciliations, flux analysis, and the review workflow — so you keep your books where they are and only add the layer that's missing.",
    },
    {
      question: "What does the Nordavix beta include?",
      answer:
        "Free early access during the beta, hands-on onboarding for your first close, a direct line to the team building the product, and real influence over what gets built next. In return we ask you to run one real month-end close in it and tell us honestly what works and what doesn't.",
    },
  ],
}

export function Body() {
  return (
    <article>
      <p className="lead">
        It&apos;s the sixth business day of the month. It&apos;s a quarter to eleven
        at night. Everything ties except one account — a prepaid that&apos;s off by
        $412 — and you know that if you go to bed now, it&apos;ll be the first thing
        waiting for you tomorrow. So you stay. Again. If you&apos;ve lived some
        version of that, the rest of this is for you.
      </p>

      <h2>The close hasn&apos;t gotten faster in ten years</h2>
      <p>
        APQC has benchmarked the monthly close for years across thousands of finance
        teams. The median company still takes around <strong>six business days</strong> to
        close its books. The uncomfortable part isn&apos;t the number — it&apos;s the
        trend. It has barely moved: roughly 6.4 days in 2015 to about 6.0 in 2024. A
        decade of new software, faster laptops, and &quot;automation,&quot; and the
        close improved by a rounding error.
      </p>
      <p>
        The spread is worse than the median lets on. APQC&apos;s top performers wrap up
        in under five days; the bottom quarter need ten or more. And a 2025
        benchmarking study from Ledge found only <strong>18%</strong> of finance teams
        close in three days or fewer. Most of the profession is slower than the
        standard everyone quietly measures themselves against.
      </p>
      <aside className="callout">
        Median business days to close, 2015 vs. 2024: about <strong>6.4 → 6.0</strong>.
        Ten years of progress, half a day faster.
      </aside>

      <h2>And it&apos;s quietly wearing people down</h2>
      <p>
        Slow is one problem. The human cost is the part nobody puts on a dashboard. In
        2022, FloQast ran a study with the University of Georgia using the Maslach
        Burnout Inventory — the standard clinical measure. <strong>99%</strong> of the
        accountants surveyed showed some level of burnout. <strong>81%</strong> said the
        close had disrupted their personal life in at least one month of the prior
        year. <strong>85%</strong> had to reopen the books at least once to fix an error
        after they thought they were finished.
      </p>
      <p>
        Robert Half puts roughly <strong>73%</strong> of finance and accounting staff
        working overtime during close — about eleven extra hours per cycle. That&apos;s
        a second workday, every single month, spent chasing tie-outs and re-keying
        numbers between QuickBooks, Excel, and email.
      </p>
      <p>
        Now add the math the whole profession is up against. The U.S. accounting
        workforce has shrunk by roughly 300,000 people since 2020 — down about 17%,
        according to the Bureau of Labor Statistics — and the number of people sitting
        for the CPA exam is well off its peak. So the close isn&apos;t getting smaller,
        the calendar isn&apos;t getting longer, and there are fewer people each year to
        absorb the gap. Something gives. Right now, the thing giving way is the people.
      </p>

      <h2>Why the close stays broken</h2>
      <p>
        Here&apos;s the honest diagnosis from someone who has done plenty of these: the
        close is mostly rules-based, repetitive, and checkable — and almost none of it
        is automated for normal-sized companies.
      </p>
      <p>
        Real close software does exist. You&apos;ve seen it at conferences. It was built
        for the Fortune 500, priced for the Fortune 500, and it takes a six-month
        implementation and a dedicated admin to stand up. If you&apos;re a controller at
        a $20M company, a CPA firm running close for thirty clients, or a fractional CFO
        juggling five sets of books, that world was never built with you in mind.
      </p>
      <p>
        So you do what everyone does. QuickBooks holds the ledger, but it doesn&apos;t
        run the close. The actual close lives in a spreadsheet someone built in 2019, a
        shared drive full of PDFs, and a thread of &quot;did you approve the AR rec
        yet?&quot; messages. It works, more or less. It also has no memory, no real
        controls, and no way to tell you what changed since last month unless you sit
        there and diff it by hand.
      </p>
      <p>
        That&apos;s the gap. Not a lack of effort — a lack of tooling that fits the 99%
        of companies that aren&apos;t the Fortune 500.
      </p>

      <h2>What we&apos;re building</h2>
      <p>
        Nordavix is a month-end close workspace for companies on QuickBooks. The idea is
        plain: automate the boring, checkable 60% of the close, and give the judgment
        work a clean place to happen.
      </p>
      <ul>
        <li>
          <strong>Connect QuickBooks and your trial balance syncs in.</strong> No
          exports, no copy-paste, no &quot;which version is current.&quot;
        </li>
        <li>
          <strong>Reconciliations roll forward on their own.</strong> Last month&apos;s
          closing balance becomes this month&apos;s opening, the GL is tied to the
          subledger automatically, and the differences get surfaced instead of buried.
          (More on doing this well in our{" "}
          <Link to="/blog/balance-sheet-reconciliation" className="text-[var(--green)] underline">
            balance sheet reconciliation guide
          </Link>.)
        </li>
        <li>
          <strong>Flux analysis that explains itself.</strong> Every material movement
          gets the transactions behind it pulled and a first-draft explanation written,
          so review starts at &quot;is this right?&quot; instead of &quot;what even
          happened here?&quot; (We broke this down in the{" "}
          <Link to="/blog/flux-analysis-guide" className="text-[var(--green)] underline">
            flux analysis guide
          </Link>.)
        </li>
        <li>
          <strong>Maker-checker and a sequential close gate, on by default.</strong> You
          can&apos;t approve your own work, and you can&apos;t close a month while the
          prior one is still open. (It&apos;s the spine of our{" "}
          <Link to="/blog/month-end-close-checklist" className="text-[var(--green)] underline">
            close checklist
          </Link>.)
        </li>
        <li>
          <strong>Clean output at the end.</strong> Working papers and a board-ready
          financial package come out as PDFs you&apos;d be comfortable handing to an
          auditor or an owner.
        </li>
      </ul>
      <p>
        It&apos;s not magic, and we won&apos;t pretend it is. The AI drafts; you still
        decide. But the difference between starting a reconciliation from a blank cell
        and starting it from a tied-out schedule with the exceptions already flagged is
        the difference between leaving at eleven and leaving at six.
      </p>

      <h2>We&apos;re looking for a few firms to build this with</h2>
      <p>
        Nordavix is in beta, and we mean it literally — not &quot;launched, but we still
        call it beta.&quot; We&apos;re onboarding a small number of teams and building
        the next stretch of the product around what actually breaks for them.
      </p>
      <p>This is for you if you&apos;re one of these:</p>
      <ul>
        <li>A controller or accounting manager at a small-to-mid company on QuickBooks.</li>
        <li>A CPA or bookkeeping firm running close for a roster of clients.</li>
        <li>A fractional CFO or outsourced team who feels the close pain five times over.</li>
      </ul>
      <p>
        <strong>What you get:</strong> Free access for the duration of the beta.
        Hands-on onboarding — we&apos;ll set up your first close with you, not point you
        at a help doc. A direct line to the people building it (one of whom is a CPA
        who has closed his share of miserable months). And genuine influence over the
        roadmap, because at this stage your &quot;this is annoying&quot; becomes next
        week&apos;s fix.
      </p>
      <p>
        <strong>What we ask:</strong> Run one real close in it. Then tell us what&apos;s
        clunky, what&apos;s missing, and what you&apos;d refuse to give up. That&apos;s
        the whole arrangement.
      </p>
      <aside className="callout">
        Beta means some edges are still rough and we ship fixes weekly. If you want a
        finished enterprise suite, we&apos;re not that — yet. If you want to shape one
        built for <strong>your</strong> size of company, this is the moment to get in.
      </aside>

      <h2>If you&apos;re tired of the 11 PM version of this job</h2>
      <p>
        The close is never going to be anyone&apos;s favorite week. But it shouldn&apos;t
        cost you your evenings, your accuracy, or the good people on your team. Those are
        too expensive to keep spending on work a machine should be doing for you.
      </p>
      <p>
        If any of this landed a little too close to home,{" "}
        <Link to="/sign-up" className="text-[var(--green)] underline font-semibold">
          start a free Nordavix workspace
        </Link>{" "}
        and we&apos;ll reach out to get you set up — or read the{" "}
        <Link to="/solutions" className="text-[var(--green)] underline">
          product overview
        </Link>{" "}
        first if you&apos;d rather see how the pieces fit together.
      </p>

      <h2>Questions we get</h2>

      <h3>Why does month-end close take so long?</h3>
      <p>
        Most of the delay isn&apos;t the accounting — it&apos;s the coordination. The
        data lives in QuickBooks, the work happens in spreadsheets, approvals happen
        over email, and nothing enforces order or remembers what happened last month.
        Teams spend more time assembling and re-checking the close than actually judging
        the numbers.
      </p>

      <h3>How many days should a month-end close take?</h3>
      <p>
        APQC benchmarks put the median monthly close at about six business days, with
        top performers under five and the slowest quarter at ten or more. For a
        small-to-mid company on QuickBooks, three to five business days is a realistic
        target once reconciliations roll forward and flux is drafted automatically.
      </p>

      <h3>Can I speed up the close without replacing QuickBooks?</h3>
      <p>
        Yes. QuickBooks is a fine general ledger; it just doesn&apos;t run the close.
        Tools like Nordavix sit on top of QuickBooks, sync the trial balance, and handle
        reconciliations, flux analysis, and the review workflow — so you keep your books
        where they are and only add the layer that&apos;s missing.
      </p>

      <h3>What does the Nordavix beta include?</h3>
      <p>
        Free early access during the beta, hands-on onboarding for your first close, a
        direct line to the team building the product, and real influence over what gets
        built next. In return we ask you to run one real month-end close in it and tell
        us honestly what works and what doesn&apos;t.
      </p>
    </article>
  )
}
