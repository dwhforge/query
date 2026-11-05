/**
 * ApplyPlan resolution (ADR-0038). Run: npx tsx src/app/keyMap/applyPlan.test.ts
 */
import {
  intentFromApplyPlan,
  resolveApplyPlan,
} from "./applyPlan";
import { applyKeyMapOntoProject } from "./service";
import type { KeyMapJoinCtx } from "./types";
import type { Project } from "../../types/pipeline";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const map = {
  id: "map_1",
  name: "M",
  entries: [{ from: "a", to: "1" }],
  storage: { kind: "seed" as const },
  output_columns: ["product_id", "variant_code"],
  to_column: "product_id",
};

const ctx: KeyMapJoinCtx = {
  hostQueryId: "fact",
  joinStepIndex: 0,
  rightQueryId: "dim",
  leftOn: ["external_sku"],
  rightOn: ["item_code"],
  joinType: "left",
};

const project = {
  id: "p",
  name: "t",
  connections: [],
  sources: [],
  workspace: {
    queries: [
      {
        id: "fact",
        name: "fact",
        steps: [
          {
            type: "Join",
            payload: {
              right_query_id: "dim",
              join_type: "left",
              left_on: ["external_sku"],
              right_on: ["item_code"],
            },
          },
        ],
      },
      { id: "dim", name: "dim", steps: [] },
    ],
    focus_query_id: "fact",
    key_maps: [map],
  },
  dbt_target: "v1",
} as Project;

{
  const plan = resolveApplyPlan(map as never, ctx, "right", {
    side: "right",
    bindings: [
      {
        map_column: "product_id",
        destination_column: "canonical_product_id",
      },
      {
        map_column: "variant_code",
        destination_column: "canonical_variant_code",
      },
    ],
  });
  assert(!("error" in plan), "plan ok");
  if ("error" in plan) throw new Error(plan.error);
  assert(
    plan.outputBindingsRight?.some(
      (b) => b.destination_column === "canonical_product_id",
    ),
    "right destinations on plan",
  );
  assert(!plan.outputBindingsLeft?.length, "left unbound for right side");
  const applied = applyKeyMapOntoProject(project, intentFromApplyPlan(plan));
  assert(applied.result.status === "ok", "fold ok");
  const dim =
    applied.result.status === "ok"
      ? applied.result.workspace.queries.find((q) => q.id === "dim")!
      : null;
  const step = dim?.steps.find((s) => s.type === "ApplyKeyMap");
  assert(!!step && step.type === "ApplyKeyMap", "Apply on dim");
  const bindings =
    step && step.type === "ApplyKeyMap"
      ? step.payload.output_bindings ?? []
      : [];
  assert(
    bindings.some((b) => b.destination_column === "canonical_variant_code"),
    `payload: ${JSON.stringify(bindings)}`,
  );
}

{
  const plan = resolveApplyPlan(map as never, ctx, "left", {
    side: "left",
    bindings: [
      { map_column: "product_id", destination_column: "mapped_product_id" },
      { map_column: "variant_code", destination_column: "mapped_variant_code" },
    ],
    joinRewrite: {
      leftOn: ["day", "mapped_product_id", "mapped_variant_code"],
      rightOn: ["day", "product_id", "variant_code"],
    },
  });
  assert(!("error" in plan), "left plan ok");
  if ("error" in plan) throw new Error(plan.error);
  assert(
    plan.joinRewrite?.leftOn.includes("day"),
    "keep day in Join rewrite on plan",
  );
  const applied = applyKeyMapOntoProject(project, intentFromApplyPlan(plan));
  assert(applied.result.status === "ok", "left fold ok");
  const join =
    applied.result.status === "ok"
      ? applied.result.workspace.queries
          .find((q) => q.id === "fact")!
          .steps.find((s) => s.type === "Join")
      : null;
  assert(
    !!join &&
      join.type === "Join" &&
      join.payload.left_on.join(",") ===
        "day,mapped_product_id,mapped_variant_code",
    `join ON: ${JSON.stringify(join)}`,
  );
}

console.log("applyPlan.test.ts: ok");
