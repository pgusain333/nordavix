/**
 * Blog post — "How Nordavix protects your clients' financial data".
 * Target keywords: "accounting software security" / "is my financial data
 * safe" / "QuickBooks app security" / "tenant isolation". Job: answer the
 * buyer's #1 objection ("can I put my clients' books in this?") in plain,
 * honest, founder-CPA voice. Every claim maps to a real, shipped control;
 * the "what we haven't done yet" section keeps it credible.
 */
import { Link } from "react-router-dom"
import type { BlogPostMeta } from "@/marketing/blog/types"

export const meta: BlogPostMeta = {
  slug:        "how-nordavix-protects-financial-data",
  title:       "How Nordavix Protects Your Clients' Financial Data",
  description: "A plain-English tour of Nordavix security: two-wall workspace isolation, encrypted credentials, read-only QuickBooks, AI that never trains on your data, and an honest roadmap.",
  date:        "2026-06-22",
  readingTime: "9 min read",
  category:    "Audit",
  excerpt:     "Before you put a client's books in any tool, you should know exactly how it's protected. Here's our whole security model in plain English — two walls around every workspace, encrypted credentials, read-only QuickBooks, no AI training on your data — and an honest list of what we haven't done yet.",
  faq: [
    {
      question: "Is my financial data safe in Nordavix?",
      answer:
        "Your data is encrypted in transit (HTTPS/TLS) and at rest (AES-256), your QuickBooks tokens get a second layer of application-level encryption, and every workspace is isolated behind two independent walls — an automatic query filter and database row-level security. You can export everything or permanently delete it at any time.",
    },
    {
      question: "Can another firm or client see my data in Nordavix?",
      answer:
        "No. Nordavix is multi-tenant, and isolation is enforced twice: a session-level filter scopes every database read to your workspace and fails closed if the context is missing, and PostgreSQL row-level security policies on every workspace table make the database itself refuse another workspace's rows. The exact cross-tenant bug we'd most fear is locked shut by an automated test that fails our build if it ever reappears.",
    },
    {
      question: "Does Nordavix's AI train on my data?",
      answer:
        "No. Nordavix uses Anthropic's Claude through their commercial API, and our agreement prohibits training their models on your data. We send only the minimum context a feature needs, and we don't build our own models on customer content.",
    },
    {
      question: "Is Nordavix SOC 2 certified?",
      answer:
        "Not yet, and we won't pretend otherwise. We already operate along SOC 2-aligned lines — encryption, least-privilege access, audit logging, role-based access, and vendor data-processing agreements — and pursuing SOC 2 Type II is on our roadmap as we grow.",
    },
  ],
}

