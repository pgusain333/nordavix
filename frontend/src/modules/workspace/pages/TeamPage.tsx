/**
 * Team page — admin invitations + role management.
 *
 * Admin-only actions are gated server-side; the frontend just hides the
 * controls for non-admins so the page renders gracefully for everyone.
 *
 *   - "Members" table: name + email + role dropdown (admin-only) + clerk role
 *   - "Pending invitations" table with revoke button
 *   - "Invite new member" form (email + role) at the top
 */
import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  UserPlus, Users, Crown, Eye, Pencil, Mail, X, AlertTriangle, CheckCircle2,
} from "lucide-react"
import { Button, Spinner } from "@/core/ui/components"
import { workspaceApi, type NordavixRole } from "@/modules/workspace/api"

const ROLE_LABELS: Record<NordavixRole, { label: string; icon: React.ReactNode; bg: string; fg: string; help: string }> = {
  admin:    {
    label: "Admin",
    icon: <Crown size={11} strokeWidth={1.8} />,
    bg: "rgba(245, 158, 11, 0.15)", fg: "#b45309",
    help: "Full access — can invite, manage roles, set books, approve.",
  },
  reviewer: {
    label: "Reviewer",
    icon: <Eye size={11} strokeWidth={1.8} />,
    bg: "#dbeafe", fg: "#1d4ed8",
    help: "Can approve / flag / mark reviewed. Cannot manage team.",
  },
  preparer: {
    label: "Preparer",
    icon: <Pencil size={11} strokeWidth={1.8} />,
    bg: "var(--surface-2)", fg: "var(--text-muted)",
    help: "Can enter overrides + attach evidence. Cannot approve own work.",
  },
}

