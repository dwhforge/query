/** Column where-provenance for Join Lens (ASCII-fold names). */

export type JoinColumnOrigin = "key" | "left" | "right" | "downstream";

function fold(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * Classify result columns after a Join.
 * - key: ON columns of this Join (left spelling; both sides matched) — not a row PK
 * - left: from left input only
 * - right: from right input only
 * - downstream: not explained by either side (later transforms / unknown)
 */
export function classifyJoinColumnOrigins(
  resultColumns: string[],
  leftOn: string[],
  leftColumns: string[],
  rightColumns: string[],
): JoinColumnOrigin[] {
  const keyFolds = new Set(leftOn.map(fold));
  const leftFolds = new Set(leftColumns.map(fold));
  const rightFolds = new Set(rightColumns.map(fold));

  return resultColumns.map((name) => {
    const f = fold(name);
    if (keyFolds.has(f)) return "key";
    // Prefixed clash form from some emitters: rightquery__col
    const bare = f.includes("__") ? f.slice(f.lastIndexOf("__") + 2) : f;
    if (leftFolds.has(f)) return "left";
    if (rightFolds.has(f) || rightFolds.has(bare)) return "right";
    return "downstream";
  });
}

export const JOIN_ORIGIN_LABEL: Record<JoinColumnOrigin, string> = {
  key: "join",
  left: "left",
  right: "right",
  downstream: "calc",
};
