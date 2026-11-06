import assert from "node:assert/strict";
import {
  GRAPH_COL_W,
  GRAPH_MARGIN,
  GRAPH_ROW_H,
  placeWithoutOverlap,
  rankGridPosition,
} from "./graphLayout";

// Saved graph: A at depth 0, B at depth 1. One new FromQuery at depth 2.
const savedA = { x: GRAPH_MARGIN, y: GRAPH_MARGIN };
const savedB = { x: GRAPH_MARGIN + GRAPH_COL_W, y: GRAPH_MARGIN };
const preferred = rankGridPosition(2, 0, 1, false);
assert.equal(preferred.x, GRAPH_MARGIN + 2 * GRAPH_COL_W);
assert.ok(preferred.x > savedB.x, "depth 2 sits to the right of depth 1");

const placed = placeWithoutOverlap(preferred, [savedA, savedB], GRAPH_ROW_H);
assert.equal(placed.x, preferred.x);
assert.notDeepEqual(placed, { x: GRAPH_MARGIN, y: GRAPH_MARGIN });
assert.ok(placed.x > savedB.x, "new node is not shifted back onto the origin");

// Same column as an existing card: keep the rank x, step down.
const blocked = placeWithoutOverlap(savedA, [savedA], GRAPH_ROW_H);
assert.equal(blocked.x, savedA.x);
assert.ok(blocked.y >= savedA.y + GRAPH_ROW_H);

console.log("graphLayout.test.ts: ok");
