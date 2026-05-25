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

// Routes the gate lets through even when books aren't seeded yet.
const SETUP_PASSTHROUGH = ["/app/setup/books", "/app/connections", "/app/companies"]

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

  // Org chosen but books not yet seeded → push to the wizard.
  if (
    !booksLoading
    && books
    && !books.seeded
    && !SETUP_PASSTHROUGH.some((p) => location.pathname.startsWith(p))
  ) {
    return <Navigate to="/app/setup/books" replace />
  }

  return <>{children}</>
}
