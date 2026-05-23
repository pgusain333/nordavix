/**
 * UploadFlow — multi-step wizard for creating a flux analysis.
 *
 * Steps:
 *   1. Choose source: Excel/CSV upload  OR  QuickBooks
 *   2a. (Upload) TB metadata form (name, periods, threshold)
 *   2b. (QBO) Connect + date range form
 *   3. (Upload) File drop zone → parse preview
 *   4. Column mapping confirmation
 *   5. Processing / AI generating
 */
import { useState, useCallback, useRef } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  Upload,
  FileSpreadsheet,
  Zap,
  CheckCircle2,
  X,
  AlertTriangle,
  ArrowRight,
  ArrowLeft,
} from "lucide-react"
import { api, type ColumnMapping, type UploadPreview, type TrialBalance } from "@/modules/flux/api"
import { Button, Input, Select, Spinner } from "@/core/ui/components"
import { cn } from "@/core/ui/utils"

type Source = "upload" | "qbo"

interface Props {
  onComplete: (tb: TrialBalance) => void
  qboConnected?: boolean
}

// ── Step indicators ───────────────────────────────────────────────────────────

const UPLOAD_STEPS = ["Source", "Details", "Upload", "Map Columns", "Running"]

function StepBar({ step, steps }: { step: number; steps: string[] }) {
  return (
    <div className="flex items-center gap-0 mb-8">
      {steps.map((label, i) => (
        <div key={label} className="flex items-center">
          <div className="flex flex-col items-center gap-1.5">
            <div
              className={cn(
                "h-7 w-7 rounded-full flex items-center justify-center text-xs font-semibold transition-colors",
                i < step  ? "bg-green text-white" :
                i === step ? "bg-ink text-white" :
                             "bg-ink-100 text-ink-400"
              )}
            >
              {i < step ? <CheckCircle2 size={14} strokeWidth={2} /> : i + 1}
            </div>
            <span className={cn(
              "text-[10px] font-medium whitespace-nowrap hidden sm:block",
              i === step ? "text-ink" : "text-ink-400"
            )}>
              {label}
            </span>
          </div>
          {i < steps.length - 1 && (
            <div className={cn(
              "w-8 sm:w-14 h-px mx-1 mt-[-10px]",
              i < step ? "bg-green" : "bg-ink-100"
            )} />
          )}
        </div>
      ))}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function UploadFlow({ onComplete, qboConnected = false }: Props) {
  const qc = useQueryClient()
  const [step, setStep]     = useState(0)
  const [source, setSource] = useState<Source>("upload")

  // TB metadata
  const [tbName,    setTbName]    = useState("")
  const [curPeriod, setCurPeriod] = useState("")
  const [priorPeriod,setPriorPeriod] = useState("")
  const [threshold, setThreshold] = useState("5000")

  // Upload state
  const [file,      setFile]     = useState<File | null>(null)
  const [preview,   setPreview]  = useState<UploadPreview | null>(null)
  const [createdTb, setCreatedTb] = useState<TrialBalance | null>(null)
  const [mapping,   setMapping]  = useState<Partial<ColumnMapping>>({})
  const [dragOver,  setDragOver] = useState(false)
  const [error,     setError]    = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // ── Mutations ────────────────────────────────────────────────────────────────

  const createTb = useMutation({
    mutationFn: () => api.createTrialBalance({
      name:                 tbName.trim(),
      period_current:       curPeriod,
      period_prior:         priorPeriod,
      materiality_threshold:parseFloat(threshold) || 5000,
    }),
    onSuccess: (tb) => {
      setCreatedTb(tb)
      setStep(2)
      setError(null)
    },
    onError: () => setError("Failed to create trial balance. Please try again."),
  })

  const uploadFile = useMutation({
    mutationFn: () => api.uploadFile(createdTb!.id, file!),
    onSuccess: (prev) => {
      setPreview(prev)
      setMapping(prev.detected_mapping)
      setStep(3)
      setError(null)
    },
    onError: () => setError("Failed to parse file. Please check it's a valid Excel or CSV."),
  })

  const parseColumns = useMutation({
    mutationFn: () => api.parseColumns(createdTb!.id, mapping as ColumnMapping),
    onSuccess: async () => {
      // Enqueue AI via run endpoint
      try { await api.runFlux(createdTb!.id) } catch { /* ok if already queued */ }
      setStep(4)
      setError(null)
      qc.invalidateQueries({ queryKey: ["trial-balances"] })
      // Poll for completion
      startPolling()
    },
    onError: () => setError("Failed to process columns. Please check your mapping."),
  })

  // ── Polling ──────────────────────────────────────────────────────────────────

  function startPolling() {
    const interval = setInterval(async () => {
      if (!createdTb) return
      try {
        const tb = await api.getTrialBalance(createdTb.id)
        if (["complete", "ready_for_review", "parsed", "error"].includes(tb.status)) {
          clearInterval(interval)
          qc.invalidateQueries({ queryKey: ["trial-balances"] })
          onComplete(tb)
        }
      } catch { clearInterval(interval) }
    }, 3000)
  }

  // ── Drag & drop ──────────────────────────────────────────────────────────────

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files[0]
    if (f) validateAndSetFile(f)
  }, [])

  function validateAndSetFile(f: File) {
    const ext = f.name.split(".").pop()?.toLowerCase()
    if (!["xlsx", "xls", "csv"].includes(ext ?? "")) {
      setError("Please upload an Excel (.xlsx, .xls) or CSV file.")
      return
    }
    setFile(f)
    setError(null)
  }

  // ── Mapping helpers ───────────────────────────────────────────────────────────

  const FIELDS: { key: keyof ColumnMapping; label: string; hint: string }[] = [
    { key: "account_number", label: "Account Number", hint: "e.g. account no, code" },
    { key: "account_name",   label: "Account Name",   hint: "e.g. description, name" },
    { key: "current_balance",label: "Current Balance",hint: "e.g. current period, this period" },
    { key: "prior_balance",  label: "Prior Balance",  hint: "e.g. prior period, previous" },
  ]

  const mappingComplete = FIELDS.every((f) => mapping[f.key])

  // ── Steps ─────────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col items-center justify-center min-h-full py-10 px-6">
      <div className="w-full max-w-xl">

        {step < 4 && (
          <StepBar step={step} steps={UPLOAD_STEPS} />
        )}

        {/* ── Step 0: Choose Source ── */}
        {step === 0 && (
          <div>
            <h2 className="text-base font-semibold text-ink mb-1">Choose your data source</h2>
            <p className="text-sm text-ink-400 mb-6">
              Upload an Excel or CSV trial balance, or pull directly from QuickBooks Online.
            </p>
            <div className="grid grid-cols-2 gap-4 mb-6">
              <SourceCard
                icon={<FileSpreadsheet size={28} strokeWidth={1.6} />}
                title="Excel / CSV"
                description="Upload a trial balance file with current and prior period columns."
                selected={source === "upload"}
                onClick={() => setSource("upload")}
              />
              <SourceCard
                icon={<Zap size={28} strokeWidth={1.6} />}
                title="QuickBooks"
                description="Connect QuickBooks Online and pull the trial balance automatically."
                selected={source === "qbo"}
                onClick={() => setSource("qbo")}
                badge={qboConnected ? "Connected" : "OAuth required"}
              />
            </div>
            <Button className="w-full" onClick={() => setStep(1)}>
              Continue
              <ArrowRight size={16} strokeWidth={1.6} />
            </Button>
          </div>
        )}

        {/* ── Step 1: TB Details ── */}
        {step === 1 && source === "upload" && (
          <div>
            <button
              onClick={() => setStep(0)}
              className="flex items-center gap-1.5 text-xs text-ink-400 hover:text-ink mb-5 transition-colors"
            >
              <ArrowLeft size={14} strokeWidth={1.6} />
              Back
            </button>
            <h2 className="text-base font-semibold text-ink mb-1">Trial balance details</h2>
            <p className="text-sm text-ink-400 mb-6">
              Name this run and set the analysis periods.
            </p>
            {error && <ErrorMsg msg={error} onClose={() => setError(null)} />}
            <div className="space-y-4">
              <Input
                id="tb-name"
                label="Analysis name"
                placeholder="e.g. May 2026 Flux Analysis"
                value={tbName}
                onChange={(e) => setTbName(e.target.value)}
              />
              <div className="grid grid-cols-2 gap-4">
                <Input
                  id="cur-period"
                  label="Current period end"
                  type="date"
                  value={curPeriod}
                  onChange={(e) => setCurPeriod(e.target.value)}
                />
                <Input
                  id="prior-period"
                  label="Prior period end"
                  type="date"
                  value={priorPeriod}
                  onChange={(e) => setPriorPeriod(e.target.value)}
                />
              </div>
              <Input
                id="threshold"
                label="Materiality threshold ($)"
                type="number"
                placeholder="5000"
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
              />
              <p className="text-xs text-ink-400">
                Variances above this dollar amount will be flagged as material and prioritized for AI commentary.
              </p>
            </div>
            <Button
              className="w-full mt-6"
              loading={createTb.isPending}
              disabled={!tbName.trim() || !curPeriod || !priorPeriod}
              onClick={() => createTb.mutate()}
            >
              Continue
              <ArrowRight size={16} strokeWidth={1.6} />
            </Button>
          </div>
        )}

        {/* QBO path — step 1 */}
        {step === 1 && source === "qbo" && (
          <div>
            <button
              onClick={() => setStep(0)}
              className="flex items-center gap-1.5 text-xs text-ink-400 hover:text-ink mb-5 transition-colors"
            >
              <ArrowLeft size={14} strokeWidth={1.6} />
              Back
            </button>
            <h2 className="text-base font-semibold text-ink mb-1">Connect QuickBooks Online</h2>
            <p className="text-sm text-ink-400 mb-6">
              Authorize Nordavix to read your QuickBooks trial balance reports.
            </p>
            {qboConnected ? (
              <div className="rounded-lg border border-green-100 bg-green-50 p-4 mb-6">
                <p className="text-sm text-green-600 font-medium flex items-center gap-2">
                  <CheckCircle2 size={16} strokeWidth={1.6} />
                  QuickBooks is connected
                </p>
              </div>
            ) : (
              <Button
                className="w-full"
                onClick={() => {
                  window.location.href = api.qboConnectUrl()
                }}
                icon={<Zap size={16} strokeWidth={1.6} />}
              >
                Connect QuickBooks Online
              </Button>
            )}
            {qboConnected && (
              <p className="text-xs text-ink-400 text-center mt-4">
                QuickBooks TB import coming in the next release.
              </p>
            )}
          </div>
        )}

        {/* ── Step 2: File Upload ── */}
        {step === 2 && (
          <div>
            <button
              onClick={() => setStep(1)}
              className="flex items-center gap-1.5 text-xs text-ink-400 hover:text-ink mb-5 transition-colors"
            >
              <ArrowLeft size={14} strokeWidth={1.6} />
              Back
            </button>
            <h2 className="text-base font-semibold text-ink mb-1">Upload trial balance file</h2>
            <p className="text-sm text-ink-400 mb-6">
              Excel (.xlsx, .xls) or CSV format. Your file must have account number,
              account name, current and prior period balance columns.
            </p>
            {error && <ErrorMsg msg={error} onClose={() => setError(null)} />}

            <div
              className={cn(
                "border-2 border-dashed rounded-xl p-10 text-center transition-colors cursor-pointer",
                dragOver   ? "border-green bg-green-50" :
                file       ? "border-green bg-green-50" :
                             "border-ink-200 hover:border-ink-400 bg-ink-50"
              )}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              onClick={() => fileInputRef.current?.click()}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) validateAndSetFile(f)
                }}
              />
              {file ? (
                <div className="flex flex-col items-center gap-2">
                  <FileSpreadsheet size={32} strokeWidth={1.6} className="text-green" />
                  <p className="text-sm font-medium text-ink">{file.name}</p>
                  <p className="text-xs text-ink-400">{(file.size / 1024).toFixed(0)} KB</p>
                  <button
                    className="text-xs text-ink-400 hover:text-unfav mt-1"
                    onClick={(e) => { e.stopPropagation(); setFile(null) }}
                  >
                    Remove
                  </button>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2">
                  <Upload size={32} strokeWidth={1.6} className="text-ink-400" />
                  <p className="text-sm font-medium text-ink">Drop your file here</p>
                  <p className="text-xs text-ink-400">or click to browse</p>
                  <p className="text-xs text-ink-200 mt-1">xlsx · xls · csv</p>
                </div>
              )}
            </div>

            <Button
              className="w-full mt-6"
              loading={uploadFile.isPending}
              disabled={!file}
              onClick={() => uploadFile.mutate()}
            >
              {uploadFile.isPending ? "Parsing…" : "Parse File"}
              <ArrowRight size={16} strokeWidth={1.6} />
            </Button>
          </div>
        )}

        {/* ── Step 3: Column Mapping ── */}
        {step === 3 && preview && (
          <div>
            <button
              onClick={() => setStep(2)}
              className="flex items-center gap-1.5 text-xs text-ink-400 hover:text-ink mb-5 transition-colors"
            >
              <ArrowLeft size={14} strokeWidth={1.6} />
              Back
            </button>
            <h2 className="text-base font-semibold text-ink mb-1">Map your columns</h2>
            <p className="text-sm text-ink-400 mb-6">
              We auto-detected column mappings based on your headers. Please confirm or adjust.
            </p>
            {error && <ErrorMsg msg={error} onClose={() => setError(null)} />}

            {/* Preview sample */}
            <div className="mb-6 rounded-lg border border-ink-100 overflow-x-auto">
              <table className="text-xs w-full">
                <thead>
                  <tr className="border-b border-ink-100 bg-ink-50">
                    {preview.headers.map((h) => (
                      <th key={h} className="text-left px-3 py-2 font-medium text-ink-600 whitespace-nowrap">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.sample_rows.slice(0, 3).map((row, i) => (
                    <tr key={i} className={i < 2 ? "border-b border-ink-100" : ""}>
                      {row.map((cell, j) => (
                        <td key={j} className="px-3 py-2 text-ink-600 tabular-nums whitespace-nowrap">
                          {cell ?? "—"}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mapping dropdowns */}
            <div className="space-y-3 mb-6">
              {FIELDS.map(({ key, label }) => (
                <Select
                  key={key}
                  id={`map-${key}`}
                  label={label}
                  value={mapping[key] ?? ""}
                  onChange={(e) =>
                    setMapping((m) => ({ ...m, [key]: e.target.value || undefined }))
                  }
                >
                  <option value="">— select column —</option>
                  {preview.headers.map((h) => (
                    <option key={h} value={h}>{h}</option>
                  ))}
                </Select>
              ))}
            </div>

            <Button
              className="w-full"
              loading={parseColumns.isPending}
              disabled={!mappingComplete}
              onClick={() => parseColumns.mutate()}
            >
              {parseColumns.isPending ? "Processing…" : "Run Flux Analysis"}
              <ArrowRight size={16} strokeWidth={1.6} />
            </Button>
          </div>
        )}

        {/* ── Step 4: Processing ── */}
        {step === 4 && (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <div className="relative h-16 w-16 mb-6">
              <div className="absolute inset-0 rounded-full bg-green-50 animate-ping opacity-30" />
              <div className="relative h-16 w-16 rounded-full bg-green-50 flex items-center justify-center">
                <Spinner className="text-green h-7 w-7" />
              </div>
            </div>
            <h2 className="text-base font-semibold text-ink mb-2">Generating AI commentary…</h2>
            <p className="text-sm text-ink-400 max-w-xs leading-relaxed">
              We're analyzing your trial balance and generating variance explanations.
              This typically takes 30–60 seconds.
            </p>
            <div className="mt-6 space-y-2 text-left w-full max-w-xs">
              {[
                "Classifying accounts by FS category",
                "Computing variance materiality",
                "Queuing AI narrative generation",
                "Awaiting commentary…",
              ].map((step, i) => (
                <div key={i} className="flex items-center gap-2.5 text-xs text-ink-400">
                  <div className={cn(
                    "h-1.5 w-1.5 rounded-full shrink-0",
                    i < 3 ? "bg-green" : "bg-ink-200 animate-pulse"
                  )} />
                  {step}
                </div>
              ))}
            </div>
          </div>
        )}

      </div>
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SourceCard({
  icon, title, description, selected, onClick, badge,
}: {
  icon: React.ReactNode
  title: string
  description: string
  selected: boolean
  onClick: () => void
  badge?: string
}) {
  return (
    <button
      className={cn(
        "relative flex flex-col items-start text-left p-5 rounded-xl border-2 transition-all",
        selected
          ? "border-green bg-green-50 shadow-card"
          : "border-ink-100 bg-white hover:border-ink-200 hover:bg-ink-50"
      )}
      onClick={onClick}
    >
      {badge && (
        <span className={cn(
          "absolute top-3 right-3 text-[10px] font-medium px-1.5 py-0.5 rounded-full",
          selected ? "bg-green text-white" : "bg-ink-100 text-ink-400"
        )}>
          {badge}
        </span>
      )}
      <div className={cn(
        "mb-3 transition-colors",
        selected ? "text-green" : "text-ink-400"
      )}>
        {icon}
      </div>
      <p className={cn(
        "text-sm font-semibold mb-1",
        selected ? "text-green-600" : "text-ink"
      )}>
        {title}
      </p>
      <p className="text-xs text-ink-400 leading-relaxed">{description}</p>
      {selected && (
        <CheckCircle2
          size={16}
          strokeWidth={1.6}
          className="absolute bottom-3 right-3 text-green"
        />
      )}
    </button>
  )
}

function ErrorMsg({ msg, onClose }: { msg: string; onClose: () => void }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-unfav-light bg-unfav-light p-3 mb-4">
      <AlertTriangle size={16} strokeWidth={1.6} className="text-unfav shrink-0 mt-0.5" />
      <p className="text-sm text-unfav flex-1">{msg}</p>
      <button onClick={onClose} className="text-unfav hover:opacity-70">
        <X size={14} />
      </button>
    </div>
  )
}
