import assert from "node:assert/strict";
import {
  buildLensMatchingPlan,
  preferIdentityFields,
  resolveLeftSourceQueryId,
} from "./planDefaults";
import type { Workspace } from "../../types/pipeline";

{
  assert.deepEqual(
    preferIdentityFields(["vendor_name", "region", "vendor_id", "category"]),
    ["vendor_id"],
    "prefers vendor_id over vendor_name",
  );
  assert.deepEqual(
    preferIdentityFields(["name", "region"]),
    ["name"],
    "falls back to first column when nothing id-like",
  );
}

{
  const plan = buildLensMatchingPlan({
    leftOn: ["vendor_label", "region"],
    rightOn: ["vendor_name", "region"],
    sourceRef: "pos_invoices",
    targetRef: "dim_vendor",
    targetColumns: ["vendor_id", "vendor_name", "region", "category"],
    scope: "cohort",
  });
  assert.equal(plan.sourceRef, "pos_invoices");
  assert.deepEqual(plan.mapKeyFields, ["vendor_label", "region"]);
  assert.deepEqual(plan.targetIdentityFields, ["vendor_id"]);
  assert.deepEqual(plan.outputs, ["vendor_id"]);
  assert.deepEqual(plan.comparisons, [
    {
      sourceField: "vendor_label",
      targetField: "vendor_name",
      role: "soft_signal",
    },
    {
      sourceField: "region",
      targetField: "region",
      role: "soft_signal",
    },
  ]);
}

{
  const ws: Workspace = {
    focus_query_id: "dirty_exact_pair",
    key_maps: [],
    queries: [
      { id: "pos_invoices", name: "pos_invoices", steps: [] },
      {
        id: "dirty_exact_pair",
        name: "dirty_exact_pair",
        steps: [
          { type: "FromQuery", payload: { query_id: "pos_invoices" } },
          {
            type: "Join",
            payload: {
              right_query_id: "dim_vendor",
              join_type: "left",
              left_on: ["vendor_label"],
              right_on: ["vendor_name"],
            },
          },
        ],
      },
    ],
  };
  assert.equal(
    resolveLeftSourceQueryId(ws, "dirty_exact_pair", 1),
    "pos_invoices",
  );
}

console.log("planDefaults.test.ts: ok");
