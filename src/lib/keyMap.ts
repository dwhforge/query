import type {
  ConnectionDef,
  KeyMapDef,
  KeyMapEntry,
  NormalizeOp,
  Project,
  QueryDef,
  SourceDef,
  TransformationStep,
  Workspace,
} from "../types/pipeline";
import { slugify, targetKey } from "../types/pipeline";

export type ApplySide = "left" | "right" | "both";


/** Effective From column names on the map relation (ADR-0024). */
export function fromColumnsEff(map: KeyMapDef): string[] {
  if (map.from_columns?.length) return map.from_columns;
  const one = (map.from_column ?? "from").trim() || "from";
  return [one];
}

/** Effective output column names on the map relation (ADR-0037). */
export function outputColumnsEff(map: KeyMapDef): string[] {
  if (map.output_columns?.length) return map.output_columns;
  const one = (map.to_column ?? "to").trim() || "to";
  return [one];
}

/** Effective From parts on an entry (ADR-0024). */
export function fromPartsEff(e: KeyMapEntry): string[] {
  if (e.from_parts?.length) return e.from_parts;
  return e.from?.trim() ? [e.from] : [];
}

/** Effective output values on an entry (ADR-0037). */
export function outputValuesEff(e: KeyMapEntry): string[] {
  if (e.output_values?.length) return e.output_values;
  if (e.to != null && e.to !== "") return [e.to];
  return [];
}

/** First output value (legacy single-To). */
export function primaryTo(e: KeyMapEntry): string {
  return outputValuesEff(e)[0] ?? "";
}

export type ApplyKeyMapOutputBinding = {
  map_column: string;
  destination_column: string;
};

/** Effective Apply output bindings (ADR-0037). */
export function applyKeymapOutputBindings(args: {
  output_column?: string;
  output_bindings?: ApplyKeyMapOutputBinding[];
  factCols: string[];
  mapColumnHint?: string;
}): ApplyKeyMapOutputBinding[] {
  if (args.output_bindings?.length) return args.output_bindings;
  const dest =
    args.output_column?.trim() ||
    args.factCols[0] ||
    "";
  if (!dest) return [];
  const mapCol = (args.mapColumnHint ?? "to").trim() || "to";
  return [{ map_column: mapCol, destination_column: dest }];
}

/**
 * Default destinations for the multi-output Apply review (ADR-0037):
 * first output → current left ON / fact column, others → map column name.
 */
export function defaultReviewDestinations(
  outCols: string[],
  currentLeftOn: string,
): string[] {
  return outCols.map((c, i) => (i === 0 && currentLeftOn.trim() ? currentLeftOn : c));
}

/**
 * Default right Join column per destination: `rightOnCols[i]`, else a
 * right column with the same name as the destination, else the destination.
 */
export function defaultReviewRightCols(
  destinations: string[],
  rightOnCols: string[],
): string[] {
  return destinations.map(
    (d, i) =>
      rightOnCols[i] ??
      rightOnCols.find((r) => r.toLowerCase() === d.toLowerCase()) ??
      d,
  );
}

/** `a, b = x, y` style ON preview text. */
export function formatJoinOn(left: string[], right: string[]): string {
  return `${left.join(", ")} = ${right.join(", ")}`;
}

/** One map output row in the Apply+Join review. */
export type ApplyReviewOutputRow = {
  mapColumn: string;
  destination: string;
  /** Include in ApplyKeyMap output_bindings. */
  includeApply: boolean;
  /** Include destination = rightCol in the rewritten Join ON. */
  includeJoin: boolean;
  rightCol: string;
};

/** Existing Join equality the user may keep when rewriting ON. */
export type ApplyReviewKeepEquality = {
  left: string;
  right: string;
  keep: boolean;
};

export type ApplyReviewState = {
  side: ApplySide;
  outputs: ApplyReviewOutputRow[];
  keepEqualities: ApplyReviewKeepEquality[];
  rewriteJoin: boolean;
};

