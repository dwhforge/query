/** Fields that change the drawn edge (selection highlight included). */

export type GraphEdgeVisual = {
  id: string;
  source: string;
  target: string;
  animated?: boolean;
  style?: {
    stroke?: unknown;
    strokeWidth?: unknown;
    strokeDasharray?: unknown;
  };
  markerEnd?: { type?: unknown; color?: unknown } | string | undefined;
  data?: { labelText?: string } | undefined;
};

function styleKey(style: GraphEdgeVisual["style"]): string {
  if (!style) return "";
  return `${String(style.stroke ?? "")}|${String(style.strokeWidth ?? "")}|${String(style.strokeDasharray ?? "")}`;
}

function markerKey(marker: GraphEdgeVisual["markerEnd"]): string {
  if (!marker) return "";
  if (typeof marker === "string") return marker;
  return `${String(marker.type ?? "")}|${String(marker.color ?? "")}`;
}

/** True when React Flow can keep the previous edge array. */
export function graphEdgesVisuallySame(
  current: readonly GraphEdgeVisual[],
  next: readonly GraphEdgeVisual[],
): boolean {
  if (current.length !== next.length) return false;
  for (let i = 0; i < current.length; i++) {
    const a = current[i]!;
    const b = next[i]!;
    if (a.id !== b.id || a.source !== b.source || a.target !== b.target) {
      return false;
    }
    if (Boolean(a.animated) !== Boolean(b.animated)) return false;
    if ((a.data?.labelText ?? "") !== (b.data?.labelText ?? "")) return false;
    if (styleKey(a.style) !== styleKey(b.style)) return false;
    if (markerKey(a.markerEnd) !== markerKey(b.markerEnd)) return false;
  }
  return true;
}
