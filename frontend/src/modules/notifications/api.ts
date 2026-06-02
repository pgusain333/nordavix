import { apiClient } from "@/core/api/client"

/** Window event any control can dispatch to open the notifications panel
 *  (mirrors the ⌘K command-palette pattern). */
export const NOTIF_EVENT = "nordavix:open-notifications"

export interface NotificationItem {
  id:         string
  type:       string
  title:      string
  body:       string | null
  link:       string | null
  read:       boolean
  created_at: string
}

export interface NotificationList {
  items:  NotificationItem[]
  unread: number
}

async function list(limit = 30): Promise<NotificationList> {
  const { data } = await apiClient.get<NotificationList>("/api/notifications", {
    params: { limit },
  })
  return data
}

async function count(): Promise<number> {
  const { data } = await apiClient.get<{ unread: number }>("/api/notifications/count")
  return data.unread
}

/** Mark notifications read. With `ids`, marks those; otherwise marks all unread. */
async function markRead(ids?: string[]): Promise<void> {
  await apiClient.post("/api/notifications/read", ids ? { ids } : {})
}

export interface NotificationPreferences {
  email_notifications_enabled: boolean
}

async function getPreferences(): Promise<NotificationPreferences> {
  const { data } = await apiClient.get<NotificationPreferences>("/api/notifications/preferences")
  return data
}

async function setPreferences(prefs: NotificationPreferences): Promise<NotificationPreferences> {
  const { data } = await apiClient.patch<NotificationPreferences>("/api/notifications/preferences", prefs)
  return data
}

export const notificationsApi = { list, count, markRead, getPreferences, setPreferences }
