/**
 * Stable left-to-right rank grid for the query canvas.
 * New nodes use the same origin as the first layout. A fresh batch is not
 * re-based onto (margin, margin), or a single deep node lands on top of depth 0.
 */

export const GRAPH_COL_W = 280;
export const GRAPH_ROW_H = 112;
export const GRAPH_MARGIN = 64;
export const GRAPH_EXPANDED_PITCH = 200;
/** Conservative card box so a new node is not dropped on an existing one. */
const NODE_W = 230;
const NODE_H = 96;

export function rankGridPosition(
  depth: number,
  row: number,
  bucketLength: number,
  expanded: boolean,
): { x: number; y: number } {
  const pitch = expanded ? GRAPH_EXPANDED_PITCH : GRAPH_ROW_H;
  const n = Math.max(1, bucketLength);
  const r = Math.max(0, Math.min(row, n - 1));
  return {
    x: GRAPH_MARGIN + depth * GRAPH_COL_W,
    y: GRAPH_MARGIN + (r - (n - 1) / 2) * pitch,
  };
}

function boxesOverlap(
  ax: number,
  ay: number,
  bx: number,
  by: number,
): boolean {
  return ax < bx + NODE_W && ax + NODE_W > bx && ay < by + NODE_H && ay + NODE_H > by;
}

/** Keep x on the rank column; step down until the card clears occupied boxes. */
export function placeWithoutOverlap(
  preferred: { x: number; y: number },
  occupied: readonly { x: number; y: number }[],
  pitch: number,
): { x: number; y: number } {
  let y = preferred.y;
  const step = pitch > 0 ? pitch : GRAPH_ROW_H;
  for (let i = 0; i < 32; i++) {
    const hit = occupied.some((o) => boxesOverlap(preferred.x, y, o.x, o.y));
    if (!hit) return { x: preferred.x, y };
    y += step;
  }
  return { x: preferred.x, y };
}
