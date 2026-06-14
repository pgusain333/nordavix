/**
 * LearnedDefaultChip — Client Memory pre-fill for schedule dialogs.
 *
 * When a CONFIRMED vendor/lessor/lender convention exists for the typed party,
 * shows a one-line "Apply" chip that fills the form from the learned setup.
 * Confirm-first: the endpoint returns only `active` facts, so nothing surfaces
 * until a reviewer has confirmed it in Settings → Client memory.
 *
 * Shared by every schedule dialog so the query + per-vendor "applied" sentinel
 * + chip live in one place. The parent supplies onApply, which sets its own
 * form fields from the learned ScheduleDefault.
 */
import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Brain } from "lucide-react"
import { memoryApi, type ScheduleDefault } from "@/modules/memory/api"

type ScheduleType = "prepaid" | "accrual" | "fixed_asset" | "lease" | "loan"

function describe(st: ScheduleType, d: ScheduleDefault): string {
  const into = d.offset_account_name ? ` into ${d.offset_account_name}` : ""
  if (st === "accrual") return `usually accrues${d.offset_account_name ? ` to ${d.offset_account_name}` : ""}.`
  if (st === "fixed_asset") {
    const bits = [d.category, d.useful_life_months ? `${d.useful_life_months}-mo` : "",
      (d.depreciation_method || "").replace("_", " ")].filter(Boolean).join(" · ")
    return `is usually ${bits || "a fixed asset"}${into}.`
  }
  if (st === "lease") return `is usually a ${d.term_months ? `${d.term_months}-month ` : ""}lease.`
  if (st === "loan") {
    const bits = [d.term_months ? `${d.term_months}-month` : "", d.interest_rate_pct ? `${d.interest_rate_pct}%` : "",
      d.payment_type].filter(Boolean).join(" ")
    return `is usually a ${bits || "loan"}.`
  }
  // prepaid
  const m = d.amortization_method === "daily_rate" ? "daily-rate" : "straight-line"
  return `is usually a ${d.term_months ? `${d.term_months}-month ` : ""}${m} prepaid${into}.`
}

export function LearnedDefaultChip({ scheduleType, party, existing, onApply }: {
  scheduleType: ScheduleType
  party: string
  existing: boolean
  onApply: (d: ScheduleDefault) => void
}) {
  const partyTrim = party.trim()
  const partyLc = partyTrim.toLowerCase()
  const { data } = useQuery({
    queryKey: ["schedule-default", scheduleType, partyLc],
    queryFn:  () => memoryApi.scheduleDefault(scheduleType, partyTrim),
    enabled:  !existing && partyTrim.length >= 2,
    staleTime: 60_000,
  })
  const learned = (!existing && data?.default) || null
  // Per-party sentinel so changing the party re-offers the new one's default.
  const [appliedFor, setAppliedFor] = useState<string | null>(null)

  if (!learned || appliedFor === partyLc) return null

  return (
    <div className="rounded-lg px-3 py-2.5 flex items-start gap-2.5"
      style={{ background: "var(--green-subtle)", border: "1px solid var(--green)" }}>
      <Brain size={15} strokeWidth={1.9} className="mt-0.5 shrink-0" style={{ color: "var(--green)" }} />
      <p className="text-[12px] min-w-0 flex-1" style={{ color: "var(--text)" }}>
        Client memory: <span className="font-semibold">{learned.vendor || partyTrim}</span> {describe(scheduleType, learned)}
      </p>
      <button
        onClick={() => { onApply(learned); setAppliedFor(partyLc) }}
        className="shrink-0 inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[12px] font-bold text-white transition-opacity hover:opacity-90"
        style={{ background: "var(--green)" }}
      >
        Apply
      </button>
    </div>
  )
}
