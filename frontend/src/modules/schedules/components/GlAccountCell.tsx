/**
 * Compact GL-account display used in every schedule items table.
 *
 * Renders "<account name> · <number>" with a small color-coded chip
 * for the account-type group (Bank, AR, Credit Card, etc.). Looks up
 * the metadata via the cached /schedules/accounts list so we don't
 * have to denormalize account name onto every schedule_items row.
 *
 * Falls back to a monospace id badge when the account isn't in the
 * loaded list (e.g. the account was deleted in QBO after the
 * schedule item was created).
 */
import { useQuery } from "@tanstack/react-query"
import { schedulesApi, type ScheduleAccount } from "@/modules/schedules/api"

interface Props {
  qboAccountId: string
}

/** Distinct background tint per group_label — keeps the recon dashboard
 * + the schedule tables visually consistent on which accounts are which. */
const GROUP_TINTS: Record<string, { bg: string; fg: string }> = {
  "Bank":                       { bg: "rgba(60, 90, 118, 0.10)", fg: "#3c5a76" },
  "Credit Card":                { bg: "rgba(155, 61, 55, 0.10)", fg: "#9b3d37" },
  "AR":                         { bg: "rgba(46, 122, 85, 0.10)", fg: "#2e7a55" },
  "AP":                         { bg: "rgba(199, 154, 82, 0.12)", fg: "#8a6326" },
  "Fixed Assets":               { bg: "rgba(84, 88, 138, 0.10)", fg: "#54588a" },
  "Other Current Assets":       { bg: "var(--surface-2)",         fg: "var(--text-muted)" },
  "Other Assets":               { bg: "var(--surface-2)",         fg: "var(--text-muted)" },
  "Other Current Liabilities":  { bg: "var(--surface-2)",         fg: "var(--text-muted)" },
  "Long Term Liabilities":      { bg: "var(--surface-2)",         fg: "var(--text-muted)" },
  "Equity":                     { bg: "var(--surface-2)",         fg: "var(--text-muted)" },
}

export function GlAccountCell({ qboAccountId }: Props) {
  const { data: accounts } = useQuery({
    queryKey: ["schedules", "accounts", "balance_sheet"],
    queryFn:  () => schedulesApi.listAccounts(),
    staleTime: 5 * 60_000,
  })

  const acct: ScheduleAccount | undefined =
    accounts?.find((a) => a.qbo_account_id === qboAccountId)

  if (!acct) {
    return (
      <span className="font-mono text-[10px]" style={{ color: "var(--text-muted)" }}>
        {qboAccountId}
      </span>
    )
  }

  const tint = GROUP_TINTS[acct.group_label] ?? {
    bg: "var(--surface-2)", fg: "var(--text-muted)",
  }

  return (
    <div className="min-w-0">
      <div className="text-theme truncate" title={acct.name}>
        {acct.number ? <span className="font-mono text-[10px] mr-1" style={{ color: "var(--text-muted)" }}>{acct.number}</span> : null}
        {acct.name}
      </div>
      <div className="text-[10px] inline-block px-1.5 py-0.5 rounded mt-0.5"
        style={{ background: tint.bg, color: tint.fg }}>
        {acct.group_label}
      </div>
    </div>
  )
}
