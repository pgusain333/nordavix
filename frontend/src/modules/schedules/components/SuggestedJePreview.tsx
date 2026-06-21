/**
 * SuggestedJePreview — renders the suggested journal entries for an
 * AI-detected schedule candidate. Used inside the three "Scan GL"
 * banners (prepaid / missed-accrual / fixed-asset) so the user knows
 * EXACTLY what to post in QBO before they click "Add to schedule" /
 * "Capitalize" / "Add accrual".
 *
 * Each kind shows TWO JE blocks:
 *
 *   PREPAID
 *     1) Initial recording (reclassification) — post NOW, dated as the
 *        original transaction date. Moves the wrong expense to a
 *        balance-sheet prepaid asset.
 *           Dr  Prepaid asset                    $total
 *           Cr  [original expense account]                $total
 *     2) Period-end amortization — post each period during the term.
 *           Dr  [expense account]                $monthly
 *           Cr  Prepaid asset                             $monthly
 *
 *   MISSED ACCRUAL
 *     1) Accrual at period-end — post in the period being closed.
 *           Dr  [expense account]                $accrue
 *           Cr  Accrued liabilities                       $accrue
 *     2) Reversing JE — post on day 1 of the next period so the
 *        already-booked payment in the next period doesn't double-count.
 *           Dr  Accrued liabilities              $accrue
 *           Cr  [expense account]                         $accrue
 *
 *   FIXED ASSET
 *     1) Initial recording (capitalization) — post NOW, dated as the
 *        in-service date. Moves the wrong expense to a fixed asset.
 *           Dr  Fixed asset — [category]         $cost
 *           Cr  [original expense account]                $cost
 *     2) Monthly depreciation — post each period for useful_life months.
 *           Dr  Depreciation expense             $monthly_dep
 *           Cr  Accumulated depreciation                  $monthly_dep
 *
 * All amounts and accounts are derived purely from the candidate fields
 * — no API calls, no server math. The component is read-only context:
 * post it in QBO yourself, then re-sync.
 */
import type {
  FixedAssetCandidate,
  MissedAccrualCandidate,
  PrepaidCandidate,
} from "@/modules/schedules/types"
import { toISODate } from "@/core/lib/dates"

type Variant =
  | { kind: "prepaid";        candidate: PrepaidCandidate }
  | { kind: "missed_accrual"; candidate: MissedAccrualCandidate }
  | { kind: "fixed_asset";    candidate: FixedAssetCandidate }

interface JeRow {
  account:  string
  debit:    number | null
  credit:   number | null
}

interface SuggestedJe {
  title:     string
  postWhen:  string
  rows:      JeRow[]
  memo:      string
}

