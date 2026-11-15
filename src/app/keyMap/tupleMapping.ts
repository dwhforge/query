import type { KeyMapDef, Workspace } from "../../types/pipeline";
import { emptyKeyMap, findApplyKeyMapIdForJoin, fromColumnsEff, outputColumnsEff, outputValuesEff, validateKeyMapEntries } from "../../lib/keyMap";
import { confirmTupleMapping, type LensTupleMapping } from "../../lib/joinLensConfirm";
import { tupleIdentity } from "../../lib/joinLensTuple";
import type { KeyMapJoinCtx } from "./types";
import { resolveJoinStepFromCtx } from "./service";

/** Read-only selection shared by batch preparation and the workbench baseline. */
export function resolveTupleMapping(workspace: Workspace, ctx: Pick<KeyMapJoinCtx, "hostQueryId" | "joinStepIndex" | "rightQueryId" | "leftOn" | "rightOn" | "probeSide">, strictAttached = true):
  { map: KeyMapDef | undefined; name: string; fromColumns: string[]; outputColumns: string[] } | { error: string } {
  const fromColumns = ctx.leftOn.map((column, i) => `from_${i + 1}_${column}`);
  const outputColumns = ctx.rightOn.map((column, i) => `to_${i + 1}_${column}`);
  const name = `Join aliases ${ctx.hostQueryId} (${ctx.leftOn.join(", ")}) → ${ctx.rightQueryId} (${ctx.rightOn.join(", ")})`;
  const maps = workspace.key_maps ?? [];
  const preferredId = findApplyKeyMapIdForJoin(workspace, ctx);
  const compatible = (map: KeyMapDef) => (map.storage?.kind ?? "seed") === "seed"
    && (map.time_mode ?? "none") === "none"
    && tupleIdentity(fromColumnsEff(map)) === tupleIdentity(fromColumns)
    && tupleIdentity(outputColumnsEff(map)) === tupleIdentity(outputColumns);
  const preferred = maps.find(m => m.id === preferredId);
  if (strictAttached && preferredId && (!preferred || !compatible(preferred))) return {
    error: "The Join already uses an incompatible Mapping. Review it before applying full tuples; no Mapping was changed.",
  };
  return { map: preferred && compatible(preferred) ? preferred : maps.find(m => m.name === name && compatible(m)), name, fromColumns, outputColumns };
}

/**
 * Pure, all-or-nothing batch preparation. Intermediate maps are private values,
 * never project/editor updates. The caller must resolve/fold Apply before commit.
 * Tuple identity is exact (including significant whitespace), not display text.
 */
export function planBatchTupleMapping(workspace: Workspace, ctx: KeyMapJoinCtx, selections: LensTupleMapping[]):
  { map: KeyMapDef; joinCtx: KeyMapJoinCtx } | { error: string } {
  if (!selections.length) return { error: "Select at least one complete tuple before applying a batch." };
  const seen = new Set<string>();
  for (const selection of selections) {
    if (tupleIdentity(ctx.leftOn) !== tupleIdentity(selection.leftOn)
      || tupleIdentity(ctx.rightOn) !== tupleIdentity(selection.rightOn)) {
      return { error: "Join fields changed. Reopen Find Matches before applying a batch." };
    }
    const valid = confirmTupleMapping(selection.leftOn, selection.rightOn, selection.fromParts, selection.outputValues);
    if ("error" in valid) return { error: `Source tuple ${tupleIdentity(selection.fromParts)}: ${valid.error}` };
    const key = tupleIdentity(selection.fromParts);
    if (seen.has(key)) return { error: `Batch contains duplicate From tuple ${key}. Select only one target for each full source tuple.` };
    seen.add(key);
  }
  const resolved = resolveTupleMapping(workspace, ctx);
  if ("error" in resolved) return resolved;
  const { fromColumns, outputColumns } = resolved;
  let staged = workspace;
  let result: { map: KeyMapDef; joinCtx: KeyMapJoinCtx } | undefined;
  for (const selection of selections) {
    const planned = planTupleMapping(staged, ctx, selection);
    if ("error" in planned) return { error: `Source tuple ${tupleIdentity(selection.fromParts)}: ${planned.error}` };
    result = planned;
    staged = { ...workspace, key_maps: [
      ...(workspace.key_maps ?? []).filter((map) => map.id !== planned.map.id), planned.map,
    ] };
  }
  // Validate the entire ready map, not just the rows touched by this batch.
  // Do not use the editor's trim/clean routine: full tuples preserve exact bytes.
  const ready = result!;
  const mapKeys = new Set<string>();
  for (const entry of ready.map.entries) {
    const parts = entry.from_parts?.length ? entry.from_parts : [entry.from];
    const key = tupleIdentity(parts);
    if (mapKeys.has(key)) return { error: `Mapping contains duplicate From tuple ${key}. Resolve duplicates in Mapping first.` };
    mapKeys.add(key);
    const valid = confirmTupleMapping(ctx.leftOn, ctx.rightOn, parts, outputValuesEff(entry));
    if ("error" in valid) return { error: `Mapping source tuple ${key} is not ready to Apply: ${valid.error}` };
  }
  // The existing KeyMap readiness contract also rejects keys that collide after
  // trimming. Check representability, but NEVER publish its cleaned/trimmed rows:
  // these selections retain exact tuple identity or the whole batch is blocked.
  const readiness = validateKeyMapEntries(ready.map.entries, fromColumns.length, { outputArity: outputColumns.length });
  if (!readiness.ok) return { error: `Mapping cannot represent this batch under the existing KeyMap validation rules: ${readiness.error}. No tuple values were normalized or written.` };
  return ready;
}

