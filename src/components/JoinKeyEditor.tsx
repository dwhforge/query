import type { ColumnMetadata } from "../types/pipeline";
import type { JoinKeyPair } from "../lib/joinKeys";
import { emptyJoinKeyPair } from "../lib/joinKeys";

type Props = {
  pairs: JoinKeyPair[];
  onChange: (pairs: JoinKeyPair[]) => void;
  leftColumns: ColumnMetadata[];
  rightColumns: ColumnMetadata[];
  leftLoading?: boolean;
  rightLoading?: boolean;
};

function ColSelect({
  value,
  onChange,
  columns,
  loading,
  side,
}: {
  value: string;
  onChange: (v: string) => void;
  columns: ColumnMetadata[];
  loading?: boolean;
  side: "left" | "right";
}) {
  const known = columns.some((c) => c.name === value);
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100 outline-none focus:ring-2 focus:ring-teal-700 disabled:opacity-50"
      disabled={loading && columns.length === 0}
      title={side === "left" ? "This query (before Join)" : "Right query"}
    >
      <option value="">
        {loading ? "loading…" : side === "left" ? "left col…" : "right col…"}
      </option>
      {value && !known && (
        <option value={value}>
          {value} (current)
        </option>
      )}
      {columns.map((c) => (
        <option key={c.name} value={c.name}>
          {c.type ? `${c.name} · ${c.type}` : c.name}
        </option>
      ))}
    </select>
  );
}

export function JoinKeyEditor({
  pairs,
  onChange,
  leftColumns,
  rightColumns,
  leftLoading,
  rightLoading,
}: Props) {
  const rows = pairs.length > 0 ? pairs : [emptyJoinKeyPair()];

  function updateAt(i: number, patch: Partial<JoinKeyPair>) {
    const next = rows.map((p, idx) => (idx === i ? { ...p, ...patch } : p));
    onChange(next);
  }

  function addPair() {
    onChange([...rows, emptyJoinKeyPair()]);
  }

  function removeAt(i: number) {
    if (rows.length <= 1) {
      onChange([emptyJoinKeyPair()]);
      return;
    }
    onChange(rows.filter((_, idx) => idx !== i));
  }

  return (
    <div className="space-y-1.5">
      <label className="block text-[10px] uppercase tracking-wide text-slate-500">
        Keys (this = other)
      </label>
      {rows.map((pair, i) => (
        <div key={i} className="flex items-center gap-1">
          <ColSelect
            side="left"
            value={pair.left}
            onChange={(left) =>
              updateAt(i, {
                left,
                right: pair.right || left,
              })
            }
            columns={leftColumns}
            loading={leftLoading}
          />
          <span className="shrink-0 text-slate-600">=</span>
          <ColSelect
            side="right"
            value={pair.right}
            onChange={(right) => updateAt(i, { right })}
            columns={rightColumns}
            loading={rightLoading}
          />
          <button
            type="button"
            className="shrink-0 rounded px-1.5 py-1 text-[11px] text-slate-500 hover:bg-slate-800 hover:text-slate-200"
            title="Remove key pair"
            onClick={() => removeAt(i)}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="text-[11px] font-medium text-teal-400/90 hover:text-teal-300"
        onClick={addPair}
      >
        + key
      </button>
      {(leftColumns.length === 0 || rightColumns.length === 0) &&
        !leftLoading &&
        !rightLoading && (
          <p className="text-[10px] text-slate-600">
            Pick columns from the lists (schema from preview). Empty list =
            preview that side first or type is unavailable.
          </p>
        )}
    </div>
  );
}
