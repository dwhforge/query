import type { TransformationStep } from "../types/pipeline";

interface HistoryProps {
  steps: TransformationStep[];
  /** query id → display name (for Join/Append labels) */
  queryNames?: Record<string, string>;
  onRemoveAt: (index: number) => void;
}

function stepLabel(
  step: TransformationStep,
  index: number,
  queryNames: Record<string, string>,
): string {
  const qname = (id: string) => queryNames[id] ?? id;
  switch (step.type) {
    case "LoadCsv":
      return `LoadCsv · ${step.payload.path.split(/[/\\]/).pop() ?? step.payload.path}`;
    case "LoadParquet":
      return `LoadParquet · ${step.payload.path.split(/[/\\]/).pop() ?? step.payload.path}`;
    case "LoadPostgres":
      return `LoadPostgres · ${step.payload.schema || "public"}.${step.payload.table_name}`;
    case "Filter":
      return `Filter · ${step.payload.condition || "(empty)"}`;
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
    case "Limit":
      return `Limit · ${step.payload.n}`;
    case "Join":
      return `Join ${step.payload.join_type} · ${qname(step.payload.right_query_id)} ON ${step.payload.left_on.join(",")}`;
    case "Append":
      return `Append · ${step.payload.other_query_ids.map(qname).join(", ")}`;
    case "CustomSql":
      return "CustomSql";
    default:
      return `Step ${index}`;
  }
}

export function History({ steps, queryNames = {}, onRemoveAt }: HistoryProps) {
  return (
    <div>
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
        Applied steps
      </h3>
      {steps.length === 0 ? (
        <p className="text-sm text-slate-600">No steps in this query.</p>
      ) : (
        <ol className="flex flex-col gap-1.5">
          {steps.map((step, index) => (
            <li
              key={`${step.type}-${index}`}
              className="rounded-lg border border-[var(--line)] bg-slate-950/50 px-2.5 py-2"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-[9px] uppercase tracking-wide text-teal-500/70">
                    s{index}
                  </div>
                  <div className="mt-0.5 text-sm text-slate-200">
                    {stepLabel(step, index, queryNames)}
                  </div>
                </div>
                {step.type !== "LoadCsv" &&
                  step.type !== "LoadParquet" &&
                  step.type !== "LoadPostgres" && (
                    <button
                      type="button"
                      onClick={() => onRemoveAt(index)}
                      className="text-[11px] text-slate-600 hover:text-rose-400"
                    >
                      remove
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
