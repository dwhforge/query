/**
 * Canonical ApplyPlan resolution (ADR-0038).
 * UI confirms ApplyUserChoice; App must not re-invent bindings / Join ON.
 */
import {
  applyKeymapOutputBindings,
  applyReviewBindingsForSide,
  fromColumnsEff,
  outputColumnsEff,
  type ApplyKeyMapOutputBinding,
  type ApplySide,
} from "../../lib/keyMap";
import type { KeyMapDef, Workspace } from "../../types/pipeline";
import { basisQueryFingerprints } from "../mappingCreate/service";
import type { KeyMapApplyIntent, KeyMapJoinCtx } from "./types";

/** Confirmed review / Lens choice — no App-side defaults after this. */
export type ApplyUserChoice = {
  side: ApplySide;
  /** Included output bindings (subset allowed). Empty array is invalid when choice is present. */
  bindings: ApplyKeyMapOutputBinding[];
  /** When set, rewrite Join ON (requires frozen identity in resolve). */
  joinRewrite?: { leftOn: string[]; rightOn: string[] };
};

/** Fully resolved Apply operation (fold input). */
export type ApplyPlan = {
  map: KeyMapDef;
  ctx: KeyMapJoinCtx;
  side: ApplySide;
  leftCols: string[];
  rightCols: string[];
  outputColumnLeft: string;
  outputColumnRight: string;
  outputBindingsLeft?: ApplyKeyMapOutputBinding[];
  outputBindingsRight?: ApplyKeyMapOutputBinding[];
  joinRewrite?: { leftOn: string[]; rightOn: string[] };
  /** Fingerprint checked at commit against the live Project map. */
  mapRevision: string;
};

export type ResolveApplyPlanError = { error: string };

/**
 * Apply-operation revision (ADR-0038).
 * - seed: definition + entry values (exact strings — no undocumented trim)
 * - query: binding + transitive known query defs and nested KeyMap definitions
 *   via `basisQueryFingerprints` (cycle-safe; ApplyKeyMap→map def + query)
 * - source/ref: definition/binding only — not a claim about warehouse content
 */
export function keyMapRevisionFingerprint(
  map: KeyMapDef,
  workspace?: Workspace | null,
): string {
  const from = fromColumnsEff(map);
  const outs = outputColumnsEff(map);
  const schema = JSON.stringify({
    from_columns: from,
    output_columns: outs,
    editable_columns: map.editable_columns ?? [],
    time_mode: map.time_mode ?? "none",
    valid_from_column: map.valid_from_column ?? null,
    valid_to_column: map.valid_to_column ?? null,
    storage: map.storage ?? { kind: "seed" },
  });
  const kind = map.storage?.kind ?? "seed";
  if (kind === "query") {
    const qid =
      map.storage && map.storage.kind === "query"
        ? map.storage.query_id.trim()
        : "";
    const q = workspace?.queries.find((x) => x.id === qid);
    let basisPart: string;
    if (!workspace || !qid) {
      basisPart = `missing:${qid || "?"}`;
    } else {
      const basis = basisQueryFingerprints(workspace, qid);
      if (!basis.ok) {
        basisPart = `err:${basis.error}`;
      } else {
        const qPart = Object.keys(basis.defs)
          .sort()
          .map((id) => `q:${id}=${basis.defs[id]}`);
        const mPart = Object.keys(basis.maps)
          .sort()
          .map((id) => `m:${id}=${basis.maps[id]}`);
        basisPart = [...qPart, ...mPart].join("|");
      }
    }
    const qFinger = JSON.stringify({
      root: qid,
      basis: basisPart,
      execution: q?.execution ?? "local",
    });
    return `apply:${map.id}:query:${hashStr(qFinger + "|" + schema)}`;
  }
  if (kind === "source" || kind === "ref") {
    // Binding/definition only — local entry cache is not external SoT.
    return `apply:${map.id}:${kind}:${hashStr(schema)}`;
  }
  // Structured JSON — preserves significant whitespace in From/outputs.
  const rows = [...(map.entries ?? [])]
    .map((e) =>
      JSON.stringify({
        from_parts: e.from_parts?.length
          ? e.from_parts
          : e.from != null && e.from !== ""
            ? [e.from]
            : [],
        output_values: e.output_values?.length
          ? e.output_values
          : e.to != null && e.to !== ""
            ? [e.to]
            : [],
        attrs: Object.fromEntries(
          Object.entries(e.attrs ?? {}).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        ),
      }),
    )
    .sort();
  return `apply:${map.id}:seed:${hashStr(JSON.stringify(rows) + "|" + schema)}`;
}

