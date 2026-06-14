/**
 * Theme system — supports "light", "dark", and "system" (follows OS preference).
 * Persists to localStorage. Applies the `dark` class to <html>.
 */
import { createContext, useContext, useEffect, useMemo, useState, ReactNode } from "react"

export type Theme = "light" | "dark" | "system"

interface ThemeContextValue {
  theme:     Theme
  resolved:  "light" | "dark"   // actual applied theme (system → resolved)
  setTheme:  (t: Theme) => void
}

const ThemeContext = createContext<ThemeContextValue>({
  theme:    "system",
  resolved: "light",
  setTheme: () => {},
})

export function useTheme() {
  return useContext(ThemeContext)
}

function getSystemTheme(): "light" | "dark" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

function applyTheme(theme: Theme): "light" | "dark" {
  const resolved = theme === "system" ? getSystemTheme() : theme
  const root = document.documentElement
  if (resolved === "dark") {
    root.classList.add("dark")
  } else {
    root.classList.remove("dark")
  }
  return resolved
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    return (localStorage.getItem("nordavix-theme") as Theme) ?? "system"
  })
  const [resolved, setResolved] = useState<"light" | "dark">(() => applyTheme(
    (localStorage.getItem("nordavix-theme") as Theme) ?? "system"
  ))

  // Apply theme on change
  useEffect(() => {
    const r = applyTheme(theme)
    setResolved(r)
    localStorage.setItem("nordavix-theme", theme)
  }, [theme])

  // Watch OS preference changes when on "system"
  useEffect(() => {
    if (theme !== "system") return
    const mq = window.matchMedia("(prefers-color-scheme: dark)")
    const handler = () => setResolved(applyTheme("system"))
    mq.addEventListener("change", handler)
    return () => mq.removeEventListener("change", handler)
  }, [theme])

  // Memoize the context value so consumers of useTheme() only re-render when
  // theme/resolved actually change — not on every ThemeProvider render.
  // setThemeState is a stable dispatcher, so it doesn't need to be a dependency.
  const value = useMemo(() => ({ theme, resolved, setTheme: setThemeState }), [theme, resolved])

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  )
}
