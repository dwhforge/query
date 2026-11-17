import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConnectionDef, SourceDef, Workspace } from "../../types/pipeline";
import { suggestSharedDescriptiveField } from "../../app/matching/attributeSuggestions";
import {
  describeWorkspace,
  matchingDatasetEstimate, matchingDatasetEvaluate, matchingDatasetPage,
  matchingDatasetCandidates, matchingDatasetDrop, matchingDatasetDecide,
  matchingDatasetConfirmClear, matchingDatasetReviewStats, matchingDatasetCompare,
  matchingProgressSave, matchingProgressList, matchingProgressRestore,
  matchingDatasetPublicationHistory, type MatchingPublicationHistoryRow,
  type DatasetMatchingRequest, type DatasetMatchingRun, type DatasetMatchingEstimate,
  type DatasetMatchingPage, type DatasetMatchRow, type DatasetReviewStats,
  type DatasetMatchingComparison, type MatchingProgressSummary, type MatchingCheckpoint,
  type ProjectRefContext,
} from "../../lib/bridge";

type FieldRule = { sourceField: string; targetField: string; role: "hard_constraint" | "soft_signal" | "reference_context" };
type Props = {
  workspace: Workspace;
  connections: ConnectionDef[];
  sources: SourceDef[];
  projectRef: ProjectRefContext;
  onSaveMapping?: (args: { runId: string; targetMapId: string | null; newMapName: string | null;
    plan: DatasetMatchingRequest["plan"] }) => Promise<{ mapId: string; mapName: string; count: number; destination: string; message: string }>;
  mapOptions?: { id: string; name: string; kind?: string; fromArity: number; outputArity: number }[];
  onOpenSavedMap?: (mapId: string) => void;
  onSaveProject?: () => void;
  onPublishSource?: (runId: string, mapId: string, maxBatches: number) => Promise<{
    eligible: number; newlyPublished: number; previouslyPublished: number; rowsWritten: number; complete: boolean;
  }>;
  /** Original JOIN binding is preserved while comparisons may be edited. */
  initialPlan?: DatasetMatchingRequest["plan"];
  lockedBindings?: { sourceRef: string; targetRef: string; mapKeyFields: string[]; outputs: string[] };
  initialMapId?: string;
  /** Run the initial JOIN-bound Matching plan automatically on first opening. */
  autoEvaluate?: boolean;
  /** Hidden tabs must never begin evaluation. */
  active?: boolean;
  /** Show exercise instructions only in an active Help Lab workflow. */
  showLabGuide?: boolean;
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
export function DatasetMatchingWorkspace({ workspace, connections, sources, projectRef, mapOptions = [], onSaveMapping, onPublishSource, onOpenSavedMap, onSaveProject, initialPlan, lockedBindings, initialMapId, autoEvaluate = false, active = true, showLabGuide = false }: Props) {
  const queries = workspace.queries ?? [];
  const [left, setLeft] = useState(initialPlan?.sourceRef ?? queries[0]?.id ?? "");
  const [right, setRight] = useState(initialPlan?.targetRef ?? queries[1]?.id ?? "");
  const [leftColumns, setLeftColumns] = useState<string[]>([]);
  const [rightColumns, setRightColumns] = useState<string[]>([]);
  const [mapKeys, setMapKeys] = useState((initialPlan?.mapKeyFields ?? []).join(", "));
  const [targetKeys, setTargetKeys] = useState((initialPlan?.targetIdentityFields ?? []).join(", "));
  const [outputs, setOutputs] = useState((initialPlan?.outputs ?? []).join(", "));
  const [comparisons, setComparisons] = useState<FieldRule[]>(initialPlan?.comparisons.map(c => ({ ...c })) ?? [{ ...INITIAL_RULE }]);
  const [sample, setSample] = useState(5);
  const [rightSample, setRightSample] = useState(100);
  const [maxPairs, setMaxPairs] = useState(2_000_000);
  const [score, setScore] = useState(0.70);
  const [estimate, setEstimate] = useState<DatasetMatchingEstimate | null>(null);
  const [run, setRun] = useState<DatasetMatchingRun | null>(null);
  const [previousRun, setPreviousRun] = useState<DatasetMatchingRun | null>(null);
  const [comparison, setComparison] = useState<DatasetMatchingComparison | null>(null);
  const [evaluatedPlan, setEvaluatedPlan] = useState<DatasetMatchingRequest["plan"] | null>(null);
  const [evaluatedFingerprint, setEvaluatedFingerprint] = useState<string | null>(null);
  const liveRuns = useRef<string[]>([]);
  const autoEvaluationStarted = useRef(false);
  const [reviewControlsOpen, setReviewControlsOpen] = useState(false);
  const candidateFetchEpoch = useRef(0);
  const [savingNewMap, setSavingNewMap] = useState(false);
  const [newMapName, setNewMapName] = useState("");
  const [saved, setSaved] = useState<{ mapId: string; mapName: string; count: number; destination: string; message: string } | null>(null);
  useEffect(() => () => { for (const id of liveRuns.current) void matchingDatasetDrop(id).catch(() => undefined); }, []);
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState("all");
  const [rows, setRows] = useState<DatasetMatchingPage | null>(null);
  const [selected, setSelected] = useState<DatasetMatchRow | null>(null);
  const [candidatePage, setCandidatePage] = useState<DatasetMatchingPage | null>(null);
  const [candidateIndex, setCandidateIndex] = useState(0);
  const [stats, setStats] = useState<DatasetReviewStats | null>(null);
  const [mapId, setMapId] = useState(initialMapId ?? "");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [taskSlot, setTaskSlot] = useState("matching_review");
  const [progressRevision, setProgressRevision] = useState<string | null>(null);
  const [taskLabel, setTaskLabel] = useState("Matching review");
  const [savedTasks, setSavedTasks] = useState<MatchingProgressSummary[]>([]);
  const [resumeSlot, setResumeSlot] = useState("");
  const [publishedCount, setPublishedCount] = useState(0);
  const [publicationHistory, setPublicationHistory] = useState<MatchingPublicationHistoryRow[]>([]);
  const [reviewFinished, setReviewFinished] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const continuePublish = useRef(true);
  const selectedMapOption = mapOptions.find(m => m.id === mapId);
  const sourceMap = selectedMapOption?.kind === "source";

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

  const attributeSuggestion = useMemo(() => suggestSharedDescriptiveField(leftColumns, rightColumns), [leftColumns, rightColumns]);
  const reconLab = left === "dirty_recon" && right === "dim_product";
  const nameLab = left === "dirty_by_id" && right === "erp_products";
  const regionLab = left === "dirty_exact_pair";
  const identityOnlyScoring = comparisons.some(c => c.role === "soft_signal" &&
    textList(mapKeys).includes(c.sourceField) && textList(outputs).includes(c.targetField));

  const plan = useMemo<DatasetMatchingRequest["plan"]>(() => ({
    sourceRef: left,
    targetRef: right,
    mapKeyFields: textList(mapKeys),
    targetIdentityFields: textList(targetKeys),
    outputs: textList(outputs),
    comparisons,
    normalization: initialPlan?.normalization ?? ["trim", "casefold"],
    ambiguity: initialPlan?.ambiguity ?? "leave_for_manual",
    scope: "full",
    semanticRevision: initialPlan?.semanticRevision ?? 1,
    uiRevision: initialPlan?.uiRevision ?? 0,
  }), [left, right, mapKeys, targetKeys, outputs, comparisons]);

  const request = useMemo<DatasetMatchingRequest>(() => ({
    plan, samplePercent: sample, rightSamplePercent: rightSample, maxCandidatePairs: maxPairs, minimumScore: score,
  }), [plan, sample, rightSample, maxPairs, score]);
  const bindingsValid = !lockedBindings || (left === lockedBindings.sourceRef && right === lockedBindings.targetRef &&
    JSON.stringify(plan.mapKeyFields) === JSON.stringify(lockedBindings.mapKeyFields) &&
    JSON.stringify(plan.outputs) === JSON.stringify(lockedBindings.outputs));
  const valid = Boolean(bindingsValid && left && right && (left !== right || !!lockedBindings) && plan.mapKeyFields.length && plan.targetIdentityFields.length && plan.outputs.length &&
    comparisons.length && comparisons.every(c => c.sourceField && c.targetField) &&
    comparisons.some(c => c.role !== "reference_context") && Number.isInteger(sample) && sample >= 1 && sample <= 100 && Number.isInteger(rightSample) && rightSample >= 1 && rightSample <= 100 &&
    Number.isFinite(score) && score >= 0 && score <= 1 && maxPairs > 0);
  // Sampling settings intentionally do not participate in this fingerprint.
  // Rules, scoring threshold and project input definitions do. A staged Mapping
  // must never be derived from evidence acquired for superseded inputs.
  const evaluationFingerprint = useMemo(() => JSON.stringify([plan, score, workspace.queries, connections, sources,
    projectRef.projectFile, projectRef.projectUid, projectRef.references, projectRef.connectionBindings]),
    [plan, score, workspace.queries, connections, sources, projectRef.projectFile, projectRef.projectUid,
      projectRef.references, projectRef.connectionBindings]);
  const runCurrent = !!run && evaluatedFingerprint === evaluationFingerprint;
  // Preserve the target Mapping's existing relation schema; do not silently reshape it.
  const saveShape = evaluatedPlan ?? plan;
  const selectedMapCompatible = !selectedMapOption ||
    (selectedMapOption.fromArity === saveShape.mapKeyFields.length &&
     selectedMapOption.outputArity === saveShape.outputs.length);
  const eligibleBulk = (run?.proposedSources ?? 0) > 0;
  useEffect(() => {
    if (!selected) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { candidateFetchEpoch.current++; setSelected(null); setCandidatePage(null); }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [selected]);
  const editRule = (idx: number, next: Partial<FieldRule>) => setComparisons(before => before.map((r, i) => i === idx ? { ...r, ...next } : r));

  const reload = useCallback(async (active: DatasetMatchingRun, index: number) => {
    const loaded = await matchingDatasetPage(active.runId, index, PAGE_SIZE, filter);
    setRows(loaded);
    setPage(index);
    setStats(await matchingDatasetReviewStats(active.runId));
  }, [filter]);
  async function execute(kind: "estimate" | "evaluate") {
    if (!valid || working || publishing) return;
    setWorking(true); setError(null); setMessage("");
    try {
      if (kind === "estimate") {
        setEstimate(await matchingDatasetEstimate(workspace, connections, sources, projectRef, request));
      } else {
        // A new Evaluate is a new Review. Preserve any reviewed decisions
        // before replacing the active run; a failed checkpoint aborts the action.
        if (run && (stats?.reviewed ?? 0) > 0) {
          if (!progressLocation) throw new Error("Your current Evaluation has reviewed decisions. Save the project file first, then Evaluate again: the old Review must be checkpointed before it can be replaced.");
          if (!evaluatedPlan || !evaluatedFingerprint) throw new Error("Previous Review has no evaluation identity; refusing to replace reviewed decisions.");
          const preserved = await matchingProgressSave({ ...progressLocation, run,
            slot: taskSlot, label: taskLabel,
            plan: { matchingPlan: evaluatedPlan, inputFingerprint: evaluatedFingerprint, targetMapId: mapId },
            finished: reviewFinished, expectedRevision: progressRevision });
          setProgressRevision(preserved.revision);
          await reloadTasks();
        }
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
        setEvaluatedFingerprint(evaluationFingerprint);
        setRun(next); setReviewFinished(false); setSelected(null); setCandidatePage(null);
        setTaskSlot(`matching_${Date.now().toString(36)}_${next.runId}`);
        setProgressRevision(null);
        setTaskLabel(`${left} → ${right}`);
        setPublicationHistory([]); setPublishedCount(0); setSaved(null); candidateFetchEpoch.current++;
        await reload(next, 0);
        if (run && (stats?.reviewed ?? 0) > 0) {
          setMessage("Previous Review saved as a resumable task before re-evaluation. New run starts with no decisions; use Resume to return to your earlier work.");
        }
      }
    } catch (e) { setError(safeMessage(e)); }
    finally { setWorking(false); }
  }
  // Do not auto-evaluate a second time on tab reactivation, plan edits or
  // after an evaluation failure. Manual Evaluate remains available for retry.
  // Incomplete plans do not initiate a Host request.
  useEffect(() => {
    if (!autoEvaluate || !active || !initialPlan || !lockedBindings || !valid || autoEvaluationStarted.current) return;
    autoEvaluationStarted.current = true;
    void execute("evaluate");
  }, [autoEvaluate, active, valid, initialPlan, lockedBindings]);

  function closeDetails() {
    candidateFetchEpoch.current++;
    setSelected(null); setCandidatePage(null);
  }
  async function chooseRow(row: DatasetMatchRow) {
    if (selected?.leftId === row.leftId) { closeDetails(); return; }
    const requestEpoch = ++candidateFetchEpoch.current;
    setSelected(row); setCandidateIndex(0); setCandidatePage(null); setError(null);
    if (!run) return;
    try {
      const response = await matchingDatasetCandidates(run.runId, row.leftId, 0, PAGE_SIZE);
      if (candidateFetchEpoch.current === requestEpoch) setCandidatePage(response);
    } catch (e) { if (candidateFetchEpoch.current === requestEpoch) setError(safeMessage(e)); }
  }
  async function nextCandidates(index: number) {
    if (!run || !selected) return;
    try { setCandidatePage(await matchingDatasetCandidates(run.runId, selected.leftId, index, PAGE_SIZE)); setCandidateIndex(index); }
    catch (e) { setError(safeMessage(e)); }
  }
  async function decide(action: "confirm" | "reject" | "defer" | "no_target", target?: number) {
    if (!run || !runCurrent || !selected || working || publishing || reviewFinished) return;
    setWorking(true); setError(null);
    try {
      const updated = await matchingDatasetDecide({ runId: run.runId, leftId: selected.leftId, rightId: action === "confirm" ? target : null, action });
      setStats(updated); await reload(run, page); setSaved(null);
      const fresh = await matchingDatasetPage(run.runId, page, PAGE_SIZE, filter);
      setSelected(fresh.rows.find(row => row.leftId === selected.leftId) ?? null);
      setMessage(`Reviewed ${updated.reviewed} Mapping keys; ${updated.confirmed} confirmed in this evaluation. Nothing saved to Mapping yet.`);
    } catch (e) { setError(safeMessage(e)); }
    finally { setWorking(false); }
  }
  // One-click review of the highest-scored candidate visible in the grid.
  // The Host still validates candidate membership and materializes RIGHT outputs;
  // this is a review decision, never a Mapping write.
  async function confirmBest(row: DatasetMatchRow) {
    if (!run || !runCurrent || working || publishing || reviewFinished || row.rightId == null ||
        !["proposed", "ambiguous", "below_threshold"].includes(row.state)) return;
    setWorking(true); setError(null);
    try {
      const updated = await matchingDatasetDecide({
        runId: run.runId, leftId: row.leftId, rightId: row.rightId, action: "confirm",
      });
      const refreshed = await matchingDatasetPage(run.runId, page, PAGE_SIZE, filter);
      setRows(refreshed);
      setStats(updated);
      setSaved(null);
      if (selected?.leftId === row.leftId) {
        setSelected(refreshed.rows.find(item => item.leftId === row.leftId) ?? null);
      }
      setMessage(`Confirmed ${displayTuple(row.mapKey)} → ${displayTuple(row.targetIdentity)} in Review (${updated.confirmed} confirmed). Save Mapping separately to persist.`);
    } catch (e) { setError(safeMessage(e)); }
    finally { setWorking(false); }
  }
  async function confirmClear() {
    if (!run || !runCurrent || working || reviewFinished || !eligibleBulk) return;
    setWorking(true); setError(null);
    try {
      const before = stats?.confirmed ?? 0;
      const updated = await matchingDatasetConfirmClear(run.runId);
      setStats(updated); await reload(run, page); setSaved(null);
      const gained = Math.max(0, updated.confirmed - before);
      setMessage(gained > 0
        ? `Confirmed ${gained} new unambiguous Mapping keys (${updated.confirmed} total). Save Mapping to persist these decisions.`
        : "No additional unambiguous proposals are eligible. Below-threshold candidates require individual review.");
    } catch (e) { setError(safeMessage(e)); }
    finally { setWorking(false); }
  }
  async function saveMapping() {
    if (!run || !runCurrent || !onSaveMapping || !evaluatedPlan || !stats?.confirmed || working) return;
    const name = newMapName.trim();
    if (savingNewMap && !name) { setError("Enter a name for the new Mapping."); return; }
    if (!savingNewMap && !mapId) { setError("Select an existing Mapping or choose Create new Mapping."); return; }
    if (!savingNewMap && !selectedMapCompatible) { setError("Selected Mapping has an incompatible key/output shape. Choose a compatible Mapping or create a new seed Mapping."); return; }
    const targetMapId = savingNewMap ? null : mapId;
    const destination = targetMapId ? mapOptions.find(m => m.id === targetMapId)?.name ?? targetMapId : name;
    if (!window.confirm(`Save ${stats.confirmed} explicitly confirmed mappings to ${destination}? Existing non-empty values will not be overwritten. Source Mapping may write to its database table.`)) return;
    setWorking(true); setError(null);
    try {
      const receipt = await onSaveMapping({ runId: run.runId, targetMapId, newMapName: savingNewMap ? name : null, plan: evaluatedPlan });
      setSaved(receipt); setMessage(receipt.message);
      setMapId(receipt.mapId); setSavingNewMap(false); setNewMapName("");
    } catch (e) { setError(safeMessage(e)); }
    finally { setWorking(false); }
  }

  const progressLocation = projectRef.projectFile && projectRef.projectUid
    ? { projectFile: projectRef.projectFile, projectUid: projectRef.projectUid } : null;
  const reloadTasks = useCallback(async () => {
    if (!progressLocation) return;
    const tasks = await matchingProgressList(progressLocation);
    setSavedTasks(tasks);
  }, [projectRef.projectFile, projectRef.projectUid]);
  useEffect(() => { void reloadTasks().catch(() => undefined); }, [reloadTasks]);

  async function saveProgress(finished = false) {
    // Allow preserving previously reviewed evidence even after moving/saving the
    // project makes the evaluation stale. Stale evidence stays non-publishable.
    if (!run || !progressLocation || working || publishing) return;
    setWorking(true); setError(null);
    try {
      if (finished && !runCurrent) throw new Error("Cannot Finish Review using stale input definitions; Save Progress is still available.");
      if (finished && ((stats?.reviewed ?? 0) < run.leftTotal || (stats?.deferred ?? 0) > 0)) throw new Error("Finish Review requires decisions for all LEFT Mapping keys with no deferred rows; Save Progress does not.");
      const checkpoint = await matchingProgressSave({ ...progressLocation, run, slot: taskSlot, label: taskLabel,
        plan: { matchingPlan: evaluatedPlan ?? plan, inputFingerprint: evaluatedFingerprint, targetMapId: mapId }, finished: finished || reviewFinished,
        expectedRevision: progressRevision });
      setProgressRevision(checkpoint.revision);
      if (finished) setReviewFinished(true);
      setMessage(`${finished ? "Review finished" : "Progress saved"}: ${checkpoint.reviewed}/${checkpoint.run.leftTotal} decisions. ${runCurrent ? "" : "This Evaluation is stale and read-only until re-evaluated. "}Transfer the project file and its sibling .matching directory for handoff.`);
      await reloadTasks();
    } catch (e) { setError(safeMessage(e)); }
    finally { setWorking(false); }
  }
  async function resumeProgress() {
    if (!progressLocation || !resumeSlot || working || publishing) return;
    setWorking(true); setError(null);
    try {
      // Never abandon another in-progress Review when opening a saved task.
      if (run && (stats?.reviewed ?? 0) > 0) {
        if (!evaluatedPlan || !evaluatedFingerprint) throw new Error("Current Review has no evaluation identity; refusing to replace reviewed decisions.");
        const preserved = await matchingProgressSave({ ...progressLocation, run,
          slot: taskSlot, label: taskLabel,
          plan: { matchingPlan: evaluatedPlan, inputFingerprint: evaluatedFingerprint, targetMapId: mapId },
          finished: reviewFinished, expectedRevision: progressRevision });
        setProgressRevision(preserved.revision);
      }
      const snapshot: MatchingCheckpoint = await matchingProgressRestore({ ...progressLocation, slot: resumeSlot });
      const stored = snapshot.plan.matchingPlan;
      if (!stored || !snapshot.plan.inputFingerprint) throw new Error("Checkpoint missing its Matching plan or input fingerprint.");
      setLeft(stored.sourceRef); setRight(stored.targetRef);
      setMapKeys(stored.mapKeyFields.join(", ")); setTargetKeys(stored.targetIdentityFields.join(", "));
      setOutputs(stored.outputs.join(", ")); setComparisons(stored.comparisons.map(c => ({ ...c })));
      setScore(snapshot.run.minimumScore);
      setEvaluatedPlan(stored); setEvaluatedFingerprint(snapshot.plan.inputFingerprint);
      liveRuns.current.push(snapshot.run.runId);
      setRun(snapshot.run); setSelected(null); setCandidatePage(null); setCandidateIndex(0);
      setPreviousRun(null); setComparison(null); setEstimate(null); setSaved(null);
      setFilter("all");
      const page = await matchingDatasetPage(snapshot.run.runId, 0, PAGE_SIZE, "all");
      setRows(page); setPage(0);
      setStats(await matchingDatasetReviewStats(snapshot.run.runId));
      setTaskSlot(resumeSlot); setTaskLabel(snapshot.label); setReviewFinished(snapshot.finished);
      setMapId(snapshot.plan.targetMapId ?? "");
      setProgressRevision(snapshot.revision);
      setPublicationHistory(await matchingDatasetPublicationHistory(snapshot.run.runId));
      setMessage(`Resumed '${snapshot.label}': ${snapshot.reviewed} decisions restored. Verify current source/Mapping context before publishing.`);
    } catch (e) { setError(safeMessage(e)); }
    finally { setWorking(false); }
  }
  async function publishSource() {
    if (!run || !runCurrent || !sourceMap || !mapId || !onPublishSource || publishing || working) return;
    if (!selectedMapCompatible) { setError("Selected source Mapping has an incompatible key/output shape; publication refused."); return; }
    if (!progressLocation) { setError("Save the project file first: durable publication needs a checkpoint and journal."); return; }
    continuePublish.current = true;
    setPublishing(true); setError(null);
    let total = 0;
    let revision = progressRevision;
    const savePublicationState = async () => {
      const snapshot = await matchingProgressSave({ ...progressLocation, run, slot: taskSlot, label: taskLabel,
        plan: { matchingPlan: evaluatedPlan ?? plan, inputFingerprint: evaluatedFingerprint, targetMapId: mapId },
        finished: reviewFinished, expectedRevision: revision });
      revision = snapshot.revision;
      setProgressRevision(revision);
    };
    try {
      // Persist the reviewed snapshot BEFORE the first external write. If the
      // app crashes between PostgreSQL commit and ledger checkpoint, the task
      // still resumes and source equality makes the retry idempotent.
      await savePublicationState();
      for (;;) {
        if (!continuePublish.current) break;
        // Entire publication RPC contains no approved pairs, only progress metrics.
        // Host processes up to 25 x 200 rows per call, journaling each success.
        const result = await onPublishSource(run.runId, mapId, 25);
        total += result.newlyPublished;
        setPublishedCount(result.previouslyPublished + result.newlyPublished);
        setPublicationHistory(await matchingDatasetPublicationHistory(run.runId));
        setMessage(`${result.previouslyPublished + result.newlyPublished}/${result.eligible} confirmed keys published to source Mapping. ${result.rowsWritten} source rows changed in this RPC.`);
        // Keep each RPC bounded; do not re-export millions of scored pairs
        // after every 5,000 published rows. The initial checkpoint ensures a
        // crash can be resumed idempotently even before the final checkpoint.
        if (result.complete) { onOpenSavedMap?.(mapId); break; }
        if (result.newlyPublished === 0) break;
      }
      await savePublicationState(); // one final snapshot, not O(number of batches) copies
      await reloadTasks();
    } catch (e) {
      if (revision) {
        try { await savePublicationState(); } catch { /* initial checkpoint is recoverable */ }
      }
      setError(`Publication stopped after ${total} new acknowledgements in this action: ${safeMessage(e)}. Previously committed batches remain in the source table; retry safely.`); }
    finally { setPublishing(false); }
  }

  const cn = "rounded border border-slate-600 bg-slate-900/70 px-2 py-1 text-xs text-slate-100";
  const btn = "rounded border border-slate-600 px-3 py-1.5 text-xs hover:bg-slate-800 disabled:opacity-40";
  return <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#0a111a] text-slate-200">
    <header className="shrink-0 border-b border-slate-700 px-4 py-3">
      <h2 className="text-base font-semibold text-teal-100">Matching <span className="ml-2 text-xs font-normal text-slate-400">{lockedBindings ? "Original pre-JOIN LEFT → RIGHT · full scope" : "Dataset → Dataset · full scope"}</span></h2>
      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2 text-xs" aria-label="Matching progress controls">
        <span className="min-w-0 truncate text-slate-400">{working ? "Evaluating or updating review…" : run ? `${stats?.reviewed ?? 0} / ${run.leftTotal} reviewed` : "Ready to evaluate"}</span>
        <button type="button" data-testid="matching-save-progress" className={btn} disabled={!progressLocation || !run || working || publishing} onClick={() => void saveProgress()}>Save review</button>
        <button type="button" className={btn} disabled={!runCurrent || working || publishing || reviewFinished || !run || (stats?.reviewed ?? 0) !== run.leftTotal || (stats?.deferred ?? 0) > 0} onClick={() => void saveProgress(true)}>Finish review</button>
        <button type="button" className={`${btn} ml-auto`} aria-expanded={reviewControlsOpen} aria-controls="matching-review-controls" onClick={() => setReviewControlsOpen(x => !x)}>Saved reviews {reviewControlsOpen ? "▴" : "▾"}</button>
      </div>
      {!progressLocation && <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2 text-xs text-amber-300">
        <span>Save the project to enable review checkpoints.</span>
        {onSaveProject && <button type="button" className="shrink-0 rounded border border-amber-600 px-2 py-1 hover:bg-amber-900/30" onClick={onSaveProject}>Save project…</button>}
      </div>}
      {reviewControlsOpen && <div id="matching-review-controls" className="mt-2 flex min-w-0 flex-wrap items-center gap-2 rounded border border-slate-700 bg-slate-900/40 p-2 text-xs">
        <label className="flex min-w-0 flex-1 items-center gap-2">Review name<input aria-label="Matching task name" className={`${cn} min-w-0 flex-1`} value={taskLabel} onChange={e => setTaskLabel(e.target.value)} /></label>
        <select aria-label="Saved Matching tasks" className={`${cn} min-w-0 max-w-full flex-1`} value={resumeSlot} onChange={e => setResumeSlot(e.target.value)}><option value="">Choose saved review…</option>{savedTasks.map(task => <option key={task.slot} value={task.slot}>{task.label} ({task.reviewed}/{task.leftTotal})</option>)}</select>
        <button type="button" className={`${btn} shrink-0`} disabled={!resumeSlot || !progressLocation || working || publishing} onClick={() => void resumeProgress()}>Resume</button>
      </div>}
    </header>
    {showLabGuide && (reconLab || nameLab || regionLab) && <details className="shrink-0 border-b border-sky-900/60 bg-sky-950/20 px-4 py-2 text-xs text-sky-100" data-testid="matching-lab-guide">
      <summary className="cursor-pointer font-semibold">Help Lab · Matching workflow</summary>
      <p className="mt-1 text-sky-200/90">1. Save the project file before a long review (enables durable progress). 2. Check identity fields and matching rules. 3. Evaluate (automatic when opening from Join Lens). 4. Review and confirm only defensible pairs. 5. Save confirmed pairs to Mapping and Save Progress; Resume later if unfinished.</p>
      {reconLab && <p className="mt-1 text-amber-200">This lab's LEFT sales rows have only <code>commercial_sku</code>, not a product name; RIGHT has <code>product_name</code>. Code similarity is NOT evidence of product equivalence. Review candidates manually, or enrich LEFT with names before using name similarity. Do not lower the threshold merely to produce proposals.</p>}
      {nameLab && <p className="mt-1 text-sky-200">Both CRM and ERP catalogs provide <code>name</code>. Keep IDs as Mapping keys/outputs; compare product names as a soft signal before Evaluate.</p>}
      {regionLab && <p className="mt-1 text-sky-200">Region belongs to the Mapping key: same vendor name in US and DE can mean different entities. Preserve both fields, inspect ambiguities, save confirmed pairs, then verify the mapped mart and the original JOIN counts.</p>}
    </details>}
    <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[minmax(260px,320px)_minmax(0,1fr)]">
      <aside className="min-w-0 space-y-3 overflow-x-hidden overflow-y-auto border-b border-slate-700 p-3 text-xs lg:border-b-0 lg:border-r">
        <div className="font-semibold uppercase text-slate-400">Datasets &amp; identity</div>
        <label className="block">LEFT query<select aria-label="LEFT dataset" className={`mt-1 w-full ${cn}`} value={left} disabled={!!lockedBindings} onChange={e => setLeft(e.target.value)}>{queries.map(q => <option key={q.id} value={q.id}>{q.name || q.id}</option>)}</select></label>
        <label className="block">RIGHT query<select aria-label="RIGHT dataset" className={`mt-1 w-full ${cn}`} value={right} disabled={!!lockedBindings} onChange={e => setRight(e.target.value)}>{queries.map(q => <option key={q.id} value={q.id}>{q.name || q.id}</option>)}</select></label>
        <label className="block">LEFT Mapping keys (comma-separated)<input className={`mt-1 w-full ${cn}`} list="match-left-cols" disabled={!!lockedBindings} value={mapKeys} onChange={e => setMapKeys(e.target.value)} placeholder="e.g. product_code" /></label>
        <label className="block">RIGHT identity fields<input className={`mt-1 w-full ${cn}`} list="match-right-cols" value={targetKeys} onChange={e => setTargetKeys(e.target.value)} /></label>
        <label className="block">RIGHT output fields, in Mapping order<input className={`mt-1 w-full ${cn}`} list="match-right-cols" disabled={!!lockedBindings} value={outputs} onChange={e => setOutputs(e.target.value)} /></label>
        <datalist id="match-left-cols">{leftColumns.map(c => <option key={c} value={c} />)}</datalist>
        <datalist id="match-right-cols">{rightColumns.map(c => <option key={c} value={c} />)}</datalist>
        <div className="flex items-center justify-between"><strong className="uppercase text-slate-400">Rules</strong><button className={btn} type="button" onClick={() => setComparisons(cs => [...cs, { ...INITIAL_RULE }])}>+ Rule</button></div>
        <p className="text-slate-400">Identity fields form Mapping keys and outputs. Comparison fields provide matching evidence; they need not be keys.</p>
        {attributeSuggestion && <button type="button" className={`${btn} w-full border-teal-700 text-teal-200`} onClick={() => setComparisons([{ ...attributeSuggestion }])}
          title="Use the shared descriptive field for similarity while leaving Mapping identities and outputs unchanged">
          Compare by {attributeSuggestion.sourceField} ↔ {attributeSuggestion.targetField}
        </button>}
        {identityOnlyScoring && <div role="note" className="rounded border border-amber-800/70 bg-amber-950/25 p-2 text-amber-200">Current similarity compares Mapping identifiers. Similar strings are not proof of identical entities. Prefer descriptive evidence where available; otherwise review pairs manually.</div>}
        {comparisons.map((rule, i) => <div key={i} className="space-y-1 rounded border border-slate-700 p-2">
          <select aria-label={`LEFT field ${i + 1}`} className={`w-full ${cn}`} value={rule.sourceField} onChange={e => editRule(i, { sourceField: e.target.value })}><option value="">LEFT field</option>{leftColumns.map(f => <option key={f} value={f}>{f}</option>)}</select>
          <select aria-label={`RIGHT field ${i + 1}`} className={`w-full ${cn}`} value={rule.targetField} onChange={e => editRule(i, { targetField: e.target.value })}><option value="">RIGHT field</option>{rightColumns.map(f => <option key={f} value={f}>{f}</option>)}</select>
          <div className="flex gap-1"><select aria-label={`Role ${i + 1}`} className={`min-w-0 flex-1 ${cn}`} value={rule.role} onChange={e => editRule(i, { role: e.target.value as FieldRule["role"] })}><option value="hard_constraint">Hard constraint / blocking</option><option value="soft_signal">Similarity score</option><option value="reference_context">Context only</option></select><button className={btn} type="button" disabled={comparisons.length === 1} onClick={() => setComparisons(cs => cs.filter((_, j) => i !== j))}>×</button></div>
        </div>)}
        <div className="grid grid-cols-1 gap-2">
          <label>LEFT Estimate sample %<input aria-label="LEFT sample percent" className={`mt-1 w-full min-w-0 ${cn}`} type="number" min={1} max={100} value={sample} onChange={e => setSample(Number(e.target.value))} /></label>
          <label>RIGHT Estimate sample %<input aria-label="RIGHT sample percent" className={`mt-1 w-full min-w-0 ${cn}`} type="number" min={1} max={100} value={rightSample} onChange={e => setRightSample(Number(e.target.value))} /></label>
          <label>Minimum score<input className={`mt-1 w-full min-w-0 ${cn}`} type="number" min={0} max={1} step={0.05} value={score} onChange={e => setScore(Number(e.target.value))} /></label>
        </div>
        <label className="block">Maximum comparisons before refusal<input className={`mt-1 w-full min-w-0 ${cn}`} type="number" min={1} max={100000000} value={maxPairs} onChange={e => setMaxPairs(Number(e.target.value))} /></label>
        <div className="flex min-w-0 flex-wrap gap-2"><button className={btn} disabled={!valid || working} onClick={() => void execute("estimate")}>Estimate {sample}% LEFT / {rightSample}% RIGHT</button><button className={`${btn} border-teal-600 text-teal-200`} disabled={!valid || working} onClick={() => void execute("evaluate")}>Evaluate full scope</button></div>
        {estimate && <div className="rounded border border-amber-800 p-2 text-amber-200">Estimate cost only: {estimate.sampledLeft} / {estimate.leftTotal} LEFT Mapping keys and {estimate.sampledRight} / {estimate.rightTotal} RIGHT rows sampled. {estimate.sampledCandidatePairs.toLocaleString()} candidate pairs observed; ~{estimate.estimatedCandidatePairs.toLocaleString()} extrapolated. RIGHT sampling can miss true matches. No coverage claim.</div>}
      </aside>
      <main className="flex min-h-0 min-w-0 flex-col overflow-hidden">
        {error && <div role="alert" className="border-b border-red-800 bg-red-950 p-2 text-xs text-red-200">{error}</div>}
        {message && <div role="status" className="border-b border-teal-800 p-2 text-xs text-teal-200">{message}</div>}
        {run && run.conflictingSourceKeys > 0 && <div role="status" className="border-b border-amber-800 bg-amber-950/30 p-2 text-xs text-amber-200">{run.conflictingSourceKeys} Mapping keys have conflicting LEFT matching attributes. Their candidates remain inspectable but cannot be confirmed until source attributes are reconciled.</div>}
        {run && !runCurrent && <div role="alert" className="border-b border-amber-800 bg-amber-950/40 p-2 text-xs text-amber-200">Evaluation is stale: rules, scoring or input definitions changed. Re-evaluate before Review or staging to Mapping. Existing materialized evidence remains read-only for inspection.</div>}
        {!run ? <div className="m-auto max-w-lg p-8 text-center text-sm text-slate-500">{working ? "Evaluating full dataset…" : "Select identity and comparison rules, then Evaluate. UI previews cannot limit the requested scope."}</div> : <>
          <div className="shrink-0 border-b border-slate-700 p-3">
            <div className="flex flex-wrap gap-4 text-sm"><strong className="text-teal-200">{run.leftTotal.toLocaleString()} LEFT keys / {run.leftSourceRows.toLocaleString()} source rows</strong><span>{run.rightTotal.toLocaleString()} RIGHT</span><span>{run.proposedSources} proposed</span><span className="text-amber-300">{run.ambiguousSources} ambiguous</span><span className="text-amber-200">{run.belowThresholdSources} below threshold</span><span>{run.unmatchedSources} no candidates</span><span className="text-amber-300">{run.conflictingSourceKeys} source attribute conflicts</span><span>{run.candidatePairs} candidate pairs evaluated</span><span>{run.aboveThresholdPairs} pairs above threshold</span><span className="text-amber-200">{run.reusedTargets} reused RIGHT identities</span></div>
            <p className="mt-1 text-xs text-slate-500">Source coverage: {run.sourceCoverage}; candidate policy: {run.candidatePolicy}; exhaustive search: {run.candidateSearchExhaustive ? "yes" : "no (hard-constrained)"}. A/B counts are indicative without a shared transactional snapshot.</p>
            {previousRun && <div className="mt-1 text-xs text-slate-400">Previous run: {previousRun.proposedSources} proposed → {run.proposedSources}; {previousRun.ambiguousSources} ambiguous → {run.ambiguousSources}. Different source snapshots may invalidate comparison.</div>}
            {comparison && <div className="mt-1 text-xs text-amber-300">Indicative evaluation A/B: {comparison.commonKeys} shared keys · {comparison.changedTarget} changed target · {comparison.becameMatched} newly matched · {comparison.becameUnmatched} newly unmatched · {comparison.firstOnly}/{comparison.secondOnly} left/right-only keys · {comparison.changedScore} changed score · {comparison.changedStatus} changed classification · {comparison.changedCandidateCount} changed candidate count · {comparison.changedSourceRows} changed source-row count. Review decisions are not compared. Snapshot verified: no.</div>}
            <div className="mt-2 flex flex-wrap items-center gap-2"><button className={btn} disabled={working || reviewFinished || !runCurrent || !eligibleBulk} title={!eligibleBulk ? "No proposed matches above threshold; review below-threshold candidates individually" : "Confirm unreviewed eligible proposals across all result pages"} onClick={() => void confirmClear()}>Confirm unreviewed proposals (up to {run.proposedSources})</button><span className="text-xs">{stats?.confirmed ?? 0} confirmed · {stats?.reviewed ?? 0} reviewed</span>{!eligibleBulk && <span className="text-xs text-amber-300">No auto-eligible proposals; inspect candidates and confirm a pair manually.</span>}
              <label className="ml-auto flex items-center gap-1 text-xs">Result filter
                <select className={cn} value={filter} onChange={e => { const next=e.target.value; setFilter(next); void matchingDatasetPage(run.runId,0,PAGE_SIZE,next).then(loaded => {setRows(loaded);setPage(0);closeDetails();}).catch(e => setError(safeMessage(e))); }}>
                  <option value="all">All</option><option value="needs_review">Needs review</option><option value="proposed">Proposed</option><option value="ambiguous">Ambiguous</option><option value="below_threshold">Below threshold</option><option value="unmatched">No candidates found</option><option value="source_conflict">Source attributes conflict</option><option value="confirm">Confirmed</option><option value="defer">Deferred</option><option value="reject">Rejected</option><option value="no_target">No target</option>
                </select>
              </label>
            </div>
          </div>
          <div className="relative flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
              <div className="min-h-0 flex-1 overflow-auto"><table className="w-full text-left text-xs"><thead className="sticky top-0 bg-slate-900"><tr><th className="p-2">LEFT identity</th><th className="p-2" title="Highest-scored RIGHT candidate, or the manually confirmed RIGHT">Best / confirmed RIGHT</th><th className="p-2">Score</th><th className="p-2">Status</th><th className="p-2">Review</th></tr></thead><tbody>{rows?.rows.map(row => <tr key={row.leftId} onClick={() => void chooseRow(row)} aria-selected={selected?.leftId === row.leftId} className={`cursor-pointer border-t border-slate-800 hover:bg-slate-800 ${selected?.leftId === row.leftId ? "bg-slate-800" : ""}`}><td className="p-2">{displayTuple(row.mapKey)}<div className="text-[10px] text-slate-500">{row.sourceRows} source {row.sourceRows === 1 ? "row" : "rows"}</div></td><td className="p-2">{displayTuple(row.outputs)}</td><td className="p-2">{row.score == null ? "—" : row.score.toFixed(3)}</td><td className="p-2">{row.state === "below_threshold" ? "Candidates below threshold" : row.state === "unmatched" ? "No candidates found" : row.state === "ambiguous" ? "Ambiguous candidates" : row.state === "source_conflict" ? "Source attributes conflict" : row.state === "confirm" ? "Confirmed" : row.state === "defer" ? "Deferred" : row.state === "reject" ? "Rejected" : row.state === "no_target" ? "No suitable RIGHT" : row.state}</td><td className="p-2"><div className="flex items-center gap-1"><button type="button" data-testid={`matching-confirm-best-${row.leftId}`} className={`${btn} whitespace-nowrap border-teal-700 text-teal-200`} disabled={working || publishing || reviewFinished || !runCurrent || row.rightId == null || !["proposed", "ambiguous", "below_threshold"].includes(row.state)} title="Confirm the highest-scored candidate shown in this row (Review only; no Mapping write)" onClick={e => { e.stopPropagation(); void confirmBest(row); }}>Confirm best</button><button type="button" className={`${btn} whitespace-nowrap`} onClick={e => { e.stopPropagation(); void chooseRow(row); }} aria-label={`Review alternatives for ${displayTuple(row.mapKey)}`}>Details</button></div></td></tr>)}</tbody></table></div>
              <div className="flex shrink-0 items-center justify-between border-t border-slate-700 p-2 text-xs"><span>Rows {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, rows?.total ?? 0)} / {rows?.total ?? 0}</span><div className="flex gap-2"><button className={btn} disabled={page === 0 || working} onClick={() => void reload(run, page - 1)}>Previous</button><button className={btn} disabled={!rows || (page + 1) * PAGE_SIZE >= rows.total || working} onClick={() => void reload(run, page + 1)}>Next</button></div></div>
            </div>
            {selected && <><button type="button" aria-label="Close Matching details backdrop" className="absolute inset-0 z-10 bg-slate-950/25" onClick={closeDetails} /><aside role="dialog" aria-modal="false" aria-label="Matching candidate details" className="absolute inset-y-0 right-0 z-20 w-[min(420px,90%)] overflow-y-auto border-l border-slate-600 bg-[#101d2c] p-3 text-xs shadow-2xl"><div className="flex items-center justify-between gap-2"><h3 className="font-semibold text-teal-200">Review LEFT #{selected.leftId}</h3><button type="button" aria-label="Close Matching details" className={`${btn} text-base`} onClick={closeDetails}>×</button></div><p className="my-2 break-all text-slate-400">{displayTuple(selected.mapKey)}</p><div className="mb-3 flex flex-wrap gap-1"><button className={btn} disabled={working || reviewFinished || !runCurrent} onClick={() => void decide("defer")}>Defer</button><button className={btn} disabled={working || reviewFinished || !runCurrent} onClick={() => void decide("reject")}>Reject</button><button className={btn} disabled={working || reviewFinished || !runCurrent} onClick={() => void decide("no_target")}>No suitable RIGHT</button></div><h4 className="mb-1 text-slate-400">Verified candidate list</h4>{candidatePage?.rows.map(row => <div className="mb-2 rounded border border-slate-700 p-2" key={row.rightId}><div>{displayTuple(row.targetIdentity)}</div><div className="text-slate-400">{displayTuple(row.outputs)} · {row.score?.toFixed(3)}</div><button className={`${btn} mt-1 text-teal-200`} disabled={working || reviewFinished || !runCurrent || selected.state === "source_conflict" || row.rightId == null} onClick={() => void decide("confirm", row.rightId ?? undefined)}>Confirm this pair</button></div>)}<div className="flex gap-2"><button className={btn} disabled={candidateIndex === 0} onClick={() => void nextCandidates(candidateIndex - 1)}>Back</button><button className={btn} disabled={!candidatePage || (candidateIndex + 1) * PAGE_SIZE >= candidatePage.total} onClick={() => void nextCandidates(candidateIndex + 1)}>More</button></div></aside></>}
          </div>
          {onSaveMapping && <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-slate-700 bg-[#101b29] p-3 text-xs" data-testid="matching-save-panel">
            <strong className="text-teal-100">Save Mapping</strong>
            <select className={cn} aria-label="Target Mapping" value={savingNewMap ? "__new__" : mapId} onChange={e => { const next = e.target.value; setSavingNewMap(next === "__new__"); if (next !== "__new__") setMapId(next); }}>
              <option value="">Select existing Mapping</option>{mapOptions.map(m => <option key={m.id} value={m.id}>{m.name} ({m.fromArity} keys → {m.outputArity} outputs){m.fromArity !== saveShape.mapKeyFields.length || m.outputArity !== saveShape.outputs.length ? " · incompatible" : ""}</option>)}
              <option value="__new__">+ Create new seed Mapping…</option>
            </select>
            {savingNewMap && <input type="text" aria-label="New Mapping name" placeholder="Mapping name" className={cn} value={newMapName} onChange={e => setNewMapName(e.target.value)} />}
            {!savingNewMap && selectedMapOption && !selectedMapCompatible && <div role="alert" data-testid="matching-save-shape-warning" className="w-full rounded border border-amber-700 bg-amber-950/30 px-2 py-1 text-amber-200">Selected Mapping has {selectedMapOption.fromArity} LEFT key column(s) and {selectedMapOption.outputArity} RIGHT output column(s); this Evaluation needs {saveShape.mapKeyFields.length} LEFT key column(s) and {saveShape.outputs.length} RIGHT output column(s). Select a compatible Mapping or choose “+ Create new seed Mapping…”. Your confirmed decisions are preserved.</div>}
            <button type="button" data-testid="matching-save" className={`${btn} border-teal-500 bg-teal-900/30 font-semibold text-teal-100`} disabled={working || publishing || !runCurrent || !stats?.confirmed || (!savingNewMap && !selectedMapCompatible) || (sourceMap && !savingNewMap && !progressLocation) || (savingNewMap ? !newMapName.trim() : !mapId)} onClick={() => void (sourceMap && !savingNewMap ? publishSource() : saveMapping())}>{sourceMap && !savingNewMap ? `Publish Confirmed (${stats?.confirmed ?? 0})` : `Save Mapping (${stats?.confirmed ?? 0})`}</button>
            {publishing && <button type="button" className={btn} onClick={() => { continuePublish.current = false; }}>Stop after current batch</button>}
            {sourceMap && <span className="text-amber-200">{publishedCount} published so far. Each Source batch commits independently; retry resumes via Host ledger.</span>}
            <span className="text-slate-400">Seed: project Save (not yet streaming). Source: Host-side bounded publication. Review progress: Save Progress. Project file Save is separate.</span>
            {publicationHistory.length > 0 && <div className="w-full text-slate-400" aria-label="Publication history">
              Publication history: {publicationHistory.map(row => `${row.mapId}: ${row.publishedKeys} keys (last ${new Date(row.lastPublishedMs).toLocaleString()})`).join(" · ")}
            </div>}
            {saved && <p role="status" data-testid="matching-saved-receipt" className="w-full text-teal-200">Saved {saved.count} pairs to {saved.mapName} ({saved.destination}). Opened Mapping editor to inspect the result. Save the project file to make it durable on disk.</p>}
          </div>}
        </>}
      </main>
    </div>
  </section>;
}
