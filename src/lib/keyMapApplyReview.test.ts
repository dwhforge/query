/**
 * Apply+Join review helpers, ADR-0037 (run: npx tsx src/lib/keyMapApplyReview.test.ts).
 */
import {
  applyReviewBindingsForSide,
  buildApplyReviewState,
  confirmApplyReview,
  defaultReviewDestinations,
  defaultReviewRightCols,
  formatJoinOn,
  validateApplyReview,
  type ApplyReviewState,
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

eq(
  applyReviewBindingsForSide("left", [
    { map_column: "a", destination_column: "A" },
  ]),
  { outputBindingsLeft: [{ map_column: "a", destination_column: "A" }] },
  "left routes to outputBindingsLeft",
);
eq(
  applyReviewBindingsForSide("right", [
    { map_column: "a", destination_column: "canonical_a" },
  ]),
  {
    outputBindingsRight: [
      { map_column: "a", destination_column: "canonical_a" },
    ],
  },
  "right routes to outputBindingsRight",
);
eq(
  applyReviewBindingsForSide("both", [
    { map_column: "a", destination_column: "A" },
  ]),
  {
    outputBindingsLeft: [{ map_column: "a", destination_column: "A" }],
    outputBindingsRight: [{ map_column: "a", destination_column: "A" }],
  },
  "both routes both sides",
);

{
  const built = buildApplyReviewState({
    side: "left",
    outCols: ["product_id", "variant_code", "category_id"],
    leftOnCols: ["external_sku"],
    rightOnCols: ["sku"],
  });
  assert(built.outputs.length === 3, "3 outputs");
  assert(built.outputs[0]!.includeJoin, "first in Join by default");
  assert(!built.outputs[1]!.includeJoin, "second not forced into Join when ON arity=1");
  assert(!built.outputs[2]!.includeJoin, "extra output not forced into Join");
  assert(built.keepEqualities.length === 1, "keep old ON row");
  assert(!built.keepEqualities[0]!.keep, "old ON opt-in (not duplicated by default)");

  // Apply all three; Join only product+variant; also keep day=day.
  const review: ApplyReviewState = {
    ...built,
    rewriteJoin: true,
    keepEqualities: [
      { left: "day", right: "day", keep: true },
      { left: "external_sku", right: "sku", keep: false },
    ],
    outputs: built.outputs.map((o, i) => ({
      ...o,
      destination:
        i === 0
          ? "mapped_product_id"
          : i === 1
            ? "mapped_variant_code"
            : "category_id",
      includeApply: true,
      includeJoin: i < 2,
      rightCol: i === 0 ? "product_id" : i === 1 ? "variant_code" : "",
    })),
  };
  const conf = confirmApplyReview(review);
  assert(conf.error === null, `confirm ok: ${conf.error}`);
  eq(
    conf.bindings,
    [
      { map_column: "product_id", destination_column: "mapped_product_id" },
      { map_column: "variant_code", destination_column: "mapped_variant_code" },
      { map_column: "category_id", destination_column: "category_id" },
    ],
    "all three bindings",
  );
  eq(
    conf.joinRewrite,
    {
      leftOn: ["day", "mapped_product_id", "mapped_variant_code"],
      rightOn: ["day", "product_id", "variant_code"],
    },
    "Join = kept day + two map outs (not category)",
  );
}

console.log("keyMapApplyReview.test.ts: ok");
