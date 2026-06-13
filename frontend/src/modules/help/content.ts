/**
 * Nordavix Help content — single source of truth.
 *
 * Rendered in TWO places:
 *   • In-app at /app/help (HelpPage)
 *   • Public marketing site at /help (PublicHelpPage)
 *
 * Both surfaces use the same renderer (HelpContent.tsx) — they just
 * differ in the page chrome around it.
 *
 * Content is structured (not raw markdown) so:
 *   • The TOC builds itself from the section list
 *   • Active-section highlighting works without parsing
 *   • Callouts / steps / tables get consistent styling
 *   • New section types (videos, demos) can plug in later
 *
 * Editing rules:
 *   • Section + subsection IDs are URL anchors — don't rename without
 *     planning redirects.
 *   • Step numbers are zero-indexed in code, 1-indexed in display.
 *   • Keep tone direct, second-person ("you"), no jargon without
 *     a glossary entry. Audience = CPA / controller / preparer with
 *     no prior Nordavix experience.
 */

// ── Block types ─────────────────────────────────────────────────────────────

/**
 * Each subsection is a sequence of blocks. The renderer maps a block
 * `kind` to a styled component. Add new block kinds here.
 */
export type Block =
  | { kind: "p"; text: string }
  | { kind: "steps"; items: string[] }
  | { kind: "bullets"; items: string[] }
  | { kind: "callout"; tone: "info" | "tip" | "warning" | "important"; title?: string; text: string }
  | { kind: "table"; columns: string[]; rows: string[][] }
  | { kind: "code"; language?: string; text: string }

export interface SubSection {
  id:     string
  title:  string
  blocks: Block[]
}

export interface Section {
  id:           string
  number:       string   // "1", "2" — displayed in the TOC
  title:        string
  summary:      string   // one-line description for the TOC tooltip
  subSections:  SubSection[]
}

// ── Sections ────────────────────────────────────────────────────────────────

