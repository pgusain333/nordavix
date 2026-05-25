import { apiClient } from "@/core/api/client"

export interface WorkspaceMember {
  id:            string | null   // our internal user UUID (null if never signed in)
  clerk_user_id: string
  first_name:    string
  last_name:     string
  display_name:  string
  email:         string | null
  image_url:     string | null
  role:          string | null
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

export const workspaceApi = { listMembers, lookupUsers }
