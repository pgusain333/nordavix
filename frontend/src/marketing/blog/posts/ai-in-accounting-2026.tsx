/**
 * Blog post — AI in accounting, what's actually working in 2026.
 * Target keyword: "AI in accounting" + "AI for CPAs"
 */
import { Link } from "react-router-dom"
import type { BlogPostMeta } from "@/marketing/blog/types"

export const meta: BlogPostMeta = {
  slug:        "ai-in-accounting-2026",
  title:       "AI in accounting: what's actually working in 2026",
  description: "Past the AI hype, where is AI genuinely useful in CPA work today? Honest read from a CPA building an AI-native close platform on what works, what doesn't, and what's coming.",
  date:        "2026-05-28",
  readingTime: "8 min read",
  category:    "AI",
  excerpt:     "Past the AI hype, where is AI genuinely useful in CPA work today — and where is it still oversold? An honest read from a CPA who's been building with it for a year.",
}

export function Body() {
  return (
    <article className="prose prose-slate max-w-none">
      <p className="lead">
        Every accounting conference in 2025 had an &quot;AI is changing
        everything&quot; keynote. Most of them were wrong about what AI actually
        does well in accounting work and what it&apos;s still bad at. Here&apos;s
        a working CPA&apos;s read on where AI is genuinely useful today, where
        it&apos;s being oversold, and what&apos;s coming next.
      </p>

      <h2>The honest baseline</h2>
      <p>
        Modern large language models — GPT-4 / Claude / Gemini class — are very
        good at four things that matter for accounting:
      </p>
      <ol>
        <li><strong>Writing.</strong> Drafting commentary, narratives, summaries from structured inputs.</li>
        <li><strong>Classification.</strong> Reading a transaction memo and assigning a category, vendor, or account.</li>
        <li><strong>Pattern-matching.</strong> Spotting things that look like a known concept (prepaid expenses, accruals, intercompany) in messy data.</li>
        <li><strong>Question-answering over a fixed context.</strong> Given a set of documents or rows, answering questions about them.</li>
      </ol>
      <p>And bad at three things that also matter:</p>
      <ol>
        <li><strong>Arithmetic.</strong> They can do simple math but make errors on long calculation chains. Never let an LLM do an unaudited cash-flow rollforward.</li>
        <li><strong>Strict rule-following without examples.</strong> &quot;Apply ASC 842 to this lease&quot; — they&apos;ll produce confident plausible output that&apos;s wrong on edge cases.</li>
        <li><strong>Knowing what they don&apos;t know.</strong> They&apos;ll hallucinate an invoice number, a date, or a balance with the same confidence as a real one.</li>
      </ol>
      <p>
        Every working AI accounting feature in 2026 plays to the strengths and
        guards against the weaknesses. The features that fail are the ones that
        pretend the weaknesses don&apos;t exist.
      </p>

      <h2>What&apos;s actually working</h2>

      <h3>1. Flux analysis commentary</h3>
      <p>
        This is where AI shines. Given an account, this period&apos;s balance,
        last period&apos;s balance, and the top 5–10 transactions driving the
        change, an LLM can write a one-paragraph variance explanation that&apos;s
        better than what most preparers write in 3 minutes — because the LLM
        actually looks at the transactions.
      </p>
      <p>
        The trick is giving it the transactions. The lazy version (&quot;here&apos;s
        the variance, write something&quot;) produces generic boilerplate. The
        useful version (&quot;here&apos;s the variance AND the three biggest
        journal entries posted to this account this month&quot;) produces a real
        explanation a reviewer can verify.
      </p>

      <h3>2. Reconciliation evidence verification</h3>
      <p>
        Upload a bank statement PDF. Upload the bank reconciliation workbook.
        Ask the LLM: &quot;Does the workbook&apos;s closing balance tie to the
        statement? Are the outstanding deposits and checks reasonable?&quot; It
        reads both documents, ties the numbers, flags discrepancies. This is
        verification, not preparation — exactly where AI is safest.
      </p>

      <h3>3. Account classification at scale</h3>
      <p>
        Given a new transaction with a vendor and memo, predict which GL account
        it should hit. Trained on your firm&apos;s historical coding, it gets
        right ~90% of the time on routine transactions. Saves preparer time
        without making any decisions a human couldn&apos;t override.
      </p>

      <h3>4. Schedule detection</h3>
      <p>
        Scanning the expense ledger for things that look like prepaid items
        (vendor + amount + memo pattern suggesting an annual SaaS subscription)
        or missed accruals (payment in current month for services rendered last
        month). The LLM doesn&apos;t book the entries — it surfaces candidates
        for the preparer to review.
      </p>

      <h3>5. Intercompany counterparty inference</h3>
      <p>
        Given an IC account name like &quot;Due from Acme Sub&quot; or a list
        of transactions mostly hitting one Customer, identify which related
        entity is the counterparty. Saves the &quot;tagging&quot; work that
        nobody enjoys.
      </p>

      <h3>6. Audit-ready documentation</h3>
      <p>
        Turning a finished reconciliation into a PDF workpaper — with the
        narrative, the variance commentary, the supporting items — formatted
        the way an audit prefers. Heavily templated work, perfect AI use case.
      </p>

      <h2>What&apos;s being oversold</h2>

      <h3>&quot;AI books your journal entries&quot;</h3>
      <p>
        Be careful. The good versions of this are sub-feature 3 above — AI
        suggests; human approves. The bad versions auto-post entries with no
        review, on the theory that you can &quot;always reverse them.&quot; In
        practice nobody reverses. Wrong entries pile up. The trial balance
        slowly drifts.
      </p>

      <h3>&quot;AI does your tax return&quot;</h3>
      <p>
        Not yet. Tax requires strict rule-following that LLMs don&apos;t do well
        without massive guardrails. Document prep — gathering the inputs, summarizing
        positions, drafting client letters — works. Actual return preparation
        with reliable accuracy is a 2027 problem.
      </p>

      <h3>&quot;Chat with your data&quot;</h3>
      <p>
        Works in demos. Falls over in production because users ask questions
        that require multi-step reasoning over financial data, and LLMs make
        arithmetic mistakes the user can&apos;t spot. Until the model is paired
        with a real query engine (text-to-SQL with verification, not free-form
        generation), this remains a research problem.
      </p>

      <h2>The pattern that&apos;s actually replacing work</h2>
      <p>
        The pattern that&apos;s genuinely reducing close hours isn&apos;t any one
        AI feature — it&apos;s the combination of: <strong>(a)</strong> automated
        data pulls from the source GL, <strong>(b)</strong> AI-drafted commentary
        and classifications on top of that data, <strong>(c)</strong> a workflow
        that enforces order so nothing falls through the cracks, and
        <strong>(d)</strong> humans staying in the review loop for every material
        decision.
      </p>
      <p>
        That&apos;s the recipe we&apos;re building at {" "}<Link to="/solutions" className="text-[var(--green)] underline">Nordavix</Link>:
        AI does the typing, humans do the thinking, software enforces the order.
        It&apos;s not a moonshot. It&apos;s automating the boring 60% of close
        work so controllers can spend their time on the 40% that needed judgment
        anyway.
      </p>

      <h2>What&apos;s coming in 2026–2027</h2>
      <ul>
        <li>
          <strong>Native audit AI.</strong> Big-4 firms are already piloting LLM-driven
          substantive testing — sampling transactions, ticking them to source,
          summarizing exceptions. Expect this to be standard in 18 months.
        </li>
        <li>
          <strong>True text-to-SQL with verification.</strong> Ask &quot;what was our
          gross margin in Q1 by product line&quot; and get the right answer because
          the model writes SQL that runs against your data and shows its work.
        </li>
        <li>
          <strong>Agentic close.</strong> The model doesn&apos;t just suggest — it
          drafts the entry, files it for review, and pings the reviewer. The human
          becomes more reviewer than preparer.
        </li>
        <li>
          <strong>Voice-first review.</strong> &quot;Read me the variances over $25k
          for the marketing department.&quot; Useful for CFOs who want a daily
          flux briefing without opening a dashboard.
        </li>
      </ul>

      <h2>The takeaway for CPAs</h2>
      <p>
        Don&apos;t buy the AI tools that promise to replace your judgment.
        DO use the AI tools that take the typing off your plate so you can use
        your judgment on the things that matter. The work has always been thinking
        + typing; AI is finally good enough to handle the typing.
      </p>
      <p>
        If you want to see what that looks like in a real close workflow,{" "}
        <Link to="/sign-up" className="text-[var(--green)] underline font-semibold">
          start a free Nordavix workspace
        </Link>{" "}
        and run your next close through it. The AI commentary, schedule
        detection, and elimination work are all live today.
      </p>
    </article>
  )
}
