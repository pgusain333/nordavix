/**
 * DocumentViewer — an in-app lightbox for workpaper evidence.
 *
 * Renders attached documents in place (no download): PDFs and text/CSV in an
 * iframe, images as a zoomable <img>. Excel / Word can't be rendered by the
 * browser and are NOT sent to any third-party viewer (these are client
 * financials) — they get a clean "download to open" fallback.
 *
 * The signed URL is fetched per item with disposition=inline (see
 * workpapersApi.viewEvidence) and cached just under its 5-minute expiry.
 * Gallery navigation (←/→, on-screen chevrons), Esc to close, scrim click to
 * close, download + open-in-tab in the header. Rendered through a portal so the
 * fixed overlay is viewport-relative regardless of ancestor transforms.
 */
import { useCallback, useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { useQuery } from "@tanstack/react-query"
import { AnimatePresence, motion, useReducedMotion } from "framer-motion"
import {
  ChevronLeft, ChevronRight, Download, ExternalLink, X,
  FileText, FileSpreadsheet, FileImage, File as FileIcon, AlertCircle,
} from "lucide-react"
import { Spinner } from "@/core/ui/components"
import { MOTION, EASE } from "@/core/motion"
import { workpapersApi, type WpEvidence } from "@/modules/workpapers/api"

type Kind = "pdf" | "image" | "text" | "office" | "other"

function kindOf(name: string, mime?: string | null): Kind {
  const ext = (name.split(".").pop() || "").toLowerCase()
  if (ext === "pdf" || mime === "application/pdf") return "pdf"
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(ext) || (mime || "").startsWith("image/")) return "image"
  if (["txt", "csv"].includes(ext)) return "text"
  if (["xlsx", "xls", "docx", "doc", "pptx", "ppt"].includes(ext)) return "office"
  return "other"
}
const isPreviewable = (k: Kind) => k === "pdf" || k === "image" || k === "text"

function fmtSize(b?: number | null): string {
  if (!b) return ""
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}

function GlyphFor({ kind }: { kind: Kind }) {
  const common = { size: 18, strokeWidth: 1.8 as const }
  if (kind === "pdf")   return <FileText {...common} style={{ color: "var(--danger)" }} />
  if (kind === "image") return <FileImage {...common} style={{ color: "var(--info)" }} />
  if (kind === "office" || kind === "text") return <FileSpreadsheet {...common} style={{ color: "var(--green)" }} />
  return <FileIcon {...common} style={{ color: "var(--text-muted)" }} />
}

function IconButton({ title, onClick, disabled, children }: {
  title: string; onClick: () => void; disabled?: boolean; children: React.ReactNode
}) {
  return (
    <button type="button" title={title} aria-label={title} onClick={onClick} disabled={disabled}
      className="p-2 rounded-lg transition-colors disabled:opacity-40"
      style={{ color: "var(--text-2)" }}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.background = "var(--surface-2)" }}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
      {children}
    </button>
  )
}

