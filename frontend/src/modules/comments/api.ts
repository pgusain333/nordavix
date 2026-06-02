import { apiClient } from "@/core/api/client"

export interface CommentItem {
  id:             string
  entity_type:    string
  entity_id:      string
  author_user_id: string
  body:           string
  mentions:       string[]
  created_at:     string
  deleted:        boolean
}

async function list(entityType: string, entityId: string): Promise<CommentItem[]> {
  const { data } = await apiClient.get<{ items: CommentItem[] }>("/api/comments", {
    params: { entity_type: entityType, entity_id: entityId },
  })
  return data.items
}

interface CreateInput {
  entityType:       string
  entityId:         string
  body:             string
  mentionedUserIds: string[]
  link?:            string | null
}

async function create(input: CreateInput): Promise<CommentItem> {
  const { data } = await apiClient.post<CommentItem>("/api/comments", {
    entity_type:        input.entityType,
    entity_id:          input.entityId,
    body:               input.body,
    mentioned_user_ids: input.mentionedUserIds,
    link:               input.link ?? null,
  })
  return data
}

async function remove(id: string): Promise<void> {
  await apiClient.delete(`/api/comments/${id}`)
}

export const commentsApi = { list, create, remove }
