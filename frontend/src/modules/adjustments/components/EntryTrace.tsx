/**
 * Everything behind one adjusting entry, in five answers.
 *
 *   Origin     what produced this, and from what
 *   Basis      the lines it is made of, against real accounts
 *   Decisions  who did what, when, and why
 *   Support    what justifies it
 *   Effect     what changed because of it
 *
 * The same five questions every close object should be able to answer. This
 * renders facts that already exist — the audit log, the row's own stamps, the
 * graph, the period's chart of accounts — rather than a second copy of them,
 * so what it shows cannot drift from what happened.
 *
 * Two things it refuses to smooth over, because a provenance panel that
 * flatters is worse than none: an effect it could not fully classify says so
 * instead of printing a confident total, and a draft's arithmetic is labelled
 * as what it WOULD do rather than what it did.
 */
import { useQuery } from "@tanstack/react-query"
import {
  ArrowRight, Brain, CheckCircle2, FileWarning, Link2, Sparkles, User as UserIcon,
} from "lucide-react"

import { adjustmentsApi, type EntryTrace as Trace } from "../api"

const money = (s: string) => {
  const n = parseFloat(s) || 0
  const sign = n < 0 ? "−" : n > 0 ? "+" : ""
  return `${sign}$${Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`
}

const SOURCE_WORD: Record<string, string> = {
  bank:        "the bank reconciliation",
  recon:       "a reconciliation review",
  flux:        "flux variance analysis",
  gl_accuracy: "the misclassification watchdog",
  assistant:   "a conversation with the AI",
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="px-3.5 py-2.5" style={{ borderTop: "1px solid var(--border)" }}>
      <p className="text-[9.5px] font-bold uppercase tracking-wider mb-1.5"
        style={{ color: "var(--text-muted)" }}>
        {title}
      </p>
      {children}
    </div>
  )
}

