interface EmptyHeroProps {
  onLoadSample: () => void;
  onAddCsv: () => void;
  onAddParquet: () => void;
  onAddPostgres: () => void;
}

export function EmptyHero({
  onLoadSample,
  onAddCsv,
  onAddParquet,
  onAddPostgres,
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
      <div className="anim-rise-delay-2 mt-8 flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={onLoadSample}
          className="rounded-lg bg-teal-500 px-5 py-2.5 text-sm font-semibold text-slate-950 shadow-[0_0_32px_rgba(45,212,191,0.35)] transition hover:bg-teal-400"
        >
          Load sample join
        </button>
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
      </div>
      <p className="mt-6 text-[11px] text-slate-600">
        Shortcuts: <kbd className="text-slate-500">O</kbd> CSV ·{" "}
        <kbd className="text-slate-500">S</kbd> sample ·{" "}
        <kbd className="text-slate-500">E</kbd> export ·{" "}
        <kbd className="text-slate-500">/</kbd> Data↔Model
      </p>
    </div>
  );
}
