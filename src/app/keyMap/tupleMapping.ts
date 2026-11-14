import type { KeyMapDef, Workspace } from "../../types/pipeline";
import { emptyKeyMap, findApplyKeyMapIdForJoin, fromColumnsEff, outputColumnsEff, outputValuesEff } from "../../lib/keyMap";
import { confirmTupleMapping, type LensTupleMapping } from "../../lib/joinLensConfirm";
import { tupleIdentity } from "../../lib/joinLensTuple";
import type { KeyMapJoinCtx } from "./types";
import { resolveJoinStepFromCtx } from "./service";

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
  // Relation names are disjoint even when both Join sides use identical names.
  const fromColumns = selection.leftOn.map((column, i) => `from_${i + 1}_${column}`);
  const outputColumns = selection.rightOn.map((column, i) => `to_${i + 1}_${column}`);
  const name = `Join aliases ${ctx.hostQueryId} (${ctx.leftOn.join(", ")}) → ${ctx.rightQueryId} (${ctx.rightOn.join(", ")})`;
  const maps = workspace.key_maps ?? [];
  const preferredId = findApplyKeyMapIdForJoin(workspace, ctx);
  const compatible = (map: KeyMapDef) => (map.storage?.kind ?? "seed") === "seed"
    && (map.time_mode ?? "none") === "none"
    && tupleIdentity(fromColumnsEff(map)) === tupleIdentity(fromColumns)
    && tupleIdentity(outputColumnsEff(map)) === tupleIdentity(outputColumns);
  const existing = maps.find((m) => m.id === preferredId && compatible(m))
    ?? maps.find((m) => m.name === name && compatible(m));
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
