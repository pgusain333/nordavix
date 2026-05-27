/**
 * Renders the Nordavix SOP / Help content from the shared content module.
 *
 * Both wrappers (in-app /app/help and public /help) use this same
 * component — they only differ in the page chrome around it
 * (sidebar / footer / theme handling). Keeping the rendering here
 * means the SOP layout stays consistent in both surfaces.
 *
 * Layout: sticky left TOC + scrollable content area on the right.
 * Active section in the TOC tracks the user's scroll position via
 * IntersectionObserver. Each section is one anchored block so
 * deep-links (e.g. /help#close-ceremony) jump straight there.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { motion } from "framer-motion"
import {
  BookOpen,
  ChevronRight,
  Info,
  Lightbulb,
  AlertTriangle,
  ShieldAlert,
  Hash,
} from "lucide-react"

import { HELP_SECTIONS, type Block, type Section, type SubSection } from "./content"

// ── Public component ────────────────────────────────────────────────────────

interface Props {
  /** When true, anchor links push to history (so back/forward works
   *  cleanly in the marketing site). The in-app variant uses replaceState
   *  to avoid polluting the React Router history stack. */
  publicMode?: boolean
}

export function HelpContent({ publicMode = false }: Props) {
  const [activeId, setActiveId] = useState<string>(HELP_SECTIONS[0]?.id ?? "")
  const contentRef = useRef<HTMLDivElement | null>(null)

  // Build a flat lookup of every anchor (section + subsection) so the
  // observer can map an in-view element ID back to a section ID.
  const sectionIdsBySub = useMemo(() => {
    const map = new Map<string, string>()
    for (const s of HELP_SECTIONS) {
      map.set(s.id, s.id)
      for (const sub of s.subSections) map.set(sub.id, s.id)
    }
    return map
  }, [])

  // Highlight whichever section header is closest to the top of the
  // viewport. rootMargin biases the activation toward the upper third
  // so the TOC feels predictive, not lagging.
  useEffect(() => {
    const root = contentRef.current
    if (!root) return
    const headers = root.querySelectorAll<HTMLElement>("[data-help-anchor]")
    if (headers.length === 0) return

    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (visible.length === 0) return
        const id = visible[0].target.getAttribute("data-help-anchor")
        if (!id) return
        const sectionId = sectionIdsBySub.get(id) ?? id
        setActiveId(sectionId)
      },
      { rootMargin: "-15% 0px -65% 0px", threshold: 0 },
    )
    headers.forEach((el) => obs.observe(el))
    return () => obs.disconnect()
  }, [sectionIdsBySub])

  // Jump to the hash on initial mount (and any later hash change so
  // clicking a TOC link does the right thing).
  useEffect(() => {
    function jumpToHash() {
      const id = window.location.hash.replace("#", "")
      if (!id) return
      const el = document.getElementById(id)
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" })
    }
    jumpToHash()
    window.addEventListener("hashchange", jumpToHash)
    return () => window.removeEventListener("hashchange", jumpToHash)
  }, [])

  function handleNavClick(e: React.MouseEvent<HTMLAnchorElement>, id: string) {
    e.preventDefault()
    const el = document.getElementById(id)
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" })
    // Update the URL so the section is shareable / refresh-friendly.
    if (publicMode) {
      window.history.pushState(null, "", `#${id}`)
    } else {
      window.history.replaceState(null, "", `#${id}`)
    }
    setActiveId(id)
  }

  return (
    <div className="flex flex-col lg:flex-row gap-8 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* ── Left: sticky TOC ───────────────────────────────────────── */}
      <aside className="lg:w-64 shrink-0 lg:sticky lg:top-6 lg:self-start lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto">
        <div className="rounded-xl p-4"
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            boxShadow: "var(--card-shadow)",
          }}>
          <div className="flex items-center gap-2 mb-3">
            <BookOpen size={14} strokeWidth={1.8} style={{ color: "var(--green)" }} />
            <h2 className="text-[10px] font-bold uppercase tracking-wider"
              style={{ color: "var(--text-muted)" }}>
              Standard Operating Procedure
            </h2>
          </div>
          <nav className="space-y-0.5">
            {HELP_SECTIONS.map((s) => {
              const isActive = activeId === s.id
              return (
                <a
                  key={s.id}
                  href={`#${s.id}`}
                  onClick={(e) => handleNavClick(e, s.id)}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors"
                  style={{
                    background: isActive ? "var(--green-subtle)" : "transparent",
                    color:      isActive ? "var(--green)"        : "var(--text-2)",
                    fontWeight: isActive ? 600 : 500,
                  }}
                  title={s.summary}
                >
                  <span
                    className="inline-flex items-center justify-center h-5 w-5 rounded text-[10px] font-bold tabular-nums shrink-0"
                    style={{
                      background: isActive ? "var(--green)" : "var(--surface-2)",
                      color:      isActive ? "white"        : "var(--text-muted)",
                    }}
                  >
                    {s.number}
                  </span>
                  <span className="flex-1 truncate">{s.title}</span>
                  {isActive && <ChevronRight size={12} strokeWidth={2.2} />}
                </a>
              )
            })}
          </nav>
        </div>

        {/* Sub-card: quick contact */}
        <div className="rounded-xl p-4 mt-3 text-xs"
          style={{
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            color: "var(--text-muted)",
          }}>
          <p className="font-semibold text-theme mb-1">Need a human?</p>
          <p className="mb-2">
            Reach the founders directly during Beta — we usually reply within
            one business day.
          </p>
          <a href="mailto:hello@nordavix.com"
            className="inline-flex items-center gap-1 font-semibold"
            style={{ color: "var(--green)" }}>
            hello@nordavix.com
            <ChevronRight size={11} strokeWidth={2} />
          </a>
        </div>
      </aside>

      {/* ── Right: content ────────────────────────────────────────── */}
      <div ref={contentRef} className="flex-1 min-w-0 space-y-12">
        {HELP_SECTIONS.map((section) => (
          <SectionView key={section.id} section={section} onAnchor={handleNavClick} />
        ))}
      </div>
    </div>
  )
}

