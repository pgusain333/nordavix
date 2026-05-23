import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { ClerkProvider } from "@clerk/clerk-react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { BrowserRouter } from "react-router-dom"
import App from "./App"
import DevShell from "./DevShell"
import "./index.css"

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string
const IS_DEV_PLACEHOLDER = !PUBLISHABLE_KEY || PUBLISHABLE_KEY.startsWith("pk_test_placeholder")

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
})

const root = document.getElementById("root")
if (!root) throw new Error("Root element not found")

// When a real Clerk key is not configured, render the layout shell directly
// so the UI can be developed and previewed without auth infrastructure.
// This branch is never reached in production (VITE_ vars are baked at build time).
if (IS_DEV_PLACEHOLDER) {
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <DevShell />
        </BrowserRouter>
      </QueryClientProvider>
    </StrictMode>,
  )
} else {
  if (!PUBLISHABLE_KEY) {
    throw new Error("VITE_CLERK_PUBLISHABLE_KEY is not set. Copy .env.example to frontend/.env.local.")
  }
  createRoot(root).render(
    <StrictMode>
      <ClerkProvider publishableKey={PUBLISHABLE_KEY}>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </QueryClientProvider>
      </ClerkProvider>
    </StrictMode>,
  )
}
