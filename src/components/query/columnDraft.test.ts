import assert from "node:assert/strict";
import { chooseColumns, editColumnText, toggleColumn } from "./columnDraft";

const initial = chooseColumns(["date", "region"]);
const typed = editColumnText("  region ,date,  amount  ");
assert.equal(typed.text, "  region ,date,  amount  ");
assert.deepEqual(typed.selected, ["region", "date", "amount"]);
// Committing reads normalized values, it does not transition/reseed visible text.
const committed = [...typed.selected];
assert.deepEqual(committed, ["region", "date", "amount"]);
assert.equal(typed.text, "  region ,date,  amount  ");
assert.deepEqual(initial, { text: "date, region", selected: ["date", "region"] });
assert.deepEqual(toggleColumn(typed, "date"), chooseColumns(["region", "amount"]));
assert.deepEqual(toggleColumn(typed, "new"), chooseColumns(["region", "date", "amount", "new"]));
assert.deepEqual(editColumnText(" , ,  "), { text: " , ,  ", selected: [] });
console.log("columnDraft tests passed");
