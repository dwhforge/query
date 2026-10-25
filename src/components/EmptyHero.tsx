export type DemoId = "sales" | "union" | "sql";

interface EmptyHeroProps {
  onLoadDemo: (id: DemoId) => void;
  onAddCsv: () => void;
  onAddParquet: () => void;
  onAddPostgres: () => void;
  onAddSqlModel: () => void;
}

const DEMOS: { id: DemoId; label: string; hint: string }[] = [
  { id: "sales", label: "Sales", hint: "medallion · join · top-N" },
  { id: "union", label: "Union", hint: "Append multi-feed" },
  { id: "sql", label: "SQL hybrid", hint: "SqlModel · window" },
];

export function EmptyHero({
  onLoadDemo,
  onAddCsv,
  onAddParquet,
  onAddPostgres,
  onAddSqlModel,
}: EmptyHeroProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <p className="anim-rise text-[11px] font-semibold uppercase tracking-[0.28em] text-teal-500/80">
        Visual pipeline workspace
      </p>
      <h2 className="anim-rise-delay-1 mt-3 max-w-xl text-4xl font-semibold tracking-tight text-slate-50 sm:text-5xl">
        DWH-RS-QUERY
      </h2>
      <p className="anim-rise-delay-2 mt-4 max-w-md text-base leading-relaxed text-slate-400">
        Drop sources on the canvas, join in a few clicks, preview instantly, export
        real dbt. Built to feel faster than Power Query.
      </p>
      <div className="anim-rise-delay-2 mt-8 w-full max-w-lg">
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
          Load demo
        </p>
        <div className="flex flex-wrap items-stretch justify-center gap-2">
          {DEMOS.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => onLoadDemo(d.id)}
              className="min-w-[8.5rem] rounded-lg bg-teal-500 px-4 py-2.5 text-left shadow-[0_0_32px_rgba(45,212,191,0.25)] transition hover:bg-teal-400"
            >
              <div className="text-sm font-semibold text-slate-950">{d.label}</div>
              <div className="text-[10px] font-medium text-slate-800/80">
                {d.hint}
              </div>
            </button>
          ))}
        </div>
      </div>
      <div className="anim-rise-delay-2 mt-6 flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={onAddCsv}
          className="rounded-lg border border-slate-600 px-4 py-2.5 text-sm text-slate-200 hover:border-teal-600"
        >
          Open CSV
        </button>
        <button
          type="button"
          onClick={onAddParquet}
          className="rounded-lg border border-slate-600 px-4 py-2.5 text-sm text-slate-200 hover:border-teal-600"
        >
          Open Parquet
        </button>
        <button
          type="button"
          onClick={onAddPostgres}
          className="rounded-lg border border-slate-700 px-4 py-2.5 text-sm text-slate-400 hover:border-slate-500"
        >
          Connect Postgres
        </button>
        <button
          type="button"
          onClick={onAddSqlModel}
          className="rounded-lg border border-slate-700 px-4 py-2.5 text-sm text-slate-400 hover:border-slate-500"
        >
          SQL model
        </button>
      </div>
      <p className="mt-6 text-[11px] text-slate-600">
        Shortcuts: <kbd className="text-slate-500">O</kbd> CSV ·{" "}
        <kbd className="text-slate-500">S</kbd> demo sales ·{" "}
        <kbd className="text-slate-500">E</kbd> export ·{" "}
        <kbd className="text-slate-500">/</kbd> Data↔Model
      </p>
    </div>
  );
}
