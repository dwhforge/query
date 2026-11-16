/** LEFT Explorer — owns the actual source (LEFT) record presentation.
 *
 * ADR-0052: business records are primary. The LEFT Explorer always shows the
 * current source records (composite keys individually labelled, real business
 * values), an explicit empty state, search, sort, provenance filters,
 * previous/next unresolved navigation, the selected-row highlight and a compact
 * relationship status.
 *
 * When RIGHT-focused investigation is active the SAME column instead shows the
 * unified list of LEFT records associated with the selected RIGHT, with
 * multi-provenance badges and a provenance filter. The reverse-relationship list
 * never lives inside the RIGHT Explorer.
 */
import { useMemo, useState } from "react";
import {
  type MatchingCandidateView,
  type MatchingTabSession,
  type MatchingProposalView,
} from "../../app/matching/types";
import {
  buildRelationshipIndex,
  relatedSources,
  type RelationshipBadge,
} from "../../app/matching/relationships";
import { candidateById } from "../../app/matching/reviewLogic";
import { recordValue, RecordValues } from "./RecordValues";
import type { ExplainJoinKeyResult } from "../../lib/bridge";
import { mapKeyToken } from "../../app/matching/types";

type Props = {
  session: MatchingTabSession;
  baseline: import("../../app/matching/relationships").MappingProjection;
  plan: { mapKeyFields: string[]; outputs: string[]; targetRef?: string; sourceRef?: string };
  selected: MatchingProposalView | null;
  page: MatchingProposalView[];
  filteredCount: number;
  filter: MatchingTabSession["reviewFilter"];
  reviewSearch: string;
  onSetSearch: (v: string) => void;
  reviewSort: "workflow" | "score";
  savedRows: MatchingProposalView[];
  savedContext: boolean;
  skipPaging: boolean;
  pageIndex: number;
  selectedHidden: boolean;
  rightFocus: MatchingCandidateView | null;
  actualJoinFacts: ExplainJoinKeyResult | null;
  onPick: (id: string) => void;
  onNavigate: (d: 1 | -1) => void;
  onSetFilter: (f: MatchingTabSession["reviewFilter"]) => void;
  onSetSort: (v: "workflow" | "score") => void;
  onSetPage: (p: number) => void;
  onSetSavedContext: (v: boolean) => void;
  onAdvanceAfterConfirm: (v: boolean) => void;
  advanceAfterConfirm: boolean;
  selectedIds: string[];
  onToggleSelected: (id: string) => void;
  onCheckVisible: () => void;
  onInvestigate: (proposalId: string) => void;
  onReturn: () => void;
  canNavigatePrev: boolean;
  canNavigateNext: boolean;
  bulkSelectable: boolean;
};

function stateLabel(state: MatchingProposalView["state"]): string {
  switch (state) {
    case "proposed": return "suggested";
    case "ambiguous": return "unclear";
    case "no_candidates": return "no match";
    case "incomplete_search": return "search cut off";
    case "confirmed_in_draft": return "marked to save";
    case "saved": return "in Mapping";
    case "deferred": return "skipped";
    case "rejected": return "rejected";
    case "stale": return "out of date";
    default: return state;
  }
}

/** Compact, non-additive relationship status for one source row. */
function RelationshipPill({ badges }: { badges: (RelationshipBadge | "Actual JOIN")[] }) {
  if (!badges.length) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1 text-[9px]">
      {badges.map(b => (
        <span key={b} className={`rounded px-1 py-0.5 font-medium ${
          b === "Confirmed draft" ? "bg-emerald-500/15 text-emerald-200"
          : b === "Existing Mapping" || b === "Actual JOIN" ? "bg-sky-500/15 text-sky-200"
          : "bg-amber-500/15 text-amber-100"}`}>{b}</span>
      ))}
    </span>
  );
}

