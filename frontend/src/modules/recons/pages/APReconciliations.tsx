import { ReconciliationsList } from "./ReconciliationsList"

export function APReconciliations() {
  return (
    <ReconciliationsList
      title="Accounts Payable"
      subtitle="Vendor balances reconciled against the GL with aging, risk, and AI commentary."
      type="AP"
    />
  )
}
