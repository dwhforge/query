import { memo, useEffect, useMemo, useRef, useState } from "react";
import type {
  ColumnMetadata,
  ConnectionDef,
  Workspace,
} from "../types/pipeline";
import {
  blameUnmatchedKey,
  explainJoinKey,
  joinKeyNearMiss,
  previewWorkspace,
  type BlameUnmatchedKeyResult,
  type ExplainJoinKeyResult,
  type JoinDiagSample,
  type JoinDiagnostics,
  type JoinKeyNearMiss,
  type JoinKeySide,
  type NearMissHypothesis,
} from "../lib/bridge";
import {
  classifyJoinColumnOrigins,
  pinSideIndicesToResult,
  type JoinColumnOrigin,
} from "../lib/joinColumnOrigin";
import { JoinLensAuto } from "./JoinLensAuto";
import { PreviewTable } from "./PreviewTable";

/** Fill result right-origin columns from a Probe right row (hypothetical map pair). */
function overlayRightOntoResultRows(
  baseRows: unknown[][],
  resultColumns: ColumnMetadata[],
  origins: JoinColumnOrigin[],
  rightRow: unknown[],
  rightColumns: ColumnMetadata[],
): unknown[][] {
  const rightByFold = new Map(
    rightColumns.map((c, i) => [fold(c.name), i] as const),
  );
  return baseRows.map((row) => {
    const next = row.slice();
    for (let ci = 0; ci < origins.length; ci++) {
      if (origins[ci] !== "right") continue;
      const name = resultColumns[ci]?.name;
      if (!name) continue;
      const f = fold(name);
      const bare = f.includes("__") ? f.slice(f.lastIndexOf("__") + 2) : f;
      const ri = rightByFold.get(f) ?? rightByFold.get(bare);
      if (ri === undefined) continue;
      next[ci] = rightRow[ri] ?? null;
    }
    return next;
  });
}

function fold(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

function cellStr(v: unknown): string {
  if (v === null || v === undefined) return "∅";
  return String(v);
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === "number" || typeof b === "number") {
    const na = Number(a);
    const nb = Number(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na === nb;
  }
  return String(a) === String(b);
}

function keyValuesFromRow(
  row: unknown[],
  columns: ColumnMetadata[],
  keyNames: string[],
): unknown[] {
  const byFold = new Map(columns.map((c, i) => [fold(c.name), i] as const));
  return keyNames.map((k) => {
    const i = byFold.get(fold(k));
    return i === undefined ? null : (row[i] ?? null);
  });
}

function keysEqual(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => valuesEqual(v, b[i]));
}