function hashStr(s: string): string {
  // FNV-1a 32-bit — stable, short, adequate for stale refuse.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function factColsFromCtx(
  ctx: KeyMapJoinCtx,
  map: KeyMapDef,
  which: "left" | "right",
): string[] {
  const applyOn = which === "left" ? ctx.applyLeftOn : ctx.applyRightOn;
  if (applyOn?.length) return applyOn;
  const on = which === "left" ? ctx.leftOn : ctx.rightOn;
  const from = fromColumnsEff(map);
  if (from.length > 1 && on.length >= from.length) {
    return on.slice(0, from.length);
  }
  return [on[0] ?? "key"];
}

function validateBindings(
  bindings: ApplyKeyMapOutputBinding[],
  mapOuts: string[],
  label: string,
): ResolveApplyPlanError | null {
  if (!bindings.length) {
    return { error: `${label}: confirmed Apply choice has no output bindings.` };
  }
  const outFold = new Set(mapOuts.map((c) => c.toLowerCase()));
  const seenMap = new Set<string>();
  const seenDest = new Set<string>();
  for (const b of bindings) {
    const mc = b.map_column?.trim() ?? "";
    const dc = b.destination_column?.trim() ?? "";
    if (!mc || !dc) {
      return {
        error: `${label}: each binding needs map_column and destination_column.`,
      };
    }
    if (!outFold.has(mc.toLowerCase())) {
      return {
        error: `${label}: unknown map output '${mc}' (map has: ${mapOuts.join(", ")}).`,
      };
    }
    const mk = mc.toLowerCase();
    const dk = dc.toLowerCase();
    if (seenMap.has(mk)) {
      return { error: `${label}: duplicate map_column '${mc}'.` };
    }
    if (seenDest.has(dk)) {
      return { error: `${label}: duplicate destination '${dc}'.` };
    }
    seenMap.add(mk);
    seenDest.add(dk);
  }
  return null;
}

function validateMapBasics(map: KeyMapDef): ResolveApplyPlanError | null {
  const from = fromColumnsEff(map);
  const outs = outputColumnsEff(map);
  if (!from.length || from.some((c) => !c.trim())) {
    return { error: `KeyMap '${map.id}': from columns are required.` };
  }
  if (!outs.length || outs.some((c) => !c.trim())) {
    return { error: `KeyMap '${map.id}': output columns are required.` };
  }
  const names = new Set<string>();
  for (const c of [...from, ...outs]) {
    const k = c.toLowerCase();
    if (names.has(k)) {
      return {
        error: `KeyMap '${map.id}': duplicate map column name '${c}'.`,
      };
    }
    names.add(k);
  }
  if (map.storage?.kind === "query" && !map.storage.query_id?.trim()) {
    return { error: `KeyMap '${map.id}': query_id is empty.` };
  }
  return null;
}

/**
 * Resolve user choice + Join context into an ApplyPlan.
 *
 * - `choice` omitted → defaults for the scalar / no-review path.
 * - `choice` present with empty or invalid bindings → error (not silent defaults).
 *
 * Schema existence of destination columns is a prepare/describe concern;
 * this layer refuses elementary binding / map ambiguity only.
 */
