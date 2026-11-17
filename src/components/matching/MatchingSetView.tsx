/** Set-first Matching result. No new mutation or commit authority. */
import { useMemo, useState } from "react";
import type { MatchingTabSession } from "../../app/matching/types";
import { evaluationFromSession } from "../../app/matching/sessionEvaluation";
import { compareSetEvaluations, type SetEvaluation, type SetEvaluationRow } from "../../app/matching/setEvaluation";
import { previewBulkConfirm, applyBulkConfirm, applyDecision, deriveMatchingReview, buildFinalDiff, summarizeFinalDiff } from "../../app/matching/reviewLogic";
import { tupleCell } from "../../lib/joinLensTuple";
import { DEFAULT_ESTIMATE_SAMPLE_PERCENT, estimateAcquiredEvaluation, type SampleEstimate } from "../../app/matching/estimateSampling";

type Props = {
  session: MatchingTabSession;
  checked: string[];
  onChecked: (ids: string[]) => void;
  onChange: (session: MatchingTabSession) => void;
  onCommit: () => void;
  commitBlocked: boolean;
  commitReason?: string | null;
  previous: SetEvaluation | null;
  onPin: (evaluation: SetEvaluation | null) => void;
};

const categories = ["all", "proposed", "ambiguous", "below_threshold", "no_proposal", "incomplete", "confirmed_draft", "other"] as const;
type Category = typeof categories[number];
const tuple = (parts: readonly (string | null)[]) => parts.map(tupleCell).join(" / ");
function category(row: SetEvaluationRow): Category {
  if (row.searchIncomplete && row.outcome === "proposed") return "incomplete";
  if (["saved", "stale", "deferred", "rejected"].includes(row.outcome)) return "other";
  return row.outcome as Category;
}

