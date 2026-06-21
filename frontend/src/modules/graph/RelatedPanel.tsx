/**
 * RelatedPanel — the first user-visible surface of the accounting knowledge
 * graph. Given an object (an account in the recon drawer), it shows everything
 * Nordavix has linked to it — the schedule that supports its reconciliation,
 * the GL-accuracy findings raised on it, the adjusting entries that explain or
 * affect it — grouped by relationship and resolved to real names.
 *
 * Self-contained: does its own query (lazy — mount only when the tab is open),
 * with premium loading / empty / error states. Theme-aware via CSS vars.
 */
import { useMemo } from "react"
import { Link } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { motion } from "framer-motion"
import {
  AlertTriangle,
  ArrowUpRight,
  BookOpen,
  Calendar,
  CalendarClock,
  CheckCircle2,
  GitCompareArrows,
  Landmark,
  MessageSquare,
  Network,
  Scale,
  type LucideIcon,
} from "lucide-react"

import { graphApi, type GraphNodeType, type RelatedItem } from "@/modules/graph/api"

interface Props {
  /** The object whose connections to show. */
  nodeType:  GraphNodeType
  nodeId:    string
  /** When nodeType is "account", folds in that account's reconciliation node. */
  periodEnd?: string
}

// Per-type icon + tint. Muted, low-chroma accents from the brand family (no
// rainbow) — each reads as a quiet accent on both cream and ink surfaces.
const TYPE_META: Record<string, { icon: LucideIcon; tint: string; bg: string }> = {
  account:        { icon: Landmark,         tint: "#2F6B66", bg: "rgba(47,107,102,0.12)" },
  journal_entry:  { icon: BookOpen,         tint: "#3C5A76", bg: "rgba(60,90,118,0.12)" },
  finding:        { icon: AlertTriangle,    tint: "#96702F", bg: "rgba(150,112,47,0.13)" },
  schedule:       { icon: CalendarClock,    tint: "#2E7A55", bg: "rgba(46,122,85,0.12)" },
  reconciliation: { icon: Scale,            tint: "#2E7A55", bg: "rgba(46,122,85,0.12)" },
  flux_variance:  { icon: GitCompareArrows, tint: "#96702F", bg: "rgba(150,112,47,0.12)" },
  task:           { icon: CheckCircle2,     tint: "#3C5A76", bg: "rgba(60,90,118,0.12)" },
  memo:           { icon: MessageSquare,    tint: "#5C6660", bg: "rgba(92,102,96,0.12)" },
  period:         { icon: Calendar,         tint: "#5C6660", bg: "rgba(92,102,96,0.12)" },
}

function typeMeta(t: string) {
  return TYPE_META[t] ?? { icon: Network, tint: "#5C6660", bg: "rgba(92,102,96,0.12)" }
}

const STATUS_CHIP: Record<string, { label: string; color: string; bg: string }> = {
  open:            { label: "Open",           color: "#8a6326", bg: "rgba(150,112,47,0.13)" },
  accepted:        { label: "Accepted",       color: "var(--green)", bg: "var(--green-subtle)" },
  posted:          { label: "Posted",         color: "var(--green)", bg: "var(--green-subtle)" },
  in_adjustments:  { label: "In adjustments", color: "#3C5A76", bg: "rgba(60,90,118,0.13)" },
  dismissed:       { label: "Dismissed",      color: "var(--text-muted)", bg: "rgba(92,102,96,0.13)" },
}

