/**
 * "It already knew" — what this client's memory brings to the close.
 *
 * Client Memory learns a firm's conventions and applies them everywhere: a
 * confirmed pairing stops Risk Radar re-flagging a vendor, a recurring
 * expectation explains a movement before anyone investigates it, an offset
 * convention pre-fills an entry. All of it fires REACTIVELY, deep inside a
 * task, so the knowledge is real, it is working, and it is invisible at the one
 * moment it would land: opening the month.
 *
 * This is that moment, and the two numbers it carries are different in kind.
 * `carried` is what is stored. `reused_last_period` is what actually DID
 * something last close — the one that says the product compounds, which is why
 * it is measured at each point of effect rather than inferred from the pile.
 *
 * The review list is what stops the pile becoming a lie. A memory that only
 * accumulates eventually suppresses flags a firm now wants to see, and the
 * longer it sits the more confidently wrong it gets.
 */
import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AnimatePresence, motion, useReducedMotion } from "framer-motion"
import { Brain, ChevronDown, Check, X } from "lucide-react"

import { memoryApi, type CloseBrief } from "@/modules/memory/api"

export function CloseBriefCard({ periodEnd, priorPeriodEnd }: {
  periodEnd: string
  /** What "held last month" is measured against. */
  priorPeriodEnd?: string
}) {
  const qc = useQueryClient()
  const reduce = useReducedMotion()
  const [open, setOpen] = useState(false)

  const { data } = useQuery({
    queryKey: ["memory", "brief", periodEnd, priorPeriodEnd],
    queryFn: () => memoryApi.closeBrief(periodEnd, priorPeriodEnd),
    enabled: !!periodEnd,
    staleTime: 5 * 60_000,
  })

  const act = useMutation({
    mutationFn: ({ id, keep }: { id: string; keep: boolean }) =>
      keep ? memoryApi.confirmFact(id) : memoryApi.dismissFact(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["memory", "brief"] })
      qc.invalidateQueries({ queryKey: ["memory", "facts"] })
    },
  })

  // Nothing learned yet is not a card. A first close has no memory to bring,
  // and an empty "0 things I know" is a worse first impression than silence.
  if (!data || data.carried === 0) return null

  const review = data.needs_review
  const brief: CloseBrief = data

  return (
    <div className="rounded-xl overflow-hidden mb-4"
      style={{ background: "var(--surface)", border: "1px solid var(--border)",
               boxShadow: "var(--card-shadow)" }}>
      <button onClick={() => setOpen((v) => !v)}
        className="w-full flex items-start gap-3 px-4 py-3.5 text-left">
        <span className="h-9 w-9 rounded-xl flex items-center justify-center shrink-0"
          style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
          <Brain size={17} strokeWidth={1.9} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] font-semibold text-theme">
            {brief.carried} thing{brief.carried === 1 ? "" : "s"} Nordavix already knows
            about this client
          </span>
          <span className="block text-[11.5px] mt-0.5" style={{ color: "var(--text-muted)" }}>
            {/* Only claim the reuse figure when there was a prior close to
                measure it against. "0 held last month" on a client's second
                month reads as a failure rather than an absence. */}
            {brief.prior_period_end && brief.reused_last_period > 0 && (
              <>{brief.reused_last_period} were used in the last close · </>
            )}
            {review.length > 0
              ? `${review.length} to look at`
              : "nothing needs your attention"}
          </span>
        </span>
        <ChevronDown size={15} strokeWidth={2} className="shrink-0 mt-1"
          style={{ color: "var(--text-muted)",
                   transform: open ? "rotate(180deg)" : "none",
                   transition: reduce ? "none" : "transform .15s" }} />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1,
                       transition: reduce ? { duration: 0 } : {
                         height: { duration: 0.22, ease: [0.22, 1, 0.36, 1] },
                         opacity: { duration: 0.18, delay: 0.04 } } }}
            exit={reduce ? { opacity: 0 } : {
              height: 0, opacity: 0,
              transition: { height: { duration: 0.16, ease: "easeIn" },
                            opacity: { duration: 0.1 } } }}
            style={{ overflow: "hidden", borderTop: "1px solid var(--border)" }}>

            <div className="px-4 py-3 space-y-2">
              {brief.by_kind.map((k) => (
                <div key={k.kind} className="flex items-baseline gap-2.5">
                  <span className="text-[13px] font-semibold tabular-nums shrink-0"
                    style={{ color: "var(--green)", minWidth: 22 }}>{k.count}</span>
                  <span className="min-w-0">
                    <span className="text-[12.5px] text-theme">{k.label}</span>
                    {k.examples.length > 0 && (
                      <span className="block text-[11px] truncate" style={{ color: "var(--text-muted)" }}>
                        {k.examples.join(" · ")}
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </div>

            {review.length > 0 && (
              <div style={{ borderTop: "1px solid var(--border)" }}>
                <p className="px-4 pt-3 pb-1 text-[10px] font-bold uppercase tracking-wider"
                  style={{ color: "var(--text-muted)" }}>
                  Still true?
                </p>
                {review.map((r) => (
                  <div key={r.fact_id} className="px-4 py-2.5 flex items-start gap-3"
                    style={{ borderTop: "1px solid var(--border)" }}>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[12.5px] text-theme">{r.title}</span>
                      <span className="block text-[11px] mt-0.5" style={{ color: "#8a6326" }}>
                        {r.reason}
                      </span>
                    </span>
                    {/* Keep is the safe default and reads first. Retiring a
                        rule un-suppresses whatever it was hiding, which is a
                        real change to what the next scan reports. */}
                    <button onClick={() => act.mutate({ id: r.fact_id, keep: true })}
                      disabled={act.isPending}
                      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold shrink-0 disabled:opacity-50"
                      style={{ background: "var(--green-subtle)", color: "var(--green)" }}>
                      <Check size={11} strokeWidth={2.6} /> Still true
                    </button>
                    <button onClick={() => act.mutate({ id: r.fact_id, keep: false })}
                      disabled={act.isPending}
                      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold shrink-0 disabled:opacity-50"
                      style={{ border: "1px solid var(--border-strong)", color: "var(--text-2)" }}>
                      <X size={11} strokeWidth={2.6} /> Retire
                    </button>
                  </div>
                ))}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
