/**
 * Blog post — maker-checker / segregation of duties for small teams.
 * Primary: "maker checker process in accounting". Cluster: "segregation of
 * duties small business", "internal controls month end close", "who should
 * approve journal entries", "self review threat accounting", "month end
 * close approval workflow".
 * Product tie-in: roles (preparer/reviewer/admin), approval gates, period
 * lock, audit log.
 */
import { Link } from "react-router-dom"
import type { BlogPostMeta } from "@/marketing/blog/types"

export const meta: BlogPostMeta = {
  slug:        "maker-checker-accounting-controls",
  title:       "Maker-Checker for a 3-Person Accounting Team: Real Controls Without the Bureaucracy",
  description: "Segregation of duties feels impossible with three people. It isn't. The four controls that actually matter at month-end — maker-checker on judgments, variance gates, period locks, and an attributed audit trail — and how to enforce them in a QuickBooks world.",
  date:        "2026-06-12",
  readingTime: "10 min read",
  category:    "Audit",
  excerpt:     "\"We're too small for internal controls\" is how every fraud post-mortem and every busted audit begins. You don't need SOX. You need four controls, enforced by the system instead of a memo — here's the whole design for a team of three.",
  faq: [
    {
      question: "What is the maker-checker process in accounting?",
      answer:
        "Maker-checker (also called four-eyes or preparer-reviewer) is the control where the person who prepares a number cannot be the person who approves it. The maker reconciles the account or drafts the journal entry; a different person — the checker — reviews the support and signs off. Its entire purpose is to make sure at least two people have looked at anything that changes the financial statements.",
    },
    {
      question: "How do you implement segregation of duties with only 2–3 people?",
      answer:
        "Stop trying to segregate everything and segregate the four decisions that matter: approving reconciliations, approving journal entries, locking the period, and changing user permissions. With three people: the preparer does the work, a second person approves it, and one admin (often the owner or fractional CFO) locks periods and manages access. Even with two people, the rule 'whoever prepared it doesn't approve it' is enforceable per item.",
    },
    {
      question: "Who should approve journal entries?",
      answer:
        "Someone other than the person who drafted them — a controller, manager, or fractional CFO acting as reviewer. The approver should see the entry, the reason for it, and the support (the variance it fixes, the schedule it comes from) before signing off. Self-approved entries are the single most common control failure auditors flag in small companies.",
    },
    {
      question: "Does QuickBooks enforce maker-checker?",
      answer:
        "Not natively. QuickBooks Online's roles control what users can access, but there is no built-in workflow that blocks a user from approving their own journal entry or reconciliation, and no period-level sign-off trail tied to each balance-sheet account. Teams typically enforce maker-checker by policy (a memo), in spreadsheets (initials in a cell), or with close software layered on top of QuickBooks that makes the rule system-enforced.",
    },
    {
      question: "What is a period lock and why does it matter?",
      answer:
        "A period lock (closing the books) prevents anyone from editing a finished month. Without it, a January number you reported can silently change in March and nothing ties anymore. A good lock is sequential — you can't close March before February — and reopening requires elevated permission and leaves a trail.",
    },
  ],
}

