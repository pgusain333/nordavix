"""Period Export — bundles a whole month-end close into one .xlsx
workbook the user can download from Settings → Data & export.

  GET /api/exports/period?period_end=YYYY-MM-DD  →  .xlsx stream

Sheets included:
  1. Cover                  — company, period, date generated
  2. Reconciliations        — every BS account with GL / SL / variance
  3. Prepaid Schedule       — all active prepaids + period amortization
  4. Accrual Schedule       — all active accruals + reversal status
  5. Fixed Asset Register   — cost, dep method, accumulated dep, NBV
  6. Lease Schedule         — payments + ASC 842 ROU + liability if used
  7. Loan Schedule          — principal, rate, term, balances
  8. Audit Log              — last 90 days of workspace events
"""
