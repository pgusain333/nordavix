/**
 * WorkspaceGate — ensures a signed-in user has an active company (Clerk
 * organization) AND has completed the books-setup wizard before any
 * /app/* page renders.
 *
 * Two checks layered together:
 *   1. Active Clerk org? → if not, show the CompaniesPanel.
 *   2. Books seeded? → if not, redirect to the BooksSetupWizard.
 *
 * The wizard route itself (/app/setup/books) is excluded from check #2
 * so the user can actually reach it. Connections is also exempt because
 * QBO must be connected before the wizard can pull a starting TB.
 */
import { useOrganization } from "@clerk/clerk-react"
import { useQuery } from "@tanstack/react-query"
import { Navigate, useLocation } from "react-router-dom"
import { CompaniesPanel } from "@/modules/onboarding/pages/CompaniesPanel"
import { reconsApi } from "@/modules/recons/api"

interface Props {
  children: React.ReactNode
}

// Only these routes are blocked when books aren't seeded — they're the
// workhorse modules that need a books_start_date to work.
// Everything else (dashboard, team, connections, companies, setup wizard
// itself) stays reachable so an admin can invite teammates / wire up QBO /
// browse the setup checklist before committing to a books-start date.
const REQUIRES_SEEDED_BOOKS = [
  "/app/reconciliations",
  "/app/flux",
]

export function WorkspaceGate({ children }: Props) {
  const { organization, isLoaded } = useOrganization()
  const location = useLocation()

  const { data: books, isLoading: booksLoading } = useQuery({
    queryKey: ["books-status"],
    queryFn:  reconsApi.getBooksStatus,
    enabled:  !!organization,
    // status rarely changes; cache hard so we don't hit the API on every nav
    staleTime: 5 * 60_000,
  })

  // Loading — avoid flashing either UI
  if (!isLoaded) return null

  // Signed in but no active company → force them through company setup
  if (!organization) return <CompaniesPanel />

  // Books not seeded AND user is trying to reach a module that requires
  // them → bounce to the wizard. Everything else renders normally.
  const needsBooks = REQUIRES_SEEDED_BOOKS.some((p) => location.pathname.startsWith(p))
  if (!booksLoading && books && !books.seeded && needsBooks) {
    return <Navigate to="/app/setup/books" replace />
  }

  return <>{children}</>
}
