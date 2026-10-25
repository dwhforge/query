import { useState } from "react";

export type PaletteStepKind =
  | "RenameColumn"
  | "DeriveColumn"
  | "GroupBy"
  | "SortBy"
  | "CustomSql";

interface StepPaletteProps {
  disabled?: boolean;
  columnChoices: string[];
  onAddRename: (from: string, to: string) => void;
  onAddDerive: (name: string, expression: string) => void;
  onAddGroupBy: (dimensions: string[], aggregates: string[]) => void;
  onAddSort: (column: string, descending: boolean) => void;
  onAddCustomSql: (rawSql: string) => void;
}

const KINDS: { id: PaletteStepKind; label: string }[] = [
  { id: "RenameColumn", label: "Rename" },
  { id: "DeriveColumn", label: "Derive" },
  { id: "GroupBy", label: "GroupBy" },
  { id: "SortBy", label: "Sort" },
  { id: "CustomSql", label: "SQL" },
];

export function StepPalette({
  disabled,
  columnChoices,
  onAddRename,
  onAddDerive,
  onAddGroupBy,
  onAddSort,
  onAddCustomSql,
}: StepPaletteProps) {
  const [kind, setKind] = useState<PaletteStepKind>("RenameColumn");
  const [renameFrom, setRenameFrom] = useState("");
  const [renameTo, setRenameTo] = useState("");
  const [deriveName, setDeriveName] = useState("");
  const [deriveExpr, setDeriveExpr] = useState("");
  const [groupDims, setGroupDims] = useState("");
  const [groupAggs, setGroupAggs] = useState("count(*) as n");
  const [sortCol, setSortCol] = useState("");
  const [sortDesc, setSortDesc] = useState(false);
  const [customSql, setCustomSql] = useState(
    "select * from {{prev_step}}",
  );

  function apply() {
    if (disabled) return;
    switch (kind) {
      case "RenameColumn": {
        const from = renameFrom.trim();
        const to = renameTo.trim();
        if (!from || !to) return;
        onAddRename(from, to);
        break;
      }
      case "DeriveColumn": {
        const name = deriveName.trim();
        const expression = deriveExpr.trim();
        if (!name || !expression) return;
        onAddDerive(name, expression);
        break;
      }
      case "GroupBy": {
        const dimensions = groupDims
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const aggregates = groupAggs
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (dimensions.length === 0 || aggregates.length === 0) return;
        onAddGroupBy(dimensions, aggregates);
        break;
      }
      case "SortBy": {
        const column = sortCol.trim();
        if (!column) return;
        onAddSort(column, sortDesc);
        break;
      }
      case "CustomSql": {
        const raw = customSql.trim();
        if (!raw) return;
        onAddCustomSql(raw);
        break;
      }
    }
  }

  const colDatalistId = "step-palette-cols";

  return (
    <div>
      <label className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
        Add step
      </label>
      <div className="mb-2 flex flex-wrap gap-1">
        {KINDS.map((k) => (
          <button
            key={k.id}
            type="button"
            disabled={disabled}
            onClick={() => setKind(k.id)}
            className={`rounded-md px-2 py-1 text-[11px] font-medium disabled:opacity-40 ${
              kind === k.id
                ? "bg-teal-500/25 text-teal-100"
                : "bg-slate-900 text-slate-400 hover:text-slate-200"
            }`}
          >
            {k.label}
          </button>
        ))}
      </div>

      <datalist id={colDatalistId}>
        {columnChoices.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>

      {kind === "RenameColumn" && (
        <div className="mb-1 flex gap-1">
          <input
            list={colDatalistId}
            value={renameFrom}
            onChange={(e) => setRenameFrom(e.target.value)}
            disabled={disabled}
            placeholder="from"
            className="w-1/2 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100 outline-none focus:ring-2 focus:ring-teal-700 disabled:opacity-40"
          />
          <input
            value={renameTo}
            onChange={(e) => setRenameTo(e.target.value)}
            disabled={disabled}
            placeholder="to"
            className="w-1/2 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100 outline-none focus:ring-2 focus:ring-teal-700 disabled:opacity-40"
          />
        </div>
      )}

      {kind === "DeriveColumn" && (
        <>
          <input
            value={deriveName}
            onChange={(e) => setDeriveName(e.target.value)}
            disabled={disabled}
            placeholder="new column name"
            className="mb-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100 outline-none focus:ring-2 focus:ring-teal-700 disabled:opacity-40"
          />
          <input
            value={deriveExpr}
            onChange={(e) => setDeriveExpr(e.target.value)}
            disabled={disabled}
            placeholder="amount * 1.2"
            className="mb-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100 outline-none focus:ring-2 focus:ring-teal-700 disabled:opacity-40"
          />
        </>
      )}

      {kind === "GroupBy" && (
        <>
          <input
            list={colDatalistId}
            value={groupDims}
            onChange={(e) => setGroupDims(e.target.value)}
            disabled={disabled}
            placeholder="dimensions: region, date"
            className="mb-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100 outline-none focus:ring-2 focus:ring-teal-700 disabled:opacity-40"
          />
          <input
            value={groupAggs}
            onChange={(e) => setGroupAggs(e.target.value)}
            disabled={disabled}
            placeholder="aggregates: sum(amount) as total"
            className="mb-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100 outline-none focus:ring-2 focus:ring-teal-700 disabled:opacity-40"
          />
        </>
      )}

      {kind === "SortBy" && (
        <div className="mb-1 flex gap-1">
          <input
            list={colDatalistId}
            value={sortCol}
            onChange={(e) => setSortCol(e.target.value)}
            disabled={disabled}
            placeholder="column"
            className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100 outline-none focus:ring-2 focus:ring-teal-700 disabled:opacity-40"
          />
          <label className="flex shrink-0 items-center gap-1 rounded-lg border border-slate-700 px-2 text-[11px] text-slate-300">
            <input
              type="checkbox"
              checked={sortDesc}
              onChange={(e) => setSortDesc(e.target.checked)}
              disabled={disabled}
            />
            desc
          </label>
        </div>
      )}

      {kind === "CustomSql" && (
        <textarea
          value={customSql}
          onChange={(e) => setCustomSql(e.target.value)}
          disabled={disabled}
          rows={3}
          spellCheck={false}
          className="mb-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-[11px] text-slate-100 outline-none focus:ring-2 focus:ring-teal-700 disabled:opacity-40"
        />
      )}

      <button
        type="button"
        onClick={apply}
        disabled={disabled}
        className="w-full rounded-lg bg-teal-500/15 px-3 py-1.5 text-xs font-semibold text-teal-200 hover:bg-teal-500/25 disabled:opacity-40"
      >
        Add {KINDS.find((k) => k.id === kind)?.label ?? "step"}
      </button>
      {kind === "CustomSql" && (
        <p className="mt-1 text-[10px] text-slate-600">
          Use {"{{prev_step}}"} for the previous CTE.
        </p>
      )}
    </div>
  );
}
