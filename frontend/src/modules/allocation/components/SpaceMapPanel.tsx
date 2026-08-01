/**
 * SpaceMapPanel — the document the square footage was transcribed FROM.
 *
 * The occupancy driver is production square feet over total, and it moves every
 * occupancy-driven pool. What sits in the registry above is a preparer's
 * transcription of something the client sent: a floor plan, a surveyor's
 * schedule, a lease exhibit. On examination the question is never "what did you
 * enter" — it's "what did you enter it from", and square footage with no source
 * behind it is a number the preparer produced.
 *
 * Superseded plans stay on file. A facility re-measured in June is new evidence
 * from June, not a correction that invalidates March, so `as of` is asked for
 * and the list is ordered by it.
 */
import { useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  AlertTriangle, FileText, Image as ImageIcon, Map, Paperclip, Trash2, Upload,
} from "lucide-react"
import { Button, Input, Spinner } from "@/core/ui"
import { allocationApi, type SpaceMap } from "../api"

const ACCEPT = ".pdf,.png,.jpg,.jpeg,.webp,.gif,.xlsx,.xls,.csv,.dwg,.docx"

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function iconFor(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? ""
  if (["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) return ImageIcon
  if (ext === "pdf") return FileText
  return Paperclip
}

export function SpaceMapPanel() {
  const [label, setLabel] = useState("")
  const [asOf, setAsOf] = useState("")
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const qc = useQueryClient()

  const { data: maps = [], isLoading } = useQuery({
    queryKey: ["allocation", "space-maps"],
    queryFn:  allocationApi.listSpaceMaps,
    staleTime: 60_000,
  })

  const onError = (e: unknown) => {
    const ex = e as { response?: { data?: { detail?: string } }; message?: string }
    setError(ex.response?.data?.detail ?? ex.message ?? "Something went wrong.")
  }
  const invalidate = () => qc.invalidateQueries({ queryKey: ["allocation", "space-maps"] })

  const upload = useMutation({
    mutationFn: (file: File) => allocationApi.uploadSpaceMap(file, {
      label: label.trim() || undefined,
      as_of: asOf || undefined,
    }),
    onSuccess: () => {
      invalidate(); setError(null); setLabel(""); setAsOf("")
      if (fileRef.current) fileRef.current.value = ""
    },
    onError,
  })
  const remove = useMutation({
    mutationFn: allocationApi.deleteSpaceMap, onSuccess: invalidate, onError,
  })
  const open = useMutation({ mutationFn: allocationApi.openSpaceMap, onError })

  return (
    <div className="rounded-xl overflow-hidden"
      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>

      <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
        <div className="flex items-center gap-2">
          <Map size={14} strokeWidth={1.9} style={{ color: "var(--text-muted)" }} />
          <h3 className="text-[13px] font-semibold text-theme">Square-footage source documents</h3>
        </div>
        <p className="text-[11px] mt-1 leading-relaxed" style={{ color: "var(--text-muted)" }}>
          The floor plan, surveyor&rsquo;s schedule or lease exhibit the client supplied.
          The figures above are a transcription of this; on examination the question is
          what they were transcribed from.
        </p>
      </div>

      {/* Upload */}
      <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="text-[11px] font-medium" style={{ color: "var(--text-muted)" }}>
              What is it? <span className="font-normal">(optional)</span>
            </span>
            <Input value={label} onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Architect's floor plan, sheet A-101" />
          </label>
          <label className="block">
            <span className="text-[11px] font-medium" style={{ color: "var(--text-muted)" }}>
              As at <span className="font-normal">(optional)</span>
            </span>
            <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </label>
        </div>

        <input ref={fileRef} type="file" accept={ACCEPT} className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) { setError(null); upload.mutate(f) }
          }} />
        <div className="flex items-center gap-2.5 mt-3 flex-wrap">
          <Button onClick={() => fileRef.current?.click()} loading={upload.isPending}
            icon={<Upload size={14} strokeWidth={1.8} />}>
            {upload.isPending ? "Uploading…" : "Upload document"}
          </Button>
          <span className="text-[10.5px]" style={{ color: "var(--text-muted)" }}>
            PDF, image, spreadsheet, DWG or Word · up to 25 MB
          </span>
        </div>

        {error && (
          <p className="ndvx-expand text-xs mt-2 flex items-start gap-1.5" style={{ color: "var(--danger)" }}>
            <AlertTriangle size={12} strokeWidth={2} className="mt-[3px] shrink-0" />
            {error}
          </p>
        )}
      </div>

      {/* On file */}
      {isLoading ? (
        <div className="flex justify-center py-6"><Spinner className="h-4 w-4" /></div>
      ) : maps.length === 0 ? (
        <div className="px-4 py-6 text-center">
          <p className="text-[12.5px] font-medium text-theme">Nothing on file</p>
          <p className="text-[11px] mt-1 max-w-md mx-auto leading-relaxed"
            style={{ color: "var(--text-muted)" }}>
            The allocation still runs without it — but the square footage behind every
            occupancy-driven pool would rest on nothing an examiner can look at.
          </p>
        </div>
      ) : (
        maps.map((m: SpaceMap, i) => {
          const Icon = iconFor(m.file_name)
          return (
            <div key={m.id}
              className="flex items-center gap-3 px-4 py-2.5"
              style={{ borderTop: i === 0 ? undefined : "1px solid var(--border)" }}>
              <Icon size={15} strokeWidth={1.8} className="shrink-0"
                style={{ color: "var(--text-muted)" }} />
              <button onClick={() => open.mutate(m.id)}
                className="min-w-0 flex-1 text-left hover:opacity-75 transition-opacity">
                <div className="text-[13px] text-theme truncate">
                  {m.label || m.file_name}
                </div>
                <div className="text-[10.5px] truncate" style={{ color: "var(--text-muted)" }}>
                  {m.label ? `${m.file_name} · ` : ""}{sizeLabel(m.file_size)}
                  {m.as_of && ` · as at ${m.as_of}`}
                  {m.uploaded_at && ` · added ${m.uploaded_at.slice(0, 10)}`}
                </div>
              </button>
              <button onClick={() => remove.mutate(m.id)} aria-label={`Remove ${m.file_name}`}
                className="p-1 rounded-md shrink-0" style={{ color: "var(--text-muted)" }}>
                <Trash2 size={14} strokeWidth={1.8} />
              </button>
            </div>
          )
        })
      )}
    </div>
  )
}
