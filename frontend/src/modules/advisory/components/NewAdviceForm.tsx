/**
 * Advice a human is giving.
 *
 * There was no way in. `source` declared a "manual" value nothing could reach,
 * so the module held what the AI wrote in a monthly report and nothing a
 * partner noticed in a meeting — which is backwards, because the best advice
 * in the building is in someone's head.
 *
 * The form asks for the hypothesis, not just the sentence: which metric this
 * moves, where it should get to, by when, and what it's worth. Only the title
 * is required — advice worth recording shouldn't be blocked by a field nobody
 * can fill honestly yet — but naming a metric is what makes it gradable, and
 * the form says so rather than silently accepting an untrackable row.
 */
import { useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Plus, X } from "lucide-react"

import { advisoryApi, type NewRec } from "../api"

const EMPTY: NewRec = {
  period_end: "", title: "", detail: "", kpi_key: null, priority: "medium",
  target_value: null, due_date: null, expected_impact: null, impact_note: "", owner: "",
}

const field = {
  background: "var(--surface-2)", border: "1px solid var(--border-strong)",
  color: "var(--text)",
} as const

export function NewAdviceForm({ periodEnd, onCreated }: {
  periodEnd: string
  onCreated: () => void
}) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<NewRec>(EMPTY)

  const { data: catalog = [] } = useQuery({
    queryKey: ["advisory", "catalog"],
    queryFn:  advisoryApi.getCatalog,
    staleTime: 30 * 60_000,
    enabled: open,
  })

  const create = useMutation({
    mutationFn: () => advisoryApi.createRecommendation({ ...form, period_end: periodEnd }),
    onSuccess: () => { setForm(EMPTY); setOpen(false); onCreated() },
  })

  const set = <K extends keyof NewRec>(k: K, v: NewRec[K]) =>
    setForm((f) => ({ ...f, [k]: v }))

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold"
        style={{ background: "var(--green)", color: "white" }}>
        <Plus size={13} strokeWidth={2.6} />
        Add advice
      </button>
    )
  }

  return (
    <div className="rounded-xl p-3.5 space-y-2.5"
      style={{ background: "var(--surface)", border: "1px solid var(--border)",
               boxShadow: "var(--card-shadow)" }}>
      <div className="flex items-center gap-2">
        <h3 className="text-[13px] font-semibold text-theme">New advice</h3>
        <div className="flex-1" />
        <button type="button" onClick={() => setOpen(false)} aria-label="Close"
          style={{ color: "var(--text-muted)" }}>
          <X size={14} strokeWidth={2.2} />
        </button>
      </div>

      <input autoFocus value={form.title} maxLength={300}
        onChange={(e) => set("title", e.target.value)}
        placeholder="What should the client do? Be specific and imperative."
        className="w-full rounded-lg px-2.5 py-1.5 text-[12.5px] outline-none" style={field} />

      <textarea value={form.detail ?? ""} rows={2}
        onChange={(e) => set("detail", e.target.value)}
        placeholder="The numbers behind it, and what doing it looks like"
        className="w-full rounded-lg px-2.5 py-1.5 text-[11.5px] outline-none resize-y" style={field} />

      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="block text-[10px] font-bold uppercase tracking-wider mb-1"
            style={{ color: "var(--text-muted)" }}>Metric it moves</span>
          <select value={form.kpi_key ?? ""}
            onChange={(e) => set("kpi_key", e.target.value || null)}
            className="w-full rounded-lg px-2 py-1.5 text-[11.5px] outline-none" style={field}>
            <option value="">Not tied to a metric</option>
            {catalog.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="block text-[10px] font-bold uppercase tracking-wider mb-1"
            style={{ color: "var(--text-muted)" }}>Priority</span>
          <select value={form.priority}
            onChange={(e) => set("priority", e.target.value as NewRec["priority"])}
            className="w-full rounded-lg px-2 py-1.5 text-[11.5px] outline-none" style={field}>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </label>
      </div>

      {/* Target and due date only matter once a metric is named — offering them
          otherwise invites a number that can never be checked against anything. */}
      {form.kpi_key && (
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="block text-[10px] font-bold uppercase tracking-wider mb-1"
              style={{ color: "var(--text-muted)" }}>Target value</span>
            <input type="number" step="any" value={form.target_value ?? ""}
              onChange={(e) => set("target_value", e.target.value === "" ? null : Number(e.target.value))}
              placeholder="optional"
              className="w-full rounded-lg px-2.5 py-1.5 text-[11.5px] outline-none" style={field} />
          </label>
          <label className="block">
            <span className="block text-[10px] font-bold uppercase tracking-wider mb-1"
              style={{ color: "var(--text-muted)" }}>By when</span>
            <input type="date" value={form.due_date ?? ""}
              onChange={(e) => set("due_date", e.target.value || null)}
              className="w-full rounded-lg px-2.5 py-1.5 text-[11.5px] outline-none" style={field} />
          </label>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="block text-[10px] font-bold uppercase tracking-wider mb-1"
            style={{ color: "var(--text-muted)" }}>Worth (approx.)</span>
          <input type="number" step="any" value={form.expected_impact ?? ""}
            onChange={(e) => set("expected_impact", e.target.value === "" ? null : Number(e.target.value))}
            placeholder="$ — optional"
            className="w-full rounded-lg px-2.5 py-1.5 text-[11.5px] outline-none" style={field} />
        </label>
        <label className="block">
          <span className="block text-[10px] font-bold uppercase tracking-wider mb-1"
            style={{ color: "var(--text-muted)" }}>Owner</span>
          <input value={form.owner ?? ""} maxLength={120}
            onChange={(e) => set("owner", e.target.value)}
            placeholder="Who's doing it"
            className="w-full rounded-lg px-2.5 py-1.5 text-[11.5px] outline-none" style={field} />
        </label>
      </div>

      {form.expected_impact != null && (
        <input value={form.impact_note ?? ""} maxLength={300}
          onChange={(e) => set("impact_note", e.target.value)}
          placeholder="What that figure is — a number with no stated basis is one a client is right to distrust"
          className="w-full rounded-lg px-2.5 py-1.5 text-[11px] outline-none" style={field} />
      )}

      {!form.kpi_key && form.title.trim() && (
        <p className="text-[10.5px]" style={{ color: "#8a6326" }}>
          Without a metric this can be tracked but never graded — it won't show whether it worked.
        </p>
      )}
      {create.isError && (
        <p className="text-[10.5px]" style={{ color: "#A0503F" }}>
          Couldn't save that. Check the title and try again.
        </p>
      )}

      <div className="flex items-center gap-2 pt-0.5">
        <button type="button" onClick={() => setOpen(false)}
          className="rounded-lg px-2.5 py-1.5 text-[11px] font-semibold"
          style={{ color: "var(--text-muted)" }}>Cancel</button>
        <div className="flex-1" />
        <button type="button" disabled={!form.title.trim() || create.isPending}
          onClick={() => create.mutate()}
          className="rounded-lg px-3 py-1.5 text-[11px] font-bold disabled:opacity-40"
          style={{ background: "var(--green)", color: "white" }}>
          {create.isPending ? "Saving…" : "Add advice"}
        </button>
      </div>
    </div>
  )
}
