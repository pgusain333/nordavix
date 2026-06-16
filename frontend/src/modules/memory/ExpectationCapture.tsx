/**
 * Teach NDVX — capture a recurring *expectation* for an account, shared by the
 * flux variance drawer and the recon account drawer. The user sets the cadence,
 * the expected amount + a tolerance band, and the reason in their own words. It
 * creates a SUGGESTED Client-Memory fact only (confirm-first); a reviewer confirms
 * it in Settings → Memory, after which NDVX pre-explains the account next period
 * when it lands within the band — and still flags it when it deviates.
 *
 * Presentational + stateful: the parent passes prefills + an `onSave` that does the
 * actual API call (so the same form serves both flux and recon).
 */
import { useState, type ReactNode } from "react"
import { Lightbulb } from "lucide-react"

/** Titled card chrome matching the flux + recon detail drawers (which each define
 *  their own local Card). Kept local so this shared component stays self-contained. */
function Card({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-xl p-3" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <div className="flex items-center gap-1.5 mb-2 text-[10px] font-semibold uppercase tracking-wider"
        style={{ color: "var(--text-muted)" }}>
        {icon}
        {title}
      </div>
      {children}
    </div>
  )
}

export type Cadence = "monthly" | "quarterly" | "annual" | "one_off"

export interface ExpectationPayload {
  recurrence:     Cadence
  expected_amount: number
  tolerance_mode: "pct" | "abs"
  tolerance_pct?: number
  tolerance_abs?: number
  explanation:    string
}

const CADENCES: { value: Cadence; label: string }[] = [
  { value: "monthly",   label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "annual",    label: "Annual" },
  { value: "one_off",   label: "One-off" },
]

