import type { JoinTupleReport, JoinTupleValue } from "./bridge";

export type TupleParts = (string | null)[];

/** JSON identity, never a presentation label or a trimmed scalar. */
export function tupleIdentity(parts: TupleParts): string {
  return JSON.stringify(parts);
}

export function tupleCell(value: string | null): string {
  return value === null ? "NULL" : JSON.stringify(value);
}

export function tupleNullCount(parts: TupleParts): number {
  return parts.filter((p) => p === null).length;
}

export function tupleMappingBlock(parts: TupleParts): string | null {
  if (!parts.length) return "No Join key fields are available.";
  if (parts.some((p) => p === null)) {
    return "NULL cannot be represented by this Mapping. Normalize or resolve NULL explicitly before mapping.";
  }
  if (parts.some((p) => p === "" || !p!.trim())) {
    return "Empty or whitespace-only values cannot be represented by a ready Mapping. They are not NULL or the literal ∅.";
  }
  return null;
}

export function findTupleSource(report: JoinTupleReport, parts: TupleParts) {
  const key = tupleIdentity(parts);
  return report.sources.find((s) => tupleIdentity(s.source.parts) === key);
}

export function searchRightTuples(report: JoinTupleReport, search: string): number[] {
  const q = search.toLocaleLowerCase();
  return report.right_universe.flatMap((v, i) =>
    !q || v.parts.some((p) => tupleCell(p).toLocaleLowerCase().includes(q)) ? [i] : [],
  );
}

export function tupleCounts(value: JoinTupleValue): string {
  return `${value.occurrences} row${value.occurrences === 1 ? "" : "s"} · ${Math.max(0, value.occurrences - 1)} duplicate rows · ${tupleNullCount(value.parts)} NULL fields`;
}
