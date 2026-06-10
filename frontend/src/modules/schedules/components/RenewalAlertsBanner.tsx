/**
 * RenewalAlertsBanner — surfaces prepaid items needing attention this
 * period. Two buckets, colored by urgency:
 *
 *   • Expiring soon (next 60 days)   — amber  · prompt to add renewal
 *   • Past end-date (still active)   — red    · prompt to mark closed or
 *                                              re-up
 *
 * Empty state: renders nothing (no "all clear" banner — would be visual
 * noise on most months when nothing needs attention).
 *
 * Each row has explicit actions:
 *   [ Add renewal ]    — opens the New Prepaid dialog pre-filled from
 *                        the expiring item (same vendor / account /
 *                        amount → new term).
 *   [ Mark closed ]    — PUT updateItem with is_active=false. Item
 *                        leaves the alerts list and the active schedule.
 *   [ Snooze ]         — local-only dismiss for the current session
 *                        (sessionStorage). Use when the user has the
 *                        renewal in hand but isn't ready to add it yet.
 *
 * The "Snooze" is intentionally NOT persisted server-side. The next
 * session re-surfaces the alert so nothing slips. If the user wants
 * to silence permanently they mark closed (real action) or extend the
 * end date (real action).
 */
import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { motion, AnimatePresence } from "framer-motion"
import { useOrganization } from "@clerk/clerk-react"
import {
  AlertTriangle, Bell, CheckCircle2, Clock, RefreshCw, X,
} from "lucide-react"

import { Spinner } from "@/core/ui/components"
import { formatDate } from "@/core/lib/dates"
import { schedulesApi } from "@/modules/schedules/api"
import type { PrepaidAlertItem, PrepaidItem } from "@/modules/schedules/types"

interface Props {
  periodEnd: string
  /** Called when user clicks "Add renewal" — caller opens the New
   * Prepaid dialog pre-filled with the prior item's data. */
  onAddRenewal: (priorItem: PrepaidAlertItem) => void
}

function snoozeKey(orgId: string | undefined): string {
  return `nordavix:prepaid:snoozed:${orgId ?? "anon"}`
}