// ── Inline figure: the maker-checker flow ───────────────────────────────────
function MakerCheckerFigure() {
  const box = (x: number, label: string, sub: string, accent: string) => (
    <g>
      <rect x={x} y="64" width="176" height="84" rx="12"
        fill="var(--surface)" stroke="var(--border-strong)" strokeWidth="1.5" />
      <rect x={x} y="64" width="176" height="6" rx="3" fill={accent} />
      <text x={x + 88} y="102" textAnchor="middle" fontSize="14" fontWeight="700" fill="var(--text)">{label}</text>
      <text x={x + 88} y="124" textAnchor="middle" fontSize="11" fill="var(--text-2)">{sub}</text>
    </g>
  )
  return (
    <figure style={{ margin: "1.8em 0" }}>
      <svg viewBox="0 0 680 220" role="img"
        aria-label="Diagram: maker prepares, checker approves, admin locks the period — three different people, each action attributed in the audit trail"
        style={{ width: "100%", height: "auto", background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 12 }}>
        {box(24,  "MAKER",   "prepares · reconciles · drafts", "var(--info)")}
        {box(252, "CHECKER", "reviews support · approves",      "var(--green)")}
        {box(480, "ADMIN",   "locks period · grants access",    "var(--warn)")}
        {/* arrows */}
        {[218, 446].map((x) => (
          <g key={x}>
            <line x1={x - 16} y1="106" x2={x + 22} y2="106" stroke="var(--text-muted)" strokeWidth="2" />
            <path d={`M ${x + 22} 106 l -8 -5 v 10 z`} fill="var(--text-muted)" />
          </g>
        ))}
        {/* forbidden self-loop */}
        <path d="M 112 64 C 112 18, 200 18, 200 56" fill="none" stroke="var(--danger)" strokeWidth="2" strokeDasharray="5 4" />
        <text x="156" y="14" textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--danger)"
          fontFamily="JetBrains Mono, monospace">SELF-APPROVAL ✕</text>
        {/* audit trail base */}
        <rect x="24" y="172" width="632" height="30" rx="8" fill="var(--surface)" stroke="var(--border)" />
        <text x="340" y="191" textAnchor="middle" fontSize="11" fill="var(--text-2)"
          fontFamily="JetBrains Mono, monospace">
          AUDIT TRAIL — every action above, attributed + timestamped
        </text>
      </svg>
      <figcaption style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 8, textAlign: "center" }}>
        The whole control in one row: different hands, one forbidden arrow, everything logged.
      </figcaption>
    </figure>
  )
}

