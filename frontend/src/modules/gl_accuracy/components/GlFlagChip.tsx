/**
 * GlFlagChip — the watchdog's voice inside the flux & recon drawers.
 *
 * When the GL-accuracy scan has an OPEN finding whose posted (wrong) account is
 * the one the preparer is currently looking at, this surfaces a compact "second
 * pair of eyes" heads-up right where they work, linking to the full GL Accuracy
 * page to review it. Renders nothing when there's no QBO account id (e.g. an
 * Excel-uploaded TB), no period, or no matching open finding — so it's safe to
 * drop into any account view unconditionally.
 *
 * Shares the exact query key the GL Accuracy page uses, so all surfaces dedupe a
 * single fetch and stay in sync the moment a finding is accepted or dismissed.
 */
import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { useOrganization } from "@clerk/clerk-react"
import { ScanSearch, ChevronRight } from "lucide-react"

import { glAccuracyApi } from "@/modules/gl_accuracy/api"

function fmtUsd(n: number): string {
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 })
}

export function GlFlagChip({
  qboAccountId,
  periodEnd,
}: {
  qboAccountId: string | null | undefined
  periodEnd: string | null | undefined
}) {
  const { organization } = useOrganization()
  const navigate = useNavigate()
  const enabled = !!organization && !!qboAccountId && !!periodEnd

  const { data } = useQuery({
    queryKey: ["gl-accuracy", "findings", periodEnd],
    queryFn: () => glAccuracyApi.getFindings(periodEnd as string),
    enabled,
    staleTime: 5 * 60_000,
  })

  if (!enabled || !data) return null
  const mine = data.items.filter((f) => f.status === "open" && f.posted_account_id === qboAccountId)
  if (mine.length === 0) return null

  const dollars = mine.reduce((s, f) => s + Math.abs(Number(f.amount) || 0), 0)
  const n = mine.length

  return (
    <button
      type="button"
      onClick={() => navigate("/app/gl-accuracy")}
      className="w-full inline-flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:brightness-[0.98]"
      style={{ background: "var(--warn-subtle)", border: "1px solid var(--warn-border)" }}
    >
      <span className="inline-flex items-start gap-2 min-w-0">
        <ScanSearch size={15} strokeWidth={2} style={{ color: "var(--warn)", marginTop: 1, flexShrink: 0 }} />
        <span className="min-w-0">
          <span className="block text-[12px] font-semibold" style={{ color: "var(--warn)" }}>
            {n === 1 ? "Nordavix flagged a possible miscode here" : `Nordavix flagged ${n} possible miscodes here`}
          </span>
          <span className="block text-[11px]" style={{ color: "var(--text-muted)" }}>
            {fmtUsd(dollars)} that may belong in another account — review in GL Accuracy
          </span>
        </span>
      </span>
      <ChevronRight size={15} strokeWidth={2} style={{ color: "var(--warn)", flexShrink: 0 }} />
    </button>
  )
}