export function Body() {
  return (
    <article>
      <p className="lead">
        Every accountant evaluating a new tool asks the same question, even if they
        don&apos;t say it out loud: <em>can I really put my clients&apos; financials in
        this?</em> It&apos;s the right question. So instead of waving around badges,
        here&apos;s the whole security model in plain English — what we actually do today,
        and just as honestly, what we don&apos;t do yet.
      </p>

      <h2>We treat your data as the foundation, not a feature</h2>
      <p>
        Nordavix is built by a CPA, for accountants — people trusted with their
        clients&apos; most sensitive records. That shapes how the product is built, not
        just how it&apos;s marketed. The short version: your data is encrypted at every
        stage, every workspace is walled off from every other one, QuickBooks stays
        read-only, and the AI never trains on your numbers. The longer version is below.
      </p>
      <aside className="callout">
        The honesty rule we hold ourselves to: where something is on the roadmap rather
        than done, we say so. An overstated security claim is the fastest way to lose an
        accountant&apos;s trust — so you&apos;ll find a &quot;what we haven&apos;t done
        yet&quot; section near the end.
      </aside>

      <h2>Two walls around every workspace</h2>
      <p>
        In multi-tenant software, the line that must never be crossed is one firm seeing
        another firm&apos;s data. We don&apos;t trust a single safeguard with that. We
        built <strong>two independent walls</strong>, so isolation holds even if a piece
        of application code had a bug.
      </p>
      <ul>
        <li>
          <strong>Wall one — automatic query scoping.</strong> A session-level filter
          stamps your workspace&apos;s identity onto every single database read. A query
          simply cannot return another workspace&apos;s rows — and it <em>fails
          closed</em>: if the workspace context is ever missing, the query errors out
          rather than returning anything at all.
        </li>
        <li>
          <strong>Wall two — the database enforces it too.</strong> On top of that,
          PostgreSQL row-level security policies sit on every one of our workspace tables
          (about 50 of them). Even a query that somehow slipped past the application layer
          is refused by the database itself.
        </li>
        <li>
          <strong>Writes are checked for ownership.</strong> Before any bulk update or
          delete, we verify you actually own the records involved.
        </li>
      </ul>
      <p>
        And because this is the highest-stakes boundary in the product, the exact bug
        we&apos;d most fear — one tenant&apos;s data bleeding into another&apos;s — is
        locked shut by an automated test that fails our build if it ever reappears. For a
        CPA firm running many clients, that same boundary keeps each client&apos;s data
        separated, too.
      </p>

      <h2>Your credentials are encrypted — and QuickBooks stays read-only</h2>
      <p>
        Encryption happens at every layer. Connections are served over HTTPS (TLS 1.2+);
        the database and uploaded files are encrypted at rest with AES-256 by our
        infrastructure providers. Your QuickBooks access tokens — the most sensitive
        secret we hold — get a <strong>second, independent layer</strong> of authenticated
        encryption inside our application before they&apos;re ever written down, using a
        key kept out of the database entirely.
      </p>
      <aside className="callout">
        That last layer isn&apos;t optional: Nordavix <strong>refuses to start in
        production</strong> without its encryption key, so tokens can never silently fall
        back to being stored in the clear.
      </aside>
      <p>
        The QuickBooks connection itself is deliberately narrow. You connect through
        Intuit&apos;s official OAuth flow — we never see your QuickBooks username or
        password — and we read only the reports the close needs (trial balance, general
        ledger, P&amp;L, A/R and A/P aging). Disconnect any time, and we revoke the tokens
        with Intuit so access ends immediately.
      </p>

      <h2>AI drafts. It never trains on your data.</h2>
      <p>
        Nordavix uses Anthropic&apos;s Claude, through their commercial API, to draft
        variance commentary and review notes. Three things are true about that:
      </p>
      <ul>
        <li><strong>No training on your data</strong> — our agreement with Anthropic prohibits it.</li>
        <li><strong>Minimum necessary</strong> — we send only the context a feature needs (an account name, the period balances, the variance), over an encrypted connection.</li>
        <li><strong>No proprietary models on your content</strong> — we use commercial APIs; we don&apos;t train our own models on customer data.</li>
      </ul>
      <p>
        The AI proposes; you decide. Nothing it drafts is posted to your books
        automatically — a person always approves.
      </p>

      <h2>Who can do what — and a record of everything</h2>
      <p>
        Sign-in is handled by Clerk, a dedicated identity provider, with single sign-on
        and multi-factor authentication available. Inside a workspace, every user has a
        role — admin, reviewer, or preparer — and the close is built around{" "}
        <Link to="/blog/maker-checker-accounting-controls" className="text-[var(--green)] underline">
          maker-checker segregation of duties
        </Link>
        : a preparer prepares, and a reviewer or admin signs off. You can&apos;t approve
        your own work, and you can&apos;t close a month while the prior one is still open.
      </p>
      <p>
        Underneath it all is a complete audit trail. Every state-changing action — a
        reconciliation marked prepared, a variance approved, a period closed, a role
        changed — is recorded with who did it and when, and retained to support the kind
        of evidence trail your{" "}
        <Link to="/blog/audit-prep-checklist" className="text-[var(--green)] underline">
          own reviewers and external auditors
        </Link>{" "}
        expect.
      </p>

      <h2>Limits that keep it stable and predictable</h2>
      <p>
        Abuse and runaway cost are security problems too. The API enforces per-workspace
        rate limits, and AI features run under a per-workspace monthly spend cap — so one
        noisy integration or an unexpected loop can&apos;t degrade the service or surprise
        anyone with a bill. Health checks and error monitoring (configured to keep
        personal data out of crash reports) let us catch issues quickly.
      </p>

      <h2>You can leave with everything</h2>
      <p>
        Your data is yours, and you&apos;re never locked in. Export your financial
        package, reconciliations, and schedules to Excel and PDF whenever you want.
        Deleting a workspace starts a <strong>30-day grace window</strong> (so an
        accidental deletion is recoverable), after which all of its data is permanently
        purged — including uploaded files — and the QuickBooks connection is revoked with
        Intuit.
      </p>

      <h2>We don&apos;t ship security regressions</h2>
      <p>
        Security isn&apos;t only about the running system — it&apos;s about how changes
        reach it. Our automated test suite includes the workspace-isolation checks
        described above, and <strong>if any of them fail, the build does not ship.</strong>{" "}
        When we find and fix an issue, we add a permanent test so it can&apos;t quietly
        return. The same pipeline runs accounting-correctness checks — tie-outs, sign
        conventions, schedule math — because a wrong number is its own kind of risk.
      </p>

      <h2>What we haven&apos;t done yet</h2>
      <p>
        A security page is only trustworthy if it tells you what isn&apos;t there. So,
        plainly:
      </p>
      <ul>
        <li><strong>We are not SOC 2 certified yet.</strong> The groundwork is in place — immutable audit logs, access controls, encryption — and SOC 2 Type II is on our roadmap. We won&apos;t display a badge we don&apos;t hold.</li>
        <li><strong>MFA is available, not enforced.</strong> Multi-factor auth is offered through Clerk; we don&apos;t yet require it for an entire workspace.</li>
        <li><strong>Automated dependency scanning</strong> isn&apos;t wired into our pipeline yet (dependencies are reviewed by hand; no production secrets live in our source code).</li>
      </ul>
      <p>
        We&apos;re early, and we&apos;d rather earn your trust with specifics than with
        logos. The full, always-current detail lives on our{" "}
        <Link to="/security" className="text-[var(--green)] underline">
          Security &amp; Trust page
        </Link>
        , and our data practices and your rights are in the{" "}
        <Link to="/privacy" className="text-[var(--green)] underline">
          Privacy Policy
        </Link>
        . If you&apos;ve found something we should fix, email{" "}
        <a href="mailto:security@nordavix.com" className="text-[var(--green)] underline">
          security@nordavix.com
        </a>{" "}
        — we engage in good faith with responsible disclosure.
      </p>
      <p>
        If you want to see all of this in a real workspace,{" "}
        <Link to="/sign-up" className="text-[var(--green)] underline font-semibold">
          start a free Nordavix workspace
        </Link>{" "}
        or read the{" "}
        <Link to="/solutions" className="text-[var(--green)] underline">
          product overview
        </Link>{" "}
        first.
      </p>

      <h2>Questions we get</h2>

      <h3>Is my financial data safe in Nordavix?</h3>
      <p>
        Your data is encrypted in transit (HTTPS/TLS) and at rest (AES-256), your
        QuickBooks tokens get a second layer of application-level encryption, and every
        workspace is isolated behind two independent walls — an automatic query filter and
        database row-level security. You can export everything or permanently delete it at
        any time.
      </p>

      <h3>Can another firm or client see my data in Nordavix?</h3>
      <p>
        No. Nordavix is multi-tenant, and isolation is enforced twice: a session-level
        filter scopes every database read to your workspace and fails closed if the
        context is missing, and PostgreSQL row-level security policies on every workspace
        table make the database itself refuse another workspace&apos;s rows. The exact
        cross-tenant bug we&apos;d most fear is locked shut by an automated test that fails
        our build if it ever reappears.
      </p>

      <h3>Does Nordavix&apos;s AI train on my data?</h3>
      <p>
        No. Nordavix uses Anthropic&apos;s Claude through their commercial API, and our
        agreement prohibits training their models on your data. We send only the minimum
        context a feature needs, and we don&apos;t build our own models on customer
        content.
      </p>

      <h3>Is Nordavix SOC 2 certified?</h3>
      <p>
        Not yet, and we won&apos;t pretend otherwise. We already operate along SOC
        2-aligned lines — encryption, least-privilege access, audit logging, role-based
        access, and vendor data-processing agreements — and pursuing SOC 2 Type II is on
        our roadmap as we grow.
      </p>
    </article>
  )
}
