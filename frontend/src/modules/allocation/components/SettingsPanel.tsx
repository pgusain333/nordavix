/**
 * SettingsPanel — the method election and the inventory account.
 *
 * Two things live here and they carry different weight. The inventory account
 * is plumbing: without it the run still computes and the workpaper is still
 * produced, but the journal entry is withheld rather than guessed at. The
 * method election is the tax position, so the server requires `reviewer` to
 * change it and a non-reviewer gets a clear message rather than a silent
 * failure.
 *
 * The account is PICKED from the client's real chart, never typed — a typo in
 * an account id produces an entry that posts to the wrong place.
 */
import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertTriangle, CheckCircle2, FileText, Save } from "lucide-react"
import { Button, Select, Spinner } from "@/core/ui"
import { allocationApi, type AllocationFrequency } from "../api"

export function SettingsPanel() {
  const [method, setMethod] = useState<"books_records" | "afs" | "">("")
  const [hasAfs, setHasAfs] = useState<boolean | null>(null)
  const [frequency, setFrequency] = useState<AllocationFrequency | "">("")
  const [saved, setSaved] = useState(false)
  const [memoBusy, setMemoBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const qc = useQueryClient()

  const { data: cfg, isLoading } = useQuery({
    queryKey: ["allocation", "settings"],
    queryFn:  allocationApi.getSettings,
  })

  const effMethod = method || cfg?.method || "books_records"
  const effHasAfs = hasAfs ?? cfg?.has_afs ?? false
  const effFreq = frequency || cfg?.allocation_frequency || "monthly"

  const save = useMutation({
    mutationFn: () => allocationApi.updateSettings({
      method: effMethod as "books_records" | "afs",
      has_afs: effHasAfs,
      allocation_frequency: effFreq,
    }),
    onSuccess: () => {
      setSaved(true); setError(null)
      qc.invalidateQueries({ queryKey: ["allocation", "settings"] })
      qc.invalidateQueries({ queryKey: ["allocation", "readiness"] })
      setTimeout(() => setSaved(false), 2500)
    },
    onError: (e: unknown) => {
      const ex = e as { response?: { data?: { detail?: string }; status?: number }; message?: string }
      setError(
        ex.response?.status === 403
          ? "Changing the method election needs a reviewer — it's the tax position, not bookkeeping."
          : ex.response?.data?.detail ?? ex.message ?? "Couldn't save.",
      )
    },
  })

  if (isLoading) return <div className="flex justify-center py-10"><Spinner className="h-5 w-5" /></div>

  const conflict = effHasAfs && effMethod === "books_records"

  return (
    <div className="space-y-3">
      <div className="rounded-xl p-4 space-y-4"
        style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>

        <div>
          <h3 className="text-sm font-semibold text-theme">Method election</h3>
          <p className="text-[11px] mt-0.5" style={{ color: "var(--text-muted)" }}>
            Which prong of §471(c)(1)(B) this client relies on
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="text-[11px] font-medium" style={{ color: "var(--text-muted)" }}>Method</span>
            <Select value={effMethod} onChange={(e) => setMethod(e.target.value as "books_records" | "afs")}>
              <option value="books_records">Books and records — §471(c)(1)(B)(ii)</option>
              <option value="afs">Conform to the AFS — §471(c)(1)(B)(i)</option>
            </Select>
          </label>
          <label className="block">
            <span className="text-[11px] font-medium" style={{ color: "var(--text-muted)" }}>
              Applicable financial statement
            </span>
            <Select value={effHasAfs ? "yes" : "no"} onChange={(e) => setHasAfs(e.target.value === "yes")}>
              <option value="no">No AFS</option>
              <option value="yes">Client has an AFS</option>
            </Select>
          </label>
        </div>

        {/* Not cosmetic: this decides the window every run covers, and how many
            periods a complete year is expected to contain. */}
        <div className="pt-3" style={{ borderTop: "1px solid var(--border)" }}>
          <h3 className="text-sm font-semibold text-theme">How often the allocation is performed</h3>
          <p className="text-[11px] mt-0.5 mb-2 leading-relaxed" style={{ color: "var(--text-muted)" }}>
            Most clients allocate monthly, alongside the close. A smaller book is often
            done once, after year end, straight onto the return. Both are legitimate —
            but the choice changes the arithmetic, not just the wording: an annual run
            covers the whole fiscal year, so its expense and payroll windows are the
            year, and a complete year is one period rather than twelve.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="text-[11px] font-medium" style={{ color: "var(--text-muted)" }}>
                Frequency
              </span>
              <Select value={effFreq}
                onChange={(e) => setFrequency(e.target.value as AllocationFrequency)}>
                <option value="monthly">Monthly — with the close</option>
                <option value="annual">Annually — once, after year end</option>
              </Select>
            </label>
          </div>
          {effFreq === "annual" && (
            <p className="ndvx-expand text-[11px] mt-2 leading-relaxed" style={{ color: "var(--text-2)" }}>
              Runs, readiness and the year-end roll-up will all work on the fiscal year.
              The payroll register still needs to cover the whole year for the payroll
              factor to be right.
            </p>
          )}
        </div>

        {conflict && (
          <div className="ndvx-expand flex items-start gap-2 rounded-lg px-3 py-2.5"
            style={{ background: "var(--warn-subtle)" }}>
            <AlertTriangle size={14} strokeWidth={2} style={{ color: "var(--warn)" }} className="mt-0.5 shrink-0" />
            <p className="text-[11.5px]" style={{ color: "var(--text)" }}>
              A client with an applicable financial statement must conform to it — the
              books-and-records prong doesn&rsquo;t apply. Runs will be blocked until this
              is resolved.
            </p>
          </div>
        )}

        <div className="pt-3" style={{ borderTop: "1px solid var(--border)" }}>
          <p className="text-[11px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
            No inventory account to choose: the monthly entry debits a mirror
            &ldquo;Other COGS &ndash; &lt;account&gt;&rdquo; account for each expense it reclasses,
            and credits the original account. Keeping the source account&rsquo;s name in the
            COGS account is what makes the reclass self-documenting on the face of the
            trial balance.
          </p>
        </div>

        {/* The document the statute actually references. Generated from live
            configuration so the policy and the computation can't drift apart. */}
        <div className="pt-3" style={{ borderTop: "1px solid var(--border)" }}>
          <h3 className="text-sm font-semibold text-theme">Written accounting procedures</h3>
          <p className="text-[11px] mt-0.5 mb-2 leading-relaxed" style={{ color: "var(--text-muted)" }}>
            §471(c)(1)(B)(ii) conditions the method on the taxpayer&rsquo;s own accounting
            procedures, so the policy has to exist as a signed document — not just as
            configuration. This one is generated from the pools, spaces and
            classifications actually in force, so it can&rsquo;t drift from what the
            engine does.
          </p>
          <Button variant="outline" loading={memoBusy}
            onClick={async () => {
              setMemoBusy(true)
              try { await allocationApi.downloadProceduresMemo() }
              catch { setError("Couldn't generate the memo.") }
              finally { setMemoBusy(false) }
            }}
            icon={<FileText size={14} strokeWidth={1.8} />}>
            Download procedures memo
          </Button>
        </div>

        {error && <p className="text-xs" style={{ color: "var(--danger)" }}>{error}</p>}

        <div className="flex items-center gap-2.5">
          <Button onClick={() => save.mutate()} loading={save.isPending}
            icon={<Save size={14} strokeWidth={1.8} />}>
            Save settings
          </Button>
          {saved && (
            <span className="inline-flex items-center gap-1 text-xs" style={{ color: "var(--positive)" }}>
              <CheckCircle2 size={13} strokeWidth={2.2} /> Saved
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
