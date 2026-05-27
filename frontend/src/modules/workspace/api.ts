import { apiClient } from "@/core/api/client"

export type NordavixRole = "admin" | "reviewer" | "preparer"

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
}

export interface MeResponse {
  id:            string
  clerk_user_id: string
  email:         string
  role:          NordavixRole
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

export const workspaceApi = {
  listMembers,
  lookupUsers,
  getMe,
  setMemberRole,
  listInvitations,
  createInvitation,
  revokeInvitation,
}
