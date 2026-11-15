import type { MatchingTuple } from "../../app/matching/types";

/** Exact values are readable without parsing IDs or collapsing NULL/empty/padding. */
export function recordValue(value: string | null | undefined): string {
  if (value === undefined) return "not acquired";
  if (value === null) return "NULL (SQL null)";
  if (value === "") return '"" (empty)';
  if (value.trim() !== value || /[\n\r\t]/.test(value)) return `${JSON.stringify(value)} (whitespace preserved)`;
  return value;
}

export function RecordValues({ fields, values }: { fields: readonly string[]; values: MatchingTuple }) {
  return <dl className="min-w-0 space-y-0.5 text-[11px]">
    {values.map((value, i) => <div key={i} className="break-words [overflow-wrap:anywhere]">
      <dt className="inline text-slate-500">{fields[i] ?? `Field ${i + 1}`}: </dt>
      <dd title={value === null ? "SQL NULL" : value === undefined ? "Not acquired" : `Exact text: ${JSON.stringify(value)}`} className="inline whitespace-pre-wrap text-slate-200">{recordValue(value)}</dd>
    </div>)}
  </dl>;
}
