/**
 * Matching workspace tab (ADR-0044).
 * Plan editor → fixture/retrieval proposals → review → final diff → Save.
 */
import { Fragment, useMemo, useRef, useState } from "react";
import { FIXTURE_PLAN } from "../app/matching/fixtures";
import { buildLensMatchingPlan } from "../app/matching/planDefaults";
import {
  applyBulkConfirm,
  applyDecision,
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
  cascadeTierLabel,
  proposalCascadeTier,
  proposalEvidenceSummary,
} from "../app/matching/cascade";
import { applyLlmRankingToSession } from "../app/matching/llmRank";
import { MATCHING_CAPS } from "../lib/matchingCaps";
import {
  applyAllowlistToProposals,
  targetSnapshotFromSession,
  widenAllowlistWithLlmAliases,
} from "../app/matching/semanticExpand";
import { loadFixtureTrial } from "../app/matching/runTrial";
import { commitMatchingSession } from "../app/matching/commitSave";
import type {
  MatchingFieldRole,
  MatchingPlanDraft,
  MatchingProposalView,
  MatchingTabSession,
} from "../app/matching/types";
import { mapKeyToken } from "../app/matching/types";

type Props = {
  session: MatchingTabSession;
  onChange: (next: MatchingTabSession) => void;
  onOpenLens?: () => void;
  /** Persist upserts into the bound Mapping via existing Save path. */
  onSaveToMap?: (args: {
    upserts: { fromParts: string[]; outputValues: string[] }[];
    session: MatchingTabSession;
  }) => Promise<void> | void;
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
  return { ...FIXTURE_PLAN, scope: session.scope };
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
  onChange,
  onOpenLens,
  onSaveToMap,
  writeAllowed = true,
  writeRefusalReason = null,
}: Props) {
  const [chatOpen, setChatOpen] = useState(!session.chatCollapsed);
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

  const plan = emptyPlan(session);
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
    const open = filterProposals(session.proposals, session.reviewFilter);
    if (
      showSavedContext &&
      session.reviewFilter !== "saved" &&
      session.reviewFilter !== "all" &&
      session.reviewFilter !== "confirmed" &&
      savedRows.length
    ) {
      const seen = new Set(open.map((p) => p.proposalId));
      return [...open, ...savedRows.filter((p) => !seen.has(p.proposalId))];
    }
    return open;
  }, [session.proposals, session.reviewFilter, showSavedContext, savedRows]);
  const isReadyView = session.reviewFilter === "ready";
  const isSavedView = session.reviewFilter === "saved";
  const skipPaging = isReadyView || isSavedView || showSavedContext;
  // Ready / Saved / compare mode: one scroll so tiers aren't split across pages.
  const page = useMemo(
    () =>
      skipPaging
        ? filtered
        : pageSlice(filtered, session.pageIndex, session.pageSize),
    [filtered, skipPaging, session.pageIndex, session.pageSize],
  );
  const counters = matchingCounters(session);
  const selected =
    session.proposals.find((p) => p.proposalId === session.selectedProposalId) ??
    page[0] ??
    null;
  const bulkPreview = previewBulkConfirm(session, bulkScope, selectedIds);
  const finalDiff = useMemo(() => buildFinalDiff(session), [session]);
  const finalSum = summarizeFinalDiff(finalDiff);

  const scopeLabel =
    session.scope === "selected"
      ? "selected rows only"
      : session.scope === "cohort"
        ? "this group of rows (not the whole table)"
        : "all rows";

  function patchPlan(patch: Partial<MatchingPlanDraft>, semantic: boolean) {
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
    onChange({ ...session, plan: next });
  }

  function applyPlanAndTrial() {
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
    setLlmProgress((prev) =>
      prev
        ? {
            ...prev,
            label: "Cancelling…",
            detail: "Stopping — UI unlocks now; ignore late model replies",
          }
        : {
            percent: prev?.percent ?? 0,
            label: "Cancelling…",
            detail: "Stopping…",
          },
    );
  }

  async function onCommit() {
    setBusy(true);
    setError(null);
    setCommitMsg(null);
    try {
      const result = await commitMatchingSession(session, {
        writeAllowed,
        writeRefusalReason: writeRefusalReason ?? undefined,
      });
      if (!result.ok) {
        setError(`Save blocked: ${result.reason}`);
        return;
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
          leftover
            ? result.session.proposals.find(
                (p) => p.state === "proposed" || p.state === "ambiguous",
              )?.proposalId
            : result.session.proposals.find((p) => p.state === "saved")
                ?.proposalId ?? result.session.selectedProposalId,
      });
      if (onSaveToMap && result.upserts.length) {
        await onSaveToMap({
          upserts: result.upserts,
          session: result.session,
        });
      }
      setCommitMsg(
        leftover
          ? `Saved ${result.upserts.length} into Mapping. ${leftover} still open. Tab Saved in Mapping lists the written keys — keep it on while deciding the rest.`
          : `Saved ${result.upserts.length} into Mapping. Open Saved in Mapping (this tab) or the Mapping editor.`,
      );
      setShowFinal(true);
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#0b1220] text-slate-200">
      <div
        className="shrink-0 border-b border-amber-900/50 bg-amber-950/40 px-3 py-2 text-[11px] leading-snug text-amber-100/95"
        role="status"
        data-testid="matching-session-banner"
      >
        Suggestions here are temporary until you write them to the Mapping.
        Restarting the app clears this draft. Mapping rows you already saved stay.
      </div>

      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-800 px-3 py-2">
        <h2 className="text-[13px] font-semibold text-teal-100">
          {session.title}
        </h2>
        <span className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-400">
          {scopeLabel}
        </span>
        <span className="text-[10px] text-slate-500">
          {counters.sourceRows} invoice rows · {counters.uniqueKeys} unique
          keys · {counters.confirmed} marked to save
        </span>
        <div className="ml-auto flex gap-2">
          {onOpenLens && (
            <button
              type="button"
              onClick={onOpenLens}
              className="rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:border-teal-700 hover:text-teal-100"
            >
              Open Mapping in Lens
            </button>
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
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-testid="matching-apply-plan"
                disabled={blockers.length > 0 || busy}
                onClick={applyPlanAndTrial}
                className="rounded border border-amber-600/70 bg-amber-500/15 px-3 py-1.5 text-[12px] font-medium text-amber-50 disabled:opacity-40"
              >
                1. Find matches
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
                Click <span className="text-amber-100">Find matches</span> to
                compare source keys with the dictionary (spelling first, no
                LLM).
              </p>
            ) : (
              <>
                <div className="flex shrink-0 flex-wrap gap-1 border-b border-slate-800 px-2 py-1.5">
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
                        disabled={session.pageIndex <= 0}
                        onClick={() =>
                          onChange({
                            ...session,
                            pageIndex: Math.max(0, session.pageIndex - 1),
                          })
                        }
                        className="rounded border border-slate-700 px-1.5 disabled:opacity-30"
                      >
                        ‹
                      </button>
                      page {session.pageIndex + 1}
                      <button
                        type="button"
                        disabled={
                          (session.pageIndex + 1) * session.pageSize >=
                          filtered.length
                        }
                        onClick={() =>
                          onChange({
                            ...session,
                            pageIndex: session.pageIndex + 1,
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

                <div className="flex min-h-0 flex-1">
                  <div className="min-w-0 flex-1 overflow-auto">
                    <table className="w-full text-left text-[11px]">
                      <thead className="sticky top-0 z-[1] bg-[#0b1220] text-slate-500">
                        <tr>
                          <th className="px-2 py-1">Tier</th>
                          <th className="px-2 py-1">Key</th>
                          <th className="px-2 py-1">Match</th>
                          <th className="px-2 py-1">Why</th>
                          <th className="px-2 py-1">Other options</th>
                          <th className="px-2 py-1">Status</th>
                          <th className="px-2 py-1">Rows</th>
                        </tr>
                      </thead>
                      <tbody>
                        {page.map((p, idx) => {
                          const tier = proposalCascadeTier(p);
                          const saved = p.state === "saved";
                          const prev = idx > 0 ? page[idx - 1]! : null;
                          const prevSaved = prev?.state === "saved";
                          const prevTier = prev
                            ? proposalCascadeTier(prev)
                            : null;
                          const showSavedSection =
                            saved && (idx === 0 || !prevSaved);
                          const showReadySection =
                            isReadyView &&
                            !saved &&
                            (idx === 0 ||
                              prevSaved ||
                              prevTier !== tier);
                          return (
                          <Fragment key={p.proposalId}>
                          {showSavedSection ? (
                            <tr className="bg-teal-950/50">
                              <td
                                colSpan={7}
                                className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-teal-200"
                              >
                                Already in Mapping · {savedRows.length} ·
                                compare only, not editable here
                              </td>
                            </tr>
                          ) : null}
                          {showReadySection ? (
                            <tr className="bg-slate-900/80">
                              <td
                                colSpan={7}
                                className={`px-2 py-1 text-[10px] font-semibold uppercase tracking-wide ${
                                  tier === "fuzzy"
                                    ? "text-emerald-300"
                                    : tier === "leftover"
                                      ? "text-amber-200"
                                      : tier === "llm"
                                        ? "text-violet-200"
                                        : "text-slate-300"
                                }`}
                              >
                                {tier === "fuzzy"
                                  ? `Matched by spelling · ${readySplit.fuzzy}`
                                  : tier === "leftover"
                                    ? `Not matched yet — send to LLM · ${readySplit.leftover}`
                                    : tier === "llm"
                                      ? `LLM suggested · ${readySplit.llm}`
                                      : `You decide · ${readySplit.other}`}
                              </td>
                            </tr>
                          ) : null}
                          <tr
                            data-testid={`matching-row-${p.proposalId}`}
                            onClick={() =>
                              onChange({
                                ...session,
                                selectedProposalId: p.proposalId,
                              })
                            }
                            className={`cursor-pointer border-t border-slate-800/80 ${
                              selected?.proposalId === p.proposalId
                                ? "bg-amber-950/30"
                                : saved
                                  ? "bg-teal-950/20 text-slate-400"
                                  : "hover:bg-slate-900/50"
                            }`}
                          >
                            <td className="px-2 py-1">
                              <span
                                className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                                  saved
                                    ? "bg-teal-500/20 text-teal-100"
                                    : tier === "fuzzy"
                                      ? "bg-emerald-500/15 text-emerald-200"
                                      : tier === "leftover"
                                        ? "bg-amber-500/20 text-amber-100"
                                        : tier === "llm"
                                          ? "bg-violet-500/20 text-violet-100"
                                          : "bg-slate-600/40 text-slate-200"
                                }`}
                              >
                                {saved ? "Saved" : cascadeTierLabel(tier)}
                              </span>
                            </td>
                            <td className="px-2 py-1 font-mono">
                              {p.mapKey.map((k) => (k === "" ? "∅" : k)).join(" · ")}
                            </td>
                            <td className="px-2 py-1 font-mono">
                              {candidateById(session, p.proposedCandidateId)
                                ?.targetId ?? "—"}
                            </td>
                            <td
                              className="max-w-[14rem] truncate px-2 py-1 text-slate-400"
                              title={p.evidence.map((e) => e.note).join("; ")}
                            >
                              {proposalEvidenceSummary(p)}
                            </td>
                            <td className="px-2 py-1">
                              {tier === "fuzzy"
                                ? "—"
                                : p.alternativeCandidateIds.length ||
                                    p.searchIncomplete
                                  ? p.alternativeCandidateIds.length || "…"
                                  : "—"}
                            </td>
                            <td className="px-2 py-1">{stateLabel(p.state)}</td>
                            <td className="px-2 py-1">{p.affectedSourceRows}</td>
                          </tr>
                          </Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  <DetailPanel
                    session={session}
                    proposal={selected}
                    onChange={onChange}
                    onAgreeReplace={(token) =>
                      onChange({
                        ...session,
                        explicitReplaceKeys: Array.from(
                          new Set([...session.explicitReplaceKeys, token]),
                        ),
                      })
                    }
                  />
                </div>

                <div className="shrink-0 space-y-2 border-t border-slate-800 p-2">
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
                      Mark {bulkPreview.keyCount} to save
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedIds(page.map((p) => p.proposalId))}
                      className="text-slate-500 hover:underline"
                    >
                      Check visible rows
                    </button>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setShowFinal((v) => !v)}
                      className="rounded border border-teal-800/60 px-2 py-1 text-[11px] text-teal-100"
                    >
                      {showFinal ? "Hide" : "Show"} what will be written
                    </button>
                    <span className="text-[10px] text-slate-500">
                      New {finalSum.adds} · change {finalSum.changes} · still
                      open {finalSum.unresolved}
                    </span>
                    <button
                      type="button"
                      data-testid="matching-save"
                      disabled={busy || !session.hasUnsavedDecisions}
                      onClick={() => void onCommit()}
                      className="ml-auto rounded border border-amber-600/70 bg-amber-500/15 px-3 py-1 text-[12px] font-medium text-amber-50 disabled:opacity-40"
                    >
                      {busy
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
                          [{r.kind}] {r.mapKey.map((k) => k || "∅").join("|")}{" "}
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

function DetailPanel({
  session,
  proposal,
  onChange,
  onAgreeReplace,
}: {
  session: MatchingTabSession;
  proposal: MatchingProposalView | null;
  onChange: (s: MatchingTabSession) => void;
  onAgreeReplace: (token: string) => void;
}) {
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

  return (
    <aside
      className="flex w-80 shrink-0 flex-col gap-2 overflow-auto border-l border-slate-800 p-2 text-[11px]"
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
          {proposal.mapKey.map((k) => k || "∅").join(" / ")}
        </span>
      </div>
      <div className="text-slate-500">
        This key covers {proposal.affectedSourceRows} source row(s)
        {proposal.searchIncomplete ? " · search was cut off" : ""}
      </div>
      <div className="rounded border border-slate-800 bg-slate-950/50 px-2 py-1 text-[10px] text-slate-300">
        {proposalEvidenceSummary(proposal)}
      </div>

      <table className="w-full font-mono text-[10px]">
        <thead>
          <tr className="text-slate-500">
            <th className="text-left">Field</th>
            <th className="text-left">Proposed</th>
            <th className="text-left">Alt</th>
          </tr>
        </thead>
        <tbody>
          {Object.keys(proposed?.fields ?? alts[0]?.fields ?? { id: "" }).map(
            (field) => (
              <tr key={field} className="border-t border-slate-800">
                <td className="py-0.5 text-slate-400">{field}</td>
                <td>{proposed?.fields[field] ?? "—"}</td>
                <td>{alts[0]?.fields[field] ?? "—"}</td>
              </tr>
            ),
          )}
        </tbody>
      </table>

      <ul className="list-disc pl-4 text-slate-400">
        {proposal.evidence.map((e, i) => (
          <li key={i}>
            <span className="text-slate-500">{e.field}:</span> {e.note}
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap gap-1">
        <button
          type="button"
          disabled={!proposed}
          onClick={() =>
            onChange(
              applyDecision(
                session,
                proposal.proposalId,
                "confirm_proposed",
                proposal.proposedCandidateId,
              ),
            )
          }
          className="rounded border border-teal-800/60 px-2 py-0.5 text-teal-100 disabled:opacity-40"
        >
          Use this match
        </button>
        {alts.map((a) =>
          a ? (
            <button
              key={a.candidateId}
              type="button"
              data-testid={`matching-choose-${a.targetId}`}
              onClick={() =>
                onChange(
                  applyDecision(
                    session,
                    proposal.proposalId,
                    "choose_alternative",
                    a.candidateId,
                  ),
                )
              }
              className="rounded border border-slate-600 px-2 py-0.5 text-slate-200"
            >
              Choose {a.targetId}
            </button>
          ) : null,
        )}
        <button
          type="button"
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
