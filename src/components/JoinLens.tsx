import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ColumnMetadata,
  ConnectionDef,
  Workspace,
} from "../types/pipeline";
import type { ExplainJoinRowsResult, JoinRowExplanation } from "../lib/bridge";
import { explainJoinRows } from "../lib/bridge";
import {
  classifyJoinColumnOrigins,
  pinSideRowsToResult,
} from "../lib/joinColumnOrigin";
import { PreviewTable } from "./PreviewTable";

const DEBOUNCE_MS = 90;
const MAX_KEYS = 24;

function fold(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

function cellStr(v: unknown): string {
  if (v === null || v === undefined) return "∅";
  return String(v);
}

type SideCardProps = {
  title: "Left" | "Right";
  columns: ColumnMetadata[];
  rows: unknown[][];
  maxMatches: number;
  /** Key-level match count before pinning to the active result row. */
  keyMatchCount: number;
  pinned: boolean;
  keyNames: string[];
  emptyHint: string;
  /** Scroll + highlight target when explanation changes. */
  scrollToken: string;
  onAnchorEl: (el: HTMLElement | null) => void;
};

function SideCard({
  title,
  columns,
  rows,
  maxMatches,
  keyMatchCount,
  pinned,
  keyNames,
  emptyHint,
  scrollToken,
  onAnchorEl,
}: SideCardProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const keyFold = new Set(keyNames.map(fold));
  const firstKeyName = keyNames[0] ? fold(keyNames[0]) : null;

  // Auto-scroll first key field of first matched row into view; report as beam anchor.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) {
      onAnchorEl(null);
      return;
    }
    const anchor = body.querySelector(
      '[data-side-key-anchor="1"]',
    ) as HTMLElement | null;
    onAnchorEl(anchor);
    if (anchor) {
      anchor.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [scrollToken, rows, columns, keyNames, onAnchorEl]);

  let status: string;
  if (keyMatchCount === 0 && rows.length === 0) {
    status = "no match";
  } else if (pinned && keyMatchCount > rows.length) {
    status =
      rows.length === 1
        ? `1 parent · ${keyMatchCount} share key`
        : `${rows.length} parents · ${keyMatchCount} share key`;
  } else if (keyMatchCount > maxMatches || keyMatchCount > rows.length) {
    status = `${rows.length} of ${keyMatchCount} shown`;
  } else {
    status = `${keyMatchCount} match${keyMatchCount === 1 ? "" : "es"}`;
  }

  return (
    <div className="flex h-full min-h-0 w-[11.5rem] shrink-0 flex-col overflow-hidden rounded-lg border border-teal-900/40 bg-[#071018] shadow-lg shadow-black/40">
      <div className="shrink-0 border-b border-slate-800 px-2 py-1.5">
        <div
          className={`text-[10px] font-semibold uppercase tracking-wide ${
            title === "Left" ? "text-sky-300/90" : "text-amber-300/90"
          }`}
        >
          {title}
        </div>
        <div className="text-[10px] text-slate-500">{status}</div>
      </div>
      <div ref={bodyRef} className="min-h-0 flex-1 overflow-auto p-1.5">
        {rows.length === 0 ? (
          <p className="px-1 py-2 text-[10px] leading-relaxed text-slate-600">
            {emptyHint}
          </p>
        ) : (
          rows.map((row, ri) => (
            <div
              key={ri}
              className="mb-1.5 rounded border border-slate-800/80 bg-slate-950/80 p-1.5 last:mb-0"
            >
              {columns.map((c, ci) => {
                const isKey = keyFold.has(fold(c.name));
                const isAnchor =
                  ri === 0 && firstKeyName !== null && fold(c.name) === firstKeyName;
                return (
                  <div
                    key={c.name}
                    data-side-key={isKey ? "1" : undefined}
                    data-side-key-anchor={isAnchor ? "1" : undefined}
                    className={`flex gap-1 truncate rounded px-0.5 text-[10px] leading-snug ${
                      isKey
                        ? "bg-teal-500/20 ring-1 ring-teal-400/50 text-teal-50"
                        : ""
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
            </div>
          ))
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
  leftOn: string[];
  rightOn: string[];
  connections: ConnectionDef[];
  columns: ColumnMetadata[];
  rows: unknown[][];
};

export function JoinLens({
  enabled,
  workspace,
  hostQueryId,
  joinStepIndex,
  leftOn,
  rightOn,
  connections,
  columns,
  rows,
}: JoinLensProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const activeRowElRef = useRef<HTMLElement | null>(null);
  const scrollParentRef = useRef<HTMLDivElement | null>(null);
  const leftAnchorRef = useRef<HTMLElement | null>(null);
  const rightAnchorRef = useRef<HTMLElement | null>(null);
  const [scrollParent, setScrollParent] = useState<HTMLDivElement | null>(
    null,
  );

  const [activeIndex, setActiveIndex] = useState(0);
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 12 });
  const cacheRef = useRef<Map<string, JoinRowExplanation>>(new Map());
  const [cacheTick, setCacheTick] = useState(0);
  const [leftCols, setLeftCols] = useState<ColumnMetadata[]>([]);
  const [rightCols, setRightCols] = useState<ColumnMetadata[]>([]);
  const [maxMatches, setMaxMatches] = useState(6);
  const [loading, setLoading] = useState(false);
  const [beam, setBeam] = useState<{
    lx: number;
    ly: number;
    cx: number;
    cy: number;
    rx: number;
    ry: number;
  } | null>(null);

  useEffect(() => {
    cacheRef.current.clear();
    setCacheTick((t) => t + 1);
    setActiveIndex(0);
  }, [hostQueryId, joinStepIndex, leftOn.join("\0"), rightOn.join("\0")]);

  // Always explain by preview row offset (not join-key alone). Same key can have
  // many left parents; key-cache made the beam stick to the first key match.
  useEffect(() => {
    if (!enabled || rows.length === 0 || leftOn.length === 0) return;

    let cancelled = false;
    const t = window.setTimeout(() => {
      const start = Math.max(0, visibleRange.start);
      const end = Math.min(rows.length, Math.max(visibleRange.end, start + 1));
      const idxs = new Set<number>();
      idxs.add(Math.min(activeIndex, rows.length - 1));
      for (let i = start; i < end && idxs.size < MAX_KEYS; i++) idxs.add(i);

      const missingOffsets: number[] = [];
      for (const i of idxs) {
        const fp = `off:${i}`;
        if (cacheRef.current.has(fp)) continue;
        missingOffsets.push(i);
        if (missingOffsets.length >= MAX_KEYS) break;
      }
      if (missingOffsets.length === 0) return;

      setLoading(true);
      void explainJoinRows(
        workspace,
        hostQueryId,
        joinStepIndex,
        { previewOffsets: missingOffsets },
        connections,
      )
        .then((res: ExplainJoinRowsResult) => {
          if (cancelled) return;
          setLeftCols(res.left_columns);
          setRightCols(res.right_columns);
          setMaxMatches(res.max_matches);
          missingOffsets.forEach((off, i) => {
            const ex = res.explanations[i];
            if (ex) cacheRef.current.set(`off:${off}`, ex);
          });
          setCacheTick((n) => n + 1);
          setLoading(false);
        })
        .catch(() => {
          if (!cancelled) setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [
    enabled,
    rows,
    columns,
    leftOn,
    visibleRange.start,
    visibleRange.end,
    activeIndex,
    workspace,
    hostQueryId,
    joinStepIndex,
    connections,
  ]);

  const activeExpl = useMemo(() => {
    void cacheTick;
    if (!enabled || rows.length === 0) return null;
    const idx = Math.min(activeIndex, rows.length - 1);
    return cacheRef.current.get(`off:${idx}`) ?? null;
  }, [activeIndex, rows, columns, leftOn, enabled, cacheTick]);

  const columnOrigins = useMemo(() => {
    if (leftCols.length === 0 && rightCols.length === 0) {
      return classifyJoinColumnOrigins(
        columns.map((c) => c.name),
        leftOn,
        leftOn,
        [],
      );
    }
    return classifyJoinColumnOrigins(
      columns.map((c) => c.name),
      leftOn,
      leftCols.map((c) => c.name),
      rightCols.map((c) => c.name),
    );
  }, [columns, leftOn, leftCols, rightCols]);

  // Key-only lookup returns every left/right row sharing the join key (e.g. same
  // region, different qty). Pin docks to the active result row via side columns.
  const leftPinned = useMemo(() => {
    const idx = Math.min(activeIndex, Math.max(0, rows.length - 1));
    const resultRow = rows[idx];
    if (!activeExpl || !resultRow) {
      return { rows: [] as unknown[][], pinned: false };
    }
    return pinSideRowsToResult({
      side: "left",
      sideRows: activeExpl.left_rows,
      sideColumns: leftCols,
      resultRow,
      resultColumns: columns,
      origins: columnOrigins,
      leftOn,
      rightOn,
    });
  }, [
    activeExpl,
    activeIndex,
    rows,
    leftCols,
    columns,
    columnOrigins,
    leftOn,
    rightOn,
  ]);

  const rightPinned = useMemo(() => {
    const idx = Math.min(activeIndex, Math.max(0, rows.length - 1));
    const resultRow = rows[idx];
    if (!activeExpl || !resultRow) {
      return { rows: [] as unknown[][], pinned: false };
    }
    return pinSideRowsToResult({
      side: "right",
      sideRows: activeExpl.right_rows,
      sideColumns: rightCols,
      resultRow,
      resultColumns: columns,
      origins: columnOrigins,
      leftOn,
      rightOn,
    });
  }, [
    activeExpl,
    activeIndex,
    rows,
    rightCols,
    columns,
    columnOrigins,
    leftOn,
    rightOn,
  ]);

  const scrollToken = useMemo(
    () =>
      `${activeIndex}|${activeExpl?.fingerprint ?? ""}|${leftPinned.rows.length}|${rightPinned.rows.length}|${leftPinned.pinned}|${rightPinned.pinned}`,
    [activeIndex, activeExpl, leftPinned, rightPinned],
  );

  const updateBeam = useCallback(() => {
    const root = rootRef.current;
    const rowEl = activeRowElRef.current;
    const clip = scrollParentRef.current;
    const leftA = leftAnchorRef.current;
    const rightA = rightAnchorRef.current;
    if (!root || !rowEl || !clip) {
      setBeam(null);
      return;
    }
    const rr = root.getBoundingClientRect();
    const ar = rowEl.getBoundingClientRect();
    const cr = clip.getBoundingClientRect();

    if (ar.bottom < cr.top + 4 || ar.top > cr.bottom - 4) {
      setBeam(null);
      return;
    }

    // Center hub = join key cell (left_on spelling). Do NOT clamp X to the clip
    // edge — that made the beam look attached to whatever column was at the
    // viewport border after horizontal scroll.
    const keyCell = rowEl.querySelector(
      '[data-join-origin="key"]',
    ) as HTMLElement | null;
    let cx: number;
    let cy: number;
    if (keyCell) {
      const kr = keyCell.getBoundingClientRect();
      cx = kr.left + kr.width / 2 - rr.left;
      cy =
        Math.min(Math.max(kr.top + kr.height / 2, cr.top + 4), cr.bottom - 4) -
        rr.top;
    } else {
      // Keys dropped from select: hub = mid of the active result row.
      const x0 = Math.max(ar.left, cr.left);
      const x1 = Math.min(ar.right, cr.right);
      cx = (x0 + x1) / 2 - rr.left;
      cy =
        Math.min(Math.max(ar.top + ar.height / 2, cr.top + 4), cr.bottom - 4) -
        rr.top;
    }

    // Side hubs = first join-key field on each dock (paired left_on / right_on).
    // Allow one-sided beam when the other side has no match.
    if (!leftA && !rightA) {
      setBeam(null);
      return;
    }
    const la = leftA?.getBoundingClientRect();
    const ra = rightA?.getBoundingClientRect();
    setBeam({
      lx: la ? la.right - rr.left : cx - 24,
      ly: la ? la.top + la.height / 2 - rr.top : cy,
      cx,
      cy,
      rx: ra ? ra.left - rr.left : cx + 24,
      ry: ra ? ra.top + ra.height / 2 - rr.top : cy,
    });
  }, []);

  const onLeftAnchor = useCallback(
    (el: HTMLElement | null) => {
      leftAnchorRef.current = el;
      requestAnimationFrame(() => updateBeam());
    },
    [updateBeam],
  );
  const onRightAnchor = useCallback(
    (el: HTMLElement | null) => {
      rightAnchorRef.current = el;
      requestAnimationFrame(() => updateBeam());
    },
    [updateBeam],
  );

  // Bring join-key column into the center viewport when the active row changes.
  useEffect(() => {
    const rowEl = activeRowElRef.current;
    if (!rowEl) return;
    const keyCell = rowEl.querySelector(
      '[data-join-origin="key"]',
    ) as HTMLElement | null;
    keyCell?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [scrollToken, activeIndex]);

  useEffect(() => {
    updateBeam();
    const root = rootRef.current;
    const clip = scrollParentRef.current;
    if (!root) return;
    const ro = new ResizeObserver(() => updateBeam());
    ro.observe(root);
    if (clip) ro.observe(clip);
    const onScroll = () => updateBeam();
    clip?.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("scroll", onScroll, true);
    return () => {
      ro.disconnect();
      clip?.removeEventListener("scroll", onScroll);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [updateBeam, activeExpl, activeIndex, enabled, scrollParent, scrollToken]);

  if (!enabled) {
    return (
      <PreviewTable columns={columns} rows={rows} highlightKeys={leftOn} />
    );
  }

  return (
    <div ref={rootRef} className="relative flex h-full min-h-0 gap-2 p-1">
      <SideCard
        title="Left"
        columns={leftCols}
        rows={leftPinned.rows}
        maxMatches={maxMatches}
        keyMatchCount={activeExpl?.left_match_count ?? 0}
        pinned={leftPinned.pinned}
        keyNames={leftOn}
        emptyHint={
          loading
            ? "resolving…"
            : "No left row for this join key (or still loading)."
        }
        scrollToken={`L:${scrollToken}`}
        onAnchorEl={onLeftAnchor}
      />

      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border border-slate-800/80">
        <div className="pointer-events-none absolute left-2 top-1 z-20 flex flex-wrap items-center gap-1.5 rounded bg-[#071018]/90 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide">
          <span className="text-teal-300/90">
            Join Lens{loading ? " · …" : ""}
          </span>
          <span className="text-slate-600">·</span>
          <span className="text-teal-300/80">join</span>
          <span className="text-sky-300/80">left</span>
          <span className="text-amber-300/80">right</span>
          <span className="text-violet-300/80">calc</span>
        </div>
        <PreviewTable
          columns={columns}
          rows={rows}
          highlightKeys={leftOn}
          columnOrigins={columnOrigins}
          activeRowIndex={activeIndex}
          onActiveRowChange={setActiveIndex}
          onVisibleRangeChange={setVisibleRange}
          onActiveRowElement={(el) => {
            activeRowElRef.current = el;
            updateBeam();
          }}
          onScrollParentRef={(el) => {
            scrollParentRef.current = el;
            setScrollParent(el);
            updateBeam();
          }}
        />
      </div>

      <SideCard
        title="Right"
        columns={rightCols}
        rows={rightPinned.rows}
        maxMatches={maxMatches}
        keyMatchCount={activeExpl?.right_match_count ?? 0}
        pinned={rightPinned.pinned}
        keyNames={rightOn}
        emptyHint={
          loading
            ? "resolving…"
            : "No right row for this join key (or still loading)."
        }
        scrollToken={`R:${scrollToken}`}
        onAnchorEl={onRightAnchor}
      />

      {beam && (
        <svg
          className="pointer-events-none absolute inset-0 z-10 h-full w-full overflow-visible"
          aria-hidden
        >
          <defs>
            <linearGradient id="join-lens-beam" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="rgb(45 212 191)" stopOpacity="0.7" />
              <stop offset="50%" stopColor="rgb(94 234 212)" stopOpacity="0.4" />
              <stop offset="100%" stopColor="rgb(45 212 191)" stopOpacity="0.7" />
            </linearGradient>
          </defs>
          <path
            d={`M ${beam.lx} ${beam.ly} C ${(beam.lx + beam.cx) / 2} ${beam.ly}, ${(beam.lx + beam.cx) / 2} ${beam.cy}, ${beam.cx} ${beam.cy}`}
            fill="none"
            stroke="url(#join-lens-beam)"
            strokeWidth="1.75"
            strokeDasharray="5 4"
          />
          <path
            d={`M ${beam.cx} ${beam.cy} C ${(beam.cx + beam.rx) / 2} ${beam.cy}, ${(beam.cx + beam.rx) / 2} ${beam.ry}, ${beam.rx} ${beam.ry}`}
            fill="none"
            stroke="url(#join-lens-beam)"
            strokeWidth="1.75"
            strokeDasharray="5 4"
          />
          <circle cx={beam.lx} cy={beam.ly} r="2.5" fill="rgb(56 189 248)" opacity="0.95" />
          <circle cx={beam.cx} cy={beam.cy} r="3" fill="rgb(94 234 212)" opacity="0.95" />
          <circle cx={beam.rx} cy={beam.ry} r="2.5" fill="rgb(251 191 36)" opacity="0.95" />
        </svg>
      )}
    </div>
  );
}
