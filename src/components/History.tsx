import type { TransformationStep } from "../types/pipeline";

interface HistoryProps {
  steps: TransformationStep[];
  /** query id → display name (for Join/Append/FromQuery) */
  queryNames?: Record<string, string>;
  selectedIndex: number | null;
  onSelect: (index: number) => void;
  onRemoveAt: (index: number) => void;
  onMove: (index: number, dir: -1 | 1) => void;
}

function isRootStep(step: TransformationStep): boolean {
  return (
    step.type === "LoadCsv" ||
    step.type === "LoadParquet" ||
    step.type === "LoadPostgres" ||
    step.type === "FromQuery" ||
    step.type === "SqlModel"
  );
}

/** One-line key props — meaning, not a SQL dump. */
export function stepSummaryLine(
  step: TransformationStep,
  queryNames: Record<string, string>,
): { kind: string; detail: string } {
  const qname = (id: string) => queryNames[id] ?? id.slice(0, 10);
  switch (step.type) {
    case "LoadCsv":
      return {
        kind: "CSV",
        detail: step.payload.path.split(/[/\\]/).pop() ?? step.payload.path,
      };
    case "LoadParquet":
      return {
        kind: "Parquet",
        detail: step.payload.path.split(/[/\\]/).pop() ?? step.payload.path,
      };
    case "LoadPostgres":
      return {
        kind: "Postgres",
        detail: `${step.payload.schema || "public"}.${step.payload.table_name}`,
      };
    case "FromQuery":
      return { kind: "From", detail: qname(step.payload.query_id) };
    case "SqlModel":
      return {
        kind: "SQL model",
        detail:
          step.payload.raw_sql.trim().split(/\s+/).slice(0, 6).join(" ") ||
          "…",
      };
    case "Filter":
      return {
        kind: "Filter",
        detail: step.payload.condition.trim() || "…",
      };
    case "SelectColumns":
      return {
        kind: "Columns",
        detail:
          step.payload.columns.length <= 3
            ? step.payload.columns.join(", ")
            : `${step.payload.columns.length} cols`,
      };
    case "RenameColumn":
      return {
        kind: "Rename",
        detail: `${step.payload.from} → ${step.payload.to}`,
      };
    case "DeriveColumn":
      return { kind: "Derived/Calc", detail: step.payload.name };
    case "GroupBy":
      return {
        kind: "GroupBy",
        detail: `${step.payload.dimensions.join(", ")} · ${step.payload.aggregates.length} agg`,
      };
    case "SortBy":
      return {
        kind: "Sort",
        detail: `${step.payload.column} ${step.payload.descending ? "↓" : "↑"}`,
      };
    case "Limit":
      return { kind: "Limit", detail: String(step.payload.n) };
    case "Join":
      return {
        kind: `Join ${step.payload.join_type}`,
        detail: (() => {
          const l = step.payload.left_on.join(",");
          const r = step.payload.right_on.join(",");
          const keys = l === r ? l : `${l}=${r}`;
          return `${qname(step.payload.right_query_id)} on ${keys}`;
        })(),
      };
    case "Append":
      return {
        kind: "Append",
        detail: step.payload.other_query_ids.map(qname).join(", "),
      };
    case "CustomSql":
      return { kind: "Custom SQL", detail: "snippet" };
    default:
      return { kind: "Step", detail: "" };
  }
}

export function History({
  steps,
  queryNames = {},
  selectedIndex,
  onSelect,
  onRemoveAt,
  onMove,
}: HistoryProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <h3 className="mb-2 shrink-0 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
        Applied steps
      </h3>
      {steps.length === 0 ? (
        <p className="text-sm text-slate-600">No steps — add below.</p>
      ) : (
        <ol className="min-h-0 flex-1 space-y-0.5 overflow-auto">
          {steps.map((step, index) => {
            const { kind, detail } = stepSummaryLine(step, queryNames);
            const selected = selectedIndex === index;
            const root = isRootStep(step);
            // Keep Load*/FromQuery pinned at s0.
            const moveUpOk =
              index > 0 && !(index === 1 && isRootStep(steps[0]!));
            const moveDownOk =
              index < steps.length - 1 && !(index === 0 && root);

            return (
              <li key={`${step.type}-${index}`}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelect(index)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelect(index);
                    }
                  }}
                  className={`flex w-full cursor-pointer items-center gap-1 rounded-md border px-1.5 py-1 text-left transition ${
                    selected
                      ? "border-teal-500/50 bg-teal-500/10"
                      : "border-transparent hover:border-[var(--line)] hover:bg-slate-900/80"
                  }`}
                >
                  <span className="w-5 shrink-0 font-mono text-[10px] text-slate-600">
                    s{index}
                  </span>
                  <span className="w-[5.5rem] shrink-0 truncate text-[10px] font-semibold uppercase tracking-wide text-teal-500/90">
                    {kind}
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-300"
                    title={detail}
                  >
                    {detail}
                  </span>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <button
                      type="button"
                      title="Move up"
                      disabled={!moveUpOk}
                      className="rounded px-1 text-[10px] text-slate-500 hover:bg-slate-800 hover:text-teal-300 disabled:opacity-20"
                      onClick={(e) => {
                        e.stopPropagation();
                        onMove(index, -1);
                      }}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      title="Move down"
                      disabled={!moveDownOk}
                      className="rounded px-1 text-[10px] text-slate-500 hover:bg-slate-800 hover:text-teal-300 disabled:opacity-20"
                      onClick={(e) => {
                        e.stopPropagation();
                        onMove(index, 1);
                      }}
                    >
                      ↓
                    </button>
                    {!root && (
                      <button
                        type="button"
                        title="Remove"
                        className="rounded px-1 text-[10px] text-slate-600 hover:text-rose-400"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemoveAt(index);
                        }}
                      >
                        ×
                      </button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
