/**
 * CommentThread — a discussion thread for any entity, with @mentions.
 *
 * Reusable: drop it in any drawer/panel with an (entityType, entityId). Loads
 * the thread, renders authors (names via useUserNames), and a composer with
 * @mention autocomplete sourced from workspace members. Posting fans out
 * mention notifications + emails on the backend. `link` is the in-app deep link
 * the mention notification opens (usually the current drawer route).
 */
import { useMemo, useRef, useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { Send, Trash2, AtSign } from "lucide-react"
import { Button, Spinner } from "@/core/ui/components"
import { workspaceApi } from "@/modules/workspace/api"
import { useUserNames } from "@/modules/workspace/hooks"
import { commentsApi, type CommentItem } from "./api"

interface Props {
  entityType: string
  entityId:   string
  /** Deep link the mention notification/email should open. */
  link?:      string
}

function timeAgo(iso: string): string {
  if (!iso) return ""
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ""
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (secs < 60) return "just now"
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d ago`
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "?"
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

/** Render a comment body, bolding @Name tokens we know are real mentions. */
function renderBody(body: string, mentionNames: string[]): React.ReactNode {
  const names = mentionNames.filter(Boolean).sort((a, b) => b.length - a.length)
  if (names.length === 0) return body
  const nodes: React.ReactNode[] = []
  let i = 0
  let key = 0
  while (i < body.length) {
    let matched: string | null = null
    if (body[i] === "@") {
      for (const n of names) {
        if (body.startsWith("@" + n, i)) { matched = n; break }
      }
    }
    if (matched) {
      nodes.push(
        <span key={key++} style={{ color: "var(--green)", fontWeight: 600 }}>@{matched}</span>,
      )
      i += matched.length + 1
    } else {
      let j = body.indexOf("@", i + 1)
      if (j === -1) j = body.length
      nodes.push(<span key={key++}>{body.slice(i, j)}</span>)
      i = j
    }
  }
  return nodes
}

export function CommentThread({ entityType, entityId, link }: Props) {
  const qc = useQueryClient()
  const taRef = useRef<HTMLTextAreaElement>(null)

  const [value, setValue] = useState("")
  // Members the user has picked from the @ dropdown (name→id), filtered at
  // submit to those whose token is still present in the text.
  const [picked, setPicked] = useState<{ id: string; name: string }[]>([])
  const [menuQuery, setMenuQuery] = useState<string | null>(null)  // null = closed
  const [menuActive, setMenuActive] = useState(0)
  const [atIndex, setAtIndex] = useState(0)

  const { data: comments = [], isLoading } = useQuery({
    queryKey: ["comments", entityType, entityId],
    queryFn:  () => commentsApi.list(entityType, entityId),
    enabled:  !!entityId,
  })
  const { data: members = [] } = useQuery({
    queryKey: ["workspace-members"],
    queryFn:  workspaceApi.listMembers,
    staleTime: 5 * 60_000,
  })
  const { data: me } = useQuery({
    queryKey: ["workspace-me"],
    queryFn:  workspaceApi.getMe,
    staleTime: 5 * 60_000,
  })

  // Resolve every author + mentioned id to a display name in one batch.
  const nameIds = useMemo(() => {
    const set = new Set<string>()
    for (const c of comments) {
      set.add(c.author_user_id)
      for (const m of c.mentions) set.add(m)
    }
    return Array.from(set)
  }, [comments])
  const names = useUserNames(nameIds)

  // Members that can actually be mentioned (have an internal id).
  const mentionable = useMemo(
    () => members.filter((m) => m.id) as { id: string; display_name: string }[],
    [members],
  )
  const menuMatches = useMemo(() => {
    if (menuQuery === null) return []
    const q = menuQuery.toLowerCase()
    return mentionable
      .filter((m) => !q || m.display_name.toLowerCase().includes(q))
      .slice(0, 6)
  }, [menuQuery, mentionable])

  const create = useMutation({
    mutationFn: (input: { body: string; mentionedUserIds: string[] }) =>
      commentsApi.create({ entityType, entityId, link, ...input }),
    onSuccess: () => {
      setValue("")
      setPicked([])
      setMenuQuery(null)
      qc.invalidateQueries({ queryKey: ["comments", entityType, entityId] })
    },
  })
  const del = useMutation({
    mutationFn: (id: string) => commentsApi.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["comments", entityType, entityId] }),
  })

  function syncMenu(text: string, caret: number) {
    const upto = text.slice(0, caret)
    const at = upto.lastIndexOf("@")
    if (at === -1 || (at > 0 && !/\s/.test(text[at - 1]))) {
      setMenuQuery(null)
      return
    }
    const q = text.slice(at + 1, caret)
    if (q.length > 30 || q.includes("\n")) { setMenuQuery(null); return }
    setAtIndex(at)
    setMenuQuery(q)
    setMenuActive(0)
  }

  function onChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setValue(e.target.value)
    syncMenu(e.target.value, e.target.selectionStart ?? e.target.value.length)
  }

  function pick(member: { id: string; display_name: string }) {
    const caret = taRef.current?.selectionStart ?? value.length
    const before = value.slice(0, atIndex)
    const after = value.slice(caret)
    const insert = `@${member.display_name} `
    const next = before + insert + after
    setValue(next)
    setPicked((p) => (p.some((x) => x.id === member.id) ? p : [...p, { id: member.id, name: member.display_name }]))
    setMenuQuery(null)
    // Restore focus + caret just after the inserted mention.
    const pos = before.length + insert.length
    requestAnimationFrame(() => {
      taRef.current?.focus()
      taRef.current?.setSelectionRange(pos, pos)
    })
  }

  function submit() {
    const body = value.trim()
    if (!body || create.isPending) return
    const mentionedUserIds = Array.from(
      new Set(picked.filter((p) => body.includes(`@${p.name}`)).map((p) => p.id)),
    )
    create.mutate({ body, mentionedUserIds })
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (menuQuery !== null && menuMatches.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setMenuActive((a) => Math.min(a + 1, menuMatches.length - 1)); return }
      if (e.key === "ArrowUp") { e.preventDefault(); setMenuActive((a) => Math.max(a - 1, 0)); return }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(menuMatches[menuActive]); return }
      if (e.key === "Escape") { e.preventDefault(); setMenuQuery(null); return }
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit() }
  }

  const visible = comments.filter((c) => !c.deleted)

  return (
    <div className="flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold" style={{ color: "var(--text)" }}>Discussion</span>
        {visible.length > 0 && (
          <span className="text-xs tabular-nums" style={{ color: "var(--text-muted)" }}>· {visible.length}</span>
        )}
      </div>

      {/* Thread */}
      <div className="space-y-3 max-h-[42vh] overflow-y-auto pr-1">
        {isLoading && (
          <div className="flex items-center gap-2 py-3 text-sm" style={{ color: "var(--text-muted)" }}>
            <Spinner /> Loading…
          </div>
        )}
        {!isLoading && visible.length === 0 && (
          <p className="text-sm py-2" style={{ color: "var(--text-muted)" }}>
            No comments yet. Start the discussion — @mention a teammate to loop them in.
          </p>
        )}
        {visible.map((c: CommentItem) => {
          const author = names[c.author_user_id] ?? "—"
          const mentionNames = c.mentions.map((id) => names[id]).filter((n) => n && n !== "—")
          const canDelete = me?.id === c.author_user_id || me?.role === "admin"
          return (
            <div key={c.id} className="flex gap-2.5">
              <div className="h-7 w-7 shrink-0 rounded-full flex items-center justify-center text-[10px] font-bold"
                style={{ background: "var(--surface-2)", color: "var(--text-muted)", border: "1px solid var(--border)" }}>
                {initials(author)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold truncate" style={{ color: "var(--text)" }}>{author}</span>
                  <span className="text-[10px] shrink-0" style={{ color: "var(--text-muted)" }}>{timeAgo(c.created_at)}</span>
                  {canDelete && (
                    <button
                      onClick={() => del.mutate(c.id)}
                      className="ml-auto shrink-0 opacity-50 hover:opacity-100 transition-opacity"
                      style={{ color: "var(--text-muted)" }}
                      title="Delete comment"
                    >
                      <Trash2 size={12} strokeWidth={1.8} />
                    </button>
                  )}
                </div>
                <p className="text-sm whitespace-pre-wrap break-words mt-0.5" style={{ color: "var(--text)" }}>
                  {renderBody(c.body, mentionNames)}
                </p>
              </div>
            </div>
          )
        })}
      </div>

      {/* Composer */}
      <div className="relative">
        <textarea
          ref={taRef}
          value={value}
          onChange={onChange}
          onKeyDown={onKeyDown}
          rows={3}
          placeholder="Add a comment… use @ to mention a teammate"
          className="w-full rounded-lg px-3 py-2 text-sm outline-none resize-none"
          style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }}
        />

        {/* @mention dropdown */}
        {menuQuery !== null && menuMatches.length > 0 && (
          <div className="absolute left-2 bottom-[58px] z-30 rounded-lg py-1 min-w-[200px] max-h-[200px] overflow-y-auto"
            style={{ background: "var(--surface)", border: "1px solid var(--border-strong)", boxShadow: "0 8px 28px -8px rgba(0,0,0,0.3)" }}>
            {menuMatches.map((m, i) => (
              <button
                key={m.id}
                onMouseEnter={() => setMenuActive(i)}
                onMouseDown={(e) => { e.preventDefault(); pick(m) }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm"
                style={{ background: i === menuActive ? "var(--green-subtle)" : "transparent", color: "var(--text)" }}
              >
                <AtSign size={12} strokeWidth={1.8} style={{ color: "var(--text-muted)" }} />
                <span className="truncate">{m.display_name}</span>
              </button>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between mt-2">
          <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>⌘↵ to send</span>
          <Button
            size="sm"
            icon={<Send size={12} strokeWidth={1.8} />}
            disabled={!value.trim()}
            loading={create.isPending}
            onClick={submit}
          >
            Comment
          </Button>
        </div>
      </div>
    </div>
  )
}
