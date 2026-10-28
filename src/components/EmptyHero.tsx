import { useMemo, useState } from "react";
import type { KeyMapDef } from "../types/pipeline";
import { emptyKeyMap } from "../lib/keyMap";
import { KeyMapEditor } from "./KeyMapEditor";

export type DemoId = "sales" | "union" | "sql" | "right" | "keymap";

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
  {
    id: "right",
    label: "Right joins",
    hint: "two RIGHT OUTER · coverage",
  },
  {
    id: "keymap",
    label: "Key mapping",
    hint: "From→To · seed table",
  },
];

/** Virtual project sample — unmatched dirty keys vs dim partners (Hero only). */
const HERO_UNMATCHED = ["www", "shop", "prt", "Web "];
const HERO_PARTNERS = ["web", "store", "partner"];
const HERO_QUERIES = [
  { id: "alias_sales", role: "fact", note: "dirty channel codes" },
  { id: "dim_channel", role: "dim", note: "canonical keys" },
  { id: "enriched", role: "join", note: "LEFT join · map before join" },
];

function initialHeroMap(): KeyMapDef {
  const map = emptyKeyMap("channel aliases");
  map.id = "map_channel_alias";
  map.entries = [
    { from: "www", to: "web" },
    { from: "shop", to: "store" },
  ];
  return map;
}

export function EmptyHero({
  onLoadDemo,
  onAddCsv,
  onAddParquet,
  onAddPostgres,
  onAddSqlModel,
}: EmptyHeroProps) {
  const [heroMap, setHeroMap] = useState<KeyMapDef>(initialHeroMap);
  const unmatchedLeft = useMemo(() => {
    const mapped = new Set(
      heroMap.entries.filter((e) => e.to.trim()).map((e) => e.from.trim()),
    );
    return HERO_UNMATCHED.filter((k) => !mapped.has(k.trim()));
  }, [heroMap.entries]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto">
      <div className="flex flex-1 flex-col items-center justify-center px-6 pb-4 pt-10 text-center lg:flex-row lg:items-stretch lg:justify-center lg:gap-10 lg:px-10 lg:text-left">
        <div className="flex max-w-lg flex-col justify-center lg:shrink-0">
          <p className="anim-rise text-[11px] font-semibold uppercase tracking-[0.28em] text-teal-500/80">
            Visual pipeline workspace
          </p>
          <h2 className="anim-rise-delay-1 mt-3 text-4xl font-semibold tracking-tight text-slate-50 sm:text-5xl">
            DWHForge Query
          </h2>
          <p className="anim-rise-delay-2 mt-4 max-w-md text-base leading-relaxed text-slate-400 lg:mx-0 mx-auto">
            Join keys that almost match — map them in a From→To table, ship as a
            dbt seed. Same idea as Power Query / Alteryx, without fuzzy merge.
          </p>
          <div className="anim-rise-delay-2 mt-8 w-full">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
              Load demo
            </p>
            <div className="flex flex-wrap items-stretch justify-center gap-2 lg:justify-start">
              {DEMOS.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => onLoadDemo(d.id)}
                  className={`min-w-[8.5rem] rounded-lg px-4 py-2.5 text-left transition ${
                    d.id === "keymap"
                      ? "bg-teal-400 shadow-[0_0_32px_rgba(45,212,191,0.35)] hover:bg-teal-300"
                      : "bg-teal-500 shadow-[0_0_32px_rgba(45,212,191,0.25)] hover:bg-teal-400"
                  }`}
                >
                  <div className="text-sm font-semibold text-slate-950">
                    {d.label}
                  </div>
                  <div className="text-[10px] font-medium text-slate-800/80">
                    {d.hint}
                  </div>
                </button>
              ))}
            </div>
          </div>
          <div className="anim-rise-delay-2 mt-6 flex flex-wrap items-center justify-center gap-3 lg:justify-start">
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
        </div>

        {/* Interactive virtual project — KeyMap playground */}
        <div className="anim-rise-delay-2 mt-10 w-full max-w-md lg:mt-0 lg:w-[26rem] lg:shrink-0">
          <div className="mb-2 flex items-end justify-between gap-2 px-0.5">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-teal-500/80">
                Try it — virtual project
              </p>
              <p className="mt-0.5 text-[11px] text-slate-500">
                alias_sales ⋈ dim_channel · edit map, then open full demo
              </p>
            </div>
            <button
              type="button"
              onClick={() => onLoadDemo("keymap")}
              className="shrink-0 rounded border border-teal-700/60 px-2 py-1 text-[10px] font-semibold text-teal-300 hover:bg-teal-500/10"
            >
              Open on canvas →
            </button>
          </div>

          <div className="mb-2 flex flex-wrap gap-1.5">
            {HERO_QUERIES.map((q) => (
              <span
                key={q.id}
                className="rounded border border-slate-800 bg-slate-950/80 px-2 py-1 font-mono text-[10px] text-slate-400"
                title={q.note}
              >
                <span className="text-slate-600">{q.role}</span> {q.id}
              </span>
            ))}
          </div>

          {unmatchedLeft.length > 0 && (
            <p className="mb-1.5 text-left text-[10px] text-amber-200/80">
              Still unmatched:{" "}
              <span className="font-mono">
                {unmatchedLeft.map((k) => JSON.stringify(k)).join(", ")}
              </span>
            </p>
          )}
          {unmatchedLeft.length === 0 && (
            <p className="mb-1.5 text-left text-[10px] text-teal-300/80">
              All sample dirty keys mapped — open the demo to Apply on the join.
            </p>
          )}

          <KeyMapEditor
            map={heroMap}
            onChange={setHeroMap}
            pickToOptions={HERO_PARTNERS}
            suggestedFrom={HERO_UNMATCHED}
            compact
            title="Channel aliases"
          />
        </div>
      </div>

      <p className="shrink-0 pb-6 text-center text-[11px] text-slate-600">
        <span className="text-slate-500">Help → User guide</span>
        {" · "}
        <span className="text-slate-500">Help → Load demo</span>
        {" · "}
        Shortcuts: <kbd className="text-slate-500">⌘O</kbd> open ·{" "}
        <kbd className="text-slate-500">E</kbd> export ·{" "}
        <kbd className="text-slate-500">/</kbd> Data↔Model
      </p>
    </div>
  );
}
