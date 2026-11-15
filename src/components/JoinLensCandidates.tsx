import { useEffect, useRef, useState } from "react";
import type { ConnectionDef, SourceDef, Workspace } from "../types/pipeline";
import { joinKeyFuzzySuggest, type JoinKeyFuzzySuggest, type ProjectRefContext } from "../lib/bridge";
import { findTupleSource, tupleCell, tupleCounts, type TupleParts } from "../lib/joinLensTuple";

const CACHE_LIMIT = 16;
const TOP_K = 8;

/** Read-only, single-source inspection. No decisions, LLM, or Mapping authority. */
export function JoinLensCandidates({ active, sourceParts, workspace, hostQueryId, joinStepIndex,
  leftOn, rightOn, connections, sources, projectRef, projectIdentity, sessionContext,
}: {
  active: boolean; sourceParts: TupleParts | null; workspace: Workspace; hostQueryId: string;
  joinStepIndex: number; leftOn: string[]; rightOn: string[]; connections: ConnectionDef[];
  sources: SourceDef[]; projectRef?: ProjectRefContext; projectIdentity: string;
  sessionContext: string;
}) {
  // Definition fingerprints stay local (connections may contain secrets). Never persist/log.
  const context = JSON.stringify({ workspace, hostQueryId, joinStepIndex, leftOn, rightOn,
    connections, sources, projectRef, projectIdentity, sessionContext });
  const selection = JSON.stringify(sourceParts);
  const owner = JSON.stringify([context, selection, active]);
  const live = useRef({ owner, context, generation: 0 });
  const cache = useRef(new Map<string, JoinKeyFuzzySuggest>());
  if (live.current.owner !== owner) {
    if (live.current.context !== context) cache.current.clear();
    live.current = { owner, context, generation: live.current.generation + 1 };
  }
  const [state, setState] = useState<{ owner: string; generation?: number; loading?: boolean; error?: string }>({ owner });
  const [revision, setRevision] = useState(0);
  const wasActive = useRef(false);
  const valid = !!sourceParts && leftOn.length >= 1 && leftOn.length <= 5 &&
    sourceParts.length === leftOn.length && rightOn.length === leftOn.length;
  const report = cache.current.get(selection);
  const tuple = report?.tuple_report;
  const source = tuple && sourceParts ? findTupleSource(tuple, sourceParts) : undefined;
  const ownsState = state.owner === owner && state.generation === live.current.generation;
  const loading = ownsState && !!state.loading;
  const error = ownsState ? state.error : undefined;

  async function find() {
    if (!active || !valid || !sourceParts || loading) return;
    const token = ++live.current.generation;
    const owned = () => live.current.owner === owner && live.current.generation === token;
    setState({ owner, generation: token, loading: true });
    try {
      const r = await joinKeyFuzzySuggest(workspace, hostQueryId, joinStepIndex, connections,
        sources, null, null, projectRef, { source_parts: sourceParts });
      if (!owned()) return;
      if (!r.tuple_report) throw new Error("Full-tuple candidates are unavailable from this Host.");
      if (r.host_query_id !== hostQueryId || r.join_step_index !== joinStepIndex ||
        JSON.stringify(r.tuple_report.left_on) !== JSON.stringify(leftOn) ||
        JSON.stringify(r.tuple_report.right_on) !== JSON.stringify(rightOn)) {
        throw new Error("Candidate context changed. Find candidates again.");
      }
      const focused = findTupleSource(r.tuple_report, sourceParts);
      if (focused?.candidates.some((c) => !Number.isInteger(c.right_index) || c.right_index < 0 ||
        r.tuple_report!.right_universe[c.right_index]?.parts.length !== rightOn.length ||
        c.field_scores.length !== leftOn.length)) throw new Error("Incomplete candidate tuple evidence from Host.");
      cache.current.delete(selection);
      cache.current.set(selection, r);
      while (cache.current.size > CACHE_LIMIT) cache.current.delete(cache.current.keys().next().value!);
      setState({ owner, generation: token });
      setRevision((v) => v + 1);
    } catch (e) {
      if (owned()) setState({ owner, generation: token, error: String(e) });
    }
  }

  useEffect(() => {
    // Opening is lazy. Changing source while open never starts a new query.
    const opening = active && !wasActive.current;
    wasActive.current = active;
    if (active && report) {
      cache.current.delete(selection);
      cache.current.set(selection, report); // LRU touch, not FIFO.
    }
    if (opening && valid && !report) void find();
    // Value ownership above includes all request dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, revision]);
  useEffect(() => () => { live.current.generation++; }, []);

  if (!active) return null;
  const candidates = [...(source?.candidates ?? [])].sort((a, b) =>
    (b.score ?? -Infinity) - (a.score ?? -Infinity) || a.right_index - b.right_index).slice(0, TOP_K);
  const incomplete = !!tuple && (tuple.left_truncated || tuple.right_truncated ||
    tuple.right_universe.length < tuple.right_distinct_total || !source ||
    source.candidates.length < tuple.right_universe.length);
  return <section data-testid="join-lens-candidates" aria-label="Right candidates" className="min-h-0 flex-1 space-y-2 overflow-auto p-2 text-[11px] text-slate-300">
    <p>Read-only · one full LEFT tuple → up to {TOP_K} RIGHT tuples. Includes right tuples that already join elsewhere.</p>
    {sourceParts ? <dl data-testid="candidate-source">{sourceParts.map((v, i) => <div key={i} className="break-all whitespace-pre-wrap"><dt className="text-slate-500">{leftOn[i]}</dt><dd className="font-mono">{tupleCell(v)}</dd></div>)}</dl> : <p>Select a LEFT card or an unmatched result row. Right-only and hypothetical pair selections are not candidate sources.</p>}
    {!valid && sourceParts && <p>Candidate inspection supports 1–5 ordered Join key pairs.</p>}
    <button type="button" disabled={!valid || loading} onClick={() => void find()}
      className="rounded border border-teal-700 px-2 py-1 text-teal-100 disabled:opacity-40">{loading ? "Finding candidates…" : "Find candidates"}</button>
    {loading && <p role="status">Searching this full tuple…</p>}
    {error && <p role="alert" className="text-rose-300">{error}</p>}
    {report?.disabled_reason && <p role="alert">{report.disabled_reason}</p>}
    {tuple && <>
      <p data-testid="candidate-coverage">Right coverage: {tuple.right_universe.length} / {tuple.right_distinct_total} distinct tuples · {tuple.right_occurrences_total} rows. Showing {candidates.length} / {source?.candidates.length ?? 0} returned competitors. Source: {source ? tupleCounts(source.source) : "unavailable"}.</p>
      <p className={incomplete ? "text-amber-200" : "text-slate-500"}>{incomplete ? `Incomplete / bounded coverage (Host cap ${tuple.tuple_cap}); not a dataset-wide best-match guarantee.` : "Complete retrieved tuple coverage; Top-K display only, not an accepted match."} External data changes in place are not detected; cached results are session-local.</p>
      {!source && <p role="alert">This exact source tuple is unavailable in the current Host result.</p>}
      {source && !candidates.length && <p>No candidates returned for this tuple.</p>}
      <ol className="space-y-2">{candidates.map((c) => {
        const target = tuple.right_universe[c.right_index]!;
        return <li key={c.right_index} data-testid="right-candidate" className="rounded border border-slate-700 p-2">
          <dl>{target.parts.map((v, i) => <div key={i} className="break-all whitespace-pre-wrap"><dt className="text-slate-500">{tuple.right_on[i]}</dt><dd className="font-mono">{tupleCell(v)}</dd></div>)}</dl>
          <p>Mean score: {c.score == null ? "unknown" : c.score.toFixed(3)} · Join tuple similarity ({report.metric})</p>
          <p>{tupleCounts(target)}</p>
          <details><summary className="cursor-pointer text-teal-200">Field differences / scores</summary>
            {sourceParts!.map((v, i) => <div key={i} className="my-1 break-all whitespace-pre-wrap border-t border-slate-800">
              <p>{leftOn[i]} → {rightOn[i]}</p><p className="font-mono">{tupleCell(v)} → {tupleCell(target.parts[i]!)}</p>
              <p>{v === target.parts[i] ? "Same" : "Changed"} · score {c.field_scores[i] == null ? "unknown" : c.field_scores[i]!.toFixed(3)}</p>
            </div>)}
          </details>
        </li>;
      })}</ol>
    </>}
  </section>;
}
