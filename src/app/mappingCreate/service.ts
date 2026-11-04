/**
 * Query-based KeyMap creation (v0.3.1 / ADR-0034).
 * Pure plan / validate / commit — React applies via projectBag fold.
 */
import { emptyKeyMap } from "../../lib/keyMap";
import { slugify, targetKey } from "../../types/pipeline";
import type {
  KeyMapDef,
  Project,
  QueryDef,
  TransformationStep,
  Workspace,
} from "../../types/pipeline";
import type { KeyMapAuthoringContext } from "../../types/generated/KeyMapAuthoringContext";
import { upsertKeyMapIntoProject } from "../keyMap";
import type {
  LastFieldsRestoreProbe,
  LastFieldsRestoreResult,
  MappingCreateApplyIntent,
  MappingCreateApplyResult,
  MappingCreateDraft,
  MappingCreatePlan,
  QueryFieldsPatch,
  SchemaEvidence,
} from "./types";
import { fingerprintSteps, schemaDigest } from "./types";

/**
 * Extract `{{query:…}}` ids — same grammar as Rust `graph::extract_query_placeholders`:
 * text between `{{query:` and `}}`, trim edges; no charset restriction (hyphens ok).
 */
export function extractQueryPlaceholders(rawSql: string): string[] {
  const out: string[] = [];
  let rest = rawSql;
  const open = "{{query:";
  while (true) {
    const start = rest.indexOf(open);
    if (start < 0) break;
    rest = rest.slice(start + open.length);
    const end = rest.indexOf("}}");
    if (end < 0) break;
    const id = rest.slice(0, end).trim();
    if (id) out.push(id);
    rest = rest.slice(end + 2);
  }
  return out;
}

/** @deprecated use extractQueryPlaceholders — kept name for call sites below. */
function sqlPlaceholderQueryIds(rawSql: string): string[] {
  return extractQueryPlaceholders(rawSql);
}

/** Local workspace queries only (no xref:…). */
export function listLocalQueries(workspace: Workspace): QueryDef[] {
  return workspace.queries.filter((q) => !String(q.id).startsWith("xref:"));
}

export function isLocalQueryId(id: string): boolean {
  return Boolean(id.trim()) && !id.startsWith("xref:");
}

/**
 * Direct upstream query ids via FromQuery / Join right / Append / SqlModel /
 * CustomSql `{{query:id}}`. Mirrors supported edges in `graph::direct_deps`.
 */
export function directUpstreamQueryIds(query: QueryDef): string[] {
  const out: string[] = [];
  for (const s of query.steps) {
    if (s.type === "FromQuery") {
      out.push(targetKey(s.payload.query_id));
    } else if (s.type === "Join") {
      out.push(targetKey(s.payload.right_query_id));
    } else if (s.type === "Append") {
      for (const t of s.payload.other_query_ids) out.push(targetKey(t));
    } else if (s.type === "SqlModel" || s.type === "CustomSql") {
      out.push(...sqlPlaceholderQueryIds(s.payload.raw_sql));
    }
  }
  return [...new Set(out.filter(Boolean))];
}

/**
 * Fingerprints for `rootQueryId` and its transitive known upstreams.
 * Missing upstream ids → refuse (conservative outside supported graph).
 */
export function basisQueryFingerprints(
  workspace: Workspace,
  rootQueryId: string,
): { ok: true; defs: Record<string, string> } | { ok: false; error: string } {
  const byId = new Map(workspace.queries.map((q) => [q.id, q]));
  if (!byId.has(rootQueryId)) {
    return { ok: false, error: `Query “${rootQueryId}” is missing.` };
  }
  const defs: Record<string, string> = {};
  const stack = [rootQueryId];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const q = byId.get(id);
    if (!q) {
      return {
        ok: false,
        error: `Upstream query “${id}” is missing — cannot confirm schema basis.`,
      };
    }
    if (String(id).startsWith("xref:")) {
      return {
        ok: false,
        error: `External upstream “${id}” is outside the supported create graph.`,
      };
    }
    defs[id] = fingerprintSteps(q.steps);
    for (const up of directUpstreamQueryIds(q)) stack.push(up);
  }
  return { ok: true, defs };
}

/**
 * Direct dependents of `queryId` via FromQuery / Join right / Append / SqlModel /
 * CustomSql `{{query:id}}`. Not map_id consumers. Same step set as
 * `directUpstreamQueryIds` / Rust `graph::direct_deps`.
 */
