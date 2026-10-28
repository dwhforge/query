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
} from "../lib/joinColumnOrigin";
import { PreviewTable } from "./PreviewTable";

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

type SideMode = "linked" | "probe";

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
}: SidePanelProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const keyFold = new Set(keyNames.map(fold));
  const linked = useMemo(() => new Set(linkedIndices), [linkedIndices]);

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
    <div className="flex h-full min-h-0 w-[13.5rem] shrink-0 flex-col overflow-hidden rounded-lg border border-teal-900/40 bg-[#071018] shadow-lg shadow-black/40">
      <div className="shrink-0 space-y-1.5 border-b border-slate-800 px-2 py-1.5">
        <div
          className={`text-[10px] font-semibold uppercase tracking-wide ${
            title === "Left" ? "text-sky-300/90" : "text-amber-300/90"
          }`}
        >
          {title} · {mode === "linked" ? "parents" : "probe"}
        </div>
        {mode === "probe" && (
          <input
            type="search"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Filter unmatched sample…"
            className="w-full rounded border border-slate-700 bg-slate-950 px-1.5 py-1 text-[10px] text-slate-200 outline-none placeholder:text-slate-600 focus:ring-1 focus:ring-teal-700"
          />
        )}
        <div className="text-[10px] leading-snug text-slate-500">
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
                    ? "border-teal-500/70 bg-teal-500/15"
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
    </div>
  );
}

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
  /** Apply near-miss → insert NormalizeKey before Join. */
  onApplyNearMiss?: (hyp: NearMissHypothesis) => void;
  /** Open KeyMap editor with From values from selected side key. */
  onMapKey?: (side: JoinKeySide, fromValues: string[]) => void;
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

  // Full-input explain + blame for a single-side selection (not pair).
  useEffect(() => {
    if (!enabled || !sideProbe || pairMode) {
      setKeyExplain(null);
      setKeyBlame(null);
      setKeyExplainError(null);
      setKeyExplainLoading(false);
      return;
    }
    let side: JoinKeySide;
    let keys: unknown[];
    if (leftSel != null) {
      const row = leftRows[leftSel];
      if (!row) return;
      side = "left";
      keys = keyValuesFromRow(row, leftCols, leftOn);
    } else {
      const row = rightRows[rightSel!];
      if (!row) return;
      side = "right";
      keys = keyValuesFromRow(row, rightCols, rightOn);
    }
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
        if (ex.result_match_count === 0) {
          setMatchesOnly(true);
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
          setMatchesOnly(true);
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
    workspace,
    hostQueryId,
    joinStepIndex,
    connections,
  ]);

  /** Result rows matching current side selection (one side or both). */
  const matchedIndices = useMemo(() => {
    if (!sideProbe) return [] as number[];

    if (pairMode) {
      const lRow = leftRows[leftSel!];
      const rRow = rightRows[rightSel!];
      if (!lRow || !rRow) return [];
      const lKeys = keyValuesFromRow(lRow, leftCols, leftOn);
      const rKeys = keyValuesFromRow(rRow, rightCols, rightOn);
      if (!keysEqual(lKeys, rKeys)) return [];
      return findResultMatches(rows, columns, leftOn, lKeys);
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
    if (sideMode === "probe") {
      return probeLeftRows
        .map((_, i) => i)
        .filter((i) => rowMatchesSearch(probeLeftRows[i]!, searchLeft));
    }
    return linkedLeft;
  }, [sideMode, probeLeftRows, searchLeft, linkedLeft]);

  const visibleRight = useMemo(() => {
    if (sideMode === "probe") {
      return probeRightRows
        .map((_, i) => i)
        .filter((i) => rowMatchesSearch(probeRightRows[i]!, searchRight));
    }
    return linkedRight;
  }, [sideMode, probeRightRows, searchRight, linkedRight]);

  /** Prefer full-input explain sample when showing matches for a key. */
  const showingExplainSample =
    !!keyExplain &&
    !pairMode &&
    sideProbe &&
    (matchesOnly || keyExplain.result_match_count === 0);

  const displayColumns = useMemo(() => {
    if (showingExplainSample && keyExplain) {
      return keyExplain.result_columns.map((c) => ({
        name: c.name,
        type: c.type,
      })) as ColumnMetadata[];
    }
    return columns;
  }, [showingExplainSample, keyExplain, columns]);

  const displayRows = useMemo(() => {
    if (showingExplainSample && keyExplain) {
      return keyExplain.result_rows;
    }
    if (!matchesOnly || !sideProbe || matchedIndices.length === 0) return rows;
    return matchedIndices.map((i) => rows[i]!);
  }, [
    showingExplainSample,
    keyExplain,
    matchesOnly,
    sideProbe,
    matchedIndices,
    rows,
  ]);

  const displayMatched = useMemo(() => {
    if (!sideProbe) return undefined;
    if (showingExplainSample && keyExplain) {
      return keyExplain.result_rows.map((_, i) => i);
    }
    if (matchesOnly && matchedIndices.length > 0) {
      return displayRows.map((_, i) => i);
    }
    return matchedIndices;
  }, [
    sideProbe,
    showingExplainSample,
    keyExplain,
    matchesOnly,
    matchedIndices,
    displayRows,
  ]);

  const displayActive = useMemo(() => {
    if (showingExplainSample) return 0;
    if (matchesOnly && matchedIndices.length > 0) {
      const pos = matchedIndices.indexOf(activeIndex);
      return pos >= 0 ? pos : 0;
    }
    return activeIndex;
  }, [showingExplainSample, matchesOnly, matchedIndices, activeIndex]);

  const displayOrigins = useMemo(() => {
    if (showingExplainSample && keyExplain) {
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
    keyExplain,
    leftOn,
    parentLeftCols,
    parentRightCols,
    columnOrigins,
  ]);

  const scrollToken = `${sideMode}|${activeIndex}|${linkedLeft.join(",")}|${linkedRight.join(",")}`;

  const leftListMode =
    sideMode === "linked"
      ? linkedListLabel(leftPin)
      : probeListLabel("left", unmatchedLeft, visibleLeft.length);
  const rightListMode =
    sideMode === "linked"
      ? linkedListLabel(rightPin)
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
      return matchedIndices.length > 0
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
    leftSel,
    matchedIndices,
    keyExplain,
    keyExplainLoading,
  ]);

  const rightStatus = useMemo(() => {
    if (!sideProbe) return null;
    if (pairMode) {
      return matchedIndices.length > 0
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
    rightSel,
    leftSel,
    matchedIndices,
    keyExplain,
    keyExplainLoading,
  ]);

  const switchMode = (next: SideMode) => {
    if (next === sideMode) return;
    setSideMode(next);
    setLeftSel(null);
    setRightSel(null);
    setMatchesOnly(false);
    setSearchLeft("");
    setSearchRight("");
    setKeyExplain(null);
    setKeyBlame(null);
    setKeyExplainError(null);
  };

  if (!enabled) {
    return (
      <PreviewTable columns={columns} rows={rows} highlightKeys={leftOn} />
    );
  }

  const sideLoading =
    sideMode === "linked" ? sidesLoading : joinDiagLoading && !joinDiag;

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
        onSelect={(index) => {
          setLeftSel((prev) => (prev === index ? null : index));
        }}
      />

      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-slate-800/80">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-800/80 bg-[#071018]/95 px-2 py-1">
          <span className="text-[9px] font-semibold uppercase tracking-wide text-teal-300/90">
            Join Lens
          </span>
          <div className="flex overflow-hidden rounded border border-slate-700">
            <button
              type="button"
              onClick={() => switchMode("linked")}
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
              className={`px-1.5 py-0.5 text-[9px] ${
                sideMode === "probe"
                  ? "bg-teal-500/20 text-teal-200"
                  : "text-slate-500 hover:text-slate-300"
              }`}
            >
              Probe
            </button>
          </div>
          <span className="text-[9px] text-slate-600">·</span>
          <span className="text-[9px] text-teal-300/80">join</span>
          <span className="text-[9px] text-sky-300/80">left</span>
          <span className="text-[9px] text-amber-300/80">right</span>
          {sideProbe ? (
            <>
              <span className="text-[9px] text-slate-600">·</span>
              <span
                className={`text-[10px] ${
                  keyExplain
                    ? keyExplain.result_match_count > 0
                      ? "text-teal-300/90"
                      : "text-amber-400/90"
                    : matchedIndices.length > 0
                      ? "text-teal-300/90"
                      : "text-amber-400/90"
                }`}
              >
                {keyExplainLoading
                  ? "Explaining key (full join)…"
                  : pairMode
                    ? matchedIndices.length > 0
                      ? `Pair in preview (${matchedIndices.length})`
                      : "This left+right pair is not in the preview"
                    : keyExplain
                      ? keyExplain.result_match_count > 0
                        ? `${keyExplain.result_match_count} join result row(s) · ×${keyExplain.expansion.toFixed(2)}`
                        : "0 join result rows (full input)"
                      : matchedIndices.length > 0
                        ? `${matchedIndices.length} in preview`
                        : "Not in preview"}
              </span>
              {(keyExplain
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
            </>
          ) : (
            <span className="text-[10px] text-slate-600">
              {sideMode === "linked"
                ? "Parents of the center row · click a parent to explain the key"
                : "Unmatched sample · click left/right to explain / blame"}
            </span>
          )}
        </div>
        {(nearMissLoading ||
          (nearMiss && nearMiss.hypotheses.length > 0)) && (
          <div className="shrink-0 space-y-1 border-b border-teal-950/60 bg-teal-950/20 px-2 py-1">
            <div className="text-[9px] font-semibold uppercase tracking-wide text-teal-400/80">
              Near-miss
              {nearMiss && nearMiss.hypotheses.length > 0
                ? ` (+${nearMiss.hypotheses.reduce((s, h) => s + h.delta_matches, 0)} keys)`
                : nearMissLoading
                  ? "…"
                  : ""}
            </div>
            {(nearMiss?.hypotheses ?? []).slice(0, 3).map((h, i) => (
              <div
                key={i}
                className="flex flex-wrap items-center gap-1.5 text-[10px] text-slate-300"
              >
                <span className="font-mono text-teal-200/90">
                  {h.ops.join("→")}
                </span>
                <span className="text-slate-500">on {h.apply_on}</span>
                <span className="text-slate-500">
                  Δ+{h.delta_matches}
                </span>
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
          </div>
        )}
        {(keyBlame || keyExplainError) && (
          <div
            className={`shrink-0 border-b px-2 py-1 text-[10px] leading-snug ${
              keyExplainError
                ? "border-amber-900/50 bg-amber-950/40 text-amber-200/90"
                : "border-slate-800 bg-slate-950/80 text-slate-300"
            }`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span>
                {keyExplainError ?? (keyBlame ? blameLabel(keyBlame) : null)}
              </span>
              {onMapKey &&
                keyBlame?.verdict === "no_partner" &&
                sideProbe &&
                !pairMode && (
                  <button
                    type="button"
                    onClick={() => {
                      const side: JoinKeySide =
                        leftSel != null ? "left" : "right";
                      const row =
                        leftSel != null
                          ? leftRows[leftSel!]
                          : rightRows[rightSel!];
                      const cols = leftSel != null ? leftCols : rightCols;
                      const keys = leftSel != null ? leftOn : rightOn;
                      if (!row) return;
                      const vals = keyValuesFromRow(row, cols, keys).map(
                        (v) => cellStr(v),
                      );
                      onMapKey(side, vals);
                    }}
                    className="rounded border border-amber-800/60 px-1.5 py-0.5 text-[9px] text-amber-100 hover:bg-amber-500/10"
                  >
                    Add to map…
                  </button>
                )}
            </div>
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
        onSelect={(index) => {
          setRightSel((prev) => (prev === index ? null : index));
        }}
      />
    </div>
  );
}

export const JoinLens = memo(JoinLensImpl);