const FILTER_LABELS: Record<MatchingTabSession["reviewFilter"], string> = {
  all: "All keys", ready: "To confirm", needs_decision: "Still open", ambiguous: "Unclear",
  incomplete_search: "Search cut off", confirmed: "Marked to save", saved: "In Mapping", stale: "Out of date",
};

export function LeftExplorer({
  session, baseline, plan, selected, page, filteredCount, filter, reviewSearch,
  onSetSearch, reviewSort, savedRows, savedContext, skipPaging, pageIndex,
  selectedHidden, rightFocus, actualJoinFacts, onPick, onNavigate, onSetFilter, onSetSort,
  onSetPage, onSetSavedContext, onAdvanceAfterConfirm, advanceAfterConfirm,
  selectedIds, onToggleSelected, onCheckVisible, onInvestigate, onReturn,
  canNavigatePrev, canNavigateNext, bulkSelectable,
}: Props) {
  const index = useMemo(() => buildRelationshipIndex(session, baseline), [session.proposals, session.candidates, session.decisions, baseline]);
  const [rightSearch, setRightSearch] = useState("");
  const [rightFilter, setRightFilter] = useState<RelationshipBadge | "Actual JOIN" | "All provenance">("All provenance");
  const related = useMemo(() => rightFocus ? relatedSources(index, rightFocus.targetId, rightFocus.outputValues) : [], [index, rightFocus]);
  const visibleRelated = useMemo(() => related.filter(r =>
    (rightFilter === "All provenance" || (rightFilter !== "Actual JOIN" && r.badges.includes(rightFilter))) &&
    r.fromParts.some(v => recordValue(v).toLocaleLowerCase().includes(rightSearch.toLocaleLowerCase()))),
    [related, rightFilter, rightSearch]);
  const actualRelated = useMemo(() => {
    if (!rightFocus || !actualJoinFacts) return [];
    const indices = actualJoinFacts.left_on.map(name => actualJoinFacts.left_columns.findIndex(c => c.name === name));
    const rows = new Map<string, { fromParts: (string | null)[]; occurrences: number }>();
    for (const row of actualJoinFacts.left_rows) {
      const fromParts = indices.map(i => i < 0 || row[i] == null ? null : String(row[i]));
      const key = mapKeyToken(fromParts);
      const prior = rows.get(key);
      rows.set(key, { fromParts, occurrences: (prior?.occurrences ?? 0) + 1 });
    }
    return [...rows].map(([key, row]) => ({ key: JSON.stringify(["executed", key]), ...row }));
  }, [rightFocus, actualJoinFacts]);

  // RIGHT-focused mode: render related-LEFT records for the selected RIGHT.
  if (rightFocus) {
    return (
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden border-r border-slate-800" aria-label="LEFT records related to selected RIGHT">
        <header className="flex shrink-0 items-center gap-2 border-b border-slate-800 px-3 py-2">
          <h3 className="min-w-0 flex-1 text-[12px] font-semibold text-teal-100">
            LEFT related to {plan.targetRef || "RIGHT"}
          </h3>
          <button type="button" onClick={onReturn} className="rounded border border-teal-700/70 px-2 py-1 text-[11px] text-teal-100">
            Return to LEFT review
          </button>
        </header>
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-800 px-3 py-1.5 text-[10px]">
          <input type="search" aria-label="Search related LEFT records" placeholder="Search related LEFT"
            className="min-w-0 rounded border border-slate-700 bg-slate-950 px-2 text-[11px]"
            value={rightSearch} onChange={e => setRightSearch(e.target.value)} />
          <select aria-label="Relationship provenance" className="rounded border border-slate-700 bg-slate-950 text-[10px]"
            value={rightFilter} onChange={e => setRightFilter(e.target.value as RelationshipBadge | "Actual JOIN" | "All provenance")}>
            {["All provenance", "Suggested", "Confirmed draft", "Existing Mapping", "Actual JOIN"].map(name => <option key={name}>{name}</option>)}
          </select>
        </div>
        <ul aria-label="Unified related LEFT records" className="flex-1 overflow-auto">
          {(rightFilter === "Actual JOIN" ? [] : visibleRelated).map(r => (
            <li key={r.key} className="border-b border-slate-800 p-3 text-[11px]">
              <RecordValues fields={plan.mapKeyFields} values={r.fromParts} />
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <RelationshipPill badges={r.badges} />
                <span className="text-slate-500">{r.origins.join(" + ") || (!r.proposalId ? "outside this run — read-only" : "")}</span>
                {r.proposalId && <button type="button" onClick={() => onInvestigate(r.proposalId!)}>Investigate this source (no decision)</button>}
              </div>
            </li>
          ))}
          {(rightFilter === "All provenance" || rightFilter === "Actual JOIN") && actualRelated.filter(r => r.fromParts.some(v => recordValue(v).toLocaleLowerCase().includes(rightSearch.toLocaleLowerCase()))).map(r => (
            <li key={r.key} className="border-b border-slate-800 p-3 text-[11px]">
              <RecordValues fields={actualJoinFacts?.left_on ?? []} values={r.fromParts} />
              <div className="mt-1 flex flex-wrap items-center gap-2"><RelationshipPill badges={["Actual JOIN"]} /><span className="text-slate-500">{r.occurrences} displayed input rows · executed values, not recovered original aliases · read-only</span></div>
            </li>
          ))}
        </ul>
        {!visibleRelated.length && !actualRelated.length && <p className="p-3 text-[11px] text-slate-500">No acquired records match this filter. Uninspected/unknown scopes do not establish absence.</p>}
      </section>
    );
  }

  // LEFT review mode.
  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden" aria-label="Source explorer">
      <header className="flex shrink-0 items-center gap-2 border-b border-slate-800 px-3 py-2">
        <h3 className="min-w-0 flex-1 text-[12px] font-semibold text-teal-100">
          LEFT · {plan.sourceRef || session.title}
        </h3>
      </header>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-800 px-3 py-1.5 text-[10px]">
        <input type="search" aria-label="Search source keys" placeholder="Search source keys"
          className="min-w-0 rounded border border-slate-700 bg-slate-950 px-2 text-[11px]"
          value={reviewSearch} onChange={e => onSetSearch(e.target.value)} />
        <select aria-label="Sort source keys" className="rounded border border-slate-700 bg-slate-950 text-[10px]"
          value={reviewSort} onChange={e => onSetSort(e.target.value as "workflow" | "score")}>
          <option value="workflow">Workflow order</option>
          <option value="score">Suggested score: high to low (unknown last)</option>
        </select>
        {(Object.keys(FILTER_LABELS) as MatchingTabSession["reviewFilter"][]).map(id => {
          const active = filter === id;
          const count = session.proposals.filter(p => {
            if (id === "all") return true;
            if (id === "saved") return p.state === "saved";
            if (id === "confirmed") return p.state === "confirmed_in_draft";
            if (id === "stale") return p.state === "stale";
            if (id === "ready") return p.state === "proposed" || p.state === "ambiguous";
            if (id === "needs_decision") return p.state === "proposed" || p.state === "ambiguous" || p.state === "no_candidates";
            if (id === "ambiguous") return p.state === "ambiguous";
            if (id === "incomplete_search") return p.state === "incomplete_search";
            return false;
          }).length;
          return (
            <button key={id} type="button" onClick={() => onSetFilter(id)}
              className={`rounded px-2 py-0.5 text-[10px] ${active ? "bg-amber-500/20 text-amber-50" : "text-slate-500 hover:text-slate-300"}`}>
              {FILTER_LABELS[id]}{count > 0 ? ` · ${count}` : ""}
            </button>
          );
        })}
        {savedRows.length > 0 && filter !== "saved" && filter !== "all" && (
          <label className="ml-2 flex items-center gap-1 text-[10px] text-teal-200/90">
            <input type="checkbox" checked={savedContext} onChange={e => onSetSavedContext(e.target.checked)} />
            Show {savedRows.length} already in Mapping
          </label>
        )}
        {!skipPaging ? (
          <div className="ml-auto flex items-center gap-1 text-[10px] text-slate-500">
            <button type="button" aria-label="Previous source page" disabled={pageIndex <= 0}
              onClick={() => onSetPage(Math.max(0, pageIndex - 1))}
              className="rounded border border-slate-700 px-1.5 disabled:opacity-30">‹</button>
            <span>page {pageIndex + 1}</span>
            <button type="button" aria-label="Next source page"
              disabled={(pageIndex + 1) * session.pageSize >= filteredCount}
              onClick={() => onSetPage(pageIndex + 1)}
              className="rounded border border-slate-700 px-1.5 disabled:opacity-30">›</button>
          </div>
        ) : (
          <div className="ml-auto text-[10px] text-slate-400">scroll the list — all groups are here</div>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-slate-700 px-3 py-1.5 text-[11px]" aria-label="Sequential review">
        <button type="button" disabled={!canNavigatePrev} onClick={() => onNavigate(-1)}>Previous unresolved</button>
        <button type="button" disabled={!canNavigateNext} onClick={() => onNavigate(1)}>Next unresolved</button>
        <label><input type="checkbox" checked={advanceAfterConfirm} onChange={e => onAdvanceAfterConfirm(e.target.checked)} /> Advance after confirm</label>
        {selectedHidden && <span role="status">Pinned source is outside this page/filter. <button type="button" onClick={() => onSetPage(0)}>Reveal source</button></span>}
      </div>
      {!page.length ? (
        <div className="flex flex-1 items-center justify-center p-4 text-[11px] text-slate-500">
          No source records. Click <span className="text-amber-100">Find matches</span> to compare source keys with the dictionary.
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full text-left text-[11px]">
          <thead className="sticky top-0 bg-slate-950 text-slate-400">
            <tr>
              {bulkSelectable && <th className="p-2">Reviewed</th>}
              <th className="p-2">Source record</th>
              <th className="p-2">Suggested / draft target</th>
              <th className="p-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {page.map(p => {
              const decision = session.decisions.find(d => d.proposalId === p.proposalId);
              const target = candidateById(session, decision?.candidateId ?? p.proposedCandidateId);
              const active = selected?.proposalId === p.proposalId;
              return (
                <tr key={p.proposalId} data-testid={`matching-row-${p.proposalId}`}
                  onClick={() => onPick(p.proposalId)}
                  className={`cursor-pointer border-t border-slate-800 ${active ? "bg-amber-950/30" : "hover:bg-slate-900"}`}>
                  {bulkSelectable && (
                    <td className="p-2">
                      <input type="checkbox" aria-label={`Reviewed source ${JSON.stringify(p.mapKey)}`}
                        checked={selectedIds.includes(p.proposalId)}
                        disabled={p.state === "saved" || p.state === "stale" || !!session.commitLifecycle}
                        onClick={e => e.stopPropagation()}
                        onChange={() => onToggleSelected(p.proposalId)} />
                    </td>
                  )}
                  <td className="p-2">
                    <button type="button" onClick={e => { e.stopPropagation(); onPick(p.proposalId); }}>
                      <RecordValues fields={plan.mapKeyFields} values={p.mapKey} />
                    </button>
                    <span className="text-slate-500">{p.affectedSourceRows} source rows</span>
                  </td>
                  <td className="p-2">
                    {target ? <RecordValues fields={plan.outputs} values={target.outputValues} /> : "No suggestion"}
                  </td>
                  <td className="p-2">
                    <span className="block">{stateLabel(p.state)}</span>
                    <RelationshipPill badges={[...(p.proposedCandidateId ? ["Suggested" as const] : []), ...(decision && p.state === "confirmed_in_draft" ? ["Confirmed draft" as const] : [])]} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      )}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-slate-800 px-3 py-1.5 text-[11px]">
        <button type="button" onClick={onCheckVisible} className="text-slate-500 hover:underline">Check visible rows</button>
      </div>
    </section>
  );
}