export function directQueryConsumers(
  workspace: Workspace,
  queryId: string,
): Array<{ queryId: string; queryName: string; via: string }> {
  const want = queryId.trim();
  if (!want) return [];
  const out: Array<{ queryId: string; queryName: string; via: string }> = [];
  for (const q of workspace.queries) {
    if (q.id === want) continue;
    const vias: string[] = [];
    for (const s of q.steps) {
      if (s.type === "FromQuery" && targetKey(s.payload.query_id) === want) {
        vias.push("FromQuery");
      } else if (
        s.type === "Join" &&
        targetKey(s.payload.right_query_id) === want
      ) {
        vias.push("Join");
      } else if (s.type === "Append") {
        if (
          s.payload.other_query_ids.some((t) => targetKey(t) === want)
        ) {
          vias.push("Append");
        }
      } else if (s.type === "SqlModel" || s.type === "CustomSql") {
        if (sqlPlaceholderQueryIds(s.payload.raw_sql).includes(want)) {
          vias.push(s.type);
        }
      }
    }
    if (vias.length) {
      out.push({
        queryId: q.id,
        queryName: q.name,
        via: [...new Set(vias)].join("+"),
      });
    }
  }
  return out;
}

/**
 * Last-Fields restore: only when last step is SelectColumns, column exists in
 * upstream schema, and is missing from the projection.
 */
export function probeLastFieldsRestore(
  args: LastFieldsRestoreProbe,
): LastFieldsRestoreResult {
  const { query, upstreamColumns, column } = args;
  const col = column.trim();
  if (!col) return { ok: false, error: "Column name is empty." };
  const last = query.steps[query.steps.length - 1];
  if (!last || last.type !== "SelectColumns") {
    return {
      ok: false,
      error:
        "Restore is only available when the last step is Fields (SelectColumns).",
    };
  }
  const up = upstreamColumns.map((c) => c.trim()).filter(Boolean);
  if (!up.length) {
    return {
      ok: false,
      error: "Schema before Fields is unknown — cannot restore safely.",
    };
  }
  const upHits = up.filter((c) => c.toLowerCase() === col.toLowerCase());
  if (upHits.length === 0) {
    return {
      ok: false,
      error: `“${col}” is not in the schema immediately before Fields.`,
    };
  }
  if (upHits.length > 1) {
    return {
      ok: false,
      error: `Column “${col}” is ambiguous in the upstream schema.`,
    };
  }
  const canonical = upHits[0]!;
  const proj = last.payload.columns.map((c) => c.trim());
  if (proj.some((c) => c.toLowerCase() === canonical.toLowerCase())) {
    return {
      ok: false,
      error: `“${canonical}” is already in the Fields projection.`,
    };
  }
  return { ok: true, column: canonical };
}

/** Merge restore picks into one SelectColumns patch (append order preserved). */
export function buildFieldsPatch(args: {
  query: QueryDef;
  upstreamColumns: string[];
  columnsToInclude: string[];
}): { ok: true; patch: QueryFieldsPatch } | { ok: false; error: string } {
  const last = args.query.steps[args.query.steps.length - 1];
  if (!last || last.type !== "SelectColumns") {
    return {
      ok: false,
      error: "Query last step is not Fields — cannot build a Fields patch.",
    };
  }
  const before = [...last.payload.columns];
  const next = [...before];
  const seen = new Set(next.map((c) => c.trim().toLowerCase()));
  for (const raw of args.columnsToInclude) {
    const probed = probeLastFieldsRestore({
      query: args.query,
      upstreamColumns: args.upstreamColumns,
      column: raw,
    });
    if (!probed.ok) return { ok: false, error: probed.error };
    const key = probed.column.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(probed.column);
  }
  if (next.length === before.length) {
    return { ok: false, error: "No Fields changes to apply." };
  }
  return {
    ok: true,
    patch: {
      queryId: args.query.id,
      columns: next,
      before,
      after: next,
    },
  };
}

