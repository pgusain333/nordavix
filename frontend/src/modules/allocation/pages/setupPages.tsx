/**
 * The setup screens, one per decision.
 *
 * These were tabs on a single Setup page. Tabs hid where you were in a sequence
 * that genuinely has an order — eligibility decides whether any of the rest is
 * usable, pools decide what the account map can point at, and the two registries
 * only matter if a pool consumes them. The left nav now carries that order, so
 * each step is a place you can link to, bookmark and be sent back to.
 *
 * Each page is deliberately thin: SetupShell owns the period and the readiness
 * rail, the panel owns the work.
 */
import { useNavigate } from "react-router-dom"
import { AccountsPanel } from "../components/AccountsPanel"
import { EligibilityPanel } from "../components/EligibilityPanel"
import { EmployeesPanel } from "../components/EmployeesPanel"
import { PoolsPanel } from "../components/PoolsPanel"
import { SettingsPanel } from "../components/SettingsPanel"
import { SpaceMapPanel } from "../components/SpaceMapPanel"
import { SpacesPanel } from "../components/SpacesPanel"
import { SetupShell } from "./SetupShell"

export function EligibilityPage() {
  return (
    <SetupShell
      title="Eligibility"
      subtitle="The §448(c) test — whether this client may use §471(c) at all"
    >
      {({ periodEnd }) => <EligibilityPanel periodEnd={periodEnd} />}
    </SetupShell>
  )
}

export function PoolsPage() {
  return (
    <SetupShell
      title="Cost pools"
      subtitle="How each group of cost is treated, and which driver apportions it"
    >
      {() => <PoolsPanel />}
    </SetupShell>
  )
}

export function AccountsPage() {
  return (
    <SetupShell
      title="Accounts"
      subtitle="Which pool each expense account belongs to"
      wide
    >
      {({ periodStart, periodEnd }) => (
        <AccountsPanel periodStart={periodStart} periodEnd={periodEnd} />
      )}
    </SetupShell>
  )
}

export function SpacesPage() {
  return (
    <SetupShell
      title="Spaces"
      subtitle="Square footage by function — the occupancy driver"
    >
      {({ periodEnd }) => (
        <div className="space-y-4">
          <SpacesPanel periodEnd={periodEnd} />
          {/* The evidence sits under the figures it supports, not on a
              separate screen someone has to know exists. */}
          <SpaceMapPanel />
        </div>
      )}
    </SetupShell>
  )
}

export function EmployeesPage() {
  const navigate = useNavigate()
  return (
    <SetupShell
      title="Employees"
      subtitle="Who works on inventory, how much of their time, and why"
      wide
    >
      {({ periodEnd }) => (
        <EmployeesPanel periodEnd={periodEnd}
          onGoToPayroll={() => navigate("/allocation/payroll")} />
      )}
    </SetupShell>
  )
}

export function SettingsPage() {
  return (
    <SetupShell
      title="Settings"
      subtitle="Method, financial statements, fiscal year and the election on file"
      hidePeriod
    >
      {() => <SettingsPanel />}
    </SetupShell>
  )
}