/** Build the initial review state for a multi-output Apply. */
export function buildApplyReviewState(args: {
  side: ApplySide;
  outCols: string[];
  leftOnCols: string[];
  rightOnCols: string[];
}): ApplyReviewState {
  // Anchor destination for the first output on the side being Applied.
  // `both` confirms one destination set for both sides (same bindings) —
  // default from the host (left) ON; user can edit before confirm.
  const anchorCol =
    args.side === "right"
      ? args.rightOnCols[0] ?? ""
      : args.leftOnCols[0] ?? "";
  const dests = defaultReviewDestinations(args.outCols, anchorCol);
  const rights = defaultReviewRightCols(dests, args.rightOnCols);
  // Default Join participation: one equality per current ON slot (extra
  // outputs like category_id stay Apply-only). Existing ON is opt-in keep
  // so rewritten keys are not duplicated beside new destinations.
  const joinSlots = Math.max(1, Math.min(args.outCols.length, args.leftOnCols.length || 1));
  return {
    side: args.side,
    outputs: args.outCols.map((mapColumn, i) => ({
      mapColumn,
      destination: dests[i]!,
      includeApply: true,
      includeJoin: i < joinSlots,
      rightCol: rights[i]!,
    })),
    keepEqualities: args.leftOnCols.map((left, i) => ({
      left,
      right: args.rightOnCols[i] ?? args.rightOnCols[0] ?? left,
      keep: false,
    })),
    rewriteJoin: false,
  };
}

/** Route confirmed bindings to the Apply side the user chose. */
export function applyReviewBindingsForSide(
  side: ApplySide,
  bindings: ApplyKeyMapOutputBinding[],
): {
  outputBindingsLeft?: ApplyKeyMapOutputBinding[];
  outputBindingsRight?: ApplyKeyMapOutputBinding[];
} {
  if (side === "left") return { outputBindingsLeft: bindings };
  if (side === "right") return { outputBindingsRight: bindings };
  return {
    outputBindingsLeft: bindings,
    outputBindingsRight: bindings,
  };
}

/** Collect Apply bindings + optional Join rewrite from review state. */
export function confirmApplyReview(state: ApplyReviewState): {
  bindings: ApplyKeyMapOutputBinding[];
  joinRewrite?: { leftOn: string[]; rightOn: string[] };
  error: string | null;
} {
  const included = state.outputs.filter((o) => o.includeApply);
  if (!included.length) {
    return { bindings: [], error: "Select at least one output to Apply." };
  }
  const seen = new Set<string>();
  for (const o of included) {
    const k = o.destination.trim().toLowerCase();
    if (!k) {
      return {
        bindings: [],
        error: "Every included output needs a destination column.",
      };
    }
    if (seen.has(k)) {
      return {
        bindings: [],
        error: `Duplicate destination column "${o.destination.trim()}".`,
      };
    }
    seen.add(k);
  }
  const bindings = included.map((o) => ({
    map_column: o.mapColumn,
    destination_column: o.destination.trim(),
  }));

  if (!state.rewriteJoin || state.side === "right") {
    return { bindings, error: null };
  }

  const leftOn: string[] = [];
  const rightOn: string[] = [];
  for (const eq of state.keepEqualities) {
    if (!eq.keep) continue;
    if (!eq.left.trim() || !eq.right.trim()) {
      return {
        bindings: [],
        error: "Kept Join equalities need both left and right columns.",
      };
    }
    leftOn.push(eq.left.trim());
    rightOn.push(eq.right.trim());
  }
  for (const o of state.outputs) {
    if (!o.includeJoin) continue;
    if (!o.includeApply) {
      return {
        bindings: [],
        error: `Join uses "${o.mapColumn}" — include it in Apply too.`,
      };
    }
    if (!o.rightCol.trim()) {
      return {
        bindings: [],
        error: "Every Join equality needs a right column.",
      };
    }
    leftOn.push(o.destination.trim());
    rightOn.push(o.rightCol.trim());
  }
  if (!leftOn.length) {
    return {
      bindings: [],
      error: "Join rewrite needs at least one equality (keep old or map output).",
    };
  }
  return {
    bindings,
    joinRewrite: { leftOn, rightOn },
    error: null,
  };
}

/** @deprecated Prefer confirmApplyReview — kept for older unit checks. */
export function validateApplyReview(
  destinations: string[],
  rights: string[],
  rewriteJoin: boolean,
): string | null {
  const state: ApplyReviewState = {
    side: "left",
    outputs: destinations.map((destination, i) => ({
      mapColumn: `out_${i}`,
      destination,
      includeApply: true,
      includeJoin: rewriteJoin,
      rightCol: rights[i] ?? "",
    })),
    keepEqualities: [],
    rewriteJoin,
  };
  return confirmApplyReview(state).error;
}