/** Exact tuple handoff. Deliberately does not use the legacy scalar/trim fill. */
export function planTupleMapping(workspace: Workspace, ctx: KeyMapJoinCtx, selection: LensTupleMapping):
  { map: KeyMapDef; joinCtx: KeyMapJoinCtx } | { error: string } {
  if (resolveJoinStepFromCtx(workspace, ctx) !== ctx.joinStepIndex) {
    return { error: "Join changed. Reopen Suggest Right before adding a Mapping." };
  }
  if (tupleIdentity(ctx.leftOn) !== tupleIdentity(selection.leftOn)
    || tupleIdentity(ctx.rightOn) !== tupleIdentity(selection.rightOn)) {
    return { error: "Join fields changed. Reopen Suggest Right before adding a Mapping." };
  }
  const valid = confirmTupleMapping(selection.leftOn, selection.rightOn, selection.fromParts, selection.outputValues);
  if ("error" in valid) return valid;
  const resolved = resolveTupleMapping(workspace, ctx, false);
  if ("error" in resolved) return resolved;
  const { map: existing, name, fromColumns, outputColumns } = resolved;
  const base = existing ?? { ...emptyKeyMap(name), from_columns: fromColumns,
    from_column: fromColumns[0], output_columns: outputColumns, to_column: outputColumns[0] };
  const key = tupleIdentity(selection.fromParts);
  const entries = [...base.entries];
  const matches = entries.flatMap((e, i) => tupleIdentity(e.from_parts?.length ? e.from_parts : [e.from]) === key ? [i] : []);
  if (matches.length > 1) return { error: "Mapping contains duplicate From tuples. Resolve duplicates in Mapping first." };
  if (matches.length) {
    const index = matches[0]!;
    const old = entries[index]!;
    const outputs = outputValuesEff(old);
    if (outputs.some((value, i) => value !== "" && value !== selection.outputValues[i])) {
      return { error: "This From tuple already has different output values. Review the existing Mapping; no values were overwritten." };
    }
    entries[index] = { ...old, from: selection.fromParts[0]!, from_parts: [...selection.fromParts],
      to: selection.outputValues[0]!, output_values: [...selection.outputValues] };
  } else {
    entries.push({ from: selection.fromParts[0]!, from_parts: [...selection.fromParts],
      to: selection.outputValues[0]!, output_values: [...selection.outputValues] });
  }
  return {
    map: { ...base, entries },
    joinCtx: { ...ctx, probeSide: "left", applyLeftOn: [...selection.leftOn], applyRightOn: [...selection.rightOn],
      outputColumnLeft: selection.leftOn[0], outputColumnRight: selection.rightOn[0],
      outputBindingsLeft: outputColumns.map((map_column, i) => ({ map_column, destination_column: selection.leftOn[i]! })),
      outputBindingsRight: outputColumns.map((map_column, i) => ({ map_column, destination_column: selection.rightOn[i]! })),
    },
  };
}
