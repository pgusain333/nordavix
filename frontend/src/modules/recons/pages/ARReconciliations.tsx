import { ReconciliationsList } from "./ReconciliationsList"

export function ARReconciliations() {
  return (
    <ReconciliationsList
      title="Accounts Receivable"
      subtitle="Customer balances reconciled against the GL with aging, risk, and AI commentary."
      type="AR"
    />
  )
}