export function EntryTrace({ entryId }: { entryId: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["adjustments", "trace", entryId],
    queryFn:  () => adjustmentsApi.trace(entryId),
    staleTime: 60_000,
  })

  if (isLoading) {
    return (
      <p className="px-3.5 py-3 text-[11px]" style={{ color: "var(--text-muted)" }}>
        Tracing…
      </p>
    )
  }
  if (isError || !data) {
    return (
      <p className="px-3.5 py-3 text-[11px]" style={{ color: "var(--text-muted)" }}>
        Couldn't load the trail for this entry.
      </p>
    )
  }

  const t: Trace = data
  const eff = t.effect
  const moved = [
    ["Net income", eff.net_income],
    ["Assets", eff.assets],
    ["Liabilities & equity", eff.liabilities_equity],
  ].filter(([, v]) => (parseFloat(v as string) || 0) !== 0)

  return (
    <div className="rounded-xl overflow-hidden"
      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>

      {/* ── Origin ── */}
      <Section title="Where it came from">
        <p className="text-[12px] text-theme">
          Drafted by {t.origin.drafted_by} from {SOURCE_WORD[t.origin.source] ?? t.origin.source}
          {t.origin.subject && (
            t.origin.subject.resolved
              ? <> — <span className="font-medium">{t.origin.subject.label}</span></>
              /* The subject exists in the graph but no longer resolves to a
                 live object. Naming it anyway would imply a link that goes
                 nowhere. */
              : <> — <span style={{ color: "var(--text-muted)" }}>{t.origin.subject.label}</span></>
          )}
        </p>
        {t.origin.rationale && (
          <p className="text-[11px] mt-1 leading-snug" style={{ color: "var(--text-muted)" }}>
            {t.origin.rationale}
          </p>
        )}
      </Section>

      {/* ── Basis ── */}
      <Section title="What it's made of">
        <div className="space-y-0.5">
          {t.basis.lines.map((ln, i) => {
            const isCredit = (parseFloat(ln.credit) || 0) > 0
            const amt = isCredit ? ln.credit : ln.debit
            return (
              <div key={i} className="flex items-baseline gap-2 text-[11.5px]">
                <span className="min-w-0 flex-1 truncate" style={{ paddingLeft: isCredit ? 14 : 0 }}>
                  {ln.account_name}
                  {ln.account_type && (
                    <span className="text-[10px] ml-1.5" style={{ color: "var(--text-muted)" }}>
                      {ln.account_type}
                    </span>
                  )}
                  {/* An account the period's chart doesn't contain can't be
                      classified — and the CSV export matches QBO by NAME, so
                      this is also where an import would fail. */}
                  {!ln.known_account && (
                    <span className="text-[10px] ml-1.5" style={{ color: "#8a6326" }}>
                      not in this period's chart
                    </span>
                  )}
                </span>
                <span className="tabular-nums shrink-0 text-[11px]" style={{ color: "var(--text-2)" }}>
                  {isCredit ? "Cr" : "Dr"} {parseFloat(amt).toLocaleString(undefined, {
                    minimumFractionDigits: 2, maximumFractionDigits: 2,
                  })}
                </span>
              </div>
            )
          })}
        </div>
      </Section>

      {/* ── Decisions ── */}
      <Section title="Who decided what">
        {t.decisions.length === 0 ? (
          <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
            Nobody has acted on this yet.
          </p>
        ) : (
          <div className="space-y-1.5">
            {t.decisions.map((d, i) => (
              <div key={i} className="flex items-baseline gap-2">
                <UserIcon size={11} strokeWidth={2} className="shrink-0 mt-0.5"
                  style={{ color: "var(--text-muted)" }} />
                <span className="min-w-0 flex-1">
                  <span className="text-[11.5px] text-theme">
                    <span className="font-medium">{d.label}</span> by {d.by}
                  </span>
                  {d.at && (
                    <span className="text-[10px] ml-1.5" style={{ color: "var(--text-muted)" }}>
                      {new Date(d.at).toLocaleDateString(undefined, {
                        day: "numeric", month: "short", year: "numeric",
                      })}
                    </span>
                  )}
                  {d.reason && (
                    <span className="block text-[10.5px] leading-snug" style={{ color: "var(--text-2)" }}>
                      “{d.reason}”
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
        {(t.prepared_by || t.approved_by) && (
          <p className="text-[10px] mt-2 pt-2 flex items-center gap-1.5 flex-wrap"
            style={{ color: "var(--text-muted)", borderTop: "1px solid var(--border)" }}>
            {t.prepared_by && <>Prepared by <b>{t.prepared_by}</b></>}
            {t.prepared_by && t.approved_by && <ArrowRight size={10} strokeWidth={2} />}
            {t.approved_by && <>Approved by <b>{t.approved_by}</b></>}
          </p>
        )}
      </Section>

      {/* ── Support ── */}
      {t.support.memory_fact && (
        <Section title="What justifies it">
          <p className="text-[11.5px] flex items-start gap-1.5">
            <Brain size={12} strokeWidth={2} className="shrink-0 mt-0.5" style={{ color: "var(--green)" }} />
            <span>
              <span className="text-theme">{t.support.memory_fact.title}</span>
              <span className="block text-[10px]" style={{ color: "var(--text-muted)" }}>
                A convention Nordavix learned from this client
              </span>
            </span>
          </p>
        </Section>
      )}

      {/* ── Effect ── */}
      <Section title={eff.applied ? "What it changed" : "What it would change"}>
        {moved.length === 0 ? (
          <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
            No net movement in the statements.
          </p>
        ) : (
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {moved.map(([label, v]) => (
              <span key={label as string} className="text-[11.5px]">
                <span style={{ color: "var(--text-muted)" }}>{label}</span>{" "}
                <span className="font-semibold tabular-nums text-theme">{money(v as string)}</span>
              </span>
            ))}
          </div>
        )}

        {!eff.complete && (
          <p className="text-[10.5px] mt-1.5 flex items-start gap-1.5" style={{ color: "#8a6326" }}>
            <FileWarning size={11} strokeWidth={2} className="shrink-0 mt-0.5" />
            {eff.unclassified_lines} line{eff.unclassified_lines === 1 ? "" : "s"} couldn't be
            classified, so these figures are part of the picture, not all of it.
          </p>
        )}

        {eff.posted_qbo_doc ? (
          <p className="text-[11px] mt-2 flex items-center gap-1.5" style={{ color: "var(--green)" }}>
            <CheckCircle2 size={12} strokeWidth={2.2} />
            Found in QuickBooks as {eff.posted_qbo_doc}
            {eff.posted_confirmed_at && (
              <span style={{ color: "var(--text-muted)" }}>
                · confirmed {new Date(eff.posted_confirmed_at).toLocaleDateString(undefined, {
                  day: "numeric", month: "short",
                })}
              </span>
            )}
          </p>
        ) : eff.applied && (
          <p className="text-[10.5px] mt-2 flex items-center gap-1.5" style={{ color: "var(--text-muted)" }}>
            <Sparkles size={11} strokeWidth={2} />
            Not yet confirmed in QuickBooks — run the posting check once it's booked.
          </p>
        )}

        {eff.edges.length > 0 && (
          <p className="text-[10px] mt-2 flex items-center gap-1.5" style={{ color: "var(--text-muted)" }}>
            <Link2 size={10} strokeWidth={2} />
            Linked to {eff.edges.length} other {eff.edges.length === 1 ? "item" : "items"} in the close
          </p>
        )}
      </Section>
    </div>
  )
}
