import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { emptyMatchingSession, mapKeyToken } from "./types";
import { buildRelationshipIndex, nextUnresolved, projectMatchingBaseline, relatedSources, type MappingProjection } from "./relationships";
import { applyDecision } from "./reviewLogic";
import type { Workspace } from "../../types/pipeline";

const baseline: MappingProjection = { complete: true, coverage: "project definition", rows: [
  { fromParts: [" a|b ", null], outputValues: ["right", ""] },
  { fromParts: ["saved-only", "DE"], outputValues: ["right", ""] },
] };
let session = emptyMatchingSession({ id: "reverse", title: "reverse", entry: "query", scope: "full", instructionText: "", plan: null, hasUnsavedDecisions: false, chatCollapsed: true });
session.candidates = ["independent-A", "independent-B"].map(id => ({ candidateId: id, targetId: id, outputValues: ["right", ""], fields: {}, evidenceRevision: 1 }));
session.proposals = Array.from({ length: 10000 }, (_, i) => ({ proposalId: `p${i}`, mapKey: i ? [`source${i}`, "DE"] : [" a|b ", null],
  sourceValues: {}, affectedSourceRows: 3, proposedCandidateId: "independent-A", alternativeCandidateIds: ["independent-A", "independent-A"],
  state: "proposed", provenance: "fuzzy", semanticPlanRevision: 1, evidenceRevision: 1, searchIncomplete: true, evidence: [],
  edges: [{ candidateId: "independent-A", metric: "contextual", score: .5, fieldScores: [], origins: ["fuzzy", "llm"] }],
}));
session = applyDecision(session, "p1", "confirm_proposed", "independent-A");
const start = performance.now();
const index = buildRelationshipIndex(session, baseline);
const elapsed = performance.now() - start;
const rows = relatedSources(index, "independent-A", ["right", ""]);
assert.equal(rows.length, 10001, "one sparse edge per source, plus saved-only alias; no duplicate multiorigin edge");
assert.deepEqual(rows[0].badges, ["Suggested", "Existing Mapping"]);
assert.deepEqual(rows[1].badges, ["Suggested", "Confirmed draft"]);
assert.deepEqual(rows[0].origins, ["fuzzy", "llm"]);
assert.equal(relatedSources(index, "independent-B", ["right", ""]).length, 2, "equal outputs do not transfer candidate edges to another identity");
assert.equal(rows.at(-1)?.proposalId, undefined, "saved-only aliases never fabricate an actionable proposal");
assert.notEqual(mapKeyToken([null]), mapKeyToken([""]));
assert.notEqual(mapKeyToken([" a|b ", null]), mapKeyToken(["a", "b|null"]));
assert.equal(nextUnresolved(session, ["p0", "p1", "p2"], "p0", 1), "p2");
assert.equal(nextUnresolved(session, ["p0", "p1", "p2"], "p0", -1), "p2");
assert.equal(session.decisions.length, 1, "index and navigation are read-only");
const workspace = { queries: [], key_maps: [{ id: "seed", name: "unrelated", entries: [], from_column: "vendor_label", to_column: "vendor_id" }] } as unknown as Workspace;
assert.equal(projectMatchingBaseline(workspace, session).complete, false);
assert.equal(projectMatchingBaseline(workspace, { ...session, targetMapId: "seed" }).rows.length, 0);
assert.equal(projectMatchingBaseline({ ...workspace, key_maps: [{ ...workspace.key_maps![0], storage: { kind: "ref", model: "external" } }] } as Workspace,
  { ...session, targetMapId: "seed" }).complete, false, "unsupported storage is not an empty complete baseline");
console.log(`relationships.test.ts: 10,000-source sparse index ${elapsed.toFixed(1)}ms; identity, provenance, coverage and navigation ok`);
