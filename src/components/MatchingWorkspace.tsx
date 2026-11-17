/**
 * Matching workspace tab (ADR-0044).
 * Plan editor → fixture/retrieval proposals → review → final diff → Save.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { MatchingSetView } from "./matching/MatchingSetView";
import type { SetEvaluation } from "../app/matching/setEvaluation";
import { llmChat, type MatchingJoinLookupResult, type MatchingLookupPage } from "../lib/bridge";
import { tupleCell } from "../lib/joinLensTuple";
import { basicPrompt, basicHighConfidenceIds, basicPlanCompatible } from "../app/matching/basic";
import {
  advancedPlanCompatible,
  advancedHighConfidenceIds,
  advancedRankAllowlist,
  invalidateRunOnPlanChange,
} from "../app/matching/advanced";
import type { TupleBatchPrompt } from "../lib/joinLensBatch";
import { BATCH_HIGH_CONFIDENCE_SCORE, BATCH_AMBIGUITY_GAP, parseSuggestedBatchTuplePairs } from "../lib/joinLensBatch";
import { undoMatchingBulk, confirmReviewedSelection, deriveMatchingReview, previewReviewedConfirm } from "../app/matching/reviewLogic";
import { FIXTURE_PLAN } from "../app/matching/fixtures";
import { buildLensMatchingPlan } from "../app/matching/planDefaults";
import {
  applyBulkConfirm,
  buildFinalDiff,
  filterProposals,
  matchingCounters,
  pageSlice,
  previewBulkConfirm,
  summarizeFinalDiff,
  type BulkConfirmScope,
} from "../app/matching/reviewLogic";
import {
  cascadeCounts,
  cascadeTierCounts,
} from "../app/matching/cascade";
import { applyLlmRankingToSession } from "../app/matching/llmRank";
import { MATCHING_CAPS } from "../lib/matchingCaps";
import {
  applyAllowlistToProposals,
  targetSnapshotFromSession,
  widenAllowlistWithLlmAliases,
} from "../app/matching/semanticExpand";
import { loadFixtureTrial } from "../app/matching/runTrial";
import { LIVE_TRIAL_UNAVAILABLE, matchingWriteRefusal } from "../app/matching/executionPolicy";
import type { MatchingSaveResult } from "../app/matching/persistSave";
import type {
  MatchingFieldRole,
  MatchingPlanDraft,
  MatchingProposalView,
  MatchingTabSession,
} from "../app/matching/types";
import { RelationshipInspector } from "./matching/RelationshipInspector";
import { suggestSharedDescriptiveField } from "../app/matching/attributeSuggestions";
import { LeftExplorer } from "./matching/LeftExplorer";
import { RightExplorer } from "./matching/RightExplorer";
import { nextUnresolved, buildRelationshipIndex, type MappingProjection } from "../app/matching/relationships";
import type { MatchingCandidateView } from "../app/matching/types";
import type { ExplainJoinKeyResult } from "../lib/bridge";

type Props = {
  session: MatchingTabSession;
  baseline?: MappingProjection;
  onInspectJoin?: (outputs: (string | null)[]) => Promise<ExplainJoinKeyResult>;
  onLookupAdvanced?: (proposalId: string, page: MatchingLookupPage) => Promise<MatchingJoinLookupResult>;
  onRunBasic?: (session: MatchingTabSession) => Promise<MatchingTabSession>;
  onMergeBasicLlm?: (runId: string, text: string, sent: TupleBatchPrompt) => void;
  onChange: (next: MatchingTabSession) => void;
  onOpenLens?: () => void;
  lensUnavailableReason?: string | null;
  onOpenDemo?: () => void;
  /** Persist upserts into the bound Mapping via existing Save path. */
  onSaveToMap?: (args: {
    session: MatchingTabSession;
  }) => Promise<MatchingSaveResult>;
  writeAllowed?: boolean;
  writeRefusalReason?: string | null;
};

const ROLE_OPTIONS: { value: MatchingFieldRole; label: string }[] = [
  { value: "hard_constraint", label: "Must be the same" },
  { value: "soft_signal", label: "Close enough" },
  { value: "reference_context", label: "Hint only" },
];

/** One-line role glossary in the plan editor (no docs needed). */
const ROLE_HINTS: Record<MatchingFieldRole, string> = {
  soft_signal:
    "Typos and other names are OK — used to score matches",
  hard_constraint:
    "Must match after trim/case — otherwise the candidate is dropped",
  reference_context:
    "Shown to you and the LLM (e.g. category) — not used to filter",
};

// stateLabel moved to LeftExplorer.tsx

function emptyPlan(session: MatchingTabSession): MatchingPlanDraft {
  if (session.plan) return session.plan;
  const ctx = session.lensCtx;
  if (ctx?.leftOn?.length || ctx?.rightOn?.length) {
    return buildLensMatchingPlan({
      leftOn: ctx.leftOn ?? [],
      rightOn: ctx.rightOn ?? [],
      sourceRef: ctx.leftSourceQueryId || ctx.hostQueryId,
      targetRef: ctx.rightQueryId,
      sourceColumns: ctx.sourceColumns,
      targetColumns: ctx.targetColumns,
      scope: session.scope,
    });
  }
  if (session.executionMode === "demo") return { ...FIXTURE_PLAN, scope: session.scope };
  return {
    sourceRef: "", targetRef: "", mapKeyFields: [], targetIdentityFields: [],
    comparisons: [], normalization: ["trim", "lower"], outputs: [],
    ambiguity: "leave_for_manual", scope: session.scope, semanticRevision: 1, uiRevision: 0,
  };
}

