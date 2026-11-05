/**
 * ApplyPlan resolution (ADR-0038). Run: npx tsx src/app/keyMap/applyPlan.test.ts
 */
import {
  intentFromApplyPlan,
  keyMapRevisionFingerprint,
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
  entries: [{ from: "a", to: "1", output_values: ["1", "x"] }],
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
  const plan = resolveApplyPlan(
    map as never,
    ctx,
    "right",
    {
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
    },
    project.workspace,
  );
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
  const plan = resolveApplyPlan(
    map as never,
    ctx,
    "left",
    {
      side: "left",
      bindings: [
        { map_column: "product_id", destination_column: "mapped_product_id" },
        { map_column: "variant_code", destination_column: "mapped_variant_code" },
      ],
      joinRewrite: {
        leftOn: ["day", "mapped_product_id", "mapped_variant_code"],
        rightOn: ["day", "product_id", "variant_code"],
      },
    },
    project.workspace,
  );
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

{
  // Confirmed empty choice must refuse — not fall through to defaults.
  const empty = resolveApplyPlan(
    map as never,
    ctx,
    "left",
    { side: "left", bindings: [] },
    project.workspace,
  );
  assert("error" in empty, "empty confirmed choice errors");
  if ("error" in empty) {
    assert(/no output bindings/i.test(empty.error), empty.error);
  }

  const unknown = resolveApplyPlan(
    map as never,
    ctx,
    "left",
    {
      side: "left",
      bindings: [{ map_column: "nope", destination_column: "x" }],
    },
    project.workspace,
  );
  assert("error" in unknown, "unknown map_column errors");

  const dupDest = resolveApplyPlan(
    map as never,
    ctx,
    "left",
    {
      side: "left",
      bindings: [
        { map_column: "product_id", destination_column: "same" },
        { map_column: "variant_code", destination_column: "same" },
      ],
    },
    project.workspace,
  );
  assert("error" in dupDest, "duplicate destination errors");
}

{
  // Change map values without changing row count after plan → commit refuses; R2 stays.
  const plan = resolveApplyPlan(
    map as never,
    ctx,
    "left",
    {
      side: "left",
      bindings: [
        { map_column: "product_id", destination_column: "mapped_product_id" },
        { map_column: "variant_code", destination_column: "mapped_variant_code" },
      ],
    },
    project.workspace,
  );
  assert(!("error" in plan), "stale setup plan ok");
  if ("error" in plan) throw new Error(plan.error);

  const r2 = {
    ...map,
    entries: [{ from: "a", to: "CHANGED", output_values: ["CHANGED", "x"] }],
  };
  const moved = {
    ...project,
    workspace: {
      ...project.workspace,
      key_maps: [r2],
    },
  } as Project;
  assert(
    keyMapRevisionFingerprint(r2 as never, moved.workspace) !== plan.mapRevision,
    "fingerprint must see value change at same row count",
  );
  const fold = applyKeyMapOntoProject(moved, intentFromApplyPlan(plan));
  assert(fold.result.status === "stale", "stale refuses commit");
  assert(fold.project === moved, "project untouched");
  assert(
    fold.project.workspace.key_maps?.[0]?.entries?.[0]?.to === "CHANGED" ||
      fold.project.workspace.key_maps?.[0]?.entries?.[0]?.output_values?.[0] ===
        "CHANGED",
    "R2 preserved",
  );
}

{
  // Trailing space in output only → different revision / stale commit.
  const spaced = {
    ...map,
    entries: [{ from: "a", to: "1 ", output_values: ["1 ", "x"] }],
  };
  assert(
    keyMapRevisionFingerprint(spaced as never, project.workspace) !==
      keyMapRevisionFingerprint(map as never, project.workspace),
    "significant whitespace must change fingerprint",
  );
  const plan = resolveApplyPlan(
    map as never,
    ctx,
    "left",
    {
      side: "left",
      bindings: [
        { map_column: "product_id", destination_column: "mapped_product_id" },
        { map_column: "variant_code", destination_column: "mapped_variant_code" },
      ],
    },
    project.workspace,
  );
  assert(!("error" in plan), "space setup plan ok");
  if ("error" in plan) throw new Error(plan.error);
  const moved = {
    ...project,
    workspace: { ...project.workspace, key_maps: [spaced] },
  } as Project;
  const fold = applyKeyMapOntoProject(moved, intentFromApplyPlan(plan));
  assert(fold.result.status === "stale", "whitespace-only change is stale");
  assert(fold.project === moved, "whitespace stale leaves project untouched");
}

{
  // Query map: upstream FromQuery change with map query steps unchanged → stale.
  const qMap = {
    id: "qm",
    name: "QM",
    entries: [],
    storage: { kind: "query" as const, query_id: "q_map" },
    from_column: "sku",
    output_columns: ["product_id"],
    to_column: "product_id",
  };
  const wsBase = {
    queries: [
      {
        id: "raw_matches",
        name: "raw",
        steps: [
          {
            type: "SqlModel",
            payload: { raw_sql: "select 'A' as sku, 'P1' as product_id" },
          },
        ],
      },
      {
        id: "q_map",
        name: "map",
        steps: [
          {
            type: "FromQuery",
            payload: { query_id: "raw_matches" },
          },
        ],
      },
      {
        id: "fact",
        name: "fact",
        steps: [
          {
            type: "Join",
            payload: {
              right_query_id: "dim",
              join_type: "left",
              left_on: ["sku"],
              right_on: ["sku"],
            },
          },
        ],
      },
      { id: "dim", name: "dim", steps: [] },
    ],
    focus_query_id: "fact",
    key_maps: [qMap],
  };
  const qProject = {
    ...project,
    workspace: wsBase,
  } as Project;
  const plan = resolveApplyPlan(
    qMap as never,
    {
      hostQueryId: "fact",
      joinStepIndex: 0,
      rightQueryId: "dim",
      leftOn: ["sku"],
      rightOn: ["sku"],
      joinType: "left",
    },
    "left",
    {
      side: "left",
      bindings: [
        { map_column: "product_id", destination_column: "product_id" },
      ],
    },
    qProject.workspace,
  );
  assert(!("error" in plan), "query plan ok");
  if ("error" in plan) throw new Error(plan.error);

  const wsUpstream = {
    ...wsBase,
    queries: wsBase.queries.map((q) =>
      q.id === "raw_matches"
        ? {
            ...q,
            steps: [
              {
                type: "SqlModel",
                payload: {
                  raw_sql: "select 'A' as sku, 'P2' as product_id",
                },
              },
            ],
          }
        : q,
    ),
  };
  assert(
    keyMapRevisionFingerprint(qMap as never, wsUpstream as never) !==
      plan.mapRevision,
    "upstream query change must change fingerprint",
  );
  const moved = { ...qProject, workspace: wsUpstream } as Project;
  const fold = applyKeyMapOntoProject(moved, intentFromApplyPlan(plan));
  assert(fold.result.status === "stale", "upstream change is stale");
  assert(fold.project === moved, "upstream stale leaves project untouched");
}

console.log("applyPlan.test.ts: ok");
