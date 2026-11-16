/** RIGHT Explorer — owns the actual target (RIGHT) record presentation.
 *
 * ADR-0052: the RIGHT Explorer always occupies the primary right column and
 * shows the acquired RIGHT records as business-readable tuples, not a technical
 * sidebar. Selecting a record is RIGHT-focused INSPECTION: it keeps the target
 * visible and switches the LEFT Explorer to the unified related-LEFT list. It
 * never confirms.
 *
 * Coverage, the actual-JOIN inspection and material warnings stay visible in a
 * compact panel so incomplete results are never silently hidden.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ExplainJoinKeyResult } from "../../lib/bridge";
import { advancedCandidateId } from "../../app/matching/advanced";
import { buildRelationshipIndex, relatedSources, type MappingProjection } from "../../app/matching/relationships";
import { mapKeyToken, type MatchingCandidateView, type MatchingProposalView, type MatchingTabSession } from "../../app/matching/types";
import { RecordValues, recordValue } from "./RecordValues";

type Props = {
  session: MatchingTabSession;
  baseline: MappingProjection;
  /** The RIGHT record currently under inspection (RIGHT-focused mode). */
  focused: MatchingCandidateView | null;
  focusEpoch: number;
  /** Current LEFT row, if any; only its acquired proposal edges count as suggestions. */
  activeSource?: MatchingProposalView | null;
  selectedTargetId?: string;
  /** Selects a pair for inspection, without confirming or changing the ledger. */
  onSelectCandidate?: (candidate: MatchingCandidateView) => void;
  /** Opens the separate RIGHT -> LEFT relationship investigation mode. */
  onSetFocus: (candidate: MatchingCandidateView | null) => void;
  onInspectJoin?: (outputs: (string | null)[]) => Promise<ExplainJoinKeyResult>;
  onJoinFacts?: (facts: ExplainJoinKeyResult | null) => void;
};

type InspectedFacts = ExplainJoinKeyResult & { inspectedAt: string };
const unavailable: MappingProjection = { rows: [], complete: false, coverage: "Mapping baseline not acquired." };

