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
import { Button, Input, Select, Spinner } from "@/core/ui"
import { allocationApi, type AllocationFrequency, type AllocSettings } from "../api"

export function SettingsPanel() {
  const [method, setMethod] = useState<"books_records" | "afs" | "">("")
  const [hasAfs, setHasAfs] = useState<boolean | null>(null)
  const [frequency, setFrequency] = useState<AllocationFrequency | "">("")
  // Form 1125-A line 9. Held as a patch over what's on file so an untouched
  // field is never resent — the server only applies what's present.
  const [line9, setLine9] = useState<Partial<AllocSettings>>({})
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
      ...line9,
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

  /** Edited value if touched, else what's on file, else the default. */
  function v<K extends keyof AllocSettings>(key: K, fallback: AllocSettings[K]) {
    return (line9[key] ?? cfg?.[key] ?? fallback) as AllocSettings[K]
  }

  // Mirrors _line9_exceptions in annual.py — shown while editing so a
  // contradiction is caught before it's saved, not discovered on the return.
  const line9Exceptions = (() => {
    const out: string[] = []
    if (v("sec263a_applies", false)) {
      out.push(
        "Line 9e says the §263A rules apply. §280E denies §263A to this taxpayer, "
        + "which is the reason §471(c) is being used — answering yes contradicts "
        + "the method this workpaper supports.",
      )
    }
    if (v("method_change_this_year", false) && !v("form_3115_filed", false)) {
      out.push(
        "Line 9f reports a change in method but no Form 3115 is recorded as filed. "
        + "Adopting §471(c) is a change in method of accounting; it needs Form 3115 "
        + "and a §481(a) adjustment.",
      )
    }
    if (v("lifo_adopted", false) && v("inv_valuation_method", "cost") === "lower_of_cost_or_market") {
      out.push("Line 9c reports LIFO while 9a reports lower of cost or market. "
        + "LIFO inventory cannot be valued at market.")
    }
    return out
  })()

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

        {/* Form 1125-A line 9 — the declarations half of the form. Lines 1-8 are
            arithmetic the engine produces; these are positions the client takes,
            and two of them can contradict the method on the face of the return. */}
        <div className="pt-3" style={{ borderTop: "1px solid var(--border)" }}>
          <h3 className="text-sm font-semibold text-theme">Form 1125-A — line 9</h3>
          <p className="text-[11px] mt-0.5 mb-2.5 leading-relaxed" style={{ color: "var(--text-muted)" }}>
            The declarations half of the form. Lines 1 to 8 come from the allocation;
            these are positions the client takes, so they&rsquo;re stated here once and
            carried onto the year-end page and both exports.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="text-[11px] font-medium" style={{ color: "var(--text-muted)" }}>
                9a · Valuing closing inventory
              </span>
              <Select value={v("inv_valuation_method", "cost") as string}
                onChange={(e) => setLine9({ ...line9, inv_valuation_method: e.target.value as AllocSettings["inv_valuation_method"] })}>
                <option value="cost">Cost</option>
                <option value="lower_of_cost_or_market">Lower of cost or market</option>
                <option value="other">Other</option>
              </Select>
            </label>
            <label className="block">
              <span className="text-[11px] font-medium" style={{ color: "var(--text-muted)" }}>
                9e · Do the §263A rules apply?
              </span>
              <Select value={v("sec263a_applies", false) ? "yes" : "no"}
                onChange={(e) => setLine9({ ...line9, sec263a_applies: e.target.value === "yes" })}>
                <option value="no">No — §280E denies §263A</option>
                <option value="yes">Yes</option>
              </Select>
            </label>
            <label className="block">
              <span className="text-[11px] font-medium" style={{ color: "var(--text-muted)" }}>
                9b · Writedown of subnormal goods
              </span>
              <Select value={v("inv_writedown_subnormal", false) ? "yes" : "no"}
                onChange={(e) => setLine9({ ...line9, inv_writedown_subnormal: e.target.value === "yes" })}>
                <option value="no">No</option>
                <option value="yes">Yes</option>
              </Select>
            </label>
            <label className="block">
              <span className="text-[11px] font-medium" style={{ color: "var(--text-muted)" }}>
                9c · LIFO adopted this year (Form 970)
              </span>
              <Select value={v("lifo_adopted", false) ? "yes" : "no"}
                onChange={(e) => setLine9({ ...line9, lifo_adopted: e.target.value === "yes" })}>
                <option value="no">No</option>
                <option value="yes">Yes</option>
              </Select>
            </label>
            <label className="block sm:col-span-2">
              <span className="text-[11px] font-medium" style={{ color: "var(--text-muted)" }}>
                9f · Change in determining quantities, cost or valuations?
              </span>
              <Select value={v("method_change_this_year", false) ? "yes" : "no"}
                onChange={(e) => setLine9({ ...line9, method_change_this_year: e.target.value === "yes" })}>
                <option value="no">No</option>
                <option value="yes">Yes — including the first year §471(c) is adopted</option>
              </Select>
            </label>

            {v("method_change_this_year", false) && (
              <>
                <label className="block sm:col-span-2 ndvx-expand">
                  <span className="text-[11px] font-medium" style={{ color: "var(--text-muted)" }}>
                    Explanation
                  </span>
                  <Input value={(v("method_change_note", "") as string) ?? ""}
                    placeholder="e.g. adopted §471(c) books-and-records inventory method effective 1 January"
                    onChange={(e) => setLine9({ ...line9, method_change_note: e.target.value || null })} />
                </label>
                <label className="block ndvx-expand">
                  <span className="text-[11px] font-medium" style={{ color: "var(--text-muted)" }}>
                    Form 3115 filed
                  </span>
                  <Select value={v("form_3115_filed", false) ? "yes" : "no"}
                    onChange={(e) => setLine9({ ...line9, form_3115_filed: e.target.value === "yes" })}>
                    <option value="no">Not yet</option>
                    <option value="yes">Filed</option>
                  </Select>
                </label>
                <label className="block ndvx-expand">
                  <span className="text-[11px] font-medium" style={{ color: "var(--text-muted)" }}>
                    §481(a) adjustment
                  </span>
                  <Input type="number" placeholder="Optional"
                    value={(v("sec481a_adjustment", "") as string) ?? ""}
                    onChange={(e) => setLine9({ ...line9, sec481a_adjustment: e.target.value || null })} />
                </label>
              </>
            )}
          </div>

          {line9Exceptions.map((x) => (
            <div key={x} className="ndvx-expand flex items-start gap-2 rounded-lg px-3 py-2.5 mt-2.5"
              style={{ background: "var(--warn-subtle)" }}>
              <AlertTriangle size={14} strokeWidth={2} className="mt-0.5 shrink-0"
                style={{ color: "var(--warn)" }} />
              <p className="text-[11.5px]" style={{ color: "var(--text)" }}>{x}</p>
            </div>
          ))}
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
