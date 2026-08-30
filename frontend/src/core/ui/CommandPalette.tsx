/**
 * CommandPalette — ⌘K / Ctrl-K, and the one place that can find anything.
 *
 * Opens on ⌘K (or Ctrl-K), or when any control dispatches the
 * `nordavix:open-command-palette` window event (so the LeftNav search box and
 * the mobile top-bar button can open it too). Keyboard-first: type to filter,
 * ↑/↓ to move, Enter to run, Esc to close. Theme-aware; mounted once in the
 * app shell.
 *
 * It searches the WORKSPACE, not just this file's list of destinations. For a
 * long time every entry here ended in `navigate(...)` and there was no search
 * endpoint behind it at all, so in a workspace holding thousands of accounts,
 * findings and entries, typing "AWS" returned a list of page names. Commands
 * still rank first — they're instant and local, and someone typing "settings"
 * wants the page — with matching data underneath as it arrives.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { useLocation, useNavigate, type NavigateFunction } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { motion, AnimatePresence } from "framer-motion"
import {
  Search, LayoutDashboard, CheckSquare, Plug, ClipboardList, BarChart3,
  ArrowLeftRight, Scale, Lightbulb, BookOpen, Users, Settings, LifeBuoy,
  Building2, Rocket, CalendarCheck2, FileDown, Gauge, Layers, ListTree,
  PlayCircle, Receipt, ShieldCheck, FileCheck2, CalendarDays, Wallet,
  type LucideIcon,
} from "lucide-react"
import { searchApi, type SearchHit } from "@/core/api/search"

export const CMDK_EVENT = "nordavix:open-command-palette"

interface Command {
  id:        string
  label:     string
  hint?:     string
  group:     string
  icon:      LucideIcon
  keywords?: string
  run:       (nav: NavigateFunction) => void
}

const COMMANDS: Command[] = [
  // ── Go to ──
  { id: "nav-dashboard",   group: "Go to", label: "Dashboard",          icon: LayoutDashboard, run: (n) => n("/app") },
  { id: "nav-autopilot",   group: "Go to", label: "Close Autopilot",    icon: Rocket, keywords: "automate schedule run close", run: (n) => n("/app/autopilot") },
  { id: "nav-tasks",       group: "Go to", label: "Close Tasks",        icon: CheckSquare,     run: (n) => n("/app/tasks") },
  { id: "nav-connections", group: "Go to", label: "Connections",        icon: Plug,            run: (n) => n("/app/connections") },
  { id: "nav-schedules",   group: "Go to", label: "Schedules",          icon: ClipboardList,   run: (n) => n("/app/schedules") },
  { id: "nav-flux",        group: "Go to", label: "Flux Analysis",      icon: BarChart3,       run: (n) => n("/app/flux") },
  { id: "nav-ic",          group: "Go to", label: "Intercompany",       icon: ArrowLeftRight,  run: (n) => n("/app/intercompany") },
  { id: "nav-recons",      group: "Go to", label: "Reconciliations",    icon: Scale,           run: (n) => n("/app/reconciliations") },
  { id: "nav-insights",    group: "Go to", label: "Insights",           icon: Lightbulb,       run: (n) => n("/app/insights") },
  { id: "nav-financials",  group: "Go to", label: "Financial Statements", icon: BookOpen,        run: (n) => n("/app/financials") },
  { id: "nav-team",        group: "Go to", label: "Team",               icon: Users,           run: (n) => n("/app/team") },
  { id: "nav-settings",    group: "Go to", label: "Settings",           icon: Settings,        run: (n) => n("/app/settings") },
  { id: "nav-help",        group: "Go to", label: "Help",               icon: LifeBuoy,        run: (n) => n("/app/help") },
  // ── Actions ──
  { id: "act-autopilot",  group: "Actions", label: "Run the close on autopilot", hint: "Sync, prepare, flux + digest — unattended", icon: Rocket, keywords: "automate schedule agentic", run: (n) => n("/app/autopilot") },
  { id: "act-flux",       group: "Actions", label: "Run a flux analysis",     hint: "Explain P&L movements",          icon: BarChart3, keywords: "variance", run: (n) => n("/app/flux") },
  { id: "act-recon",      group: "Actions", label: "Reconcile accounts",      hint: "Tie out the balance sheet",      icon: Scale,                            run: (n) => n("/app/reconciliations") },
  { id: "act-financials", group: "Actions", label: "Export financial statements", hint: "IS / BS / Cash flow + schedules", icon: BookOpen, keywords: "excel pdf statements package", run: (n) => n("/app/financials") },
  { id: "act-connect",    group: "Actions", label: "Connect QuickBooks",      icon: Plug, keywords: "qbo sync",       run: (n) => n("/app/connections") },
  { id: "act-invite",     group: "Actions", label: "Invite a teammate",       icon: Users, keywords: "preparer reviewer", run: (n) => n("/app/team") },
  { id: "act-company",    group: "Actions", label: "Switch / add company",    icon: Building2, keywords: "workspace org", run: (n) => n("/app/companies") },
]

/**
 * Nordavix Allocate has its own destinations.
 *
 * The palette is mounted in both shells and the top bar advertises ⌘K in both,
 * so offering only close-app routes meant pressing it inside Allocate and
 * landing in Reconciliations — out of the product entirely. Which set is shown
 * follows the path, because that's what the user is looking at.
 */