export function TeamPage() {
  const qc = useQueryClient()
  const [inviteEmail, setInviteEmail] = useState("")
  const [inviteRole, setInviteRole] = useState<NordavixRole>("preparer")
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [inviteSuccess, setInviteSuccess] = useState<string | null>(null)

  const { data: me } = useQuery({
    queryKey: ["workspace-me"], queryFn: workspaceApi.getMe, staleTime: 60_000,
  })
  const { data: members, isLoading: membersLoading } = useQuery({
    queryKey: ["workspace-members"], queryFn: workspaceApi.listMembers, staleTime: 60_000,
  })
  const { data: invitations } = useQuery({
    queryKey: ["workspace-invitations"], queryFn: workspaceApi.listInvitations, staleTime: 60_000,
  })

  const isAdmin = me?.role === "admin"

  const inviteMut = useMutation({
    mutationFn: () => workspaceApi.createInvitation(inviteEmail.trim(), inviteRole),
    onSuccess: () => {
      setInviteSuccess(`Invitation sent to ${inviteEmail.trim()}.`)
      setInviteError(null)
      setInviteEmail("")
      qc.invalidateQueries({ queryKey: ["workspace-invitations"] })
    },
    onError: (err: unknown) => {
      const ex = err as { response?: { data?: { detail?: string } }; message?: string }
      setInviteSuccess(null)
      setInviteError(ex.response?.data?.detail ?? ex.message ?? "Could not send invitation.")
    },
  })

  const roleMut = useMutation({
    mutationFn: (v: { memberId: string; role: NordavixRole }) =>
      workspaceApi.setMemberRole(v.memberId, v.role),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workspace-members"] }),
    onError: (err: unknown) => {
      const ex = err as { response?: { data?: { detail?: string } }; message?: string }
      alert(ex.response?.data?.detail ?? ex.message ?? "Could not change role.")
    },
  })

  const revokeMut = useMutation({
    mutationFn: (id: string) => workspaceApi.revokeInvitation(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workspace-invitations"] }),
  })

  const sortedMembers = useMemo(() => {
    const order = { admin: 0, reviewer: 1, preparer: 2 } as Record<NordavixRole, number>
    return [...(members ?? [])].sort((a, b) => order[a.role] - order[b.role])
  }, [members])

  return (
    <div className="flex flex-col h-full overflow-y-auto" style={{ background: "var(--bg)" }}>
      <div className="px-4 sm:px-8 pt-6 pb-4"
        style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
        <h1 style={{
          fontSize: "clamp(22px, 5vw, 28px)", fontWeight: 700, lineHeight: 1.2,
          letterSpacing: "-0.01em", color: "var(--text)", margin: 0,
        }}>
          Team
        </h1>
        <p className="text-xs sm:text-sm mt-1.5" style={{ color: "var(--text-muted)" }}>
          Manage who has access to this workspace and what they can do.
          Admins invite members and assign roles; reviewers approve work; preparers enter and edit.
        </p>
      </div>

      <div className="flex-1 px-4 sm:px-8 py-5 max-w-5xl w-full mx-auto space-y-5">

        {/* ── Invite form — admin only ─────────────────────────── */}
        {isAdmin ? (
          <div className="rounded-xl p-4"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
            <div className="flex items-center gap-2 mb-3">
              <UserPlus size={16} strokeWidth={1.8} style={{ color: "var(--green)" }} />
              <h2 className="text-sm font-semibold text-theme">Invite a team member</h2>
            </div>
            <div className="flex items-end gap-2 flex-wrap">
              <label className="flex-1 min-w-[220px]">
                <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                  Email
                </span>
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="teammate@firm.com"
                  className="w-full rounded-lg px-3 py-2 mt-1 text-sm outline-none"
                  style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }}
                />
              </label>
              <label className="w-48">
                <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                  Role
                </span>
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as NordavixRole)}
                  className="w-full rounded-lg px-3 py-2 mt-1 text-sm outline-none"
                  style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }}
                >
                  <option value="preparer">Preparer</option>
                  <option value="reviewer">Reviewer</option>
                  <option value="admin">Admin</option>
                </select>
              </label>
              <Button size="sm" icon={<Mail size={12} strokeWidth={1.8} />}
                loading={inviteMut.isPending}
                disabled={!inviteEmail.includes("@")}
                onClick={() => inviteMut.mutate()}>
                Send invitation
              </Button>
            </div>
            <p className="text-[10px] mt-2" style={{ color: "var(--text-muted)" }}>
              {ROLE_LABELS[inviteRole].help}
            </p>
            {inviteError && (
              <div className="mt-2 rounded-md p-2 text-xs flex items-start gap-1.5"
                style={{ background: "rgba(220, 38, 38, 0.10)", color: "#b91c1c", border: "1px solid rgba(220, 38, 38, 0.30)" }}>
                <AlertTriangle size={12} strokeWidth={1.8} className="shrink-0 mt-0.5" />
                <span>{inviteError}</span>
              </div>
            )}
            {inviteSuccess && (
              <div className="mt-2 rounded-md p-2 text-xs flex items-start gap-1.5"
                style={{ background: "var(--green-subtle)", color: "var(--green)", border: "1px solid var(--green)" }}>
                <CheckCircle2 size={12} strokeWidth={2} className="shrink-0 mt-0.5" />
                <span>{inviteSuccess}</span>
              </div>
            )}
          </div>
        ) : me ? (
          <div className="rounded-xl p-3 text-xs"
            style={{ background: "var(--surface-2)", border: "1px dashed var(--border)", color: "var(--text-muted)" }}>
            You're signed in as <span className="font-semibold text-theme">{ROLE_LABELS[me.role].label}</span>.
            Only admins can invite members or change roles. Ask your workspace admin for changes.
          </div>
        ) : null}

        {/* ── Members table ────────────────────────────────────── */}
        <div className="rounded-xl overflow-hidden"
          style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
          <div className="px-4 py-3 flex items-center gap-2"
            style={{ borderBottom: "1px solid var(--border)" }}>
            <Users size={16} strokeWidth={1.8} style={{ color: "var(--green)" }} />
            <h2 className="text-sm font-semibold text-theme">Members</h2>
            <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
              ({sortedMembers.length})
            </span>
          </div>
          {membersLoading ? (
            <div className="py-8 flex items-center justify-center"><Spinner className="h-5 w-5" /></div>
          ) : sortedMembers.length === 0 ? (
            <p className="py-6 text-xs text-center" style={{ color: "var(--text-muted)" }}>
              No members yet.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: "var(--surface-2)" }}>
                  <th className="text-left px-3 py-2 text-[10px] font-semibold uppercase tracking-wide"
                    style={{ color: "var(--text-muted)" }}>Name</th>
                  <th className="text-left px-3 py-2 text-[10px] font-semibold uppercase tracking-wide"
                    style={{ color: "var(--text-muted)" }}>Email</th>
                  <th className="text-left px-3 py-2 text-[10px] font-semibold uppercase tracking-wide"
                    style={{ color: "var(--text-muted)", width: 200 }}>Role</th>
                </tr>
              </thead>
              <tbody>
                {sortedMembers.map((m) => {
                  const meta = ROLE_LABELS[m.role]
                  const isMe = me?.clerk_user_id === m.clerk_user_id
                  return (
                    <tr key={m.clerk_user_id} style={{ borderTop: "1px solid var(--border)" }}>
                      <td className="px-3 py-2 text-theme">
                        {m.display_name}{isMe && <span className="ml-1 text-[10px]" style={{ color: "var(--green)" }}>(you)</span>}
                      </td>
                      <td className="px-3 py-2 text-xs" style={{ color: "var(--text-2)" }}>{m.email || "—"}</td>
                      <td className="px-3 py-2">
                        {isAdmin && m.id ? (
                          <select
                            value={m.role}
                            disabled={roleMut.isPending}
                            onChange={(e) => roleMut.mutate({ memberId: m.id!, role: e.target.value as NordavixRole })}
                            className="rounded-md px-2 py-1 text-xs outline-none"
                            style={{ background: meta.bg, color: meta.fg, border: `1px solid ${meta.fg}` }}
                          >
                            <option value="preparer">Preparer</option>
                            <option value="reviewer">Reviewer</option>
                            <option value="admin">Admin</option>
                          </select>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
                            style={{ background: meta.bg, color: meta.fg }}>
                            {meta.icon} {meta.label}
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* ── Pending invitations ──────────────────────────────── */}
        {(invitations?.length ?? 0) > 0 && (
          <div className="rounded-xl overflow-hidden"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
            <div className="px-4 py-3 flex items-center gap-2"
              style={{ borderBottom: "1px solid var(--border)" }}>
              <Mail size={16} strokeWidth={1.8} style={{ color: "var(--green)" }} />
              <h2 className="text-sm font-semibold text-theme">Pending invitations</h2>
              <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                ({invitations!.length})
              </span>
            </div>
            <ul>
              {invitations!.map((inv) => {
                const meta = ROLE_LABELS[inv.nordavix_role]
                return (
                  <li key={inv.id}
                    className="px-4 py-2 flex items-center gap-2 text-sm"
                    style={{ borderTop: "1px solid var(--border)" }}>
                    <Mail size={12} strokeWidth={1.8} style={{ color: "var(--text-muted)" }} />
                    <span className="text-theme">{inv.email}</span>
                    <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
                      style={{ background: meta.bg, color: meta.fg }}>
                      {meta.icon} {meta.label}
                    </span>
                    <span className="ml-auto text-[10px]" style={{ color: "var(--text-muted)" }}>
                      Sent {inv.created_at ? new Date(inv.created_at as string).toLocaleDateString() : "—"}
                    </span>
                    {isAdmin && (
                      <button
                        onClick={() => revokeMut.mutate(inv.id)}
                        disabled={revokeMut.isPending}
                        className="h-6 w-6 inline-flex items-center justify-center rounded"
                        title="Revoke invitation"
                        style={{ color: "#b91c1c" }}>
                        <X size={12} strokeWidth={1.8} />
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