export function MatchingSetView({ session, checked, onChecked, onChange, onCommit, commitBlocked, commitReason, previous, onPin }: Props) {
  const evaluation = useMemo(() => evaluationFromSession(session), [session]);
  const [filter, setFilter] = useState<Category>("all");
  const [query, setQuery] = useState("");
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [showReview, setShowReview] = useState(false);
  const [estimatePercent, setEstimatePercent] = useState(DEFAULT_ESTIMATE_SAMPLE_PERCENT);
  const [estimate, setEstimate] = useState<SampleEstimate | null>(null);
  const [estimateRun, setEstimateRun] = useState<string | null>(null);
  if (!evaluation) return null;
  const current = evaluation;
  // Estimates are invalidated by changed run evidence, rules, or draft decisions.
  const estimateIdentity = JSON.stringify([current.runId, current.planRevision,
    current.rows.map(r => [r.sourceKey, r.outcome, r.searchIncomplete, r.candidateId])]);
  const activeEstimate = estimateRun === estimateIdentity ? estimate : null;
  const stats = current.stats;
  // Count *evaluated/scored* evidence separately from eligible suggestions.
  // A candidate displayed below threshold is evidence, not a proposed Mapping.
  const evidenceCounts = new Map(session.proposals.map(p => {
    const scored = p.edges?.filter(edge => edge.score != null && Number.isFinite(edge.score)) ?? [];
    const above = session.basicRun
      ? scored.filter(edge => edge.score! >= session.basicRun!.scoreCutoff).length : null;
    return [p.proposalId, { scored: scored.length, above, unknown: p.coverage?.competitorsUnknown ?? 0 }] as const;
  }));
  const totalScored = [...evidenceCounts.values()].reduce((sum, counts) => sum + counts.scored, 0);
  const totalAbove = session.basicRun
    ? [...evidenceCounts.values()].reduce((sum, counts) => sum + (counts.above ?? 0), 0) : null;
  const inspected = inspectedId ? session.proposals.find(p => p.proposalId === inspectedId) : undefined;
  const inspectedDecision = inspected && session.decisions.find(d => d.proposalId === inspected.proposalId);
  const availableCandidates = inspected?.alternativeCandidateIds.flatMap(id => {
    const candidate = session.candidates.find(c => c.candidateId === id);
    return candidate ? [candidate] : [];
  }) ?? [];
  const selectedCandidate = availableCandidates.find(c => c.candidateId === selectedCandidateId);
  const inspectedCanConfirm = !!inspected && !!selectedCandidate && !inspectedDecision &&
    !session.commitLifecycle && inspected.state !== "stale" && inspected.state !== "saved";
  const finalDiff = buildFinalDiff(session);
  const finalSum = summarizeFinalDiff(finalDiff);
  const confirmedCount = session.decisions.filter(d => d.kind === "confirm_proposed" || d.kind === "choose_alternative").length;
  const filtered = current.rows.filter(r =>
    (filter === "all" || category(r) === filter) &&
    (!query || `${tuple(r.left)} ${r.right ? tuple(r.right) : ""}`.toLowerCase().includes(query.toLowerCase())));
  const compare = previous ? compareSetEvaluations(previous, current) : null;
  const bulk = previewBulkConfirm(session, "selection", checked);
  const statusCount: Record<Category, number> = {
    all: stats.acquiredKeys, proposed: stats.proposed, ambiguous: stats.ambiguous,
    no_proposal: stats.noProposal, below_threshold: stats.belowThreshold, incomplete: stats.incomplete,
    confirmed_draft: stats.confirmedDraft, other: stats.otherDecided,
  };
  const labels: Record<Category, string> = {
    all: "All", proposed: "Proposed", ambiguous: "Ambiguous",
    no_proposal: "No candidates found", below_threshold: "Candidates below threshold", incomplete: "Incomplete",
    confirmed_draft: "Confirmed draft", other: "Other decisions",
  };
  const complete = current.sourceComplete === true && current.targetComplete === true;
  const allVisible = filtered.length > 0 && filtered.every(r => checked.includes(r.id));
  const toggleAll = () => onChecked(allVisible
    ? checked.filter(id => !filtered.some(r => r.id === id))
    : [...new Set([...checked, ...filtered.map(r => r.id)])]);

  return <section className="relative flex min-h-0 flex-1 flex-col" aria-label="Matching relationship set" data-testid="matching-set-view">
    <div className="shrink-0 border-b border-slate-800 px-3 py-2 text-[11px]">
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-[12px] text-teal-100">Relationship set · {current.producer === "basic" ? "Basic" : "Advanced"}</strong>
        <span className="text-slate-400">Rule revision {current.planRevision} · {current.sourceScope} LEFT scope · {stats.acquiredKeys} keys / {stats.acquiredSourceRows} input rows</span>
        <button type="button" className="ml-auto rounded border border-slate-700 px-2 py-1 text-teal-100"
          onClick={() => onPin(current)}>Pin this evaluation as A</button>
      </div>
      <p className={complete ? "mt-1 text-slate-400" : "mt-1 text-amber-200"} role="status">
        {complete ? "Acquisition complete for the requested, bounded scope." : "Incomplete or unknown acquisition coverage."}
        {stats.notAcquired == null ? " Unacquired LEFT count unknown." : stats.notAcquired ? ` ${stats.notAcquired} LEFT groups not acquired.` : ""}
        {" "}Results describe proposed relationships, NOT executed JOIN impact or saved Mapping.
      </p>
      <p className="mt-1 text-slate-400" data-testid="matching-set-evidence-totals">
        {totalScored} scored candidate pairs across acquired LEFT keys
        {totalAbove != null ? ` · ${totalAbove} above the Basic suggestion threshold` : ""}
        {` · ${stats.proposed} LEFT keys with a proposed relationship`}. These are different counts.
      </p>
    </div>
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-800 px-3 py-1.5 text-[11px]" aria-label="Sample Estimate settings">
      <span className="font-medium text-slate-200">Estimate · sample</span>
      <label htmlFor="matching-estimate-percent" className="text-slate-400">Sample % of acquired LEFT keys</label>
      <input id="matching-estimate-percent" type="number" min={1} max={100} step={1}
        data-testid="matching-estimate-percent" value={estimatePercent}
        onChange={e => { setEstimatePercent(Number(e.target.value)); setEstimate(null); }}
        className="w-16 rounded border border-slate-700 bg-slate-950 px-1.5 py-1" />
      <button type="button" data-testid="matching-estimate-run"
        disabled={!Number.isFinite(estimatePercent) || estimatePercent < 1 || estimatePercent > 100 || !stats.acquiredKeys}
        onClick={() => { setEstimate(estimateAcquiredEvaluation(current, estimatePercent)); setEstimateRun(estimateIdentity); }}
        className="rounded border border-slate-700 px-2 py-1 text-slate-200 disabled:opacity-40">Estimate sample</button>
      <span className="text-slate-500">Default 5%. Optional sampled projection, not full Evaluate.</span>
      {activeEstimate && <p className="w-full text-amber-200" role="status" data-testid="matching-estimate-result">
        Sampled {activeEstimate.sampledKeys}/{activeEstimate.acquiredKeys} acquired LEFT keys ({activeEstimate.actualPercent.toFixed(1)}% actual).
        {" "}Observed in sample: {activeEstimate.sampled.proposed} proposed, {activeEstimate.sampled.ambiguous} ambiguous,
        {" "}{activeEstimate.sampled.below_threshold} below threshold, {activeEstimate.sampled.no_proposal} with no candidates, {activeEstimate.sampled.incomplete} incomplete.
        {" "}Extrapolation is illustrative for acquired keys only, NOT a full-dataset result or a preflight Host cost estimate.
      </p>}
    </div>
    <div className="grid shrink-0 grid-cols-2 gap-2 border-b border-slate-800 p-2 sm:grid-cols-4 lg:grid-cols-8" aria-label="Matching evaluation statistics">
      {([
        ["Proposed", stats.proposed], ["Ambiguous", stats.ambiguous], ["Below threshold", stats.belowThreshold], ["No candidates found", stats.noProposal],
        ["Incomplete", stats.incomplete], ["Confirmed draft", stats.confirmedDraft],
        ["RIGHT outputs used", stats.distinctProposedOutputs], ["Many-to-one groups", stats.manyToOneOutputGroups],
      ] as [string, number][]).map(([label, value]) =>
        <div key={label} className="rounded border border-slate-800 bg-slate-950/50 px-2 py-1.5">
          <div className="text-[18px] font-semibold text-slate-100">{value}</div><div className="text-[10px] text-slate-400">{label}</div>
        </div>)}
    </div>
    {previous && <div className="shrink-0 border-b border-slate-800 px-3 py-1.5 text-[11px]" data-testid="matching-set-comparison">
      {compare?.comparable ? <>
        <strong className="text-teal-100">A/B indicative comparison</strong>
        <span className="ml-2">{compare.unchanged} unchanged · {compare.newProposals} gained · {compare.lostProposals} lost · {compare.changed} changed</span>
        <p className="text-amber-200">{compare.warning}</p>
      </> : <span className="text-amber-200">A/B cannot be compared: {compare && !compare.comparable ? compare.reason : "Unavailable"}</span>}
      <button type="button" className="ml-3 underline" onClick={() => onPin(null)}>Clear A</button>
    </div>}
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-800 px-3 py-2 text-[11px]">
      <input type="search" aria-label="Search relationship set" placeholder="Search LEFT / RIGHT values" value={query}
        onChange={e => setQuery(e.target.value)} className="min-w-[210px] rounded border border-slate-700 bg-slate-950 px-2 py-1" />
      <div className="flex flex-wrap gap-1" aria-label="Relationship outcome filters">
        {categories.map(c => <button type="button" key={c} onClick={() => setFilter(c)}
          aria-pressed={filter === c}
          className={`rounded border px-2 py-1 ${filter === c ? "border-teal-600 text-teal-100" : "border-slate-700 text-slate-400"}`}>
          {labels[c]} · {statusCount[c]}
        </button>)}
      </div>
    </div>
    <div className="min-h-0 flex-1 overflow-auto" role="region" aria-label="Proposed relationships table">
      <table className="w-full border-collapse text-left text-[11px]">
        <thead className="sticky top-0 z-10 bg-[#0b1220] text-slate-400"><tr className="border-b border-slate-700">
          <th className="p-2"><input type="checkbox" aria-label="Select all visible LEFT keys" checked={allVisible} onChange={toggleAll} /></th>
          <th className="p-2">LEFT key</th><th className="p-2">Best RIGHT evidence / proposed output</th>
          <th className="p-2">Score</th><th className="p-2">Outcome</th><th className="p-2">Investigate</th>
        </tr></thead>
        <tbody>{filtered.map(row => <tr key={row.sourceKey} className="border-b border-slate-800 hover:bg-slate-900/70">
          <td className="p-2"><input type="checkbox" aria-label={`Select LEFT ${tuple(row.left)}`} checked={checked.includes(row.id)}
            onChange={() => onChecked(checked.includes(row.id) ? checked.filter(id => id !== row.id) : [...checked, row.id])} /></td>
          <td className="p-2"><div className="font-mono text-slate-100">{tuple(row.left)}</div><small className="text-slate-500">{row.sourceRows} source rows</small></td>
          <td className="p-2 font-mono">{row.right ? tuple(row.right) : <span className="text-slate-500">—</span>}</td>
          <td className="p-2">{row.score === null ? "Unknown" : row.score.toFixed(3)}</td>
          <td className="p-2"><span className={category(row) === "proposed" ? "text-teal-200" : category(row) === "incomplete" ? "text-amber-200" : "text-slate-300"}>
            {labels[category(row)]}
          </span><div className="mt-0.5 text-[10px] text-slate-500">
            {evidenceCounts.get(row.id)?.scored ?? 0} scored
            {evidenceCounts.get(row.id)?.above != null ? ` · ${evidenceCounts.get(row.id)!.above} above threshold` : ""}
            {(evidenceCounts.get(row.id)?.unknown ?? 0) > 0 ? ` · ${evidenceCounts.get(row.id)!.unknown} unknown` : ""}
          </div></td>
          <td className="p-2"><button type="button" className="rounded border border-slate-700 px-2 py-1 text-teal-100"
            onClick={() => { setInspectedId(row.id); setSelectedCandidateId(null); }}>Details</button></td>
        </tr>)}</tbody>
      </table>
      {!filtered.length && <p className="p-4 text-center text-slate-400">No LEFT keys match these filters within the acquired scope.</p>}
    </div>
    <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-slate-700 bg-[#0b1220] px-3 py-2 text-[11px]">
      <span className="text-slate-400">{checked.length} selected · {bulk.keyCount} high-confidence eligible · {bulk.excluded.length} excluded</span>
      <button type="button" data-testid="matching-set-bulk-confirm" disabled={!bulk.keyCount || !!session.commitLifecycle}
        onClick={() => onChange(applyBulkConfirm(session, bulk))}
        className="rounded border border-teal-700 px-2 py-1 text-teal-100 disabled:opacity-40">Confirm {bulk.keyCount} eligible</button>
      <button type="button" data-testid="matching-set-review" onClick={() => setShowReview(true)}
        className="ml-auto rounded border border-slate-700 px-3 py-1 text-slate-200">
        Review {confirmedCount} decisions
      </button>
      <button type="button" data-testid="matching-set-write" onClick={onCommit}
        disabled={commitBlocked || confirmedCount === 0} title={commitReason ?? undefined}
        className="rounded border border-amber-700 px-3 py-1 text-amber-100 disabled:opacity-40">
        Write {confirmedCount} to Mapping
      </button>
    </footer>
    {inspected && <div className="absolute inset-0 z-20 flex justify-end bg-slate-950/55" data-testid="matching-set-details-backdrop">
      <aside className="flex h-full w-full max-w-[470px] flex-col border-l border-slate-700 bg-[#0b1220] shadow-xl"
        aria-label="Relationship details" data-testid="matching-set-details">
        <header className="flex shrink-0 items-center justify-between border-b border-slate-700 p-3">
          <strong className="text-[13px] text-teal-100">Relationship details</strong>
          <button type="button" className="rounded border border-slate-700 px-2 py-1 text-[11px]" onClick={() => setInspectedId(null)}>Close</button>
        </header>
        <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3 text-[11px]">
          <div className="rounded border border-slate-800 p-3"><div className="text-slate-400">LEFT · complete key</div>
            <div className="mt-1 font-mono text-slate-100">{tuple(inspected.mapKey)}</div>
            <div className="mt-1 text-slate-500">{inspected.affectedSourceRows} source rows</div>
          </div>
          <p className="text-slate-400">Choose a RIGHT candidate to stage an explicit decision. Browsing never confirms or writes.</p>
          {availableCandidates.map(candidate => {
            const edge = inspected.edges?.find(e => e.candidateId === candidate.candidateId);
            return <button type="button" key={candidate.candidateId} aria-pressed={selectedCandidateId === candidate.candidateId}
              onClick={() => setSelectedCandidateId(candidate.candidateId)}
              className={`block w-full rounded border p-3 text-left ${selectedCandidateId === candidate.candidateId ? "border-teal-500 bg-teal-950/30" : "border-slate-700"}`}>
              <div className="font-mono text-slate-100">{tuple(candidate.outputValues)}</div>
              <div className="mt-1 text-slate-400">{edge?.score == null ? "Score unknown" : `Similarity ${edge.score.toFixed(3)} (not a probability)`}</div>
            </button>;
          })}
          {!availableCandidates.length && <div className="rounded border border-amber-900/50 p-3 text-amber-200">No acquired selectable RIGHT candidate for this LEFT. The shortlist is not a complete dictionary.</div>}
          {inspectedDecision && <div className="rounded border border-teal-900/60 p-2 text-teal-100">
            <span>Already reviewed: {inspectedDecision.kind}.</span>
            <button type="button" data-testid="matching-set-undo-single" className="ml-2 rounded border border-slate-600 px-2 py-1"
              onClick={() => { const decisions = session.decisions.filter(d => d.proposalId !== inspected.proposalId);
                onChange(deriveMatchingReview({ ...session, decisions, hasUnsavedDecisions: decisions.length > 0 }));
              }}>Undo decision</button>
          </div>}
          <p className="text-slate-500">Only acquired, source-bound candidates may be confirmed here. Additional verified lookup and exceptional decisions remain in the legacy review implementation until migrated.</p>
        </div>
        <footer className="flex shrink-0 justify-end gap-2 border-t border-slate-700 p-3">
          <button type="button" className="rounded border border-slate-700 px-3 py-1" onClick={() => setInspectedId(null)}>Cancel</button>
          <button type="button" data-testid="matching-set-confirm-single" disabled={!inspectedCanConfirm}
            className="rounded border border-teal-700 px-3 py-1 text-teal-100 disabled:opacity-40"
            onClick={() => { if (!inspected || !selectedCandidate) return;
              const next = applyDecision(session, inspected.proposalId, selectedCandidate.candidateId === inspected.proposedCandidateId ? "confirm_proposed" : "choose_alternative", selectedCandidate.candidateId);
              if (next !== session) { onChange(deriveMatchingReview(next)); setInspectedId(null); }
            }}>Confirm selected</button>
        </footer>
      </aside>
    </div>}
    {showReview && <div className="absolute inset-0 z-20 flex justify-end bg-slate-950/55">
      <aside className="flex h-full w-full max-w-[560px] flex-col border-l border-slate-700 bg-[#0b1220] shadow-xl"
        aria-label="Review Mapping changes" data-testid="matching-set-review-panel">
        <header className="flex items-center justify-between border-b border-slate-700 p-3">
          <strong className="text-[13px] text-teal-100">Review Mapping changes</strong>
          <button type="button" className="rounded border border-slate-700 px-2 py-1 text-[11px]" onClick={() => setShowReview(false)}>Close</button>
        </header>
        <div className="border-b border-slate-700 p-3 text-[11px] text-slate-400">{finalSum.adds} additions · {finalSum.changes} changes · {finalSum.unresolved} unresolved · {confirmedCount} confirmed drafts. Preview is not a write authorization.</div>
        <div className="min-h-0 flex-1 space-y-2 overflow-auto p-3 text-[11px]">{finalDiff.map((row, i) =>
          <div key={i} className="rounded border border-slate-800 p-2 font-mono">
            <span className="text-slate-400">{row.kind} · {row.origin}</span>
            <div className="mt-1">{tuple(row.mapKey)} → {row.newOutputs ? tuple(row.newOutputs) : "—"}</div>
          </div>)}
          {!finalDiff.length && <p className="text-slate-400">No acquired changes to review.</p>}
        </div>
        <footer className="flex justify-end gap-2 border-t border-slate-700 p-3">
          <button type="button" className="rounded border border-slate-700 px-3 py-1" onClick={() => setShowReview(false)}>Back</button>
          <button type="button" data-testid="matching-set-review-write" disabled={commitBlocked || confirmedCount === 0}
            title={commitReason ?? undefined} onClick={onCommit}
            className="rounded border border-amber-700 px-3 py-1 text-amber-100 disabled:opacity-40">Write {confirmedCount} to Mapping</button>
        </footer>
      </aside>
    </div>}
  </section>;
}