export function RelatedPanel({ nodeType, nodeId, periodEnd }: Props) {
  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ["graph", "related", nodeType, nodeId, periodEnd],
    queryFn:  () => graphApi.related(nodeType, nodeId, periodEnd),
    staleTime: 30_000,
  })

  const total = data?.total ?? 0

  // A one-line "2 findings · 1 schedule · 3 entries" summary across all groups.
  const typeCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const g of data?.groups ?? []) {
      for (const it of g.items) counts.set(it.type, (counts.get(it.type) ?? 0) + 1)
    }
    return [...counts.entries()]
  }, [data])

  if (isLoading) return <RelatedSkeleton />

  if (isError) {
    return (
      <div className="rounded-xl p-6 text-center" style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
        <p className="text-sm font-semibold text-theme mb-1">Couldn't load connections</p>
        <p className="text-xs mb-3" style={{ color: "var(--text-muted)" }}>The knowledge graph is briefly unavailable.</p>
        <button onClick={() => refetch()}
          className="text-xs font-semibold rounded-md px-3 py-1.5"
          style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
          Try again
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="flex items-start gap-3">
        <span className="h-10 w-10 rounded-xl flex items-center justify-center shrink-0"
          style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
          <Network size={19} strokeWidth={1.8} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-bold text-theme">Related</h3>
            {total > 0 && (
              <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full tabular-nums"
                style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
                {total} connected
              </span>
            )}
          </div>
          <p className="text-[12px] mt-0.5 leading-snug" style={{ color: "var(--text-muted)" }}>
            How this account connects across your close — its schedule, findings, and adjusting entries.
          </p>
          {typeCounts.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
              {typeCounts.map(([t, n], i) => {
                const m = typeMeta(t)
                const Icon = m.icon
                return (
                  <span key={t} className="inline-flex items-center gap-1 text-[11px]" style={{ color: "var(--text-2)" }}>
                    {i > 0 && <span aria-hidden style={{ color: "var(--text-muted)", marginRight: 2 }}>·</span>}
                    <Icon size={11} strokeWidth={2} style={{ color: m.tint }} />
                    <span className="tabular-nums font-semibold">{n}</span>
                    <span style={{ color: "var(--text-muted)" }}>{labelForType(t, n)}</span>
                  </span>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── Groups ─────────────────────────────────────────────────── */}
      {total === 0 ? (
        <RelatedEmpty />
      ) : (
        <div className="space-y-3.5">
          {data!.groups.map((group, gi) => (
            <motion.div
              key={group.relation}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.22, delay: Math.min(gi * 0.04, 0.2) }}
            >
              <div className="flex items-center gap-2 mb-1.5 px-0.5">
                <span className="text-[10px] font-bold uppercase tracking-[0.08em]" style={{ color: "var(--text-muted)" }}>
                  {group.label}
                </span>
                <span className="text-[10px] tabular-nums" style={{ color: "var(--text-muted)" }}>· {group.items.length}</span>
                <span className="flex-1 h-px" style={{ background: "var(--border)" }} />
              </div>
              <div className="rounded-xl overflow-hidden" style={{ border: "1px solid var(--border)" }}>
                {group.items.map((item, i) => (
                  <RelatedRow key={`${item.type}:${item.id}`} item={item} first={i === 0} />
                ))}
              </div>
            </motion.div>
          ))}
          {isFetching && (
            <p className="text-[10px] text-center" style={{ color: "var(--text-muted)" }}>Refreshing…</p>
          )}
        </div>
      )}
    </div>
  )
}

// ── Row ──────────────────────────────────────────────────────────────

function RelatedRow({ item, first }: { item: RelatedItem; first: boolean }) {
  const m = typeMeta(item.type)
  const Icon = m.icon
  const chip = item.status ? STATUS_CHIP[item.status] : undefined

  const inner = (
    <>
      <span className="h-8 w-8 rounded-lg flex items-center justify-center shrink-0"
        style={{ background: m.bg, color: m.tint }}>
        <Icon size={15} strokeWidth={1.9} />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-[13px] font-medium truncate text-theme">{item.label}</span>
        {item.sublabel && (
          <span className="block text-[11px] truncate" style={{ color: "var(--text-muted)" }}>{item.sublabel}</span>
        )}
      </span>
      {chip && (
        <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full shrink-0"
          style={{ background: chip.bg, color: chip.color }}>
          {chip.label}
        </span>
      )}
      {item.href && (
        <ArrowUpRight size={14} strokeWidth={2} className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ color: "var(--text-muted)" }} />
      )}
    </>
  )

  const rowClass = "group w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors"
  const rowStyle = { borderTop: first ? undefined : "1px solid var(--border)", background: "transparent" }
  const hoverOn = (e: React.MouseEvent<HTMLElement>) => { (e.currentTarget as HTMLElement).style.background = "var(--surface-2)" }
  const hoverOff = (e: React.MouseEvent<HTMLElement>) => { (e.currentTarget as HTMLElement).style.background = "transparent" }

  if (item.href) {
    return (
      <Link to={item.href} className={rowClass} style={rowStyle} onMouseEnter={hoverOn} onMouseLeave={hoverOff}>
        {inner}
      </Link>
    )
  }
  return (
    <div className={rowClass} style={rowStyle} onMouseEnter={hoverOn} onMouseLeave={hoverOff}>
      {inner}
    </div>
  )
}