export function Body() {
  return (
    <article>
      <p className="lead">
        "We're too small for internal controls" is how every fraud post-mortem
        and every blown audit begins. The good news: a three-person team doesn't
        need SOX. It needs <strong>four controls</strong>, applied to the
        handful of decisions that actually change the financial statements —
        and it needs them enforced by the system, not by a memo everyone forgot
        by February.
      </p>

      <h2>Why small teams skip controls (and why the reasoning fails)</h2>
      <p>
        The honest objection isn't laziness — it's arithmetic. Classic
        segregation-of-duties charts assume you can split authorization,
        custody, recording, and reconciliation across different people. With
        three people (or two, or one plus a fractional CFO), the chart is
        impossible, so teams conclude controls are impossible and stop there.
      </p>
      <p>
        The error is treating controls as all-or-nothing. You can't segregate{" "}
        <em>everything</em>; you can absolutely segregate the four decisions
        that matter. Auditors know this — when they assess a small client, they
        aren't looking for a Fortune 500 control matrix. They're looking for
        whether <strong>anything material can reach the financial statements
        seen by only one pair of eyes</strong>, and whether the books can change
        after you've reported them.
      </p>

      <h2>The four controls that actually matter</h2>

      <h3>1 · Maker-checker on judgments (not on everything)</h3>
      <p>
        The control: <strong>whoever prepared a number cannot approve it.</strong>{" "}
        Apply it to judgments — reconciliations, journal entries, variance
        explanations — not to mechanical work like coding a routine bill.
        Approving your own reconciliation isn't review; it's proofreading your
        own essay. You'll miss the same thing twice.
      </p>
      <MakerCheckerFigure />
      <p>
        The roles for a team of three map cleanly: a <strong>preparer</strong>{" "}
        who reconciles accounts and drafts entries, a <strong>reviewer</strong>{" "}
        who approves them against the support, and an <strong>admin</strong> —
        often the owner, CFO, or the engagement partner at a CPA firm — who
        locks periods and controls access. Two people? The roles flex per item:
        you prepare the bank rec, your colleague approves it; they prepare the
        accrual entry, you approve that. The rule survives even when the
        org chart is tiny.
      </p>

      <h3>2 · A variance gate in front of "done"</h3>
      <p>
        Nothing should be markable as reconciled while the general ledger and
        the supporting subledger still disagree. That sounds obvious; in
        spreadsheet-land it's unenforceable — a tab can say "reconciled ✓" in a
        cell next to a $4,320 unexplained difference, and nothing stops it. A
        real gate means the approve button literally doesn't work until the
        variance is zero or explained line-by-line. (Our{" "}
        <Link to="/blog/balance-sheet-reconciliation-checklist">balance sheet
        reconciliation checklist</Link> covers what "explained" should mean.)
      </p>

      <h3>3 · The period lock — sequential, gated, reversible only with a trail</h3>
      <p>
        Once a month is reported, it must stop moving. A period lock prevents
        edits to closed months; a <em>good</em> one is sequential (you can't
        close March while February is still open — closing out of order is how
        roll-forwards break) and refuses to lock while accounts remain
        unapproved. Reopening should require the admin role and leave a
        timestamped record of who did it and why.
      </p>

      <h3>4 · An attributed audit trail</h3>
      <p>
        Every approval, every entry, every lock and reopen — recorded with who
        and when, in a log nobody can edit. This is the control that makes the
        other three provable. When the auditor asks "who approved this and on
        what evidence," the answer is a row in a log, not an archaeology project
        through email. (It's also most of the work in our{" "}
        <Link to="/blog/audit-prep-checklist">audit prep checklist</Link> —
        done continuously instead of in a panic.)
      </p>

      <h2>The 3-person control matrix (steal this)</h2>
      <table>
        <thead>
          <tr><th>Decision</th><th>Preparer</th><th>Reviewer</th><th>Admin</th></tr>
        </thead>
        <tbody>
          <tr><td>Sync data / reconcile accounts</td><td>✓ does</td><td>✓ can</td><td>✓ can</td></tr>
          <tr><td>Draft journal entries &amp; schedules</td><td>✓ does</td><td>✓ can</td><td>✓ can</td></tr>
          <tr><td>Mark account prepared</td><td>✓ (own work)</td><td>✓</td><td>✓</td></tr>
          <tr><td><strong>Approve reconciliation / entry</strong></td><td>✕ never own work</td><td>✓</td><td>✓</td></tr>
          <tr><td><strong>Flag for investigation</strong></td><td>✕</td><td>✓</td><td>✓</td></tr>
          <tr><td><strong>Close / reopen period</strong></td><td>✕</td><td>✕</td><td>✓</td></tr>
          <tr><td><strong>Manage users &amp; roles</strong></td><td>✕</td><td>✕</td><td>✓</td></tr>
          <tr><td><strong>Change company settings</strong></td><td>✕</td><td>✕</td><td>✓</td></tr>
        </tbody>
      </table>
      <aside className="callout">
        <strong>The one-person caveat, honestly:</strong> if you are truly solo,
        maker-checker is impossible by definition. The fallback controls are a
        period lock you respect, an immutable log, and a periodic external
        review (your CPA looking at one month per quarter). Don't pretend a
        memo to yourself is a control — schedule the outside eyes instead.
      </aside>

      <h2>Policy-enforced vs system-enforced (the part that decides everything)</h2>
      <p>
        Here is the uncomfortable truth about every control above: written in a
        memo, they decay. The first deadline crunch, someone approves their own
        entry "just this once," and now your control environment is a story you
        tell rather than a thing that happens. The difference between a control
        that exists and a control that works is <strong>where it's
        enforced</strong>:
      </p>
      <table>
        <thead>
          <tr><th></th><th>Policy-enforced (memo)</th><th>System-enforced</th></tr>
        </thead>
        <tbody>
          <tr><td>Self-approval</td><td>"Please don't"</td><td>The button returns a 403</td></tr>
          <tr><td>Closing with open items</td><td>Checklist discipline</td><td>Close is blocked until accounts approve</td></tr>
          <tr><td>Editing a closed month</td><td>Hope</td><td>Locked; admin-only reopen, logged</td></tr>
          <tr><td>Evidence of review</td><td>Initials in a cell</td><td>Attributed, timestamped sign-off</td></tr>
        </tbody>
      </table>
      <p>
        QuickBooks alone can't get you to the right-hand column — its roles
        gate <em>access</em>, not <em>workflow</em>. There's no native concept
        of "this reconciliation was prepared by A and must be approved by
        someone who isn't A." That's the layer close software adds. In{" "}
        <Link to="/solutions">Nordavix</Link>, the matrix above isn't a
        policy — it's the permission model: preparers physically cannot approve
        their own work (the API refuses, not just the button), approval is
        blocked while variance is non-zero, the close gate won't lock a month
        with unapproved accounts, periods close sequentially, and every action
        lands in an audit log with a name on it. Even the AI obeys the matrix:
        it prepares and proposes, and the approval click is always a human who
        isn't the preparer.
      </p>

      <h2>Roll it out in one close (a realistic plan)</h2>
      <ol>
        <li><strong>Week 1 — name the roles.</strong> One sentence each: who prepares, who approves, who holds admin. Two people is enough; flex per item.</li>
        <li><strong>First close — apply maker-checker to judgments only.</strong> Reconciliations and JEs. Leave bill-coding alone; don't boil the ocean.</li>
        <li><strong>Same close — lock the month when done.</strong> If your tools can't lock, export the final TB and date-stamp it somewhere immutable. Imperfect, better than nothing.</li>
        <li><strong>Second close — add the variance gate.</strong> Nothing gets called reconciled with an unexplained difference. Watch what this surfaces; it will surprise you.</li>
        <li><strong>Quarter-end — read your own log.</strong> Ten minutes: who approved what? Any self-approvals sneak through? That review <em>is</em> the control environment maturing.</li>
      </ol>

      <aside className="callout">
        <strong>Try the system-enforced version free:</strong> Nordavix is in
        beta — the full role model, approval gates, sequential close, and audit
        log on top of a read-only QuickBooks connection.{" "}
        <Link to="/sign-up">Start a workspace</Link>, invite one colleague as a
        reviewer, and run a single month through it. If the matrix above holds
        without anyone reading a memo, it's working.
      </aside>

      <h2>FAQ</h2>
      <h3>What is the maker-checker process in accounting?</h3>
      <p>
        The control where the person who prepares a number cannot be the person
        who approves it. The maker reconciles or drafts; a different person —
        the checker — reviews the support and signs off, so nothing material
        reaches the financial statements on one pair of eyes.
      </p>
      <h3>How do you implement segregation of duties with 2–3 people?</h3>
      <p>
        Segregate the four decisions that matter rather than everything:
        approving reconciliations, approving entries, locking periods, and
        managing access. Preparer does the work, a second person approves, one
        admin locks and grants. With two people, the rule "never approve your
        own work" is enforceable per item.
      </p>
      <h3>Who should approve journal entries?</h3>
      <p>
        Someone other than the drafter — controller, manager, or fractional CFO
        — reviewing the entry, its reason, and its support before sign-off.
        Self-approved entries are the most common small-company control failure
        auditors flag.
      </p>
      <h3>Does QuickBooks enforce maker-checker?</h3>
      <p>
        Not natively — QBO roles gate access, not workflow. There's no built-in
        block on approving your own entry and no per-account sign-off trail.
        Teams enforce it by policy, in spreadsheets, or with close software
        layered on QuickBooks that makes the rule system-enforced.
      </p>
      <h3>What is a period lock and why does it matter?</h3>
      <p>
        Closing the books so a finished month can't be edited. Without it, a
        reported January number can silently change in March. A good lock is
        sequential, blocked until accounts are approved, and reversible only by
        an admin with a logged reason.
      </p>
    </article>
  )
}
