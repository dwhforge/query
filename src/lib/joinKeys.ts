import type { ColumnMetadata } from "../types/pipeline";

export type JoinKeyPair = { left: string; right: string };

export function emptyJoinKeyPair(): JoinKeyPair {
  return { left: "", right: "" };
}

/** Sync editor pairs from IR arrays (pad to equal length, min 1 row). */
export function pairsFromOn(
  leftOn: string[],
  rightOn: string[],
): JoinKeyPair[] {
  const n = Math.max(leftOn.length, rightOn.length, 1);
  const out: JoinKeyPair[] = [];
  for (let i = 0; i < n; i++) {
    const left = (leftOn[i] ?? "").trim();
    const right = (rightOn[i] ?? leftOn[i] ?? "").trim();
    out.push({ left, right });
  }
  if (out.every((p) => !p.left && !p.right)) {
    return [emptyJoinKeyPair()];
  }
  return out;
}

export function pairsToOn(pairs: JoinKeyPair[]): {
  left_on: string[];
  right_on: string[];
} {
  const filled = pairs
    .map((p) => ({
      left: p.left.trim(),
      right: (p.right.trim() || p.left.trim()).trim(),
    }))
    .filter((p) => p.left.length > 0);
  if (filled.length === 0) {
    return { left_on: [], right_on: [] };
  }
  return {
    left_on: filled.map((p) => p.left),
    right_on: filled.map((p) => p.right),
  };
}

export function joinPairsComplete(pairs: JoinKeyPair[]): boolean {
  const { left_on } = pairsToOn(pairs);
  return left_on.length > 0;
}

/** Prefer shared names; rank id / *_id; else empty (caller must not invent "id"). */
export function suggestJoinPairs(
  leftCols: ColumnMetadata[],
  rightCols: ColumnMetadata[],
): JoinKeyPair[] {
  const leftNames = leftCols.map((c) => c.name);
  const rightSet = new Set(rightCols.map((c) => c.name));
  const common = leftNames.filter((n) => rightSet.has(n));
  if (common.length === 0) {
    return [emptyJoinKeyPair()];
  }

  const score = (name: string): number => {
    const lower = name.toLowerCase();
    if (lower === "id") return 100;
    if (lower.endsWith("_id")) return 80;
    if (lower === "region" || lower === "key") return 60;
    return 40;
  };
  common.sort((a, b) => score(b) - score(a) || a.localeCompare(b));
  // One clear best, or a single common column → auto-fill that pair only.
  if (common.length === 1 || score(common[0]) >= 60) {
    return [{ left: common[0], right: common[0] }];
  }
  // Ambiguous many commons with weak scores — leave empty for the user.
  return [emptyJoinKeyPair()];
}

export function formatJoinKeyLabel(leftOn: string[], rightOn: string[]): string {
  const n = Math.max(leftOn.length, rightOn.length);
  if (n === 0) return "?";
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const l = leftOn[i] ?? "";
    const r = rightOn[i] ?? l;
    if (!l && !r) continue;
    parts.push(l === r ? l : `${l}=${r}`);
  }
  return parts.join(", ") || "?";
}
