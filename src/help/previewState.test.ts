import assert from "node:assert/strict";
import { previewScopeLabel, previewStateMessage } from "./previewState";
assert.match(previewStateMessage("queued"), /Computing/);
assert.match(previewStateMessage("error"), /failed/);
assert.match(previewStateMessage("cancelled"), /cancelled/);
assert.match(previewStateMessage("ready"), /No rows/);
assert.match(previewScopeLabel({ focus_query_id: "q", queries: [{ id: "q", name: "Sales", steps: [{ type: "Join",
  payload: { right_query_id: "r", join_type: "left", left_on: [], right_on: [] } }] }] }, "q", 0), /Sales · through s0 Join/);
assert.match(previewScopeLabel(null, null, null), /Select a query/);
console.log("previewState tests passed");
