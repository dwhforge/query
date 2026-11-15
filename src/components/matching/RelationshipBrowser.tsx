import { useEffect, useMemo, useRef, useState } from "react";
import type { ExplainJoinKeyResult } from "../../lib/bridge";
import { advancedCandidateId } from "../../app/matching/advanced";
import { buildRelationshipIndex, relatedSources, type MappingProjection } from "../../app/matching/relationships";
import { mapKeyToken, type MatchingCandidateView, type MatchingTabSession } from "../../app/matching/types";
import { RecordValues, recordValue } from "./RecordValues";

type InspectedFacts = ExplainJoinKeyResult & { inspectedAt: string };
const unavailable: MappingProjection = { rows: [], complete: false, coverage: "Mapping baseline not acquired." };
type Props = {
  session: MatchingTabSession;
  baseline?: MappingProjection;
  target: MatchingCandidateView | null;
  focusEpoch: number;
  onFocusTarget: (candidate: MatchingCandidateView) => void;
  onInspectJoin?: (outputs: (string | null)[]) => Promise<ExplainJoinKeyResult>;
  onInvestigate: (proposalId: string) => void;
  onReturn: () => void;
};

/** One related-LEFT list; separate evidence authorities never become additive. */
export function RelationshipBrowser({ session, baseline = unavailable, target, focusEpoch, onFocusTarget, onInspectJoin, onInvestigate, onReturn }: Props) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [leftSearch, setLeftSearch] = useState("");
  const [filter, setFilter] = useState("All provenance");
  const [leftPage, setLeftPage] = useState(0);
  const [facts, setFacts] = useState<InspectedFacts | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const intent = useRef(0);
  const cache = useRef(new Map<string, InspectedFacts>());
  const evidenceKey = useMemo(() => JSON.stringify([session.id, session.generation, session.basicRun?.id, session.advancedRun?.id,
    session.joinBinding, session.commitLifecycle, target?.targetId, baseline]),
    [session.id, session.generation, session.basicRun?.id, session.advancedRun?.id, session.joinBinding, session.commitLifecycle, target?.targetId, baseline]);
  // Includes Mapping refresh and sticky lifecycle; focusEpoch defeats A→B→A.
  const owner = JSON.stringify([evidenceKey, focusEpoch]);
  const ownerRef = useRef(owner); ownerRef.current = owner;
  useEffect(() => { intent.current++; setFacts(session.commitLifecycle ? null : cache.current.get(evidenceKey) ?? null); setError(""); setLoading(false); setLeftPage(0);
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
  const visibleTargets = targets.filter(c => [...c.outputValues, ...Object.values(c.fields)].some(v => recordValue(v).toLocaleLowerCase().includes(search.toLocaleLowerCase())));
  const targetPage = Math.min(page, Math.max(0, Math.ceil(visibleTargets.length / 20) - 1));
  const sources = useMemo(() => target ? relatedSources(index, target.targetId, target.outputValues) : [], [index, target]);
  const count = (badge: string) => sources.filter(r => r.badges.includes(badge as never)).length;
  const sharedOutputs = target ? targets.filter(c => mapKeyToken(c.outputValues) === mapKeyToken(target.outputValues)).length : 0;
  const executedKeys = facts?.left_on.map(name => facts.left_columns.findIndex(c => c.name === name)) ?? [];
  // Executed input rows stay in the SAME list, in a distinct namespace: transformed
  // keys cannot silently become original aliases or proposal confirmation authority.
  const executed = new Map<string, { values: (string | null)[]; occurrences: number; examples: unknown[][] }>();
  for (const row of facts?.left_rows ?? []) {
    const values = executedKeys.map(i => row[i] == null ? null : String(row[i]));
    const key = mapKeyToken(values);
    const previous = executed.get(key);
    executed.set(key, { values, occurrences: (previous?.occurrences ?? 0) + 1, examples: [...(previous?.examples ?? []), row] });
  }
  const list = [
    ...sources.map(r => ({ key: JSON.stringify(["original", r.key]), values: r.fromParts, badges: r.badges as string[],
      description: `${r.occurrences ?? "unknown"} source rows · ${r.state ?? "outside this run — read-only"} · ${r.origins.join(" + ")}`,
      proposalId: r.proposalId, executed: false, examples: [] as unknown[][] })),
    ...[...executed].map(([key, row]) => ({ key: JSON.stringify(["executed", key]), values: row.values, badges: ["Actual JOIN"],
      description: `${row.occurrences} displayed input rows · executed input values, not recovered original aliases · read-only`, proposalId: undefined, executed: true, examples: row.examples })),
  ].filter(r => (filter === "All provenance" || r.badges.includes(filter)) && r.values.some(v => recordValue(v).toLocaleLowerCase().includes(leftSearch.toLocaleLowerCase())));
  const visibleLeftPage = Math.min(leftPage, Math.max(0, Math.ceil(list.length / 20) - 1));
  const locked = !!session.commitLifecycle || session.executionMode !== "live";
  async function inspect() {
    if (!target || !onInspectJoin || locked) return;
    const epoch = ++intent.current, captured = owner;
    setLoading(true); setError(""); setFacts(null);
    try {
      const result = await onInspectJoin(target.outputValues);
      if (epoch === intent.current && ownerRef.current === captured) {
        const inspected = { ...result, inspectedAt: new Date().toISOString() };
        cache.current.delete(evidenceKey); cache.current.set(evidenceKey, inspected);
        while (cache.current.size > 8) cache.current.delete(cache.current.keys().next().value!);
        setFacts(inspected);
      }
    } catch (e) { if (epoch === intent.current && ownerRef.current === captured) setError(String(e)); }
    finally { if (epoch === intent.current && ownerRef.current === captured) setLoading(false); }
  }
  return <section className="space-y-2 border-t border-slate-700 p-3 text-[11px]" aria-label="RIGHT relationship explorer">
    <h3 className="font-semibold">RIGHT records · {session.plan?.targetRef}</h3>
    <p>Acquired targets only; browsing does not establish admissibility for any LEFT source.</p>
    <input aria-label="Search acquired targets" type="search" placeholder="Search target records" value={search}
      className="w-full rounded border border-slate-700 bg-slate-950 p-1" onChange={e => { setSearch(e.target.value); setPage(0); }} />
    <details open={!target}><summary>{visibleTargets.length} acquired target records · browse</summary>
      <div className="max-h-60 overflow-auto space-y-1">{visibleTargets.slice(targetPage * 20, (targetPage + 1) * 20).map(c => <button type="button" key={c.targetId}
        data-testid="matching-browse-target" className="block w-full rounded border border-slate-700 p-2 text-left" onClick={() => onFocusTarget(c)}>
        <RecordValues fields={session.plan?.outputs ?? []} values={c.outputValues} />
        {c.identityParts && <div>{session.basicRun ? "Identity (exact RIGHT tuple)" : "Target identity"}: <RecordValues fields={session.basicRun ? session.plan?.outputs ?? [] : session.plan?.targetIdentityFields ?? []} values={c.identityParts} /></div>}
      </button>)}</div>
      <button type="button" disabled={!targetPage} onClick={() => setPage(targetPage - 1)}>Previous targets</button>
      <button type="button" disabled={(targetPage + 1) * 20 >= visibleTargets.length} onClick={() => setPage(targetPage + 1)}>Next targets</button>
    </details>
    {target && <>
      <h3 className="font-semibold">LEFT records related to this RIGHT</h3>
      <RecordValues fields={session.plan?.outputs ?? []} values={target.outputValues} />
      <button type="button" onClick={onReturn}>Return to LEFT review</button>
      <section aria-label="Relationship authority coverage" className="rounded border border-slate-700 p-2 space-y-1">
        <p>Separate authorities — counts are non-additive.</p>
        <p>Suggested: {count("Suggested")} source keys in installed run edges only. {session.proposals.length} acquired source keys; additional records/shortlist edges may exist.</p>
        <p>Confirmed draft: {count("Confirmed draft")} source keys in this session, not written.</p>
        <p>Existing Mapping: {baseline.complete ? count("Existing Mapping") : "unknown total; 0 acquired"} source keys for this output group. {baseline.coverage}</p>
        <p>{sharedOutputs} acquired target identities share these outputs. Mapping and execution evidence belongs to the output-key group, not independent target identity.</p>
        <p>Actual JOIN: {facts ? `${facts.left_match_count} LEFT input rows · ${facts.right_match_count} RIGHT input rows · ${facts.result_match_count} result rows` : loading ? "loading" : error ? "unavailable" : "not inspected"}.</p>
        {facts && <><p>Inspected at {facts.inspectedAt} against the current JOIN definition, not a historical preview. Cached query-time evidence; inspect again for a fresh read. Showing {facts.left_rows.length}/{facts.left_match_count} LEFT input rows; sample limit {facts.sample_limit}. {facts.left_match_count > facts.left_rows.length ? "Partial sample; additional rows exist. Complete arbitrary-large reverse enumeration unsupported." : "All matching LEFT input rows fit this query-time sample."}</p>
          <p>NULL uses SQL equality. Outer JOIN result rows alone do not prove a matching partner. Executed keys may be transformed; original alias count unknown. No external snapshot isolation.</p></>}
        {error && <p role="alert">{error}</p>}
        <button type="button" data-testid="matching-inspect-join" disabled={locked || loading || !onInspectJoin} onClick={() => void inspect()}>Inspect actual JOIN counts and examples (up to 50)</button>
        {!onInspectJoin && <p>Actual JOIN inspection unavailable for this session.</p>}
      </section>
      <label>Provenance filter <select aria-label="Relationship provenance" value={filter} className="bg-slate-950" onChange={e => { setFilter(e.target.value); setLeftPage(0); }}>
        {["All provenance", "Suggested", "Confirmed draft", "Existing Mapping", "Actual JOIN"].map(name => <option key={name}>{name}</option>)}
      </select></label>
      <input type="search" aria-label="Search related LEFT records" placeholder="Search related LEFT" value={leftSearch} className="w-full bg-slate-950 p-1" onChange={e => { setLeftSearch(e.target.value); setLeftPage(0); }} />
      <ul aria-label="Unified related LEFT records" className="space-y-2">{list.slice(visibleLeftPage * 20, (visibleLeftPage + 1) * 20).map(row => <li key={row.key} className="rounded border border-slate-700 p-2">
        <RecordValues fields={row.executed ? facts?.left_on ?? [] : session.plan?.mapKeyFields ?? []} values={row.values} />
        <div className="flex flex-wrap gap-1">{row.badges.map(b => <span key={b} className="rounded bg-slate-800 px-1">{b}</span>)}</div>
        <p>{row.description}</p>
        {row.examples.length > 0 && <details><summary>Displayed input row fields ({row.examples.length} bounded examples)</summary>
          {row.examples.map((example, i) => <div key={i} className="border-t border-slate-800 py-1"><RecordValues fields={facts?.left_columns.map(c => c.name) ?? []}
            values={example.map(value => value == null ? null : String(value))} /></div>)}
        </details>}
        {row.proposalId && <button type="button" onClick={() => onInvestigate(row.proposalId!)}>Investigate this source (no decision)</button>}
      </li>)}</ul>
      {!list.length && <p>No acquired records match this filter. Uninspected/unknown scopes do not establish absence.</p>}
      <button type="button" disabled={!visibleLeftPage} onClick={() => setLeftPage(visibleLeftPage - 1)}>Previous related records</button>
      <button type="button" disabled={(visibleLeftPage + 1) * 20 >= list.length} onClick={() => setLeftPage(visibleLeftPage + 1)}>Next related records</button>
    </>}
  </section>;
}