export function DocumentViewer({ items, startId, onClose, onDownload }: {
  items: WpEvidence[]
  startId: string
  onClose: () => void
  onDownload: (id: string) => void
}) {
  const reduce = useReducedMotion()
  const [idx, setIdx] = useState(() => {
    const i = items.findIndex((it) => it.id === startId)
    return i < 0 ? 0 : i
  })
  const [zoom, setZoom] = useState(false)

  const item = items[idx]
  const kind = item ? kindOf(item.file_name, item.mime_type) : "other"
  const previewable = isPreviewable(kind)

  const { data, isLoading, isError } = useQuery({
    queryKey: ["workpapers", "view", item?.id],
    queryFn: () => workpapersApi.viewEvidence(item!.id),
    enabled: !!item && previewable,
    staleTime: 4 * 60_000,   // under the 5-minute signed-URL expiry
    retry: 1,
  })

  const go = useCallback((delta: number) => {
    setZoom(false)
    setIdx((i) => Math.max(0, Math.min(items.length - 1, i + delta)))
  }, [items.length])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose() }
      else if (e.key === "ArrowLeft") go(-1)
      else if (e.key === "ArrowRight") go(1)
    }
    window.addEventListener("keydown", onKey)
    // Lock background scroll while open.
    const prev = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      window.removeEventListener("keydown", onKey)
      document.body.style.overflow = prev
    }
  }, [onClose, go])

  if (!item) return null

  const meta = [item.mime_type, fmtSize(item.file_size), `${idx + 1} of ${items.length}`].filter(Boolean).join("  ·  ")

  const body = (() => {
    if (!previewable) {
      return (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
          <div className="h-16 w-16 rounded-2xl flex items-center justify-center" style={{ background: "var(--surface-2)" }}>
            <GlyphFor kind={kind} />
          </div>
          <div>
            <div className="text-[14px] font-semibold text-theme">{item.file_name}</div>
            <p className="text-[12px] mt-1 max-w-xs mx-auto" style={{ color: "var(--text-muted)" }}>
              {kind === "office"
                ? "Excel and Word files can’t be previewed in the browser. Download to open it in your spreadsheet or document app."
                : "This file type can’t be previewed. Download it to open."}
            </p>
          </div>
          <button type="button" onClick={() => onDownload(item.id)}
            className="inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-[13px] font-semibold text-white"
            style={{ background: "var(--green)" }}>
            <Download size={15} strokeWidth={1.9} /> Download
          </button>
        </div>
      )
    }
    if (isLoading) {
      return (
        <div className="absolute inset-0 flex items-center justify-center gap-2.5">
          <Spinner className="h-5 w-5" />
          <span className="text-[13px]" style={{ color: "var(--text-muted)" }}>Loading preview…</span>
        </div>
      )
    }
    if (isError || !data?.url) {
      return (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
          <AlertCircle size={28} strokeWidth={1.8} style={{ color: "var(--danger)" }} />
          <p className="text-[13px]" style={{ color: "var(--text-2)" }}>Couldn’t load this document.</p>
          <button type="button" onClick={() => onDownload(item.id)}
            className="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-[12px] font-semibold"
            style={{ border: "1px solid var(--border-strong)", color: "var(--text)" }}>
            <Download size={14} strokeWidth={1.9} /> Download instead
          </button>
        </div>
      )
    }
    if (kind === "image") {
      return (
        <div className="absolute inset-0 overflow-auto flex items-center justify-center p-4">
          <img src={data.url} alt={item.file_name} onClick={() => setZoom((z) => !z)}
            style={{
              cursor: zoom ? "zoom-out" : "zoom-in",
              maxWidth: zoom ? "none" : "100%", maxHeight: zoom ? "none" : "100%",
              objectFit: "contain", borderRadius: 6,
            }} />
        </div>
      )
    }
    // pdf + text (CSV/TXT served as text/plain so it renders, not downloads)
    return (
      <iframe src={data.url} title={item.file_name}
        className="absolute inset-0 w-full h-full" style={{ border: "none", background: "#fff" }} />
    )
  })()

  return createPortal(
    <AnimatePresence>
      <motion.div
        initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        transition={{ duration: MOTION.FAST }}
        onClick={onClose}
        role="dialog" aria-modal="true" aria-label={`Preview: ${item.file_name}`}
        className="fixed inset-0 flex items-center justify-center p-3 sm:p-6"
        style={{ zIndex: 1000, background: "rgba(8,12,16,0.66)", backdropFilter: "blur(2px)" }}>
        <motion.div
          initial={reduce ? false : { opacity: 0, scale: 0.985, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.985, y: 8 }}
          transition={{ duration: MOTION.DEFAULT, ease: EASE.OUT }}
          onClick={(e) => e.stopPropagation()}
          className="relative flex flex-col rounded-2xl overflow-hidden w-full"
          style={{
            maxWidth: 1040, height: "88vh",
            background: "var(--surface)", border: "1px solid var(--border-strong)",
            boxShadow: "0 24px 60px rgba(0,0,0,0.40)",
          }}>

          {/* Header */}
          <div className="flex items-center gap-3 px-4 py-3 border-b shrink-0" style={{ borderColor: "var(--border)" }}>
            <GlyphFor kind={kind} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-semibold text-theme">{item.file_name}</div>
              <div className="text-[11px] truncate" style={{ color: "var(--text-muted)" }}>{meta}</div>
            </div>
            <div className="flex items-center gap-0.5 shrink-0">
              {data?.url && (
                <IconButton title="Open in new tab" onClick={() => window.open(data.url, "_blank", "noopener,noreferrer")}>
                  <ExternalLink size={17} strokeWidth={1.9} />
                </IconButton>
              )}
              <IconButton title="Download" onClick={() => onDownload(item.id)}>
                <Download size={17} strokeWidth={1.9} />
              </IconButton>
              <IconButton title="Close (Esc)" onClick={onClose}>
                <X size={18} strokeWidth={2} />
              </IconButton>
            </div>
          </div>

          {/* Body */}
          <div className="relative flex-1 min-h-0" style={{ background: kind === "image" ? "var(--surface-2)" : "var(--surface)" }}>
            {body}

            {/* Gallery navigation */}
            {items.length > 1 && (
              <>
                <NavArrow side="left" disabled={idx === 0} onClick={() => go(-1)} />
                <NavArrow side="right" disabled={idx === items.length - 1} onClick={() => go(1)} />
              </>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  )
}

function NavArrow({ side, disabled, onClick }: { side: "left" | "right"; disabled: boolean; onClick: () => void }) {
  if (disabled) return null
  return (
    <button type="button" aria-label={side === "left" ? "Previous document" : "Next document"} onClick={onClick}
      className="absolute top-1/2 -translate-y-1/2 h-10 w-10 rounded-full flex items-center justify-center transition-transform hover:scale-105"
      style={{
        [side]: 12, background: "var(--surface)", border: "1px solid var(--border-strong)",
        boxShadow: "0 2px 10px rgba(0,0,0,0.18)", color: "var(--text)",
      } as React.CSSProperties}>
      {side === "left" ? <ChevronLeft size={20} strokeWidth={2} /> : <ChevronRight size={20} strokeWidth={2} />}
    </button>
  )
}

export default DocumentViewer
