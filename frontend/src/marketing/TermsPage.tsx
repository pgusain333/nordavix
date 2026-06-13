/**
 * TermsPage — Nordavix Terms of Service.
 *
 * Long-form legal copy specific to this product: B2B SaaS for
 * month-end close, multi-tenant, connects to QuickBooks Online,
 * uses Anthropic's Claude for AI commentary. Terms reflect those
 * realities (no consumer / B2C clauses, explicit AI disclosure,
 * subprocessor table, QBO-specific data clauses, etc.).
 *
 * NOTE: This is a thoughtful template based on common SaaS practices,
 * not a substitute for licensed legal review. Before charging real
 * customers, have a lawyer review and adapt for your jurisdiction
 * and customer mix (consumer states, GDPR, HIPAA, SOC, etc.).
 */
import { FileText } from "lucide-react"
import { LegalLayout, type LegalSection } from "./_legal/LegalLayout"
import { SEO } from "@/marketing/seo/SEO"

const SECTIONS: LegalSection[] = [
  {
    id: "acceptance",
    title: "Acceptance of these Terms",
    body: (
      <>
        <p>
          These Terms of Service (the <strong>"Terms"</strong>) form a binding agreement between
          <strong> Nordavix, Inc.</strong> (<strong>"Nordavix," "we," "us," "our"</strong>) and
          the business entity that registers for an account or otherwise accesses or uses
          the Nordavix platform (<strong>"Customer," "you," "your"</strong>). By creating an
          account, clicking "I agree" (or any equivalent acceptance), or accessing or using
          any part of the Service, you represent that (i) you have authority to bind your
          organization to these Terms, and (ii) your organization agrees to be bound by them.
        </p>
        <p>
          If you do not have that authority, or your organization does not agree, do not
          access or use the Service. Personal use (i.e. as an individual not acting on
          behalf of a business) is outside the scope of these Terms and is not supported.
        </p>
      </>
    ),
  },
  {
    id: "definitions",
    title: "Key definitions",
    body: (
      <>
        <p>For clarity in the rest of this document:</p>
        <ul>
          <li>
            <strong>Service</strong> — the Nordavix software-as-a-service platform, including
            the web application at <code>nordavix.com</code>, related APIs, documentation,
            and any updates we release.
          </li>
          <li>
            <strong>Customer Data</strong> — any data, files, financial records, transaction
            details, attachments, narratives, comments, or other content that you or your
            Users upload to or generate within the Service, including data we pull on your
            behalf from connected third-party systems (e.g. QuickBooks Online).
          </li>
          <li>
            <strong>User</strong> — a natural person you authorize to access the Service on
            your behalf (employees, contractors, advisors). Users are bound by these Terms
            through you.
          </li>
          <li>
            <strong>AI Output</strong> — text, summaries, commentary, or recommendations
            produced by Nordavix's AI models (currently Anthropic's Claude family) using
            Customer Data as input.
          </li>
          <li>
            <strong>Connected System</strong> — any third-party platform you authorize
            Nordavix to read from or write to on your behalf (e.g. QuickBooks Online).
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "the-service",
    title: "What the Service does",
    body: (
      <>
        <p>
          Nordavix is a month-end close automation platform built for accounting teams,
          fractional CFOs, controllers, and CPA firms. The Service currently supports:
        </p>
        <ul>
          <li>
            <strong>Reconciliations</strong> — pulling balance sheet snapshots from QuickBooks
            Online, comparing them to subledger detail, tracking roll-forward / variances,
            attaching supporting evidence, and walking transactions through a maker/checker
            approval workflow.
          </li>
          <li>
            <strong>Flux Analysis</strong> — computing dollar and percent variances on
            trial-balance accounts, identifying material movers using a threshold you set,
            and generating AI commentary that explains drivers using transaction-level evidence.
          </li>
          <li>
            <strong>Financial Statements, Insights, Tasks, Intercompany</strong> — additional
            workflow surfaces that derive from the same close data.
          </li>
        </ul>
        <p>
          We may add, modify, or retire features over time. We will not remove a feature
          you actively rely on without giving reasonable advance notice via in-app message
          or email, except when required for security or legal reasons.
        </p>
      </>
    ),
  },
  {
    id: "accounts",
    title: "Accounts and authentication",
    body: (
      <>
        <p>
          You create an account by signing in through our identity provider (currently
          Clerk). Each User must use credentials issued to them individually; shared
          credentials are not permitted. You are responsible for:
        </p>
        <ul>
          <li>
            Keeping your authentication credentials confidential and using strong
            authentication factors (e.g. SSO with a reputable identity provider).
          </li>
          <li>
            Authorizing only people who genuinely need access — and removing them promptly
            when their role ends.
          </li>
          <li>
            All activity that occurs under your account, whether or not authorized by you.
          </li>
        </ul>
        <p>
          Notify us promptly at <a href="mailto:security@nordavix.com">security@nordavix.com</a>
          if you suspect unauthorized access. We will work with you in good faith to
          investigate and contain the issue, but you remain responsible for the consequences
          of any compromise originating outside our infrastructure (lost passwords, phishing,
          insider misuse, etc.).
        </p>
      </>
    ),
  },
  {
    id: "fees",
    title: "Subscriptions, fees, and billing",
    body: (
      <>
        <p>
          Access to the Service may be free during a beta period or governed by a paid
          subscription. If you subscribe to a paid plan:
        </p>
        <ul>
          <li>
            <strong>Fees</strong> are presented at checkout or in an order form and are
            billed in advance for each billing cycle (monthly or annual).
          </li>
          <li>
            <strong>Auto-renewal</strong> — subscriptions renew automatically at the end of
            each cycle at the then-current rate unless you cancel before the renewal date.
          </li>
          <li>
            <strong>Taxes</strong> — fees do not include sales, use, VAT, GST, or similar
            taxes, which are your responsibility unless we are legally required to collect them.
          </li>
          <li>
            <strong>Refunds</strong> — fees paid are non-refundable except where required
            by law or as expressly stated in your order form.
          </li>
          <li>
            <strong>Failed payments</strong> — if a payment fails and is not cured within
            ten (10) days, we may suspend the Service until the balance is paid.
          </li>
        </ul>
        <p>
          We may change prices at any time with at least thirty (30) days' notice;
          new pricing takes effect at your next renewal.
        </p>
      </>
    ),
  },
  {
    id: "trials",
    title: "Free trials and beta features",
    body: (
      <>
        <p>
          We may offer a free trial, free tier, or early-access ("beta") program. Beta
          features are provided <strong>as-is</strong>, may be incomplete or unstable, and
          may be modified or discontinued without notice. We recommend not running
          mission-critical workflows exclusively on beta features.
        </p>
        <p>
          Feedback you provide on beta features may be used by Nordavix without compensation
          or obligation, subject to the Feedback section below.
        </p>
      </>
    ),
  },
  {
    id: "customer-data",
    title: "Your data",
    body: (
      <>
        <p>
          Customer Data belongs to you. You grant Nordavix a limited, non-exclusive,
          worldwide license to host, process, transmit, display, and otherwise use
          Customer Data solely to (i) provide the Service to you and your Users,
          (ii) maintain and improve the Service (including troubleshooting and security
          monitoring), and (iii) comply with legal obligations.
        </p>
        <p>
          You represent that you have all rights necessary to upload Customer Data and to
          authorize us to read it from Connected Systems. You are responsible for the
          accuracy, legality, and reliability of Customer Data and for ensuring that
          providing it to Nordavix does not violate any obligation to a third party
          (including your own clients, if you are an accounting firm).
        </p>
        <h3>Exports and deletion</h3>
        <p>
          You can export Customer Data from the Service at any time using the in-app
          export controls. On termination, we will retain Customer Data for thirty (30)
          days to allow you to export it, then delete it from active systems within
          ninety (90) days. Backup copies are purged on our standard rotation (no longer
          than 180 days). Audit logs containing references to Customer Data may persist
          longer where required for legal, compliance, or security purposes.
        </p>
      </>
    ),
  },
  {
    id: "acceptable-use",
    title: "Acceptable use",
    body: (
      <>
        <p>You agree not to:</p>
        <ul>
          <li>
            Reverse engineer, decompile, or attempt to derive the source code of the
            Service, except to the extent applicable law prohibits this restriction.
          </li>
          <li>
            Scrape, crawl, or use automation to extract data from the Service outside of
            documented APIs.
          </li>
          <li>
            Resell, sublicense, or commercially redistribute the Service to a third party,
            except where you are a CPA firm or accounting service provider using Nordavix
            to deliver close services to your own clients (which is permitted and expected).
          </li>
          <li>
            Use the Service to store or transmit content that is unlawful, defamatory,
            infringing, malicious (e.g. malware), or designed to interfere with others'
            use of the Service.
          </li>
          <li>
            Probe, scan, or test the Service's vulnerabilities or breach security or
            authentication measures without prior written authorization. (We welcome
            responsible disclosure — see <em>Security</em> in our Privacy Policy.)
          </li>
          <li>
            Use AI Output to make automated decisions that have legal or significant
            effects on individuals without appropriate human review — Nordavix is a tool
            for accountants, not a replacement for professional judgment.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "integrations",
    title: "Third-party integrations",
    body: (
      <>
        <p>
          The Service integrates with third-party platforms — most notably QuickBooks
          Online — to pull and (in limited cases) push data on your behalf. When you
          authorize an integration:
        </p>
        <ul>
          <li>
            You grant Nordavix permission to access the third-party platform using the
            scopes you approved during OAuth.
          </li>
          <li>
            You remain bound by the third party's own terms of service (e.g. Intuit's
            Developer Terms). We are not responsible for changes the third party makes
            to its APIs, pricing, or access policies.
          </li>
          <li>
            We will only request the minimum scope needed to deliver the features you
            use. You can revoke access at any time from the third party's settings.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "ai-commentary",
    title: "AI Output disclaimer",
    body: (
      <>
        <p>
          Nordavix uses large language models (currently Anthropic's Claude) to generate
          variance commentary, AI verification notes, and other narrative content. AI
          Output is:
        </p>
        <ul>
          <li>
            <strong>Probabilistic, not deterministic.</strong> Two runs may produce
            different wording. Some outputs may be inaccurate, incomplete, or stale.
          </li>
          <li>
            <strong>Decision-support, not advice.</strong> AI Output does not constitute
            legal, tax, audit, or investment advice. It is provided to help an accountant
            draft commentary faster — the accountant remains responsible for verifying
            and signing off on the final work product.
          </li>
          <li>
            <strong>Generated using Customer Data.</strong> See our
            <a href="/privacy#ai-processing"> Privacy Policy</a> for details on how AI
            providers handle the data we send them, including the contractual
            no-training commitments we have in place.
          </li>
        </ul>
        <p>
          You are solely responsible for any decisions you, your Users, or your clients
          make based on AI Output. Nordavix disclaims all liability for losses arising
          from reliance on AI Output that was not independently reviewed by a qualified
          professional.
        </p>
      </>
    ),
  },
  {
    id: "ip",
    title: "Intellectual property",
    body: (
      <>
        <p>
          Nordavix owns all right, title, and interest in and to the Service, including
          all underlying software, designs, models, prompts, documentation, and trademarks.
          These Terms do not transfer any IP rights to you except the limited right to use
          the Service in accordance with these Terms during your subscription.
        </p>
        <p>
          You retain all rights in Customer Data. AI Output generated using Customer Data
          is licensed to you on the same terms as Customer Data — i.e. you may use, modify,
          and distribute it as part of your close workpapers and deliverables.
        </p>
      </>
    ),
  },
  {
    id: "feedback",
    title: "Feedback",
    body: (
      <>
        <p>
          If you send us suggestions, ideas, bug reports, or other feedback about the
          Service, you grant us a perpetual, irrevocable, royalty-free, worldwide
          license to use that feedback for any purpose, including improving the Service,
          without any obligation to you. You are not required to provide feedback, but
          we appreciate it.
        </p>
      </>
    ),
  },
  {
    id: "confidentiality",
    title: "Confidentiality",
    body: (
      <>
        <p>
          Each party may receive non-public information of the other party
          (<strong>"Confidential Information"</strong>). The receiving party agrees to
          (i) protect it with the same care it uses for its own confidential information
          (and no less than reasonable care), (ii) use it only to perform under these
          Terms, and (iii) not disclose it to third parties except to its employees,
          contractors, or advisors who have a need to know and are bound by confidentiality
          obligations at least as protective as these.
        </p>
        <p>
          Confidential Information does not include information that is publicly available,
          rightfully known prior to disclosure, independently developed, or rightfully
          obtained from a third party without confidentiality restrictions.
        </p>
      </>
    ),
  },
  {
    id: "term-termination",
    title: "Term and termination",
    body: (
      <>
        <p>
          These Terms remain in effect until terminated. You may cancel your subscription
          and close your account at any time from the in-app settings or by emailing
          <a href="mailto:support@nordavix.com"> support@nordavix.com</a>. Cancellation
          stops auto-renewal but does not entitle you to a refund of fees already paid
          for the current billing cycle.
        </p>
        <p>
          We may suspend or terminate your account if you (i) materially breach these
          Terms and do not cure within ten (10) days of notice, (ii) fail to pay fees
          when due, (iii) engage in activity that creates legal or security risk for
          Nordavix or other customers, or (iv) we reasonably believe we are required
          to do so by law.
        </p>
        <p>
          Sections that by their nature should survive termination — payment obligations,
          Customer Data export rights, IP, confidentiality, disclaimers, limitation of
          liability, indemnification, and miscellaneous — survive.
        </p>
      </>
    ),
  },
  {
    id: "availability",
    title: "Service availability",
    body: (
      <>
        <p>
          We aim for high availability but do not warrant uninterrupted or error-free
          operation. We may take the Service offline for scheduled maintenance, emergency
          repairs, or to comply with legal obligations. Where commercially reasonable, we
          will notify you in advance of scheduled downtime.
        </p>
        <p>
          A formal Service Level Agreement with availability commitments and remedies may
          be offered to enterprise customers on a separate order form.
        </p>
      </>
    ),
  },
  {
    id: "changes",
    title: "Modifications to these Terms",
    body: (
      <>
        <p>
          We may update these Terms from time to time. If we make a material change, we
          will notify you by email or in-app notice at least fourteen (14) days before
          the change takes effect. Your continued use of the Service after the effective
          date constitutes acceptance of the updated Terms. If you do not agree, you may
          cancel your account before the effective date.
        </p>
      </>
    ),
  },
  {
    id: "warranty-disclaimer",
    title: "Disclaimer of warranties",
    body: (
      <>
        <p>
          TO THE MAXIMUM EXTENT PERMITTED BY LAW, THE SERVICE IS PROVIDED <strong>"AS IS"</strong>
          AND <strong>"AS AVAILABLE,"</strong> WITHOUT WARRANTIES OF ANY KIND, WHETHER
          EXPRESS, IMPLIED, OR STATUTORY, INCLUDING WARRANTIES OF MERCHANTABILITY,
          FITNESS FOR A PARTICULAR PURPOSE, TITLE, NON-INFRINGEMENT, OR THAT THE SERVICE
          WILL BE UNINTERRUPTED, SECURE, OR ERROR-FREE.
        </p>
        <p>
          NORDAVIX DOES NOT WARRANT THAT AI OUTPUT, VARIANCE CALCULATIONS, OR OTHER
          DERIVED RESULTS WILL BE ACCURATE OR COMPLETE. THE SERVICE IS A TOOL — YOU AND
          YOUR USERS REMAIN RESPONSIBLE FOR THE ACCURACY OF YOUR FINANCIAL RECORDS AND
          ANY DELIVERABLES YOU PRODUCE USING THE SERVICE.
        </p>
      </>
    ),
  },
  {
    id: "limitation-liability",
    title: "Limitation of liability",
    body: (
      <>
        <p>
          TO THE MAXIMUM EXTENT PERMITTED BY LAW:
        </p>
        <ul>
          <li>
            NEITHER PARTY WILL BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL,
            OR PUNITIVE DAMAGES, OR FOR LOSS OF PROFITS, REVENUES, DATA, BUSINESS, OR
            GOODWILL, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.
          </li>
          <li>
            EACH PARTY'S TOTAL CUMULATIVE LIABILITY ARISING OUT OF OR RELATING TO THESE
            TERMS WILL NOT EXCEED THE AMOUNTS PAID BY CUSTOMER TO NORDAVIX IN THE TWELVE
            (12) MONTHS PRECEDING THE EVENT GIVING RISE TO THE CLAIM, OR ONE HUNDRED US
            DOLLARS ($100), WHICHEVER IS GREATER.
          </li>
        </ul>
        <p>
          These limitations apply to the maximum extent permitted by law, even if a
          remedy fails of its essential purpose. They do not apply to (i) either party's
          payment obligations, (ii) breach of confidentiality, (iii) infringement of the
          other party's intellectual property, or (iv) liability that cannot be limited
          under applicable law (e.g. gross negligence or willful misconduct).
        </p>
      </>
    ),
  },
  {
    id: "indemnification",
    title: "Indemnification",
    body: (
      <>
        <p>
          <strong>You will defend and indemnify</strong> Nordavix, its affiliates, and
          their respective officers, employees, and agents against any third-party claim
          arising from (i) Customer Data, (ii) your or your Users' breach of these Terms,
          (iii) your violation of applicable law, or (iv) your use of AI Output without
          appropriate professional review.
        </p>
        <p>
          <strong>Nordavix will defend and indemnify</strong> you against any third-party
          claim that the Service, as provided by Nordavix and used in accordance with
          these Terms, infringes that third party's intellectual property rights. We will
          not be liable for claims arising from (i) your modifications to the Service,
          (ii) combinations of the Service with non-Nordavix products, or (iii) Customer
          Data or Connected Systems.
        </p>
        <p>
          The indemnifying party's obligations are conditioned on the indemnified party
          (a) promptly notifying the indemnifying party of the claim, (b) tendering
          control of the defense and settlement, and (c) cooperating reasonably at the
          indemnifying party's expense.
        </p>
      </>
    ),
  },
  {
    id: "governing-law",
    title: "Governing law and jurisdiction",
    body: (
      <>
        <p>
          These Terms are governed by the laws of the State of Delaware, USA, without
          regard to its conflict-of-laws principles. The United Nations Convention on
          Contracts for the International Sale of Goods does not apply.
        </p>
        <p>
          Subject to the Dispute Resolution section below, the parties consent to the
          exclusive jurisdiction and venue of the state and federal courts located in
          New Castle County, Delaware for any action that is not subject to arbitration.
        </p>
      </>
    ),
  },
  {
    id: "disputes",
    title: "Dispute resolution",
    body: (
      <>
        <p>
          The parties will attempt in good faith to resolve any dispute through informal
          negotiation, starting with a written notice describing the dispute sent to
          <a href="mailto:legal@nordavix.com"> legal@nordavix.com</a>. If the dispute is
          not resolved within thirty (30) days, either party may initiate binding
          arbitration administered by the American Arbitration Association under its
          Commercial Arbitration Rules, seated in Wilmington, Delaware, before a single
          arbitrator. Judgment on the award may be entered in any court of competent
          jurisdiction.
        </p>
        <p>
          Either party may seek injunctive or equitable relief in a court of competent
          jurisdiction to protect its intellectual property or confidential information
          without first proceeding to arbitration.
        </p>
        <p>
          <strong>Class action waiver.</strong> Disputes must be brought on an individual
          basis only — class, collective, and representative actions are not permitted.
        </p>
      </>
    ),
  },
  {
    id: "miscellaneous",
    title: "Miscellaneous",
    body: (
      <>
        <ul>
          <li>
            <strong>Entire agreement.</strong> These Terms, together with our Privacy
            Policy and any order forms, constitute the entire agreement between the
            parties regarding the Service and supersede all prior discussions.
          </li>
          <li>
            <strong>Severability.</strong> If any provision is held unenforceable, the
            remaining provisions will remain in full force.
          </li>
          <li>
            <strong>No waiver.</strong> Failure to enforce a provision is not a waiver
            of the right to enforce it later.
          </li>
          <li>
            <strong>Assignment.</strong> You may not assign these Terms without our prior
            written consent. We may assign these Terms in connection with a merger,
            acquisition, or sale of substantially all of our assets.
          </li>
          <li>
            <strong>Force majeure.</strong> Neither party is liable for delays or failures
            caused by events beyond its reasonable control (e.g. acts of God, war,
            terrorism, riots, government action, fire, internet or utility outages).
          </li>
          <li>
            <strong>Independent contractors.</strong> The parties are independent
            contractors. These Terms do not create any partnership, agency, or
            employment relationship.
          </li>
          <li>
            <strong>Notices.</strong> Legal notices to Nordavix must be sent to
            <a href="mailto:legal@nordavix.com"> legal@nordavix.com</a>. Notices to you
            will be sent to the email address on file for your account.
          </li>
        </ul>
      </>
    ),
  },
]

export function TermsPage() {
  return (
    <>
    <SEO
      title="Terms of Service"
      description="The Nordavix Terms of Service — the agreement that governs use of the Nordavix month-end close platform."
      path="/terms"
      noindex
    />
    <LegalLayout
      title="Terms of Service"
      subtitle="The rules of the road for using Nordavix. Plain-English summary above each section so you don't have to wade through dense legalese to find what matters."
      effectiveDate="2026-05-26"
      lastUpdated="2026-05-26"
      Icon={FileText}
      related={{ label: "Read the Privacy Policy", to: "/privacy" }}
      summary={
        <>
          You can use Nordavix to run your close workflow. Your data stays yours. We charge
          for paid plans (or it's free during beta). The AI helps you draft commentary —
          a real human still has to review the work. We cap our liability at what you've
          paid us in the last 12 months. Don't do illegal stuff or try to break into the
          system. Disputes go to arbitration in Delaware. The full text below has all the
          specifics — read it before you sign up your firm.
        </>
      }
      sections={SECTIONS}
    />
    </>
  )
}