function FieldSelect({
  label,
  value,
  options,
  onChange,
  allowEmpty = false,
  multiHint,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
  allowEmpty?: boolean;
  multiHint?: string;
}) {
  const opts = useMemo(() => {
    const set = new Set(options.filter(Boolean));
    if (value.trim()) set.add(value);
    return [...set];
  }, [options, value]);
  const listId = `matching-opts-${label.replace(/\W+/g, "-")}`;
  return (
    <label className="text-[11px] text-slate-400">
      {label}
      {multiHint ? (
        <span className="ml-1 font-normal text-slate-600">({multiHint})</span>
      ) : null}
      {opts.length > 0 ? (
        <>
          <input
            list={listId}
            className="mt-0.5 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-[12px]"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={allowEmpty ? "—" : undefined}
          />
          <datalist id={listId}>
            {opts.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
        </>
      ) : (
        <input
          className="mt-0.5 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-[12px]"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </label>
  );
}

function MultiFieldSelect({
  label,
  values,
  options,
  onChange,
}: {
  label: string;
  values: string[];
  options: string[];
  onChange: (v: string[]) => void;
}) {
  const opts = useMemo(() => {
    const set = new Set(options.filter(Boolean));
    for (const v of values) if (v.trim()) set.add(v);
    return [...set];
  }, [options, values]);
  return (
    <fieldset className="text-[11px] text-slate-400">
      <legend className="mb-1">{label}</legend>
      {opts.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {opts.map((o) => {
            const on = values.includes(o);
            return (
              <label
                key={o}
                className={`inline-flex cursor-pointer items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[11px] ${
                  on
                    ? "border-teal-600/70 bg-teal-500/15 text-teal-50"
                    : "border-slate-700 text-slate-400"
                }`}
              >
                <input
                  type="checkbox"
                  className="accent-teal-500"
                  checked={on}
                  onChange={() => {
                    onChange(
                      on ? values.filter((x) => x !== o) : [...values, o],
                    );
                  }}
                />
                {o}
              </label>
            );
          })}
        </div>
      ) : (
        <input
          className="mt-0.5 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-[12px]"
          value={values.join(", ")}
          onChange={(e) =>
            onChange(
              e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            )
          }
          placeholder="col_a, col_b"
        />
      )}
    </fieldset>
  );
}

function planBlockers(plan: MatchingPlanDraft): string[] {
  const blockers: string[] = [];
  if (!plan.sourceRef.trim() || !plan.targetRef.trim()) {
    blockers.push("Set source and target");
  }
  if (!plan.mapKeyFields.length || plan.mapKeyFields.every((f) => !f.trim())) {
    blockers.push("Map key is missing");
  }
  if (
    !plan.targetIdentityFields.length ||
    plan.targetIdentityFields.every((f) => !f.trim())
  ) {
    blockers.push("Target identity is missing");
  }
  if (!plan.outputs.length || plan.outputs.every((o) => !o.trim())) {
    blockers.push("Outputs are empty or incompatible");
  }
  return blockers;
}

export function MatchingWorkspace({
  session,
  baseline,
  onInspectJoin,
  onRunBasic,
  onLookupAdvanced,
  onMergeBasicLlm,
  onChange,
  onOpenLens,
  lensUnavailableReason,
  onOpenDemo,
  onSaveToMap,
  writeAllowed = true,
  writeRefusalReason = null,
}: Props) {
  const reviewedProposals = useMemo(() => deriveMatchingReview(session).proposals,
    [session.proposals, session.decisions, session.plan?.semanticRevision, session.commitLifecycle, session.basicRun, session.advancedRun]);
  session = { ...session, proposals: reviewedProposals };
  const latestSession = useRef(session);
  latestSession.current = session;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const isBasic = !!session.joinBinding;
  const acknowledged = session.commitLifecycle?.status === "acknowledged" ? session.commitLifecycle.receipt : null;
  const [chatOpen, setChatOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [llmPhase, setLlmPhase] = useState<"idle" | "expand" | "rank">("idle");
  const [llmProgress, setLlmProgress] = useState<{
    percent: number;
    label: string;
    detail: string;
  } | null>(null);
  const llmAbortRef = useRef<AbortController | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bulkScope, setBulkScope] = useState<BulkConfirmScope>("filter");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [showFinal, setShowFinal] = useState(false);
  const [pinnedEvaluation, setPinnedEvaluation] = useState<SetEvaluation | null>(null);
  const [commitMsg, setCommitMsg] = useState<string | null>(null);
  const [showSavedContext, setShowSavedContext] = useState(true);
  const [rightFocus, setRightFocus] = useState<MatchingCandidateView | null>(null);
  // An inspected pair is not a confirmed decision. RIGHT-focused reverse browsing
  // remains a separate explicit action and never stages a Mapping decision.
  const [selectedRight, setSelectedRight] = useState<MatchingCandidateView | null>(null);
  const [actualJoinFacts, setActualJoinFacts] = useState<ExplainJoinKeyResult | null>(null);
  const [focusEpoch, setFocusEpoch] = useState(0);
  const baselineForExplorers: MappingProjection = baseline ?? { rows: [], complete: false, coverage: "Mapping baseline not acquired." };
  // Relationship index is rebuilt by the LeftExplorer (owned by the LEFT column).
  void buildRelationshipIndex;
  void baselineForExplorers;
  const [advanceAfterConfirm, setAdvanceAfterConfirm] = useState(false);
  function inspectRight(candidate: MatchingCandidateView | null) { setRightFocus(candidate); setActualJoinFacts(null); setFocusEpoch(e => e + 1); }
  function selectRight(candidate: MatchingCandidateView) {
    setSelectedRight(candidate);
    setRightFocus(null);
    setActualJoinFacts(null);
    setFocusEpoch(e => e + 1);
  }
  function returnToLeftReview() { setRightFocus(null); setActualJoinFacts(null); setFocusEpoch(e => e + 1); }
  function focusSource(id: string) { setRightFocus(null); setSelectedRight(null); setActualJoinFacts(null); setFocusEpoch(e => e + 1); onChange({ ...session, selectedProposalId: id }); }
  const [reviewSearch, setReviewSearch] = useState("");
  const [reviewSort, setReviewSort] = useState<"workflow" | "score">("workflow");

  const plan = emptyPlan(session);
  const isDemo = session.executionMode === "demo";
  /** ADR-0051: explicitly confirmed Advanced mode (disclosure alone never re-runs). */
  const isAdvancedConfirmed = isBasic && session.matchingMode === "advanced";
  /** Plan shape decides the producer: the Basic form keeps the Basic default;
   * a confirmed non-Basic plan with the original JOIN key/output shape runs Advanced. */
  const planRunsBasic = isBasic && basicPlanCompatible(session);
  const planRunsAdvanced = isBasic && !planRunsBasic && advancedPlanCompatible(session);
  const originRefusal = matchingWriteRefusal(session);
  const blockers = useMemo(() => planBlockers(plan), [plan]);
  const sourceCols = session.lensCtx?.sourceColumns ?? [];
  const targetCols = session.lensCtx?.targetColumns ?? [];
  const attributeSuggestion = suggestSharedDescriptiveField(sourceCols, targetCols);
  const queryOpts = session.queryOptions ?? [];
  const hasProposals = session.proposals.length > 0;
  const { resolvedDeterministic, residue } = useMemo(
    () => cascadeCounts(session.proposals),
    [session.proposals],
  );
  const tiers = useMemo(
    () => cascadeTierCounts(session.proposals),
    [session.proposals],
  );
  const llmTouched = session.proposals.some((p) => p.provenance === "llm");
  const llmGateHint = !hasProposals
    ? "Find matches first (step 1)"
    : !session.llmPermissionGranted
      ? "Open LLM rules → tick “allow sending fields”"
      : !session.instructionText.trim()
        ? "Open LLM rules → write how names/regions should match"
        : residue === 0
          ? `Nothing left for the model — ${resolvedDeterministic} key(s) already matched or saved`
          : null;
  const savedRows = useMemo(
    () => session.proposals.filter((p) => p.state === "saved"),
    [session.proposals],
  );
  const filtered = useMemo(() => {
    const query = reviewSearch.toLocaleLowerCase();
    const open = filterProposals(session.proposals, session.reviewFilter).filter(p =>
      !query || [...p.mapKey, ...Object.values(p.sourceValues ?? {})].some(v => tupleCell(v).toLocaleLowerCase().includes(query)));
    if (reviewSort === "score") {
      const score = (p: MatchingProposalView) => p.edges?.find(e => e.candidateId === p.proposedCandidateId)?.score ?? -1;
      open.sort((a, b) => score(b) - score(a));
    }
    if (
      showSavedContext &&
      session.reviewFilter !== "saved" &&
      session.reviewFilter !== "all" &&
      session.reviewFilter !== "confirmed" &&
      savedRows.length
    ) {
      const seen = new Set(open.map((p) => p.proposalId));
      return [...open, ...savedRows.filter((p) => !seen.has(p.proposalId) &&
        (!query || p.mapKey.some(v => tupleCell(v).toLocaleLowerCase().includes(query))))];
    }
    return open;
  }, [session.proposals, session.reviewFilter, showSavedContext, savedRows, reviewSearch, reviewSort]);
  const isReadyView = session.reviewFilter === "ready";
  const isSavedView = session.reviewFilter === "saved";
  const skipPaging = isReadyView || isSavedView || (showSavedContext && savedRows.length > 0 && session.reviewFilter !== "all");
  const pageIndex = Math.min(session.pageIndex, Math.max(0, Math.ceil(filtered.length / session.pageSize) - 1));
  // Ready / Saved / compare mode: one scroll so tiers aren't split across pages.
  const page = useMemo(
    () =>
      skipPaging
        ? filtered
        : pageSlice(filtered, pageIndex, session.pageSize),
    [filtered, skipPaging, pageIndex, session.pageSize],
  );
  const counters = matchingCounters(session);
  const pinned = session.proposals.find(p => p.proposalId === session.selectedProposalId) ?? (session.selectedProposalId ? null : page[0] ?? null);
  const selected = pinned?.state === "stale" && !page.some(p => p.proposalId === pinned.proposalId) ? null : pinned;
  const selectedHidden = !!selected && !page.some(p => p.proposalId === selected.proposalId);
  const sequenceIds = filtered.map(p => p.proposalId);
  function navigate(direction: 1 | -1) {
    const id = nextUnresolved(session, sequenceIds, selected?.proposalId ?? null, direction);
    if (id) focusSource(id);
  }
  function changeReview(next: MatchingTabSession) {
    const confirmedNow = next.decisions.some(d => (d.kind === "choose_alternative" || d.kind === "confirm_proposed") &&
      !session.decisions.some(old => old.proposalId === d.proposalId));
    if (advanceAfterConfirm && confirmedNow) {
      const id = nextUnresolved(next, sequenceIds, selected?.proposalId ?? null, 1);
      if (id) { next = { ...next, selectedProposalId: id }; setRightFocus(null); setSelectedRight(null); setFocusEpoch(e => e + 1); }
    }
    onChange(next);
  }
  useEffect(() => { setRightFocus(null); setSelectedRight(null); setFocusEpoch(e => e + 1); }, [session.basicRun?.id, session.advancedRun?.id, session.commitLifecycle]);
  const bulkPreview = previewBulkConfirm(session, "selection", bulkScope === "selection" ? selectedIds
    : (bulkScope === "page" ? page : filtered).map(p => p.proposalId));
  const reviewedPreview = previewReviewedConfirm(session, selectedIds);
  const finalDiff = useMemo(() => buildFinalDiff(baseline?.complete ? { ...session, mapBaseline: baseline.rows.map(r => ({
    fromParts: r.fromParts as string[], outputValues: r.outputValues as string[],
  })) } : session), [session, baseline]);
  const finalSum = summarizeFinalDiff(finalDiff);

  const scopeLabel =
    session.scope === "selected"
      ? "selected rows only"
      : session.scope === "cohort"
        ? "this group of rows (not the whole table)"
        : isBasic ? "Full input scope · bounded unmatched keys" : "all rows";

  function patchPlan(patch: Partial<MatchingPlanDraft>, semantic: boolean) {
    if (semantic && session.hasUnsavedDecisions && !window.confirm(
      "Changing the matching plan clears current suggestions and draft decisions. Continue?",
    )) return;
    const base = session.plan ?? plan;
    const next: MatchingPlanDraft = {
      ...base,
      ...patch,
      semanticRevision: semantic
        ? base.semanticRevision + (session.plan ? 1 : 0)
        : base.semanticRevision,
      uiRevision: semantic ? base.uiRevision : base.uiRevision + 1,
    };
    if (!session.plan) {
      next.semanticRevision = 1;
      next.uiRevision = 0;
    }
    // ADR-0051: a semantic edit explicitly invalidates producer evidence and
    // decisions (both producers). Disclosure alone never re-runs.
    if (semantic && isBasic && (session.basicRun ?? session.advancedRun)) {
      setCommitMsg("Plan changed: previous evidence and draft decisions were cleared. Find matches explicitly to run the edited plan.");
      setSelectedIds([]);
    }
    onChange(semantic && isBasic ? invalidateRunOnPlanChange({ ...session, plan: next }) : { ...session, plan: next });
  }

  async function applyPlanAndTrial() {
    if (isBasic && onRunBasic) {
      // ADR-0051: the plan's shape decides the producer. The Basic form keeps
      // the Basic default; a confirmed non-Basic plan with the original
      // ordered JOIN keys → outputs explicitly runs the verified Advanced
      // acquisition. The original key/output shape is never editable.
      if (!planRunsBasic && !planRunsAdvanced) {
        setError("The original JOIN key/output shape is locked for live matching. Restore it, then Find matches.");
        return;
      }
      setBusy(true); setError(null); setCommitMsg(null);
      try {
        // Route on the plan's shape, never on a stale mode flag.
        const target = planRunsAdvanced
          ? { ...session, matchingMode: "advanced" as const }
          : { ...session, matchingMode: "basic" as const };
        const next = await onRunBasic(target);
        if (!mounted.current || latestSession.current.id !== session.id || latestSession.current.commitLifecycle?.status === "stale") return;
        onChange(next); setSelectedIds([]); setShowFinal(false);
      }
      catch (e) { setError(String(e)); }
      finally { setBusy(false); }
      return;
    }
    if (!isDemo) {
      setError(LIVE_TRIAL_UNAVAILABLE);
      setCommitMsg(null);
      return;
    }
    if (blockers.length) return;
    setError(null);
    const withPlan = { ...session, plan: { ...plan, scope: session.scope } };
    onChange(loadFixtureTrial(withPlan));
    setShowFinal(false);
    setCommitMsg(null);
  }

  function openLlmRules(reason: string) {
    setChatOpen(true);
    setError(reason);
  }

  async function rankWithLlm() {
    if (isBasic && session.advancedRun) {
      // ADR-0051: Advanced residue ranks within the verified acquisition's
      // bounded allowlists. No semantic expand — the snapshot is the universe.
      if (!session.llmPermissionGranted || !session.instructionText.trim()) {
        openLlmRules("Allow sending matching fields and enter matching instructions first."); return;
      }
      if (session.commitLifecycle) return;
      const allowlist = advancedRankAllowlist(session);
      const eligible = Object.values(allowlist ?? {}).some((ids) => ids.length > 0);
      if (!eligible) { setCommitMsg("No LLM-eligible residue in this verified snapshot — every key is resolved or has no bounded alternatives."); return; }
      llmAbortRef.current?.abort();
      const ac = new AbortController();
      llmAbortRef.current = ac;
      setBusy(true);
      setLlmPhase("rank");
      setLlmProgress({ percent: 20, label: "Choosing the best match", detail: `Ranking residue inside the verified snapshot…` });
      setError(null);
      setCommitMsg(null);
      try {
        const { session: next, error: rankErr, warning: rankWarn, picks, cancelled } = await applyLlmRankingToSession(session, {
          instruction: session.instructionText,
          llmCandidateIdsByProposal: allowlist,
          maxProposals: Math.min(residue, MATCHING_CAPS.massRunUniqueKeys),
          signal: ac.signal,
          onProgress: (p) => {
            setLlmProgress({ percent: 20 + Math.round(p.percent * 0.8), label: "Choosing the best match",
              detail: `Batch ${p.batchIndex}/${p.batchTotal} · ${p.keysDone}/${p.keysTotal} keys · ${p.picksSoFar} picks` });
          },
        });
        onChange(next);
        if (cancelled) setCommitMsg(`LLM cancelled: kept ${picks} ranked pick(s). Open Ambiguous / LLM rows first.`);
        else if (rankErr) { setError(rankErr); setCommitMsg(`LLM stopped: ranked ${picks}/${residue}.`); }
        else {
          const warn = rankWarn ? ` · ${rankWarn}` : "";
          setLlmProgress({ percent: 100, label: "LLM complete", detail: `Ranked ${picks}/${residue}` });
          setCommitMsg(`LLM done: ranked ${picks}/${residue} within the verified snapshot${warn}. Open Ready (Fuzzy+LLM) for the combined result; Ambiguous still needs you.`);
        }
      } catch (e) {
        setError(typeof e === "string" ? e : String(e));
      } finally {
        if (llmAbortRef.current === ac) llmAbortRef.current = null;
        setBusy(false);
        setLlmPhase("idle");
        setLlmProgress(null);
      }
      return;
    }
    if (isBasic) {
      if (!onMergeBasicLlm) { setError("The authoritative Matching session owner is unavailable."); return; }
      if (!session.llmPermissionGranted || !session.instructionText.trim()) {
        openLlmRules("Allow sending matching fields and enter matching instructions first."); return;
      }
      if (!session.basicRun || session.commitLifecycle) return;
      const sent = basicPrompt(session), runId = session.basicRun.id;
      if (!sent.groups.length) { setError("No pending source groups fit the bounded prompt."); return; }
      setBusy(true); setError(null);
      try {
        const reply = await llmChat([{ role: "system", content: sent.prompt }, { role: "user", content: session.instructionText.slice(0, 4000) }]);
        if (!mounted.current || latestSession.current.basicRun?.id !== runId || latestSession.current.commitLifecycle) return;
        if (reply.content.length > 12000) throw new Error("Oversized model response rejected as a whole.");
        if (!parseSuggestedBatchTuplePairs(reply.content, sent).length) throw new Error("No valid complete tuple pairs in the model response. No alternatives were added.");
        onMergeBasicLlm(runId, reply.content, sent);
        setCommitMsg(`LLM alternatives merged without confirming decisions. Prompt omitted ${sent.omittedSources} source groups and ${sent.omittedCandidates} candidate slots.`);
      } catch (e) { setError(String(e)); }
      finally { setBusy(false); }
      return;
    }
    if (!session.proposals.length) {
      setError("Find matches first (step 1)");
      return;
    }
    if (!session.llmPermissionGranted) {
      openLlmRules(
        "Allow sending matching fields to external LLM (checkbox in LLM rules), then retry.",
      );
      return;
    }
    if (!session.instructionText.trim()) {
      openLlmRules(
        "Describe matching rules in LLM rules (right panel), then retry.",
      );
      return;
    }
    if (residue === 0) {
      setCommitMsg(
        `Nothing for LLM — deterministic tier already resolved ${resolvedDeterministic} key(s). Review and Save.`,
      );
      return;
    }
    llmAbortRef.current?.abort();
    const ac = new AbortController();
    llmAbortRef.current = ac;
    setBusy(true);
    setLlmPhase("expand");
    setLlmProgress({
      percent: 2,
      label: "Looking up other names",
      detail: `Preparing ${residue} residue keys…`,
    });
    setError(null);
    setCommitMsg(null);
    try {
      // Cascade Tier 2: alias-expand → lookup (residue only).
      const targets = targetSnapshotFromSession(session);
      const expanded = await widenAllowlistWithLlmAliases(session, targets, {
        signal: ac.signal,
        onProgress: (p) => {
          // Expand = first ~20% of overall cascade.
          setLlmProgress({
            percent: Math.round(p.percent * 0.2),
            label: "Looking up other names",
            detail: p.label,
          });
        },
      });
      let working = applyAllowlistToProposals(
        session,
        expanded.allowlistByProposal,
      );
      if (expanded.llmCalls && working.runMetrics) {
        working = {
          ...working,
          runMetrics: {
            ...working.runMetrics,
            llmCalls: working.runMetrics.llmCalls + expanded.llmCalls,
          },
        };
      }
      onChange(working);

      if (expanded.cancelled || ac.signal.aborted) {
        setCommitMsg(
          `LLM cancelled during expand · kept seed widen (+${expanded.stats.candidatesAdded} cand). Rank skipped.`,
        );
        return;
      }

      setLlmPhase("rank");
      setLlmProgress({
        percent: 20,
        label: "Choosing the best match",
        detail: `Starting rank on residue allowlists…`,
      });
      // Cascade Tier 3: rank residue allowlists only (host-validated).
      const {
        session: next,
        error: rankErr,
        warning: rankWarn,
        picks,
        cancelled,
      } = await applyLlmRankingToSession(working, {
        instruction: session.instructionText,
        llmCandidateIdsByProposal: expanded.allowlistByProposal,
        maxProposals: Math.min(residue, MATCHING_CAPS.massRunUniqueKeys),
        signal: ac.signal,
        onProgress: (p) => {
          setLlmProgress({
            percent: 20 + Math.round(p.percent * 0.8),
            label: "Choosing the best match",
            detail: `Batch ${p.batchIndex}/${p.batchTotal} · ${p.keysDone}/${p.keysTotal} keys · ${p.picksSoFar} picks`,
          });
        },
      });
      onChange(next);
      setLlmProgress({
        percent: cancelled ? (llmProgress?.percent ?? 20) : 100,
        label: cancelled ? "LLM cancelled" : "LLM complete",
        detail: `Ranked ${picks}/${residue}`,
      });
      const expandLine = `expand +${expanded.stats.candidatesAdded} cand on ${expanded.stats.keysWidened} keys (${expanded.stats.aliasRows} alias rows)`;
      if (cancelled) {
        setCommitMsg(
          `LLM cancelled: skipped ${resolvedDeterministic} fuzzy · ${expandLine} · kept ${picks} ranked pick(s). Open Ambiguous / LLM rows first.`,
        );
      } else if (rankErr) {
        setError(
          expanded.error ? `${expanded.error}; ${rankErr}` : rankErr,
        );
        setCommitMsg(
          `LLM stopped: skipped ${resolvedDeterministic} fuzzy · ${expandLine} · ranked ${picks}/${residue}.`,
        );
      } else {
        const warn = rankWarn ? ` · ${rankWarn}` : "";
        setCommitMsg(
          `LLM done: skipped ${resolvedDeterministic} fuzzy · ${expandLine} · ranked ${picks}/${residue}${warn}. Open Ready (Fuzzy+LLM) for the combined result; Ambiguous still needs you.`,
        );
      }
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    } finally {
      if (llmAbortRef.current === ac) llmAbortRef.current = null;
      setBusy(false);
      setLlmPhase("idle");
      setLlmProgress(null);
    }
  }

  function cancelLlm() {
    const ac = llmAbortRef.current;
    if (!ac) return;
    ac.abort();
    setLlmProgress((prev) => ({
      percent: prev?.percent ?? 0,
      label: "Cancelling…",
      detail: prev
        ? "Stopping — UI unlocks now; ignore late model replies"
        : "Stopping…",
    }));
  }

  async function onCommit() {
    if (session.commitLifecycle) return;
    setBusy(true);
    setError(null);
    setCommitMsg(null);
    try {
      if (originRefusal || !writeAllowed || !onSaveToMap) {
        setError(originRefusal ?? writeRefusalReason ?? "Mapping Save is unavailable. Confirmed decisions remain in draft.");
        return;
      }
      // ADR-0051: both producers freeze the shared UI through the same pending
      // lifecycle; the App resolves the exact producer run (Basic/Advanced).
      if (isBasic && (session.basicRun ?? session.advancedRun)) onChange({ ...session, commitLifecycle: { status: "pending", runId: (session.basicRun ?? session.advancedRun)!.id } });
      const result = await onSaveToMap({ session });
      if (result.status !== "saved" && result.status !== "no_changes") {
        if (result.session) onChange(result.session);
        else if (isBasic && latestSession.current.commitLifecycle?.status !== "stale") onChange({ ...latestSession.current, commitLifecycle: undefined });
        setError(`Save ${result.status}: ${result.message} Confirmed decisions remain in draft; retry when ready.`);
        return;
      }
      if (isBasic) {
        onChange(result.session); setSelectedIds([]); setShowFinal(false); setCommitMsg(result.message); return;
      }
      const leftover = result.session.proposals.filter(
        (p) => p.state === "proposed" || p.state === "ambiguous",
      ).length;
      setShowSavedContext(true);
      onChange({
        ...result.session,
        reviewFilter: leftover ? "needs_decision" : "saved",
        pageIndex: 0,
        selectedProposalId:
          (leftover
            ? result.session.proposals.find(
                (p) => p.state === "proposed" || p.state === "ambiguous",
              )?.proposalId
            : result.session.proposals.find((p) => p.state === "saved")
                ?.proposalId) ??
          result.session.selectedProposalId ??
          null,
      });
      setCommitMsg(
        `${result.message}${leftover ? ` ${leftover} still open.` : ""}`,
      );
      setShowFinal(true);
    } catch (e) {
     if (isBasic && latestSession.current.commitLifecycle?.status === "pending") onChange({ ...latestSession.current, commitLifecycle: undefined });
     setError(typeof e === "string" ? e : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div inert={session.commitLifecycle?.status === "pending"} className="flex h-full min-h-0 flex-col bg-[#0b1220] text-slate-200" data-testid="matching-workspace">
      <details className="shrink-0 border-b border-slate-800 px-3 py-1 text-[10px] text-slate-400" data-testid="matching-session-banner">
        <summary className="cursor-pointer">Draft status · {isDemo ? "Demo cannot write to Mapping" : "Not saved to the project file"}</summary>
        <p className="py-1">{isDemo ? "Demo decisions are temporary and cannot be written to a Mapping." : "Draft decisions are temporary until written to Mapping. Restarting clears this draft; save the project file separately after Mapping changes."}</p>
      </details>

      <div
        role="status"
        data-testid="matching-data-origin"
        className="shrink-0 border-b border-slate-800 px-3 py-1 text-[10px] text-slate-400"
      >
        {isDemo
          ? "Demo fixtures — sample data only, not your live query results. Writing to Mapping is blocked. The trial uses the fixed provider/region example."
          : isBasic && session.advancedRun
            ? "Live Advanced matching — actual bounded JOIN fields, contextual similarity scores (not probabilities). Verified acquisition, no fixtures."
            : isBasic ? "Live Basic matching — actual bounded JOIN tuples. Edit the plan and confirm it to use Advanced field matching." : LIVE_TRIAL_UNAVAILABLE}
        {!isDemo && onOpenDemo && (
          <button
            type="button"
            data-testid="matching-open-demo"
            onClick={onOpenDemo}
            className="ml-2 rounded border border-amber-600/70 px-2 py-1"
          >
            Demo fixtures
          </button>
        )}
      </div>

      {session.basicRun && <details className="shrink-0 border-b border-slate-800 px-3 py-0.5 text-[10px] text-slate-400"><summary>Evidence &amp; coverage · {session.basicRun.report.sources.length} LEFT keys · {session.basicRun.report.right_universe.length} RIGHT tuples{session.basicRun.report.right_truncated ? " · partial" : ""}</summary><p data-testid="matching-basic-coverage" role="status">
        {session.basicRun.report.sources.length}/{session.basicRun.report.left_distinct_total} unmatched source tuples
        {" · "}{session.basicRun.report.sources.reduce((n, g) => n + g.source.occurrences, 0)}/{session.basicRun.report.left_occurrences_total} source rows
        {" · "}{session.basicRun.report.right_universe.length}/{session.basicRun.report.right_distinct_total} right tuples
        {session.basicRun.report.left_truncated ? " · source retrieval truncated" : ""}
        {session.basicRun.report.right_truncated ? " · right retrieval truncated; confidence bulk blocked" : ""}
      </p></details>}

      {session.advancedRun && <details className="shrink-0 border-b border-slate-800 px-3 py-0.5 text-[10px] text-slate-400"><summary>Evidence &amp; coverage · verified live acquisition{session.advancedRun.snapshot.acquisition.complete ? " · complete" : " · partial"}</summary><p data-testid="matching-advanced-coverage" role="status">
        Verified live acquisition · {session.advancedRun.snapshot.acquisition.sourceRows.length}/{session.advancedRun.snapshot.acquisition.sourceKeyCap} source tuples
        {" · "}{session.advancedRun.snapshot.acquisition.targetRows.length}/{session.advancedRun.snapshot.acquisition.targetRowCap} right tuples
        {session.advancedRun.snapshot.acquisition.complete ? "" : " · right retrieval truncated — confidence bulk blocked"}
        {" · "}run {session.advancedRun.id}
      </p></details>}

      {session.commitLifecycle?.status === "stale" && <p role="alert" className="p-2 text-amber-200">{session.commitLifecycle.reason}</p>}
      {acknowledged && <section aria-label="Matching commit receipt" className="p-3 text-teal-100">
        <p role="status">Applied {acknowledged.appliedCount} complete tuple mappings.</p>
        <p>Previous review decisions have been cleared. Save the project file separately.</p>
        <button type="button" disabled={busy} onClick={() => void applyPlanAndTrial()}>Refresh remaining review</button>
      </section>}

      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-800 px-3 py-2">
        <h2 className="text-[13px] font-semibold text-teal-100">
          MATCHING: {plan.sourceRef || session.title} → {plan.targetRef || "target"}
        </h2>
        <span className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-400">
          {scopeLabel}
        </span>
        <span className="text-[10px] text-slate-500">
          {counters.uniqueKeys} LEFT · {counters.confirmed} confirmed · {session.proposals.length} acquired
        </span>
        <div className="ml-auto flex gap-2">
          {!isDemo && onOpenLens && (
            <button
              type="button"
              onClick={onOpenLens}
              disabled={Boolean(lensUnavailableReason)}
              title={lensUnavailableReason ?? "Inspect the original Join"}
              data-testid="matching-open-lens"
              className="rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:border-teal-700 hover:text-teal-100"
            >
              {isBasic ? "Open original JOIN in Lens" : "Open Mapping in Lens"}
            </button>
          )}
          {!isDemo && lensUnavailableReason && (
            <span className="text-[11px] text-slate-400" data-testid="matching-lens-unavailable">{lensUnavailableReason}</span>
          )}
          <button
            type="button"
            onClick={() => setChatOpen((v) => !v)}
            className={`rounded border px-2 py-1 text-[11px] ${
              hasProposals &&
              residue > 0 &&
              (!session.llmPermissionGranted ||
                !session.instructionText.trim())
                ? "border-teal-600/70 text-teal-100"
                : "border-slate-700 text-slate-400"
            }`}
          >
              {chatOpen ? "Hide how to match (LLM)" : "How to match (LLM)"}
          </button>
        </div>
      </header>

      {error && (
        <div className="shrink-0 border-b border-rose-900/50 bg-rose-950/40 px-3 py-1.5 text-[11px] text-rose-100">
          {error}
        </div>
      )}
      {commitMsg && (
        <div className="shrink-0 border-b border-teal-900/40 bg-teal-950/30 px-3 py-1.5 text-[11px] text-teal-100">
          {commitMsg}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <section
            className="max-h-[18%] shrink-0 overflow-auto border-b border-slate-800 p-2"
            aria-label="Matching plan"
          >
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              Matching Rules
            </div>
            <details>
              <summary className="cursor-pointer text-xs">Edit plan{isBasic ? (isAdvancedConfirmed ? " — confirmed Advanced live plan" : " — Basic locks the original JOIN keys") : ""}</summary>
              {isBasic && !isAdvancedConfirmed && <p className="text-xs text-slate-400">Basic locks the original ordered LEFT keys → RIGHT outputs. Confirm this plan for Advanced live execution: the original JOIN key/output fields stay locked, comparison fields, roles and normalization are yours.</p>}
              {isAdvancedConfirmed && (
                <p className="text-xs text-teal-200/90" data-testid="matching-advanced-confirm-state">
                  Confirmed Advanced plan. Find matches runs the verified live acquisition; comparing the same plan again does not re-run until you click it.
                  {!advancedPlanCompatible(session) && " The plan no longer matches the original JOIN shape — restore it before Find matches."}
                </p>
              )}
              <fieldset disabled={busy}>
                <fieldset disabled={isBasic} data-testid="matching-plan-bindings">
            <div className="grid gap-2 sm:grid-cols-2">
              <FieldSelect
                label="Source"
                value={plan.sourceRef}
                options={queryOpts}
                onChange={(v) => patchPlan({ sourceRef: v }, true)}
              />
              <FieldSelect
                label="Target"
                value={plan.targetRef}
                options={queryOpts}
                onChange={(v) => patchPlan({ targetRef: v }, true)}
              />
              <div className="sm:col-span-2">
                <MultiFieldSelect
                  label="Source key (match on)"
                  values={plan.mapKeyFields}
                  options={
                    sourceCols.length ? sourceCols : plan.mapKeyFields
                  }
                  onChange={(mapKeyFields) =>
                    patchPlan({ mapKeyFields }, true)
                  }
                />
              </div>
              <MultiFieldSelect
                label="Dictionary ID"
                values={plan.targetIdentityFields}
                options={
                  targetCols.length ? targetCols : plan.targetIdentityFields
                }
                onChange={(targetIdentityFields) =>
                  patchPlan({ targetIdentityFields }, true)
                }
              />
              <MultiFieldSelect
                label="Write to Mapping"
                values={plan.outputs}
                options={targetCols.length ? targetCols : plan.outputs}
                onChange={(outputs) => patchPlan({ outputs }, true)}
              />
            </div>
                </fieldset>
            <div className="mt-2 space-y-1">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                Fields to compare
              </div>
              {plan.comparisons.map((c, i) => (
                <div key={i} className="flex flex-wrap items-end gap-2">
                  <div className="w-36">
                    <FieldSelect
                      label="Source field"
                      value={c.sourceField}
                      options={sourceCols}
                      onChange={(sourceField) => {
                        const comparisons = plan.comparisons.slice();
                        comparisons[i] = { ...c, sourceField };
                        patchPlan({ comparisons }, true);
                      }}
                    />
                  </div>
                  <span className="pb-2 text-slate-600">↔</span>
                  <div className="w-36">
                    <FieldSelect
                      label="Target field"
                      value={c.targetField}
                      options={targetCols}
                      onChange={(targetField) => {
                        const comparisons = plan.comparisons.slice();
                        comparisons[i] = { ...c, targetField };
                        patchPlan({ comparisons }, true);
                      }}
                    />
                  </div>
                  <label className="text-[11px] text-slate-400">
                    How to use
                    <select
                      className="mt-0.5 block rounded border border-slate-700 bg-slate-950 px-1.5 py-1 text-[11px]"
                      value={c.role}
                      title={ROLE_HINTS[c.role]}
                      onChange={(e) => {
                        const comparisons = plan.comparisons.slice();
                        comparisons[i] = {
                          ...c,
                          role: e.target.value as MatchingFieldRole,
                        };
                        patchPlan({ comparisons }, true);
                      }}
                    >
                      {ROLE_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value} title={ROLE_HINTS[o.value]}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="mb-0.5 flex h-7 w-7 items-center justify-center rounded border border-slate-700 text-[14px] leading-none text-slate-400 hover:border-rose-700 hover:text-rose-200 disabled:opacity-40"
                    onClick={() => {
                      if (plan.comparisons.length <= 1) return;
                      patchPlan(
                        {
                          comparisons: plan.comparisons.filter(
                            (_, j) => j !== i,
                          ),
                        },
                        true,
                      );
                    }}
                    disabled={plan.comparisons.length <= 1}
                    title="Remove comparison"
                    aria-label="Remove comparison"
                  >
                    ×
                  </button>
                  <p
                    className="min-w-[12rem] max-w-sm flex-1 pb-1.5 text-[10px] leading-snug text-slate-500"
                    title={ROLE_HINTS[c.role]}
                  >
                    {ROLE_HINTS[c.role]}
                  </p>
                </div>
              ))}
              <button
                type="button"
                className="rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:border-teal-700 hover:text-teal-100"
                onClick={() =>
                  patchPlan(
                    {
                      comparisons: [
                        ...plan.comparisons,
                        {
                          sourceField: sourceCols[0] ?? "",
                          targetField: targetCols[0] ?? "",
                          role: "soft_signal",
                        },
                      ],
                    },
                    true,
                  )
                }
              >
                + Compare another field
              </button>
            </div>
            {blockers.length > 0 && (
              <ul className="mt-2 list-disc pl-4 text-[11px] text-amber-200/90">
                {blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            )}
              </fieldset>
            </details>
            {isBasic && planRunsBasic && attributeSuggestion && !isDemo && (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                <span>JOIN codes identify Mapping keys; descriptive fields can rank the actual entities.</span>
                <button type="button" data-testid="matching-use-entity-attributes"
                  className="rounded border border-teal-700 px-2 py-1 text-teal-200 disabled:opacity-40"
                  disabled={busy || !!session.commitLifecycle || session.hasUnsavedDecisions}
                  onClick={() => patchPlan({ comparisons: [{ ...attributeSuggestion }] }, true)}>
                  Compare {attributeSuggestion.sourceField} ↔ {attributeSuggestion.targetField} (Advanced)
                </button>
              </div>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-testid="matching-apply-plan"
                disabled={(isDemo && blockers.length > 0) || busy || !!session.commitLifecycle || (isBasic && session.hasUnsavedDecisions)
                  || (isBasic && !planRunsBasic && !planRunsAdvanced)}
                title={isBasic && !planRunsBasic && !planRunsAdvanced
                  ? "The plan no longer matches the original ordered JOIN keys → outputs. Restore that shape, then Find matches."
                  : undefined}
                onClick={() => void applyPlanAndTrial()}
                className="rounded border border-amber-600/70 bg-amber-500/15 px-3 py-1.5 text-[12px] font-medium text-amber-50 disabled:opacity-40"
              >
                {isDemo ? "1. Run demo fixtures" : "1. Find matches"}
              </button>
              <button
                type="button"
                data-testid="matching-rank-llm"
                disabled={busy || !hasProposals}
                onClick={() => void rankWithLlm()}
                title={
                  llmGateHint ??
                  `Trial leftover — string match skipped ${residue} key(s). This button SENDS them to the model (not a result yet).`
                }
                className={`rounded border px-3 py-1.5 text-[12px] font-medium disabled:opacity-40 ${
                  busy || llmTouched
                    ? "border-violet-500/80 bg-violet-500/20 text-violet-50"
                    : "border-teal-700/70 bg-teal-500/10 text-teal-50"
                }`}
              >
                {llmPhase === "expand"
                  ? `LLM expand… (${residue} leftover)`
                  : llmPhase === "rank"
                    ? `LLM ranking… (${residue} leftover)`
                    : residue > 0
                      ? `2. Ask LLM about the ${residue} unmatched`
                      : "2. Ask LLM about unmatched"}
              </button>
              {llmGateHint && hasProposals ? (
                <button
                  type="button"
                  onClick={() => openLlmRules(llmGateHint)}
                  className="text-[10px] text-amber-200/90 underline-offset-2 hover:underline"
                >
                  {llmGateHint}
                </button>
              ) : null}
              {hasProposals ? (
                <span className="text-[10px] text-slate-500">
                  String-matched {tiers.fuzzy}
                  {" · "}
                  unmatched {tiers.leftover}
                  {tiers.llm ? ` · LLM answered ${tiers.llm}` : ""}
                  {tiers.manual ? ` · you decide ${tiers.manual}` : ""}
                  {savedRows.length ? ` · in Mapping ${savedRows.length}` : ""}
                </span>
              ) : null}
            </div>
            {busy && llmPhase !== "idle" ? (
              <div
                className="mt-2 overflow-hidden rounded-md border-2 border-violet-400 bg-violet-600 px-3 py-2.5 text-violet-50 shadow-[0_0_24px_rgba(139,92,246,0.45)]"
                role="status"
                aria-live="polite"
                aria-busy="true"
                data-testid="matching-llm-phase"
              >
                <div className="flex items-center gap-3">
                  <span
                    className="inline-block h-4 w-4 shrink-0 rounded-full border-2 border-violet-100 border-t-transparent"
                    style={{ animation: "matching-llm-spin 0.7s linear infinite" }}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-semibold tracking-wide">
                      LLM is working —{" "}
                      {llmProgress?.percent != null
                        ? `${llmProgress.percent}%`
                        : "please wait"}
                    </div>
                    <div className="text-[11px] text-violet-100/95">
                      {llmProgress?.label ??
                        (llmPhase === "expand"
                          ? "Looking up other names for unmatched keys"
                          : "Picking the best dictionary row")}
                      {llmProgress?.detail ? ` · ${llmProgress.detail}` : ""}
                    </div>
                  </div>
                  <span className="shrink-0 rounded bg-violet-950/40 px-2 py-0.5 font-mono text-[11px] font-semibold tabular-nums text-violet-50">
                    {llmProgress?.percent ?? 0}%
                  </span>
                  <button
                    type="button"
                    data-testid="matching-llm-cancel"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      cancelLlm();
                    }}
                    className="shrink-0 rounded border border-violet-100/80 bg-violet-950/50 px-2.5 py-1 text-[11px] font-semibold text-violet-50 hover:bg-violet-950/80"
                  >
                    Cancel
                  </button>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-violet-950/50">
                  <div
                    className="h-full rounded-full bg-violet-100 transition-[width] duration-300 ease-out"
                    style={{
                      width: `${Math.min(100, Math.max(2, llmProgress?.percent ?? 2))}%`,
                    }}
                  />
                </div>
              </div>
            ) : null}
            {llmTouched && !busy ? (
              <div className="mt-2 rounded border border-violet-800/40 bg-violet-950/20 px-2 py-1 text-[10px] text-violet-200/90">
                LLM finished on unmatched keys only. Spelling matches were left
                alone. Open{" "}
                <span className="font-medium text-violet-100">To confirm</span>{" "}
                to review, then Mark to save → Write to Mapping.
              </div>
            ) : null}
          </section>

          <section
            className="relative flex min-h-0 flex-1 flex-col"
            aria-label="Proposal review"
            aria-busy={busy && llmPhase !== "idle"}
          >
            {busy && llmPhase !== "idle" ? (
              <div
                className="absolute inset-0 z-10 flex items-start justify-center bg-slate-950/55 pt-10 backdrop-blur-[1px]"
                data-testid="matching-llm-overlay"
              >
                <div className="rounded-md border border-violet-400/80 bg-violet-600/95 px-4 py-2 text-center text-violet-50 shadow-lg">
                  <div className="text-[12px] font-semibold">
                    LLM is running — wait or Cancel
                  </div>
                  <div className="mt-0.5 font-mono text-[11px] tabular-nums text-violet-100/95">
                    {llmProgress
                      ? `${llmProgress.percent}% · ${llmProgress.detail}`
                      : "…"}
                  </div>
                  <button
                    type="button"
                    data-testid="matching-llm-cancel-overlay"
                    className="mt-2 rounded border border-violet-100/80 bg-violet-950/60 px-3 py-1 text-[11px] font-semibold hover:bg-violet-950"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      cancelLlm();
                    }}
                  >
                    Cancel LLM
                  </button>
                </div>
              </div>
            ) : null}
            <div
              className={`flex min-h-0 flex-1 flex-col ${
                busy && llmPhase !== "idle"
                  ? "pointer-events-none opacity-60"
                  : ""
              }`}
            >
            {(session.basicRun || session.advancedRun) ? (
              <MatchingSetView
                session={session}
                checked={selectedIds}
                onChecked={setSelectedIds}
                onChange={changeReview}
                onCommit={() => void onCommit()}
                commitBlocked={busy || !!session.commitLifecycle || !!originRefusal || !session.hasUnsavedDecisions}
                commitReason={originRefusal}
                previous={pinnedEvaluation}
                onPin={setPinnedEvaluation}
              />
            ) : !hasProposals ? (
              <>
                <div className="grid min-h-[250px] flex-1 grid-cols-2 overflow-hidden">
                  <section aria-label="Source explorer" className="flex min-h-0 flex-col border-r border-slate-800">
                    <header className="border-b border-slate-800 px-3 py-2 text-[12px] font-semibold text-teal-100">LEFT · {plan.sourceRef || session.title}</header>
                    <input type="search" aria-label="Search source keys" placeholder="Search LEFT records" disabled className="m-2 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-[11px]" />
                    <p className="m-auto p-4 text-center text-[11px] text-slate-500">{acknowledged ? "Use Refresh remaining review to acquire source records." : "No LEFT records acquired yet. Use Find matches to retrieve the current source keys."}</p>
                  </section>
                  <RightExplorer session={session} baseline={baselineForExplorers} focused={rightFocus} focusEpoch={focusEpoch} onSetFocus={inspectRight} onInspectJoin={onInspectJoin} onJoinFacts={setActualJoinFacts} />
                </div>
                <section aria-label="Relationship comparison" className="flex h-[150px] shrink-0 items-center justify-between border-t border-slate-800 px-3">
                  <span className="text-[12px] text-slate-400">Select an acquired LEFT record to inspect a relationship.</span>
                  <button type="button" disabled className="rounded border border-teal-700 px-3 py-1 text-[12px] opacity-50">Confirm match</button>
                </section>
                <div className="flex shrink-0 items-center gap-2 border-t border-slate-800 p-2 text-[11px]">
                  <span>0 confirmed · Mapping unchanged</span>
                  <button type="button" disabled className="ml-auto rounded border border-slate-700 px-3 py-1 opacity-50">Review Changes</button>
                  <button type="button" disabled className="rounded border border-amber-700 px-3 py-1 opacity-50">Write to Mapping</button>
                  <span className="text-[10px] text-slate-500">Project Save is separate</span>
                </div>
              </>
            ) : (
              <>
                {/* ADR-0052 mandatory composition: LEFT and RIGHT Explorers are
                    sibling primary columns (equal width), Relationship Inspector
                    lives BELOW both. The reverse-relationship list lives inside the
                    LEFT Explorer when RIGHT-focused (rightFocus is set). */}
                <div className="grid min-h-[250px] flex-1 grid-cols-2 overflow-hidden">
                  <LeftExplorer
                    session={session} baseline={baselineForExplorers} plan={plan} selected={selected}
                    page={page} filteredCount={filtered.length} filter={session.reviewFilter}
                    reviewSearch={reviewSearch} reviewSort={reviewSort} savedRows={savedRows}
                    savedContext={showSavedContext} skipPaging={skipPaging} pageIndex={pageIndex}
                    selectedHidden={selectedHidden} rightFocus={rightFocus}
                    actualJoinFacts={actualJoinFacts}
                    onPick={focusSource}
                    onNavigate={navigate}
                    onSetSearch={v => { setReviewSearch(v); onChange({ ...session, pageIndex: 0 }); }}
                    onSetFilter={id => onChange({ ...session, reviewFilter: id, pageIndex: 0 })}
                    onSetSort={setReviewSort}
                    onSetPage={p => onChange({ ...session, pageIndex: p })}
                    onSetSavedContext={setShowSavedContext}
                    onAdvanceAfterConfirm={setAdvanceAfterConfirm}
                    advanceAfterConfirm={advanceAfterConfirm}
                    selectedIds={selectedIds}
                    onToggleSelected={id => setSelectedIds(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...new Set([...ids, id])])}
                    onCheckVisible={() => setSelectedIds(page.map(p => p.proposalId))}
                    onInvestigate={id => { setFocusEpoch(e => e + 1); onChange({ ...session, selectedProposalId: id }); }}
                    onReturn={returnToLeftReview}
                    canNavigatePrev={!!nextUnresolved(session, sequenceIds, selected?.proposalId ?? null, -1)}
                    canNavigateNext={!!nextUnresolved(session, sequenceIds, selected?.proposalId ?? null, 1)}
                    bulkSelectable={hasProposals}
                  />
                  <RightExplorer
                    session={session} baseline={baselineForExplorers} focused={rightFocus} focusEpoch={focusEpoch}
                    activeSource={selected} selectedTargetId={selectedRight?.targetId}
                    onSelectCandidate={selectRight} onSetFocus={inspectRight}
                    onInspectJoin={onInspectJoin} onJoinFacts={setActualJoinFacts}
                  />
                </div>
                <div className="flex h-[190px] max-h-[23%] min-h-[145px] shrink-0 flex-col overflow-hidden border-t border-slate-800">
                  <RelationshipInspector key={(session.basicRun ?? session.advancedRun)?.id ?? session.id} session={session} baseline={baseline}
                    focusEpoch={focusEpoch} browsedTarget={rightFocus ?? selectedRight} autoPickedTargetId={!rightFocus ? selectedRight?.targetId : undefined} onLookupAdvanced={onLookupAdvanced} proposal={selected} onChange={changeReview} onInspectTarget={inspectRight}
                    onAgreeReplace={token => onChange({ ...session, explicitReplaceKeys: Array.from(new Set([...session.explicitReplaceKeys, token])) })} />
                </div>

                <div className="shrink-0 space-y-1 border-t border-slate-800 p-1.5">
                  <details><summary className="cursor-pointer text-[11px]">Review actions — explicit counted bulk</summary>
                  <div className="flex flex-wrap items-center gap-2 text-[11px]">
                    <span className="text-slate-500">Mark as OK</span>
                    {(
                      [
                        ["selection", "checked rows"],
                        ["page", "this page"],
                        ["filter", "this list"],
                      ] as [BulkConfirmScope, string][]
                    ).map(([s, label]) => (
                        <button
                          key={s}
                          type="button"
                          onClick={() => setBulkScope(s)}
                          className={`rounded border px-1.5 py-0.5 ${
                            bulkScope === s
                              ? "border-amber-600 text-amber-100"
                              : "border-slate-700 text-slate-400"
                          }`}
                        >
                          {label}
                        </button>
                    ))}
                    <span className="text-slate-500">
                      {bulkPreview.keyCount} matches ·{" "}
                      {bulkPreview.affectedSourceRows} rows
                      {bulkPreview.excluded.length
                        ? ` · skipped ${bulkPreview.excluded.length} unclear`
                        : ""}
                    </span>
                    <button
                      type="button"
                      data-testid="matching-bulk-confirm"
                      disabled={!bulkPreview.keyCount}
                      onClick={() =>
                        onChange(applyBulkConfirm(session, bulkPreview))
                      }
                      className="rounded border border-slate-600 px-2 py-0.5 text-slate-200 disabled:opacity-40"
                    >
                      {isBasic && (session.basicRun ?? session.advancedRun)
                        ? `Accept high-confidence suggestions (${bulkPreview.keyCount})`
                        : `Mark ${bulkPreview.keyCount} ${isDemo ? "in demo" : "to save"}`}
                    </button>
                    {isBasic && <>
                      <button type="button" data-testid="matching-reviewed-bulk" disabled={!reviewedPreview.keyCount || busy}
                        onClick={() => onChange(confirmReviewedSelection(session, selectedIds))}>
                        Confirm reviewed checked rows ({reviewedPreview.keyCount})
                      </button>
                      <span className="text-slate-500">{reviewedPreview.affectedSourceRows} source rows · checked rows confirm displayed suggested targets; use Choose for alternatives.</span>
                      {session.decisions.some(d => d.bulkToken) && <button type="button" onClick={() => onChange(undoMatchingBulk(session))}>Undo bulk acceptance</button>}
                      <span className="text-slate-500">
                        {(session.advancedRun
                          ? advancedHighConfidenceIds(session, BATCH_HIGH_CONFIDENCE_SCORE, BATCH_AMBIGUITY_GAP)
                          : basicHighConfidenceIds(session)).length} eligible across this run;
                        {session.advancedRun ? "contextual similarity scores are not probabilities" : "spelling scores are not probabilities"}.
                      </span>
                    </>}
                  </div>

                  </details>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setShowFinal((v) => !v)}
                      className="rounded border border-teal-800/60 px-2 py-1 text-[11px] text-teal-100"
                    >
                      {showFinal ? "Close Review" : "Review Changes"}
                    </button>
                    <span className="text-[10px] text-slate-500">
                      {counters.confirmed} confirmed · new {finalSum.adds} · change {finalSum.changes} · still open {finalSum.unresolved}
                    </span>
                    <button
                      type="button"
                      data-testid="matching-save"
                      disabled={busy || !!session.commitLifecycle || !!originRefusal || !session.hasUnsavedDecisions}
                      title={originRefusal ?? undefined}
                      onClick={() => void onCommit()}
                      className="ml-auto rounded border border-amber-600/70 bg-amber-500/15 px-3 py-1 text-[12px] font-medium text-amber-50 disabled:opacity-40"
                    >
                      {isDemo ? "Demo — writing blocked" : busy
                        ? "Saving…"
                        : `Write ${session.decisions.filter((d) => d.kind === "confirm_proposed" || d.kind === "choose_alternative").length} to Mapping`}
                    </button>
                  </div>
                  <span className="text-[9px] text-slate-500">Project file Save is separate.</span>

                  {showFinal && (
                    <div
                      className="max-h-40 overflow-auto rounded border border-slate-800 bg-slate-950/50 p-2 text-[10px]"
                      data-testid="matching-final-diff"
                    >
                      {finalDiff.map((r, i) => (
                        <div key={i} className="font-mono text-slate-300">
                          [{!baseline?.complete && r.kind !== "unresolved" ? "baseline unknown" : r.kind}] {r.mapKey.map(tupleCell).join("|")}{" "}
                          {r.oldOutputs?.join(",") ?? "∅"} →{" "}
                          {r.newOutputs?.join(",") ?? "∅"} ({r.origin}, rows=
                          {r.affectedSourceRows})
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
            </div>
          </section>
        </div>

        {chatOpen && (
          <aside className="flex w-72 shrink-0 flex-col border-l border-slate-800 bg-slate-950/40">
            <div className="border-b border-slate-800 px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Tell the LLM how to match
            </div>
            <div className="p-2 text-[11px] leading-snug text-slate-500">
              Step 1 already matched obvious spelling. Step 2 sends only the
              leftovers (nicknames, translations, abbreviations). Nothing is
              written to Mapping until you mark matches and click Write.
            </div>
            <label className="mx-2 flex items-center gap-2 text-[11px] text-slate-400">
              <input
                type="checkbox"
                checked={session.llmPermissionGranted}
                onChange={(e) =>
                  onChange({
                    ...session,
                    llmPermissionGranted: e.target.checked,
                  })
                }
              />
              Allow sending matching fields to external LLM
            </label>
            <textarea
              className="m-2 min-h-[8rem] flex-1 resize-none rounded border border-slate-700 bg-slate-950 p-2 text-[11px]"
              placeholder={
                "Example:\n• vendor names may be translations or abbreviations\n• regions must be the same country (US≈USA, DE≈Germany)\n• same name in different regions = different companies"
              }
              value={session.instructionText}
              onChange={(e) =>
                onChange({ ...session, instructionText: e.target.value })
              }
            />
            <button
              type="button"
              className="m-2 rounded border border-teal-700/70 px-2 py-1.5 text-[11px] text-teal-100 disabled:opacity-40"
              disabled={busy || !hasProposals}
              onClick={() => void rankWithLlm()}
            >
              {busy
                ? "Ranking…"
                : residue > 0
                  ? `Ask LLM about the ${residue} unmatched`
                  : "Ask LLM about unmatched"}
            </button>
          </aside>
        )}
      </div>
    </div>
  );
}
