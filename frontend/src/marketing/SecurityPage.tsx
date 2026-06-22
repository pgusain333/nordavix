/**
 * SecurityPage — Nordavix Security & Trust.
 *
 * A sales/trust asset (indexable, unlike Terms/Privacy) aimed at the buyer's
 * #1 objection: "can I put my clients' financials in this?" Every claim maps
 * to something the product actually does:
 *   - TLS in transit; AES-256 at-rest (Supabase/R2); app-layer authenticated
 *     encryption (Fernet/AES+HMAC) for QBO OAuth tokens; prod fails closed
 *     without the key (core/security/crypto.py + main.py boot guard).
 *   - Tenant isolation enforced at the ORM/session layer (core/db/session.py
 *     do_orm_execute) + the demo read-only DB guard (before_commit/flush).
 *   - QBO via OAuth, read-only scopes, revoked on disconnect/delete.
 *   - Anthropic API, contractually no training on customer data.
 *   - Clerk auth (SSO/MFA), RBAC + maker/checker, audit log, 30-day purge.
 *
 * Honesty rule: we are NOT SOC 2 certified yet — say so plainly. Overclaiming
 * compliance is both wrong and a fast way to lose an accountant's trust.
 */
import { ShieldCheck } from "lucide-react"
import { LegalLayout, type LegalSection } from "./_legal/LegalLayout"
import { SEO } from "@/marketing/seo/SEO"

