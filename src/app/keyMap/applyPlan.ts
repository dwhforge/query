/**
 * Canonical ApplyPlan resolution (ADR-0038).
 * UI confirms ApplyUserChoice; App must not re-invent bindings / Join ON.
 */
import {
  applyKeymapOutputBindings,
  applyReviewBindingsForSide,
  outputColumnsEff,
  type ApplyKeyMapOutputBinding,
  type ApplySide,
} from "../../lib/keyMap";
import type { KeyMapDef } from "../../types/pipeline";
import type { KeyMapApplyIntent, KeyMapJoinCtx } from "./types";

/** Confirmed review / Lens choice — no App-side defaults after this. */
export type ApplyUserChoice = {
  side: ApplySide;
  /** Included output bindings (subset allowed). */
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
  /** Fingerprint for stale refuse (map id + storage + output list). */
  mapRevision: string;
};

export type ResolveApplyPlanError = { error: string };

export function keyMapRevisionFingerprint(map: KeyMapDef): string {
  const outs = outputColumnsEff(map).join("\0");
  const storage = JSON.stringify(map.storage ?? { kind: "seed" });
  return `${map.id}|${storage}|${outs}|${map.entries?.length ?? 0}`;
}

function factColsFromCtx(
  ctx: KeyMapJoinCtx,
  map: KeyMapDef,
  which: "left" | "right",
): string[] {
  const applyOn = which === "left" ? ctx.applyLeftOn : ctx.applyRightOn;
  if (applyOn?.length) return applyOn;
  const on = which === "left" ? ctx.leftOn : ctx.rightOn;
  const from = map.from_columns?.length
    ? map.from_columns
    : map.from_column
      ? [map.from_column]
      : [];
  if (from.length > 1 && on.length >= from.length) {
    return on.slice(0, from.length);
  }
  return [on[0] ?? "key"];
}

/**
 * Resolve user choice + Join context into an ApplyPlan.
 * When `choice` is omitted (scalar Apply without review), builds default
 * single/multi bindings from map outputs — still in this module, not App.
 */
export function resolveApplyPlan(
  map: KeyMapDef,
  ctx: KeyMapJoinCtx,
  side: ApplySide,
  choice?: ApplyUserChoice,
): ApplyPlan | ResolveApplyPlanError {
  const leftCols = factColsFromCtx(ctx, map, "left");
  const rightCols = factColsFromCtx(ctx, map, "right");
  const outs = outputColumnsEff(map);
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

  if (choice?.bindings?.length) {
    const routed = applyReviewBindingsForSide(choice.side, choice.bindings);
    bindingsLeft = routed.outputBindingsLeft;
    bindingsRight = routed.outputBindingsRight;
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
    side: choice?.side ?? side,
    leftCols,
    rightCols,
    outputColumnLeft,
    outputColumnRight,
    outputBindingsLeft: bindingsLeft,
    outputBindingsRight: bindingsRight,
    joinRewrite,
    mapRevision: keyMapRevisionFingerprint(map),
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
  };
}
