/**
 * DemoModeProvider — "Explore a sample company" read-only demo.
 *
 * When the user enters demo mode, the api client tags every request with
 * `X-Nordavix-Demo: 1` (see setDemoModeProvider) and the backend serves the
 * seeded read-only demo tenant. State is localStorage-backed so the api-client
 * getter is race-free (it reads localStorage directly). Entering/exiting wipes
 * the React Query cache so all pages refetch against the right tenant, mirroring
 * the org-switch reset in ClerkApiWirer. Switching workspaces auto-exits demo.
 */
import {
  createContext, useCallback, useContext, useEffect, useRef, useState,
  type ReactNode,
} from "react"
import { useNavigate } from "react-router-dom"
import { Eye, ArrowLeft } from "lucide-react"
import { useOrganization } from "@clerk/clerk-react"
import { useQueryClient } from "@tanstack/react-query"
import { setDemoModeProvider } from "@/core/api/client"

const KEY = "nordavix_demo"

function readFlag(): boolean {
  try { return localStorage.getItem(KEY) === "1" } catch { return false }
}

interface DemoCtx {
  isDemo: boolean
  enterDemo: () => void
  exitDemo: () => void
}

const Ctx = createContext<DemoCtx>({ isDemo: false, enterDemo: () => {}, exitDemo: () => {} })

export function useDemoMode(): DemoCtx {
  return useContext(Ctx)
}

export function DemoModeProvider({ children }: { children: ReactNode }) {
  const [isDemo, setIsDemo] = useState<boolean>(readFlag)
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { organization } = useOrganization()
  const orgRef = useRef<string | null | undefined>(undefined)

  // The api-client getter reads localStorage directly so a request fired
  // synchronously right after enterDemo() already carries the header.
  useEffect(() => { setDemoModeProvider(readFlag) }, [])

  const enterDemo = useCallback(() => {
    try { localStorage.setItem(KEY, "1") } catch { /* private mode */ }
    setIsDemo(true)
    qc.removeQueries()
    navigate("/app")
  }, [qc, navigate])

  const exitDemo = useCallback(() => {
    try { localStorage.removeItem(KEY) } catch { /* private mode */ }
    setIsDemo(false)
    qc.removeQueries()
    navigate("/app")
  }, [qc, navigate])

  // Switching to a real workspace auto-exits demo (never leak the header to a
  // real org; keep the banner honest). Skips the first render.
  useEffect(() => {
    const current = organization?.id ?? null
    if (orgRef.current !== undefined && orgRef.current !== current && readFlag()) {
      try { localStorage.removeItem(KEY) } catch { /* ignore */ }
      setIsDemo(false)
      qc.removeQueries()
    }
    orgRef.current = current
  }, [organization?.id, qc])

  return <Ctx.Provider value={{ isDemo, enterDemo, exitDemo }}>{children}</Ctx.Provider>
}

/** Full-width read-only banner shown across the app while in demo mode. */
export function DemoBanner() {
  const { isDemo, exitDemo } = useDemoMode()
  if (!isDemo) return null
  return (
    <div
      className="flex items-center justify-center gap-3 px-4 py-2 shrink-0 text-xs flex-wrap"
      style={{ background: "#fffbeb", borderBottom: "1px solid #fde68a", color: "#92400e" }}
    >
      <span className="inline-flex items-center gap-1.5 text-center">
        <Eye size={13} strokeWidth={2} className="shrink-0" />
        You're exploring a <strong>sample company</strong> (Northwind Trading Co.) — everything here is read-only demo data.
      </span>
      <button
        onClick={exitDemo}
        className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 font-semibold transition-opacity hover:opacity-90"
        style={{ background: "#92400e", color: "#fff" }}
      >
        <ArrowLeft size={12} strokeWidth={2.2} /> Exit demo
      </button>
    </div>
  )
}
