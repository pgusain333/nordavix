/**
 * Nordavix design system — core UI primitives.
 *
 * Design tokens:
 *   ink (#0E1112) default button bg, white text
 *   green (#3E8F66 / #5BB089) active / accent state
 *   Space Grotesk font (inherited from body)
 *
 * Button heights: sm=26px, default=32px, lg=40px
 * Icon stroke: 1.6, icon size: 22px
 * Selection controls: green-500 when active
 */
import { type VariantProps, cva } from "class-variance-authority"
import { forwardRef, type ReactNode, type InputHTMLAttributes, type HTMLAttributes } from "react"
import { cn } from "@/core/ui/utils"

// ── Button ─────────────────────────────────────────────────────────────────────

const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-1.5 font-medium transition-colors",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20",
    "disabled:pointer-events-none disabled:opacity-40",
    "rounded-[6px] whitespace-nowrap select-none",
  ].join(" "),
  {
    variants: {
      variant: {
        default:     "bg-ink text-white hover:bg-ink/88 active:bg-ink/80",
        green:       "bg-green text-white hover:bg-green-600 active:bg-green-600",
        outline:     "border border-ink-100 text-ink bg-transparent hover:bg-ink-50 active:bg-ink-100",
        ghost:       "text-ink hover:bg-ink-50 active:bg-ink-100",
        destructive: "bg-unfav text-white hover:bg-unfav/90",
        link:        "text-green underline-offset-4 hover:underline p-0 h-auto font-normal",
      },
      size: {
        sm:       "h-[26px] px-2.5 text-xs",
        default:  "h-8 px-3 text-sm",
        lg:       "h-10 px-4 text-sm",
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
        <svg
          className="animate-spin h-3.5 w-3.5 shrink-0"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle
            className="opacity-25"
            cx="12" cy="12" r="10"
            stroke="currentColor" strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
          />
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
        default:    "bg-ink-100 text-ink-600",
        pending:    "bg-ink-100 text-ink-600",
        generating: "bg-material-light text-material",
        generated:  "bg-green-50 text-green",
        approved:   "bg-green-50 text-green-600",
        edited:     "bg-blue-50 text-blue-700",
        flagged:    "bg-unfav-light text-unfav",
        material:   "bg-material-light text-material font-semibold",
        soon:       "bg-ink-100 text-ink-400 uppercase tracking-widest text-[9px]",
        error:      "bg-unfav-light text-unfav",
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
          variant === "approved" || variant === "generated" ? "bg-green" :
          variant === "flagged" || variant === "error" ? "bg-unfav" :
          variant === "generating" ? "bg-material" :
          "bg-ink-400"
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
    <label
      className="flex items-center gap-2 cursor-pointer select-none"
      htmlFor={id}
    >
      <input
        type="checkbox"
        id={id}
        className={cn(
          "h-4 w-4 rounded border-[1.5px] border-ink-200 cursor-pointer",
          "checked:bg-green checked:border-green focus:ring-2 focus:ring-green/20",
          "accent-green transition-colors",
          className
        )}
        {...props}
      />
      {label && <span className="text-sm text-ink">{label}</span>}
    </label>
  )
}

// ── Radio ─────────────────────────────────────────────────────────────────────

interface RadioProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
}

function Radio({ className, label, id, ...props }: RadioProps) {
  return (
    <label
      className="flex items-center gap-2 cursor-pointer select-none"
      htmlFor={id}
    >
      <input
        type="radio"
        id={id}
        className={cn(
          "h-4 w-4 border-[1.5px] border-ink-200 cursor-pointer accent-green",
          className
        )}
        {...props}
      />
      {label && <span className="text-sm text-ink">{label}</span>}
    </label>
  )
}

// ── Spinner ───────────────────────────────────────────────────────────────────

function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cn("animate-spin h-5 w-5 text-ink-400", className)}
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  )
}

// ── Card ──────────────────────────────────────────────────────────────────────

function Card({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "bg-white rounded-lg border border-ink-100 shadow-card",
        className
      )}
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
        <label htmlFor={id} className="text-xs font-medium text-ink-600">
          {label}
        </label>
      )}
      <select
        id={id}
        className={cn(
          "h-8 rounded-[6px] border border-ink-100 bg-white px-2.5 text-sm text-ink",
          "focus:outline-none focus:ring-2 focus:ring-green/20 focus:border-green",
          "disabled:opacity-40",
          error && "border-unfav",
          className
        )}
        {...props}
      >
        {children}
      </select>
      {error && <p className="text-xs text-unfav">{error}</p>}
    </div>
  )
}

// ── Input ─────────────────────────────────────────────────────────────────────

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
}

function Input({ className, label, error, id, ...props }: InputProps) {
  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label htmlFor={id} className="text-xs font-medium text-ink-600">
          {label}
        </label>
      )}
      <input
        id={id}
        className={cn(
          "h-8 rounded-[6px] border border-ink-100 bg-white px-2.5 text-sm text-ink",
          "placeholder:text-ink-400",
          "focus:outline-none focus:ring-2 focus:ring-green/20 focus:border-green",
          "disabled:opacity-40",
          error && "border-unfav",
          className
        )}
        {...props}
      />
      {error && <p className="text-xs text-unfav">{error}</p>}
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
