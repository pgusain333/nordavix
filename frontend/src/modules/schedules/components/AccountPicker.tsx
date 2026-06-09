/**
 * Reusable balance-sheet account picker.
 *
 * Used inside schedule create/edit dialogs and at the top of each
 * detail page to filter the items table to one account. Pulls the
 * QBO chart of accounts from /api/schedules/accounts.
 *
 * Two render modes:
 *   - <AccountPicker mode="filter" />  → null option "All accounts"
 *   - <AccountPicker mode="form"   />  → required, no null option
 */
import { useQuery } from "@tanstack/react-query"
import { Spinner } from "@/core/ui/components"
import { schedulesApi } from "@/modules/schedules/api"

interface Props {
  value:    string
  onChange: (qbo_account_id: string) => void
  mode:     "filter" | "form"
  label?:   string
  disabled?: boolean
  /** "balance_sheet" (default) lists asset/liability accounts; "expense"
   *  lists P&L / income-statement accounts (for the offset/expense side). */
  kind?:    "balance_sheet" | "expense"
}

export function AccountPicker({ value, onChange, mode, label, disabled, kind = "balance_sheet" }: Props) {
  const { data: accounts, isLoading } = useQuery({
    queryKey: ["schedules", "accounts", kind],
    queryFn:  () => schedulesApi.listAccounts(kind),
    staleTime: 5 * 60_000,
  })

  if (isLoading) {
    return (
      <div className="inline-flex items-center gap-2 text-xs" style={{ color: "var(--text-muted)" }}>
        <Spinner className="h-3 w-3" />
        Loading accounts…
      </div>
    )
  }

  return (
    <div className="inline-flex flex-col gap-1 min-w-0">
      {label && (
        <span className="text-[10px] font-semibold uppercase tracking-wide"
          style={{ color: "var(--text-muted)" }}>
          {label}{mode === "form" && " *"}
        </span>
      )}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="rounded-lg px-3 py-1.5 text-sm outline-none transition-colors min-w-[260px]"
        style={{
          background: "var(--surface-2)",
          border: "1px solid var(--border-strong)",
          color: "var(--text)",
        }}
      >
        {mode === "filter" && <option value="">All accounts</option>}
        {mode === "form" && <option value="">— Select account —</option>}
        {(accounts ?? []).map((a) => (
          <option key={a.qbo_account_id} value={a.qbo_account_id}>
            {a.number ? `${a.number} · ` : ""}{a.name} · {a.group_label}
          </option>
        ))}
      </select>
    </div>
  )
}
