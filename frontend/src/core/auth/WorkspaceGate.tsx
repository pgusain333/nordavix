/**
 * WorkspaceGate — ensures a signed-in user has an active company (Clerk
 * organization) before any /app/* page renders.
 *
 * If no active org, we render the dedicated <CompaniesPanel /> page in place
 * of the requested route. That page is also reachable directly at
 * /app/companies for users who want to switch between companies they've
 * already created, so this gate doesn't need to do anything fancy — it just
 * delegates to the same UI.
 */
import { useOrganization } from "@clerk/clerk-react"
import { CompaniesPanel } from "@/modules/onboarding/pages/CompaniesPanel"

interface Props {
  children: React.ReactNode
}

export function WorkspaceGate({ children }: Props) {
  const { organization, isLoaded } = useOrganization()

  // Loading — avoid flashing either UI
  if (!isLoaded) return null

  // Signed in but no active company → force them through company setup
  if (!organization) return <CompaniesPanel />

  return <>{children}</>
}