const ALLOCATION_COMMANDS: Command[] = [
  { id: "alloc-dashboard",  group: "Go to", label: "Dashboard",        icon: Gauge,          run: (n) => n("/allocation") },
  { id: "alloc-eligibility", group: "Go to", label: "Eligibility",     icon: Scale, keywords: "448c threshold small business taxpayer gross receipts", run: (n) => n("/allocation/eligibility") },
  { id: "alloc-pools",      group: "Go to", label: "Cost pools",       icon: Layers, keywords: "driver treatment direct excluded", run: (n) => n("/allocation/pools") },
  { id: "alloc-accounts",   group: "Go to", label: "Accounts",         icon: ListTree, keywords: "map chart of accounts cogs 280e", run: (n) => n("/allocation/accounts") },
  { id: "alloc-spaces",     group: "Go to", label: "Spaces",           icon: Building2, keywords: "square footage occupancy floor plan", run: (n) => n("/allocation/spaces") },
  { id: "alloc-employees",  group: "Go to", label: "Employees",        icon: Users, keywords: "payroll classification split production", run: (n) => n("/allocation/employees") },
  { id: "alloc-payroll",    group: "Go to", label: "Payroll register", icon: Receipt, keywords: "import wages adp gusto", run: (n) => n("/allocation/payroll") },
  { id: "alloc-runs",       group: "Go to", label: "Run allocation",   icon: PlayCircle, keywords: "workpaper journal entry", run: (n) => n("/allocation/runs") },
  { id: "alloc-yearend",    group: "Go to", label: "Year end",         icon: CalendarCheck2, keywords: "roll-up 1125-a cogs", run: (n) => n("/allocation/year-end") },
  { id: "alloc-export",     group: "Go to", label: "Export",           icon: FileDown, keywords: "excel pdf workbook report deliverable", run: (n) => n("/allocation/export") },
  { id: "alloc-team",       group: "Go to", label: "Team",             icon: Users,          run: (n) => n("/allocation/team") },
  { id: "alloc-settings",   group: "Go to", label: "Settings",         icon: Settings, keywords: "method election frequency 1125-a line 9", run: (n) => n("/allocation/settings") },
  // ── Actions ──
  { id: "alloc-act-run",     group: "Actions", label: "Run this period's allocation", hint: "Pull QuickBooks and compute", icon: PlayCircle, keywords: "471c compute", run: (n) => n("/allocation/runs") },
  { id: "alloc-act-payroll", group: "Actions", label: "Import a payroll register", hint: "The payroll factor needs wages", icon: Receipt, keywords: "csv xlsx upload", run: (n) => n("/allocation/payroll") },
  { id: "alloc-act-export",  group: "Actions", label: "Export the client report",  hint: "PDF deliverable and Excel workbook", icon: FileDown, keywords: "pdf excel deliverable", run: (n) => n("/allocation/export") },
  { id: "alloc-act-1125a",   group: "Actions", label: "See the Form 1125-A lines", hint: "Year-end roll-up and declarations", icon: CalendarCheck2, keywords: "cogs return", run: (n) => n("/allocation/year-end") },
  // The one seam back — named so it's findable rather than a trap.
  { id: "alloc-act-close",   group: "Actions", label: "Switch to month-end close", icon: LayoutDashboard, keywords: "product switch recons flux", run: (n) => n("/app") },
]

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-4 pt-2 pb-1 text-[10px] font-bold uppercase tracking-wider"
      style={{ color: "var(--text-muted)" }}>{children}</p>
  )
}

function score(cmd: Command, q: string): number {
  if (!q) return 1
  const needle = q.toLowerCase()
  const hay = `${cmd.label} ${cmd.hint ?? ""} ${cmd.keywords ?? ""} ${cmd.group}`.toLowerCase()
  if (cmd.label.toLowerCase().startsWith(needle)) return 3
  if (hay.includes(needle)) return 2
  // loose subsequence fallback
  let i = 0
  for (const ch of hay) {
    if (ch === needle[i]) i++
    if (i === needle.length) return 1
  }
  return 0
}