function readSnoozed(orgId: string | undefined): Set<string> {
  try {
    const raw = sessionStorage.getItem(snoozeKey(orgId))
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch { return new Set() }
}

function writeSnoozed(orgId: string | undefined, ids: Set<string>): void {
  try { sessionStorage.setItem(snoozeKey(orgId), JSON.stringify(Array.from(ids))) }
  catch { /* harmless */ }
}

export function RenewalAlertsBanner({ periodEnd, onAddRenewal }: Props) {
  const { organization } = useOrganization()
  const qc = useQueryClient()
  const [snoozed, setSnoozed] = useState<Set<string>>(() => readSnoozed(organization?.id))
  const [collapsed, setCollapsed] = useState(false)

  // Refresh snoozed set if org changes mid-session
  useEffect(() => { setSnoozed(readSnoozed(organization?.id)) }, [organization?.id])

  const { data, isLoading } = useQuery({
    queryKey: ["schedules", "prepaid", "alerts", periodEnd],
    queryFn:  () => schedulesApi.getPrepaidAlerts(periodEnd),
    // 1-min stale: alerts don't change frequently within a session,
    // but we re-fetch when the user adds / closes an item via the
    // explicit invalidate on mutation success below.
    staleTime: 60_000,
  })

  const closeMut = useMutation({
    mutationFn: (id: string) => schedulesApi.updateItem("prepaid", id, { is_active: false } as Partial<PrepaidItem>),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["schedules"] })
    },
  })

  const visible = useMemo(() => {
    const filter = (arr: PrepaidAlertItem[]) => arr.filter((i) => !snoozed.has(i.id))
    return {
      expiring: filter(data?.expiring_soon ?? []),
      past:     filter(data?.past_due       ?? []),
    }
  }, [data, snoozed])

  function snooze(id: string) {
    const next = new Set(snoozed)
    next.add(id)
    setSnoozed(next)
    writeSnoozed(organization?.id, next)
  }

  // ── Empty/loading early-outs ──────────────────────────────────────────
  if (isLoading) return null  // banner appears once data is in; avoid layout shift
  const totalVisible = visible.expiring.length + visible.past.length
  if (totalVisible === 0) return null

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      className="rounded-xl overflow-hidden"
      style={{
        background: "var(--surface)",
        border: `1px solid ${visible.past.length > 0 ? "#ecd7d3" : "#fed7aa"}`,
        boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
      }}
    >
      {/* Header */}
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="w-full px-4 py-3 flex items-center gap-3 text-left transition-colors hover:bg-[var(--surface-2)]"
        style={{ background: visible.past.length > 0 ? "#f7eeec" : "#f7f1e6" }}
      >
        <span className="h-7 w-7 rounded-lg inline-flex items-center justify-center shrink-0"
          style={{
            background: visible.past.length > 0 ? "#f4e9e7" : "#ffedd5",
            color: visible.past.length > 0 ? "#9b3d37" : "#c2410c",
          }}>
          <Bell size={13} strokeWidth={2} />
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold" style={{ color: visible.past.length > 0 ? "#7f1d1d" : "#7c2d12" }}>
            {totalVisible} prepaid {totalVisible === 1 ? "item needs" : "items need"} attention
          </p>
          <p className="text-[11px]" style={{ color: visible.past.length > 0 ? "#86332e" : "#9a3412" }}>
            {visible.past.length > 0 && (
              <>
                <span className="font-semibold">{visible.past.length} past end-date</span>
                {visible.expiring.length > 0 && " · "}
              </>
            )}
            {visible.expiring.length > 0 && (
              <>{visible.expiring.length} expiring in next {data?.expiring_within_days ?? 60} days</>
            )}
          </p>
        </div>
        <span className="text-[11px] font-medium uppercase tracking-wider px-2"
          style={{ color: visible.past.length > 0 ? "#86332e" : "#9a3412" }}>
          {collapsed ? "Show" : "Hide"}
        </span>
      </button>

      {/* Body */}
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            style={{ overflow: "hidden" }}
          >
            <div className="px-4 pb-3 pt-1 space-y-3">
              {visible.past.length > 0 && (
                <AlertGroup
                  label="Past end-date — still active"
                  tone="danger"
                  items={visible.past}
                  onAddRenewal={onAddRenewal}
                  onMarkClosed={(id) => closeMut.mutate(id)}
                  onSnooze={snooze}
                  closing={closeMut.isPending ? closeMut.variables : null}
                />
              )}
              {visible.expiring.length > 0 && (
                <AlertGroup
                  label={`Expiring within ${data?.expiring_within_days ?? 60} days`}
                  tone="warning"
                  items={visible.expiring}
                  onAddRenewal={onAddRenewal}
                  onMarkClosed={(id) => closeMut.mutate(id)}
                  onSnooze={snooze}
                  closing={closeMut.isPending ? closeMut.variables : null}
                />
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

// ── Subcomponents ───────────────────────────────────────────────────────

function AlertGroup({
  label, tone, items, onAddRenewal, onMarkClosed, onSnooze, closing,
}: {
  label: string
  tone: "warning" | "danger"
  items: PrepaidAlertItem[]
  onAddRenewal: (item: PrepaidAlertItem) => void
  onMarkClosed: (id: string) => void
  onSnooze:     (id: string) => void
  closing:      string | null | undefined
}) {
  const headerColor = tone === "danger" ? "#7f1d1d" : "#7c2d12"
  return (
    <div>
      <p className="text-[10px] font-bold uppercase tracking-wider mb-1.5"
        style={{ color: headerColor }}>
        {label}
      </p>
      <div className="space-y-1.5">
        {items.map((item) => (
          <AlertRow
            key={item.id}
            item={item}
            tone={tone}
            isClosing={closing === item.id}
            onAddRenewal={() => onAddRenewal(item)}
            onMarkClosed={() => onMarkClosed(item.id)}
            onSnooze={() => onSnooze(item.id)}
          />
        ))}
      </div>
    </div>
  )
}

function AlertRow({
  item, tone, isClosing, onAddRenewal, onMarkClosed, onSnooze,
}: {
  item: PrepaidAlertItem
  tone: "warning" | "danger"
  isClosing: boolean
  onAddRenewal: () => void
  onMarkClosed: () => void
  onSnooze:     () => void
}) {
  const accentBg = tone === "danger" ? "#fff1f2" : "#f8f4e9"
  const accentBd = tone === "danger" ? "#fecdd3" : "#e8d9b0"
  const amount = parseFloat(item.total_amount) || 0
  const amountFmt = `$${amount.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`

  // Days-to-end phrasing
  let daysLabel: string
  if (item.days_to_end > 0) {
    daysLabel = item.days_to_end === 1 ? "ends tomorrow" : `ends in ${item.days_to_end} days`
  } else if (item.days_to_end === 0) {
    daysLabel = "ends today"
  } else {
    const ago = Math.abs(item.days_to_end)
    daysLabel = ago === 1 ? "ended yesterday" : `ended ${ago} days ago`
  }

  return (
    <div className="rounded-lg p-3"
      style={{ background: accentBg, border: `1px solid ${accentBd}` }}>
      <div className="flex items-start gap-3 flex-wrap sm:flex-nowrap">
        <span className="h-7 w-7 rounded-md inline-flex items-center justify-center shrink-0 mt-0.5"
          style={{ background: "white", color: tone === "danger" ? "#9b3d37" : "#c2410c" }}>
          {tone === "danger" ? <AlertTriangle size={12} strokeWidth={2} /> : <Clock size={12} strokeWidth={2} />}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold truncate" style={{ color: "var(--text)" }}>
              {item.vendor || item.description}
            </p>
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded"
              style={{ background: "white", color: "var(--text-muted)", border: "1px solid var(--border)" }}>
              {amountFmt}
            </span>
          </div>
          <p className="text-[11px] truncate" style={{ color: "var(--text-2)" }}>
            {item.vendor ? item.description : ""}{item.vendor ? " · " : ""}
            {item.reference ? `${item.reference} · ` : ""}
            {formatDate(item.start_date)} → {formatDate(item.end_date)}
            <span className="font-semibold" style={{ color: tone === "danger" ? "#9b3d37" : "#c2410c" }}>
              {" · "}{daysLabel}
            </span>
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={onAddRenewal}
            disabled={isClosing}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[11px] font-semibold transition-opacity hover:opacity-90 disabled:opacity-40"
            style={{ background: "var(--green)", color: "white" }}
            title="Open New Prepaid dialog pre-filled with this item"
          >
            <RefreshCw size={11} strokeWidth={2} /> Add renewal
          </button>
          <button
            type="button"
            onClick={onMarkClosed}
            disabled={isClosing}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[11px] font-semibold transition-colors disabled:opacity-40"
            style={{ background: "white", color: "var(--text-2)", border: "1px solid var(--border)" }}
            title="Mark this prepaid inactive — drops from active schedule"
          >
            {isClosing ? <Spinner className="h-3 w-3" /> : <CheckCircle2 size={11} strokeWidth={2} />}
            Mark closed
          </button>
          <button
            type="button"
            onClick={onSnooze}
            disabled={isClosing}
            className="inline-flex items-center justify-center h-7 w-7 rounded-md transition-colors disabled:opacity-40"
            style={{ color: "var(--text-muted)" }}
            title="Hide for this session only — re-surfaces next time"
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "white" }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent" }}
          >
            <X size={12} strokeWidth={2} />
          </button>
        </div>
      </div>
    </div>
  )
}
