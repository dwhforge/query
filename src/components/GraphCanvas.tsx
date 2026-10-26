import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getBezierPath,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { formatJoinKeyLabel } from "../lib/joinKeys";
import type { QueryDef, TransformationStep } from "../types/pipeline";

export type CanvasPositions = Record<string, { x: number; y: number }>;

export type GraphEdgeKind = "join" | "append" | "from";

export type GraphEdgeInfo = {
  kind: GraphEdgeKind;
  hostQueryId: string;
  otherQueryId: string;
};

type StepChip = { index: number; label: string };

export type QueryNodeData = {
  label: string;
  sourceKind: string;
  stepCount: number;
  stepSummary: string;
  steps: StepChip[];
  expanded: boolean;
  isFocus: boolean;
  isActive: boolean;
};

type QueryNodeType = Node<QueryNodeData, "query">;

type EdgeData = GraphEdgeInfo & {
  labelText?: string;
  labelKind?: GraphEdgeKind;
} & Record<string, unknown>;

/** HTML edge labels stay sharp under zoom; default SVG labels look blurry. */
const LabeledEdge = memo(function LabeledEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  data,
  label,
}: EdgeProps<Edge<EdgeData>>) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const text =
    (typeof data?.labelText === "string" && data.labelText) ||
    (typeof label === "string" ? label : "") ||
    "";
  const kind = data?.labelKind ?? data?.kind ?? "join";
  const tone =
    kind === "join"
      ? "border-teal-500/40 bg-slate-950 text-teal-200"
      : kind === "append"
        ? "border-slate-600 bg-slate-950 text-slate-300"
        : "border-violet-500/40 bg-slate-950 text-violet-200";

  return (
    <>
      <BaseEdge id={id} path={edgePath} style={style} markerEnd={markerEnd} />
      {text ? (
        <EdgeLabelRenderer>
          <div
            className={`nodrag nopan pointer-events-none absolute z-[1] max-w-[220px] rounded-md border px-2 py-0.5 text-center font-mono text-[11px] font-semibold leading-tight tracking-tight shadow-md ${tone}`}
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
            title={text}
          >
            {text}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
});

const edgeTypes = { labeled: LabeledEdge };

type CanvasActions = {
  toggleExpand: (queryId: string) => void;
  deriveQuery: (queryId: string) => void;
};

const CanvasActionsCtx = createContext<CanvasActions>({
  toggleExpand: () => {},
  deriveQuery: () => {},
});

interface GraphCanvasProps {
  queries: QueryDef[];
  activeQueryId: string | null;
  focusQueryId: string | null;
  positions?: CanvasPositions;
  onPositionsChange?: (positions: CanvasPositions) => void;
  onSelect: (id: string) => void;
  onSetFocus: (id: string) => void;
  onConnectJoin?: (
    rightQueryId: string,
    leftQueryId: string,
  ) => void | Promise<void>;
  onSelectEdge?: (edge: GraphEdgeInfo) => void;
  onRemoveEdge?: (edge: GraphEdgeInfo) => void;
  onRemoveQuery?: (queryId: string) => void;
  /** New query whose first step is FromQuery(this node). */
  onDeriveQuery?: (fromQueryId: string) => void;
}

function sourceKind(q: QueryDef): string {
  const s = q.steps[0];
  if (!s) return "empty";
  if (s.type === "LoadCsv") return "CSV";
  if (s.type === "LoadParquet") return "Parquet";
  if (s.type === "LoadPostgres") return "Postgres";
  if (s.type === "FromQuery") return "REF";
  if (s.type === "SqlModel") return "SQL";
  return s.type;
}

function shortStepLabel(step: TransformationStep, index: number): string {
  switch (step.type) {
    case "LoadCsv":
      return `s${index} LoadCsv`;
    case "LoadParquet":
      return `s${index} LoadParquet`;
    case "LoadPostgres":
      return `s${index} LoadPostgres`;
    case "FromQuery":
      return `s${index} FromQuery`;
    case "SqlModel":
      return `s${index} SQL model`;
    case "Filter":
      return `s${index} Filter`;
    case "SelectColumns":
      return `s${index} Select`;
    case "Join": {
      const keys = formatJoinKeyLabel(
        step.payload.left_on,
        step.payload.right_on,
      );
      return keys && keys !== "?"
        ? `s${index} Join ${keys}`
        : `s${index} Join ${step.payload.join_type}`;
    }
    case "Append":
      return `s${index} Append`;
    case "RenameColumn":
      return `s${index} Rename`;
    case "DeriveColumn":
      return `s${index} Derived/Calc`;
    case "GroupBy":
      return `s${index} GroupBy`;
    case "SortBy":
      return `s${index} Sort`;
    case "Limit":
      return `s${index} Limit ${step.payload.n}`;
    case "CustomSql":
      return `s${index} Custom SQL`;
    default:
      return `s${index}`;
  }
}

function stepSummary(q: QueryDef): string {
  const transforms = q.steps
    .slice(1)
    .map((s) => {
      switch (s.type) {
        case "Filter":
          return "Filter";
        case "SelectColumns":
          return "Select";
        case "Join":
          return "Join";
        case "Append":
          return "Append";
        case "RenameColumn":
          return "Rename";
        case "DeriveColumn":
          return "Derived/Calc";
        case "GroupBy":
          return "Group";
        case "SortBy":
          return "Sort";
        case "Limit":
          return "Limit";
        case "CustomSql":
          return "Custom SQL";
        default:
          return s.type;
      }
    })
    .slice(0, 4);
  if (transforms.length === 0) return "source only";
  const more = q.steps.length - 1 > transforms.length ? "…" : "";
  return transforms.join(" · ") + more;
}

function queryDepths(queries: QueryDef[]): Map<string, number> {
  const byId = new Map(queries.map((q) => [q.id, q]));
  const memo = new Map<string, number>();

  function depth(id: string, stack: Set<string>): number {
    if (memo.has(id)) return memo.get(id)!;
    if (stack.has(id)) return 0;
    stack.add(id);
    const q = byId.get(id);
    let d = 0;
    if (q) {
      for (const step of q.steps) {
        if (step.type === "Join") {
          d = Math.max(d, depth(step.payload.right_query_id, stack) + 1);
        }
        if (step.type === "Append") {
          for (const other of step.payload.other_query_ids) {
            d = Math.max(d, depth(other, stack) + 1);
          }
        }
      }
    }
    stack.delete(id);
    memo.set(id, d);
    return d;
  }

  for (const q of queries) depth(q.id, new Set());
  return memo;
}

function buildGraph(
  queries: QueryDef[],
  focusQueryId: string | null,
  activeQueryId: string | null,
  prevPositions: Map<string, { x: number; y: number }>,
  expandedIds: Set<string>,
  selectedEdgeId: string | null,
): { nodes: QueryNodeType[]; edges: Edge[] } {
  const depths = queryDepths(queries);
  const rankBuckets = new Map<number, string[]>();
  for (const q of queries) {
    const d = depths.get(q.id) ?? 0;
    const bucket = rankBuckets.get(d) ?? [];
    bucket.push(q.id);
    rankBuckets.set(d, bucket);
  }

  const nodes: QueryNodeType[] = queries.map((q) => {
    const d = depths.get(q.id) ?? 0;
    const bucket = rankBuckets.get(d) ?? [];
    const row = bucket.indexOf(q.id);
    const saved = prevPositions.get(q.id);
    const expanded = expandedIds.has(q.id);
    return {
      id: q.id,
      type: "query",
      position: saved ?? { x: 48 + d * 260, y: 48 + row * (expanded ? 200 : 130) },
      data: {
        label: q.name,
        sourceKind: sourceKind(q),
        stepCount: q.steps.length,
        stepSummary: stepSummary(q),
        steps: q.steps.map((s, i) => ({
          index: i,
          label: shortStepLabel(s, i),
        })),
        expanded,
        isFocus: q.id === focusQueryId,
        isActive: q.id === activeQueryId,
      },
      // Do not drive RF `selected` from app state — it feedback-loops with
      // onSelectionChange and can blank the whole React tree.
    };
  });

  const edges: Edge[] = [];
  for (const q of queries) {
    for (const step of q.steps) {
      if (step.type === "Join") {
        const right = step.payload.right_query_id;
        const id = `join:${right}->${q.id}`;
        const selected = selectedEdgeId === id;
        const keys = formatJoinKeyLabel(
          step.payload.left_on,
          step.payload.right_on,
        );
        const labelText = `${step.payload.join_type} · ${keys}`;
        edges.push({
          id,
          type: "labeled",
          source: right,
          target: q.id,
          label: labelText,
          data: {
            kind: "join",
            labelKind: "join",
            labelText,
            hostQueryId: q.id,
            otherQueryId: right,
          } satisfies EdgeData,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: selected ? "#5eead4" : "#2dd4bf",
          },
          style: {
            stroke: selected ? "#5eead4" : "#2dd4bf",
            strokeWidth: selected ? 3 : 2,
          },
          animated: selected || q.id === focusQueryId || right === focusQueryId,
        });
      }
      if (step.type === "Append") {
        for (const other of step.payload.other_query_ids) {
          const id = `append:${other}->${q.id}`;
          const selected = selectedEdgeId === id;
          edges.push({
            id,
            type: "labeled",
            source: other,
            target: q.id,
            label: "append",
            data: {
              kind: "append",
              labelKind: "append",
              labelText: "append",
              hostQueryId: q.id,
              otherQueryId: other,
            } satisfies EdgeData,
            markerEnd: {
              type: MarkerType.ArrowClosed,
              color: selected ? "#cbd5e1" : "#94a3b8",
            },
            style: {
              stroke: selected ? "#cbd5e1" : "#64748b",
              strokeWidth: selected ? 2.5 : 1.5,
              strokeDasharray: "4 3",
            },
          });
        }
      }
      if (step.type === "FromQuery") {
        const src = step.payload.query_id;
        const id = `from:${src}->${q.id}`;
        const selected = selectedEdgeId === id;
        edges.push({
          id,
          type: "labeled",
          source: src,
          target: q.id,
          label: "from",
          data: {
            kind: "from",
            labelKind: "from",
            labelText: "from",
            hostQueryId: q.id,
            otherQueryId: src,
          } satisfies EdgeData,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: selected ? "#a78bfa" : "#8b5cf6",
          },
          style: {
            stroke: selected ? "#a78bfa" : "#7c3aed",
            strokeWidth: selected ? 2.5 : 1.75,
            strokeDasharray: "2 4",
          },
          animated: selected || q.id === focusQueryId || src === focusQueryId,
        });
      }
    }
  }

  return { nodes, edges };
}

