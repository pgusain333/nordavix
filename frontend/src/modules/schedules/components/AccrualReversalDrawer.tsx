/**
 * AccrualReversalDrawer — right-to-left slide-in showing the full
 * lifecycle of one accrued expense item: original accrual JE, the
 * pairing reversal JE, status, days outstanding.
 *
 * Matches PrepaidAmortizationDrawer's chrome so the two slide-in
 * patterns feel consistent. No API call — everything is computed
 * from the item's existing fields.
 */
import { useMemo } from "react"
import { motion } from "framer-motion"
import { X, FileText, CheckCircle2, AlertCircle } from "lucide-react"
import type { AccrualItem } from "@/modules/schedules/types"

interface Props {
  item:     AccrualItem
  onClose:  () => void
}

function fmt(s: string | number): string {
  const n = typeof s === "string" ? parseFloat(s) : s
  return `$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function daysBetween(a: string, b: string): number {
  const da = new Date(a + "T00:00:00")
  const db = new Date(b + "T00:00:00")
  return Math.round((db.getTime() - da.getTime()) / 86_400_000)
}

export function AccrualReversalDrawer({ item, onClose }: Props) {
  const amount = parseFloat(item.amount) || 0
  const today = useMemo(() => new Date().toISOString().slice(0, 10), [])
  const isReversed = item.is_reversed ||
    (item.reverses_on !== null && item.reverses_on <= today)
  const reversalDate = item.reverses_on
  const daysOutstanding = isReversed
    ? (reversalDate ? daysBetween(item.accrual_date, reversalDate) : null)
    : daysBetween(item.accrual_date, today)

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
        className="fixed inset-0 z-40"
        style={{ background: "rgba(0,0,0,0.45)" }}
        onClick={onClose}
      />

      <motion.aside
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        exit={{ x: "100%" }}
        transition={{ type: "tween", duration: 0.25, ease: "easeOut" }}
        className="fixed inset-y-0 right-0 z-50 w-full sm:w-[600px] flex flex-col"
        style={{
          background: "var(--bg)",
          borderLeft: "1px solid var(--border)",
          boxShadow: "-12px 0 32px rgba(0,0,0,0.18)",
        }}
      >
        {/* Header */}
        <div className="px-5 py-4 flex items-start justify-between gap-3"
          style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1">
              <FileText size={15} strokeWidth={1.8} style={{ color: "#b45309" }} />
              <p className="text-[10px] font-semibold uppercase tracking-wider"
                style={{ color: "#b45309" }}>
                Accrual lifecycle
              </p>
              {isReversed ? (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold"
                  style={{ color: "var(--text-muted)" }}>
                  <CheckCircle2 size={10} strokeWidth={2.4} />
                  Reversed
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold"
                  style={{ color: "#b45309" }}>
                  <AlertCircle size={10} strokeWidth={2.4} />
                  Active
                </span>
              )}
            </div>
            <h2 className="text-base font-bold text-theme truncate">{item.description}</h2>
            <p className="text-[11px] mt-0.5" style={{ color: "var(--text-muted)" }}>
              {item.vendor ?? "—"}
              {item.reference && <span> · {item.reference}</span>}
            </p>
          </div>
          <button onClick={onClose}
            className="h-7 w-7 rounded-md flex items-center justify-center hover:bg-[var(--surface-2)]"
            style={{ color: "var(--text-muted)" }} title="Close">
            <X size={15} strokeWidth={1.8} />
          </button>
        </div>

        {/* Quick stats */}
        <div className="px-5 py-3 grid grid-cols-3 gap-3"
          style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
          <Kpi label="Amount" value={fmt(amount)} />
          <Kpi label="Accrued on" value={item.accrual_date} />
          <Kpi
            label={isReversed ? "Reversed on" : "Days outstanding"}
            value={
              isReversed
                ? (reversalDate ?? "—")
                : (daysOutstanding !== null ? `${daysOutstanding} day${daysOutstanding === 1 ? "" : "s"}` : "—")
            }
          />
        </div>

        {/* Body — scrollable */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Original accrual JE */}
          <section>
            <p className="text-[10px] font-semibold uppercase tracking-wider mb-2"
              style={{ color: "var(--text-muted)" }}>
              Journal entry · {item.accrual_date} (accrual)
            </p>
            <div className="rounded-lg overflow-hidden"
              style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
              <table className="w-full text-xs">
                <thead>
                  <tr style={{ background: "var(--surface-2)" }}>
                    <Th>Account</Th>
                    <Th right>Debit</Th>
                    <Th right>Credit</Th>
                  </tr>
                </thead>
                <tbody>
                  <tr style={{ borderTop: "1px solid var(--border)" }}>
                    <Td>Expense (P&amp;L)</Td>
                    <Td right tabular bold>{fmt(amount)}</Td>
                    <Td muted right>—</Td>
                  </tr>
                  <tr style={{ borderTop: "1px solid var(--border)" }}>
                    <Td indent>Accrued Liability (BS)</Td>
                    <Td muted right>—</Td>
                    <Td right tabular bold>{fmt(amount)}</Td>
                  </tr>
                </tbody>
              </table>
              <div className="px-3 py-2 text-[10px]"
                style={{ background: "var(--surface-2)", color: "var(--text-muted)", borderTop: "1px solid var(--border)" }}>
                Memo: accrue {item.description}
                {item.vendor && ` for ${item.vendor}`}.
              </div>
            </div>
          </section>

          {/* Reversal JE — only if reverses_on is set */}
          <section>
            <p className="text-[10px] font-semibold uppercase tracking-wider mb-2"
              style={{ color: "var(--text-muted)" }}>
              Journal entry · {reversalDate ?? "not scheduled"} (reversal)
            </p>
            {reversalDate ? (
              <div className="rounded-lg overflow-hidden"
                style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
                <table className="w-full text-xs">
                  <thead>
                    <tr style={{ background: "var(--surface-2)" }}>
                      <Th>Account</Th>
                      <Th right>Debit</Th>
                      <Th right>Credit</Th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr style={{ borderTop: "1px solid var(--border)" }}>
                      <Td>Accrued Liability (BS)</Td>
                      <Td right tabular bold>{fmt(amount)}</Td>
                      <Td muted right>—</Td>
                    </tr>
                    <tr style={{ borderTop: "1px solid var(--border)" }}>
                      <Td indent>Expense (P&amp;L) or Cash</Td>
                      <Td muted right>—</Td>
                      <Td right tabular bold>{fmt(amount)}</Td>
                    </tr>
                  </tbody>
                </table>
                <div className="px-3 py-2 text-[10px]"
                  style={{ background: "var(--surface-2)", color: "var(--text-muted)", borderTop: "1px solid var(--border)" }}>
                  Memo: reverse accrual booked {item.accrual_date}
                  {item.vendor && ` for ${item.vendor}`}.
                </div>
              </div>
            ) : (
              <div className="rounded-lg px-3 py-3 text-[11px]"
                style={{
                  background: "rgba(245, 158, 11, 0.08)",
                  border: "1px dashed rgba(245, 158, 11, 0.40)",
                  color: "#92400e",
                }}>
                No reversal date set. The accrual will stay on the books until you
                fill in <span className="font-semibold">Reverses on</span> (usually
                the date it gets paid) and re-commit the snapshot.
              </div>
            )}
          </section>

          {/* Lifecycle summary */}
          <section className="rounded-lg p-4"
            style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
            <p className="text-[10px] font-semibold uppercase tracking-wider mb-2"
              style={{ color: "var(--text-muted)" }}>
              Lifecycle
            </p>
            <ol className="text-xs space-y-1.5" style={{ color: "var(--text-2)" }}>
              <li>
                <span className="font-semibold text-theme">{item.accrual_date}</span> ·
                accrual booked — creates {fmt(amount)} liability
              </li>
              {reversalDate ? (
                <li>
                  <span className="font-semibold text-theme">{reversalDate}</span> ·
                  reversal — clears the liability
                  {!isReversed && (
                    <span className="ml-1 text-[10px] font-semibold"
                      style={{ color: "#b45309" }}>(upcoming)</span>
                  )}
                </li>
              ) : (
                <li>
                  <span className="font-semibold text-theme">—</span> ·
                  reversal not scheduled
                </li>
              )}
              <li>
                Net P&amp;L impact: <span className="font-semibold text-theme">$0</span>{" "}
                (assuming reversal lands in a later period than the accrual)
              </li>
            </ol>
          </section>
        </div>
      </motion.aside>
    </>
  )
}

// ── Helpers ────────────────────────────────────────────────────────────────

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider"
        style={{ color: "var(--text-muted)" }}>{label}</p>
      <p className="text-sm font-bold tabular-nums mt-0.5 text-theme">{value}</p>
    </div>
  )
}

function Th({ children, right }: { children?: React.ReactNode; right?: boolean }) {
  return (
    <th className={`px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide ${right ? "text-right" : "text-left"}`}
      style={{ color: "var(--text-muted)" }}>
      {children}
    </th>
  )
}

function Td({ children, right, tabular, bold, muted, indent }: {
  children?: React.ReactNode
  right?:    boolean
  tabular?:  boolean
  bold?:     boolean
  muted?:    boolean
  indent?:   boolean
}) {
  return (
    <td
      className={[
        "px-3 py-2",
        right   ? "text-right"     : "",
        tabular ? "tabular-nums"   : "",
        bold    ? "font-semibold"  : "",
        indent  ? "pl-6"           : "",
      ].filter(Boolean).join(" ")}
      style={{ color: muted ? "var(--text-muted)" : "var(--text)" }}
    >
      {children}
    </td>
  )
}
