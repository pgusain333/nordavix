/**
 * WorkspaceGate — checks two things in order:
 *   1. Signed-in user has both first + last name set (NameGate)
 *   2. Signed in WITH an active org (this file)
 *
 * If either is missing, the user sees the appropriate prompt before
 * any app content renders. Order matters: collect the name first so
 * that company creation + every audit log entry from this session
 * onwards is attributed to a real person rather than just an email.
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
import { NameGate } from "./NameGate"

interface Props {
  children: React.ReactNode
}

export function WorkspaceGate({ children }: Props) {
  const { organization, isLoaded } = useOrganization()

  // Loading — avoid flashing either UI
  if (!isLoaded) return null

  // Wrap everything in NameGate so the "what should we call you?" prompt
  // shows BEFORE companies panel — picking a company and creating audit
  // entries with a nameless user produces ugly "prepared by foo@bar.com"
  // attribution that's hard to clean up later.
  return (
    <NameGate>
      {!organization ? <CompaniesPanel /> : <>{children}</>}
    </NameGate>
  )
}
