/**
 * CommandPalette — ⌘K / Ctrl-K global navigator + quick actions.
 *
 * Opens on ⌘K (or Ctrl-K), or when any control dispatches the
 * `nordavix:open-command-palette` window event (so the LeftNav search box and
 * the mobile top-bar button can open it too). Keyboard-first: type to filter,
 * ↑/↓ to move, Enter to run, Esc to close. Theme-aware; mounted once in the
 * app shell.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate, type NavigateFunction } from "react-router-dom"
import { motion, AnimatePresence } from "framer-motion"
import {
  Search, LayoutDashboard, CheckSquare, Plug, ClipboardList, BarChart3,
  ArrowLeftRight, Scale, Lightbulb, BookOpen, Users, Settings, LifeBuoy,
  Building2, type LucideIcon,
} from "lucide-react"

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
  { id: "nav-tasks",       group: "Go to", label: "Close Tasks",        icon: CheckSquare,     run: (n) => n("/app/tasks") },
  { id: "nav-connections", group: "Go to", label: "Connections",        icon: Plug,            run: (n) => n("/app/connections") },
  { id: "nav-schedules",   group: "Go to", label: "Schedules",          icon: ClipboardList,   run: (n) => n("/app/schedules") },
  { id: "nav-flux",        group: "Go to", label: "Flux Analysis",      icon: BarChart3,       run: (n) => n("/app/flux") },
  { id: "nav-ic",          group: "Go to", label: "Intercompany",       icon: ArrowLeftRight,  run: (n) => n("/app/intercompany") },
  { id: "nav-recons",      group: "Go to", label: "Reconciliations",    icon: Scale,           run: (n) => n("/app/reconciliations") },
  { id: "nav-insights",    group: "Go to", label: "Insights",           icon: Lightbulb,       run: (n) => n("/app/insights") },
  { id: "nav-financials",  group: "Go to", label: "Financial Package",  icon: BookOpen,        run: (n) => n("/app/financials") },
  { id: "nav-team",        group: "Go to", label: "Team",               icon: Users,           run: (n) => n("/app/team") },
  { id: "nav-settings",    group: "Go to", label: "Settings",           icon: Settings,        run: (n) => n("/app/settings") },
  { id: "nav-help",        group: "Go to", label: "Help",               icon: LifeBuoy,        run: (n) => n("/app/help") },
  // ── Actions ──
  { id: "act-flux",       group: "Actions", label: "Run a flux analysis",     hint: "Explain P&L movements",          icon: BarChart3, keywords: "variance", run: (n) => n("/app/flux") },
  { id: "act-recon",      group: "Actions", label: "Reconcile accounts",      hint: "Tie out the balance sheet",      icon: Scale,                            run: (n) => n("/app/reconciliations") },
  { id: "act-financials", group: "Actions", label: "Export financial package", hint: "IS / BS / Cash flow + schedules", icon: BookOpen, keywords: "excel pdf statements", run: (n) => n("/app/financials") },
  { id: "act-connect",    group: "Actions", label: "Connect QuickBooks",      icon: Plug, keywords: "qbo sync",       run: (n) => n("/app/connections") },
  { id: "act-invite",     group: "Actions", label: "Invite a teammate",       icon: Users, keywords: "preparer reviewer", run: (n) => n("/app/team") },
  { id: "act-company",    group: "Actions", label: "Switch / add company",    icon: Building2, keywords: "workspace org", run: (n) => n("/app/companies") },
]

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

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState("")
  const [active, setActive] = useState(0)
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)

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

  const results = useMemo(
    () => COMMANDS
      .map((c) => ({ c, s: score(c, q) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c),
    [q],
  )

  useEffect(() => { if (active >= results.length) setActive(0) }, [results.length, active])

  function run(cmd: Command) {
    setOpen(false)
    cmd.run(navigate)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)) }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
    else if (e.key === "Enter") { e.preventDefault(); const c = results[active]; if (c) run(c) }
    else if (e.key === "Escape") { setOpen(false) }
  }

  let lastGroup = ""

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
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
                placeholder="Jump to… or type a command"
                className="flex-1 bg-transparent outline-none py-3 text-sm"
                style={{ color: "var(--text)" }}
              />
              <kbd className="text-[10px] px-1.5 py-0.5 rounded"
                style={{ background: "var(--surface-2)", color: "var(--text-muted)", border: "1px solid var(--border)" }}>esc</kbd>
            </div>

            {/* Results */}
            <div className="max-h-[50vh] overflow-y-auto py-1.5">
              {results.length === 0 && (
                <p className="px-4 py-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>No matches.</p>
              )}
              {results.map((c, i) => {
                const Icon = c.icon
                const showGroup = c.group !== lastGroup
                lastGroup = c.group
                const isActive = i === active
                return (
                  <div key={c.id}>
                    {showGroup && (
                      <p className="px-4 pt-2 pb-1 text-[10px] font-bold uppercase tracking-wider"
                        style={{ color: "var(--text-muted)" }}>{c.group}</p>
                    )}
                    <button
                      onMouseEnter={() => setActive(i)}
                      onClick={() => run(c)}
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
              })}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
