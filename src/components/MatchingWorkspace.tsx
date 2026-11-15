/**
 * Matching workspace tab (ADR-0044).
 * Plan editor → fixture/retrieval proposals → review → final diff → Save.
 */
import { useEffect, useMemo, useRef, useState } from "react";
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
  candidateById,
  filterProposals,
  matchingCounters,
  pageSlice,
  previewBulkConfirm,
  readyTierSplit,
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
import { RecordValues } from "./matching/RecordValues";
import { RelationshipBrowser } from "./matching/RelationshipBrowser";
import { nextUnresolved, type MappingProjection } from "../app/matching/relationships";
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

const FILTERS: {
  id: MatchingTabSession["reviewFilter"];
  label: string;
  title: string;
}[] = [
  {
    id: "ready",
    label: "To confirm",
    title: "Suggested matches — Fuzzy plus any LLM picks. Not in Mapping yet.",
  },
  {
    id: "needs_decision",
    label: "Still open",
    title: "Anything not confirmed or saved yet.",
  },
  {
    id: "ambiguous",
    label: "Unclear",
    title: "Several possible matches, or the model was unsure.",
  },
  {
    id: "incomplete_search",
    label: "Search cut off",
    title: "Candidate search stopped early — needs LLM or a manual pick.",
  },
  {
    id: "confirmed",
    label: "Marked to save",
    title: "You confirmed these. Click Write to Mapping to keep them.",
  },
  {
    id: "saved",
    label: "In Mapping",
    title: "Already written to the Mapping. Use for comparison.",
  },
  {
    id: "stale",
    label: "Out of date",
    title: "Plan changed after this suggestion was made.",
  },
  { id: "all", label: "All keys", title: "Every key in this matching run." },
];

