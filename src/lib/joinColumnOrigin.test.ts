import assert from "node:assert/strict";
import { classifyJoinColumnOrigins } from "./joinColumnOrigin";

const origins = classifyJoinColumnOrigins(
  ["crm_id", "name", "name_1", "erp_id"],
  ["crm_id"],
  ["crm_id", "name"],
  ["erp_id", "name"],
);

assert.deepEqual(origins, ["key", "left", "right", "right"]);

const noFalseLeft = classifyJoinColumnOrigins(
  ["qty_1"],
  ["id"],
  ["id", "qty_1"],
  ["id", "qty"],
);
assert.equal(noFalseLeft[0], "left");

console.log("joinColumnOrigin.test.ts: ok");
