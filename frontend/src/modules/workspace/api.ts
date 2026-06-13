import { apiClient } from "@/core/api/client"

export type NordavixRole = "admin" | "reviewer" | "preparer"

/** Admin-powers an admin can delegate to a non-admin (must match the backend
 *  DELEGATABLE_POWERS set). The role still governs prepare vs approve. */
export type MemberPower = "autopilot" | "pbc" | "period_lock" | "qbo"

export interface PowerDef { key: MemberPower; label: string; description: string }

export const POWER_CATALOG: PowerDef[] = [
  { key: "autopilot",   label: "Run Close Autopilot",     description: "Configure and trigger the unattended auto-close." },
  { key: "pbc",         label: "Send client doc requests", description: "Email clients magic-link evidence requests." },
  { key: "period_lock", label: "Lock / reopen the period", description: "Close the books for a period and reopen them." },
  { key: "qbo",         label: "Manage QuickBooks",        description: "Connect or disconnect the QuickBooks data source." },
]

export interface WorkspaceMember {
  id:            string | null   // our internal user UUID (null if never signed in)
  clerk_user_id: string
  first_name:    string
  last_name:     string
  display_name:  string
  email:         string | null
  image_url:     string | null
  clerk_role:    string | null   // Clerk's org role ('org:admin' / 'org:member')
  role:          NordavixRole    // Our 3-tier role
  delegated_powers: MemberPower[]
  suspended:     boolean
}

export interface MeResponse {
  id:            string
  clerk_user_id: string
  email:         string
  role:          NordavixRole
  delegated_powers: MemberPower[]
  suspended:     boolean
}

/** True if the user can perform `power` — admins always can; others need the
 *  explicit grant. Mirrors the backend require_capability. */
export function hasPower(me: MeResponse | null | undefined, power: MemberPower): boolean {
  if (!me) return false
  if (me.role === "admin") return true
  return (me.delegated_powers ?? []).includes(power)
}

export interface Invitation {
  id:             string
  email:          string
  clerk_role:     string
  nordavix_role:  NordavixRole
  created_at:     string | number | null
  expires_at:     string | number | null
  status:         string
}

export interface UserLookupEntry {
  display_name:  string
  email:         string | null
  image_url:     string | null
  clerk_user_id: string | null
}

async function listMembers(): Promise<WorkspaceMember[]> {
  const { data } = await apiClient.get<{ members: WorkspaceMember[] }>("/api/workspace/members")
  return data.members
}

async function lookupUsers(ids: string[]): Promise<Record<string, UserLookupEntry>> {
  if (ids.length === 0) return {}
  const { data } = await apiClient.get<{ users: Record<string, UserLookupEntry> }>(
    "/api/workspace/users/lookup",
    { params: { ids: ids.join(",") } },
  )
  return data.users
}

async function getMe(): Promise<MeResponse> {
  const { data } = await apiClient.get<MeResponse>("/api/workspace/me")
  return data
}

async function setMemberRole(memberId: string, role: NordavixRole): Promise<{ id: string; role: NordavixRole }> {
  const { data } = await apiClient.post(`/api/workspace/members/${memberId}/role`, { role })
  return data
}

async function setMemberCapabilities(
  memberId: string, powers: MemberPower[],
): Promise<{ id: string; delegated_powers: MemberPower[] }> {
  const { data } = await apiClient.put(`/api/workspace/members/${memberId}/capabilities`, { powers })
  return data
}

async function setMemberSuspended(
  memberId: string, suspended: boolean,
): Promise<{ id: string; suspended: boolean }> {
  const action = suspended ? "suspend" : "restore"
  const { data } = await apiClient.post(`/api/workspace/members/${memberId}/${action}`)
  return data
}

async function listInvitations(): Promise<Invitation[]> {
  const { data } = await apiClient.get<{ invitations: Invitation[] }>("/api/workspace/invitations")
  return data.invitations
}

async function createInvitation(email: string, role: NordavixRole): Promise<Invitation> {
  const { data } = await apiClient.post("/api/workspace/invitations", { email, role })
  return data
}

async function revokeInvitation(id: string): Promise<void> {
  await apiClient.delete(`/api/workspace/invitations/${encodeURIComponent(id)}`)
}

export interface DeleteWorkspaceResponse {
  deleted:         boolean
  already_deleted?: boolean
  purge_after?:    string | null   // ISO — when the data is permanently purged
  grace_days?:     number
  qbo_revoked?:    boolean | null
}

/**
 * Delete the active workspace on the Nordavix backend. Revokes the QBO token
 * and soft-deletes the tenant (inaccessible immediately; hard-purged after the
 * grace window). Call this BEFORE Clerk's organization.destroy() so the request
 * still resolves a valid org from the JWT.
 */
async function deleteWorkspace(): Promise<DeleteWorkspaceResponse> {
  const { data } = await apiClient.delete<DeleteWorkspaceResponse>("/api/workspace")
  return data
}

export interface AiUsage {
  cap_usd:       number   // 0 = no dollar cap configured
  spent_usd:     number   // estimated AI spend this calendar month
  remaining_usd: number   // max(0, cap - spent)
  exceeded:      boolean   // at/over the cap
  enforced:      boolean   // whether the cap actually blocks
  resets_at:     string    // ISO — first instant of next month
}

/** Current-month AI spend vs the workspace cap (for the Settings usage card). */
async function getAiUsage(): Promise<AiUsage> {
  const { data } = await apiClient.get<AiUsage>("/api/workspace/ai-usage")
  return data
}

export const workspaceApi = {
  listMembers,
  lookupUsers,
  getMe,
  setMemberRole,
  setMemberCapabilities,
  setMemberSuspended,
  listInvitations,
  createInvitation,
  revokeInvitation,
  deleteWorkspace,
  getAiUsage,
}
