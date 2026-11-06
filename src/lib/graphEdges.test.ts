import assert from "node:assert/strict";
import { graphEdgesVisuallySame, type GraphEdgeVisual } from "./graphEdges";

const focused: GraphEdgeVisual = {
  id: "from:src->host",
  source: "src",
  target: "host",
  animated: true,
  data: { labelText: "from" },
  style: { stroke: "#7c3aed", strokeWidth: 1.75, strokeDasharray: "2 4" },
  markerEnd: { type: "arrowclosed", color: "#8b5cf6" },
};

const selected: GraphEdgeVisual = {
  ...focused,
  style: { stroke: "#a78bfa", strokeWidth: 2.5, strokeDasharray: "2 4" },
  markerEnd: { type: "arrowclosed", color: "#a78bfa" },
};

assert.equal(graphEdgesVisuallySame([focused], [focused]), true);
assert.equal(
  graphEdgesVisuallySame([focused], [selected]),
  false,
  "selection recolor must replace the edge even when it was already animated",
);

console.log("graphEdges.test.ts: ok");