/** What each kind of hit looks like in the list. The icon is the fastest
 *  signal of "which part of the product am I about to land in". */
const HIT_META: Record<SearchHit["type"], { icon: LucideIcon; group: string }> = {
  account:    { icon: Scale,         group: "Accounts" },
  finding:    { icon: ShieldCheck,   group: "Risk Radar" },
  review:     { icon: FileCheck2,    group: "Close Review" },
  task:       { icon: CheckSquare,   group: "Tasks" },
  adjustment: { icon: Wallet,        group: "Adjustments" },
  schedule:   { icon: ClipboardList, group: "Schedules" },
  period:     { icon: CalendarDays,  group: "Periods" },
}

/** Wait this long after the last keystroke before asking the server.
 *  Short enough to feel immediate while typing an account number, long enough
 *  that a five-letter word is one request rather than five. */
const DEBOUNCE_MS = 180

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState("")
  const [active, setActive] = useState(0)
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const inputRef = useRef<HTMLInputElement>(null)

  // Debounced copy of the query, so every keystroke doesn't become a request.
  const [debounced, setDebounced] = useState("")
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [q])

  // Data search. Allocate has its own product with its own tables, so the
  // workspace search only runs in the close app rather than returning
  // reconciliation accounts to someone looking at cost pools.
  const inCloseApp = !pathname.startsWith("/allocation")
  const enabled = open && inCloseApp && debounced.trim().length >= 2
  const { data: found, isFetching } = useQuery({
    queryKey: ["search", debounced],
    queryFn: ({ signal }) => searchApi.query(debounced.trim(), signal),
    enabled,
    // Results are cheap to re-fetch and stale ones are actively misleading —
    // a finding cleared a minute ago should not still be offered.
    staleTime: 15_000,
    gcTime: 60_000,
    placeholderData: (prev) => prev,
  })
  const hits: SearchHit[] = enabled ? (found?.results ?? []) : []
  // Which product's destinations to offer. Follows the path rather than a
  // remembered preference: what you're looking at is what you mean.
  const commands = pathname.startsWith("/allocation") ? ALLOCATION_COMMANDS : COMMANDS

  // ⌘K / Ctrl-K toggles; the window event opens (used by LeftNav + mobile bar).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    function onOpen() { setOpen(true) }
    window.addEventListener("keydown", onKey)
    window.addEventListener(CMDK_EVENT, onOpen)
    return () => {
      window.removeEventListener("keydown", onKey)
      window.removeEventListener(CMDK_EVENT, onOpen)
    }
  }, [])

  useEffect(() => {
    if (open) {
      setQ("")
      setActive(0)
      const t = setTimeout(() => inputRef.current?.focus(), 10)
      return () => clearTimeout(t)
    }
  }, [open])

  const matchedCommands = useMemo(
    () => commands
      .map((c) => ({ c, s: score(c, q) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c),
    [q, commands],
  )

  /** Commands and workspace hits as ONE navigable list.
   *
   *  Commands first: they resolve locally and instantly, and someone typing
   *  "settings" means the page. Data follows as it arrives — and because the
   *  keyboard index runs across both, ↓↓↓ walks from a destination into a real
   *  account without the reader having to notice there are two lists. */
  type Row =
    | { kind: "cmd"; key: string; cmd: Command }
    | { kind: "hit"; key: string; hit: SearchHit }
  const rows: Row[] = useMemo(() => [
    ...matchedCommands.map((c) => ({ kind: "cmd" as const, key: `c:${c.id}`, cmd: c })),
    ...hits.map((h) => ({ kind: "hit" as const, key: `h:${h.type}:${h.id}`, hit: h })),
  ], [matchedCommands, hits])

  useEffect(() => { if (active >= rows.length) setActive(0) }, [rows.length, active])

  function run(row: Row) {
    setOpen(false)
    if (row.kind === "cmd") row.cmd.run(navigate)
    else navigate(row.hit.link)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, rows.length - 1)) }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
    else if (e.key === "Enter") { e.preventDefault(); const r = rows[active]; if (r) run(r) }
    else if (e.key === "Escape") { setOpen(false) }
  }

  const typing = q.trim().length > 0
  const tooShort = typing && q.trim().length < 2
  let lastGroup = ""

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.14, ease: "easeOut" }}
          className="fixed inset-0 z-[100] flex items-start justify-center p-4 pt-[12vh]"
          style={{ background: "rgba(0,0,0,0.45)", backdropFilter: "blur(2px)" }}
          onClick={() => setOpen(false)}
        >
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ duration: 0.14, ease: "easeOut" }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-xl rounded-xl overflow-hidden"
            style={{ background: "var(--surface)", border: "1px solid var(--border-strong)", boxShadow: "0 24px 60px -12px rgba(0,0,0,0.45)" }}
          >
            {/* Search input */}
            <div className="flex items-center gap-2 px-4" style={{ borderBottom: "1px solid var(--border)" }}>
              <Search size={16} strokeWidth={1.8} style={{ color: "var(--text-muted)" }} />
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => { setQ(e.target.value); setActive(0) }}
                onKeyDown={onKeyDown}
                placeholder={inCloseApp
                  ? "Search accounts, findings, entries…  or type a command"
                  : "Jump to… or type a command"}
                className="flex-1 bg-transparent outline-none py-3 text-sm"
                style={{ color: "var(--text)" }}
              />
              {/* A quiet pulse while the workspace query is in flight. Never a
                  spinner that replaces the list: the commands are already
                  usable and yanking them away to show a loader would make a
                  fast palette feel slow. */}
              {isFetching && (
                <span className="h-1.5 w-1.5 rounded-full shrink-0"
                  style={{ background: "var(--green)", animation: "ndvx-cmdk-pulse 1s ease-in-out infinite" }} />
              )}
              <kbd className="text-[10px] px-1.5 py-0.5 rounded"
                style={{ background: "var(--surface-2)", color: "var(--text-muted)", border: "1px solid var(--border)" }}>esc</kbd>
            </div>
            <style>{"@keyframes ndvx-cmdk-pulse{0%,100%{opacity:.25}50%{opacity:1}}"}</style>

            {/* Results */}
            <div className="max-h-[50vh] overflow-y-auto py-1.5">
              {rows.length === 0 && (
                <p className="px-4 py-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>
                  {tooShort
                    ? "Keep typing — two characters or more."
                    : isFetching ? "Searching…" : "No matches."}
                </p>
              )}
              {rows.map((row, i) => {
                const isActive = i === active
                if (row.kind === "cmd") {
                  const c = row.cmd
                  const Icon = c.icon
                  const showGroup = c.group !== lastGroup
                  lastGroup = c.group
                  return (
                    <div key={row.key}>
                      {showGroup && <GroupLabel>{c.group}</GroupLabel>}
                      <button
                        onMouseEnter={() => setActive(i)}
                        onClick={() => run(row)}
                        className="w-full flex items-center gap-3 px-4 py-2 text-left transition-colors"
                        style={{ background: isActive ? "var(--green-subtle)" : "transparent" }}
                      >
                        <Icon size={15} strokeWidth={1.8}
                          style={{ color: isActive ? "var(--green)" : "var(--text-muted)" }} className="shrink-0" />
                        <span className="flex-1 min-w-0 truncate">
                          <span className="text-sm" style={{ color: "var(--text)" }}>{c.label}</span>
                          {c.hint && <span className="text-[11px] ml-2" style={{ color: "var(--text-muted)" }}>{c.hint}</span>}
                        </span>
                      </button>
                    </div>
                  )
                }
                const h = row.hit
                const meta = HIT_META[h.type] ?? HIT_META.account
                const Icon = meta.icon
                // One header for the whole data section rather than one per
                // type: results are ranked by relevance across types, so
                // per-type headers would flip back and forth down the list.
                const showGroup = lastGroup !== "__data"
                lastGroup = "__data"
                return (
                  <div key={row.key}>
                    {showGroup && <GroupLabel>In this workspace</GroupLabel>}
                    <button
                      onMouseEnter={() => setActive(i)}
                      onClick={() => run(row)}
                      className="w-full flex items-center gap-3 px-4 py-2 text-left transition-colors"
                      style={{ background: isActive ? "var(--green-subtle)" : "transparent" }}
                    >
                      <Icon size={15} strokeWidth={1.8}
                        style={{ color: isActive ? "var(--green)" : "var(--text-muted)" }} className="shrink-0" />
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm truncate" style={{ color: "var(--text)" }}>{h.label}</span>
                        {h.sublabel && (
                          <span className="block text-[11px] truncate" style={{ color: "var(--text-muted)" }}>
                            {h.sublabel}
                          </span>
                        )}
                      </span>
                      <span className="text-[9.5px] font-bold uppercase tracking-wider shrink-0 rounded px-1.5 py-0.5"
                        style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}>
                        {meta.group}
                      </span>
                    </button>
                  </div>
                )
              })}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