function stateLabel(state: MatchingProposalView["state"]): string {
  switch (state) {
    case "proposed":
      return "suggested";
    case "ambiguous":
      return "unclear";
    case "no_candidates":
      return "no match";
    case "incomplete_search":
      return "search cut off";
    case "confirmed_in_draft":
      return "marked to save";
    case "saved":
      return "in Mapping";
    case "deferred":
      return "skipped";
    case "rejected":
      return "rejected";
    case "stale":
      return "out of date";
    default:
      return state;
  }
}

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
  const [commitMsg, setCommitMsg] = useState<string | null>(null);
  const [showSavedContext, setShowSavedContext] = useState(true);
  const [targetFocus, setTargetFocus] = useState<MatchingCandidateView | null>(null);
  const [focusEpoch, setFocusEpoch] = useState(0);
  const [advanceAfterConfirm, setAdvanceAfterConfirm] = useState(false);
  function inspectTarget(candidate: MatchingCandidateView) { setFocusEpoch(e => e + 1); setTargetFocus(candidate); }
  function focusSource(id: string) { setFocusEpoch(e => e + 1); setTargetFocus(null); onChange({ ...session, selectedProposalId: id }); }
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
  const readySplit = useMemo(
    () => readyTierSplit(session.proposals),
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
      if (id) { next = { ...next, selectedProposalId: id }; setTargetFocus(null); setFocusEpoch(e => e + 1); }
    }
    onChange(next);
  }
  useEffect(() => { setTargetFocus(null); setFocusEpoch(e => e + 1); }, [session.basicRun?.id, session.advancedRun?.id, session.commitLifecycle]);
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
      <div
        className="shrink-0 border-b border-amber-900/50 bg-amber-950/40 px-3 py-2 text-[11px] leading-snug text-amber-100/95"
        role="status"
        data-testid="matching-session-banner"
      >
        {isDemo ? (
          "Demo decisions are temporary and cannot be written to a Mapping. Restarting the app clears this demo."
        ) : (
          <>
            Suggestions here are temporary until you write them to the Mapping.
            Restarting the app clears this draft. After writing to Mapping, save the
            project file to keep local Mapping changes.
          </>
        )}
      </div>

      <div
        role="status"
        data-testid="matching-data-origin"
        className="shrink-0 border-b border-amber-900/50 px-3 py-2 text-[11px] text-amber-100"
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

      {session.basicRun && <p role="status" data-testid="matching-basic-coverage" className="shrink-0 border-b border-slate-800 px-3 py-1 text-[11px] text-slate-400">
        {session.basicRun.report.sources.length}/{session.basicRun.report.left_distinct_total} unmatched source tuples
        {" · "}{session.basicRun.report.sources.reduce((n, g) => n + g.source.occurrences, 0)}/{session.basicRun.report.left_occurrences_total} source rows
        {" · "}{session.basicRun.report.right_universe.length}/{session.basicRun.report.right_distinct_total} right tuples
        {session.basicRun.report.left_truncated ? " · source retrieval truncated" : ""}
        {session.basicRun.report.right_truncated ? " · right retrieval truncated; confidence bulk blocked" : ""}
      </p>}

      {session.advancedRun && <p role="status" data-testid="matching-advanced-coverage" className="shrink-0 border-b border-slate-800 px-3 py-1 text-[11px] text-slate-400">
        Verified live acquisition · {session.advancedRun.snapshot.acquisition.sourceRows.length}/{session.advancedRun.snapshot.acquisition.sourceKeyCap} source tuples
        {" · "}{session.advancedRun.snapshot.acquisition.targetRows.length}/{session.advancedRun.snapshot.acquisition.targetRowCap} right tuples
        {session.advancedRun.snapshot.acquisition.complete ? "" : " · right retrieval truncated — confidence bulk blocked"}
        {" · "}run {session.advancedRun.id}
      </p>}

      {session.commitLifecycle?.status === "stale" && <p role="alert" className="p-2 text-amber-200">{session.commitLifecycle.reason}</p>}
      {acknowledged && <section aria-label="Matching commit receipt" className="p-3 text-teal-100">
        <p role="status">Applied {acknowledged.appliedCount} complete tuple mappings.</p>
        <p>Previous review decisions have been cleared. Save the project file separately.</p>
        <button type="button" disabled={busy} onClick={() => void applyPlanAndTrial()}>Refresh remaining review</button>
      </section>}

      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-800 px-3 py-2">
        <h2 className="text-[13px] font-semibold text-teal-100">
          {session.title}
        </h2>
        <span className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-400">
          {scopeLabel}
        </span>
        <span className="text-[10px] text-slate-500">
          {counters.sourceRows} source rows · {counters.uniqueKeys} unique
          keys · {counters.confirmed} marked to save
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
            className="max-h-[40%] shrink-0 overflow-auto border-b border-slate-800 p-3"
            aria-label="Matching plan"
          >
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              How matching works
            </div>
            <details open={!isBasic}>
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
            {!hasProposals ? (
              <p className="p-3 text-[12px] text-slate-500">
                {acknowledged ? "Use Refresh remaining review to retrieve again. " : ""}Click <span className="text-amber-100">Find matches</span> to
                compare source keys with the dictionary (spelling first, no
                LLM).
              </p>
            ) : (
              <>
                <div className="flex shrink-0 flex-wrap gap-1 border-b border-slate-800 px-2 py-1.5">
                  <input type="search" aria-label="Search source keys" value={reviewSearch}
                    placeholder="Search source keys"
                    className="min-w-0 rounded border border-slate-700 bg-slate-950 px-2 text-[11px]"
                    onChange={e => { setReviewSearch(e.target.value); onChange({ ...session, pageIndex: 0 }); }} />
                  <select aria-label="Sort source keys" value={reviewSort}
                    className="rounded border border-slate-700 bg-slate-950 text-[11px]"
                    onChange={e => { setReviewSort(e.target.value as "workflow" | "score"); onChange({ ...session, pageIndex: 0 }); }}>
                    <option value="workflow">Workflow order</option>
                    <option value="score">Suggested score: high to low (unknown last)</option>
                  </select>
                  {FILTERS.map((f) => {
                    const n = filterProposals(session.proposals, f.id).length;
                    return (
                    <button
                      key={f.id}
                      type="button"
                      title={f.title}
                      onClick={() =>
                        onChange({
                          ...session,
                          reviewFilter: f.id,
                          pageIndex: 0,
                        })
                      }
                      className={`rounded px-2 py-0.5 text-[10px] ${
                        session.reviewFilter === f.id
                          ? "bg-amber-500/20 text-amber-50"
                          : "text-slate-500 hover:text-slate-300"
                      }`}
                    >
                      {f.label}
                      {n > 0 ? ` · ${n}` : ""}
                    </button>
                    );
                  })}
                  {savedRows.length > 0 &&
                  session.reviewFilter !== "saved" &&
                  session.reviewFilter !== "all" ? (
                    <label className="ml-2 flex items-center gap-1 text-[10px] text-teal-200/90">
                      <input
                        type="checkbox"
                        checked={showSavedContext}
                        onChange={(e) => setShowSavedContext(e.target.checked)}
                      />
                      Show {savedRows.length} already in Mapping
                    </label>
                  ) : null}
                  {!skipPaging ? (
                    <div className="ml-auto flex items-center gap-1 text-[10px] text-slate-500">
                      <button
                        type="button"
                        aria-label="Previous source page"
                        disabled={pageIndex <= 0}
                        onClick={() =>
                          onChange({
                            ...session,
                            pageIndex: Math.max(0, pageIndex - 1),
                          })
                        }
                        className="rounded border border-slate-700 px-1.5 disabled:opacity-30"
                      >
                        ‹
                      </button>
                      page {pageIndex + 1}
                      <button
                        type="button"
                        aria-label="Next source page"
                        disabled={
                          (pageIndex + 1) * session.pageSize >=
                          filtered.length
                        }
                        onClick={() =>
                          onChange({
                            ...session,
                            pageIndex: pageIndex + 1,
                          })
                        }
                        className="rounded border border-slate-700 px-1.5 disabled:opacity-30"
                      >
                        ›
                      </button>
                    </div>
                  ) : (
                    <div className="ml-auto text-[10px] text-slate-400">
                      scroll the list — all groups are here
                    </div>
                  )}
                </div>

                {isReadyView ? (
                  <div
                    className="shrink-0 border-b border-slate-800 bg-slate-950/60 px-2 py-1 text-[10px] text-slate-300"
                    data-testid="matching-ready-banner"
                  >
                    Suggested matches (not in Mapping yet):{" "}
                    <span className="text-emerald-200">
                      string {readySplit.fuzzy}
                    </span>
                    {readySplit.leftover > 0 ? (
                      <>
                        {" · "}
                        <span className="text-amber-200">
                          unmatched {readySplit.leftover}
                        </span>
                      </>
                    ) : null}
                    {readySplit.llm > 0 ? (
                      <>
                        {" · "}
                        <span className="text-violet-200">
                          LLM {readySplit.llm}
                        </span>
                      </>
                    ) : null}
                    {readySplit.other > 0 ? (
                      <>
                        {" · "}
                        <span className="text-slate-200">
                          you decide {readySplit.other}
                        </span>
                      </>
                    ) : null}
                  </div>
                ) : null}

                <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-slate-700 p-2 text-[11px]" aria-label="Sequential review">
                  <button type="button" disabled={!nextUnresolved(session, sequenceIds, selected?.proposalId ?? null, -1)} onClick={() => navigate(-1)}>Previous unresolved</button>
                  <button type="button" disabled={!nextUnresolved(session, sequenceIds, selected?.proposalId ?? null, 1)} onClick={() => navigate(1)}>Next unresolved</button>
                  <label><input type="checkbox" checked={advanceAfterConfirm} onChange={e => setAdvanceAfterConfirm(e.target.checked)} /> Advance after confirm</label>
                  {selectedHidden && <span role="status">Pinned source is outside this page/filter. <button type="button" onClick={() => { setReviewSearch(""); onChange({ ...session, reviewFilter: "all", pageIndex: Math.floor(session.proposals.findIndex(p => p.proposalId === selected?.proposalId) / session.pageSize) }); }}>Reveal source</button></span>}
                </div>
                <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto xl:grid-cols-2">
                  <section className="min-w-0 overflow-auto" aria-label="Source explorer">
                    <h3 className="p-2 font-semibold">LEFT records · {plan.sourceRef}</h3>
                    {!targetFocus && <table className="w-full text-left text-[11px]">
                      <thead className="sticky top-0 bg-slate-950 text-slate-400"><tr><th>Reviewed</th><th>Source record</th><th>Suggested / draft target</th><th>Status</th></tr></thead>
                      <tbody>{page.map(p => {
                        const target = candidateById(session, session.decisions.find(d => d.proposalId === p.proposalId)?.candidateId ?? p.proposedCandidateId);
                        return <tr key={p.proposalId} data-testid={`matching-row-${p.proposalId}`} onClick={() => focusSource(p.proposalId)}
                          className={`cursor-pointer border-t border-slate-800 ${selected?.proposalId === p.proposalId ? "bg-amber-950/30" : "hover:bg-slate-900"}`}>
                          <td className="p-2"><input type="checkbox" aria-label={`Reviewed source ${JSON.stringify(p.mapKey)}`}
                            checked={selectedIds.includes(p.proposalId)} disabled={p.state === "saved" || p.state === "stale" || !!session.commitLifecycle}
                            onClick={e => e.stopPropagation()} onChange={e => setSelectedIds(ids => e.target.checked ? [...new Set([...ids, p.proposalId])] : ids.filter(id => id !== p.proposalId))} /></td>
                          <td className="p-2"><button type="button" onClick={e => { e.stopPropagation(); focusSource(p.proposalId); }}><RecordValues fields={plan.mapKeyFields} values={p.mapKey} /></button><span className="text-slate-500">{p.affectedSourceRows} source rows</span></td>
                          <td className="p-2">{target ? <RecordValues fields={plan.outputs} values={target.outputValues} /> : "No suggestion"}</td>
                          <td className="p-2">{stateLabel(p.state)}</td>
                        </tr>;
                      })}</tbody>
                    </table>}
                    <RelationshipBrowser session={session} baseline={baseline} target={targetFocus} onFocusTarget={inspectTarget}
                      onInspectJoin={onInspectJoin} focusEpoch={focusEpoch} onInvestigate={id => { setFocusEpoch(e => e + 1); onChange({ ...session, selectedProposalId: id }); }}
                      onReturn={() => { setTargetFocus(null); setFocusEpoch(e => e + 1); }} />
                  </section>
                  <RelationshipInspector key={(session.basicRun ?? session.advancedRun)?.id ?? session.id} session={session} baseline={baseline}
                    focusEpoch={focusEpoch} browsedTarget={targetFocus} onLookupAdvanced={onLookupAdvanced} proposal={selected} onChange={changeReview} onInspectTarget={inspectTarget}
                    onAgreeReplace={token => onChange({ ...session, explicitReplaceKeys: Array.from(new Set([...session.explicitReplaceKeys, token])) })} />
                </div>

                <div className="shrink-0 space-y-2 border-t border-slate-800 p-2">
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
                    <button
                      type="button"
                      onClick={() => setSelectedIds(page.map((p) => p.proposalId))}
                      className="text-slate-500 hover:underline"
                    >
                      Check visible rows
                    </button>
                  </div>

                  </details>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setShowFinal((v) => !v)}
                      className="rounded border border-teal-800/60 px-2 py-1 text-[11px] text-teal-100"
                    >
                      {showFinal ? "Hide" : "Show"} {isDemo ? "demo decisions (no writes)" : "what will be written"}
                    </button>
                    <span className="text-[10px] text-slate-500">
                      New {finalSum.adds} · change {finalSum.changes} · still
                      open {finalSum.unresolved}
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