// ── Section ────────────────────────────────────────────────────────────────

function SectionView({
  section, onAnchor,
}: {
  section: Section
  onAnchor: (e: React.MouseEvent<HTMLAnchorElement>, id: string) => void
}) {
  return (
    <motion.section
      id={section.id}
      data-help-anchor={section.id}
      initial={{ opacity: 0, y: 8 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-10% 0px" }}
      transition={{ duration: 0.25 }}
      className="scroll-mt-6"
    >
      {/* Section header */}
      <div className="flex items-baseline gap-3 mb-2">
        <span className="text-[11px] font-bold tabular-nums uppercase tracking-wider"
          style={{ color: "var(--green)" }}>
          Section {section.number}
        </span>
        <a href={`#${section.id}`} onClick={(e) => onAnchor(e, section.id)}
          className="inline-flex items-center gap-1 opacity-0 hover:opacity-100 transition-opacity"
          title="Copy link to this section"
          style={{ color: "var(--text-muted)" }}>
          <Hash size={11} strokeWidth={2} />
        </a>
      </div>
      <h2 className="text-2xl sm:text-3xl font-bold text-theme leading-tight mb-1"
        style={{ letterSpacing: "-0.01em" }}>
        {section.title}
      </h2>
      <p className="text-sm mb-6" style={{ color: "var(--text-muted)" }}>{section.summary}</p>

      {/* Subsections */}
      <div className="space-y-8">
        {section.subSections.map((sub) => (
          <SubSectionView key={sub.id} sub={sub} onAnchor={onAnchor} />
        ))}
      </div>
    </motion.section>
  )
}

function SubSectionView({
  sub, onAnchor,
}: {
  sub: SubSection
  onAnchor: (e: React.MouseEvent<HTMLAnchorElement>, id: string) => void
}) {
  return (
    <div id={sub.id} data-help-anchor={sub.id} className="scroll-mt-6">
      <h3 className="text-lg font-bold text-theme mb-3 flex items-center gap-2 group">
        {sub.title}
        <a href={`#${sub.id}`} onClick={(e) => onAnchor(e, sub.id)}
          className="opacity-0 group-hover:opacity-100 transition-opacity"
          title="Copy link to this subsection"
          style={{ color: "var(--text-muted)" }}>
          <Hash size={12} strokeWidth={2} />
        </a>
      </h3>
      <div className="space-y-3">
        {sub.blocks.map((block, i) => (
          <BlockView key={i} block={block} />
        ))}
      </div>
    </div>
  )
}

// ── Blocks ────────────────────────────────────────────────────────────────

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case "p":
      return (
        <p className="text-sm sm:text-[15px] leading-relaxed" style={{ color: "var(--text)" }}>
          {block.text}
        </p>
      )

    case "steps":
      return (
        <ol className="space-y-2.5 pl-0">
          {block.items.map((item, i) => (
            <li key={i} className="flex gap-3 text-sm leading-relaxed">
              <span className="inline-flex items-center justify-center h-6 w-6 rounded-full text-[11px] font-bold tabular-nums shrink-0"
                style={{
                  background: "var(--green-subtle)",
                  color: "var(--green)",
                  border: "1px solid var(--green)",
                }}>
                {i + 1}
              </span>
              <span style={{ color: "var(--text)" }} className="pt-0.5">{item}</span>
            </li>
          ))}
        </ol>
      )

    case "bullets":
      return (
        <ul className="space-y-1.5">
          {block.items.map((item, i) => (
            <li key={i} className="flex items-start gap-2 text-sm leading-relaxed">
              <span className="text-[12px] mt-1" style={{ color: "var(--green)" }}>▸</span>
              <span style={{ color: "var(--text)" }}>{item}</span>
            </li>
          ))}
        </ul>
      )

    case "callout": {
      const meta = CALLOUT_META[block.tone]
      const Icon = meta.icon
      return (
        <div className="rounded-lg p-3 sm:p-4 flex items-start gap-3"
          style={{
            background: meta.bg,
            border: `1px solid ${meta.border}`,
          }}>
          <Icon size={16} strokeWidth={2}
            className="shrink-0 mt-0.5" style={{ color: meta.fg }} />
          <div className="flex-1 min-w-0 space-y-1">
            {block.title && (
              <p className="text-[11px] font-bold uppercase tracking-wider"
                style={{ color: meta.fg }}>
                {block.title}
              </p>
            )}
            <p className="text-sm leading-relaxed" style={{ color: "var(--text)" }}>
              {block.text}
            </p>
          </div>
        </div>
      )
    }

    case "table":
      return (
        <div className="overflow-x-auto rounded-lg"
          style={{ border: "1px solid var(--border)" }}>
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: "var(--surface-2)" }}>
                {block.columns.map((c) => (
                  <th key={c} className="text-left px-3 py-2 text-[11px] font-bold uppercase tracking-wide"
                    style={{ color: "var(--text-muted)" }}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, ri) => (
                <tr key={ri} style={{ borderTop: "1px solid var(--border)" }}>
                  {row.map((cell, ci) => (
                    <td key={ci} className="px-3 py-2 align-top"
                      style={{ color: ci === 0 ? "var(--text)" : "var(--text-2)" }}>
                      {ci === 0 ? <span className="font-semibold">{cell}</span> : cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )

    case "code":
      return (
        <pre className="rounded-md p-3 overflow-x-auto text-xs font-mono"
          style={{
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            color: "var(--text-2)",
          }}>
          <code>{block.text}</code>
        </pre>
      )
  }
}

// Callout palette — info (blue), tip (green), warning (amber), important (red)
const CALLOUT_META = {
  info:      { icon: Info,        fg: "#1d4ed8",         bg: "#dbeafe",                 border: "#bfdbfe" },
  tip:       { icon: Lightbulb,   fg: "var(--green)",    bg: "var(--green-subtle)",     border: "var(--green)" },
  warning:   { icon: AlertTriangle,fg: "#b45309",         bg: "#fef3c7",                 border: "#fcd34d" },
  important: { icon: ShieldAlert, fg: "#b91c1c",         bg: "#fef2f2",                 border: "#fecaca" },
} as const
