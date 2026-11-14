import type { ConnectionDef, SourceDef, Workspace } from "../types/pipeline";
import type { JoinTupleReport, ProjectRefContext } from "./bridge";
import { confirmTupleMapping, type LensTupleMapping } from "./joinLensConfirm";
import { joinTupleLlmPrompt, parseSuggestedTuplePairs } from "./joinLensLlmPrompt";
import { tupleIdentity, type TupleParts } from "./joinLensTuple";

/** Local-only exact context token. Never include this token in a model prompt or telemetry.
 * Sorted object keys avoid invalidating on equivalent object reconstruction; array order
 * remains significant. Full IR includes upstream queries, mappings and Apply bindings.
 * Connection secrets intentionally participate in invalidation, but never leave this API.
 */
export function batchContextFingerprint(workspace: Workspace, hostQueryId: string, joinStepIndex: number,
  connections: ConnectionDef[], sources: SourceDef[], projectRef?: ProjectRefContext): string {
  return JSON.stringify({ workspace, hostQueryId, joinStepIndex, connections, sources, projectRef }, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
}

export const BATCH_FUZZY_ALTERNATIVES = 8;
export const BATCH_LLM_GROUPS = 4;
export const BATCH_LLM_CANDIDATES = 12;
export const BATCH_LLM_BUDGET = 10_000;
export const BATCH_HISTORY_MESSAGES = 6;
export const BATCH_MESSAGE_CHARS = 4_000;

export type TupleBatchAlternative = {
  rightIndex: number; origins: ("fuzzy" | "llm" | "manual")[]; why?: string;
};
export type TupleBatchProposal = {
  id: string; sourceIndex: number; alternatives: TupleBatchAlternative[];
  selected: number | null; decision: "pending" | "accepted" | "skipped";
  omittedFuzzy: number;
};

/** One decision per complete source identity, never one scalar proposal per field. */
export function tupleBatchProposals(report: JoinTupleReport, cutoff: number): TupleBatchProposal[] {
  const seen = new Set<string>();
  return report.sources.flatMap((group, sourceIndex) => {
    const id = tupleIdentity(group.source.parts);
    if (seen.has(id)) return [];
    seen.add(id);
    const indices = [...new Set(group.candidates.filter(c => c.score != null && c.score >= cutoff
      && !!report.right_universe[c.right_index]).map(c => c.right_index))];
    return [{ id, sourceIndex, selected: null, decision: "pending" as const,
      alternatives: indices.slice(0, BATCH_FUZZY_ALTERNATIVES).map(rightIndex => ({ rightIndex, origins: ["fuzzy" as const] })),
      omittedFuzzy: Math.max(0, indices.length - BATCH_FUZZY_ALTERNATIVES) }];
  });
}

export function chooseBatchTarget(proposal: TupleBatchProposal, rightIndex: number): TupleBatchProposal {
  if (proposal.decision !== "pending") return proposal;
  return { ...proposal, selected: rightIndex, alternatives: proposal.alternatives.some(a => a.rightIndex === rightIndex)
    ? proposal.alternatives : [...proposal.alternatives, { rightIndex, origins: ["manual"] }] };
}

export function collectTupleBatch(report: JoinTupleReport, proposals: TupleBatchProposal[]): LensTupleMapping[] | { error: string } {
  const result: LensTupleMapping[] = [];
  const seen = new Set<string>();
  for (const p of proposals.filter(p => p.decision === "accepted")) {
    const source = report.sources[p.sourceIndex]?.source.parts;
    const target = p.selected == null ? undefined : report.right_universe[p.selected]?.parts;
    if (!source || !target || tupleIdentity(source) !== p.id) return { error: "Missing or changed complete tuple selection." };
    if (seen.has(p.id)) return { error: "Duplicate/conflicting source decisions must be resolved before applying." };
    const mapping = confirmTupleMapping(report.left_on, report.right_on, source, target);
    if ("error" in mapping) return mapping;
    seen.add(p.id);
    result.push(mapping);
  }
  return result;
}

export type TupleBatchPrompt = {
  prompt: string;
  groups: { source: TupleParts; allowed: TupleParts[] }[];
  omittedSources: number; omittedCandidates: number;
};

/** Bound both axes and total message length; allowlists are exactly the sent rows.
 * Reuse Suggest Right's prompt and parser unchanged; no connection/IR data is sent.
 */
export function tupleBatchLlmPrompt(report: JoinTupleReport, proposals: TupleBatchProposal[], focusSourceId?: string | null): TupleBatchPrompt {
  let prompt = "Review independent source groups below. Propose alternatives, never accept mappings. Return one JSON pairs object for all groups.\n";
  const groups: TupleBatchPrompt["groups"] = [];
  let omittedCandidates = 0;
  const pending = proposals.filter(p => p.decision === "pending");
  // Selecting a queue record makes any retrieved source reachable without
  // silently skipping the earlier pending records to get past the group cap.
  const focusIndex = pending.findIndex(p => p.id === focusSourceId);
  if (focusIndex > 0) pending.unshift(...pending.splice(focusIndex, 1));
  for (const p of pending) {
    if (groups.length >= BATCH_LLM_GROUPS) break;
    const group = report.sources[p.sourceIndex];
    if (!group) continue;
    const ranked = [...new Set([...group.candidates.map(c => c.right_index), ...report.right_universe.map((_, i) => i)])];
    const right_universe = ranked.slice(0, BATCH_LLM_CANDIDATES).flatMap(i => report.right_universe[i] ? [report.right_universe[i]!] : []);
    const built = joinTupleLlmPrompt({ ...report, right_universe }, group.source.parts);
    if (!built.allowed.length || prompt.length + built.prompt.length > BATCH_LLM_BUDGET - 200) continue;
    prompt += `\nSource group ${groups.length + 1}:\n${built.prompt}\n`;
    groups.push({ source: group.source.parts, allowed: built.allowed });
    omittedCandidates += report.right_universe.length - built.allowed.length;
  }
  const omittedSources = pending.length - groups.length;
  prompt += `\nIncomplete coverage: omitted ${omittedSources} pending source groups and ${omittedCandidates} retrieved candidate slots in included groups. Retrieval itself may be truncated.`;
  return { prompt, groups, omittedSources, omittedCandidates };
}

export function mergeTupleBatchLlm(report: JoinTupleReport, proposals: TupleBatchProposal[], text: string, sent: TupleBatchPrompt) {
  let added = 0, duplicates = 0, conflicts = 0;
  const next = proposals.map(p => ({ ...p, alternatives: p.alternatives.map(a => ({ ...a, origins: [...a.origins] })) }));
  const indices = new Map(report.right_universe.map((row, i) => [tupleIdentity(row.parts), i]));
  for (const group of sent.groups) {
    const proposal = next.find(p => p.id === tupleIdentity(group.source));
    if (!proposal) continue;
    for (const pair of parseSuggestedTuplePairs(text, group.source, group.allowed)) {
      const rightIndex = indices.get(tupleIdentity(pair.to_parts));
      if (rightIndex == null) continue;
      if (proposal.decision !== "pending") {
        if (proposal.selected === rightIndex) duplicates++; else conflicts++;
        continue; // Never overwrite accepted/skipped decisions, even with a later model response.
      }
      const existing = proposal.alternatives.find(a => a.rightIndex === rightIndex);
      if (existing) {
        duplicates++;
        if (!existing.origins.includes("llm")) existing.origins.push("llm");
        existing.why = pair.why;
      } else {
        proposal.alternatives.push({ rightIndex, origins: ["llm"], why: pair.why });
        added++;
      }
    }
  }
  return { proposals: next, added, duplicates, conflicts };
}