/** Stable key for dirty-buffer / uniqueness (JSON tuple). */
export function tupleKey(parts: string[]): string {
  return JSON.stringify(parts.map((p) => p.trim()));
}

export function applyKeymapColumns(
  column: string | undefined,
  columns: string[] | undefined,
): string[] {
  if (columns?.length) return columns;
  if (column?.trim()) return [column.trim()];
  return [];
}

/**
 * Prefer the KeyMap already wired via ApplyKeyMap on this Join's key column
 * (host before Join for left; right query for right).
 *
 * Traces RenameColumn backward so ApplyKeyMap on a pre-rename name still matches.
 * Does NOT fall back to an unrelated ApplyKeyMap (e.g. channel before a company Join).
 */
export function findApplyKeyMapIdForJoin(
  workspace: Workspace,
  ctx: {
    hostQueryId: string;
    joinStepIndex: number;
    rightQueryId: string;
    leftOn: string[];
    rightOn: string[];
    probeSide?: "left" | "right";
  },
): string | null {
  const fold = (s: string) => s.toLowerCase();

  /** Names that refer to `joinCol` at each step, walking renames backward. */
  const scanMapForJoinCol = (
    steps: TransformationStep[],
    upto: number | null,
    joinCol: string | undefined,
  ): string | null => {
    if (!joinCol?.trim()) return null;
    const end = upto == null ? steps.length : Math.min(upto, steps.length);
    const names = new Set<string>([fold(joinCol)]);
    for (let i = end - 1; i >= 0; i--) {
      const s = steps[i];
      if (!s) continue;
      if (s.type === "RenameColumn") {
        const from = fold(s.payload.from);
        const to = fold(s.payload.to);
        if (names.has(to)) {
          names.delete(to);
          names.add(from);
        }
        continue;
      }
      if (s.type === "ApplyKeyMap") {
        const cols = applyKeymapColumns(
          s.payload.column,
          s.payload.columns,
        ).map(fold);
        if (cols.some((c) => names.has(c))) {
          return targetKey(s.payload.map_id);
        }
      }
    }
    return null;
  };

  const preferRight = ctx.probeSide === "right";
  const leftCol = ctx.leftOn[0];
  const rightCol = ctx.rightOn[0];
  const host = workspace.queries.find((q) => q.id === ctx.hostQueryId);
  const right = workspace.queries.find((q) => q.id === ctx.rightQueryId);

  if (preferRight) {
    return (
      (right ? scanMapForJoinCol(right.steps, null, rightCol) : null) ??
      (host ? scanMapForJoinCol(host.steps, ctx.joinStepIndex, leftCol) : null)
    );
  }
  return (
    (host ? scanMapForJoinCol(host.steps, ctx.joinStepIndex, leftCol) : null) ??
    (right ? scanMapForJoinCol(right.steps, null, rightCol) : null)
  );
}

export function emptyKeyMap(name = "Key map"): KeyMapDef {
  const id = `map_${slugify(name)}_${Date.now().toString(36)}`;
  return {
    id,
    name,
    entries: [],
    storage: { kind: "seed" },
    from_column: "from",
    from_columns: ["from"],
    to_column: "to",
    output_columns: ["to"],
  };
}

/** dbt seed / ref name for a KeyMap id (mirrors Rust `key_map_seed_name`). */
export function keyMapSeedName(mapId: string): string {
  const raw = mapId
    .trim()
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const id = raw || "map";
  return id.startsWith("map_") ? id : `map_${id}`;
}

export type ValidateKeyMapOpts = {
  /** ADR-0028: duplicate From allowed when ranges do not overlap. */
  timeMode?: "none" | "range_scd";
  validFromColumn?: string;
  validToColumn?: string;
  /** ADR-0037: required length of output_values (default 1). */
  outputArity?: number;
};

export { parseScdBound, parseScdBoundDetailed } from "./scdBound";
import { parseScdBound } from "./scdBound";

