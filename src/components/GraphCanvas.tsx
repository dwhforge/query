import { useMemo } from "react";
import type { QueryDef } from "../types/pipeline";

export interface GraphEdge {
  from: string;
  to: string;
  label: string;
}

interface GraphCanvasProps {
  queries: QueryDef[];
  activeQueryId: string | null;
  focusQueryId: string | null;
  onSelect: (id: string) => void;
  onSetFocus: (id: string) => void;
}

function sourceKind(q: QueryDef): string {
  const s = q.steps[0];
  if (!s) return "empty";
  if (s.type === "LoadCsv") return "CSV";
  if (s.type === "LoadParquet") return "Parquet";
  if (s.type === "LoadPostgres") return "Postgres";
  if (s.type === "Join") return "Join";
  return s.type;
}

export function GraphCanvas({
  queries,
  activeQueryId,
  focusQueryId,
  onSelect,
  onSetFocus,
}: GraphCanvasProps) {
  const { positions, edges, width, height } = useMemo(() => {
    const w = Math.max(720, queries.length * 220);
    const h = 280;
    const positions = new Map<string, { x: number; y: number }>();
    queries.forEach((q, i) => {
      const col = i % 3;
      const row = Math.floor(i / 3);
      positions.set(q.id, {
        x: 120 + col * 220,
        y: 70 + row * 120,
      });
    });

    const edges: GraphEdge[] = [];
    for (const q of queries) {
      for (const step of q.steps) {
        if (step.type === "Join") {
          edges.push({
            from: step.payload.right_query_id,
            to: q.id,
            label: `${step.payload.join_type} · ${step.payload.left_on.join(",")}`,
          });
        }
        if (step.type === "Append") {
          for (const other of step.payload.other_query_ids) {
            edges.push({ from: other, to: q.id, label: "append" });
          }
        }
      }
    }

    return { positions, edges, width: w, height: h };
  }, [queries]);

  if (queries.length === 0) return null;

  return (
    <div className="relative h-full min-h-[260px] overflow-auto rounded-xl border border-[var(--line)] bg-[radial-gradient(ellipse_at_20%_0%,var(--glow),transparent_50%),linear-gradient(180deg,#0a1520,var(--bg0))]">
      <svg width={width} height={height} className="block">
        <defs>
          <marker
            id="arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#2dd4bf" />
          </marker>
        </defs>
        {edges.map((e, i) => {
          const a = positions.get(e.from);
          const b = positions.get(e.to);
          if (!a || !b) return null;
          const midX = (a.x + b.x) / 2;
          const midY = (a.y + b.y) / 2 - 18;
          return (
            <g key={`${e.from}-${e.to}-${i}`}>
              <path
                d={`M ${a.x} ${a.y} C ${midX} ${a.y}, ${midX} ${b.y}, ${b.x} ${b.y}`}
                fill="none"
                stroke="#2dd4bf"
                strokeWidth="2"
                markerEnd="url(#arrow)"
                className="edge-pulse"
              />
              <text
                x={midX}
                y={midY}
                textAnchor="middle"
                className="fill-teal-300/80 text-[10px]"
                style={{ fontSize: 10 }}
              >
                {e.label}
              </text>
            </g>
          );
        })}
      </svg>

      {queries.map((q, idx) => {
        const p = positions.get(q.id)!;
        const active = q.id === activeQueryId;
        const focus = q.id === focusQueryId;
        return (
          <button
            key={q.id}
            type="button"
            onClick={() => onSelect(q.id)}
            onDoubleClick={() => onSetFocus(q.id)}
            className={`anim-rise absolute w-[168px] -translate-x-1/2 -translate-y-1/2 rounded-xl border px-3 py-2.5 text-left backdrop-blur transition duration-200 ${
              active
                ? "border-teal-400/70 bg-slate-900/95 shadow-[0_0_0_1px_rgba(45,212,191,0.35),0_12px_40px_rgba(0,0,0,0.45)]"
                : "border-[var(--line)] bg-[var(--node)] hover:border-teal-700/60"
            }`}
            style={{
              left: p.x,
              top: p.y,
              animationDelay: `${idx * 0.05}s`,
            }}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-teal-400/90">
                {sourceKind(q)}
              </span>
              {focus && (
                <span className="rounded bg-teal-500/15 px-1.5 py-0.5 text-[9px] text-teal-300">
                  FOCUS
                </span>
              )}
            </div>
            <div className="mt-1 truncate text-sm font-semibold text-slate-100">
              {q.name}
            </div>
            <div className="mt-0.5 text-[11px] text-slate-500">
              {q.steps.length} step{q.steps.length === 1 ? "" : "s"}
            </div>
          </button>
        );
      })}
    </div>
  );
}
