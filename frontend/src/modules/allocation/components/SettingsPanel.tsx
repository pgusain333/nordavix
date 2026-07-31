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
import { AlertTriangle, CheckCircle2, Save } from "lucide-react"
import { Button, Select, Spinner } from "@/core/ui"
import { allocationApi } from "../api"

export function SettingsPanel() {
  const [method, setMethod] = useState<"books_records" | "afs" | "">("")
  const [hasAfs, setHasAfs] = useState<boolean | null>(null)
  const [invId, setInvId] = useState<string>("")
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const qc = useQueryClient()

  const { data: cfg, isLoading } = useQuery({
    queryKey: ["allocation", "settings"],
    queryFn:  allocationApi.getSettings,
  })

  // QBO may be disconnected; the picker degrades to a message rather than
  // blocking the rest of the form.
  const { data: accounts, isError: accountsError } = useQuery({
    queryKey: ["allocation", "inventory-accounts"],
    queryFn:  allocationApi.listInventoryAccounts,
    retry: false,
  })

  const effMethod = method || cfg?.method || "books_records"
  const effHasAfs = hasAfs ?? cfg?.has_afs ?? false
  const effInvId  = invId || cfg?.inventory_account_id || ""

  const save = useMutation({
    mutationFn: () => {
      const picked = accounts?.find((a) => a.qbo_account_id === effInvId)
      return allocationApi.updateSettings({
        method: effMethod as "books_records" | "afs",
        has_afs: effHasAfs,
        inventory_account_id: effInvId || null,
        inventory_account_name: picked?.account_name ?? cfg?.inventory_account_name ?? null,
      })
    },
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

        {conflict && (
          <div className="flex items-start gap-2 rounded-lg px-3 py-2.5"
            style={{ background: "var(--warn-subtle)" }}>
            <AlertTriangle size={14} strokeWidth={2} style={{ color: "var(--warn)" }} className="mt-0.5 shrink-0" />
            <p className="text-[11.5px]" style={{ color: "var(--text)" }}>
              A client with an applicable financial statement must conform to it — the
              books-and-records prong doesn&rsquo;t apply. Runs will be blocked until this
              is resolved.
            </p>
          </div>
        )}

        <div className="pt-1" style={{ borderTop: "1px solid var(--border)" }}>
          <h3 className="text-sm font-semibold text-theme mt-3">Inventory account</h3>
          <p className="text-[11px] mt-0.5 mb-2" style={{ color: "var(--text-muted)" }}>
            The account the reclass entry debits. Without it the allocation still runs
            and the workpaper is still produced — only the journal entry is withheld.
          </p>
          {accountsError ? (
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              Couldn&rsquo;t read the chart of accounts from QuickBooks.
              {cfg?.inventory_account_name && ` Currently set to ${cfg.inventory_account_name}.`}
            </p>
          ) : (
            <Select value={effInvId} onChange={(e) => setInvId(e.target.value)}>
              <option value="">Not set — journal entry withheld</option>
              {(accounts ?? []).map((a) => (
                <option key={a.qbo_account_id} value={a.qbo_account_id}>
                  {a.account_number ? `${a.account_number} · ` : ""}{a.account_name}
                </option>
              ))}
            </Select>
          )}
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
