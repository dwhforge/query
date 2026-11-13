import assert from "node:assert/strict";
import { ownsLabTask, reconJoinTarget, startLabTask } from "./reconLab";
import type { Workspace } from "../types/pipeline";

assert.equal(startLabTask("sales", "p"), null);
assert.equal(startLabTask("recon_ship_sales", undefined), null);
const task = startLabTask("recon_ship_sales", "p");
assert.deepEqual(task, { projectUid: "p", visible: true });
assert.ok(ownsLabTask(task, "p"));
assert.ok(!ownsLabTask(task, "other"));
assert.equal(ownsLabTask(null, "p"), false);
assert.equal(reconJoinTarget({ queries: [], focus_query_id: "" }), null);
const workspace: Workspace = { focus_query_id: "dirty_recon", queries: [{ id: "dirty_recon", name: "Original",
  steps: [{ type: "FromQuery", payload: { query_id: "sales" } },
    { type: "Filter", payload: { condition: "true" } },
    { type: "Join", payload: { right_query_id: "dim_product", join_type: "left", left_on: ["sku"], right_on: ["id"] } }],
}] };
assert.deepEqual(reconJoinTarget(workspace), { queryId: "dirty_recon", stepIndex: 2 });
assert.equal(reconJoinTarget({ ...workspace, queries: workspace.queries.map((q) => ({ ...q, steps: [] })) }), null);
assert.equal(ownsLabTask({ ...task!, visible: false }, "p"), true);
console.log("reconLab task tests passed");
