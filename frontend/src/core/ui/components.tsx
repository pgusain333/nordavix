/**
 * Nordavix design system — core UI primitives.
 *
 * All buttons: green background, white text (brand standard).
 * Dark mode: all form elements use CSS var tokens.
 */
import { type VariantProps, cva } from "class-variance-authority"
import { forwardRef, type ReactNode, type InputHTMLAttributes, type HTMLAttributes } from "react"
import { cn } from "@/core/ui/utils"

// ── Button ─────────────────────────────────────────────────────────────────────

const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-1.5 font-semibold transition-all duration-150",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--green)]/30",
    "disabled:pointer-events-none disabled:opacity-40",
    "rounded-[8px] whitespace-nowrap select-none",
  ].join(" "),
  {
    variants: {
      variant: {
        // Primary — green bg, white text (brand standard for all CTAs)
        default:     "bg-[var(--green)] text-white hover:opacity-90 active:opacity-80 shadow-sm",
        green:       "bg-[var(--green)] text-white hover:opacity-90 active:opacity-80 shadow-sm",
        // Outline — visible in both light and dark mode
        outline:     "border border-[var(--border-strong)] text-[var(--text)] bg-transparent hover:bg-[var(--surface-2)] active:bg-[var(--border)]",
        ghost:       "text-[var(--text-2)] bg-transparent hover:bg-[var(--surface-2)] active:bg-[var(--border)]",
        destructive: "bg-[#9b3d37] text-white hover:bg-[#9b3d37] shadow-sm",
        link:        "text-[var(--green)] underline-offset-4 hover:underline p-0 h-auto font-normal shadow-none",
      },
      size: {
        sm:       "h-[26px] px-2.5 text-xs",
        default:  "h-8 px-3.5 text-sm",
        lg:       "h-10 px-5 text-sm",
        icon:     "h-8 w-8 p-0",
        "icon-sm":"h-[26px] w-[26px] p-0",
        "icon-lg":"h-10 w-10 p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  loading?: boolean
  icon?: ReactNode
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, loading, icon, children, disabled, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <svg className="animate-spin h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      ) : icon ? (
        <span className="shrink-0">{icon}</span>
      ) : null}
      {children}
    </button>
  )
)
Button.displayName = "Button"

// ── Badge ──────────────────────────────────────────────────────────────────────

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
  {
    variants: {
      variant: {
        default:    "bg-[var(--surface-2)] text-[var(--text-2)]",
        pending:    "bg-[var(--surface-2)] text-[var(--text-2)]",
        generating: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
        generated:  "bg-[var(--green-subtle)] text-[var(--green)]",
        approved:   "bg-[var(--green-subtle)] text-[var(--green)]",
        edited:     "bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
        flagged:    "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400",
        material:   "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400 font-semibold",
        soon:       "bg-[var(--surface-2)] text-[var(--text-muted)] uppercase tracking-widest text-[9px]",
        error:      "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400",
      },
    },
    defaultVariants: { variant: "default" },
  }
)

type BadgeVariant =
  | "default" | "pending" | "generating" | "generated"
  | "approved" | "edited" | "flagged" | "material" | "soon" | "error"

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant
  dot?: boolean
}

function Badge({ className, variant = "default", dot, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props}>
      {dot && (
        <span className={cn(
          "inline-block h-1.5 w-1.5 rounded-full",
          variant === "approved" || variant === "generated" ? "bg-[var(--green)]" :
          variant === "flagged" || variant === "error" ? "bg-red-500" :
          variant === "generating" || variant === "material" ? "bg-amber-500" :
          "bg-[var(--border-strong)]"
        )} />
      )}
      {children}
    </span>
  )
}

// ── StatusBadge ────────────────────────────────────────────────────────────────

export type VarianceStatus = "pending" | "generating" | "generated" | "approved" | "edited" | "flagged"
export type TBStatus = "pending" | "processing" | "parsed" | "ready_for_review" | "generating" | "complete" | "error"

const VARIANCE_STATUS_LABELS: Record<VarianceStatus, string> = {
  pending:    "Pending",
  generating: "Generating…",
  generated:  "AI Generated",
  approved:   "Approved",
  edited:     "Edited",
  flagged:    "Flagged",
}