export function RightExplorer({ session, baseline = unavailable, focused, focusEpoch, activeSource, selectedTargetId, onSelectCandidate, onSetFocus, onInspectJoin, onJoinFacts }: Props) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [facts, setFacts] = useState<InspectedFacts | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const intent = useRef(0);
  const cache = useRef(new Map<string, InspectedFacts>());
  const evidenceKey = useMemo(() => JSON.stringify([session.id, session.generation, session.basicRun?.id, session.advancedRun?.id,
    session.joinBinding, session.commitLifecycle, focused?.targetId, baseline]),
    [session.id, session.generation, session.basicRun?.id, session.advancedRun?.id, session.joinBinding, session.commitLifecycle, focused?.targetId, baseline]);
  const owner = JSON.stringify([evidenceKey, focusEpoch]);
  const ownerRef = useRef(owner); ownerRef.current = owner;
  useEffect(() => { intent.current++; setFacts(session.commitLifecycle ? null : cache.current.get(evidenceKey) ?? null); setError(""); setLoading(false);
    return () => { intent.current++; };
  }, [owner]);
  const index = useMemo(() => buildRelationshipIndex(session, baseline), [session.proposals, session.candidates, session.decisions, baseline]);
  const targets = useMemo(() => {
    const rows = new Map(session.candidates.map(c => [c.targetId, c]));
    const run = session.advancedRun;
    if (run) for (const row of run.snapshot.acquisition.targetRows) if (!rows.has(row.targetId)) rows.set(row.targetId, {
      candidateId: advancedCandidateId(run.id, row.targetId), targetId: row.targetId, outputValues: row.outputValues,
      identityParts: row.identityValues, fields: row.fields, occurrences: row.occurrences, evidenceRevision: run.evidenceRevision, runId: run.id,
    });
    return [...rows.values()];
  }, [session.candidates, session.advancedRun]);
  const proposedIds = useMemo(() => new Set([
    activeSource?.proposedCandidateId,
    ...(activeSource?.alternativeCandidateIds ?? []),
    ...(activeSource?.edges ?? []).map(e => e.candidateId),
  ].filter((id): id is string => !!id)), [activeSource]);
  const visibleTargets = useMemo(() => targets
    .filter(c => [...c.outputValues, ...(c.identityParts ?? []), ...Object.values(c.fields)]
      .some(v => recordValue(v).toLocaleLowerCase().includes(search.toLocaleLowerCase())))
    .sort((a, b) => Number(proposedIds.has(b.candidateId)) - Number(proposedIds.has(a.candidateId))),
    [targets, search, proposedIds]);
  const targetPage = Math.min(page, Math.max(0, Math.ceil(visibleTargets.length / 20) - 1));
  const related = useMemo(() => focused ? relatedSources(index, focused.targetId, focused.outputValues) : [], [index, focused]);
  const count = (badge: string) => related.filter(r => r.badges.includes(badge as never)).length;
  const sharedOutputs = focused ? targets.filter(c => mapKeyToken(c.outputValues) === mapKeyToken(focused.outputValues)).length : 0;
  const executedKeys = facts?.left_on.map(name => facts.left_columns.findIndex(c => c.name === name)) ?? [];
  const executed = new Map<string, { values: (string | null)[]; occurrences: number; examples: unknown[][] }>();
  for (const row of facts?.left_rows ?? []) {
    const values = executedKeys.map(i => row[i] == null ? null : String(row[i]));
    const key = mapKeyToken(values);
    const previous = executed.get(key);
    executed.set(key, { values, occurrences: (previous?.occurrences ?? 0) + 1, examples: [...(previous?.examples ?? []), row] });
  }
  const executedList = [...executed].map(([key, row]) => ({ key: JSON.stringify(["executed", key]), values: row.values, occurrences: row.occurrences,
    examples: row.examples }));
  const locked = !!session.commitLifecycle || session.executionMode !== "live";
  async function inspect() {
    if (!focused || !onInspectJoin || locked) return;
    const epoch = ++intent.current, captured = owner;
    setLoading(true); setError(""); setFacts(null);
    try {
      const result = await onInspectJoin(focused.outputValues);
      if (epoch === intent.current && ownerRef.current === captured) {
        const inspected = { ...result, inspectedAt: new Date().toISOString() };
        cache.current.delete(evidenceKey); cache.current.set(evidenceKey, inspected);
        while (cache.current.size > 8) cache.current.delete(cache.current.keys().next().value!);
        setFacts(inspected);
        onJoinFacts?.(result);
      }
    } catch (e) { if (epoch === intent.current && ownerRef.current === captured) { setError(String(e)); onJoinFacts?.(null); } }
    finally { if (epoch === intent.current && ownerRef.current === captured) setLoading(false); }
  }
  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden" aria-label="RIGHT relationship explorer">
      <header className="flex shrink-0 items-center gap-2 border-b border-slate-800 px-3 py-2">
        <h3 className="min-w-0 flex-1 text-[12px] font-semibold text-teal-100">RIGHT · {session.plan?.targetRef}</h3>
      </header>
      <div className="shrink-0 px-3 pb-2">
        <input aria-label="Search acquired targets" type="search" placeholder="Search acquired targets" value={search}
          className="w-full rounded border border-slate-700 bg-slate-950 p-1 text-[11px]" onChange={e => { setSearch(e.target.value); setPage(0); }} />
      </div>
      {activeSource && (
        <p className="shrink-0 px-3 pb-1 text-[10px] text-slate-400" role="status">
          {proposedIds.size ? "Highlighted: candidates suggested for the active LEFT; other records are still available." :
            "No suggested candidates for this LEFT. Select an acquired RIGHT manually."}
        </p>
      )}
      <ul aria-label="Acquired RIGHT records" className="flex-1 overflow-auto">
        {!visibleTargets.length && <li className="p-3 text-[11px] text-slate-400">{search ? "No acquired RIGHT records match this search." : "No acquired RIGHT records. Manual lookup remains available in Relationship Details."}</li>}
        {visibleTargets.slice(targetPage * 20, (targetPage + 1) * 20).map(c => {
          const suggested = proposedIds.has(c.candidateId);
          const selected = selectedTargetId === c.targetId;
          const independentIdentity = !session.basicRun && c.identityParts?.length &&
            mapKeyToken(c.identityParts) !== mapKeyToken(c.outputValues);
          return (
          <li key={c.targetId} className={`border-b border-slate-800 ${selected ? "bg-teal-950/50" : ""}`}>
            <div className={`flex items-start gap-2 border-l-2 px-2 py-1.5 ${selected ? "border-teal-400" : suggested ? "border-teal-700" : "border-transparent"}`}>
              <button type="button" data-testid="matching-select-target"
                aria-pressed={selected} aria-label={`Select RIGHT ${c.outputValues.map(recordValue).join(" / ")}`}
                className="min-w-0 flex-1 rounded p-1 text-left text-[11px] hover:bg-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-400"
                onClick={() => onSelectCandidate ? onSelectCandidate(c) : onSetFocus(c)}>
                <RecordValues fields={session.plan?.outputs ?? []} values={c.outputValues} />
                {independentIdentity ? <div className="mt-1 text-slate-400">Target identity:
                  <RecordValues fields={session.plan?.targetIdentityFields ?? []} values={c.identityParts!} />
                </div> : null}
                {suggested && <span className="mt-1 inline-block rounded border border-teal-700 px-1 text-[10px] text-teal-200">Suggested candidate</span>}
                {selected && <span className="ml-1 text-[10px] text-teal-200">Selected for inspection</span>}
              </button>
              <button type="button" className="shrink-0 rounded border border-slate-700 px-2 py-1 text-[10px] text-slate-300 hover:border-teal-700"
                onClick={() => onSetFocus(c)} data-testid="matching-browse-target" aria-label={`Related LEFT for ${c.outputValues.map(recordValue).join(" / ")}`}>
                Related LEFT<span className="sr-only">{c.outputValues.map((value, i) => <span key={i}>{recordValue(value)}</span>)}</span>
              </button>
            </div>
          </li>
        );})}
      </ul>
      <p className="shrink-0 border-t border-slate-800 px-3 py-1 text-[10px] text-slate-500">{visibleTargets.length} of {targets.length} acquired RIGHT records · browsing is inspection only</p>
      {visibleTargets.length > 20 && (
        <div className="flex shrink-0 items-center justify-between border-t border-slate-800 px-3 py-1.5 text-[10px] text-slate-500">
          <button type="button" disabled={!targetPage} onClick={() => setPage(targetPage - 1)}>Previous targets</button>
          <span>page {targetPage + 1}</span>
          <button type="button" disabled={(targetPage + 1) * 20 >= visibleTargets.length} onClick={() => setPage(targetPage + 1)}>Next targets</button>
        </div>
      )}
      {focused && (
        <details className="shrink-0 border-t border-slate-800 bg-slate-950/50 px-3 py-1 text-[10px] space-y-1">
          <summary>Evidence &amp; Coverage · {facts ? `${facts.left_rows.length}/${facts.left_match_count} actual JOIN LEFT rows sampled` : "actual JOIN not inspected"}</summary>
          <section aria-label="Relationship authority coverage" className="space-y-1 py-1">
          <p>Separate authorities — counts are non-additive.</p>
          <p>Suggested: {count("Suggested")} source keys in this run's edges only. {session.proposals.length} acquired source keys; additional records/shortlist edges may exist.</p>
          <p>Confirmed draft: {count("Confirmed draft")} source keys in this session, not written.</p>
          <p>Existing Mapping: {baseline.complete ? count("Existing Mapping") : "unknown total; 0 acquired"} source keys for this output group. {baseline.coverage}</p>
          <p>{sharedOutputs} acquired target identities share these outputs. Mapping and execution evidence belongs to the output-key group, not independent target identity.</p>
          <p>Actual JOIN: {facts ? `${facts.left_match_count} LEFT input rows · ${facts.right_match_count} RIGHT input rows · ${facts.result_match_count} result rows` : loading ? "loading" : error ? "unavailable" : "not inspected"}.</p>
          {facts && (
            <>
              <p>Inspected at {facts.inspectedAt} against the current JOIN definition, not a historical preview. Cached query-time evidence; inspect again for a fresh read. Showing {facts.left_rows.length}/{facts.left_match_count} LEFT input rows; sample limit {facts.sample_limit}. {facts.left_match_count > facts.left_rows.length ? "Partial sample; additional rows exist. Complete arbitrary-large reverse enumeration unsupported." : "All matching LEFT input rows fit this query-time sample."}</p>
              <p>NULL uses SQL equality. Outer JOIN result rows alone do not prove a matching partner. Executed keys may be transformed; original alias count unknown. No external snapshot isolation.</p>
            </>
          )}
          {executedList.length > 0 && (
            <p>{executedList.length} executed input rows — transformed LEFT values, not recovered original aliases; read-only.</p>
          )}
          {error && <p role="alert">{error}</p>}
          <button type="button" data-testid="matching-inspect-join" disabled={locked || loading || !onInspectJoin} onClick={() => void inspect()}>
            Inspect actual JOIN counts and examples (up to 50)
          </button>
          {!onInspectJoin && <p>Actual JOIN inspection unavailable for this session.</p>}
          </section>
        </details>
      )}
    </section>
  );
}
