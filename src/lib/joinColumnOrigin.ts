/** Column where-provenance for Join Lens (ASCII-fold names). */

export type JoinColumnOrigin = "key" | "left" | "right" | "downstream";

export type SidePinResult = {
  /** Rows to show in the dock (key matches filtered/ranked to this result row). */
  rows: unknown[][];
  /** True when non-key columns uniquely identified parent row(s). */
  pinned: boolean;
};

function fold(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === "number" || typeof b === "number") {
    const na = Number(a);
    const nb = Number(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na === nb;
  }
  return String(a) === String(b);
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

type PinCheck = { sideIdx: number; value: unknown; isKey: boolean };

/**
 * Among key-level matches, prefer the parent row(s) that match this result
 * row's side columns. Without non-key overlap we keep all key matches
 * (cannot tell which left/right row produced the center row).
 */
export function pinSideRowsToResult(args: {
  side: "left" | "right";
  sideRows: unknown[][];
  sideColumns: { name: string }[];
  resultRow: unknown[];
  resultColumns: { name: string }[];
  origins: JoinColumnOrigin[];
  leftOn: string[];
  rightOn: string[];
}): SidePinResult {
  const {
    side,
    sideRows,
    sideColumns,
    resultRow,
    resultColumns,
    origins,
    leftOn,
    rightOn,
  } = args;
  if (sideRows.length <= 1) {
    return { rows: sideRows, pinned: false };
  }

  const sideByFold = new Map(
    sideColumns.map((c, i) => [fold(c.name), i] as const),
  );
  const resultByFold = new Map(
    resultColumns.map((c, i) => [fold(c.name), i] as const),
  );
  const checks: PinCheck[] = [];
  const usedSide = new Set<number>();

  const addCheck = (sideIdx: number, resultIdx: number, isKey: boolean) => {
    if (usedSide.has(sideIdx)) return;
    usedSide.add(sideIdx);
    checks.push({
      sideIdx,
      value: resultRow[resultIdx] ?? null,
      isKey,
    });
  };

  // Key pairs: result uses left_on spelling; right side uses right_on names.
  for (let k = 0; k < leftOn.length; k++) {
    const resultIdx = resultByFold.get(fold(leftOn[k]!));
    if (resultIdx === undefined) continue;
    const sideName = side === "left" ? leftOn[k]! : rightOn[k] ?? leftOn[k]!;
    const sideIdx = sideByFold.get(fold(sideName));
    if (sideIdx === undefined) continue;
    addCheck(sideIdx, resultIdx, true);
  }

  for (let i = 0; i < resultColumns.length; i++) {
    const origin = origins[i];
    if (origin !== side) continue;
    const name = resultColumns[i]!.name;
    const f = fold(name);
    let sideIdx = sideByFold.get(f);
    if (sideIdx === undefined && f.includes("__")) {
      sideIdx = sideByFold.get(f.slice(f.lastIndexOf("__") + 2));
    }
    if (sideIdx === undefined) continue;
    addCheck(sideIdx, i, false);
  }

  const nonKey = checks.filter((c) => !c.isKey);
  if (nonKey.length === 0) {
    return { rows: sideRows, pinned: false };
  }

  const scored = sideRows.map((row) => {
    let score = 0;
    for (const c of checks) {
      if (valuesEqual(row[c.sideIdx], c.value)) score += 1;
    }
    return { row, score };
  });
  const perfect = checks.length;
  const perfectRows = scored.filter((s) => s.score === perfect).map((s) => s.row);
  if (perfectRows.length > 0 && perfectRows.length < sideRows.length) {
    return { rows: perfectRows, pinned: true };
  }
  if (perfectRows.length === sideRows.length) {
    // All key matches also match non-keys (e.g. identical payload) — still "pinned".
    return { rows: perfectRows, pinned: true };
  }

  // Partial: surface best-scoring rows first; pin if a unique winner beats key-only.
  const max = Math.max(...scored.map((s) => s.score));
  const keyOnlyScore = checks.length - nonKey.length;
  if (max > keyOnlyScore) {
    const best = scored.filter((s) => s.score === max).map((s) => s.row);
    if (best.length < sideRows.length) {
      return { rows: best, pinned: true };
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return { rows: scored.map((s) => s.row), pinned: false };
}
