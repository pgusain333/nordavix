/**
 * PublicUploadPage — the client side of a PBC magic link (/r/:token).
 *
 * Design doctrine: the client is a business owner on their phone, not an
 * accountant in an app. One card, one job. No Clerk, no app shell, no
 * navigation — the page IS the task. Pine band for brand recognition
 * (matches the email they clicked), serif title for the editorial voice,
 * a big forgiving drop zone, and an explicit "all done" state so they
 * know they can close the tab.
 *
 * Auth: the token in the URL is the credential. Calls go straight to the
 * API with plain fetch — no Authorization header exists or is needed.
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { useParams } from "react-router-dom"

const API = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") ?? ""

const PINE  = "#0C2620"
const CREAM = "#F4F1E9"
const SAGE  = "#9CC4AD"
const INK   = "#14181A"
const SERIF = '"Fraunces", Georgia, serif'
const MONO  = '"JetBrains Mono", ui-monospace, monospace'

interface PublicRequest {
  company:      string
  title:        string
  note:         string | null
  period_label: string
  status:       "pending" | "fulfilled" | "cancelled" | "expired"
  expires_at:   string
  files:        { file_name: string; uploaded_at: string }[]
  max_files:    number
  allowed_exts: string[]
}

type PageState =
  | { kind: "loading" }
  | { kind: "invalid" }
  | { kind: "ready"; req: PublicRequest }

export function PublicUploadPage() {
  const { token = "" } = useParams()
  const [state, setState] = useState<PageState>({ kind: "loading" })
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    document.title = "Secure upload · Nordavix"
    fetch(`${API}/api/pbc-public/${encodeURIComponent(token)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error()
        setState({ kind: "ready", req: await r.json() })
      })
      .catch(() => setState({ kind: "invalid" }))
  }, [token])

  const upload = useCallback(async (files: FileList | File[]) => {
    setError(null)
    setUploading(true)
    try {
      for (const file of Array.from(files)) {
        const fd = new FormData()
        fd.append("file", file)
        const r = await fetch(`${API}/api/pbc-public/${encodeURIComponent(token)}/upload`, {
          method: "POST", body: fd,
        })
        const body = await r.json().catch(() => null)
        if (!r.ok) throw new Error(body?.detail ?? "Upload failed. Try again.")
        setState({ kind: "ready", req: body as PublicRequest })
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed. Try again.")
    } finally {
      setUploading(false)
    }
  }, [token])

  const req = state.kind === "ready" ? state.req : null
  const closed = req ? (req.status === "cancelled" || req.status === "expired") : false

  return (
    <div className="min-h-screen flex flex-col items-center px-4 py-8 sm:py-14"
      style={{ background: CREAM }}>
      <div className="w-full max-w-[480px] rounded-2xl overflow-hidden bg-white"
        style={{ border: "1px solid #E6E4DF", boxShadow: "0 18px 50px -20px rgba(12,38,32,0.25)" }}>

        {/* Pine brand band — visual continuity with the email */}
        <div className="px-7 py-4 flex items-center justify-between" style={{ background: PINE }}>
          <span className="font-bold text-[15px] tracking-tight" style={{ color: CREAM }}>
            nordavix<span style={{ color: SAGE }}>.</span>
          </span>
          <span className="text-[9.5px] uppercase" style={{ fontFamily: MONO, color: SAGE, letterSpacing: "0.16em" }}>
            Secure upload
          </span>
        </div>

        <div className="px-7 py-7">
          {state.kind === "loading" && (
            <div className="py-12 text-center">
              <div className="h-5 w-5 mx-auto rounded-full border-2 border-t-transparent animate-spin"
                style={{ borderColor: "#2E7A55", borderTopColor: "transparent" }} />
              <p className="text-xs mt-3" style={{ color: "#8A8F98" }}>Checking your link…</p>
            </div>
          )}

          {state.kind === "invalid" && (
            <div className="py-10 text-center">
              <h1 className="text-[22px]" style={{ fontFamily: SERIF, fontWeight: 550, color: INK }}>
                This link isn't valid
              </h1>
              <p className="text-sm mt-2 leading-relaxed" style={{ color: "#3C4146" }}>
                It may have been replaced by a newer one. Ask your accountant
                to send a fresh request — it takes them one click.
              </p>
            </div>
          )}

          {req && (
            <>
              <p className="text-[10px] uppercase" style={{ fontFamily: MONO, color: "#8A8F98", letterSpacing: "0.16em" }}>
                {req.company} · {req.period_label}
              </p>
              <h1 className="text-[24px] leading-snug mt-2" style={{ fontFamily: SERIF, fontWeight: 550, color: INK }}>
                {req.title}
              </h1>
              {req.note && (
                <p className="text-[13.5px] mt-3 leading-relaxed rounded-lg px-3.5 py-3"
                  style={{ color: "#3C4146", background: "#FAFAF8", border: "1px solid #E6E4DF" }}>
                  {req.note}
                </p>
              )}

              {/* Terminal states */}
              {req.status === "cancelled" && (
                <p className="text-sm mt-5 rounded-lg px-3.5 py-3"
                  style={{ color: "#86332e", background: "#f7eeec", border: "1px solid #ecd7d3" }}>
                  This request was cancelled — nothing more is needed from you.
                </p>
              )}
              {req.status === "expired" && (
                <p className="text-sm mt-5 rounded-lg px-3.5 py-3"
                  style={{ color: "#7a5622", background: "#f4eddf", border: "1px solid #e8dcc3" }}>
                  This link has expired. Ask {req.company} to resend the request.
                </p>
              )}

              {/* Drop zone */}
              {!closed && (
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => inputRef.current?.click()}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") inputRef.current?.click() }}
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files.length) void upload(e.dataTransfer.files) }}
                  className="mt-6 rounded-xl px-6 py-9 text-center cursor-pointer transition-colors select-none"
                  style={{
                    border: `1.5px dashed ${dragOver ? "#2E7A55" : "#C9C5BA"}`,
                    background: dragOver ? "#EAF4EE" : "#FCFBF7",
                  }}
                >
                  <input ref={inputRef} type="file" multiple className="hidden"
                    accept={req.allowed_exts.map((e) => `.${e}`).join(",")}
                    onChange={(e) => { if (e.target.files?.length) void upload(e.target.files); e.target.value = "" }} />
                  <p className="text-sm font-semibold" style={{ color: INK }}>
                    {uploading ? "Uploading…" : "Drop your file here, or tap to choose"}
                  </p>
                  <p className="text-[11px] mt-1.5" style={{ color: "#8A8F98" }}>
                    {req.allowed_exts.map((e) => e.toUpperCase()).join(" · ")} · up to 15 MB each
                  </p>
                </div>
              )}

              {error && (
                <p className="text-xs mt-3 font-medium" style={{ color: "#9b3d37" }}>{error}</p>
              )}

              {/* Uploaded so far */}
              {req.files.length > 0 && (
                <div className="mt-5">
                  <p className="text-[10px] uppercase mb-2" style={{ fontFamily: MONO, color: "#8A8F98", letterSpacing: "0.14em" }}>
                    Received {req.files.length === 1 ? "" : `· ${req.files.length} files`}
                  </p>
                  <ul className="space-y-1.5">
                    {req.files.map((f, i) => (
                      <li key={i} className="flex items-center gap-2 text-[13px] rounded-lg px-3 py-2"
                        style={{ background: "#EAF4EE", color: "#1d5038" }}>
                        <span aria-hidden className="font-bold" style={{ color: "#2E7A55" }}>✓</span>
                        <span className="truncate">{f.file_name}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="text-[13px] mt-3.5 leading-relaxed" style={{ color: "#3C4146" }}>
                    <strong>All set.</strong> {req.company} has your file{req.files.length === 1 ? "" : "s"} —
                    you can close this page, or add more above if needed.
                  </p>
                </div>
              )}
            </>
          )}
        </div>

        {/* Trust footer */}
        <div className="px-7 py-3.5" style={{ borderTop: "1px solid #E6E4DF" }}>
          <p className="text-[10.5px] leading-relaxed" style={{ color: "#8A8F98" }}>
            Files go directly to {req?.company ?? "your accountant"}'s secure Nordavix
            workspace — encrypted in transit and at rest. No account needed.
          </p>
        </div>
      </div>

      <p className="text-[10.5px] mt-5" style={{ fontFamily: MONO, color: "#8A8F98", letterSpacing: "0.08em" }}>
        POWERED BY NORDAVIX · NORDAVIX.COM
      </p>
    </div>
  )
}