/** Trim From parts; reject empty to / duplicate tuples (ADR-0024 / ADR-0028). */
export function validateKeyMapEntries(
  entries: KeyMapEntry[],
  arity = 1,
  opts?: ValidateKeyMapOpts,
): { ok: true; entries: KeyMapEntry[] } | { ok: false; error: string } {
  const n = Math.max(1, arity);
  const outN = Math.max(1, opts?.outputArity ?? 1);
  const range = opts?.timeMode === "range_scd";
  const vfCol = opts?.validFromColumn?.trim() || "valid_from";
  const vtCol = opts?.validToColumn?.trim() || "valid_to";
  const cleaned: KeyMapEntry[] = [];
  const seen = new Set<string>();
  const ranges = new Map<string, { from: number; to: number | null }[]>();
  for (const e of entries) {
    let parts = fromPartsEff(e).map((p) => p.trim());
    if (parts.length === 1 && n > 1) {
      while (parts.length < n) parts.push("");
    }
    if (parts.length !== n && parts.every(Boolean)) {
      return {
        ok: false,
        error: `From parts length ${parts.length} ≠ arity ${n}`,
      };
    }
    // While editing mid-flight, allow incomplete arity (pad) but reject empties once filled.
    if (parts.length < n) {
      while (parts.length < n) parts.push("");
    }
    if (parts.length > n) parts = parts.slice(0, n);
    if (parts.some((p) => !p)) {
      return { ok: false, error: "Empty From part is not allowed" };
    }
    let outs = outputValuesEff(e);
    if (outs.length < outN) {
      while (outs.length < outN) outs.push("");
    }
    if (outs.length > outN) outs = outs.slice(0, outN);
    if (outs.some((v) => !v)) {
      return {
        ok: false,
        error: `Empty output for From ${JSON.stringify(parts)}`,
      };
    }
    const key = tupleKey(parts);
    if (range) {
      const vfRaw = (e.attrs?.[vfCol] ?? "").trim();
      if (!vfRaw) {
        return {
          ok: false,
          error: `Range SCD requires ${vfCol} for From ${JSON.stringify(parts)}`,
        };
      }
      const vf = parseScdBound(vfRaw);
      if (vf == null) {
        return {
          ok: false,
          error: `Invalid ${vfCol} '${vfRaw}' (YYYY-MM-DD or HH:MM:SS; no fractional seconds)`,
        };
      }
      const vtRaw = (e.attrs?.[vtCol] ?? "").trim();
      let vt: number | null = null;
      if (vtRaw) {
        vt = parseScdBound(vtRaw);
        if (vt == null) {
          return {
            ok: false,
            error: `Invalid ${vtCol} '${vtRaw}' (YYYY-MM-DD or HH:MM:SS; no fractional seconds)`,
          };
        }
        if (vt <= vf) {
          return {
            ok: false,
            error: `${vtCol} must be > ${vfCol} for From ${JSON.stringify(parts)}`,
          };
        }
      }
      const list = ranges.get(key) ?? [];
      for (const other of list) {
        // Half-open [from,to): overlap if intervals intersect
        const aEnd = other.to ?? Number.POSITIVE_INFINITY;
        const bEnd = vt ?? Number.POSITIVE_INFINITY;
        if (other.from < bEnd && vf < aEnd) {
          return {
            ok: false,
            error: `Overlapping ranges for From ${JSON.stringify(parts)}`,
          };
        }
      }
      list.push({ from: vf, to: vt });
      ranges.set(key, list);
    } else if (seen.has(key)) {
      return {
        ok: false,
        error: `Duplicate From ${JSON.stringify(parts)}`,
      };
    }
    seen.add(key);
    // Preserve editor-only row id across validate (not part of warehouse schema).
    const rowId =
      (e as { __dwhRowId?: string; __dwhLocalId?: string }).__dwhRowId ??
      (e as { __dwhLocalId?: string }).__dwhLocalId;
    cleaned.push({
      from: parts[0]!,
      from_parts: parts,
      to: outs[0]!,
      output_values: outs,
      ...(e.attrs && Object.keys(e.attrs).length ? { attrs: e.attrs } : {}),
      ...(rowId ? { __dwhRowId: rowId } : {}),
    } as KeyMapEntry);
  }
  return { ok: true, entries: cleaned };
}

