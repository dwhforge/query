/**
 * Apply+Join review helpers, ADR-0037 (run: npx tsx src/lib/keyMapApplyReview.test.ts).
 */
import {
  defaultReviewDestinations,
  defaultReviewRightCols,
  formatJoinOn,
  validateApplyReview,
} from "./keyMap";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}
function eq(a: unknown, b: unknown, msg: string) {
  assert(JSON.stringify(a) === JSON.stringify(b), `${msg}: ${JSON.stringify(a)}`);
}

const dests = defaultReviewDestinations(["company_id", "region"], "company");
eq(dests, ["company", "region"], "first → left ON, others → map column");

eq(
  defaultReviewRightCols(dests, ["company_id"]),
  ["company_id", "region"],
  "right defaults by index, then same name",
);
eq(
  defaultReviewRightCols(["a", "B"], ["x", "b"]).slice(1),
  ["b"],
  "same-name match is case-insensitive when index missing",
);

eq(formatJoinOn(["a", "b"], ["x", "y"]), "a, b = x, y", "ON preview");

assert(validateApplyReview(["a", "b"], ["x", "y"], true) === null, "valid");
assert(validateApplyReview(["a", "A"], [], false) !== null, "duplicate dest");
assert(validateApplyReview(["a", ""], [], false) !== null, "empty dest");
assert(validateApplyReview(["a"], [" "], true) !== null, "empty right");
assert(validateApplyReview(["a"], [" "], false) === null, "right ignored w/o rewrite");

console.log("keyMapApplyReview.test.ts: ok");
