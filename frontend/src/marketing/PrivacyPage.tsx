/**
 * PrivacyPage — Nordavix Privacy Policy.
 *
 * Built around the actual data flows of the product: QuickBooks Online
 * pulls (trial balance, GL, P&L), Anthropic Claude for AI commentary,
 * Clerk for auth, Supabase Postgres for storage, Cloudflare R2 for
 * files, Fly.io for backend, Vercel for frontend. Subprocessor table
 * lists each provider explicitly so customers (especially CPA firms
 * with their own clients) can answer due-diligence questions.
 *
 * Covers GDPR + CCPA basics. As with Terms, this is a thoughtful
 * template, not a substitute for licensed privacy counsel.
 */
import { ShieldCheck } from "lucide-react"
import { LegalLayout, type LegalSection } from "./_legal/LegalLayout"

const SECTIONS: LegalSection[] = [
  {
    id: "overview",
    title: "Overview and scope",
    body: (
      <>
        <p>
          This Privacy Policy explains how <strong>Nordavix, Inc.</strong>
          (<strong>"Nordavix," "we," "us," "our"</strong>) collects, uses, shares, and
          protects personal information when you visit our marketing website at
          <code> nordavix.com</code>, use the Nordavix platform (the <strong>"Service"</strong>),
          or otherwise interact with us.
        </p>
        <p>
          Nordavix is a B2B platform sold to businesses (typically CPA firms, fractional
          CFO firms, controllers, and finance teams). In most cases, our customer (the
          business that subscribes) is the <strong>data controller</strong> for the personal
          information stored in their workspace, and Nordavix acts as a
          <strong> data processor</strong> on the customer's behalf, governed by these terms
          and any Data Processing Addendum we have signed with them.
        </p>
        <p>
          When the personal information at issue is about <strong>you</strong> as an
          end-user (e.g. your account email, your IP address when you sign in), Nordavix
          acts as the controller. This Policy describes both roles where they differ.
        </p>
      </>
    ),
  },
  {
    id: "information-we-collect",
    title: "Information we collect",
    body: (
      <>
        <h3>You provide directly</h3>
        <ul>
          <li>
            <strong>Account information</strong> — name, email, organization name, role
            (admin, reviewer, preparer), profile photo. Collected through our identity
            provider (Clerk) when you sign up or are invited by an existing customer.
          </li>
          <li>
            <strong>Workspace content</strong> — trial balances you upload, reconciling
            items you enter, narratives you write, files you attach as evidence,
            comments, due dates, task assignments.
          </li>
          <li>
            <strong>Communications</strong> — support emails, feedback you send via the
            in-app feedback dialog, sales inquiries.
          </li>
          <li>
            <strong>Payment information</strong> — handled by our payment processor; we
            do not store full card numbers on our infrastructure.
          </li>
        </ul>
        <h3>We pull from systems you connect</h3>
        <ul>
          <li>
            <strong>QuickBooks Online</strong> — when you authorize the integration, we
            read the reports needed to power Reconciliations and Flux: TrialBalance,
            GeneralLedger, ProfitAndLoss, AgedReceivables, AgedPayables, plus account
            metadata. We use the minimum scope required for the features you use.
          </li>
        </ul>
        <h3>We collect automatically</h3>
        <ul>
          <li>
            <strong>Usage data</strong> — pages visited, features used, in-app actions
            (e.g. "user X approved variance Y on TB Z"), timestamps. We use this to operate
            the audit log, troubleshoot issues, and improve the product.
          </li>
          <li>
            <strong>Device and log data</strong> — IP address, browser type and version,
            operating system, referring URL, error logs.
          </li>
          <li>
            <strong>Cookies and similar technologies</strong> — see the
            <a href="#cookies"> Cookies</a> section below.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "how-we-use",
    title: "How we use information",
    body: (
      <>
        <p>We use the information described above to:</p>
        <ul>
          <li>
            <strong>Provide the Service</strong> — render dashboards, compute variances,
            generate AI commentary, pull QBO data, track approvals, store evidence,
            manage subscriptions.
          </li>
          <li>
            <strong>Maintain security and integrity</strong> — detect and prevent fraud,
            abuse, unauthorized access; investigate incidents; comply with the
            maker/checker audit trail built into the product.
          </li>
          <li>
            <strong>Communicate with you</strong> — service announcements, security
            notices, billing receipts, support replies. Marketing emails are sent only
            with your opt-in and include an unsubscribe link.
          </li>
          <li>
            <strong>Improve the product</strong> — analyze aggregate usage to understand
            which features need work. We don't train AI models on your data — see the
            <a href="#ai-processing"> AI Processing</a> section.
          </li>
          <li>
            <strong>Comply with law</strong> — respond to lawful requests, enforce our
            Terms, protect the rights and safety of users and the public.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "legal-bases",
    title: "Legal bases (GDPR)",
    body: (
      <>
        <p>
          If you are in the European Economic Area, the United Kingdom, or another region
          with similar privacy laws, our legal bases for processing your personal
          information are:
        </p>
        <ul>
          <li>
            <strong>Contract</strong> — we need to process your data to provide the
            Service you (or your employer) subscribed to.
          </li>
          <li>
            <strong>Legitimate interests</strong> — operating, improving, securing the
            Service; running our business. Where we rely on this basis we have considered
            and balanced against your rights.
          </li>
          <li>
            <strong>Consent</strong> — where required, e.g. for non-essential cookies or
            marketing emails. You can withdraw consent at any time without affecting the
            lawfulness of processing before withdrawal.
          </li>
          <li>
            <strong>Legal obligation</strong> — to comply with applicable laws.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "ai-processing",
    title: "AI processing",
    body: (
      <>
        <p>
          Nordavix uses large language models — currently Anthropic's Claude family — to
          generate variance commentary, AI verification notes, and other narrative content.
          Here's exactly what happens when you click a feature that uses AI:
        </p>
        <ol>
          <li>
            We assemble a prompt containing the relevant Customer Data — for example, an
            account name, period balances, dollar variance, percent variance, anomaly
            flags, and (when you've pulled them) the top transactions driving the
            variance.
          </li>
          <li>
            We send the prompt to Anthropic's API over an encrypted connection.
          </li>
          <li>
            Anthropic returns generated text, which we save as the commentary on that
            variance line.
          </li>
        </ol>
        <p>
          <strong>Our agreement with Anthropic prohibits using your data to train their
          models.</strong> Anthropic's data handling for API customers is described in
          their <a href="https://www.anthropic.com/legal/aup" target="_blank" rel="noreferrer">
          usage policy</a> and <a href="https://www.anthropic.com/legal/privacy" target="_blank" rel="noreferrer">
          privacy policy</a>. Anthropic retains API request/response data for a limited
          period for safety and abuse-prevention purposes.
        </p>
        <p>
          We do not send Customer Data to AI providers other than as needed to power
          features you use. We do not use Customer Data to train Nordavix's own models
          (we don't train models — we use commercial APIs).
        </p>
      </>
    ),
  },
  {
    id: "sharing-and-subprocessors",
    title: "How we share information",
    body: (
      <>
        <p>
          Nordavix does not sell personal information. We share information only as
          described below.
        </p>
        <h3>Subprocessors</h3>
        <p>
          We rely on a small set of vetted infrastructure providers to operate the Service.
          Each is bound by a Data Processing Agreement and is restricted to processing
          data on our behalf for the purposes listed:
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
            <tr><td>Intuit (QuickBooks Online)</td><td>Source of accounting data, when you connect your QBO account</td><td>USA</td></tr>
          </tbody>
        </table>
        <p>
          We may update this list as we change vendors. Material changes will be
          announced via the Service or by email at least thirty (30) days in advance,
          where commercially reasonable.
        </p>
        <h3>Other sharing</h3>
        <ul>
          <li>
            <strong>Within your organization</strong> — your workspace content is visible
            to other Users in your workspace based on their role.
          </li>
          <li>
            <strong>Legal compliance</strong> — to comply with valid legal process
            (subpoenas, court orders), or where we have a good-faith belief that
            disclosure is necessary to protect rights, property, or safety.
          </li>
          <li>
            <strong>Business transfers</strong> — in connection with a merger,
            acquisition, financing, or sale of all or part of our business. We will
            notify you of any such change in ownership or control.
          </li>
          <li>
            <strong>With your consent</strong> — any other sharing not described above
            will only happen with your direction or consent.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "international-transfers",
    title: "International data transfers",
    body: (
      <>
        <p>
          Nordavix is based in the United States, and most of our subprocessors are too.
          If you are located outside the U.S., your data will be transferred to and
          processed in the U.S. and other jurisdictions where our subprocessors operate.
        </p>
        <p>
          For transfers from the European Economic Area, the United Kingdom, or
          Switzerland, we rely on the European Commission's Standard Contractual Clauses
          (and the UK Addendum where applicable) with each subprocessor that requires
          them. Copies of relevant clauses can be requested at
          <a href="mailto:privacy@nordavix.com"> privacy@nordavix.com</a>.
        </p>
      </>
    ),
  },
  {
    id: "retention",
    title: "Data retention",
    body: (
      <>
        <p>
          We retain personal information for as long as needed to provide the Service,
          comply with legal obligations, resolve disputes, and enforce agreements. In
          practice:
        </p>
        <ul>
          <li>
            <strong>Account data</strong> — kept while your account is active. Deleted
            within ninety (90) days of account closure.
          </li>
          <li>
            <strong>Workspace content (Customer Data)</strong> — kept while you subscribe;
            on termination we retain it for thirty (30) days to allow you to export, then
            delete within ninety (90) days of that grace period ending. Backups purge on
            our standard rotation (no longer than 180 days).
          </li>
          <li>
            <strong>Audit logs</strong> — retained for up to seven (7) years to support
            the maker/checker compliance posture our customers expect. Audit log entries
            include references to actions but not full copies of the data acted upon.
          </li>
          <li>
            <strong>Marketing list</strong> — kept until you unsubscribe.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "security",
    title: "Security",
    body: (
      <>
        <p>
          We use technical and organizational measures designed to protect personal
          information, including:
        </p>
        <ul>
          <li>
            <strong>Encryption</strong> — TLS 1.2+ for data in transit; AES-256 at rest
            for the database and object storage.
          </li>
          <li>
            <strong>Tenant isolation</strong> — every row in our application database is
            scoped to a tenant ID enforced at the ORM layer; cross-tenant reads are
            blocked by a session-level filter listener.
          </li>
          <li>
            <strong>Authentication</strong> — handled by Clerk; supports SSO and MFA.
          </li>
          <li>
            <strong>Access control</strong> — role-based access within the product
            (admin / reviewer / preparer). Nordavix employees access production data only
            when necessary to provide support or investigate incidents, subject to
            confidentiality obligations.
          </li>
          <li>
            <strong>Audit logging</strong> — every state-changing action in the product
            writes an audit log entry tying the action to a user and a timestamp.
          </li>
          <li>
            <strong>Backups</strong> — automatic, encrypted, periodically tested.
          </li>
        </ul>
        <p>
          No system is perfectly secure. If you believe you've found a vulnerability,
          please email <a href="mailto:security@nordavix.com">security@nordavix.com</a>
          with a description and steps to reproduce. We commit to good-faith engagement
          with responsible disclosure.
        </p>
      </>
    ),
  },
  {
    id: "your-rights",
    title: "Your rights",
    body: (
      <>
        <p>
          Depending on where you live, you may have the following rights regarding your
          personal information. Most are available through the in-app settings or by
          emailing <a href="mailto:privacy@nordavix.com">privacy@nordavix.com</a>:
        </p>
        <ul>
          <li><strong>Access</strong> — request a copy of the personal information we hold about you.</li>
          <li><strong>Rectification</strong> — correct inaccurate information.</li>
          <li><strong>Erasure</strong> — delete personal information, subject to legal exceptions.</li>
          <li><strong>Portability</strong> — receive your data in a structured, machine-readable format.</li>
          <li><strong>Restriction or objection</strong> — limit how we process your data, or object to processing based on legitimate interests.</li>
          <li><strong>Withdraw consent</strong> — for any processing that relies on consent (e.g. marketing emails).</li>
          <li><strong>Complain to a regulator</strong> — if you're in the EEA or UK, you may lodge a complaint with your local supervisory authority.</li>
        </ul>
        <p>
          We will respond to verifiable requests within the timeframe required by
          applicable law (typically thirty (30) days). If your data sits in a workspace
          controlled by a Nordavix customer (your employer or accounting firm), we may
          direct you to that customer to handle the request, and assist them as
          appropriate.
        </p>
      </>
    ),
  },
  {
    id: "ccpa",
    title: "California privacy notice",
    body: (
      <>
        <p>
          For California residents, the California Consumer Privacy Act (as amended by
          the CPRA) provides the rights described above plus the following clarifications:
        </p>
        <ul>
          <li>
            <strong>Categories of personal information collected.</strong> Identifiers
            (name, email, IP), commercial information (subscription history), internet or
            other electronic activity (usage logs), professional information (organization,
            role), and inferences drawn from the foregoing. Customer Data uploaded by your
            employer may include additional categories.
          </li>
          <li>
            <strong>Sources.</strong> Directly from you, from your organization, from
            systems you connect, and automatically as you use the Service.
          </li>
          <li>
            <strong>Purposes.</strong> Operating the Service, security, support,
            compliance, communications, product improvement.
          </li>
          <li>
            <strong>Sale or sharing.</strong> Nordavix does not sell personal information
            and does not share it for cross-context behavioral advertising.
          </li>
          <li>
            <strong>Non-discrimination.</strong> We will not deny service or charge a
            different price because you exercised a privacy right.
          </li>
        </ul>
        <p>
          To exercise California rights, email
          <a href="mailto:privacy@nordavix.com"> privacy@nordavix.com</a>. We will verify
          your identity using information already associated with your account.
        </p>
      </>
    ),
  },
  {
    id: "children",
    title: "Children's privacy",
    body: (
      <>
        <p>
          Nordavix is a B2B tool intended only for business use by adults. The Service
          is not directed to children under 16, and we do not knowingly collect personal
          information from anyone under 16. If you believe a child has provided us with
          personal information, please contact
          <a href="mailto:privacy@nordavix.com"> privacy@nordavix.com</a> and we will
          delete it.
        </p>
      </>
    ),
  },
  {
    id: "cookies",
    title: "Cookies and similar technologies",
    body: (
      <>
        <p>
          We use a small number of cookies and similar technologies, kept to the minimum
          needed to operate the Service:
        </p>
        <ul>
          <li>
            <strong>Strictly necessary</strong> — authentication, session continuity, CSRF
            protection. These are required for the Service to function and cannot be turned
            off.
          </li>
          <li>
            <strong>Functional</strong> — remembering your theme preference (light/dark),
            active workspace, sidebar collapsed state.
          </li>
          <li>
            <strong>Analytics</strong> — aggregate usage measurement (page views, error
            rates). We currently do not use third-party advertising trackers.
          </li>
        </ul>
        <p>
          You can control cookies through your browser. Blocking strictly necessary
          cookies will break login.
        </p>
      </>
    ),
  },
  {
    id: "third-parties",
    title: "Third-party services and links",
    body: (
      <>
        <p>
          The Service contains links to third-party websites and integrates with
          third-party platforms (e.g. QuickBooks Online). Those parties have their own
          privacy practices and we encourage you to review them. Nordavix is not
          responsible for the privacy practices of third parties.
        </p>
        <p>
          When you authorize an integration, the third party may continue to process your
          data under its own terms even after you stop using Nordavix.
        </p>
      </>
    ),
  },
  {
    id: "changes",
    title: "Changes to this Policy",
    body: (
      <>
        <p>
          We may update this Privacy Policy from time to time. The "Last updated" date
          at the top reflects the most recent revision. For material changes — for
          example, adding a new category of data we collect, a new purpose, or a new
          subprocessor that processes sensitive data — we will notify you via in-app
          banner or email at least fourteen (14) days before the change takes effect.
        </p>
      </>
    ),
  },
  {
    id: "contact",
    title: "Contact us",
    body: (
      <>
        <p>
          For questions about this Privacy Policy, or to exercise any of your rights:
        </p>
        <ul>
          <li>Email: <a href="mailto:privacy@nordavix.com">privacy@nordavix.com</a></li>
          <li>Security disclosures: <a href="mailto:security@nordavix.com">security@nordavix.com</a></li>
          <li>Legal notices: <a href="mailto:legal@nordavix.com">legal@nordavix.com</a></li>
        </ul>
        <p>
          If you are in the EEA or UK and prefer to contact a representative, please
          email <a href="mailto:privacy@nordavix.com">privacy@nordavix.com</a> and we
          will direct you appropriately.
        </p>
      </>
    ),
  },
]

export function PrivacyPage() {
  return (
    <LegalLayout
      title="Privacy Policy"
      subtitle="Exactly what we collect, why we collect it, who else touches it, and the controls you have. No dark patterns, no surprise data sharing."
      effectiveDate="2026-05-26"
      lastUpdated="2026-05-26"
      Icon={ShieldCheck}
      related={{ label: "Read the Terms of Service", to: "/terms" }}
      summary={
        <>
          Your data stays yours. We pull from QuickBooks only what's needed to run your
          close, send relevant snippets to Anthropic's Claude to draft commentary
          (Anthropic contractually can't train on it), and store everything in a
          tenant-isolated database in the US. We don't sell your data, don't run ad
          trackers, and use the smallest set of subprocessors we can — listed by name
          in section 6. You have full rights to export and delete your data at any time.
        </>
      }
      sections={SECTIONS}
    />
  )
}