function StatusBadge({ status }: { status: VarianceStatus | TBStatus | string }) {
  const v = status as VarianceStatus
  return (
    <Badge variant={v as BadgeVariant} dot>
      {VARIANCE_STATUS_LABELS[v] ?? status}
    </Badge>
  )
}

// ── Checkbox ──────────────────────────────────────────────────────────────────

interface CheckboxProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
}

function Checkbox({ className, label, id, ...props }: CheckboxProps) {
  return (
    <label className="flex items-center gap-2 cursor-pointer select-none" htmlFor={id}>
      <input
        type="checkbox"
        id={id}
        className={cn(
          "h-4 w-4 rounded border-[1.5px] border-[var(--border-strong)] cursor-pointer",
          "checked:bg-[var(--green)] checked:border-[var(--green)]",
          "focus:ring-2 focus:ring-[var(--green)]/20 accent-[var(--green)] transition-colors",
          className
        )}
        {...props}
      />
      {label && <span className="text-sm text-theme">{label}</span>}
    </label>
  )
}

// ── Radio ─────────────────────────────────────────────────────────────────────

interface RadioProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
}

function Radio({ className, label, id, ...props }: RadioProps) {
  return (
    <label className="flex items-center gap-2 cursor-pointer select-none" htmlFor={id}>
      <input
        type="radio"
        id={id}
        className={cn(
          "h-4 w-4 border-[1.5px] border-[var(--border-strong)] cursor-pointer accent-[var(--green)]",
          className
        )}
        {...props}
      />
      {label && <span className="text-sm text-theme">{label}</span>}
    </label>
  )
}

// ── Spinner ───────────────────────────────────────────────────────────────────

function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn("animate-spin h-5 w-5", className)} fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  )
}

// ── Card ──────────────────────────────────────────────────────────────────────

function Card({ className, children, style, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-xl", className)}
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        boxShadow: "var(--card-shadow)",
        ...style,
      }}
      {...props}
    >
      {children}
    </div>
  )
}

// ── Select ────────────────────────────────────────────────────────────────────

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string
  error?: string
}

function Select({ className, label, error, id, children, ...props }: SelectProps) {
  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label htmlFor={id} className="text-xs font-medium" style={{ color: "var(--text-2)" }}>
          {label}
        </label>
      )}
      <select
        id={id}
        className={cn(
          "h-9 rounded-[8px] px-2.5 text-sm",
          "focus:outline-none focus:ring-2 focus:ring-[var(--green)]/20",
          "disabled:opacity-40",
          error && "ring-1 ring-red-500",
          className
        )}
        style={{
          background: "var(--surface)",
          border: `1px solid ${error ? "#9b3d37" : "var(--border-strong)"}`,
          color: "var(--text)",
        }}
        {...props}
      >
        {children}
      </select>
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  )
}

// ── Input ─────────────────────────────────────────────────────────────────────

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
  hint?: string
  error?: string
}

function Input({ className, label, hint, error, id, ...props }: InputProps) {
  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label htmlFor={id} className="text-xs font-medium" style={{ color: "var(--text-2)" }}>
          {label}
        </label>
      )}
      <input
        id={id}
        className={cn(
          "h-9 rounded-[8px] px-2.5 text-sm w-full",
          "focus:outline-none focus:ring-2 focus:ring-[var(--green)]/20",
          "disabled:opacity-40",
          "placeholder:opacity-40",
          className
        )}
        style={{
          background: "var(--surface)",
          border: `1px solid ${error ? "#9b3d37" : "var(--border-strong)"}`,
          color: "var(--text)",
        }}
        {...props}
      />
      {hint && !error && <p className="text-xs" style={{ color: "var(--text-muted)" }}>{hint}</p>}
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  )
}

export {
  Button, buttonVariants,
  Badge,
  StatusBadge,
  Checkbox,
  Radio,
  Spinner,
  Card,
  Select,
  Input,
}
export type { ButtonProps, BadgeProps, CheckboxProps, RadioProps, InputProps, SelectProps }