export const HELP_SECTIONS: Section[] = [
  // ── 1. Overview ─────────────────────────────────────────────────────────
  {
    id: "overview",
    number: "1",
    title: "Welcome to Nordavix",
    summary: "What Nordavix does + who it's for",
    subSections: [
      {
        id: "what-is-nordavix",
        title: "What Nordavix is",
        blocks: [
          { kind: "p", text:
            "Nordavix is an AI-powered month-end close platform for CPA firms, controllers, " +
            "and fractional CFOs. It pulls balances and transactions directly from " +
            "QuickBooks Online, runs reconciliations and flux analysis, generates " +
            "AI commentary on every material movement, and produces audit-ready " +
            "PDF deliverables — all in one workspace per client company.",
          },
          { kind: "p", text:
            "Think of it as the workpaper layer that sits above QuickBooks: QBO is " +
            "the source of truth for the data; Nordavix is where you review it, " +
            "tick and tie it, document it, and sign off on it.",
          },
          { kind: "callout", tone: "info", title: "Read order",
            text: "If you're brand new, follow sections 2 through 7 in order — they " +
                  "track the actual workflow from first sign-up through a closed month. " +
                  "Sections 8–13 are reference material you'll dip into as needed.",
          },
        ],
      },
      {
        id: "core-modules",
        title: "The core modules",
        blocks: [
          { kind: "p", text:
            "Every closeable workspace gives you these modules. They share data " +
            "(reconciliations feed the financial statements, flux analysis feeds " +
            "the executive report) so you do each task once.",
          },
          { kind: "table",
            columns: ["Module", "What it's for", "Who uses it"],
            rows: [
              ["Dashboard",         "Single pane of glass for the close — progress card, recon counts, flux summary, exec report button", "Everyone"],
              ["Reconciliations",   "Tick-and-tie every balance-sheet account; capture subledger composition; attach evidence",          "Preparer + Reviewer"],
              ["Flux Analysis",     "Variance analysis between current and prior period; AI explains material movements",                 "Preparer + Reviewer"],
              ["Intercompany",      "Surfaces IC accounts and auto-suggests counterparty pairs",                                          "Reviewer + Admin"],
              ["Financial Statements", "Income Statement, Balance Sheet, Cash Flow + audit-ready PDF",                                    "Reviewer + Admin"],
              ["Insights",          "Liquidity, profitability, AR/AP, expense monitor — KPI dashboards with trends",                      "Reviewer + Admin"],
              ["Executive Report",  "AI-narrated 10+ page board deliverable (closed periods only)",                                       "Admin"],
            ],
          },
        ],
      },
    ],
  },

  // ── 2. Getting Started ──────────────────────────────────────────────────
  {
    id: "getting-started",
    number: "2",
    title: "Getting started",
    summary: "Sign-up through first reconciliation — in order",
    subSections: [
      {
        id: "sign-up",
        title: "Sign up + create your workspace",
        blocks: [
          { kind: "steps", items: [
            "Go to nordavix.com and click \"Sign in\" (top right). New users will be routed to the sign-up flow automatically.",
            "Choose Google SSO (one click) or email + password. Email signups receive a verification link.",
            "Enter your first and last name when prompted. This name appears on every PDF deliverable as preparer/approver attribution, so use your professional name.",
            "Pick a workspace name. Each workspace = one client company. CPA firms running multiple clients create one workspace per client.",
            "You land on the Dashboard with the setup checklist visible.",
          ] },
          { kind: "callout", tone: "tip",
            text: "Working on multiple companies? Create one workspace per company from " +
                  "Settings → Workspaces (or click the workspace name in the sidebar → Switch company). " +
                  "Each is fully isolated — data never leaks across workspaces.",
          },
        ],
      },
      {
        id: "connect-quickbooks",
        title: "Connect QuickBooks Online",
        blocks: [
          { kind: "p", text:
            "Nordavix is read-only against QuickBooks. We never write back. " +
            "The connection uses OAuth (Intuit's standard) and requires admin role on the QBO company.",
          },
          { kind: "steps", items: [
            "From the Dashboard, click \"Connect QuickBooks\" on the setup checklist (or go to Connections in the sidebar).",
            "You're redirected to Intuit's authorization page. Sign in with your QBO credentials.",
            "Pick the company you want to connect from Intuit's company picker.",
            "Click \"Connect\" — you're redirected back to Nordavix. The Connections page shows the connected company name and timestamp.",
          ] },
          { kind: "callout", tone: "warning",
            text: "Only admins can connect QuickBooks. Preparers and reviewers see the " +
                  "Connections page but can't initiate the OAuth flow. " +
                  "If you're a preparer, ask your admin to connect.",
          },
        ],
      },
      {
        id: "books-setup",
        title: "Set your books start date + opening balances",
        blocks: [
          { kind: "p", text:
            "Nordavix uses a strict close-and-roll-forward model: each month's opening " +
            "balances come from the prior month's reconciled subledger. To start the chain, " +
            "you tell us the date your books begin in our system, and we seed opening " +
            "balances from QBO as of the day before.",
          },
          { kind: "steps", items: [
            "From the setup checklist, click \"Set books start date + opening balances\".",
            "Pick your books start date (the first month you'll close in Nordavix). For most teams this is the first day of the current quarter or the start of the fiscal year.",
            "Review the seeded opening balances — Nordavix pulls every balance-sheet account from QBO as of (start − 1 day) and shows you the proposed openings. Edit any that look off.",
            "Click \"Seed openings\". The dashboard's Month-end close tracker now lights up from your start date forward.",
          ] },
          { kind: "callout", tone: "important",
            text: "You only do this once. After that, every subsequent month's opening = " +
                  "the prior month's signed-off subledger value. The chain enforces that " +
                  "months close in order — you can't skip a month.",
          },
        ],
      },
      {
        id: "invite-team",
        title: "Invite your team",
        blocks: [
          { kind: "p", text:
            "Nordavix supports three roles. They map cleanly to the maker/checker " +
            "discipline finance teams already use:",
          },
          { kind: "table",
            columns: ["Role", "What they can do", "Typical user"],
            rows: [
              ["Admin",    "Everything: invite users, connect QBO, set books, close + reopen periods, override approvals", "Firm partner, in-house controller"],
              ["Reviewer", "Approve reconciliations + flux analyses, sign off TBs", "Senior accountant, manager"],
              ["Preparer", "Pull data, mark prepared, attach evidence — but can't approve their own work", "Staff accountant, bookkeeper"],
            ],
          },
          { kind: "steps", items: [
            "Open the sidebar → Team (admin only).",
            "Click \"Invite\", enter the person's email, pick a role, and send.",
            "They receive an invite email from Nordavix. After they accept and sign in, they appear in the workspace with the role you assigned.",
          ] },
          { kind: "callout", tone: "tip",
            text: "You can change a user's role any time from the Team page. Maker/checker " +
                  "is enforced at the action level — even an admin can't approve their own " +
                  "manual subledger entry without overriding the gate explicitly.",
          },
        ],
      },
    ],
  },

  // ── 3. Roles & Permissions ──────────────────────────────────────────────
  {
    id: "roles",
    number: "3",
    title: "Roles & permissions",
    summary: "Maker/checker, approval gates, sequential close",
    subSections: [
      {
        id: "role-matrix",
        title: "The full role matrix",
        blocks: [
          { kind: "p", text:
            "Every action in the app has a clear role gate. If you don't see a button you " +
            "think you should, check this table.",
          },
          { kind: "table",
            columns: ["Action", "Admin", "Reviewer", "Preparer"],
            rows: [
              ["Connect QuickBooks",                  "Yes", "No",  "No"],
              ["Set books start date",                "Yes", "No",  "No"],
              ["Invite + manage team",                "Yes", "No",  "No"],
              ["Sync from QuickBooks",                "Yes", "Yes", "Yes"],
              ["Run Agentic Mode (AI)",               "Yes", "Yes", "Yes"],
              ["Per-row Agentic on a single item",    "Yes", "Yes", "Yes"],
              ["Enter manual subledger override",     "Yes", "Yes", "Yes"],
              ["Mark account as Prepared",            "Yes", "Yes", "Yes"],
              ["Approve account",                     "Yes", "Yes", "No"],
              ["Flag account for follow-up",          "Yes", "Yes", "No"],
              ["Reset account to Pending",            "Yes", "Yes", "Yes"],
              ["Sign off a flux analysis",            "Yes", "Yes", "No"],
              ["Close month-end books",               "Yes", "No",  "No"],
              ["Reopen closed books",                 "Yes", "No",  "No"],
              ["Generate Executive Report",           "Yes", "Yes", "Yes"],
            ],
          },
        ],
      },
      {
        id: "maker-checker",
        title: "Maker / checker rule",
        blocks: [
          { kind: "p", text:
            "A user cannot approve their own manual subledger entry — the approval has " +
            "to come from a different user. This is a hard rule that protects the audit " +
            "trail. Admins can override it on a per-action basis when the situation demands " +
            "(e.g., a solo bookkeeper), but the override is logged in the audit feed.",
          },
          { kind: "callout", tone: "important",
            text: "If you enter a manual subledger value and then try to approve the same " +
                  "row, the Approve button returns a 403 with a clear explanation. Ask a " +
                  "different reviewer or admin to approve, or — if you're an admin — use " +
                  "the override flow.",
          },
        ],
      },
      {
        id: "sequential-close",
        title: "Sequential close gate",
        blocks: [
          { kind: "p", text:
            "You can't close March until February is fully closed. You can't even start " +
            "doing reconciliation work on March if February has any open accounts. This " +
            "is a finance-controls discipline — it prevents skipping a month or " +
            "back-dating activity.",
          },
          { kind: "p", text:
            "The gate runs on both the dashboard (locks the month tile) and the recons " +
            "page (locks the dashboard body) and the server (rejects the close API call). " +
            "If you hit the lock, the UI tells you which prior month is blocking + links " +
            "you straight to it.",
          },
        ],
      },
    ],
  },

  // ── 4. Reconciliations ──────────────────────────────────────────────────
  {
    id: "reconciliations",
    number: "4",
    title: "Reconciliations",
    summary: "Tick-and-tie every balance-sheet account",
    subSections: [
      {
        id: "recons-overview",
        title: "How reconciliations work",
        blocks: [
          { kind: "p", text:
            "Reconciliations is the workhorse of month-end close. For every balance-" +
            "sheet account, you confirm the GL balance ties to its supporting subledger " +
            "(or to a list of reconciling items you tick off). When every account is " +
            "approved, the books can close.",
          },
          { kind: "p", text:
            "The page lives at Reconciliations in the sidebar. Each month gets its own " +
            "dashboard page with a sticky KPI bar (GL / Subledger / Variance / Progress) " +
            "above a table of every BS account from QBO.",
          },
        ],
      },
      {
        id: "recons-workflow",
        title: "The per-account workflow",
        blocks: [
          { kind: "steps", items: [
            "Pick a period from the Dashboard's month-end tracker (or directly via the date picker on the Reconciliations page).",
            "Click \"Sync from QuickBooks\" — Nordavix pulls every BS account balance for the period end, plus AR/AP aging details and any composition data we can get.",
            "Each row shows GL Balance, Subledger Balance (rolled forward from prior period + any current activity you've ticked), Variance, and Status.",
            "Click a row to expand: edit the subledger value manually OR tick reconciling items pulled from QBO transactions.",
            "When the row ties (variance = 0), click the row's status chip to advance Pending → Prepared.",
            "A reviewer or admin then clicks the chip again to advance Prepared → Approved.",
            "Repeat until every row is Approved.",
          ] },
          { kind: "callout", tone: "tip",
            text: "Bulk-select rows (checkbox in the leftmost column) to apply Mark Prepared, " +
                  "Approve, Flag, or Reset to Pending across many accounts at once. The " +
                  "toolbar appears above the table when any row is selected.",
          },
        ],
      },
      {
        id: "recons-agentic",
        title: "Agentic Mode (AI auto-preparer)",
        blocks: [
          { kind: "p", text:
            "Agentic Mode runs across every open account in the period, pulls transactions " +
            "from QBO, ties out where the math works, and writes structured AI commentary " +
            "(narrative + risk level + justified status + key entities + recommendations) " +
            "for each one. Click the green \"Agentic Mode\" button in the header.",
          },
          { kind: "p", text:
            "It's analyze-and-suggest only — it doesn't auto-approve. After the run, " +
            "every row it touched has AI commentary visible in its expand drawer and a " +
            "subtle AI badge on the row. You review and decide.",
          },
          { kind: "p", text:
            "Need to redo just one row? Use the per-row \"Run AI\" pill in the row's " +
            "actions column. Click it on an account that already has commentary and you'll " +
            "be warned before overwriting.",
          },
        ],
      },
      {
        id: "recons-evidence",
        title: "Attaching evidence",
        blocks: [
          { kind: "steps", items: [
            "Open the row's expand drawer.",
            "Drag a file (bank statement PDF, subledger export, etc.) into the Evidence section, or click \"Upload\".",
            "AI will OCR the document and extract the relevant balance, then compare it to your entered subledger value. Match = green check; mismatch = red alert.",
            "Files attach to the row forever — they're visible on the PDF export and the audit log.",
          ] },
        ],
      },
      {
        id: "recons-pdf",
        title: "Per-account PDF export",
        blocks: [
          { kind: "p", text:
            "Once a row is Prepared or Approved, a Download button appears in its actions. " +
            "Click it to get a single-page (or multi-page for long-item lists) working " +
            "paper PDF — masthead, account info, reconciliation build-up table, AI " +
            "commentary, notes, and attached evidence list. Approved exports are clean; " +
            "Prepared exports carry a DRAFT watermark.",
          },
        ],
      },
    ],
  },

  // ── 5. Flux Analysis ─────────────────────────────────────────────────────
  {
    id: "flux",
    number: "5",
    title: "Flux Analysis",
    summary: "Variance analysis with AI narrative",
    subSections: [
      {
        id: "flux-overview",
        title: "What flux analysis does",
        blocks: [
          { kind: "p", text:
            "Flux analysis compares current-period balances to a prior period (typically " +
            "the same month last year) and flags significant movements. For each row, " +
            "Nordavix pulls the underlying QBO transactions in the change window and asks " +
            "an AI to write a controller-grade explanation of what drove the variance.",
          },
        ],
      },
      {
        id: "flux-create",
        title: "Create a new analysis",
        blocks: [
          { kind: "steps", items: [
            "Open Flux Analysis from the sidebar — you land on the month index.",
            "Pick the month you want to analyze. If you came from the Dashboard's Open Flux tile, the row is pre-highlighted.",
            "Click \"Start\" on an empty month. The new-analysis form opens with the period pre-filled.",
            "Confirm the current period end and prior period end (defaults to one year prior). Pick a comparison type if you want quarter-to-quarter or YTD-to-YTD.",
            "Click \"Pull from QuickBooks\". Nordavix fetches both Trial Balance reports, computes the variances, and lands you on the variance table.",
          ] },
        ],
      },
      {
        id: "flux-table",
        title: "Reading the variance table",
        blocks: [
          { kind: "p", text:
            "Every account that has balances in either period gets a row. Columns: " +
            "Account # / Name / Category / Current Balance / Prior Balance / $ Variance / " +
            "% Variance / Status / Actions.",
          },
          { kind: "p", text:
            "Status tabs above the table — Open / Prepared / Approved / All — let you " +
            "focus on what's left to do. The KPI strip at the top tracks total variance, " +
            "approval progress, and AI commentary coverage in real time.",
          },
        ],
      },
      {
        id: "flux-row-drill",
        title: "Drilling into a row",
        blocks: [
          { kind: "steps", items: [
            "Click any row to expand it. The drawer shows the AI commentary panel (if generated) and a Transactions section.",
            "Click \"Pull transactions\" — Nordavix calls QBO's GeneralLedger report for the account in the change window and lists every transaction.",
            "Tick each transaction as you verify it. The footer shows Sum of pulled transactions, GL variance, and Matched Amount — when fully matched, the line goes green with a checkmark.",
            "Use the per-row \"Run AI\" Sparkles button to generate (or regenerate) structured AI commentary just for this row.",
            "When you're satisfied, advance the row status via the chip or the bulk toolbar.",
          ] },
          { kind: "callout", tone: "info", title: "Sign convention",
            text: "QBO returns transactions in their natural debit sign — so for credit-natural " +
                  "accounts (Credit Card, AP, Liabilities, Equity, Revenue) a normal posting " +
                  "appears NEGATIVE. The Matched Amount calculation flips the sign automatically " +
                  "for these accounts; we show both raw and normalized values side-by-side so " +
                  "you can audit the math.",
          },
        ],
      },
      {
        id: "flux-signoff",
        title: "Signing off the analysis",
        blocks: [
          { kind: "p", text:
            "Once every variance row is approved, the \"Sign off analysis\" button in the " +
            "header enables (admin + reviewer only). Click it to stamp the trial balance " +
            "with your name and timestamp. This is what unlocks the month for close — " +
            "the books cannot close until every flux analysis for the month is signed off.",
          },
        ],
      },
    ],
  },

  // ── 6. Financial Statements ─────────────────────────────────────────────
  {
    id: "financials",
    number: "6",
    title: "Financial Statements",
    summary: "IS / BS / CF + audit-ready PDF",
    subSections: [
      {
        id: "financials-overview",
        title: "What you get",
        blocks: [
          { kind: "p", text:
            "Three statements (Income Statement, Balance Sheet, Statement of Cash Flows) " +
            "rendered on-screen with audit-style formatting + a downloadable PDF that's " +
            "clean enough to hand to an external auditor.",
          },
          { kind: "p", text:
            "Two data sources: Nordavix synced (built from the GL snapshots captured during " +
            "your reconciliation work — works offline, respects manual overrides) and " +
            "QuickBooks live (calls QBO reports directly). Cash Flow always pulls live " +
            "from QBO regardless of source selection.",
          },
        ],
      },
      {
        id: "financials-periods",
        title: "Period selection",
        blocks: [
          { kind: "p", text:
            "Income Statement and Cash Flow are period-based (\"for the period from X to Y\"). " +
            "Balance Sheet is point-in-time (\"as of Y\").",
          },
          { kind: "steps", items: [
            "Pick a period type: YTD (default; auto-calculates start as Jan 1) or Custom range.",
            "If Custom, pick a From date for IS / CF. The Balance Sheet ignores it.",
            "Pick the To date (As-of date for BS).",
            "Use Quick chips — Last month / Last quarter / YTD / Last year — for one-click common cuts.",
            "Click \"Load financials\".",
          ] },
        ],
      },
      {
        id: "financials-export",
        title: "Exporting PDFs",
        blocks: [
          { kind: "p", text:
            "Click Export PDF in the header. The dropdown offers:",
          },
          { kind: "bullets", items: [
            "Full financial package — all 3 statements in one PDF (the typical deliverable).",
            "Income Statement only, Balance Sheet only, or Cash Flow only.",
          ] },
          { kind: "p", text:
            "When books are closed for the period, exports are FINAL (clean). When not " +
            "closed, exports are DRAFT (watermarked). The dropdown header makes it " +
            "explicit which you'll get.",
          },
        ],
      },
      {
        id: "executive-report",
        title: "Executive Report (the big USP)",
        blocks: [
          { kind: "p", text:
            "Once books are closed, the Executive Report card appears at the top of the " +
            "Financial Statements page (and on the Dashboard's books-closed banner). Click " +
            "\"Generate report\" to produce a 10+ page AI-narrated PDF that bundles:",
          },
          { kind: "bullets", items: [
            "Cover page with company name, period, closed-by attribution",
            "AI-written executive summary + key highlights (4-6 bullets)",
            "All three financial statements (IS / BS / CF), full audit-style tables",
            "Liquidity insights with a 6-month cash + OCF line chart",
            "Profitability insights with revenue / GP / NI bar chart",
            "AR/AP aging + DSO/DPO",
            "Top expense categories + month-over-month movers",
            "Reconciliation summary (counts, top variances, flagged items)",
            "Flux highlights — per analysis with top material variances + AI narratives",
            "AI Risks / Recommendations / Forward Outlook in colored callouts",
            "Notes & Methodology footer",
          ] },
          { kind: "callout", tone: "tip",
            text: "Generation takes 10–30 seconds because of the live QBO pulls + the AI call. " +
                  "The UI shows a spinner with reassuring copy.",
          },
        ],
      },
    ],
  },

  // ── 7. Month-End Close Ceremony ─────────────────────────────────────────
  {
    id: "close-ceremony",
    number: "7",
    title: "Month-end close ceremony",
    summary: "The full end-to-end close in 9 steps",
    subSections: [
      {
        id: "ceremony-steps",
        title: "Close a month from start to finish",
        blocks: [
          { kind: "p", text:
            "This is the canonical close ceremony. Follow it every month. Total time for " +
            "a small workspace with everything synced: 20–40 minutes once you're fluent.",
          },
          { kind: "steps", items: [
            "PERIOD: Open Dashboard. Click the month tile in the tracker for the month you're closing.",
            "RECONS SYNC: Click Open Reconciliations. Click \"Sync from QuickBooks\". Wait ~5–15 seconds.",
            "RECONS PREPARE: For each row, tick reconciling items / enter subledger value until variance = 0. Alternatively run Agentic Mode to auto-prepare every open account.",
            "RECONS APPROVE: A reviewer or admin clicks each row's status chip from Prepared → Approved. Bulk approve via the toolbar if you trust the prepared work.",
            "FLUX: Open Flux Analysis. Click Start on the month tile (or open an existing one). Click Pull from QuickBooks.",
            "FLUX REVIEW: Walk every variance row. Run Agentic Mode for AI commentary on every variance. Approve each row.",
            "FLUX SIGN-OFF: An admin or reviewer clicks \"Sign off analysis\" in the flux header. The TB is now stamped.",
            "CLOSE: Back on Dashboard. The Month-End Close Progress card turns green with \"Ready to close — every account approved\". An admin clicks \"Close month-end books\".",
            "DELIVER: From the closed banner, click \"Download executive report\". Email it to your CEO / CFO / board.",
          ] },
        ],
      },
      {
        id: "ceremony-gates",
        title: "What blocks the close",
        blocks: [
          { kind: "p", text:
            "The Close button is disabled (and the server rejects the call) unless ALL of " +
            "these are true:",
          },
          { kind: "bullets", items: [
            "Every prior period from books-start is already closed (sequential close)",
            "Every reconciliation account for this period has status Approved",
            "At least one flux analysis exists for this period",
            "Every flux analysis for this period has been signed off",
          ] },
          { kind: "callout", tone: "warning",
            text: "If any of these fail, the dashboard's Ready-to-close strip tells you " +
                  "exactly what's blocking — typically with a deep link to the offending page.",
          },
        ],
      },
    ],
  },

  // ── 8. Intercompany ─────────────────────────────────────────────────────
  {
    id: "intercompany",
    number: "8",
    title: "Intercompany",
    summary: "IC accounts + counterparty mapping",
    subSections: [
      {
        id: "ic-overview",
        title: "How IC works",
        blocks: [
          { kind: "p", text:
            "Intercompany surfaces accounts whose names suggest IC activity (\"Due From X\", " +
            "\"Loan to Affiliate\", \"IC Receivable\", etc.) and auto-suggests counterparty " +
            "pairings — for example, your \"Due From Sub A\" should net against Sub A's " +
            "\"Due To Parent\".",
          },
          { kind: "p", text:
            "If your books don't have IC activity (single-entity), the page shows a " +
            "friendly empty state explaining it'll light up when an IC-named account " +
            "appears.",
          },
        ],
      },
    ],
  },

  // ── 9. Insights ─────────────────────────────────────────────────────────
  {
    id: "insights",
    number: "9",
    title: "Insights",
    summary: "Liquidity, profitability, AR/AP, expense monitor",
    subSections: [
      {
        id: "insights-overview",
        title: "What's in Insights",
        blocks: [
          { kind: "p", text:
            "Insights is a four-section KPI dashboard with trends. It reads from the same " +
            "GL snapshots that feed reconciliations, so the numbers always match the " +
            "financial package.",
          },
          { kind: "bullets", items: [
            "LIQUIDITY: Cash balance, monthly burn (3-mo average), runway, operating cash flow proxy. Includes a 6-month cash + OCF line chart.",
            "PROFITABILITY: Revenue, Gross Profit, Operating Income, Net Income with margin percentages and prior-period comparisons. Includes a revenue/GP/NI bar chart over the trailing 6 months.",
            "AR / AP: DSO, DPO, percentage of AR over 60 days, percentage of AP over 60 days, top concentrations.",
            "EXPENSES: Top categories by amount, month-over-month movers, trend lines per category.",
          ] },
          { kind: "p", text:
            "The page supports a custom date range and refreshes from QBO on demand. " +
            "Jump-nav at the top lets you scroll directly to any section.",
          },
        ],
      },
    ],
  },

  // ── 10. Settings ────────────────────────────────────────────────────────
  {
    id: "settings",
    number: "10",
    title: "Settings",
    summary: "Company profile, workspaces, preferences",
    subSections: [
      {
        id: "settings-overview",
        title: "What's where",
        blocks: [
          { kind: "table",
            columns: ["Section", "What you set"],
            rows: [
              ["Company",       "Legal name, address, tax ID, fiscal year, accounting defaults"],
              ["Profile",       "Your name + email (Clerk-managed; click the account avatar to edit)"],
              ["Workspaces",    "Switch between client workspaces, or create a new one"],
              ["Team",          "Invite / remove members + change roles"],
              ["Notifications", "Email + in-app alerts (per-event toggles; preference sync is on the roadmap)"],
              ["AI preferences", "Agentic defaults, materiality threshold, narrative tone"],
              ["Appearance",    "Light / dark / system theme, table row density"],
              ["Data & export", "Audit log download, full reconciliations export"],
              ["About",         "Version, docs, support contact"],
            ],
          },
        ],
      },
    ],
  },

  // ── 11. Troubleshooting ─────────────────────────────────────────────────
  {
    id: "troubleshooting",
    number: "11",
    title: "Troubleshooting",
    summary: "Common issues + fixes",
    subSections: [
      {
        id: "tr-qbo",
        title: "QuickBooks connection issues",
        blocks: [
          { kind: "bullets", items: [
            "\"QuickBooks isn't connected\" banner — go to Connections and re-authorize. The OAuth token expires after extended inactivity.",
            "\"Could not pull statement from QuickBooks\" on the financials page — usually a transient QBO 5xx. Click Reload. If it persists, try a different period to confirm it's not data-specific.",
            "Balances differ between Nordavix and QBO — check the source toggle on the financials page. Nordavix synced may be stale if you haven't synced reconciliations recently.",
          ] },
        ],
      },
      {
        id: "tr-signin",
        title: "Sign-in problems",
        blocks: [
          { kind: "bullets", items: [
            "Locked out / forgot password — use \"Forgot password\" on the sign-in page. Reset link arrives via email.",
            "No invite email — check spam. If still missing, ask the admin to resend from Team page.",
            "Google SSO blocked — your IT may require an admin-consented OAuth scope. Try email + password instead.",
          ] },
        ],
      },
      {
        id: "tr-ai",
        title: "AI takes too long / fails",
        blocks: [
          { kind: "bullets", items: [
            "Agentic Mode (whole period): 30s–3min depending on account count. Stop button cancels cooperatively.",
            "Per-row Agentic: 10–15s typical, up to 60s if QBO is slow.",
            "Executive Report: 10–30s typical. If it fails, the page surfaces the actual error — usually QBO rate-limiting. Wait 30s, retry.",
            "All AI calls fall back to a deterministic narrative if Claude is unavailable, so the PDF always ships.",
          ] },
        ],
      },
      {
        id: "tr-data",
        title: "Data not syncing",
        blocks: [
          { kind: "bullets", items: [
            "Refresh doesn't show new QBO activity — Nordavix is on-demand. Click Sync from QuickBooks on the recons page.",
            "Account showing $0 — confirm in QBO that the account had activity in the period; check that books_start_date isn't after the activity date.",
            "Subledger value missing on roll-forward — verify the prior period's account was Approved (not Prepared). Only Approved values roll forward.",
          ] },
        ],
      },
    ],
  },

  // ── 12. Glossary ────────────────────────────────────────────────────────
  {
    id: "glossary",
    number: "12",
    title: "Glossary",
    summary: "Terms used across the product",
    subSections: [
      {
        id: "glossary-terms",
        title: "Definitions",
        blocks: [
          { kind: "table",
            columns: ["Term", "Definition"],
            rows: [
              ["Agentic Mode",        "AI auto-preparer. Runs across every open item, pulls transactions, attempts to tie out, writes structured commentary. Suggest-only — never auto-approves."],
              ["Books start date",    "The first day your books exist in Nordavix. Opening balances seed from QBO as of (this date − 1 day)."],
              ["Close-and-roll",      "Each month's opening = prior month's approved closing. The chain enforces sequential closes."],
              ["Credit-natural",      "An account whose normal balance is on the credit side: Liabilities, Equity, Revenue. QBO transactions on these appear as negative debits."],
              ["Executive Report",    "AI-narrated, multi-page PDF deliverable. Only available after books close."],
              ["Flux analysis",       "Variance analysis between two periods. Each row gets AI commentary explaining what drove the movement."],
              ["GL snapshot",         "Frozen balance for an account at a period-end, captured on every reconciliations sync. Powers the Nordavix synced financial source."],
              ["Maker / checker",     "The user who enters a value cannot be the same user who approves it. Hard rule, server-enforced."],
              ["Materiality",         "(Deprecated in the UI.) Was a per-analysis threshold below which variances were ignored. We now show every variance and let you decide."],
              ["Matched Amount",      "On a variance row drill-in, the portion of the GL variance explained by pulled transactions. Equal to the variance when fully reconciled."],
              ["Period end",          "The last day of a closing period. Most commonly the last day of a calendar month."],
              ["Preparer",            "The role that does the work but cannot approve their own work."],
              ["Reviewer",            "The role that approves the preparer's work. Cannot close books."],
              ["Roll-forward",        "Copying the prior period's approved subledger value into the current period's opening. Automatic."],
              ["Sequential close",    "The rule that prevents closing a month while any earlier month is still open."],
              ["Sign-off (flux)",     "Reviewer/admin action that stamps a flux analysis as complete. Required before books can close."],
              ["Subledger",           "The supporting detail behind a GL account. AR aging behind 'Accounts Receivable', vendor bills behind 'Accounts Payable', bank reconciliation behind 'Cash', etc."],
              ["Sync",                "On-demand pull from QuickBooks. Nordavix is on-demand, not push — you click Sync when you want fresh data."],
              ["Tenant",              "Internal term for a workspace. Each tenant's data is physically isolated at the database level."],
              ["Variance",            "GL balance current period minus GL balance prior period. Positive = went up; negative = went down (in the account's natural direction)."],
              ["Workspace",           "One client company. CPA firms create one workspace per client."],
            ],
          },
        ],
      },
    ],
  },

  // ── 13. Support ─────────────────────────────────────────────────────────
  {
    id: "support",
    number: "13",
    title: "Support & feedback",
    summary: "How to reach the team",
    subSections: [
      {
        id: "support-contact",
        title: "Getting help",
        blocks: [
          { kind: "bullets", items: [
            "EMAIL: hello@nordavix.com — best for non-urgent questions. We reply within one business day during Beta.",
            "IN-APP FEEDBACK: Click \"Send feedback\" in the sidebar (above your account info). Bugs, ideas, comments all go to the same inbox.",
            "URGENT: If you're mid-close and blocked, email us with subject \"URGENT — close blocker\" and we'll prioritize.",
          ] },
        ],
      },
      {
        id: "support-status",
        title: "Status + uptime",
        blocks: [
          { kind: "p", text:
            "We monitor both the frontend (Vercel) and backend (Fly.io). If something's " +
            "down on our end, we'll typically notice within minutes. There's no public " +
            "status page yet — that ships when we exit Beta.",
          },
        ],
      },
      {
        id: "support-roadmap",
        title: "What's next",
        blocks: [
          { kind: "p", text:
            "Roadmap is shaped by Beta feedback. Currently in active development:",
          },
          { kind: "bullets", items: [
            "Prepaid + accrual schedules (auto-amortization)",
            "Saved AI preferences per workspace",
            "Email digests of close progress",
            "Public status page + SOC 2 attestation",
            "Xero + NetSuite integrations",
          ] },
        ],
      },
    ],
  },
]