export function ExpectationCapture({
  defaultExpected,
  defaultReason,
  disabled,
  onSave,
}: {
  /** Prefill for the expected amount (the account's current balance). */
  defaultExpected?: string | number | null
  /** Prefill for the reason (AI commentary / narrative); user can edit. */
  defaultReason?: string | null
  /** Hide entirely (read-only / closed period). */
  disabled?: boolean
  onSave: (p: ExpectationPayload) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [recurrence, setRecurrence] = useState<Cadence>("monthly")
  const [expected, setExpected] = useState(
    defaultExpected == null ? "" : String(defaultExpected),
  )
  const [tolMode, setTolMode] = useState<"pct" | "abs">("pct")
  const [tolerance, setTolerance] = useState("15")
  const [reason, setReason] = useState((defaultReason || "").trim())
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  if (disabled) return null

  async function save() {
    const amt = parseFloat(expected)
    if (!Number.isFinite(amt)) {
      setErr("Enter the expected amount.")
      return
    }
    if (!reason.trim()) {
      setErr("Add a short reason so NDVX knows why this recurs.")
      return
    }
    const tol = parseFloat(tolerance)
    const payload: ExpectationPayload = {
      recurrence,
      expected_amount: amt,
      tolerance_mode: tolMode,
      explanation: reason.trim(),
    }
    if (tolMode === "abs") payload.tolerance_abs = Math.max(0, Number.isFinite(tol) ? tol : 0)
    else payload.tolerance_pct = Math.max(1, Math.min(200, Number.isFinite(tol) ? tol : 15))

    setSaving(true)
    setErr(null)
    try {
      await onSave(payload)
      setSaved(true)
      setOpen(false)
    } catch {
      setErr("Couldn't save — please try again.")
    } finally {
      setSaving(false)
    }
  }

  if (saved) {
    return (
      <Card title="Recurring expectation" icon={<Lightbulb size={13} strokeWidth={1.8} />}>
        <p className="text-[12px]" style={{ color: "var(--text)" }}>
          Saved as a suggestion. A reviewer can confirm it in <strong>Settings → Memory</strong>; once
          confirmed, NDVX pre-explains this account next period when it lands as expected — on both flux
          and reconciliations — and still flags it if it deviates.
        </p>
      </Card>
    )
  }

  return (
    <Card title="Teach NDVX" icon={<Lightbulb size={13} strokeWidth={1.8} />}>
      {!open ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
            Does this recur? Save the explanation as a recurring expectation NDVX can reuse.
          </p>
          <button
            onClick={() => setOpen(true)}
            className="shrink-0 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-semibold transition-colors"
            style={{ border: "1px solid var(--border-strong)", color: "var(--text-2)" }}
          >
            Save as recurring
          </button>
        </div>
      ) : (
        <div className="space-y-3.5">
          {/* Cadence */}
          <div>
            <p className="text-[11px] font-semibold mb-1.5" style={{ color: "var(--text-2)" }}>How often does it recur?</p>
            <div className="inline-flex flex-wrap items-center gap-1 rounded-lg p-1"
              style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
              {CADENCES.map(({ value, label }) => (
                <button key={value} onClick={() => setRecurrence(value)}
                  className="rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors"
                  style={{
                    background: recurrence === value ? "var(--green-subtle)" : "transparent",
                    color: recurrence === value ? "var(--green)" : "var(--text-muted)",
                  }}>
                  {label}
                </button>
              ))}
            </div>
            <p className="text-[10px] mt-1" style={{ color: "var(--text-muted)" }}>
              {recurrence === "monthly" && "Applies every close."}
              {recurrence === "quarterly" && "Applies this month and every third month after."}
              {recurrence === "annual" && "Applies this calendar month each year."}
              {recurrence === "one_off" && "Documents this period only — never recurs."}
            </p>
          </div>

          {/* Expected amount */}
          <div>
            <label className="text-[11px] font-semibold block mb-1.5" style={{ color: "var(--text-2)" }}>
              Expected amount
            </label>
            <div className="inline-flex items-center rounded-md overflow-hidden"
              style={{ border: "1px solid var(--border-strong)" }}>
              <span className="px-2 py-1 text-[12px]" style={{ color: "var(--text-muted)", background: "var(--surface)" }}>$</span>
              <input value={expected} onChange={(e) => setExpected(e.target.value)} inputMode="decimal"
                aria-label="Expected amount"
                className="w-36 px-2 py-1 text-[12px] outline-none tabular-nums"
                style={{ background: "var(--surface)", color: "var(--text)" }} />
            </div>
          </div>

          {/* Tolerance: mode + value */}
          <div>
            <p className="text-[11px] font-semibold mb-1.5" style={{ color: "var(--text-2)" }}>Tolerance band</p>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="inline-flex items-center gap-1 rounded-lg p-1"
                style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
                {(["pct", "abs"] as const).map((m) => (
                  <button key={m} onClick={() => { setTolMode(m); setTolerance(m === "pct" ? "15" : "") }}
                    className="rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors"
                    style={{
                      background: tolMode === m ? "var(--green-subtle)" : "transparent",
                      color: tolMode === m ? "var(--green)" : "var(--text-muted)",
                    }}>
                    {m === "pct" ? "Percent (%)" : "Amount ($)"}
                  </button>
                ))}
              </div>
              <div className="inline-flex items-center rounded-md overflow-hidden"
                style={{ border: "1px solid var(--border-strong)" }}>
                <span className="px-2 py-1 text-[12px]" style={{ color: "var(--text-muted)", background: "var(--surface)" }}>±</span>
                <input value={tolerance} onChange={(e) => setTolerance(e.target.value)} inputMode="decimal"
                  aria-label="Tolerance" placeholder={tolMode === "pct" ? "15" : "500"}
                  className="w-20 px-2 py-1 text-[12px] outline-none tabular-nums"
                  style={{ background: "var(--surface)", color: "var(--text)" }} />
                <span className="px-2 py-1 text-[12px]" style={{ color: "var(--text-muted)", background: "var(--surface)" }}>
                  {tolMode === "pct" ? "%" : "$"}
                </span>
              </div>
            </div>
            <p className="text-[10px] mt-1" style={{ color: "var(--text-muted)" }}>
              Within this band of the expected amount NDVX pre-explains it; outside it, it's flagged.
            </p>
          </div>

          {/* Reason */}
          <div>
            <label className="text-[11px] font-semibold block mb-1.5" style={{ color: "var(--text-2)" }}>
              Why does it recur?
            </label>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3}
              placeholder="e.g. Quarterly insurance prepayment booked each Q-end."
              className="w-full rounded-md px-2.5 py-1.5 text-[12px] outline-none resize-y leading-snug"
              style={{ background: "var(--surface)", border: "1px solid var(--border-strong)", color: "var(--text)" }} />
          </div>

          {err && <p className="text-[11px]" style={{ color: "var(--danger)" }}>{err}</p>}

          <div className="flex items-center gap-2">
            <button onClick={save} disabled={saving}
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-bold text-white disabled:opacity-50"
              style={{ background: "var(--green)" }}>
              {saving ? "Saving…" : "Save"}
            </button>
            <button onClick={() => setOpen(false)} disabled={saving}
              className="rounded-lg px-2.5 py-1.5 text-[12px] font-semibold"
              style={{ border: "1px solid var(--border-strong)", color: "var(--text-2)" }}>
              Cancel
            </button>
          </div>
          <p className="text-[10px]" style={{ color: "var(--text-muted)" }}>
            Creates a suggestion only — a reviewer confirms it in Settings → Memory before it ever applies.
          </p>
        </div>
      )}
    </Card>
  )
}
