import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server.edge";
import { FindRightDialog, TupleFields } from "./FindRightDialog";

const fields = renderToStaticMarkup(createElement(TupleFields, {
  leftOn: ["source_name", "source_region", "source_code"], rightOn: ["right_name", "right_region", "right_code"],
  source: [null, "", "∅"], target: ["NULL", "", "∅"],
}));
assert.ok(fields.includes("source_name") && fields.includes("right_name"));
assert.equal((fields.match(/Changed/g) ?? []).length, 1);
assert.equal((fields.match(/Same/g) ?? []).length, 2);
assert.ok(fields.includes("NULL"));
assert.ok(fields.includes("&quot;&quot;"), "empty string has explicit quoted display");
assert.ok(fields.includes("&quot;∅&quot;"), "literal ∅ is not a null placeholder");
const props = {
  open: true, fromParts: ["∅", ""] as (string | null)[],
  workspace: { focus_query_id: "fact", queries: [] }, hostQueryId: "fact", joinStepIndex: 1,
  connections: [], onClose: () => {}, onAccept: () => {},
};
const dialog = renderToStaticMarkup(createElement(FindRightDialog, props));
assert.ok(dialog.includes('role="dialog"'));
assert.ok(dialog.includes("Ask LLM to rank candidates"));
assert.ok(dialog.includes('aria-describedby="find-right-llm-help"'));
assert.ok(dialog.includes("All Join fields are searched together"));
assert.ok(dialog.includes("Empty or whitespace-only"));
assert.match(dialog, /<button[^>]*disabled=""[^>]*>Add to mapping<\/button>/);
assert.ok(!dialog.includes("per-column") && !dialog.includes("Remap which"));
assert.equal(renderToStaticMarkup(createElement(FindRightDialog, { ...props, open: false })), "");
console.log("FindRightDialog.test.ts: ok");
