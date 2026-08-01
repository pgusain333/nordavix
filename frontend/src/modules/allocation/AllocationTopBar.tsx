/**
 * AllocationTopBar — the close app's top bar, configured for Allocate.
 *
 * Deliberately the SAME component rather than a copy: staff move between the two
 * products all day, and a bar that drifts out of sync is a bar you have to
 * re-learn. What differs is only what genuinely differs — this product's route
 * titles, no Command Center (that's a close-app roster), and a §471(c) readiness
 * chip in place of the close-progress chip.
 *
 * Help opens in a NEW TAB because the guide currently lives in the close app;
 * navigating there in place would drop the preparer out of Allocate entirely.
 */
import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { TopBar } from "@/core/layout/TopBar"
import { allocationApi } from "./api"
import { useAllocationWindow } from "./components/MonthPicker"

const ALLOCATION_TITLES: [string, string][] = [
  ["/allocation/eligibility", "Eligibility"],
  ["/allocation/pools",       "Cost pools"],
  ["/allocation/accounts",    "Accounts"],
  ["/allocation/spaces",      "Spaces"],
  ["/allocation/employees",   "Employees"],
  ["/allocation/settings",    "Settings"],
  ["/allocation/team",        "Team"],
  ["/allocation/payroll",     "Payroll register"],
  ["/allocation/runs",        "Run allocation"],
  ["/allocation/year-end",    "Year end"],
  ["/allocation",             "Dashboard"],
]

/** Ready / blocked for the period on screen — the one thing that gates everything. */
function ReadinessChip() {
  const navigate = useNavigate()
  // The normalised window, so the chip names the period the run will use.
  const { periodEnd, frequency } = useAllocationWindow()
  const { data } = useQuery({
    queryKey: ["allocation", "readiness", periodEnd],
    queryFn:  () => allocationApi.getReadiness(periodEnd),
    staleTime: 15_000,
    retry: 0,          // not set up yet → just hide the chip
  })
  if (!data) return null

  const label = frequency === "annual"
    ? `FY ${periodEnd.slice(0, 4)}`
    : periodEnd.slice(0, 7)
  const fg = data.ready ? "var(--positive)" : "var(--warn)"
  const bg = data.ready ? "var(--positive-subtle)" : "var(--warn-subtle)"

  return (
    <button
      onClick={() => navigate(data.ready ? "/allocation/runs" : "/allocation/eligibility")}
      title={data.ready
        ? "Ready to run — open Run allocation"
        : `${data.blockers.length} blocker${data.blockers.length === 1 ? "" : "s"} — open setup`}
      className="hidden xl:inline-flex items-center gap-1.5 ml-2 shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold transition-transform hover:-translate-y-px"
      style={{ background: bg, color: fg, border: "1px solid var(--border)" }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: fg }} />
      §471(c) · {label}&nbsp;
      <span className="tabular-nums opacity-80">
        {data.ready ? "ready" : `${data.blockers.length} to fix`}
      </span>
    </button>
  )
}

export function AllocationTopBar() {
  return (
    <TopBar
      titles={ALLOCATION_TITLES}
      subTitles={[]}
      appName="Nordavix Allocate"
      helpPath="/app/help"
      helpNewTab
      rolePath="/allocation/team"
      showCommandCenter={false}
      showCloseChip={false}
      chip={<ReadinessChip />}
    />
  )
}
