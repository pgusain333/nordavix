/**
 * WorkspaceGate — checks just one thing now: signed in WITH an active org.
 *
 * Books-seeded redirects have been REMOVED. Earlier versions bounced users
 * from /app/reconciliations and /app/flux to the books wizard when they
 * hadn't seeded yet — but if the wizard has any issue (QBO auth, balance
 * pull problem), users get trapped with no way out. Better UX: let them
 * use every page; the pages that benefit from books_start_date show their
 * own dismissible "set up books for full features" banner.
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
