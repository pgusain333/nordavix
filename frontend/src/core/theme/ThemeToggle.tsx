/**
 * ThemeToggle — compact 3-way toggle: Light / Dark / System.
 * Shown in the bottom of LeftNav.
 */
import { Sun, Moon, Monitor } from "lucide-react"
import { useTheme, type Theme } from "./ThemeProvider"
import { cn } from "@/core/ui/utils"

const OPTIONS: { value: Theme; icon: React.ElementType; label: string }[] = [
  { value: "light",  icon: Sun,     label: "Light"  },
  { value: "dark",   icon: Moon,    label: "Dark"   },
  { value: "system", icon: Monitor, label: "System" },
]

export function ThemeToggle() {
  const { theme, setTheme } = useTheme()

  return (
    <div className="flex items-center gap-0.5 rounded-lg p-0.5"
      style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
      {OPTIONS.map(({ value, icon: Icon, label }) => (
        <button
          key={value}
          title={label}
          onClick={() => setTheme(value)}
          className={cn(
            "flex items-center justify-center h-6 w-6 rounded-md transition-all duration-150",
            theme === value
              ? "bg-surface shadow-sm text-theme"
              : "text-theme-muted hover:text-theme-2"
          )}
          style={theme === value ? { background: "var(--surface)" } : undefined}
        >
          <Icon size={13} strokeWidth={1.8} />
        </button>
      ))}
    </div>
  )
}
