import type { TransformationStep } from "../types/pipeline";

interface HistoryProps {
  steps: TransformationStep[];
  onRemoveAt: (index: number) => void;
}

function stepLabel(step: TransformationStep, index: number): string {
  switch (step.type) {
    case "LoadCsv":
      return `LoadCsv · ${step.payload.path.split(/[/\\]/).pop() ?? step.payload.path}`;
    case "LoadParquet":
      return `LoadParquet · ${step.payload.path.split(/[/\\]/).pop() ?? step.payload.path}`;
    case "LoadPostgres":
      return `LoadPostgres · ${step.payload.table_name}`;
    case "Filter":
      return `Filter · ${step.payload.condition || "(пусто)"}`;
    case "SelectColumns":
      return `Select · ${step.payload.columns.join(", ")}`;
    case "RenameColumn":
      return `Rename · ${step.payload.from} → ${step.payload.to}`;
    case "DeriveColumn":
      return `Derive · ${step.payload.name}`;
    case "GroupBy":
      return `GroupBy · ${step.payload.dimensions.join(", ")}`;
    case "SortBy":
      return `Sort · ${step.payload.column}`;
    case "Join":
      return `Join ${step.payload.join_type} · ${step.payload.right_query_id} ON ${step.payload.left_on.join(",")}`;
    case "Append":
      return `Append · ${step.payload.other_query_ids.join(", ")}`;
    case "CustomSql":
      return "CustomSql";
    default:
      return `Step ${index}`;
  }
}

export function History({ steps, onRemoveAt }: HistoryProps) {
  return (
    <div className="flex h-full flex-col">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
        История изменений
      </h2>
      {steps.length === 0 ? (
        <p className="text-sm text-slate-500">Нет шагов в этой query.</p>
      ) : (
        <ol className="flex flex-1 flex-col gap-2 overflow-auto">
          {steps.map((step, index) => (
            <li
              key={`${step.type}-${index}`}
              className="rounded-md border border-slate-800 bg-slate-900/70 px-3 py-2"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-teal-500/80">
                    s{index}
                  </div>
                  <div className="mt-0.5 text-sm text-slate-200">
                    {stepLabel(step, index)}
                  </div>
                </div>
                {step.type !== "LoadCsv" &&
                  step.type !== "LoadParquet" &&
                  step.type !== "LoadPostgres" && (
                    <button
                      type="button"
                      onClick={() => onRemoveAt(index)}
                      className="text-xs text-slate-500 hover:text-rose-400"
                    >
                      убрать
                    </button>
                  )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