export function parseFromToPaste(
  text: string,
  arity = 1,
  outputArity = 1,
): KeyMapEntry[] {
  const n = Math.max(1, arity);
  const outN = Math.max(1, outputArity);
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const out: KeyMapEntry[] = [];
  for (const line of lines) {
    if (/^from\b/i.test(line) && /\bto\b/i.test(line)) continue;
    const parts = line.includes("\t")
      ? line.split("\t")
      : line.includes(",")
        ? line.split(",")
        : line.split(/\s+/);
    if (parts.length < n + 1) continue;
    const fromParts = parts
      .slice(0, n)
      .map((p) => p.trim().replace(/^"|"$/g, ""));
    const clean = (p: string) => p.trim().replace(/^"|"$/g, "");
    // Last output absorbs extra delimiters (legacy single-To behavior at outN=1).
    const tail = parts.slice(n);
    const outputs =
      outN === 1
        ? [
            tail
              .join(line.includes(",") ? "," : "\t")
              .trim()
              .replace(/^"|"$/g, ""),
          ]
        : Array.from({ length: outN }, (_, i) =>
            i < outN - 1
              ? clean(tail[i] ?? "")
              : clean(
                  tail
                    .slice(i)
                    .join(line.includes(",") ? "," : "\t"),
                ),
          );
    if (fromParts.every(Boolean)) {
      out.push({
        from: fromParts[0]!,
        from_parts: fromParts,
        to: outputs[0] ?? "",
        output_values: outputs,
      });
    }
  }
  return out;
}

function defaultOutputBindings(
  map: KeyMapDef,
  factCols: string[],
  outputColumn?: string,
  explicit?: ApplyKeyMapOutputBinding[],
): ApplyKeyMapOutputBinding[] {
  if (explicit?.length) return explicit;
  const outs = outputColumnsEff(map);
  if (outs.length <= 1) {
    return applyKeymapOutputBindings({
      output_column: outputColumn,
      factCols,
      mapColumnHint: outs[0] ?? "to",
    });
  }
  // Multi-output: destination defaults to map column name (new fact cols).
  // First binding may still use a legacy scalar outputColumn overwrite.
  return outs.map((map_column, i) => ({
    map_column,
    destination_column:
      i === 0 && outputColumn?.trim() ? outputColumn.trim() : map_column,
  }));
}

/** Result of upserting Apply before a Join index. */
export type UpsertApplyResult = {
  steps: TransformationStep[];
  /** True when a new Apply was spliced at `at` (Join and later steps shift +1). */
  insertedBefore: boolean;
};

function upsertApplyStep(
  steps: TransformationStep[],
  at: number,
  columns: string[],
  map: KeyMapDef,
  outputColumn?: string,
  outputBindings?: ApplyKeyMapOutputBinding[],
): UpsertApplyResult {
  const next = [...steps];
  const cols = columns.filter((c) => c.trim());
  if (!cols.length) return { steps: next, insertedBefore: false };
  const bindings = defaultOutputBindings(map, cols, outputColumn, outputBindings);
  const payload = {
    column: cols[0]!,
    columns: cols,
    output_bindings: bindings,
    map_id: map.id,
    entries: map.entries,
  };
  const key = cols.map((c) => c.toLowerCase()).join("\0");
  const existing = next.findIndex((s, i) => {
    if (
      i > at ||
      s.type !== "ApplyKeyMap" ||
      targetKey(s.payload.map_id) !== map.id
    ) {
      return false;
    }
    const sc = applyKeymapColumns(s.payload.column, s.payload.columns)
      .map((c) => c.toLowerCase())
      .join("\0");
    return sc === key;
  });
  if (existing >= 0) {
    next[existing] = { type: "ApplyKeyMap", payload };
    return { steps: next, insertedBefore: false };
  }
  next.splice(at, 0, { type: "ApplyKeyMap", payload });
  return { steps: next, insertedBefore: true };
}

function upsertNormalizeBeforeJoin(
  steps: TransformationStep[],
  joinIndex: number,
  columns: string[],
  ops: NormalizeOp[],
): TransformationStep[] {
  const next = [...steps];
  const existing = next.findIndex(
    (s, i) =>
      i < joinIndex &&
      s.type === "NormalizeKey" &&
      s.payload.columns.join("\0") === columns.join("\0"),
  );
  const step: TransformationStep = {
    type: "NormalizeKey",
    payload: { columns, ops },
  };
  if (existing >= 0) {
    next[existing] = step;
    return next;
  }
  next.splice(joinIndex, 0, step);
  return next;
}

