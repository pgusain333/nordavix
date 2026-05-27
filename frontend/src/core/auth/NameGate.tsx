/**
 * NameGate — blocks access to the app until the signed-in user has both
 * a first name AND a last name set on their Clerk profile.
 *
 * Why this exists: Nordavix's audit trail attributes every close action
 * ("Prepared by", "Approved by", "Closed by") to the acting user. When
 * a user signs up via Google but Google doesn't share their name (or
 * they signed up via email-only), the display falls back to the email
 * address — which makes audit trails look like "prepared by
 * sarah@firm.com" instead of "prepared by Sarah Kim", and any PDF
 * deliverable looks unprofessional to the firm's client.
 *
 * Solution: a one-time, in-app prompt that requires both names before
 * letting the user into the rest of the app. Saves via Clerk's
 * `user.update()` which propagates the name back to our backend's
 * Clerk-user lookup automatically.
 *
 * This complements the Clerk dashboard setting:
 *   User & Authentication → Email, Phone, Username → personal info →
 *   set First name + Last name to **Required** on the sign-up form.
 *
 * Even with the dashboard setting on, this gate catches:
 *   - Users who signed up before the setting was enabled
 *   - SSO sign-ups (Google etc.) where the provider didn't share a name
 *   - Anyone who later cleared their name from Clerk's profile UI
 */
import { useEffect, useState } from "react"
import { useUser } from "@clerk/clerk-react"
import { motion } from "framer-motion"
import { UserCircle2, Sparkles } from "lucide-react"
import { Button } from "@/core/ui/components"

interface Props {
  children: React.ReactNode
}

export function NameGate({ children }: Props) {
  const { user, isLoaded } = useUser()
  const [firstName, setFirstName] = useState("")
  const [lastName,  setLastName]  = useState("")
  const [saving,    setSaving]    = useState(false)
  const [error,     setError]     = useState<string | null>(null)

  // Pre-populate from any partial name Clerk already has (e.g. Google
  // shared first name but not last). User can correct in-place.
  useEffect(() => {
    if (!user) return
    setFirstName(user.firstName ?? "")
    setLastName(user.lastName ?? "")
  }, [user?.id, user?.firstName, user?.lastName])

  // Clerk hook is still loading — render nothing rather than flash gate.
  if (!isLoaded) return null

  // No user signed in — let upstream auth guards handle redirect.
  if (!user) return <>{children}</>

  // Both names present — pass through to the rest of the app.
  if (user.firstName?.trim() && user.lastName?.trim()) {
    return <>{children}</>
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    const fn = firstName.trim()
    const ln = lastName.trim()
    if (!fn || !ln) {
      setError("Both first and last name are required.")
      return
    }
    setSaving(true)
    setError(null)
    try {
      await user!.update({ firstName: fn, lastName: ln })
      // Clerk's user object updates reactively — the next render will see
      // both names set and unmount the gate, revealing children.
    } catch (e) {
      const ex = e as { errors?: { longMessage?: string; message?: string }[]; message?: string }
      setError(
        ex.errors?.[0]?.longMessage
          ?? ex.errors?.[0]?.message
          ?? ex.message
          ?? "Could not save your name. Try again.",
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6"
      style={{ background: "var(--bg)" }}>
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-md rounded-2xl overflow-hidden"
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          boxShadow: "0 24px 64px -16px rgba(0,0,0,0.20)",
        }}>
        {/* Header */}
        <div className="p-6 sm:p-7 border-b text-center"
          style={{ borderColor: "var(--border)" }}>
          <div className="inline-flex items-center justify-center h-14 w-14 rounded-2xl mb-4"
            style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
            <UserCircle2 size={26} strokeWidth={1.8} />
          </div>
          <h1 className="text-xl font-bold text-theme leading-tight mb-1">
            What should we call you?
          </h1>
          <p className="text-sm" style={{ color: "var(--text-2)" }}>
            Your name appears on every close action you take — preparer
            stamps, reviewer approvals, signed-off PDFs. Let's get it right.
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSave} className="p-6 sm:p-7 space-y-4">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5"
              style={{ color: "var(--text-muted)" }}>
              First name
            </label>
            <input
              type="text"
              autoFocus
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              placeholder="Jane"
              disabled={saving}
              required
              className="w-full rounded-lg px-3 py-2.5 text-sm outline-none transition-colors"
              style={{
                background: "var(--surface-2)",
                border: "1px solid var(--border-strong)",
                color: "var(--text)",
              }}
              onFocus={(e) => (e.currentTarget.style.borderColor = "var(--green)")}
              onBlur={(e) => (e.currentTarget.style.borderColor = "var(--border-strong)")}
            />
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5"
              style={{ color: "var(--text-muted)" }}>
              Last name
            </label>
            <input
              type="text"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              placeholder="Smith"
              disabled={saving}
              required
              className="w-full rounded-lg px-3 py-2.5 text-sm outline-none transition-colors"
              style={{
                background: "var(--surface-2)",
                border: "1px solid var(--border-strong)",
                color: "var(--text)",
              }}
              onFocus={(e) => (e.currentTarget.style.borderColor = "var(--green)")}
              onBlur={(e) => (e.currentTarget.style.borderColor = "var(--border-strong)")}
            />
          </div>

          {error && (
            <p className="text-xs" style={{ color: "#dc2626" }}>
              {error}
            </p>
          )}

          <Button
            type="submit"
            loading={saving}
            disabled={saving || !firstName.trim() || !lastName.trim()}
            icon={<Sparkles size={13} strokeWidth={1.8} />}
            className="w-full justify-center"
          >
            Continue
          </Button>

          <p className="text-[11px] text-center" style={{ color: "var(--text-muted)" }}>
            You can change this anytime from your profile settings.
          </p>
        </form>
      </motion.div>
    </div>
  )
}