function uniqueOrdered(cols: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of cols) {
    const t = c.trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/**
 * Keep restores only for queries still in the source/target pair.
 * Pure helper for wizard pair changes and plan build.
 */
export function restoresForPair(
  restores: Record<string, string[]>,
  sourceQueryId: string,
  targetQueryId: string,
): Record<string, string[]> {
  const keep = new Set([sourceQueryId, targetQueryId].filter(Boolean));
  const out: Record<string, string[]> = {};
  for (const [id, cols] of Object.entries(restores)) {
    if (!keep.has(id) || !cols?.length) continue;
    out[id] = [...cols];
  }
  return out;
}

/**
 * Physical KeyMap relation column names — must be unique within the seed CSV
 * header (From… + To). Authoring context keeps the original query column names.
 */
export function allocateMapRelationColumns(args: {
  /** Preferred From names (usually authoring source columns). */
  sourceColumns: string[];
  /** Preferred To name (default `to`). */
  preferredTo?: string;
}): {
  from_columns: string[];
  from_column: string;
  to_column: string;
} {
  const from_columns = uniqueOrdered(args.sourceColumns);
  if (!from_columns.length) {
    throw new Error("allocateMapRelationColumns: empty From columns");
  }
  const used = new Set(from_columns.map((c) => c.toLowerCase()));
  const preferred = (args.preferredTo ?? "to").trim() || "to";
  let to_column = preferred;
  if (used.has(to_column.toLowerCase())) {
    let i = 2;
    while (used.has(`${preferred}_${i}`.toLowerCase())) i += 1;
    to_column = `${preferred}_${i}`;
  }
  return {
    from_columns,
    from_column: from_columns[0]!,
    to_column,
  };
}

/** Observed output ∪ planned restores — UI selection helper only. */
export function selectableOutputColumns(
  evidence: SchemaEvidence,
  restoreColumns: string[] | undefined,
): string[] {
  return uniqueOrdered([
    ...evidence.outputColumns,
    ...(restoreColumns ?? []),
  ]);
}

/** Planned output after applying a Fields patch for this query (if any). */
export function plannedOutputColumns(
  evidence: SchemaEvidence,
  patches: QueryFieldsPatch[],
): string[] {
  const patch = patches.find((p) => p.queryId === evidence.queryId);
  return patch ? [...patch.after] : [...evidence.outputColumns];
}

export function validateDraftSelection(args: {
  workspace: Workspace;
  draft: MappingCreateDraft;
  sourceOutputColumns: string[];
  targetOutputColumns: string[];
}): { ok: true } | { ok: false; error: string } {
  const name = args.draft.name.trim();
  if (!name) return { ok: false, error: "Name the mapping." };
  if (!isLocalQueryId(args.draft.sourceQueryId)) {
    return {
      ok: false,
      error: "Source must be a local workspace query (not an external reference).",
    };
  }
  if (!isLocalQueryId(args.draft.targetQueryId)) {
    return {
      ok: false,
      error: "Target must be a local workspace query (not an external reference).",
    };
  }
  const src = args.workspace.queries.find(
    (q) => q.id === args.draft.sourceQueryId,
  );
  const tgt = args.workspace.queries.find(
    (q) => q.id === args.draft.targetQueryId,
  );
  if (!src) return { ok: false, error: "Source query is missing." };
  if (!tgt) return { ok: false, error: "Target query is missing." };
  const fromCols = uniqueOrdered(args.draft.sourceColumns);
  if (!fromCols.length) {
    return { ok: false, error: "Pick at least one source key column." };
  }
  const toCol = args.draft.targetColumn.trim();
  if (!toCol) return { ok: false, error: "Pick a target value column." };
  for (const c of fromCols) {
    if (
      !args.sourceOutputColumns.some(
        (x) => x.trim().toLowerCase() === c.toLowerCase(),
      )
    ) {
      return {
        ok: false,
        error: `Source column “${c}” is not available after planned Fields changes.`,
      };
    }
  }
  if (
    !args.targetOutputColumns.some(
      (x) => x.trim().toLowerCase() === toCol.toLowerCase(),
    )
  ) {
    return {
      ok: false,
      error: `Target column “${toCol}” is not available after planned Fields changes.`,
    };
  }
  return { ok: true };
}

function newMapId(name: string, existing: Set<string>): string {
  const base = `map_${slugify(name) || "map"}`;
  if (!existing.has(base)) return base;
  for (let i = 2; i < 10_000; i++) {
    const id = `${base}_${i}`;
    if (!existing.has(id)) return id;
  }
  return `${base}_${Date.now().toString(36)}`;
}

function assertEvidenceBasisFresh(
  workspace: Workspace,
  evidence: SchemaEvidence,
): { ok: true } | { ok: false; error: string } {
  const live = basisQueryFingerprints(workspace, evidence.queryId);
  if (!live.ok) return live;
  const ids = new Set([
    ...Object.keys(live.defs),
    ...Object.keys(evidence.basisQueryDefs),
  ]);
  for (const id of ids) {
    if (live.defs[id] !== evidence.basisQueryDefs[id]) {
      const q = workspace.queries.find((x) => x.id === id);
      return {
        ok: false,
        error: `Query “${q?.name ?? id}” (schema basis) changed since describe — refresh and confirm again.`,
      };
    }
  }
  return { ok: true };
}

/**
 * Build a review plan from draft + **observed** schema evidence.
 * Does not mutate Project. Computes patches, then validates From/To on planned output.
 */
export function buildMappingCreatePlan(args: {
  project: Project;
  draft: MappingCreateDraft;
  /** Observed describe evidence (do not pre-merge restores into outputColumns). */
  schemas: SchemaEvidence[];
}): { ok: true; plan: MappingCreatePlan } | { ok: false; error: string } {
  const { project, draft } = args;
  const sourceCols = uniqueOrdered(draft.sourceColumns);
  const targetCol = draft.targetColumn.trim();
  const srcEv = args.schemas.find((s) => s.queryId === draft.sourceQueryId);
  const tgtEv = args.schemas.find((s) => s.queryId === draft.targetQueryId);
  if (!srcEv || !tgtEv) {
    return { ok: false, error: "Schema evidence incomplete — re-describe queries." };
  }
  for (const ev of args.schemas) {
    const basis = assertEvidenceBasisFresh(project.workspace, ev);
    if (!basis.ok) return basis;
  }

  const restores = restoresForPair(
    draft.restoreColumnsByQuery,
    draft.sourceQueryId,
    draft.targetQueryId,
  );
  const patches: QueryFieldsPatch[] = [];
  const patchByQuery = new Map<string, string[]>();
  for (const [qid, cols] of Object.entries(restores)) {
    if (!cols?.length) continue;
    const merged = patchByQuery.get(qid) ?? [];
    patchByQuery.set(qid, uniqueOrdered([...merged, ...cols]));
  }
  for (const [qid, cols] of patchByQuery) {
    const q = project.workspace.queries.find((x) => x.id === qid);
    const ev = args.schemas.find((s) => s.queryId === qid);
    if (!q || !ev) {
      return { ok: false, error: `Cannot restore Fields on missing query “${qid}”.` };
    }
    if (!ev.upstreamColumns) {
      return {
        ok: false,
        error: `Upstream schema for “${q.name}” is unknown — restore blocked.`,
      };
    }
    const built = buildFieldsPatch({
      query: q,
      upstreamColumns: ev.upstreamColumns,
      columnsToInclude: cols,
    });
    if (!built.ok) return built;
    patches.push(built.patch);
  }

  const plannedSource = plannedOutputColumns(srcEv, patches);
  const plannedTarget = plannedOutputColumns(tgtEv, patches);
  const sel = validateDraftSelection({
    workspace: project.workspace,
    draft: { ...draft, sourceColumns: sourceCols, targetColumn: targetCol },
    sourceOutputColumns: plannedSource,
    targetOutputColumns: plannedTarget,
  });
  if (!sel.ok) return sel;

  const existingIds = new Set(
    (project.workspace.key_maps ?? []).map((m) => m.id),
  );
  const mapId = newMapId(draft.name.trim(), existingIds);
  const authoringContext: KeyMapAuthoringContext = {
    source_query_id: draft.sourceQueryId,
    source_columns: sourceCols,
    target_query_id: draft.targetQueryId,
    target_column: targetCol,
  };
  const relation = allocateMapRelationColumns({ sourceColumns: sourceCols });
  const map: KeyMapDef = {
    ...emptyKeyMap(draft.name.trim()),
    id: mapId,
    name: draft.name.trim(),
    entries: [],
    storage: { kind: "seed" },
    from_column: relation.from_column,
    from_columns: relation.from_columns,
    to_column: relation.to_column,
    authoring_context: authoringContext,
  };

  const expectedQueryDefs: Record<string, string> = {};
  for (const ev of args.schemas) {
    Object.assign(expectedQueryDefs, ev.basisQueryDefs);
  }
  for (const id of [
    draft.sourceQueryId,
    draft.targetQueryId,
    ...patches.map((p) => p.queryId),
  ]) {
    const q = project.workspace.queries.find((x) => x.id === id);
    if (!q) return { ok: false, error: `Query “${id}” disappeared.` };
    expectedQueryDefs[id] = fingerprintSteps(q.steps);
  }

  const consumerIds = new Set(patches.map((p) => p.queryId));
  const consumers = [...consumerIds].flatMap((id) =>
    directQueryConsumers(project.workspace, id),
  );
  const warnings = [
    "External databases, existing Joins, and Apply steps will not change.",
    "Changes apply to the in-app project; disk save is separate.",
    "Automatic undo after create is not provided in this slice.",
  ];
  if (consumers.length) {
    warnings.push(
      `Direct consumers of patched queries: ${consumers
        .map((c) => `${c.queryName} (${c.via})`)
        .join(", ")}. Output schema may widen.`,
    );
  } else if (patches.length) {
    warnings.push(
      "No direct workspace dependents found — this does not prove absence of external or unparsed consumers.",
    );
  }

  return {
    ok: true,
    plan: {
      projectId: project.id,
      map,
      authoringContext,
      expectedQueryDefs,
      schemaEvidence: args.schemas,
      patches,
      consumers,
      warnings,
    },
  };
}

function applyPatchToQuery(
  q: QueryDef,
  patch: QueryFieldsPatch,
): { ok: true; query: QueryDef } | { ok: false; error: string } {
  const last = q.steps[q.steps.length - 1];
  if (!last || last.type !== "SelectColumns") {
    return { ok: false, error: `“${q.name}” no longer ends with Fields.` };
  }
  if (JSON.stringify(last.payload.columns) !== JSON.stringify(patch.before)) {
    return {
      ok: false,
      error: `Fields projection on “${q.name}” changed since review.`,
    };
  }
  const steps: TransformationStep[] = [
    ...q.steps.slice(0, -1),
    { type: "SelectColumns", payload: { columns: [...patch.columns] } },
  ];
  return { ok: true, query: { ...q, steps } };
}

/**
 * Compare freshly described evidence digests to the plan (live schema gate).
 * Does not mutate the plan. Call before dispatch after a new describe.
 */
export function assertLiveSchemaMatchesPlan(
  plan: MappingCreatePlan,
  live: SchemaEvidence[],
): { ok: true } | { ok: false; error: string } {
  for (const ev of plan.schemaEvidence) {
    const cur = live.find((s) => s.queryId === ev.queryId);
    if (!cur) {
      return {
        ok: false,
        error: `Schema for “${ev.queryId}” could not be re-confirmed — describe again.`,
      };
    }
    if (cur.digest !== ev.digest) {
      return {
        ok: false,
        error: `Schema for “${ev.queryId}” changed since review — refresh and confirm again.`,
      };
    }
    for (const [id, fp] of Object.entries(ev.basisQueryDefs)) {
      if (cur.basisQueryDefs[id] !== fp) {
        return {
          ok: false,
          error: `Schema basis for “${ev.queryId}” drifted during re-describe — refresh and confirm again.`,
        };
      }
    }
  }
  return { ok: true };
}

/**
 * Freshness + identity checks against the live project (before fold).
 */
export function validateMappingCreatePlan(
  project: Project,
  plan: MappingCreatePlan,
): { ok: true } | { ok: false; error: string } {
  if (project.id !== plan.projectId) {
    return { ok: false, error: "Project changed — re-run review." };
  }
  if ((project.workspace.key_maps ?? []).some((m) => m.id === plan.map.id)) {
    return { ok: false, error: `KeyMap id “${plan.map.id}” already exists.` };
  }
  for (const [qid, fp] of Object.entries(plan.expectedQueryDefs)) {
    const q = project.workspace.queries.find((x) => x.id === qid);
    if (!q) {
      return { ok: false, error: `Query “${qid}” is missing — re-run review.` };
    }
    if (fingerprintSteps(q.steps) !== fp) {
      return {
        ok: false,
        error: `Query “${q.name}” changed since review — refresh and confirm again.`,
      };
    }
  }
  for (const ev of plan.schemaEvidence) {
    const basis = assertEvidenceBasisFresh(project.workspace, ev);
    if (!basis.ok) return basis;
  }
  for (const patch of plan.patches) {
    const q = project.workspace.queries.find((x) => x.id === patch.queryId);
    const ev = plan.schemaEvidence.find((s) => s.queryId === patch.queryId);
    if (!q || !ev?.upstreamColumns) {
      return {
        ok: false,
        error: `Cannot re-validate Fields patch for “${patch.queryId}”.`,
      };
    }
    const rebuilt = buildFieldsPatch({
      query: q,
      upstreamColumns: ev.upstreamColumns,
      columnsToInclude: patch.after.filter((c) => !patch.before.includes(c)),
    });
    if (!rebuilt.ok) return rebuilt;
    if (JSON.stringify(rebuilt.patch.columns) !== JSON.stringify(patch.columns)) {
      return {
        ok: false,
        error: `Fields patch for “${q.name}” is no longer valid — re-run review.`,
      };
    }
  }
  const srcEv = plan.schemaEvidence.find(
    (s) => s.queryId === plan.authoringContext.source_query_id,
  );
  const tgtEv = plan.schemaEvidence.find(
    (s) => s.queryId === plan.authoringContext.target_query_id,
  );
  if (!srcEv || !tgtEv) {
    return { ok: false, error: "Schema evidence incomplete on plan." };
  }
  const plannedSource = plannedOutputColumns(srcEv, plan.patches);
  const plannedTarget = plannedOutputColumns(tgtEv, plan.patches);
  for (const col of plan.authoringContext.source_columns) {
    if (!plannedSource.some((c) => c.toLowerCase() === col.toLowerCase())) {
      return {
        ok: false,
        error: `Source key “${col}” is not available after planned Fields changes.`,
      };
    }
  }
  if (
    !plannedTarget.some(
      (c) =>
        c.toLowerCase() === plan.authoringContext.target_column.toLowerCase(),
    )
  ) {
    return {
      ok: false,
      error: `Target column “${plan.authoringContext.target_column}” is not available after planned Fields changes.`,
    };
  }
  return { ok: true };
}

/**
 * Pure fold: apply patches + upsert map, or leave project untouched.
 */
export function applyMappingCreateOntoProject(
  project: Project,
  intent: MappingCreateApplyIntent,
): { project: Project; result: MappingCreateApplyResult } {
  const { opId, plan } = intent;
  const fresh = validateMappingCreatePlan(project, plan);
  if (!fresh.ok) {
    return {
      project,
      result: { status: "stale", opId, reason: fresh.error },
    };
  }
  try {
    let queries = project.workspace.queries;
    for (const patch of plan.patches) {
      const idx = queries.findIndex((q) => q.id === patch.queryId);
      if (idx < 0) {
        return {
          project,
          result: {
            status: "stale",
            opId,
            reason: `Query “${patch.queryId}” missing during commit.`,
          },
        };
      }
      const applied = applyPatchToQuery(queries[idx]!, patch);
      if (!applied.ok) {
        return {
          project,
          result: { status: "stale", opId, reason: applied.error },
        };
      }
      queries = queries.map((q, i) => (i === idx ? applied.query : q));
    }
    const withQueries: Project = {
      ...project,
      workspace: { ...project.workspace, queries },
    };
    const next = upsertKeyMapIntoProject(withQueries, plan.map);
    return {
      project: next,
      result: {
        status: "applied",
        opId,
        mapId: plan.map.id,
        map: plan.map,
        dirtyDelta: null,
        message: plan.patches.length
          ? `Created “${plan.map.name}” and updated Fields`
          : `Created “${plan.map.name}”`,
      },
    };
  } catch (e) {
    return {
      project,
      result: {
        status: "error",
        opId,
        reason: typeof e === "string" ? e : String(e),
      },
    };
  }
}

/** Columns excluded by last Fields but present upstream. */
export function excludedByLastFields(
  query: QueryDef,
  upstreamColumns: string[],
): string[] {
  const last = query.steps[query.steps.length - 1];
  if (!last || last.type !== "SelectColumns") return [];
  const have = new Set(
    last.payload.columns.map((c) => c.trim().toLowerCase()),
  );
  return upstreamColumns
    .map((c) => c.trim())
    .filter((c) => c && !have.has(c.toLowerCase()));
}

export function makeSchemaEvidence(args: {
  workspace: Workspace;
  queryId: string;
  outputColumns: string[];
  upstreamColumns: string[] | null;
}): SchemaEvidence {
  const basis = basisQueryFingerprints(args.workspace, args.queryId);
  if (!basis.ok) {
    throw new Error(basis.error);
  }
  return {
    queryId: args.queryId,
    outputColumns: args.outputColumns,
    upstreamColumns: args.upstreamColumns,
    digest: schemaDigest([
      ...args.outputColumns,
      ...(args.upstreamColumns ?? []).map((c) => `up:${c}`),
    ]),
    basisQueryDefs: basis.defs,
  };
}

/** Stable fingerprint of local query definitions (wizard workspace-drift detect). */
export function workspaceQueryDefsFingerprint(workspace: Workspace): string {
  return JSON.stringify(
    [...workspace.queries]
      .map((q) => [q.id, fingerprintSteps(q.steps)] as const)
      .sort((a, b) => a[0].localeCompare(b[0])),
  );
}