/** Join identity frozen before Apply insert (right + ON + type). */
export type JoinStepIdentity = {
  rightQueryId: string;
  leftOn: string[];
  rightOn: string[];
  joinType: import("../types/pipeline").JoinType;
};

function joinMatchesIdentity(
  s: TransformationStep | undefined,
  id: JoinStepIdentity,
): s is TransformationStep & { type: "Join" } {
  return (
    s?.type === "Join" &&
    targetKey(s.payload.right_query_id) === id.rightQueryId &&
    s.payload.left_on.join("\0") === id.leftOn.join("\0") &&
    s.payload.right_on.join("\0") === id.rightOn.join("\0") &&
    s.payload.join_type === id.joinType
  );
}

export type ApplyKeyMapWorkspaceResult =
  | { ok: true; workspace: Workspace }
  | { ok: false; error: string };

/**
 * Insert/update ApplyKeyMap on left (before join) and/or right (append).
 * Join rewrite uses the same Join that was at `joinStepIndex` before insert —
 * never re-search by right query alone (ADR-0037 review).
 */
export function applyKeyMapToWorkspace(
  workspace: Workspace,
  hostQueryId: string,
  joinStepIndex: number,
  rightQueryId: string,
  side: ApplySide,
  columnLeft: string,
  columnRight: string,
  map: KeyMapDef,
  columnsLeft?: string[],
  columnsRight?: string[],
  outputColumnLeft?: string,
  outputColumnRight?: string,
  /** ADR-0037: explicit multi-output destinations (left Apply). */
  outputBindingsLeft?: ApplyKeyMapOutputBinding[],
  outputBindingsRight?: ApplyKeyMapOutputBinding[],
  /** When set, rewrite that Join's ON to these left/right equals after Apply. */
  joinRewrite?: { leftOn: string[]; rightOn: string[] },
  /** Required when joinRewrite is set — identity of the Join before insert. */
  joinIdentity?: JoinStepIdentity,
): ApplyKeyMapWorkspaceResult {
  const leftCols = columnsLeft?.length ? columnsLeft : [columnLeft];
  const rightCols = columnsRight?.length ? columnsRight : [columnRight];
  const outLeft =
    outputColumnLeft?.trim() || leftCols[0];
  const outRight =
    outputColumnRight?.trim() || rightCols[0];
  const wantRewrite =
    !!joinRewrite?.leftOn.length && !!joinRewrite?.rightOn.length;

  if (wantRewrite && side !== "right") {
    if (!joinIdentity) {
      return {
        ok: false,
        error:
          "Apply+Join requires a frozen Join identity (right query, ON, type).",
      };
    }
    const host = workspace.queries.find((q) => q.id === hostQueryId);
    if (!host || !joinMatchesIdentity(host.steps[joinStepIndex], joinIdentity)) {
      return {
        ok: false,
        error:
          "Target Join was removed or changed — Apply+Join refused (no ambiguous fallback).",
      };
    }
  }

  let failed: string | null = null;
  const queries = workspace.queries.map((q) => {
    if (failed) return q;
    if (side !== "right" && q.id === hostQueryId) {
      const before = q.steps[joinStepIndex];
      if (wantRewrite && joinIdentity && !joinMatchesIdentity(before, joinIdentity)) {
        failed =
          "Target Join was removed or changed — Apply+Join refused (no ambiguous fallback).";
        return q;
      }
      const { steps: withApply, insertedBefore } = upsertApplyStep(
        q.steps,
        joinStepIndex,
        leftCols,
        map,
        outLeft,
        outputBindingsLeft,
      );
      let steps = withApply;
      if (wantRewrite && joinRewrite && joinIdentity) {
        const joinIdxAfter = insertedBefore ? joinStepIndex + 1 : joinStepIndex;
        const j = steps[joinIdxAfter];
        if (!joinMatchesIdentity(j, joinIdentity)) {
          failed =
            "Target Join could not be located after Apply insert — refused without rewriting another Join.";
          return q;
        }
        steps = [...steps];
        steps[joinIdxAfter] = {
          ...j,
          payload: {
            ...j.payload,
            left_on: [...joinRewrite.leftOn],
            right_on: [...joinRewrite.rightOn],
          },
        };
      }
      return { ...q, steps };
    }
    if (side !== "left" && q.id === rightQueryId) {
      const { steps } = upsertApplyStep(
        q.steps,
        q.steps.length,
        rightCols,
        map,
        outRight,
        outputBindingsRight,
      );
      return { ...q, steps };
    }
    return q;
  });
  if (failed) return { ok: false, error: failed };
  const key_maps = upsertKeyMapList(workspace.key_maps ?? [], map);
  return { ok: true, workspace: { ...workspace, queries, key_maps } };
}