// ── Empty + loading ──────────────────────────────────────────────────

function RelatedEmpty() {
  return (
    <div className="rounded-2xl px-6 py-10 text-center" style={{ background: "var(--surface-2)", border: "1px dashed var(--border-strong)" }}>
      <div className="h-12 w-12 mx-auto rounded-xl flex items-center justify-center mb-3"
        style={{ background: "var(--surface)", color: "var(--text-muted)", border: "1px solid var(--border)" }}>
        <Network size={22} strokeWidth={1.5} />
      </div>
      <p className="text-sm font-semibold text-theme mb-1">No connections yet</p>
      <p className="text-xs max-w-xs mx-auto leading-relaxed" style={{ color: "var(--text-muted)" }}>
        As you reconcile this account, accept adjusting entries, and run AI checks, Nordavix
        links the related work here — so the full story behind the balance is one glance away.
      </p>
    </div>
  )
}

function RelatedSkeleton() {
  return (
    <div className="space-y-4" aria-hidden>
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-xl animate-pulse" style={{ background: "var(--surface-2)" }} />
        <div className="flex-1 space-y-2">
          <div className="h-3 w-24 rounded animate-pulse" style={{ background: "var(--surface-2)" }} />
          <div className="h-2.5 w-48 rounded animate-pulse" style={{ background: "var(--surface-2)" }} />
        </div>
      </div>
      {[0, 1].map((g) => (
        <div key={g} className="space-y-2">
          <div className="h-2.5 w-20 rounded animate-pulse" style={{ background: "var(--surface-2)" }} />
          <div className="rounded-xl overflow-hidden" style={{ border: "1px solid var(--border)" }}>
            {[0, 1].map((r) => (
              <div key={r} className="flex items-center gap-3 px-3 py-2.5"
                style={{ borderTop: r === 0 ? undefined : "1px solid var(--border)" }}>
                <div className="h-8 w-8 rounded-lg animate-pulse" style={{ background: "var(--surface-2)" }} />
                <div className="flex-1 space-y-1.5">
                  <div className="h-2.5 w-2/3 rounded animate-pulse" style={{ background: "var(--surface-2)" }} />
                  <div className="h-2 w-1/3 rounded animate-pulse" style={{ background: "var(--surface-2)" }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── helpers ──────────────────────────────────────────────────────────

function labelForType(t: string, n: number): string {
  const singular: Record<string, string> = {
    account: "account", journal_entry: "entry", finding: "finding", schedule: "schedule",
    reconciliation: "reconciliation", flux_variance: "variance", task: "task", memo: "memo", period: "period",
  }
  const word = singular[t] ?? t.replace("_", " ")
  if (n === 1) return word
  // simple pluralization fit for our nouns
  return word.endsWith("y") ? `${word.slice(0, -1)}ies` : `${word}s`
}
