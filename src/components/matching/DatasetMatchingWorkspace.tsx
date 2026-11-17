import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConnectionDef, SourceDef, Workspace } from "../../types/pipeline";
import {
  describeWorkspace,
  matchingDatasetEstimate, matchingDatasetEvaluate, matchingDatasetPage,
  matchingDatasetCandidates, matchingDatasetDrop, matchingDatasetDecide,
  matchingDatasetConfirmClear, matchingDatasetReviewStats, matchingDatasetCompare,
  type DatasetMatchingRequest, type DatasetMatchingRun, type DatasetMatchingEstimate,
  type DatasetMatchingPage, type DatasetMatchRow, type DatasetReviewStats,
  type DatasetMatchingComparison,
  type ProjectRefContext,
} from "../../lib/bridge";

type FieldRule = { sourceField: string; targetField: string; role: "hard_constraint" | "soft_signal" | "reference_context" };
type Props = {
  workspace: Workspace;
  connections: ConnectionDef[];
  sources: SourceDef[];
  projectRef: ProjectRefContext;
  onStageToMapping?: (runId: string, targetMapId: string, plan: DatasetMatchingRequest["plan"]) => Promise<void>;
  mapOptions?: { id: string; name: string }[];
};
const INITIAL_RULE: FieldRule = { sourceField: "", targetField: "", role: "soft_signal" };
const PAGE_SIZE = 50;
function textList(raw: string) { return raw.split(",").map(s => s.trim()).filter(Boolean); }
function displayTuple(raw: string | null | undefined) {
  if (!raw) return "—";
  try { const v: unknown = JSON.parse(raw); return Array.isArray(v) ? v.join(" · ") : raw; }
  catch { return raw; }
}
function safeMessage(e: unknown) { return e instanceof Error ? e.message : String(e); }