const QueryNode = memo(function QueryNode({
  id,
  data,
}: NodeProps<QueryNodeType>) {
  const { toggleExpand, deriveQuery } = useContext(CanvasActionsCtx);
  return (
    <div
      className={`min-w-[180px] max-w-[240px] rounded-xl border px-3 py-2.5 shadow-lg backdrop-blur transition ${
        data.isActive
          ? "border-teal-400/70 bg-slate-900/95 shadow-[0_0_0_1px_rgba(45,212,191,0.35),0_12px_40px_rgba(0,0,0,0.45)]"
          : "border-[var(--line)] bg-[var(--node)]"
      }`}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!h-2.5 !w-2.5 !border-teal-800 !bg-teal-500"
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-teal-400/90">
          {data.sourceKind}
        </span>
        <div className="flex items-center gap-1">
          {data.isFocus && (
            <span className="rounded bg-teal-500/15 px-1.5 py-0.5 text-[9px] text-teal-300">
              FOCUS
            </span>
          )}
          <button
            type="button"
            title="Branch: new query = FromQuery / dbt ref(this)"
            className="nodrag nopan rounded px-1 text-[10px] text-slate-500 hover:bg-slate-800 hover:text-violet-300"
            onClick={(e) => {
              e.stopPropagation();
              deriveQuery(id);
            }}
          >
            ref↳
          </button>
          <button
            type="button"
            title={data.expanded ? "Collapse steps" : "Expand steps"}
            className="nodrag nopan rounded px-1 text-[10px] text-slate-500 hover:bg-slate-800 hover:text-teal-300"
            onClick={(e) => {
              e.stopPropagation();
              toggleExpand(id);
            }}
          >
            {data.expanded ? "▾" : "▸"} {data.stepCount}
          </button>
        </div>
      </div>
      <div className="mt-1 truncate text-sm font-semibold text-slate-100">
        {data.label}
      </div>
      {!data.expanded && (
        <div className="mt-1 truncate text-[10px] text-slate-600">
          {data.stepSummary}
        </div>
      )}
      {data.expanded && (
        <ol className="mt-2 max-h-40 space-y-0.5 overflow-auto border-t border-slate-800 pt-1.5">
          {data.steps.map((s) => (
            <li
              key={s.index}
              className="truncate font-mono text-[10px] text-slate-400"
              title={s.label}
            >
              {s.label}
            </li>
          ))}
        </ol>
      )}
      <Handle
        type="source"
        position={Position.Right}
        className="!h-2.5 !w-2.5 !border-teal-800 !bg-teal-500"
      />
    </div>
  );
});