const SECTIONS: LegalSection[] = [
  {
    id: "commitment",
    title: "Our commitment",
    body: (
      <>
        <p>
          Nordavix is built by a CPA, for accountants — people trusted with their
          clients' most sensitive financial records. We treat that responsibility as
          the foundation of the product, not a feature we bolted on later.
        </p>
        <p>
          This page describes, in concrete terms, how we protect your data <em>today</em>.
          We'd rather be specific and honest than wave around badges: where something is
          on our roadmap rather than already done, you'll see us say so. For the legal
          detail on what we collect and your rights, see the{" "}
          <a href="/privacy">Privacy Policy</a>. For a plain-English walkthrough of how
          it all fits together, read{" "}
          <a href="/blog/how-nordavix-protects-financial-data">
            How Nordavix protects your clients' financial data
          </a>.
        </p>
      </>
    ),
  },
  {
    id: "encryption",
    title: "Encryption everywhere",
    body: (
      <>
        <p>Your data is encrypted at every stage:</p>
        <ul>
          <li>
            <strong>In transit</strong> — every connection to Nordavix is served over
            HTTPS with TLS 1.2 or higher. Plaintext HTTP is never used.
          </li>
          <li>
            <strong>At rest</strong> — the database and every uploaded file are encrypted
            at rest with AES-256 by our infrastructure providers (Supabase for the
            database, Cloudflare R2 for files).
          </li>
          <li>
            <strong>Application-layer, for the most sensitive secrets</strong> — your
            QuickBooks access tokens get a second, independent layer of{" "}
            <em>authenticated</em> encryption (AES with HMAC) inside our application
            before they're ever written to the database, using a key held only in our
            secrets manager — never in the database itself. The practical result: even a
            leaked database dump contains no usable QuickBooks credentials.
          </li>
        </ul>
        <p>
          That last layer isn't optional. Nordavix <strong>refuses to start in
          production</strong> if the encryption key isn't configured, so tokens can never
          silently fall back to being stored in the clear.
        </p>
      </>
    ),
  },
  {
    id: "isolation",
    title: "Your workspace is walled off — twice",
    body: (
      <>
        <p>
          Nordavix is multi-tenant, so the line that must never be crossed is one firm
          seeing another firm's data. We don't trust a single safeguard with that — we
          built <strong>two independent walls</strong>, so isolation holds even if a piece
          of application code had a bug.
        </p>
        <ul>
          <li>
            <strong>Wall one — automatic query scoping.</strong> A session-level filter
            stamps your workspace's identity onto every database read. A query simply
            cannot return another workspace's rows — and it <em>fails closed</em>: if the
            workspace context is ever missing, the query errors out rather than returning
            anything.
          </li>
          <li>
            <strong>Wall two — the database enforces it too.</strong> On top of that,
            PostgreSQL row-level security policies sit on every one of our workspace
            tables (about 50 of them). Even a query that somehow slipped past the
            application layer is refused by the database itself.
          </li>
          <li>
            <strong>Writes are checked for ownership</strong> — before any bulk update or
            delete, we verify you actually own the records involved.
          </li>
          <li>
            <strong>Read-only surfaces stay read-only</strong> — shared experiences like
            the "sample company" demo are enforced read-only at the database layer: a
            write attempt is refused before it can touch the data, not just hidden in the
            UI.
          </li>
        </ul>
        <p>
          One firm's books can never appear in another firm's workspace. And because this
          is the highest-stakes boundary in the product, the exact bug we'd most fear —
          one tenant's data bleeding into another's — is locked shut by an automated test
          that fails our build if it ever reappears. For CPA firms serving many clients,
          the same boundary keeps each client's data separated.
        </p>
      </>
    ),
  },
  {
    id: "quickbooks",
    title: "QuickBooks: read-only, least privilege",
    body: (
      <>
        <ul>
          <li>
            <strong>OAuth, not passwords</strong> — you connect QuickBooks Online through
            Intuit's official OAuth 2.0 flow. Nordavix never sees or stores your
            QuickBooks username or password.
          </li>
          <li>
            <strong>Only what we need</strong> — we read the specific reports that power
            the close (TrialBalance, GeneralLedger, Profit &amp; Loss, A/R and A/P aging,
            and account metadata). Nothing more.
          </li>
          <li>
            <strong>Encrypted tokens</strong> — the access tokens that let us pull those
            reports are encrypted as described in <a href="#encryption">Encryption</a>.
          </li>
          <li>
            <strong>Revocable anytime</strong> — disconnect from Settings whenever you
            like. On disconnect — and when you delete a workspace — we revoke the tokens
            with Intuit so access ends immediately.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "ai",
    title: "AI never trains on your data",
    body: (
      <>
        <p>
          Nordavix uses Anthropic's Claude models, through their commercial API, to draft
          variance commentary and review notes. We're deliberate about what that means
          for your data:
        </p>
        <ul>
          <li>
            <strong>No training on your data.</strong> Our agreement with Anthropic
            prohibits using your data to train their models.
          </li>
          <li>
            <strong>Minimum necessary.</strong> We send only the context a given feature
            needs — for example, an account name, the period balances, and the variance —
            over an encrypted connection.
          </li>
          <li>
            <strong>We don't build our own models on your data.</strong> Nordavix uses
            commercial APIs; we don't train proprietary models on customer content.
          </li>
        </ul>
        <p>
          The full data flow is documented in the{" "}
          <a href="/privacy#ai-processing">AI Processing</a> section of our Privacy
          Policy, with links to Anthropic's own policies.
        </p>
      </>
    ),
  },
  {
    id: "access",
    title: "Authentication & access control",
    body: (
      <>
        <ul>
          <li>
            <strong>Managed authentication</strong> — sign-in is handled by Clerk, a
            dedicated identity provider, with support for single sign-on (SSO) and
            multi-factor authentication (MFA).
          </li>
          <li>
            <strong>Role-based access</strong> — every user has a role (admin, reviewer,
            or preparer) that governs what they can see and do inside a workspace.
          </li>
          <li>
            <strong>Maker / checker by design</strong> — the close workflow separates
            preparation from approval: a preparer prepares, and a reviewer or admin
            signs off. The segregation of duties auditors look for is built in.
          </li>
          <li>
            <strong>Least-privilege internally</strong> — Nordavix staff access
            production data only when necessary to provide support or investigate an
            incident, under confidentiality obligations.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "audit",
    title: "Every action is logged",
    body: (
      <>
        <p>
          Nordavix keeps a complete audit trail. Every state-changing action — a
          reconciliation marked prepared, a variance approved, a period closed, a role
          changed — is recorded with the user who did it and a timestamp.
        </p>
        <p>
          This is the same evidence trail your own reviewers and external auditors expect,
          available in-app and retained to support a multi-year compliance posture.
        </p>
      </>
    ),
  },
  {
    id: "reliability",
    title: "Reliability & backups",
    body: (
      <>
        <ul>
          <li>
            <strong>Reputable, managed infrastructure</strong> — Nordavix runs on
            Fly.io (application), Supabase (database), Vercel (web), and Cloudflare
            (delivery and file storage).
          </li>
          <li>
            <strong>Encrypted backups</strong> — the database is backed up automatically
            on a managed rotation, encrypted at rest.
          </li>
          <li>
            <strong>Abuse &amp; cost protection</strong> — the API enforces per-workspace
            rate limits, and AI features run under a per-workspace monthly spend cap, so
            the service stays stable and costs stay predictable — no single integration or
            runaway loop can degrade it.
          </li>
          <li>
            <strong>Monitoring</strong> — health checks and error monitoring let us catch
            and respond to issues quickly.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "ownership",
    title: "You own your data — export and deletion",
    body: (
      <>
        <p>
          Your data is yours, and you're never locked in:
        </p>
        <ul>
          <li>
            <strong>Export anytime</strong> — download your financial package,
            reconciliations, and schedules to Excel and PDF whenever you want.
          </li>
          <li>
            <strong>Delete on your terms</strong> — deleting a workspace from Settings
            starts a 30-day grace window (so an accidental deletion is recoverable),
            after which all of its data is permanently purged — including uploaded files
            — and the QuickBooks connection is revoked with Intuit.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "subprocessors",
    title: "Subprocessors",
    body: (
      <>
        <p>
          We rely on a small set of vetted infrastructure providers, each bound by a
          Data Processing Agreement and restricted to processing data on our behalf:
        </p>
        <table>
          <thead>
            <tr>
              <th>Provider</th>
              <th>Purpose</th>
              <th>Region</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>Anthropic</td><td>AI commentary generation (Claude API)</td><td>USA</td></tr>
            <tr><td>Clerk</td><td>Authentication, user management, OAuth flows</td><td>USA</td></tr>
            <tr><td>Supabase</td><td>Managed PostgreSQL database</td><td>USA</td></tr>
            <tr><td>Cloudflare R2</td><td>Object storage for uploaded files / evidence</td><td>Global edge</td></tr>
            <tr><td>Fly.io</td><td>Backend application hosting</td><td>USA (primary)</td></tr>
            <tr><td>Vercel</td><td>Frontend hosting and CDN</td><td>Global edge</td></tr>
            <tr><td>Intuit (QuickBooks Online)</td><td>Source of accounting data, when you connect QBO</td><td>USA</td></tr>
          </tbody>
        </table>
        <p>
          The canonical, up-to-date list lives in our{" "}
          <a href="/privacy#sharing-and-subprocessors">Privacy Policy</a>. Material
          changes are announced in advance where commercially reasonable.
        </p>
      </>
    ),
  },
  {
    id: "development",
    title: "How we build and ship",
    body: (
      <>
        <p>
          Security isn't only about the running system — it's about how changes reach it.
        </p>
        <ul>
          <li>
            <strong>Security tests gate every release.</strong> Our automated test suite
            includes the workspace-isolation checks described above. If any of them fail,
            the build does not ship — full stop.
          </li>
          <li>
            <strong>Fixed issues stay fixed.</strong> When we find and fix a security or
            correctness issue, we add a permanent test that re-checks it on every build,
            so it can't quietly come back.
          </li>
          <li>
            <strong>Accuracy is tested too.</strong> The same pipeline runs
            accounting-correctness checks — tie-outs, sign conventions, schedule math —
            because a wrong number is its own kind of risk.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "compliance",
    title: "Compliance & roadmap",
    body: (
      <>
        <p>
          We want to be straight with you about where we are:
        </p>
        <ul>
          <li>
            <strong>SOC 2 — on our roadmap, not yet certified.</strong> We are not
            currently SOC 2 certified. We already operate along SOC 2-aligned lines —
            encryption, least-privilege access, audit logging, role-based access, and
            vendor DPAs — and pursuing SOC 2 Type II is on our roadmap as we grow.
          </li>
          <li>
            <strong>GDPR &amp; CCPA</strong> — our data practices, legal bases, and your
            rights are covered in the <a href="/privacy">Privacy Policy</a>.
          </li>
          <li>
            <strong>Data Processing Agreement</strong> — a DPA is available to customers
            on request; email <a href="mailto:legal@nordavix.com">legal@nordavix.com</a>.
          </li>
          <li>
            <strong>Internal security reviews</strong> — we routinely review our own
            codebase for security issues and harden as we find them.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "disclosure",
    title: "Report a vulnerability",
    body: (
      <>
        <p>
          No system is perfectly secure, and we welcome help making ours better. If you
          believe you've found a vulnerability, email{" "}
          <a href="mailto:security@nordavix.com">security@nordavix.com</a> with a
          description and steps to reproduce.
        </p>
        <p>
          We commit to good-faith engagement with responsible disclosure. We won't pursue
          legal action against researchers who act in good faith, respect user privacy,
          and avoid degrading the service.
        </p>
      </>
    ),
  },
]

export function SecurityPage() {
  return (
    <>
    <SEO
      title="Security & Trust"
      description="How Nordavix protects client financial data: encryption in transit and at rest, workspace isolation, read-only QuickBooks access, no AI training on your data."
      path="/security"
    />
    <LegalLayout
      title="Security & Trust"
      subtitle="You're trusted with your clients' books. Here's exactly how we protect that data — in plain terms, with no overclaiming."
      effectiveDate="2026-06-02"
      lastUpdated="2026-06-02"
      Icon={ShieldCheck}
      related={{ label: "Read the Privacy Policy", to: "/privacy" }}
      summary={
        <>
          Your clients' financials deserve careful handling. Nordavix encrypts your data
          in transit and at rest, isolates every workspace at the database layer,
          connects to QuickBooks read-only over OAuth (we never see your QuickBooks
          password), and never lets AI train on your data. You can export or permanently
          delete everything at any time. We're not SOC 2 certified yet — it's on our
          roadmap — and this page tells you exactly what we do today.
        </>
      }
      sections={SECTIONS}
    />
    </>
  )
}
