import { ReactNode } from "react"
import { cn } from "@/core/ui/utils"

interface RightContextPaneProps {
  title?: string
  children: ReactNode
  className?: string
}

export function RightContextPane({ title, children, className }: RightContextPaneProps) {
  return (
    <aside
      className={cn("flex h-screen w-80 shrink-0 flex-col", className)}
      style={{ background: "var(--surface)", borderLeft: "1px solid var(--border)" }}
    >
      {title && (
        <div className="flex items-center px-4 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
          <h2 className="text-sm font-semibold" style={{ color: "var(--text-2)" }}>{title}</h2>
        </div>
      )}
      <div className="flex-1 overflow-y-auto p-4">{children}</div>
    </aside>
  )
}
