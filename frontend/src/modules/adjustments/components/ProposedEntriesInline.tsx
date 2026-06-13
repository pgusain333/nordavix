/**
 * ProposedEntriesInline — renders the AI-proposed adjusting entries for ONE
 * origin (a reconciled account, a bank account, or a flux variance) right
 * where the difference + explanation already are. This is the no-navigation
 * core of the feature: see the variance → see the drafted fix → act, in place.
 *
 * Fetches the same ["adjustments"] cache the queue uses, filtered by
 * source + source_ref + period. Renders nothing when there are no proposals,
 * so it never clutters a clean account.
 */
import { useQuery } from "@tanstack/react-query"

import { workspaceApi } from "@/modules/workspace/api"
import {
  adjustmentsApi,
  type AdjustmentSource,
  type ProposedEntry,
} from "../api"
import { ProposedEntryCard } from "./ProposedEntryCard"

interface Props {
  source:     AdjustmentSource
  sourceRef:  string
  periodEnd:  string
  readOnly?:  boolean
  /** Hide dismissed/posted history; show only actionable (open/accepted). */
  activeOnly?: boolean
  /** Optional heading above the list (omit to render bare cards). */
  title?:     string
}

export function ProposedEntriesInline({
  source, sourceRef, periodEnd, readOnly, activeOnly = true, title,
}: Props) {
  const { data: me } = useQuery({
    queryKey: ["workspace-me"],
    queryFn:  workspaceApi.getMe,
    staleTime: 60_000,
  })
  const canReview = me?.role === "admin" || me?.role === "reviewer"
  // Any workspace member (incl. preparer) can build the JE — pick accounts;
  // it auto-saves for the reviewer. Approval is gated separately by canReview.
  const canEdit = !!me?.role

  const { data } = useQuery({
    queryKey: ["adjustments", source, sourceRef, periodEnd],
    queryFn:  () => adjustmentsApi.list({ source, sourceRef, periodEnd }),
    enabled:  !!sourceRef && !!periodEnd,
    staleTime: 30_000,
  })

  let items: ProposedEntry[] = data?.items ?? []
  if (activeOnly) items = items.filter((e) => e.status === "open" || e.status === "accepted")
  if (items.length === 0) return null

  return (
    <div className="space-y-2">
      {title && (
        <p className="text-[10px] font-bold uppercase tracking-wider" style={{ color: "#54588a" }}>
          {title}
        </p>
      )}
      {items.map((e) => (
        <ProposedEntryCard key={e.id} entry={e} canReview={canReview} canEdit={canEdit} readOnly={readOnly} />
      ))}
    </div>
  )
}
