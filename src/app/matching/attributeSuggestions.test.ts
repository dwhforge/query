import assert from "node:assert/strict";
import { suggestSharedDescriptiveField } from "./attributeSuggestions";
assert.deepEqual(suggestSharedDescriptiveField(["crm_id", "name"], ["erp_id", "name"]),
  { sourceField: "name", targetField: "name", role: "soft_signal" });
assert.deepEqual(suggestSharedDescriptiveField(["NAME"], ["name"]),
  { sourceField: "NAME", targetField: "name", role: "soft_signal" });
assert.equal(suggestSharedDescriptiveField(["crm_id"], ["erp_id"]), null);
assert.equal(suggestSharedDescriptiveField(["name"], ["description"]), null,
  "different semantic fields must not be guessed automatically");
console.log("Shared descriptive matching field suggestion tests passed");