/** Independent Matching uses full Host-evaluated datasets. No UI page is ever an engine input. */
export function DatasetMatchingWorkspace({ workspace, connections, sources, projectRef, mapOptions = [], onStageToMapping }: Props) {
  const queries = workspace.queries ?? [];
  const [left, setLeft] = useState(queries[0]?.id ?? "");
  const [right, setRight] = useState(queries[1]?.id ?? "");
  const [leftColumns, setLeftColumns] = useState<string[]>([]);
  const [rightColumns, setRightColumns] = useState<string[]>([]);
  const [mapKeys, setMapKeys] = useState("");
  const [targetKeys, setTargetKeys] = useState("");
  const [outputs, setOutputs] = useState("");
  const [comparisons, setComparisons] = useState<FieldRule[]>([{ ...INITIAL_RULE }]);
  const [sample, setSample] = useState(5);
  const [maxPairs, setMaxPairs] = useState(2_000_000);
  const [score, setScore] = useState(0.70);
  const [estimate, setEstimate] = useState<DatasetMatchingEstimate | null>(null);
  const [run, setRun] = useState<DatasetMatchingRun | null>(null);
  const [previousRun, setPreviousRun] = useState<DatasetMatchingRun | null>(null);
  const [comparison, setComparison] = useState<DatasetMatchingComparison | null>(null);
  const [evaluatedPlan, setEvaluatedPlan] = useState<DatasetMatchingRequest["plan"] | null>(null);
  const liveRuns = useRef<string[]>([]);
  useEffect(() => () => { for (const id of liveRuns.current) void matchingDatasetDrop(id).catch(() => undefined); }, []);
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState("all");
  const [rows, setRows] = useState<DatasetMatchingPage | null>(null);
  const [selected, setSelected] = useState<DatasetMatchRow | null>(null);
  const [candidatePage, setCandidatePage] = useState<DatasetMatchingPage | null>(null);
  const [candidateIndex, setCandidateIndex] = useState(0);
  const [stats, setStats] = useState<DatasetReviewStats | null>(null);
  const [mapId, setMapId] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let live = true;
    const columns = async (queryId: string) => {
      if (!queryId) return [];
      const response = await describeWorkspace({ ...workspace, focus_query_id: queryId }, connections, sources, projectRef);
      return response.columns.map(c => c.name);
    };
    void Promise.all([columns(left), columns(right)]).then(([l, r]) => {
      if (!live) return;
      setLeftColumns(l);
      setRightColumns(r);
    }).catch(e => { if (live) setError(`Schema: ${safeMessage(e)}`); });
    return () => { live = false; };
  }, [left, right, workspace, connections, sources, projectRef.projectFile, projectRef.projectUid]);

  const plan = useMemo<DatasetMatchingRequest["plan"]>(() => ({
    sourceRef: left,
    targetRef: right,
    mapKeyFields: textList(mapKeys),
    targetIdentityFields: textList(targetKeys),
    outputs: textList(outputs),
    comparisons,
    normalization: ["trim", "casefold"],
    ambiguity: "leave_for_manual",
    scope: "full",
    semanticRevision: 1,
    uiRevision: 0,
  }), [left, right, mapKeys, targetKeys, outputs, comparisons]);

  const request = useMemo<DatasetMatchingRequest>(() => ({
    plan, samplePercent: sample, maxCandidatePairs: maxPairs, minimumScore: score,
  }), [plan, sample, maxPairs, score]);
  const valid = Boolean(left && right && left !== right && plan.mapKeyFields.length && plan.targetIdentityFields.length && plan.outputs.length &&
    comparisons.length && comparisons.every(c => c.sourceField && c.targetField) &&
    comparisons.some(c => c.role !== "reference_context") && Number.isInteger(sample) && sample >= 1 && sample <= 100 &&
    Number.isFinite(score) && score >= 0 && score <= 1 && maxPairs > 0);
  const editRule = (idx: number, next: Partial<FieldRule>) => setComparisons(before => before.map((r, i) => i === idx ? { ...r, ...next } : r));

  const reload = useCallback(async (active: DatasetMatchingRun, index: number) => {
    const loaded = await matchingDatasetPage(active.runId, index, PAGE_SIZE, filter);
    setRows(loaded);
    setPage(index);
    setStats(await matchingDatasetReviewStats(active.runId));
  }, [filter]);
  async function execute(kind: "estimate" | "evaluate") {
    if (!valid || working) return;
    setWorking(true); setError(null); setMessage("");
    try {
      if (kind === "estimate") {
        setEstimate(await matchingDatasetEstimate(workspace, connections, sources, projectRef, request));
      } else {
        const next = await matchingDatasetEvaluate(workspace, connections, sources, projectRef, request);
        // Keep one prior run for indicative comparison. Do not call this snapshot-verified A/B.
        if (run) {
          if (previousRun) { await matchingDatasetDrop(previousRun.runId); liveRuns.current = liveRuns.current.filter(id => id !== previousRun.runId); }
          setPreviousRun(run);
          try { setComparison(await matchingDatasetCompare(run.runId, next.runId)); }
          catch (e) { setComparison(null); setMessage(`A/B comparison refused: ${safeMessage(e)}`); }
        } else { setComparison(null); }
        liveRuns.current.push(next.runId);
        setEvaluatedPlan(JSON.parse(JSON.stringify(plan)) as DatasetMatchingRequest["plan"]);
        setRun(next); setSelected(null); setCandidatePage(null);
        await reload(next, 0);
      }
    } catch (e) { setError(safeMessage(e)); }
    finally { setWorking(false); }
  }
  async function chooseRow(row: DatasetMatchRow) {
    setSelected(row); setCandidateIndex(0); setCandidatePage(null); setError(null);
    if (!run) return;
    try { setCandidatePage(await matchingDatasetCandidates(run.runId, row.leftId, 0, PAGE_SIZE)); }
    catch (e) { setError(safeMessage(e)); }
  }
  async function nextCandidates(index: number) {
    if (!run || !selected) return;
    try { setCandidatePage(await matchingDatasetCandidates(run.runId, selected.leftId, index, PAGE_SIZE)); setCandidateIndex(index); }
    catch (e) { setError(safeMessage(e)); }
  }
  async function decide(action: "confirm" | "reject" | "defer" | "no_target", target?: number) {
    if (!run || !selected || working) return;
    setWorking(true); setError(null);
    try {
      const updated = await matchingDatasetDecide({ runId: run.runId, leftId: selected.leftId, rightId: action === "confirm" ? target : null, action });
      setStats(updated); await reload(run, page); setMessage(`Reviewed ${updated.reviewed} source rows. No Mapping was modified.`);
    } catch (e) { setError(safeMessage(e)); }
    finally { setWorking(false); }
  }
  async function confirmClear() {
    if (!run || working) return;
    setWorking(true); setError(null);
    try {
      const updated = await matchingDatasetConfirmClear(run.runId);
      setStats(updated); await reload(run, page); setMessage(`Confirmed ${updated.confirmed} unambiguous evaluated rows, not merely the visible page. Review before Mapping.`);
    } catch (e) { setError(safeMessage(e)); }
    finally { setWorking(false); }
  }
  async function stage() {
    if (!run || !mapId || !onStageToMapping || !evaluatedPlan || working) return;
    setWorking(true); setError(null);
    try { await onStageToMapping(run.runId, mapId, evaluatedPlan); setMessage("Confirmed matches staged in Mapping editor. Check, Save, then Apply explicitly."); }
    catch (e) { setError(safeMessage(e)); }
    finally { setWorking(false); }
  }

  const cn = "rounded border border-slate-600 bg-slate-900/70 px-2 py-1 text-xs text-slate-100";
  const btn = "rounded border border-slate-600 px-3 py-1.5 text-xs hover:bg-slate-800 disabled:opacity-40";
  return <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#0a111a] text-slate-200">
    <header className="shrink-0 border-b border-slate-700 px-4 py-3">
      <h2 className="text-base font-semibold text-teal-100">Matching <span className="ml-2 text-xs font-normal text-slate-400">Dataset → Dataset · full scope</span></h2>
      <p className="mt-1 text-xs text-slate-400">Estimate is sampled. Evaluate reads every source row and every target row; pagination affects display only.</p>
    </header>
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(260px,320px)_minmax(0,1fr)]">
      <aside className="space-y-3 overflow-y-auto border-r border-slate-700 p-3 text-xs">
        <div className="font-semibold uppercase text-slate-400">Datasets &amp; identity</div>
        <label className="block">LEFT query<select aria-label="LEFT dataset" className={`mt-1 w-full ${cn}`} value={left} onChange={e => setLeft(e.target.value)}>{queries.map(q => <option key={q.id} value={q.id}>{q.name || q.id}</option>)}</select></label>
        <label className="block">RIGHT query<select aria-label="RIGHT dataset" className={`mt-1 w-full ${cn}`} value={right} onChange={e => setRight(e.target.value)}>{queries.map(q => <option key={q.id} value={q.id}>{q.name || q.id}</option>)}</select></label>
        <label className="block">LEFT Mapping keys (comma-separated)<input className={`mt-1 w-full ${cn}`} list="match-left-cols" value={mapKeys} onChange={e => setMapKeys(e.target.value)} placeholder="e.g. product_code" /></label>
        <label className="block">RIGHT identity fields<input className={`mt-1 w-full ${cn}`} list="match-right-cols" value={targetKeys} onChange={e => setTargetKeys(e.target.value)} /></label>
        <label className="block">RIGHT output fields, in Mapping order<input className={`mt-1 w-full ${cn}`} list="match-right-cols" value={outputs} onChange={e => setOutputs(e.target.value)} /></label>
        <datalist id="match-left-cols">{leftColumns.map(c => <option key={c} value={c} />)}</datalist>
        <datalist id="match-right-cols">{rightColumns.map(c => <option key={c} value={c} />)}</datalist>
        <div className="flex items-center justify-between"><strong className="uppercase text-slate-400">Rules</strong><button className={btn} type="button" onClick={() => setComparisons(cs => [...cs, { ...INITIAL_RULE }])}>+ Rule</button></div>
        {comparisons.map((rule, i) => <div key={i} className="space-y-1 rounded border border-slate-700 p-2">
          <select aria-label={`LEFT field ${i + 1}`} className={`w-full ${cn}`} value={rule.sourceField} onChange={e => editRule(i, { sourceField: e.target.value })}><option value="">LEFT field</option>{leftColumns.map(f => <option key={f} value={f}>{f}</option>)}</select>
          <select aria-label={`RIGHT field ${i + 1}`} className={`w-full ${cn}`} value={rule.targetField} onChange={e => editRule(i, { targetField: e.target.value })}><option value="">RIGHT field</option>{rightColumns.map(f => <option key={f} value={f}>{f}</option>)}</select>
          <div className="flex gap-1"><select aria-label={`Role ${i + 1}`} className={`min-w-0 flex-1 ${cn}`} value={rule.role} onChange={e => editRule(i, { role: e.target.value as FieldRule["role"] })}><option value="hard_constraint">Hard constraint / blocking</option><option value="soft_signal">Similarity score</option><option value="reference_context">Context only</option></select><button className={btn} type="button" disabled={comparisons.length === 1} onClick={() => setComparisons(cs => cs.filter((_, j) => i !== j))}>×</button></div>
        </div>)}
        <div className="grid grid-cols-2 gap-2">
          <label>Estimate sample %<input aria-label="Sample percent" className={`mt-1 w-full ${cn}`} type="number" min={1} max={100} value={sample} onChange={e => setSample(Number(e.target.value))} /></label>
          <label>Minimum score<input className={`mt-1 w-full ${cn}`} type="number" min={0} max={1} step={0.05} value={score} onChange={e => setScore(Number(e.target.value))} /></label>
        </div>
        <label className="block">Maximum comparisons before refusal<input className={`mt-1 w-full ${cn}`} type="number" min={1} max={100000000} value={maxPairs} onChange={e => setMaxPairs(Number(e.target.value))} /></label>
        <div className="flex gap-2"><button className={btn} disabled={!valid || working} onClick={() => void execute("estimate")}>Estimate {sample}%</button><button className={`${btn} border-teal-600 text-teal-200`} disabled={!valid || working} onClick={() => void execute("evaluate")}>Evaluate full scope</button></div>
        {estimate && <div className="rounded border border-amber-800 p-2 text-amber-200">Estimate only: {estimate.sampledLeft} / {estimate.leftTotal} LEFT rows sampled. {estimate.sampledCandidatePairs.toLocaleString()} candidate pairs observed; ~{estimate.estimatedCandidatePairs.toLocaleString()} extrapolated. No coverage claim.</div>}
      </aside>
      <main className="flex min-h-0 flex-col overflow-hidden">
        {error && <div role="alert" className="border-b border-red-800 bg-red-950 p-2 text-xs text-red-200">{error}</div>}
        {message && <div role="status" className="border-b border-teal-800 p-2 text-xs text-teal-200">{message}</div>}
        {!run ? <div className="m-auto max-w-lg p-8 text-center text-sm text-slate-500">Select two queries, choose identity and comparison rules, then Evaluate. UI previews cannot limit the requested scope.</div> : <>
          <div className="shrink-0 border-b border-slate-700 p-3">
            <div className="flex flex-wrap gap-4 text-sm"><strong className="text-teal-200">{run.leftTotal.toLocaleString()} LEFT</strong><span>{run.rightTotal.toLocaleString()} RIGHT</span><span>{run.proposedSources} proposed</span><span className="text-amber-300">{run.ambiguousSources} ambiguous</span><span className="text-amber-200">{run.belowThresholdSources} below threshold</span><span>{run.unmatchedSources} no candidates</span><span>{run.candidatePairs} scored candidate pairs (including below threshold)</span><span className="text-amber-200">{run.reusedTargets} reused RIGHT identities</span></div>
            <p className="mt-1 text-xs text-slate-500">Source coverage: {run.sourceCoverage}; candidate policy: {run.candidatePolicy}; exhaustive search: {run.candidateSearchExhaustive ? "yes" : "no (hard-constrained)"}. A/B counts are indicative without a shared transactional snapshot.</p>
            {previousRun && <div className="mt-1 text-xs text-slate-400">Previous run: {previousRun.proposedSources} proposed → {run.proposedSources}; {previousRun.ambiguousSources} ambiguous → {run.ambiguousSources}. Different source snapshots may invalidate comparison.</div>}
            {comparison && <div className="mt-1 text-xs text-amber-300">Indicative relationship A/B: {comparison.commonKeys} shared keys · {comparison.changedTarget} changed target · {comparison.becameMatched} newly matched · {comparison.becameUnmatched} newly unmatched · {comparison.firstOnly}/{comparison.secondOnly} left/right-only keys. Snapshot verified: no.</div>}
            <div className="mt-2 flex flex-wrap items-center gap-2"><button className={btn} disabled={working} onClick={() => void confirmClear()}>Review: confirm all unambiguous</button><span className="text-xs">{stats?.confirmed ?? 0} confirmed · {stats?.reviewed ?? 0} reviewed</span>
              <label className="ml-auto flex items-center gap-1 text-xs">Result filter
                <select className={cn} value={filter} onChange={e => { const next=e.target.value; setFilter(next); void matchingDatasetPage(run.runId,0,PAGE_SIZE,next).then(loaded => {setRows(loaded);setPage(0);setSelected(null);}).catch(e => setError(safeMessage(e))); }}>
                  <option value="all">All</option><option value="proposed">Proposed</option><option value="ambiguous">Ambiguous</option><option value="below_threshold">Below threshold</option><option value="unmatched">No candidates found</option><option value="confirm">Confirmed</option><option value="defer">Deferred</option><option value="reject">Rejected</option><option value="no_target">No target</option>
                </select>
              </label>
            </div>
          </div>
          <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
              <div className="min-h-0 flex-1 overflow-auto"><table className="w-full text-left text-xs"><thead className="sticky top-0 bg-slate-900"><tr><th className="p-2">LEFT identity</th><th className="p-2">Candidate RIGHT</th><th className="p-2">Score</th><th className="p-2">Candidates</th><th className="p-2">Status</th></tr></thead><tbody>{rows?.rows.map(row => <tr key={row.leftId} onClick={() => void chooseRow(row)} className={`cursor-pointer border-t border-slate-800 hover:bg-slate-800 ${selected?.leftId === row.leftId ? "bg-slate-800" : ""}`}><td className="p-2">{displayTuple(row.mapKey)}</td><td className="p-2">{displayTuple(row.outputs)}</td><td className="p-2">{row.score == null ? "—" : row.score.toFixed(3)}</td><td className="p-2">{row.alternatives}</td><td className="p-2">{row.state === "below_threshold" ? "Candidates below threshold" : row.state === "unmatched" ? "No candidates found" : row.state === "ambiguous" ? "Ambiguous candidates" : row.state}</td></tr>)}</tbody></table></div>
              <div className="flex shrink-0 items-center justify-between border-t border-slate-700 p-2 text-xs"><span>Rows {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, rows?.total ?? 0)} / {rows?.total ?? 0}</span><div className="flex gap-2"><button className={btn} disabled={page === 0 || working} onClick={() => void reload(run, page - 1)}>Previous</button><button className={btn} disabled={!rows || (page + 1) * PAGE_SIZE >= rows.total || working} onClick={() => void reload(run, page + 1)}>Next</button></div></div>
            </div>
            {selected && <aside className="w-[300px] shrink-0 overflow-y-auto border-l border-slate-700 p-3 text-xs"><h3 className="font-semibold text-teal-200">Review LEFT #{selected.leftId}</h3><p className="my-2 break-all text-slate-400">{displayTuple(selected.mapKey)}</p><div className="mb-3 flex flex-wrap gap-1"><button className={btn} disabled={working} onClick={() => void decide("defer")}>Defer</button><button className={btn} disabled={working} onClick={() => void decide("reject")}>Reject</button><button className={btn} disabled={working} onClick={() => void decide("no_target")}>No suitable RIGHT</button></div><h4 className="mb-1 text-slate-400">Verified candidate list</h4>{candidatePage?.rows.map(row => <div className="mb-2 rounded border border-slate-700 p-2" key={row.rightId}><div>{displayTuple(row.targetIdentity)}</div><div className="text-slate-400">{displayTuple(row.outputs)} · {row.score?.toFixed(3)}</div><button className={`${btn} mt-1 text-teal-200`} disabled={working || row.rightId == null} onClick={() => void decide("confirm", row.rightId ?? undefined)}>Confirm this pair</button></div>)}<div className="flex gap-2"><button className={btn} disabled={candidateIndex === 0} onClick={() => void nextCandidates(candidateIndex - 1)}>Back</button><button className={btn} disabled={!candidatePage || (candidateIndex + 1) * PAGE_SIZE >= candidatePage.total} onClick={() => void nextCandidates(candidateIndex + 1)}>More</button></div></aside>}
          </div>
          {onStageToMapping && <div className="flex shrink-0 items-center gap-2 border-t border-slate-700 p-2 text-xs"><span>Stage confirmed pairs into existing Mapping draft:</span><select className={cn} aria-label="Target Mapping" value={mapId} onChange={e => setMapId(e.target.value)}><option value="">Select Mapping</option>{mapOptions.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select><button className={btn} disabled={!mapId || !stats?.confirmed || working} onClick={() => void stage()}>Stage into Mapping editor</button><span className="text-slate-500">Review, Save and Apply remain separate.</span></div>}
        </>}
      </main>
    </div>
  </section>;
}
