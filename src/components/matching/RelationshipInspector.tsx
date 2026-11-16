import { useEffect, useRef, useState } from "react";
import type { MatchingJoinLookupResult, MatchingLookupPage } from "../../lib/bridge";
import { tupleCell, tupleMappingBlock } from "../../lib/joinLensTuple";
import { applyDecision, candidateById } from "../../app/matching/reviewLogic";
import { proposalCascadeTier, proposalEvidenceSummary } from "../../app/matching/cascade";
import { mapKeyToken, type MatchingProposalView, type MatchingTabSession, type MatchingCandidateView } from "../../app/matching/types";
import type { MappingProjection } from "../../app/matching/relationships";
import { RecordValues, recordValue } from "./RecordValues";

function stateLabel(state: string) { return state.replace(/_/g, " "); }
export function RelationshipInspector({
  session,
  onLookupAdvanced,
  proposal,
  onChange,
  onAgreeReplace,
  onInspectTarget,
  baseline,
  focusEpoch,
  browsedTarget,
  autoPickedTargetId,
}: {
  session: MatchingTabSession;
  onLookupAdvanced?: (proposalId: string, page: MatchingLookupPage) => Promise<MatchingJoinLookupResult>;
  onInspectTarget: (candidate: MatchingCandidateView) => void;
  baseline?: MappingProjection;
  focusEpoch: number;
  browsedTarget?: MatchingCandidateView | null;
  /** Only a direct click on the RIGHT candidate may preselect a temporary pair. */
  autoPickedTargetId?: string;
  proposal: MatchingProposalView | null;
  onChange: (s: MatchingTabSession) => void;
  onAgreeReplace: (token: string) => void;
}) {
  // Temporary picks are per-source and per-run (the parent keys this panel by run).
  // They never mutate producer suggestions or the authoritative decision ledger.
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [candidateSearch, setCandidateSearch] = useState("");
  const [candidatePage, setCandidatePage] = useState(0);
  const [candidateSort, setCandidateSort] = useState<"score" | "values">("score");
  const [lookupResult, setLookupResult] = useState<MatchingJoinLookupResult | null>(null);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupError, setLookupError] = useState("");
  const lookupGeneration = useRef(0);
  const lookupCache = useRef(new Map<string, MatchingJoinLookupResult>());
  const lookupDataKey = JSON.stringify([session.id, session.advancedRun?.id, proposal?.proposalId, session.joinBinding]);
  const lookupOwner = JSON.stringify([session.id, session.advancedRun?.id, proposal?.proposalId, session.commitLifecycle, session.joinBinding, focusEpoch]);
  const ownerRef = useRef(lookupOwner); ownerRef.current = lookupOwner;
  useEffect(() => { lookupGeneration.current++; setLookupResult(session.commitLifecycle ? null : lookupCache.current.get(lookupDataKey) ?? null); setLookupBusy(false); setLookupError("");
    return () => { lookupGeneration.current++; };
  }, [lookupOwner]);
  async function findAdvanced(page: MatchingLookupPage) {
    if (!proposal || !onLookupAdvanced) return;
    const generation = ++lookupGeneration.current, owner = lookupOwner;
    setLookupBusy(true); setLookupResult(null); setLookupError("");
    try {
      const result = await onLookupAdvanced(proposal.proposalId, page);
      if (generation === lookupGeneration.current && ownerRef.current === owner) {
        lookupCache.current.delete(lookupDataKey); lookupCache.current.set(lookupDataKey, result);
        while (lookupCache.current.size > 16) lookupCache.current.delete(lookupCache.current.keys().next().value!);
        setLookupResult(result); setCandidatePage(0);
      }
    } catch (e) {
      if (generation === lookupGeneration.current && ownerRef.current === owner) setLookupError(String(e));
    } finally { if (generation === lookupGeneration.current && ownerRef.current === owner) setLookupBusy(false); }
  }
  const searches = useRef(new Map<string, { text: string; page: number }>());
  useEffect(() => {
    const view = searches.current.get(proposal?.proposalId ?? "");
    setCandidateSearch(view?.text ?? ""); setCandidatePage(view?.page ?? 0);
  }, [proposal?.proposalId]);
  useEffect(() => { if (proposal) searches.current.set(proposal.proposalId, { text: candidateSearch, page: candidatePage }); }, [candidateSearch, candidatePage]);
  if (!proposal) {
    return (
      <aside className="w-72 shrink-0 border-l border-slate-800 p-2 text-[11px] text-slate-500">
        Select a key in the list
      </aside>
    );
  }
  const proposed = candidateById(session, proposal.proposedCandidateId);
  const alts = proposal.alternativeCandidateIds
    .map((id) => candidateById(session, id))
    .filter(Boolean);
  const live = session.mapLive.find(
    (r) => mapKeyToken(r.fromParts) === mapKeyToken(proposal.mapKey),
  );
  const tier = proposalCascadeTier(proposal);
  const decision = session.decisions.find(d => d.proposalId === proposal.proposalId);
  const decided = candidateById(session, decision?.candidateId);
  // A click on an acquired RIGHT selects a temporary inspection pair, not a
  // decision. Advanced still requires source-scoped candidate/lookup authority.
  const browsedAdmissible = !!browsedTarget && autoPickedTargetId === browsedTarget.targetId && (session.basicRun ||
    proposal.alternativeCandidateIds.includes(browsedTarget.candidateId) ||
    proposal.proposedCandidateId === browsedTarget.candidateId ||
    lookupResult?.candidates.some(r => r.candidateId === browsedTarget.candidateId));
  const picked = (browsedAdmissible ? browsedTarget : null) ?? candidateById(session, picks[proposal.proposalId]);
  const comparison = browsedTarget ?? picked ?? decided ?? proposed;
  const baselineRows = baseline?.rows.filter(r => mapKeyToken(r.fromParts) === mapKeyToken(proposal.mapKey)) ?? [];
  const consequence = !baseline?.complete ? "Baseline not acquired — final verification still required" : baselineRows.length > 1
    ? "Conflict: duplicate existing From keys" : !baselineRows.length ? "Add one complete Mapping key" : comparison && mapKeyToken(baselineRows[0]!.outputValues) === mapKeyToken(comparison.outputValues)
      ? "Already matches / no-op" : "Conflict: existing outputs differ; Write will refuse nonempty differing outputs";
  const sourceBlock = tupleMappingBlock(proposal.mapKey);
  // Basic can browse its full verified retrieved universe, not just its shortlist.
  // Advanced manual results were source/plan verified by Host, beyond the shortlist.
  const lookupRows = lookupResult?.candidates ?? [];
  const universe = session.basicRun ? session.candidates : lookupResult
    ? lookupRows.map(row => candidateById(session, row.candidateId)).filter(c => !!c) : [...new Map([proposed, ...alts].filter(c => !!c).map(c => [c.candidateId, c])).values()];
  const query = candidateSearch.toLocaleLowerCase();
  // Keep Host-verified identity-only Advanced hits even if identity columns are
  // not duplicated into the display-fields object.
  const candidates = universe.filter(c => [...c.outputValues, ...(c.identityParts ?? []), ...Object.values(c.fields)]
    .some(v => tupleCell(v).toLocaleLowerCase().includes(query))).sort((a, b) => {
      if (candidateSort === "values") return mapKeyToken(a.outputValues).localeCompare(mapKeyToken(b.outputValues));
      const score = (id: string) => lookupRows.find(r => r.candidateId === id)?.score
        ?? proposal.edges?.find(e => e.candidateId === id)?.score ?? -1;
      return score(b.candidateId) - score(a.candidateId);
    });
  const pageCount = Math.max(1, Math.ceil(candidates.length / 20));
  const visiblePage = Math.min(candidatePage, pageCount - 1);
  const candidateLocked = !!session.commitLifecycle || proposal.state === "saved" || proposal.state === "stale";

  function confirmPicked() {
    if (!proposal || !picked || (browsedTarget && browsedTarget.candidateId !== picked.candidateId) || candidateLocked || sourceBlock || tupleMappingBlock(picked.outputValues)) return;
    if (session.advancedRun && !proposal.alternativeCandidateIds.includes(picked.candidateId) && !lookupRows.some(r => r.candidateId === picked.candidateId)) return;
    // Register a manual Basic alternative from the already retrieved universe
    // only on explicit confirmation. Scores stay Host-owned or unknown.
    const next = session.basicRun && !proposal.alternativeCandidateIds.includes(picked.candidateId) ? { ...session, proposals: session.proposals.map(p => {
      if (p.proposalId !== proposal.proposalId) return p;
      const edges = [...(p.edges ?? [])];
      const index = edges.findIndex(e => e.candidateId === picked.candidateId);
      const edge = index < 0 ? { candidateId: picked.candidateId, metric: "join_tuple_similarity" as const,
        score: null, fieldScores: picked.outputValues.map(() => null), origins: [] } : edges[index]!;
      const manual = { ...edge, origins: [...new Set([...edge.origins, "manual" as const])] };
      if (index < 0) edges.push(manual); else edges[index] = manual;
      return { ...p, edges, alternativeCandidateIds: [...new Set([...p.alternativeCandidateIds, picked.candidateId])] };
    }) } : lookupResult && lookupRows.some(r => r.candidateId === picked.candidateId) ? { ...session, proposals: session.proposals.map(p => {
      if (p.proposalId !== proposal.proposalId) return p;
      const row = lookupRows.find(r => r.candidateId === picked.candidateId);
      if (!row || JSON.stringify(row.outputValues) !== JSON.stringify(picked.outputValues)) return p;
      return { ...p, userTouched: true,
        manualLookups: { ...p.manualLookups, [picked.candidateId]: lookupResult.page },
        edges: [...(p.edges ?? []).filter(e => e.candidateId !== picked.candidateId), {
          candidateId: picked.candidateId, metric: "contextual" as const, score: row.score,
          fieldScores: row.fieldScores, origins: ["manual" as const] }],
        alternativeCandidateIds: [...new Set([...p.alternativeCandidateIds, picked.candidateId])] };
    }) } : session;
    onChange(applyDecision(next, proposal.proposalId, picked.candidateId === proposal.proposedCandidateId ? "confirm_proposed" : "choose_alternative", picked.candidateId));
  }

  return (
    <aside
      className="flex min-w-0 flex-1 flex-col gap-1.5 overflow-auto border-l border-slate-800 p-2 text-[11px]"
      data-testid="matching-detail"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
            tier === "fuzzy"
              ? "bg-emerald-500/15 text-emerald-200"
              : tier === "leftover"
                ? "bg-amber-500/20 text-amber-100"
                : tier === "llm"
                  ? "bg-violet-500/20 text-violet-100"
                  : "bg-slate-600/40 text-slate-200"
          }`}
        >
          {tier === "fuzzy"
            ? "Matched by spelling"
            : tier === "leftover"
              ? "Not sent to LLM yet"
              : tier === "llm"
                ? "LLM suggested this"
                : "You need to pick"}
        </span>
      </div>
      <div className="font-semibold text-slate-200">
        Source:{" "}
        <span className="font-mono">
          {proposal.mapKey.map(tupleCell).join(" / ")}
        </span>
      </div>
      <div className="text-slate-500">
        This key covers {proposal.affectedSourceRows} source row(s)
        {proposal.searchIncomplete ? " · search was cut off" : ""}
      </div>
      {decision && <section aria-label="Current draft decision" className="rounded border border-teal-800 p-2">
        <p>{stateLabel(proposal.state)}{decided ? ` → ${decided.outputValues.map(tupleCell).join(" · ")}` : ""}</p>
        <button type="button" disabled={candidateLocked} onClick={() => {
          setPicks(current => { const next = { ...current }; delete next[proposal.proposalId]; return next; });
          const decisions = session.decisions.filter(d => d.proposalId !== proposal.proposalId);
          onChange({ ...session, decisions, hasUnsavedDecisions: decisions.length > 0,
            proposals: session.proposals.map(p => p.proposalId === proposal.proposalId
              ? { ...p, state: p.suggestionState ?? "proposed", userTouched: true } : p) });
        }}>Undo decision</button>
      </section>}
      {/* ADR-0052: the selected relationship is the most prominent thing in this
          panel. It is stable: opening/closing Details never changes it. */}
      <div className="order-[-2] shrink-0 rounded border border-teal-800 bg-teal-950/30 px-3 py-1.5">
        <div className="flex flex-wrap items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-teal-200/80">
          Selected relationship
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-100">
          <span className="min-w-0 break-words font-mono">
            {proposal.mapKey.map(tupleCell).join(" / ")}
          </span>
          <span className="text-teal-300">→</span>
          <span className="min-w-0 break-words font-mono">
            {comparison
              ? comparison.outputValues.map(tupleCell).join(" / ")
              : "no RIGHT selected"}
          </span>
        </div>
        <div className="mt-1 text-[11px] text-slate-400">
          {picked ? "Selected for confirmation" : decided ? "Confirmed draft" : "Suggested — not yet confirmed"}
        </div>
      </div>

      <section aria-label="Relationship comparison" className="space-y-1">
        <div className="grid grid-cols-2 gap-3">
          <div><h4 className="text-[9px] uppercase text-slate-500">LEFT</h4><RecordValues fields={session.plan?.mapKeyFields ?? []} values={proposal.mapKey} /></div>
          <div><h4 className="text-[9px] uppercase text-slate-500">RIGHT</h4>{comparison ? <RecordValues fields={session.plan?.outputs ?? []} values={comparison.outputValues} /> : "No target selected"}</div>
        </div>
        <details><summary>Details · {proposalEvidenceSummary(proposal)}</summary><div className="max-h-24 overflow-auto">
        {session.plan?.comparisons.map((field, i) => <div key={i}>
          <span>{field.sourceField} → {field.targetField} · {field.role.replace(/_/g, " ")}: </span>
          <span>{recordValue(proposal.sourceValues[field.sourceField])} → {recordValue(comparison?.fields[field.targetField])}</span>
          <span> · {field.role === "reference_context" ? "reference / unscored" : `Host field score: ${proposal.edges?.find(e => e.candidateId === comparison?.candidateId)?.fieldScores[i] ?? "unknown"}; no inferred constraint pass`}</span>
        </div>)}
        <p>{consequence}. Confirm stages a draft only; Write Mapping verifies the original JOIN. Save the project separately.</p>
        {proposal.evidence.map((e, i) => <p key={i}><span className="text-slate-500">{e.field}:</span> {e.note}</p>)}
        </div></details>
        {comparison && <button type="button" className="rounded border border-slate-600 px-2 py-1" onClick={() => onInspectTarget(comparison)}>Inspect RIGHT relationships</button>}
      </section>

      <section aria-label="Explicit relationship actions" className="order-[-1] sticky top-0 z-10 flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-700 bg-[#0b1220] px-2 py-1.5">
        <button type="button" disabled={!proposed || candidateLocked || !!decision || !!sourceBlock || !!tupleMappingBlock(proposed.outputValues)}
          onClick={() => proposed && setPicks({ ...picks, [proposal.proposalId]: proposed.candidateId })}>Select suggested candidate</button>
      {browsedTarget && <section aria-label="Inspected RIGHT pair" className="rounded border border-slate-700 p-2">
        <p>Inspecting this RIGHT with the pinned LEFT. Navigation has not selected or confirmed it.</p>
        <button type="button" disabled={candidateLocked || !!decision || (!session.basicRun && !proposal.alternativeCandidateIds.includes(browsedTarget.candidateId) && !lookupRows.some(r => r.candidateId === browsedTarget.candidateId))}
          onClick={() => setPicks({ ...picks, [proposal.proposalId]: browsedTarget.candidateId })}>Select this relationship for inspection</button>
        {!session.basicRun && !proposal.alternativeCandidateIds.includes(browsedTarget.candidateId) && !lookupRows.some(r => r.candidateId === browsedTarget.candidateId) && <p>Not admissible for this source yet. Use its own Find right records lookup; another source's lookup cannot authorize this pair.</p>}
      </section>}
      <button type="button" className="rounded border border-teal-700 p-2 disabled:opacity-40"
        disabled={!picked || candidateLocked || !!decision || !!sourceBlock || !!tupleMappingBlock(picked.outputValues) || (!!browsedTarget && picked.candidateId !== browsedTarget.candidateId)}
        onClick={confirmPicked}>Confirm selected candidate</button>
      </section>
      {(session.basicRun ?? session.advancedRun) && <section aria-label="Candidate evidence" className="space-y-2">
        <p>{proposal.coverage?.rightRetrieved}/{proposal.coverage?.rightTotal ?? "unknown"} retrieved right tuples · {proposal.coverage?.shortlistOmitted ?? 0} alternatives omitted from display · {proposal.coverage?.competitorsUnknown ?? "unknown"} unknown competitors</p>
        {session.advancedRun && <p className="text-slate-400">Verified live acquisition, run {session.advancedRun.id.slice(0, 24)}… · {proposal.coverage?.sourceRetrieved} source tuples · right retrieval {proposal.coverage?.rightTruncated ? "truncated — incomplete coverage blocks confidence bulk" : "complete"}</p>}
        {tupleMappingBlock(proposal.mapKey) && <p role="note" className="text-amber-200">{tupleMappingBlock(proposal.mapKey)}</p>}
        <details><summary>Technical candidate evidence (similarity, not probability)</summary>
          {alts.slice(0, 8).map(c => {
            if (!c) return null;
            const edge = proposal.edges?.find(e => e.candidateId === c.candidateId);
            return <div key={c.candidateId} className="rounded border border-slate-700 p-1">
              <RecordValues fields={session.plan?.outputs ?? []} values={c.outputValues} />
              <p>{edge?.origins.join(" + ") ?? "unknown origin"} · mean {edge?.score ?? "unknown"} · {c.occurrences ?? "unknown"} target rows</p>
              <p>Field scores: {edge?.fieldScores.map(s => s == null ? "unknown" : `${(s * 100).toFixed(1)}%`).join(" / ") ?? "unknown"}</p>
              {edge?.rationale && <p>{edge.rationale}</p>}
            </div>;
          })}
        </details>
      </section>}

      {(session.candidates.length > 0 || session.basicRun || session.advancedRun) && <details>
        <summary>Search other records</summary>
        <section aria-label="Manual right search" className="space-y-2">
          <p>{session.basicRun ? "Search all retrieved RIGHT tuples only, not the full dataset."
            : !session.advancedRun ? "Candidates acquired for this review only; selecting does not confirm."
            : "Search the bounded RIGHT universe through Host, beyond the shortlist. Hard constraints still apply; no dataset-wide scalability claim."}</p>
          <input type="search" aria-label="Search right candidates" placeholder="Search all fields"
            className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1"
            value={candidateSearch} onChange={e => { lookupGeneration.current++; lookupCache.current.delete(lookupDataKey); setLookupBusy(false); setLookupResult(null); setLookupError(""); setCandidateSearch(e.target.value); setCandidatePage(0); }} />
          {session.advancedRun && <>
            <button type="button" data-testid="matching-advanced-lookup" disabled={lookupBusy || candidateLocked || !!decision || !onLookupAdvanced}
              onClick={() => void findAdvanced({ text: candidateSearch, offset: 0 })}>{lookupBusy ? "Searching…" : "Find right records"}</button>
            {lookupError && <p role="alert">{lookupError}</p>}
            {lookupResult && <p role="status">{lookupResult.total} admissible matches in {lookupResult.universeCount}/{lookupResult.universeCap} bounded RIGHT records · Host page {lookupResult.page.offset / 20 + 1}</p>}
            {lookupResult && <>
              <button type="button" disabled={lookupBusy || lookupResult.page.offset === 0} onClick={() => void findAdvanced({ ...lookupResult.page, offset: lookupResult.page.offset - 20 })}>Previous lookup page</button>
              <button type="button" disabled={lookupBusy || lookupResult.page.offset + 20 >= lookupResult.total} onClick={() => void findAdvanced({ ...lookupResult.page, offset: lookupResult.page.offset + 20 })}>Next lookup page</button>
            </>}
          </>}
          <select aria-label="Sort right candidates" value={candidateSort}
            className="w-full rounded border border-slate-700 bg-slate-950"
            onChange={e => { setCandidateSort(e.target.value as "score" | "values"); setCandidatePage(0); }}>
            <option value="score">Score: high to low (unknown last)</option>
            <option value="values">Tuple values</option>
          </select>
          <p>{candidates.length} retrieved matches · page {visiblePage + 1}/{pageCount}</p>
          {!candidates.length && <p>No retrieved right tuples match this search.</p>}
          <div className="max-h-80 overflow-auto space-y-1">
          {candidates.slice(visiblePage * 20, (visiblePage + 1) * 20).map(c => {
            const lookupRow = lookupRows.find(r => r.candidateId === c.candidateId);
            const edge = lookupRow ? { ...lookupRow, metric: "contextual", origins: ["manual"] } : proposal.edges?.find(e => e.candidateId === c.candidateId);
            const block = tupleMappingBlock(c.outputValues);
            return <label key={c.candidateId} data-testid={`matching-choose-${c.targetId}`} className="block rounded border border-slate-700 p-1">
              <input type="radio" name={`candidate-${proposal.proposalId}`} checked={picked?.candidateId === c.candidateId}
                disabled={candidateLocked || !!decision} onChange={() => setPicks({ ...picks, [proposal.proposalId]: c.candidateId })} />
              <RecordValues fields={session.plan?.outputs ?? []} values={c.outputValues} />
              <button type="button" onClick={() => onInspectTarget(c)}>Inspect RIGHT relationships</button>
              <span className="block">{edge?.origins?.join(" + ") ?? "not proposed for this source"} · {edge?.metric ?? "unknown metric"} · mean {edge?.score == null ? "unknown" : `${(edge.score * 100).toFixed(1)}%`} · {c.occurrences ?? "unknown"} target rows</span>
              {(c.occurrences ?? 0) > 1 && <span className="block text-amber-200">Repeated target tuple: the JOIN may multiply rows.</span>}
              {block && <span className="block text-amber-200">{block}</span>}
            </label>;
          })}
          </div>
          <button type="button" disabled={visiblePage === 0} onClick={() => setCandidatePage(visiblePage - 1)}>Previous records</button>
          <button type="button" disabled={visiblePage + 1 >= pageCount} onClick={() => setCandidatePage(visiblePage + 1)}>Next records</button>
          {picked && <p>Selected (not confirmed): {picked.outputValues.map(tupleCell).join(" · ")}</p>}

        </section>
      </details>}

      <div className="flex flex-wrap gap-1">
        <button
          type="button"
          disabled={candidateLocked || !!decision}
          onClick={() =>
            onChange(
              applyDecision(session, proposal.proposalId, "defer", null),
            )
          }
          className="rounded border border-slate-700 px-2 py-0.5 text-slate-400"
        >
          Skip for now
        </button>
        <button
          type="button"
          disabled={candidateLocked || !!decision}
          onClick={() =>
            onChange(
              applyDecision(
                session,
                proposal.proposalId,
                "no_suitable_target",
                null,
              ),
            )
          }
          className="rounded border border-slate-700 px-2 py-0.5 text-slate-400"
        >
          No match in dictionary
        </button>
        {live && (
          <button
            type="button"
            onClick={() => onAgreeReplace(mapKeyToken(proposal.mapKey))}
            className="rounded border border-amber-800/50 px-2 py-0.5 text-amber-100"
          >
            Agree replace existing
          </button>
        )}
      </div>
    </aside>
  );
}