export function applyNormalizeToWorkspace(
  workspace: Workspace,
  hostQueryId: string,
  joinStepIndex: number,
  rightQueryId: string,
  side: ApplySide,
  leftOn: string[],
  rightOn: string[],
  ops: NormalizeOp[],
): Workspace {
  const queries = workspace.queries.map((q) => {
    if (side !== "right" && q.id === hostQueryId) {
      return {
        ...q,
        steps: upsertNormalizeBeforeJoin(q.steps, joinStepIndex, leftOn, ops),
      };
    }
    if (side !== "left" && q.id === rightQueryId) {
      const joinLike = q.steps.length;
      return {
        ...q,
        steps: upsertNormalizeBeforeJoin(q.steps, joinLike, rightOn, ops),
      };
    }
    return q;
  });
  return { ...workspace, queries };
}

export function upsertKeyMapList(
  maps: KeyMapDef[],
  map: KeyMapDef,
): KeyMapDef[] {
  const i = maps.findIndex((m) => m.id === map.id);
  if (i < 0) return [...maps, map];
  const next = [...maps];
  next[i] = map;
  return next;
}

export function syncApplyKeyMapEntries(
  queries: QueryDef[],
  map: KeyMapDef,
): QueryDef[] {
  // ADR-0022: source maps must not snapshot the WH dictionary into ApplyKeyMap.
  const snapEntries =
    map.storage?.kind === "source" ? [] : map.entries;
  return queries.map((q) => ({
    ...q,
    steps: q.steps.map((s) =>
      s.type === "ApplyKeyMap" && targetKey(s.payload.map_id) === map.id
        ? {
            ...s,
            payload: { ...s.payload, entries: snapEntries },
          }
        : s,
    ),
  }));
}

function pgDsn(c: ConnectionDef | undefined): string | null {
  const dsn = c?.postgres?.connection_string?.trim();
  return dsn || null;
}

export type KeyMapConnResolve =
  | { ok: true; dsn: string; connectionId: string }
  | { ok: false; error: string };

/**
 * Resolve Postgres DSN for a source-backed KeyMap.
 *
 * Write path (`forWrite=true`): requires an explicit `storage.connection_id`
 * with a usable DSN — never falls back to target / “any PG” (silent wrong DB).
 *
 * Read path: may fall back to a matching Explorer source’s connection only.
 * A *set* but missing/invalid `connection_id` is always an error (no silent hop).
 */
export function resolveKeyMapConnection(
  project: Project,
  map: KeyMapDef,
  connections: ConnectionDef[] = project.connections,
  forWrite = false,
): KeyMapConnResolve {
  if (map.storage?.kind !== "source") {
    return { ok: false, error: "Mapping storage is not source" };
  }
  const { source, table, connection_id } = map.storage;
  const cid = connection_id?.trim() ?? "";

  if (cid) {
    const conn = connections.find((x) => x.id === cid);
    if (!conn) {
      return {
        ok: false,
        error: `Mapping connection_id “${cid}” not found — pick a Connection in the editor (no fallback).`,
      };
    }
    const dsn = pgDsn(conn);
    if (!dsn) {
      return {
        ok: false,
        error: `Connection “${cid}” has no Postgres DSN — open Connections and save it.`,
      };
    }
    return { ok: true, dsn, connectionId: cid };
  }

  if (forWrite) {
    return {
      ok: false,
      error:
        "Mapping write requires an explicit Connection on the map (Storage → Connection). No silent fallback to target / other PG.",
    };
  }

  // Read-only convenience: Explorer source with same schema.table.
  const match = project.sources.find(
    (s: SourceDef) =>
      s.kind === "postgres" &&
      (s.schema ?? "").toLowerCase() === source.toLowerCase() &&
      (s.table_name ?? "").toLowerCase() === table.toLowerCase(),
  );
  if (match?.connection_id) {
    const conn = connections.find((x) => x.id === match.connection_id);
    const dsn = pgDsn(conn);
    if (dsn && conn) {
      return { ok: true, dsn, connectionId: conn.id };
    }
  }
  if (match?.connection_string?.trim()) {
    return {
      ok: true,
      dsn: match.connection_string.trim(),
      connectionId: match.connection_id ?? "",
    };
  }

  return {
    ok: false,
    error: `No connection for Mapping source ${source}.${table} — set Storage → Connection.`,
  };
}