function fmt(n: number | null): string {
  if (n === null) return "—"
  if (n === 0)    return "$0.00"
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function pickPrepaidJes(c: PrepaidCandidate): SuggestedJe[] {
  const total    = parseFloat(c.gl_amount) || 0
  const months   = c.ai_service_months ?? 0
  const vendor   = c.ai_vendor || c.gl_vendor || "vendor"
  const isStraight = c.ai_method === "straight_line"
  // Average monthly for the preview. Even for daily_rate, this is the
  // mean monthly that the user expects to see on the JE preview row;
  // the actual recognition pattern in the drawer is precise per day.
  const monthly  = months > 0 ? Math.round((total / months) * 100) / 100 : 0
  const start    = c.ai_service_start || c.gl_txn_date
  const acctName = c.gl_account_name

  return [
    {
      title:    "Initial recording — reclassify to prepaid",
      postWhen: `Post in QBO dated ${c.gl_txn_date}`,
      rows: [
        { account: "Prepaid Expenses (BS)",     debit: total, credit: null  },
        { account: `${acctName} (P&L)`,          debit: null,  credit: total },
      ],
      memo: `Reclassify ${vendor} payment — multi-period prepaid (was direct-expensed)`,
    },
    {
      title:    `Monthly amortization (${months || "N"} periods, ${isStraight ? "straight-line" : "daily-rate"})`,
      postWhen: `Post at each month-end from ${start} through end of term`,
      rows: [
        { account: `${acctName} (P&L)`,          debit: monthly, credit: null    },
        { account: "Prepaid Expenses (BS)",     debit: null,    credit: monthly },
      ],
      memo: `Amortize prepaid ${vendor} — 1/${months || "N"}`,
    },
  ]
}

function pickAccrualJes(c: MissedAccrualCandidate): SuggestedJe[] {
  const accrue   = parseFloat(c.ai_suggested_amount ?? c.gl_amount) || parseFloat(c.gl_amount) || 0
  const vendor   = c.ai_vendor || c.gl_vendor || "vendor"
  const periodEnd = c.ai_service_period_end || c.period_end
  // First day of the month AFTER period_end. Bump the month forward;
  // simple ISO add since dates here are guaranteed valid YYYY-MM-DD
  // strings from the API.
  const reverseDate = (() => {
    const d = new Date(periodEnd + "T00:00:00")
    d.setMonth(d.getMonth() + 1)
    d.setDate(1)
    return toISODate(d)
  })()
  const acctName = c.gl_account_name

  return [
    {
      title:    "Accrue at period-end",
      postWhen: `Post in QBO dated ${periodEnd} (the period being closed)`,
      rows: [
        { account: `${acctName} (P&L)`,        debit: accrue, credit: null   },
        { account: "Accrued Liabilities (BS)", debit: null,   credit: accrue },
      ],
      memo: `Accrue ${vendor} services performed in ${periodEnd} — invoice arrived ${c.gl_txn_date}`,
    },
    {
      title:    "Reversing entry next period",
      postWhen: `Post in QBO dated ${reverseDate} (day 1 of next period)`,
      rows: [
        { account: "Accrued Liabilities (BS)", debit: accrue, credit: null   },
        { account: `${acctName} (P&L)`,        debit: null,   credit: accrue },
      ],
      memo: `Reverse ${vendor} accrual — payment already booked ${c.gl_txn_date} nets to single recognition`,
    },
  ]
}

function pickFixedAssetJes(c: FixedAssetCandidate): SuggestedJe[] {
  const cost    = parseFloat(c.ai_cost ?? c.gl_amount) || parseFloat(c.gl_amount) || 0
  const salvage = parseFloat(c.ai_salvage_value ?? "0") || 0
  const life    = c.ai_useful_life_months ?? 0
  const monthlyDep = life > 0 ? Math.round(((cost - salvage) / life) * 100) / 100 : 0
  const description = c.ai_description || c.gl_memo || c.ai_vendor || "asset"
  const category  = c.ai_category || "Fixed Asset"
  const inService = c.ai_in_service_date || c.gl_txn_date
  const acctName  = c.gl_account_name
  const lifeLabel = life > 0
    ? life % 12 === 0 ? `${life / 12}-yr` : `${life}-mo`
    : "useful"

  return [
    {
      title:    "Initial recording — capitalize",
      postWhen: `Post in QBO dated ${inService}`,
      rows: [
        { account: `Fixed Asset — ${category} (BS)`, debit: cost, credit: null },
        { account: `${acctName} (P&L)`,               debit: null, credit: cost },
      ],
      memo: `Reclassify mis-expensed ${description} — capitalize per US-GAAP (${lifeLabel} life)`,
    },
    {
      title:    `Monthly depreciation (${life || "N"} months, straight-line)`,
      postWhen: `Post at each month-end from ${inService}`,
      rows: [
        { account: "Depreciation Expense (P&L)",           debit: monthlyDep, credit: null       },
        { account: `Accumulated Depreciation — ${category} (BS)`, debit: null,       credit: monthlyDep },
      ],
      memo: `Depreciate ${description} — 1/${life || "N"} (${lifeLabel} life)`,
    },
  ]
}

function pickJes(v: Variant): SuggestedJe[] {
  if (v.kind === "prepaid")        return pickPrepaidJes(v.candidate)
  if (v.kind === "missed_accrual") return pickAccrualJes(v.candidate)
  return pickFixedAssetJes(v.candidate)
}

export function SuggestedJePreview(v: Variant) {
  const jes = pickJes(v)
  return (
    <div className="mt-2 rounded-lg overflow-hidden"
      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <div className="px-3 py-1.5 flex items-center gap-2"
        style={{ background: "rgba(84, 88, 138, 0.06)", borderBottom: "1px solid var(--border)" }}>
        <p className="text-[10px] font-bold uppercase tracking-wider" style={{ color: "#54588a" }}>
          ✨ Suggested journal entries
        </p>
        <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
          Post in QuickBooks, then come back here and re-sync the GL.
        </span>
      </div>
      <div className="divide-y" style={{ borderColor: "var(--border)" }}>
        {jes.map((je, i) => (
          <JeBlock key={i} index={i + 1} je={je} />
        ))}
      </div>
    </div>
  )
}

function JeBlock({ index, je }: { index: number; je: SuggestedJe }) {
  return (
    <div className="px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-2 flex-wrap mb-1.5">
        <p className="text-[11px] font-semibold text-theme">
          <span className="inline-block w-4 text-[10px] font-mono"
            style={{ color: "var(--text-muted)" }}>{index}.</span>
          {je.title}
        </p>
        <p className="text-[10px]" style={{ color: "var(--text-muted)" }}>
          {je.postWhen}
        </p>
      </div>
      <table className="w-full text-[11px]">
        <thead>
          <tr style={{ background: "var(--surface-2)" }}>
            <th className="text-left px-2 py-1 font-semibold"
              style={{ color: "var(--text-muted)" }}>Account</th>
            <th className="text-right px-2 py-1 font-semibold"
              style={{ color: "var(--text-muted)", width: 110 }}>Debit</th>
            <th className="text-right px-2 py-1 font-semibold"
              style={{ color: "var(--text-muted)", width: 110 }}>Credit</th>
          </tr>
        </thead>
        <tbody>
          {je.rows.map((r, i) => (
            <tr key={i} style={{ borderTop: "1px solid var(--border)" }}>
              <td className="px-2 py-1 text-theme"
                style={{ paddingLeft: r.credit !== null && r.debit === null ? 20 : 8 }}>
                {r.account}
              </td>
              <td className="px-2 py-1 text-right tabular-nums font-semibold"
                style={{ color: r.debit ? "var(--text)" : "var(--text-muted)" }}>
                {fmt(r.debit)}
              </td>
              <td className="px-2 py-1 text-right tabular-nums font-semibold"
                style={{ color: r.credit ? "var(--text)" : "var(--text-muted)" }}>
                {fmt(r.credit)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[10px] mt-1 italic" style={{ color: "var(--text-muted)" }}>
        Memo: {je.memo}
      </p>
    </div>
  )
}