const nodeTypes = { query: QueryNode };

function edgeInfoFromEdge(edge: Edge): GraphEdgeInfo | null {
  const d = edge.data as EdgeData | undefined;
  if (!d?.kind || !d.hostQueryId || !d.otherQueryId) return null;
  return {
    kind: d.kind,
    hostQueryId: d.hostQueryId,
    otherQueryId: d.otherQueryId,
  };
}

function GraphCanvasInner({
  queries,
  activeQueryId,
  focusQueryId,
  positions,
  onPositionsChange,
  onSelect,
  onSetFocus,
  onConnectJoin,
  onSelectEdge,
  onRemoveEdge,
  onRemoveQuery,
  onDeriveQuery,
}: GraphCanvasProps) {
  const { fitView } = useReactFlow();
  const positionsRef = useRef(new Map<string, { x: number; y: number }>());
  const fittedKey = useRef<string>("");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<GraphEdgeInfo | null>(null);

  // Seed from persisted project positions once / when project changes.
  useEffect(() => {
    if (!positions) return;
    for (const [id, p] of Object.entries(positions)) {
      positionsRef.current.set(id, p);
    }
  }, [positions]);

  const initial = useMemo(
    () =>
      buildGraph(
        queries,
        focusQueryId,
        activeQueryId,
        positionsRef.current,
        expandedIds,
        selectedEdgeId,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- bootstrap only
    [],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);

  const toggleExpand = useCallback((queryId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(queryId)) next.delete(queryId);
      else next.add(queryId);
      return next;
    });
  }, []);

  const deriveQuery = useCallback(
    (queryId: string) => {
      onDeriveQuery?.(queryId);
    },
    [onDeriveQuery],
  );

  const actions = useMemo(
    () => ({ toggleExpand, deriveQuery }),
    [toggleExpand, deriveQuery],
  );

  // Sync graph from project model. Merge into RF nodes so measured size stays.
  useEffect(() => {
    const built = buildGraph(
      queries,
      focusQueryId,
      activeQueryId,
      positionsRef.current,
      expandedIds,
      selectedEdgeId,
    );
    setNodes((current) => {
      for (const n of current) {
        positionsRef.current.set(n.id, n.position);
      }
      const prevById = new Map(current.map((n) => [n.id, n]));
      return built.nodes.map((node) => {
        const prev = prevById.get(node.id);
        if (!prev) return node;
        return {
          ...prev,
          type: node.type,
          position: prev.position,
          data: node.data,
        };
      });
    });
    setEdges(built.edges);

    const key = queries
      .map((q) => q.id)
      .sort()
      .join("|");
    if (key && key !== fittedKey.current) {
      fittedKey.current = key;
      requestAnimationFrame(() => {
        void fitView({ padding: 0.2, duration: 200 });
      });
    }
  }, [
    queries,
    focusQueryId,
    activeQueryId,
    expandedIds,
    selectedEdgeId,
    setNodes,
    setEdges,
    fitView,
  ]);

  const persistPositions = useCallback(() => {
    if (!onPositionsChange) return;
    const out: CanvasPositions = {};
    for (const n of nodes) {
      out[n.id] = { x: n.position.x, y: n.position.y };
      positionsRef.current.set(n.id, n.position);
    }
    onPositionsChange(out);
  }, [nodes, onPositionsChange]);

  const onNodeClick = useCallback(
    (_: MouseEvent, node: Node) => {
      setSelectedEdgeId(null);
      setSelectedEdge(null);
      onSelect(node.id);
    },
    [onSelect],
  );

  const onNodeDoubleClick = useCallback(
    (_: MouseEvent, node: Node) => {
      onSetFocus(node.id);
    },
    [onSetFocus],
  );

  const onEdgeClick = useCallback(
    (_: MouseEvent, edge: Edge) => {
      const info = edgeInfoFromEdge(edge);
      setSelectedEdgeId(edge.id);
      setSelectedEdge(info);
      if (info) {
        onSelect(info.hostQueryId);
        onSelectEdge?.(info);
      }
    },
    [onSelect, onSelectEdge],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (!onConnectJoin || !c.source || !c.target || c.source === c.target)
        return;
      onConnectJoin(c.source, c.target);
    },
    [onConnectJoin],
  );

  const removeSelectedEdge = useCallback(() => {
    if (!selectedEdge || !onRemoveEdge) return;
    onRemoveEdge(selectedEdge);
    setSelectedEdgeId(null);
    setSelectedEdge(null);
  }, [selectedEdge, onRemoveEdge]);

  const removeActiveQuery = useCallback(() => {
    if (!activeQueryId || !onRemoveQuery) return;
    onRemoveQuery(activeQueryId);
    setSelectedEdgeId(null);
    setSelectedEdge(null);
  }, [activeQueryId, onRemoveQuery]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      e.preventDefault();
      // Edge selection wins over node.
      if (selectedEdge) {
        removeSelectedEdge();
        return;
      }
      if (activeQueryId) {
        removeActiveQuery();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedEdge, activeQueryId, removeSelectedEdge, removeActiveQuery]);

  if (queries.length === 0) return null;

  return (
    <CanvasActionsCtx.Provider value={actions}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onEdgeClick={onEdgeClick}
        onConnect={onConnect}
        onNodeDragStop={persistPositions}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.35}
        maxZoom={1.6}
        nodesConnectable={Boolean(onConnectJoin)}
        edgesFocusable
        edgesReconnectable={false}
        elementsSelectable={false}
        nodesDraggable
        deleteKeyCode={null}
        proOptions={{ hideAttribution: true }}
        className="dwh-flow"
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={18}
          size={1}
          color="rgba(148,163,184,0.18)"
        />
        <Controls
          showInteractive={false}
          className="!shadow-none [&>button]:!border-[var(--line)] [&>button]:!bg-slate-950 [&>button]:!fill-slate-300"
        />
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) =>
            (n.data as QueryNodeData | undefined)?.isFocus
              ? "#2dd4bf"
              : "#334155"
          }
          maskColor="rgba(7,16,24,0.75)"
          className="!border-[var(--line)] !bg-[#071018]/80"
        />
      </ReactFlow>

      {selectedEdge && onRemoveEdge && (
        <div className="absolute right-3 top-3 z-10 flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-950/95 px-2.5 py-1.5 shadow-lg">
          <span className="font-mono text-[11px] text-teal-200">
            {selectedEdge.kind === "join"
              ? "Join"
              : selectedEdge.kind === "append"
                ? "Append"
                : "From"}{" "}
            · {selectedEdge.otherQueryId.slice(0, 8)}→
            {selectedEdge.hostQueryId.slice(0, 8)}
          </span>
          <button
            type="button"
            onClick={removeSelectedEdge}
            className="rounded bg-rose-500/15 px-2 py-0.5 text-[11px] font-semibold text-rose-300 hover:bg-rose-500/25"
          >
            Remove
          </button>
        </div>
      )}

      {!selectedEdge && activeQueryId && onRemoveQuery && (
        <div className="absolute right-3 top-3 z-10 flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-950/95 px-2.5 py-1.5 shadow-lg">
          <span className="max-w-[140px] truncate text-[11px] text-slate-200">
            {queries.find((q) => q.id === activeQueryId)?.name ?? activeQueryId}
          </span>
          <button
            type="button"
            onClick={removeActiveQuery}
            className="rounded bg-rose-500/15 px-2 py-0.5 text-[11px] font-semibold text-rose-300 hover:bg-rose-500/25"
          >
            Delete
          </button>
        </div>
      )}
    </CanvasActionsCtx.Provider>
  );
}

export function GraphCanvas(props: GraphCanvasProps) {
  return (
    <div className="relative h-full min-h-[260px] overflow-hidden rounded-xl border border-[var(--line)] bg-[radial-gradient(ellipse_at_20%_0%,var(--glow),transparent_50%),linear-gradient(180deg,#0a1520,var(--bg0))]">
      <ReactFlowProvider>
        <GraphCanvasInner {...props} />
      </ReactFlowProvider>
      <p className="pointer-events-none absolute bottom-2 left-3 text-[10px] text-slate-600">
        Drag · zoom · dblclick=focus · ref↳=FromQuery/dbt ref · ▸ steps ·
        Del=delete
        {props.onConnectJoin ? " · drag handle→Join" : ""}
      </p>
    </div>
  );
}