/** @deprecated Prefer resolveKeyMapConnection — kept for call sites that only need DSN. */
export function resolveKeyMapConnectionString(
  project: Project,
  map: KeyMapDef,
  connections: ConnectionDef[] = project.connections,
  forWrite = false,
): string | null {
  const r = resolveKeyMapConnection(project, map, connections, forWrite);
  return r.ok ? r.dsn : null;
}

/** Remove KeyMap resource and all ApplyKeyMap steps that reference it. */
export function deleteKeyMapFromWorkspace(
  workspace: Workspace,
  mapId: string,
): { workspace: Workspace; removedSteps: number } {
  let removedSteps = 0;
  const queries = workspace.queries.map((q) => {
    const steps = q.steps.filter((s) => {
      if (s.type === "ApplyKeyMap" && targetKey(s.payload.map_id) === mapId) {
        removedSteps += 1;
        return false;
      }
      return true;
    });
    return { ...q, steps };
  });
  const key_maps = (workspace.key_maps ?? []).filter((m) => m.id !== mapId);
  return {
    workspace: { ...workspace, queries, key_maps },
    removedSteps,
  };
}

/** Accept into a draft only. Filled mappings and ambiguous proposals are untouched. */
export function mergeKeyMapProposals(
  entries: KeyMapEntry[],
  proposals: {
    from_key: string;
    to_key: string;
    ambiguous: boolean;
    from_parts?: string[];
  }[],
): KeyMapEntry[] {
  const merged = new Map(
    entries.map((entry) => [tupleKey(fromPartsEff(entry)), entry] as const),
  );
  for (const proposal of proposals) {
    if (proposal.ambiguous) continue;
    const parts =
      proposal.from_parts?.length
        ? proposal.from_parts
        : proposal.from_key.trim()
          ? [proposal.from_key]
          : [];
    if (!parts.length) continue;
    const key = tupleKey(parts);
    const cur = merged.get(key);
    if (cur && outputValuesEff(cur).some((v) => v.trim())) continue;
    merged.set(key, {
      from: parts[0]!,
      from_parts: parts,
      to: proposal.to_key,
      output_values: [proposal.to_key],
    });
  }
  return [...merged.values()];
}

/** One named output cell from a lens / query result (ADR-0037). */
export type LensOutputCell = { column: string; value: string };

/**
 * Merge named cells into `output_values` by column name. Unnamed columns are
 * unchanged; a filled cell that differs is reported and never overwritten.
 */
export function mergeLensOutputCells(
  entry: KeyMapEntry,
  outputColumns: string[],
  cells: LensOutputCell[],
):
  | { ok: true; entry: KeyMapEntry }
  | { ok: false; error: string; conflicts: LensOutputCell[] } {
  const cols = outputColumns.length ? outputColumns : ["to"];
  const index = new Map(cols.map((c, i) => [c.trim().toLowerCase(), i] as const));
  const outs = outputValuesEff(entry).slice(0, cols.length);
  while (outs.length < cols.length) outs.push("");
  const conflicts: LensOutputCell[] = [];
  for (const cell of cells) {
    const i = index.get(cell.column.trim().toLowerCase());
    if (i === undefined) {
      return {
        ok: false,
        error: `Unknown output column “${cell.column}”`,
        conflicts: [],
      };
    }
    const cur = outs[i] ?? "";
    if (cur.trim() && cur !== cell.value) {
      conflicts.push(cell);
      continue;
    }
    if (!cur.trim()) outs[i] = cell.value;
  }
  if (conflicts.length) {
    return {
      ok: false,
      error: `Output conflict on ${conflicts.map((c) => `“${c.column}”`).join(", ")}`,
      conflicts,
    };
  }
  return {
    ok: true,
    entry: { ...entry, to: outs[0] ?? "", output_values: outs },
  };
}