export function resolveApplyPlan(
  map: KeyMapDef,
  ctx: KeyMapJoinCtx,
  side: ApplySide,
  choice?: ApplyUserChoice,
  workspace?: Workspace | null,
): ApplyPlan | ResolveApplyPlanError {
  const mapErr = validateMapBasics(map);
  if (mapErr) return mapErr;

  const leftCols = factColsFromCtx(ctx, map, "left");
  const rightCols = factColsFromCtx(ctx, map, "right");
  const from = fromColumnsEff(map);
  const outs = outputColumnsEff(map);

  if (
    (side === "left" || side === "both") &&
    leftCols.length < from.length
  ) {
    return {
      error: `Apply left keys (${leftCols.length}) must cover map From arity (${from.length}).`,
    };
  }
  if (
    (side === "right" || side === "both") &&
    rightCols.length < from.length
  ) {
    return {
      error: `Apply right keys (${rightCols.length}) must cover map From arity (${from.length}).`,
    };
  }

  const outputColumnLeft = ctx.outputColumnLeft?.trim() || leftCols[0]!;
  const outLeftIdx = leftCols.findIndex(
    (c) => c.toLowerCase() === outputColumnLeft.toLowerCase(),
  );
  const outputColumnRight =
    ctx.outputColumnRight?.trim() ||
    rightCols[outLeftIdx >= 0 ? outLeftIdx : 0] ||
    rightCols[0]!;

  let bindingsLeft: ApplyKeyMapOutputBinding[] | undefined;
  let bindingsRight: ApplyKeyMapOutputBinding[] | undefined;
  let joinRewrite = choice?.joinRewrite;
  const resolvedSide = choice?.side ?? side;

  if (choice !== undefined) {
    // Confirmed review path — empty/invalid must not fall through to defaults.
    const routed = applyReviewBindingsForSide(choice.side, choice.bindings ?? []);
    bindingsLeft = routed.outputBindingsLeft;
    bindingsRight = routed.outputBindingsRight;
    if (choice.side === "left" || choice.side === "both") {
      const err = validateBindings(
        bindingsLeft ?? [],
        outs,
        "Apply review (left)",
      );
      if (err) return err;
    }
    if (choice.side === "right" || choice.side === "both") {
      const err = validateBindings(
        bindingsRight ?? [],
        outs,
        "Apply review (right)",
      );
      if (err) return err;
    }
  } else {
    // No review panel (scalar / single-output): defaults live here, not in App.
    const defaultLeft =
      outs.length > 1
        ? outs.map((map_column, i) => ({
            map_column,
            destination_column: i === 0 ? outputColumnLeft : map_column,
          }))
        : applyKeymapOutputBindings({
            output_column: outputColumnLeft,
            factCols: leftCols,
            mapColumnHint: outs[0] ?? "to",
          });
    const defaultRight =
      outs.length > 1
        ? outs.map((map_column, i) => ({
            map_column,
            destination_column: i === 0 ? outputColumnRight : map_column,
          }))
        : applyKeymapOutputBindings({
            output_column: outputColumnRight,
            factCols: rightCols,
            mapColumnHint: outs[0] ?? "to",
          });
    if (side === "left" || side === "both") bindingsLeft = defaultLeft;
    if (side === "right" || side === "both") bindingsRight = defaultRight;
    // "Apply map only" must not inherit a stale ctx rewrite.
    joinRewrite = undefined;
  }

  if (joinRewrite) {
    if (
      !joinRewrite.leftOn.length ||
      joinRewrite.leftOn.length !== joinRewrite.rightOn.length
    ) {
      return { error: "Join rewrite needs aligned leftOn/rightOn." };
    }
  }

  return {
    map,
    ctx,
    side: resolvedSide,
    leftCols,
    rightCols,
    outputColumnLeft,
    outputColumnRight,
    outputBindingsLeft: bindingsLeft,
    outputBindingsRight: bindingsRight,
    joinRewrite,
    mapRevision: keyMapRevisionFingerprint(map, workspace),
  };
}

/** Intent for the existing fold — 1:1 with ApplyPlan (no further semantics). */
export function intentFromApplyPlan(plan: ApplyPlan): KeyMapApplyIntent {
  return {
    map: plan.map,
    ctx: plan.joinRewrite
      ? { ...plan.ctx, joinRewrite: plan.joinRewrite }
      : { ...plan.ctx, joinRewrite: undefined },
    side: plan.side,
    leftCols: plan.leftCols,
    rightCols: plan.rightCols,
    outputColumnLeft: plan.outputColumnLeft,
    outputColumnRight: plan.outputColumnRight,
    outputBindingsLeft: plan.outputBindingsLeft,
    outputBindingsRight: plan.outputBindingsRight,
    joinRewrite: plan.joinRewrite,
    expectedMapRevision: plan.mapRevision,
  };
}