/** Match result rows whose left_on columns equal `sideKeys`. */
function findResultMatches(
  resultRows: unknown[][],
  resultColumns: ColumnMetadata[],
  resultKeyNames: string[],
  sideKeys: unknown[],
): number[] {
  if (sideKeys.length === 0 || sideKeys.every((v) => v == null)) return [];
  const byFold = new Map(
    resultColumns.map((c, i) => [fold(c.name), i] as const),
  );
  const idxs = resultKeyNames.map((k) => byFold.get(fold(k)));
  if (idxs.some((i) => i === undefined)) return [];
  const out: number[] = [];
  for (let r = 0; r < resultRows.length; r++) {
    const row = resultRows[r]!;
    let ok = true;
    for (let k = 0; k < sideKeys.length; k++) {
      if (!valuesEqual(row[idxs[k]!], sideKeys[k])) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(r);
  }
  return out;
}

function rowMatchesSearch(row: unknown[], q: string): boolean {
  if (!q.trim()) return true;
  const needle = q.trim().toLowerCase();
  return row.some((cell) => cellStr(cell).toLowerCase().includes(needle));
}

function asColumns(sample: JoinDiagSample | null | undefined): ColumnMetadata[] {
  if (!sample) return [];
  return sample.columns.map((c) => ({ name: c.name, type: c.type }));
}

/** What Linked mode shows for one side. */
function linkedListLabel(pin: {
  indices: number[];
  keyMatchCount: number;
  pinned: boolean;
}): string {
  const n = pin.indices.length;
  const k = pin.keyMatchCount;
  if (k === 0) return "No parent for this result row";
  if (k === 1) return "1 parent of center";
  if (pin.pinned && n === 1) {
    return `1 parent of center (${k} share key)`;
  }
  return `${n} parents of center · same key`;
}

function probeListLabel(
  side: "left" | "right",
  sample: JoinDiagSample | null | undefined,
  shown: number,
): string {
  if (!sample) return "Waiting for diagnostics…";
  const kind = side === "left" ? "unmatched left" : "unmatched right";
  return `Probe · ${kind} · ${shown}/${sample.sample_rows} of ${sample.total_count}`;
}

function blameLabel(b: BlameUnmatchedKeyResult): string {
  switch (b.verdict) {
    case "absent_at_source":
      return "Blame · key absent at source";
    case "filtered_upstream": {
      const step =
        b.dropped_at_step_kind != null
          ? `${b.dropped_at_step_kind}${
              b.dropped_at_step != null ? ` #${b.dropped_at_step}` : ""
            }`
          : "an upstream step";
      return `Blame · filtered upstream at ${step} (was at source, gone at Join input)`;
    }
    case "no_partner":
      return "Blame · no partner on the other side at Join input";
    case "present_on_both":
      return "Blame · key present on both sides (check join type / keys)";
    default:
      return `Blame · ${b.verdict}`;
  }
}

type SideMode = "linked" | "probe" | "auto";

type SidePanelProps = {
  title: "Left" | "Right";
  mode: SideMode;
  columns: ColumnMetadata[];
  rows: unknown[][];
  visibleIndices: number[];
  keyNames: string[];
  loading: boolean;
  search: string;
  onSearch: (q: string) => void;
  selectedIndex: number | null;
  /** Linked parents highlight. Empty in Probe. */
  linkedIndices: number[];
  onSelect: (index: number) => void;
  listModeLabel: string;
  statusHint: string | null;
  emptyHint: string;
  /** Scroll first parent into view when center parents change. */
  scrollToken: string;
  /** Probe + selected row: primary Map CTA. */
  selectedKeyLabel?: string | null;
  onAddToMap?: () => void;
  mapButtonLabel?: string;
};

function SidePanel({
  title,
  mode,
  columns,
  rows,
  visibleIndices,
  keyNames,
  loading,
  search,
  onSearch,
  selectedIndex,
  linkedIndices,
  onSelect,
  listModeLabel,
  statusHint,
  emptyHint,
  scrollToken,
  selectedKeyLabel,
  onAddToMap,
  mapButtonLabel = "Add to map…",
}: SidePanelProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const keyFold = new Set(keyNames.map(fold));
  const linked = useMemo(() => new Set(linkedIndices), [linkedIndices]);
  const activeSide = selectedIndex != null;

  const displayCols = useMemo(() => {
    const keyed: { col: ColumnMetadata; idx: number }[] = [];
    const rest: { col: ColumnMetadata; idx: number }[] = [];
    columns.forEach((col, idx) => {
      (keyFold.has(fold(col.name)) ? keyed : rest).push({ col, idx });
    });
    return [...keyed, ...rest];
  }, [columns, keyNames]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body || visibleIndices.length === 0) return;
    const first = body.querySelector("button");
    first?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [scrollToken, visibleIndices]);

  return (
    <div
      className={`flex h-full min-h-0 w-[13.5rem] shrink-0 flex-col overflow-hidden rounded-lg bg-[#071018] shadow-lg shadow-black/40 ${
        activeSide && mode === "probe"
          ? "border-2 border-amber-500/70"
          : "border border-teal-900/40"
      }`}
    >
      <div className="shrink-0 space-y-1.5 border-b border-slate-800 px-2 py-1.5">
        <div
          className={`text-[10px] font-semibold uppercase tracking-wide ${
            title === "Left" ? "text-sky-300/90" : "text-amber-300/90"
          }`}
        >
          {title} · {mode === "linked" ? "parents" : "unmatched"}
        </div>
        {mode !== "linked" && (
          <input
            type="search"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Filter unmatched sample…"
            className="w-full rounded border border-slate-700 bg-slate-950 px-1.5 py-1 text-[10px] text-slate-200 outline-none placeholder:text-slate-600 focus:ring-1 focus:ring-teal-700"
          />
        )}
        <div className="min-w-0 text-[10px] leading-snug text-slate-500">
          {loading ? "loading…" : listModeLabel}
          {statusHint && (
            <span className="mt-0.5 block text-[10px] text-slate-400">
              {statusHint}
            </span>
          )}
        </div>
      </div>
      <div ref={bodyRef} className="min-h-0 flex-1 overflow-auto p-1.5">
        {visibleIndices.length === 0 ? (
          <p className="px-1 py-2 text-[10px] leading-relaxed text-slate-600">
            {loading ? "Loading…" : emptyHint}
          </p>
        ) : (
          visibleIndices.map((index) => {
            const row = rows[index]!;
            const selected = selectedIndex === index;
            const isLinked = linked.has(index);
            return (
              <button
                key={index}
                type="button"
                onClick={() => onSelect(index)}
                className={`mb-1.5 w-full rounded border p-1.5 text-left last:mb-0 ${
                  selected
                    ? mode === "probe"
                      ? "border-amber-500/80 bg-amber-500/15 ring-1 ring-amber-500/40"
                      : "border-teal-500/70 bg-teal-500/15"
                    : isLinked
                      ? "border-teal-800/50 bg-teal-500/5"
                      : "border-slate-800/80 bg-slate-950/80 hover:border-slate-700"
                }`}
              >
                {displayCols.map(({ col: c, idx: ci }) => {
                  const isKey = keyFold.has(fold(c.name));
                  return (
                    <div
                      key={c.name}
                      className={`flex gap-1 truncate rounded px-0.5 text-[10px] leading-snug ${
                        isKey ? "bg-teal-500/15 text-teal-50" : ""
                      }`}
                    >
                      <span
                        className={`shrink-0 ${isKey ? "text-teal-300" : "text-slate-600"}`}
                      >
                        {c.name}
                      </span>
                      <span
                        className={`min-w-0 truncate font-mono ${isKey ? "text-teal-50" : "text-slate-300"}`}
                      >
                        {cellStr(row[ci])}
                      </span>
                    </div>
                  );
                })}
              </button>
            );
          })
        )}
      </div>
      {mode === "probe" && onAddToMap && selectedIndex != null && (
        <div className="shrink-0 space-y-1.5 border-t border-amber-900/50 bg-amber-950/35 px-2 py-2">
          <div className="text-[9px] uppercase tracking-wide text-amber-200/80">
            This key
          </div>
          <div
            className="truncate font-mono text-[11px] text-amber-50"
            title={selectedKeyLabel ?? undefined}
          >
            {selectedKeyLabel || "∅"}
          </div>
          <button
            type="button"
            title={mapButtonLabel}
            onClick={onAddToMap}
            className="w-full rounded border border-amber-600/70 bg-amber-500/20 px-2 py-1 text-[10px] font-semibold text-amber-50 hover:bg-amber-500/30"
          >
            {mapButtonLabel}
          </button>
        </div>
      )}
    </div>
  );
}

const FIRST_USE_HINT_KEY = "dwh.joinLens.firstUseHint.v1";

export type JoinLensProps = {
  enabled: boolean;
  workspace: Workspace;
  hostQueryId: string;
  joinStepIndex: number;
  rightQueryId: string;
  leftOn: string[];
  rightOn: string[];
  connections: ConnectionDef[];
  columns: ColumnMetadata[];
  rows: unknown[][];
  /** Opposite-probe candidates (unmatched samples). */
  joinDiag: JoinDiagnostics | null;
  joinDiagLoading?: boolean;
  /** Bump to force Probe mode (e.g. from Data-banner "Open in Probe"). */
  forceProbeNonce?: number;
  /** Apply near-miss → insert NormalizeKey before Join. */
  onApplyNearMiss?: (hyp: NearMissHypothesis) => void;
  /**
   * Open KeyMap with From values (and optional To when both sides selected).
   * `side` = which join input gets ApplyKeyMap (usually left for dirty→id).
   */
  onMapKey?: (
    side: JoinKeySide,
    fromValues: string[],
    opts?: { toValues?: string[] },
  ) => void;
};

function JoinLensImpl({
  enabled,
  workspace,
  hostQueryId,
  joinStepIndex,
  rightQueryId,
  leftOn,
  rightOn,
  connections,
  columns,
  rows,
  joinDiag,
  joinDiagLoading = false,
  forceProbeNonce = 0,
  onApplyNearMiss,
  onMapKey,
}: JoinLensProps) {
  /** Linked-mode parent lookup (preview of left/right inputs). */
  const [parentLeftCols, setParentLeftCols] = useState<ColumnMetadata[]>([]);
  const [parentRightCols, setParentRightCols] = useState<ColumnMetadata[]>([]);
  const [parentLeftRows, setParentLeftRows] = useState<unknown[][]>([]);
  const [parentRightRows, setParentRightRows] = useState<unknown[][]>([]);
  const [sidesLoading, setSidesLoading] = useState(false);

  const [sideMode, setSideMode] = useState<SideMode>("linked");
  const [searchLeft, setSearchLeft] = useState("");
  const [searchRight, setSearchRight] = useState("");
  const [leftSel, setLeftSel] = useState<number | null>(null);
  const [rightSel, setRightSel] = useState<number | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [matchesOnly, setMatchesOnly] = useState(false);
  const [keyExplain, setKeyExplain] = useState<ExplainJoinKeyResult | null>(
    null,
  );
  const [keyBlame, setKeyBlame] = useState<BlameUnmatchedKeyResult | null>(
    null,
  );
  const [keyExplainLoading, setKeyExplainLoading] = useState(false);
  const [keyExplainError, setKeyExplainError] = useState<string | null>(null);
  const [nearMiss, setNearMiss] = useState<JoinKeyNearMiss | null>(null);
  const [nearMissLoading, setNearMissLoading] = useState(false);
  const [nearMissOpen, setNearMissOpen] = useState(false);
  const [mapToast, setMapToast] = useState<string | null>(null);
  const [showFirstUseHint, setShowFirstUseHint] = useState(() => {
    try {
      return localStorage.getItem(FIRST_USE_HINT_KEY) !== "1";
    } catch {
      return true;
    }
  });

  useEffect(() => {
    if (!forceProbeNonce) return;
    setSideMode("probe");
    setMatchesOnly(false);
    setSearchLeft("");
    setSearchRight("");
    setKeyExplain(null);
    setKeyBlame(null);
    setKeyExplainError(null);
    setLeftSel(null);
    setRightSel(null);
  }, [forceProbeNonce]);

  useEffect(() => {
    if (!enabled || !hostQueryId || joinStepIndex < 1 || !rightQueryId) return;
    let cancelled = false;
    setSidesLoading(true);
    const leftWs: Workspace = {
      ...workspace,
      focus_query_id: hostQueryId,
      queries: workspace.queries.map((q) =>
        q.id === hostQueryId
          ? { ...q, steps: q.steps.slice(0, joinStepIndex) }
          : q,
      ),
    };
    const rightWs: Workspace = {
      ...workspace,
      focus_query_id: rightQueryId,
    };
    void Promise.all([
      previewWorkspace(leftWs, connections),
      previewWorkspace(rightWs, connections),
    ])
      .then(([left, right]) => {
        if (cancelled) return;
        setParentLeftCols(left.columns);
        setParentLeftRows(left.rows);
        setParentRightCols(right.columns);
        setParentRightRows(right.rows);
        setSidesLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setParentLeftCols([]);
          setParentLeftRows([]);
          setParentRightCols([]);
          setParentRightRows([]);
          setSidesLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    enabled,
    workspace,
    hostQueryId,
    joinStepIndex,
    rightQueryId,
    connections,
  ]);

  useEffect(() => {
    setLeftSel(null);
    setRightSel(null);
    setSearchLeft("");
    setSearchRight("");
    setMatchesOnly(false);
    setActiveIndex(0);
    setSideMode("linked");
    setKeyExplain(null);
    setKeyBlame(null);
    setKeyExplainError(null);
    setNearMiss(null);
  }, [hostQueryId, joinStepIndex, leftOn.join("\0"), rightOn.join("\0")]);

  useEffect(() => {
    if (!enabled || !hostQueryId || joinStepIndex < 1) return;
    let cancelled = false;
    setNearMissLoading(true);
    void joinKeyNearMiss(workspace, hostQueryId, joinStepIndex, connections)
      .then((r) => {
        if (!cancelled) setNearMiss(r);
      })
      .catch(() => {
        if (!cancelled) setNearMiss(null);
      })
      .finally(() => {
        if (!cancelled) setNearMissLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, workspace, hostQueryId, joinStepIndex, connections]);

  const unmatchedLeft = joinDiag?.unmatched_left ?? null;
  const unmatchedRight = joinDiag?.unmatched_right ?? null;

  const probeLeftCols = useMemo(
    () => asColumns(unmatchedLeft),
    [unmatchedLeft],
  );
  const probeRightCols = useMemo(
    () => asColumns(unmatchedRight),
    [unmatchedRight],
  );
  const probeLeftRows = unmatchedLeft?.rows ?? [];
  const probeRightRows = unmatchedRight?.rows ?? [];

  const leftCols = sideMode === "linked" ? parentLeftCols : probeLeftCols;
  const rightCols = sideMode === "linked" ? parentRightCols : probeRightCols;
  const leftRows = sideMode === "linked" ? parentLeftRows : probeLeftRows;
  const rightRows = sideMode === "linked" ? parentRightRows : probeRightRows;

  const pairMode = leftSel != null && rightSel != null;
  const sideProbe = leftSel != null || rightSel != null;

  // Full-input explain for the probe focus. Prefer left when both selected so
  // pair preview keeps the same left sample (right only fills right cols).
  const explainFocus = useMemo(() => {
    if (leftSel != null) {
      return { side: "left" as const, index: leftSel };
    }
    if (rightSel != null) {
      return { side: "right" as const, index: rightSel };
    }
    return null;
  }, [leftSel, rightSel]);

  useEffect(() => {
    if (!enabled || !explainFocus) {
      setKeyExplain(null);
      setKeyBlame(null);
      setKeyExplainError(null);
      setKeyExplainLoading(false);
      return;
    }
    const { side, index } = explainFocus;
    const row = side === "left" ? leftRows[index] : rightRows[index];
    const cols = side === "left" ? leftCols : rightCols;
    const keysOn = side === "left" ? leftOn : rightOn;
    if (!row) return;
    const keys = keyValuesFromRow(row, cols, keysOn);
    if (keys.length === 0 || keys.every((v) => v == null)) {
      setKeyExplain(null);
      setKeyBlame(null);
      return;
    }
    let cancelled = false;
    setKeyExplainLoading(true);
    setKeyExplainError(null);
    setKeyBlame(null);
    void explainJoinKey(
      workspace,
      hostQueryId,
      joinStepIndex,
      side,
      keys,
      connections,
    )
      .then(async (ex) => {
        if (cancelled) return;
        setKeyExplain(ex);
        setMatchesOnly(true);
        if (ex.result_match_count === 0) {
          try {
            const blame = await blameUnmatchedKey(
              workspace,
              hostQueryId,
              joinStepIndex,
              side,
              keys,
              connections,
            );
            if (!cancelled) setKeyBlame(blame);
          } catch (e) {
            if (!cancelled) {
              setKeyBlame(null);
              setKeyExplainError(typeof e === "string" ? e : String(e));
            }
          }
        } else {
          setKeyBlame(null);
        }
        setKeyExplainLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setKeyExplain(null);
        setKeyBlame(null);
        setKeyExplainLoading(false);
        setKeyExplainError(typeof e === "string" ? e : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [
    enabled,
    explainFocus,
    leftRows,
    rightRows,
    leftCols,
    rightCols,
    leftOn,
    rightOn,
    workspace,
    hostQueryId,
    joinStepIndex,
    connections,
  ]);

  // Pair preview is not a blame context — drop blame when both sides selected.
  useEffect(() => {
    if (pairMode) setKeyBlame(null);
  }, [pairMode]);

  /** Result rows matching current side selection (one side or both). */
  const matchedIndices = useMemo(() => {
    if (!sideProbe) return [] as number[];

    if (pairMode) {
      const lRow = leftRows[leftSel!];
      if (!lRow) return [];
      // Base preview on left key. When keys ≠ right (map pair), right cols are
      // overlaid hypothetically in displayRows; when equal, these are real hits.
      return findResultMatches(
        rows,
        columns,
        leftOn,
        keyValuesFromRow(lRow, leftCols, leftOn),
      );
    }

    if (leftSel != null) {
      const row = leftRows[leftSel];
      if (!row) return [];
      return findResultMatches(
        rows,
        columns,
        leftOn,
        keyValuesFromRow(row, leftCols, leftOn),
      );
    }
    const row = rightRows[rightSel!];
    if (!row) return [];
    return findResultMatches(
      rows,
      columns,
      leftOn,
      keyValuesFromRow(row, rightCols, rightOn),
    );
  }, [
    sideProbe,
    pairMode,
    leftSel,
    rightSel,
    leftRows,
    rightRows,
    leftCols,
    rightCols,
    leftOn,
    rightOn,
    rows,
    columns,
  ]);

  /** Pair selected but keys differ → preview as if left mapped to right. */
  const pairHypothetical = useMemo(() => {
    if (!pairMode || leftSel == null || rightSel == null) return false;
    const lRow = leftRows[leftSel];
    const rRow = rightRows[rightSel];
    if (!lRow || !rRow) return false;
    return !keysEqual(
      keyValuesFromRow(lRow, leftCols, leftOn),
      keyValuesFromRow(rRow, rightCols, rightOn),
    );
  }, [
    pairMode,
    leftSel,
    rightSel,
    leftRows,
    rightRows,
    leftCols,
    rightCols,
    leftOn,
    rightOn,
  ]);

  // Keep Matches-only on when forming a map pair so the center stays focused.
  useEffect(() => {
    if (pairMode) setMatchesOnly(true);
  }, [pairMode]);

  const columnOrigins = useMemo(
    () =>
      classifyJoinColumnOrigins(
        columns.map((c) => c.name),
        leftOn,
        parentLeftCols.map((c) => c.name),
        parentRightCols.map((c) => c.name),
      ),
    [columns, leftOn, parentLeftCols, parentRightCols],
  );

  const leftPin = useMemo(() => {
    const resultRow = rows[activeIndex];
    if (!resultRow) {
      return { indices: [] as number[], keyMatchCount: 0, pinned: false };
    }
    return pinSideIndicesToResult({
      side: "left",
      sideRows: parentLeftRows,
      sideColumns: parentLeftCols,
      resultRow,
      resultColumns: columns,
      origins: columnOrigins,
      leftOn,
      rightOn,
    });
  }, [
    rows,
    activeIndex,
    parentLeftRows,
    parentLeftCols,
    columns,
    columnOrigins,
    leftOn,
    rightOn,
  ]);

  const rightPin = useMemo(() => {
    const resultRow = rows[activeIndex];
    if (!resultRow) {
      return { indices: [] as number[], keyMatchCount: 0, pinned: false };
    }
    return pinSideIndicesToResult({
      side: "right",
      sideRows: parentRightRows,
      sideColumns: parentRightCols,
      resultRow,
      resultColumns: columns,
      origins: columnOrigins,
      leftOn,
      rightOn,
    });
  }, [
    rows,
    activeIndex,
    parentRightRows,
    parentRightCols,
    columns,
    columnOrigins,
    leftOn,
    rightOn,
  ]);

  const linkedLeft = sideMode === "linked" ? leftPin.indices : [];
  const linkedRight = sideMode === "linked" ? rightPin.indices : [];

  /**
   * Linked: parents of center only (stable pin order) — no text filter
   * (usually 1 row; a search box felt broken).
   * Probe: unmatched diag sample, substring filter on cell values (L/R same).
   */
  const visibleLeft = useMemo(() => {
    if (sideMode !== "linked") {
      return probeLeftRows
        .map((_, i) => i)
        .filter((i) => rowMatchesSearch(probeLeftRows[i]!, searchLeft));
    }
    return linkedLeft;
  }, [sideMode, probeLeftRows, searchLeft, linkedLeft]);

  const visibleRight = useMemo(() => {
    if (sideMode !== "linked") {
      return probeRightRows
        .map((_, i) => i)
        .filter((i) => rowMatchesSearch(probeRightRows[i]!, searchRight));
    }
    return linkedRight;
  }, [sideMode, probeRightRows, searchRight, linkedRight]);

  /** Prefer full-input explain sample when showing matches for a key. */
  const showingExplainSample =
    !!keyExplain &&
    !pairHypothetical &&
    sideProbe &&
    (matchesOnly || keyExplain.result_match_count === 0);

  /** Pair map preview: same left explain sample, right cols overlaid. */
  const pairExplainPreview =
    pairHypothetical && !!keyExplain && leftSel != null && rightSel != null;

  const displayColumns = useMemo(() => {
    if ((showingExplainSample || pairExplainPreview) && keyExplain) {
      return keyExplain.result_columns.map((c) => ({
        name: c.name,
        type: c.type,
      })) as ColumnMetadata[];
    }
    return columns;
  }, [showingExplainSample, pairExplainPreview, keyExplain, columns]);

  const displayOrigins = useMemo(() => {
    if ((showingExplainSample || pairExplainPreview) && keyExplain) {
      return classifyJoinColumnOrigins(
        keyExplain.result_columns.map((c) => c.name),
        leftOn,
        parentLeftCols.map((c) => c.name),
        parentRightCols.map((c) => c.name),
      );
    }
    return columnOrigins;
  }, [
    showingExplainSample,
    pairExplainPreview,
    keyExplain,
    leftOn,
    parentLeftCols,
    parentRightCols,
    columnOrigins,
  ]);

  const displayRows = useMemo(() => {
    if (pairExplainPreview && keyExplain && rightSel != null) {
      const explainCols = keyExplain.result_columns.map((c) => ({
        name: c.name,
        type: c.type,
      })) as ColumnMetadata[];
      return overlayRightOntoResultRows(
        keyExplain.result_rows,
        explainCols,
        displayOrigins,
        rightRows[rightSel]!,
        rightCols,
      );
    }
    if (showingExplainSample && keyExplain) {
      return keyExplain.result_rows;
    }
    if (!matchesOnly || !sideProbe || matchedIndices.length === 0) return rows;
    const base = matchedIndices.map((i) => rows[i]!);
    if (
      pairHypothetical &&
      rightSel != null &&
      rightRows[rightSel] &&
      columnOrigins.some((o) => o === "right")
    ) {
      return overlayRightOntoResultRows(
        base,
        columns,
        columnOrigins,
        rightRows[rightSel]!,
        rightCols,
      );
    }
    return base;
  }, [
    pairExplainPreview,
    showingExplainSample,
    keyExplain,
    matchesOnly,
    sideProbe,
    matchedIndices,
    rows,
    pairHypothetical,
    rightSel,
    rightRows,
    rightCols,
    columns,
    columnOrigins,
    displayOrigins,
  ]);

  const displayMatched = useMemo(() => {
    if (!sideProbe) return undefined;
    if ((showingExplainSample || pairExplainPreview) && keyExplain) {
      return keyExplain.result_rows.map((_, i) => i);
    }
    if (matchesOnly && matchedIndices.length > 0) {
      return displayRows.map((_, i) => i);
    }
    return matchedIndices;
  }, [
    sideProbe,
    showingExplainSample,
    pairExplainPreview,
    keyExplain,
    matchesOnly,
    matchedIndices,
    displayRows,
  ]);

  const displayActive = useMemo(() => {
    if (showingExplainSample || pairExplainPreview) return 0;
    if (matchesOnly && matchedIndices.length > 0) {
      const pos = matchedIndices.indexOf(activeIndex);
      return pos >= 0 ? pos : 0;
    }
    return activeIndex;
  }, [
    showingExplainSample,
    pairExplainPreview,
    matchesOnly,
    matchedIndices,
    activeIndex,
  ]);

  const scrollToken = `${sideMode}|${activeIndex}|${linkedLeft.join(",")}|${linkedRight.join(",")}`;

  const leftListMode =
    sideMode === "linked"
      ? linkedListLabel(leftPin)
      : sideMode === "auto"
        ? `Unmatched sample · ${visibleLeft.length}`
        : probeListLabel("left", unmatchedLeft, visibleLeft.length);
  const rightListMode =
    sideMode === "linked"
      ? linkedListLabel(rightPin)
      : sideMode === "auto"
        ? `Unmatched sample · ${visibleRight.length}`
        : probeListLabel("right", unmatchedRight, visibleRight.length);

  const leftEmpty =
    sideMode === "linked"
      ? "No parent for this result row."
      : joinDiagLoading || !joinDiag
        ? "Waiting for diagnostics…"
        : searchLeft.trim()
          ? "No sample rows match filter."
          : unmatchedLeft && unmatchedLeft.total_count === 0
            ? "No unmatched left (full input)."
            : "No unmatched left in sample.";

  const rightEmpty =
    sideMode === "linked"
      ? "No parent for this result row."
      : joinDiagLoading || !joinDiag
        ? "Waiting for diagnostics…"
        : searchRight.trim()
          ? "No sample rows match filter."
          : unmatchedRight && unmatchedRight.total_count === 0
            ? "No unmatched right (full input)."
            : "No unmatched right in sample.";

  const leftStatus = useMemo(() => {
    if (!sideProbe) return null;
    if (pairMode) {
      return pairHypothetical
        ? `Pair preview · ${matchedIndices.length} left row(s)`
        : matchedIndices.length > 0
          ? `Pair → ${matchedIndices.length} in result`
          : "Pair not in result";
    }
    if (leftSel != null && keyExplain) {
      return `Full join · ${keyExplain.result_match_count} result · L${keyExplain.left_match_count}/R${keyExplain.right_match_count}`;
    }
    if (leftSel != null) {
      return keyExplainLoading ? "Explaining key…" : null;
    }
    return null;
  }, [
    sideProbe,
    pairMode,
    pairHypothetical,
    leftSel,
    matchedIndices,
    keyExplain,
    keyExplainLoading,
  ]);

  const rightStatus = useMemo(() => {
    if (!sideProbe) return null;
    if (pairMode) {
      return pairHypothetical
        ? `Pair preview · right → center`
        : matchedIndices.length > 0
          ? `Pair → ${matchedIndices.length} in result`
          : "Pair not in result";
    }
    if (rightSel != null && leftSel == null && keyExplain) {
      return `Full join · ${keyExplain.result_match_count} result · L${keyExplain.left_match_count}/R${keyExplain.right_match_count}`;
    }
    if (rightSel != null && leftSel == null) {
      return keyExplainLoading ? "Explaining key…" : null;
    }
    return null;
  }, [
    sideProbe,
    pairMode,
    pairHypothetical,
    rightSel,
    leftSel,
    matchedIndices,
    keyExplain,
    keyExplainLoading,
  ]);

  function keyLabelFor(side: JoinKeySide, rowIndex: number): string {
    const row = side === "left" ? leftRows[rowIndex] : rightRows[rowIndex];
    const cols = side === "left" ? leftCols : rightCols;
    const keys = side === "left" ? leftOn : rightOn;
    if (!row) return "";
    return keyValuesFromRow(row, cols, keys)
      .map((v) => cellStr(v))
      .join(" · ");
  }

  function keyValsFor(side: JoinKeySide, rowIndex: number): string[] {
    const row = side === "left" ? leftRows[rowIndex] : rightRows[rowIndex];
    const cols = side === "left" ? leftCols : rightCols;
    const keys = side === "left" ? leftOn : rightOn;
    if (!row) return [];
    return keyValuesFromRow(row, cols, keys)
      .map((v) => cellStr(v))
      .filter((v) => v.trim());
  }

  function emitMapKey(side: JoinKeySide, rowIndex: number) {
    if (!onMapKey) return;
    const vals = keyValsFor(side, rowIndex);
    if (!vals.length) return;
    onMapKey(side, vals);
    const toast = `Opened KeyMap · from=${vals.join(" · ")}`;
    setMapToast(toast);
    window.setTimeout(() => {
      setMapToast((cur) => (cur === toast ? null : cur));
    }, 3500);
  }

  /** Left unmatched → From, right unmatched → To (dirty names → canon id). */
  function emitMapPair() {
    if (!onMapKey || leftSel == null || rightSel == null) return;
    const fromVals = keyValsFor("left", leftSel);
    const toVals = keyValsFor("right", rightSel);
    if (!fromVals.length || !toVals.length) return;
    onMapKey("left", fromVals, { toValues: toVals });
    const toast = `Opened KeyMap · ${fromVals.join(" · ")} → ${toVals.join(" · ")}`;
    setMapToast(toast);
    window.setTimeout(() => {
      setMapToast((cur) => (cur === toast ? null : cur));
    }, 3500);
  }

  const pairFromLabel =
    pairMode && leftSel != null ? keyLabelFor("left", leftSel) : null;
  const pairToLabel =
    pairMode && rightSel != null ? keyLabelFor("right", rightSel) : null;

  const switchMode = (next: SideMode) => {
    if (next === sideMode) return;
    setSideMode(next);
    setMatchesOnly(false);
    setSearchLeft("");
    setSearchRight("");
    setKeyExplain(null);
    setKeyBlame(null);
    setKeyExplainError(null);
    setLeftSel(null);
    setRightSel(null);
    setNearMissOpen(false);
  };

  const dismissFirstUseHint = () => {
    setShowFirstUseHint(false);
    try {
      localStorage.setItem(FIRST_USE_HINT_KEY, "1");
    } catch {
      /* ignore */
    }
  };

  const unmatchedTotal =
    (joinDiag?.unmatched_left_count ?? 0) +
    (joinDiag?.unmatched_right_count ?? 0);

  const selectedProbeSide: JoinKeySide | null =
    sideMode === "probe"
      ? leftSel != null
        ? "left"
        : rightSel != null
          ? "right"
          : null
      : null;

  const selectedProbeIndex =
    selectedProbeSide === "left"
      ? leftSel
      : selectedProbeSide === "right"
        ? rightSel
        : null;

  const selectedKeyDisplay =
    selectedProbeSide != null && selectedProbeIndex != null
      ? keyLabelFor(selectedProbeSide, selectedProbeIndex)
      : null;

  const statusLine = (() => {
    if (sideMode === "linked") {
      return `Result row ${activeIndex + 1} of ${rows.length} · parents highlighted on Left/Right`;
    }
    if (!sideProbe) {
      return unmatchedTotal > 0
        ? `Pick an unmatched row on Left or Right to map or blame (${unmatchedTotal} unmatched)`
        : "No unmatched keys in the current sample";
    }
    if (pairMode && pairFromLabel && pairToLabel) {
      if (pairHypothetical) {
        const n =
          keyExplain?.result_rows.length ?? matchedIndices.length;
        return `Pair preview “${pairFromLabel}” → “${pairToLabel}” · ${n} left row(s), right cols filled as if mapped · Map this pair to apply`;
      }
      const inResult =
        matchedIndices.length > 0
          ? `${matchedIndices.length} result row(s) (keys already equal)`
          : "not in result";
      return `Pair “${pairFromLabel}” → “${pairToLabel}” · ${inResult}`;
    }
    if (keyBlame) return blameLabel(keyBlame);
    if (keyExplainError) return keyExplainError;
    if (keyExplainLoading) return "Explaining key…";
    if (keyExplain && selectedKeyDisplay) {
      return `Key “${selectedKeyDisplay}” · ${keyExplain.result_match_count} result · L${keyExplain.left_match_count}/R${keyExplain.right_match_count}`;
    }
    if (selectedKeyDisplay) {
      return `Selected “${selectedKeyDisplay}” · pick a partner on the other side to Map the pair, or Add to map with empty To`;
    }
    return "Select an unmatched row (or both sides to Map a pair)";
  })();

  if (!enabled) {
    return (
      <PreviewTable columns={columns} rows={rows} highlightKeys={leftOn} />
    );
  }

  const sideLoading =
    sideMode === "linked" ? sidesLoading : joinDiagLoading && !joinDiag;

  const nearMissCount = nearMiss?.hypotheses.length ?? 0;
  const showNearMissChrome =
    nearMissLoading || nearMissCount > 0;

  return (
    <div className="relative flex h-full min-h-0 gap-2 p-1">
      <SidePanel
        title="Left"
        mode={sideMode}
        columns={leftCols}
        rows={leftRows}
        visibleIndices={visibleLeft}
        keyNames={leftOn}
        loading={sideLoading}
        search={searchLeft}
        onSearch={setSearchLeft}
        selectedIndex={leftSel}
        linkedIndices={linkedLeft}
        listModeLabel={leftListMode}
        statusHint={leftStatus}
        emptyHint={leftEmpty}
        scrollToken={`L:${scrollToken}`}
        selectedKeyLabel={
          leftSel != null ? keyLabelFor("left", leftSel) : null
        }
        onSelect={(index) => {
          if (sideMode === "auto") return;
          setLeftSel((prev) => (prev === index ? null : index));
        }}
        mapButtonLabel={pairMode ? "Map this pair…" : "Add to map…"}
        onAddToMap={
          onMapKey && sideMode === "probe" && leftSel != null
            ? pairMode
              ? () => emitMapPair()
              : () => emitMapKey("left", leftSel)
            : undefined
        }
      />

      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-slate-800/80">
        {/* Layer 1: title + mode */}
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-800/80 bg-[#071018]/95 px-2 py-1.5">
          <span className="text-[9px] font-semibold uppercase tracking-wide text-teal-300/90">
            Join Lens
          </span>
          <div className="flex overflow-hidden rounded border border-slate-700">
            <button
              type="button"
              onClick={() => switchMode("linked")}
              title="Parents of the selected result row"
              className={`px-1.5 py-0.5 text-[9px] ${
                sideMode === "linked"
                  ? "bg-teal-500/20 text-teal-200"
                  : "text-slate-500 hover:text-slate-300"
              }`}
            >
              Linked
            </button>
            <button
              type="button"
              onClick={() => switchMode("probe")}
              title="Keys that did not join — pick one to map or blame"
              className={`px-1.5 py-0.5 text-[9px] ${
                sideMode === "probe"
                  ? "bg-teal-500/20 text-teal-200"
                  : "text-slate-500 hover:text-slate-300"
              }`}
            >
              Probe
              {unmatchedTotal > 0 && (
                <span className="ml-1 text-amber-300/90">·{unmatchedTotal}</span>
              )}
              {unmatchedTotal > 0 && (
                <span className="ml-1 text-[8px] font-normal normal-case text-amber-200/70">
                  needs map?
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => switchMode("auto")}
              title="Suggest From→To with Jaro-Winkler. Accept writes a KeyMap. Probe stays manual."
              className={`px-1.5 py-0.5 text-[9px] ${
                sideMode === "auto"
                  ? "bg-teal-500/20 text-teal-200"
                  : "text-slate-500 hover:text-slate-300"
              }`}
            >
              Auto
            </button>
          </div>
          <span
            className="min-w-0 flex-1 truncate text-[10px] text-slate-500"
            title={
              sideMode === "linked"
                ? "Parents of the selected result row"
                : sideMode === "auto"
                  ? "Fuzzy suggestions — accept into a KeyMap"
                  : "Keys that did not join — pick one to map or blame"
            }
          >
            {sideMode === "linked"
              ? "Parents of the selected result row"
              : sideMode === "auto"
                ? "Fuzzy suggestions — accept into a KeyMap"
                : "Keys that did not join — pick one to map or blame"}
          </span>
        </div>

        {showFirstUseHint && (
          <div className="shrink-0 border-b border-teal-950/50 bg-teal-950/25 px-2 py-1.5 text-[10px] leading-relaxed text-teal-100/90">
            <div className="flex items-start justify-between gap-2">
              <ol className="list-decimal space-y-0.5 pl-3.5">
                <li>
                  <span className="font-semibold text-teal-200">Linked</span> —
                  understand fan-out of the result row
                </li>
                <li>
                  <span className="font-semibold text-teal-200">Probe</span> —
                  find holes (unmatched keys)
                </li>
                <li>
                  Click unmatched (ideally left + right partner) →{" "}
                  <span className="font-semibold text-amber-200">
                    Map this pair…
                  </span>
                </li>
                <li>
                  <span className="font-semibold text-teal-200">Auto</span> —
                  Jaro-Winkler suggestions, then Accept. Leftovers can go to the
                  LLM chat.
                </li>
              </ol>
              <button
                type="button"
                onClick={dismissFirstUseHint}
                className="shrink-0 rounded border border-slate-700 px-1.5 py-0.5 text-[9px] text-slate-400 hover:text-slate-200"
              >
                Got it
              </button>
            </div>
          </div>
        )}

        {mapToast && (
          <div className="shrink-0 border-b border-amber-900/40 bg-amber-950/30 px-2 py-1 text-[10px] text-amber-100/90">
            {mapToast}
          </div>
        )}

        {sideMode === "auto" ? (
          <JoinLensAuto
            workspace={workspace}
            hostQueryId={hostQueryId}
            joinStepIndex={joinStepIndex}
            connections={connections}
            onAccept={
              onMapKey
                ? (fromValues, toValues) => {
                    onMapKey("left", fromValues, { toValues });
                    const toast = `Opened KeyMap · ${fromValues.length} auto pair${fromValues.length === 1 ? "" : "s"}`;
                    setMapToast(toast);
                    window.setTimeout(() => {
                      setMapToast((cur) => (cur === toast ? null : cur));
                    }, 3500);
                  }
                : undefined
            }
          />
        ) : (
          <>
        {/* Layer 2: status */}
        <div className="shrink-0 border-b border-slate-800/60 bg-slate-950/50 px-2 py-1 text-[10px] leading-snug text-slate-400">
          {statusLine}
        </div>

        {/* Layer 3: secondary controls */}
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-800/80 bg-[#071018]/80 px-2 py-1">
          <span className="text-[9px] text-teal-300/80">join</span>
          <span className="text-[9px] text-sky-300/80">left</span>
          <span className="text-[9px] text-amber-300/80">right</span>
          {sideProbe &&
            (keyExplain
              ? keyExplain.result_match_count > 0
              : matchedIndices.length > 0) && (
              <button
                type="button"
                onClick={() => setMatchesOnly((v) => !v)}
                className="rounded border border-slate-700 px-1.5 py-0.5 text-[9px] text-slate-400 hover:border-teal-800 hover:text-teal-200"
              >
                {matchesOnly || showingExplainSample
                  ? "Show all preview"
                  : "Matches only"}
              </button>
            )}
          {sideProbe && (
            <button
              type="button"
              onClick={() => {
                setLeftSel(null);
                setRightSel(null);
                setMatchesOnly(false);
                setKeyExplain(null);
                setKeyBlame(null);
                setKeyExplainError(null);
              }}
              className="rounded border border-slate-700 px-1.5 py-0.5 text-[9px] text-slate-500 hover:text-slate-300"
            >
              Clear
            </button>
          )}
          {showNearMissChrome && (
            <button
              type="button"
              onClick={() => setNearMissOpen((v) => !v)}
              className="rounded border border-teal-800/70 px-1.5 py-0.5 text-[9px] text-teal-200/90 hover:bg-teal-500/10"
            >
              {nearMissLoading
                ? "Near-miss…"
                : `${nearMissCount} near-miss hypothes${nearMissCount === 1 ? "is" : "es"}`}
              {nearMissOpen ? " ▾" : " ▸"}
            </button>
          )}
        </div>

        {showNearMissChrome && nearMissOpen && (
          <div className="shrink-0 space-y-1 border-b border-teal-950/60 bg-teal-950/20 px-2 py-1">
            {(nearMiss?.hypotheses ?? []).slice(0, 3).map((h, i) => (
              <div
                key={i}
                className="flex flex-wrap items-center gap-1.5 text-[10px] text-slate-300"
              >
                <span className="font-mono text-teal-200/90">
                  {h.ops.join("→")}
                </span>
                <span className="text-slate-500">on {h.apply_on}</span>
                <span className="text-slate-500">Δ+{h.delta_matches}</span>
                {onApplyNearMiss && (
                  <button
                    type="button"
                    onClick={() => onApplyNearMiss(h)}
                    className="rounded border border-teal-800/80 px-1 py-0.5 text-[9px] text-teal-200 hover:bg-teal-500/10"
                  >
                    Apply NormalizeKey
                  </button>
                )}
              </div>
            ))}
            {!nearMissLoading && nearMissCount === 0 && (
              <div className="text-[10px] text-slate-500">No hypotheses yet</div>
            )}
          </div>
        )}

        {/* Key card: single side or L→R pair → Map */}
        {sideMode === "probe" && pairMode && pairFromLabel && pairToLabel && (
          <div className="shrink-0 border-b border-amber-950/40 bg-gradient-to-r from-amber-950/35 via-slate-950/40 to-amber-950/20 px-2 py-2">
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-[9px] uppercase tracking-wide text-amber-200/70">
                  Map pair · left → right
                </div>
                <div className="truncate font-mono text-[12px] text-amber-50">
                  From: {pairFromLabel}
                </div>
                <div className="truncate font-mono text-[12px] text-teal-100/90">
                  To: {pairToLabel}
                </div>
              </div>
              {onMapKey && (
                <button
                  type="button"
                  onClick={() => emitMapPair()}
                  className="shrink-0 rounded border border-amber-600/80 bg-amber-500/25 px-3 py-1.5 text-[11px] font-semibold text-amber-50 hover:bg-amber-500/35"
                >
                  Map this pair…
                </button>
              )}
            </div>
          </div>
        )}
        {sideMode === "probe" &&
          !pairMode &&
          selectedProbeSide != null &&
          selectedProbeIndex != null && (
            <div className="shrink-0 border-b border-amber-950/40 bg-gradient-to-r from-amber-950/30 via-slate-950/40 to-slate-950/20 px-2 py-2">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-[9px] uppercase tracking-wide text-amber-200/70">
                    Selected key · {selectedProbeSide}
                  </div>
                  <div className="truncate font-mono text-[12px] text-amber-50">
                    From: {selectedKeyDisplay || "∅"}
                  </div>
                  <div className="text-[10px] text-slate-500">
                    To:{" "}
                    <span className="italic text-slate-600">
                      (pick unmatched on the other side, or set in KeyMap)
                    </span>
                  </div>
                </div>
                {onMapKey && (
                  <button
                    type="button"
                    onClick={() =>
                      emitMapKey(selectedProbeSide, selectedProbeIndex)
                    }
                    className="shrink-0 rounded border border-amber-600/80 bg-amber-500/25 px-3 py-1.5 text-[11px] font-semibold text-amber-50 hover:bg-amber-500/35"
                  >
                    Add to map…
                  </button>
                )}
              </div>
            </div>
          )}

        {sideMode === "probe" && !sideProbe && unmatchedTotal > 0 && (
          <div className="shrink-0 border-b border-amber-950/40 bg-amber-950/15 px-2 py-1.5 text-[10px] text-amber-100/80">
            Select unmatched left + right partner → Map this pair… (or one side
            → Add to map…)
          </div>
        )}

        <div className="min-h-0 flex-1">
          <PreviewTable
            columns={displayColumns}
            rows={displayRows}
            highlightKeys={leftOn}
            columnOrigins={displayOrigins}
            activeRowIndex={displayActive}
            onActiveRowChange={(i) => {
              if (showingExplainSample) return;
              if (matchesOnly && matchedIndices.length > 0) {
                setActiveIndex(matchedIndices[i] ?? matchedIndices[0]!);
              } else {
                setActiveIndex(i);
              }
            }}
            matchedRowIndices={displayMatched}
          />
        </div>
          </>
        )}
      </div>

      <SidePanel
        title="Right"
        mode={sideMode}
        columns={rightCols}
        rows={rightRows}
        visibleIndices={visibleRight}
        keyNames={rightOn}
        loading={sideLoading}
        search={searchRight}
        onSearch={setSearchRight}
        selectedIndex={rightSel}
        linkedIndices={linkedRight}
        listModeLabel={rightListMode}
        statusHint={rightStatus}
        emptyHint={rightEmpty}
        scrollToken={`R:${scrollToken}`}
        selectedKeyLabel={
          rightSel != null ? keyLabelFor("right", rightSel) : null
        }
        onSelect={(index) => {
          if (sideMode === "auto") return;
          setRightSel((prev) => (prev === index ? null : index));
        }}
        mapButtonLabel={pairMode ? "Map this pair…" : "Add to map…"}
        onAddToMap={
          onMapKey && sideMode === "probe" && rightSel != null
            ? pairMode
              ? () => emitMapPair()
              : () => emitMapKey("right", rightSel)
            : undefined
        }
      />
    </div>
  );
}

export const JoinLens = memo(JoinLensImpl);
