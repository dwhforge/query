/** Read-only projections. None of these values can authorize a decision or write. */
import type { Workspace } from "../../types/pipeline";
import { outputValuesEff } from "../../lib/keyMap";
import { resolveTupleMapping } from "../keyMap/tupleMapping";
import { mapKeyToken, type MatchingTabSession, type MatchingTuple } from "./types";

export type MappingProjection = {
  mapId?: string;
  coverage: string;
  complete: boolean;
  rows: { fromParts: MatchingTuple; outputValues: MatchingTuple }[];
};

export function projectMatchingBaseline(workspace: Workspace, session: MatchingTabSession): MappingProjection {
  let map = workspace.key_maps?.find(m => m.id === session.targetMapId);
  if (session.joinBinding) {
    const b = session.joinBinding;
    const resolved = resolveTupleMapping(workspace, { hostQueryId: b.hostQueryId, joinStepIndex: b.joinStepIndex,
      rightQueryId: b.rightQueryId, leftOn: [...b.leftOn], rightOn: [...b.rightOn] });
    if ("error" in resolved) return { coverage: resolved.error, complete: false, rows: [] };
    map = resolved.map;
  }
  if (!map) return session.joinBinding
    ? { coverage: "No compatible Mapping selected; Write would create one.", complete: true, rows: [] }
    : { coverage: "Mapping baseline unavailable: no current bound definition. Missing baseline is not empty.", complete: false, rows: [] };
  if ((map.storage?.kind ?? "seed") !== "seed" || (map.time_mode ?? "none") !== "none") return {
    mapId: map.id, coverage: "Mapping baseline not acquired: source/query/reference/range storage. Complete reverse enumeration is unavailable here.", complete: false, rows: [],
  };
  return { mapId: map.id, coverage: "Complete within the current project Mapping definition (not an unsaved editor draft). Save project separately.", complete: true,
    rows: map.entries.map(e => ({ fromParts: e.from_parts?.length ? e.from_parts : [e.from], outputValues: outputValuesEff(e) })) };
}

export type RelationshipBadge = "Suggested" | "Confirmed draft" | "Existing Mapping";
export type RelatedSource = { key: string; fromParts: MatchingTuple; proposalId?: string;
  badges: RelationshipBadge[]; origins: string[]; occurrences?: number; state?: string };
export type RelationshipIndex = {
  byTarget: Map<string, RelatedSource[]>;
  baselineByOutput: Map<string, RelatedSource[]>;
};

/** O(records + installed edges + decisions + baseline). Never source × target. */
export function buildRelationshipIndex(session: MatchingTabSession, baseline: MappingProjection): RelationshipIndex {
  const byTarget = new Map<string, Map<string, RelatedSource>>();
  const candidates = new Map(session.candidates.map(c => [c.candidateId, c]));
  const decisions = new Map(session.decisions.map(d => [d.proposalId, d]));
  for (const p of session.proposals) {
    const d = decisions.get(p.proposalId);
    const ids = new Set([p.proposedCandidateId, ...p.alternativeCandidateIds, ...(p.edges ?? []).map(e => e.candidateId), d?.candidateId]);
    for (const id of ids) {
      const c = id ? candidates.get(id) : undefined;
      if (!c) continue;
      let sources = byTarget.get(c.targetId);
      if (!sources) byTarget.set(c.targetId, sources = new Map());
      const key = mapKeyToken(p.mapKey);
      const edge = p.edges?.find(e => e.candidateId === id);
      const validDraft = d?.candidateId === id && p.state === "confirmed_in_draft";
      sources.set(key, { key, fromParts: p.mapKey, proposalId: p.proposalId,
        badges: [...(edge || p.alternativeCandidateIds.includes(id!) || p.proposedCandidateId === id ? ["Suggested" as const] : []),
          ...(validDraft ? ["Confirmed draft" as const] : [])],
        origins: edge?.origins ?? [p.provenance], occurrences: p.affectedSourceRows, state: p.state });
    }
  }
  const baselineByOutput = new Map<string, RelatedSource[]>();
  for (const row of baseline.rows) {
    const output = mapKeyToken(row.outputValues);
    const rows = baselineByOutput.get(output) ?? [];
    rows.push({ key: mapKeyToken(row.fromParts), fromParts: row.fromParts, badges: ["Existing Mapping"], origins: [] });
    baselineByOutput.set(output, rows);
  }
  return { byTarget: new Map([...byTarget].map(([id, rows]) => [id, [...rows.values()]])), baselineByOutput };
}

/** Output-group evidence is explicitly not attribution to an independent target. */
export function relatedSources(index: RelationshipIndex, targetId: string, outputs: MatchingTuple): RelatedSource[] {
  const merged = new Map((index.byTarget.get(targetId) ?? []).map(r => [r.key, { ...r, badges: [...r.badges] }]));
  for (const baseline of index.baselineByOutput.get(mapKeyToken(outputs)) ?? []) {
    const prior = merged.get(baseline.key);
    if (prior) prior.badges = [...new Set([...prior.badges, ...baseline.badges])];
    else merged.set(baseline.key, baseline);
  }
  return [...merged.values()];
}

export function nextUnresolved(session: MatchingTabSession, ids: string[], current: string | null, direction: 1 | -1): string | null {
  const decided = new Set(session.decisions.map(d => d.proposalId));
  const proposals = new Map(session.proposals.map(p => [p.proposalId, p]));
  const start = ids.indexOf(current ?? "");
  for (let step = 1; step <= ids.length; step++) {
    const id = ids[(start + direction * step + ids.length * 2) % ids.length]!;
    const p = proposals.get(id);
    if (id !== current && p && !decided.has(id) && p.state !== "saved" && p.state !== "stale") return id;
  }
  return null;
}
