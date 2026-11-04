import { useEffect, useMemo, useRef, useState } from "react";
import { cancelRunningQuery, previewWorkspace } from "../../lib/bridge";
import { attrsSummarySql } from "../../lib/mappingCheck";
import type { MappingCheckProjection } from "../../types/mappingCheck";
import type { ConnectionDef, SourceDef, Workspace } from "../../types/pipeline";
import {
  axes,
  parseQualitySummaryDetailed,
  parseQualityTargets,
  qualityProjectionCacheKey,
  QUALITY_SUMMARY,
  QUALITY_TARGETS,
  SIGNALS,
  type QualityCell,
  type QualityDimension,
  type QualityTarget,
} from "../../lib/mappingQuality";
import "./mapping-quality.css";

export type CohortInspectPayload =
  | {
      kind: "matrix";
      cohortCells: QualityCell[];
      samples: string[];
    }
  | {
      kind: "target";
      targetKey: string;
      samples: string[];
    };

type Props = {
  /** Only fetch while the overview tab is visible — shares the host preview lane with canvas. */
  active: boolean;
  workspace: Workspace;
  connections: ConnectionDef[];
  sources: SourceDef[];
  /** Cohort = group/target predicate; samples only illustrate / focus Lens (ADR-0027). */
  onInspect: (payload: CohortInspectPayload) => void;
  onCanvas: () => void;
  /** Surface long overview / handoff work in the app progress bar. */
  onProgress?: (state: { phase: string; percent: number } | null) => void;
  /** ADR-0027: persist a CheckRun after a successful full aggregate. */
  onCheckRun?: (payload: {
    cells: QualityCell[];
    totalPositions: number;
  }) => void;
  /** ADR-0027: mark observed difference as allowed (does not change KeyMap). */
  onAllowDifference?: (groupKey: string, explanation: string) => void;
  allowNote?: string | null;
  deltaNote?: string | null;
  /** ADR-0027 projection; default lab_v1. */
  projection?: MappingCheckProjection;
};
const count = (value: number) => value.toLocaleString("en-US");
const percent = (part: number, total: number) =>
  total ? `${((100 * part) / total).toFixed(1)}%` : "0%";

function isPreviewPreempted(reason: unknown): boolean {
  // ADR-0029 HostRpcError — match kind or legacy message text.
  if (
    reason &&
    typeof reason === "object" &&
    "errorDetail" in reason &&
    (reason as { errorDetail?: { kind?: string } }).errorDetail?.kind ===
      "cancelled"
  ) {
    return true;
  }
  const msg =
    reason instanceof Error
      ? reason.message
      : typeof reason === "object" &&
          reason &&
          "message" in reason &&
          typeof (reason as { message: unknown }).message === "string"
        ? (reason as { message: string }).message
        : String(reason);
  return /preview superseded|preview cancelled|superseded/i.test(msg);
}

type LoadPhase = "matrix" | "targets" | "retry";

/** Prototype projection viewer: aggregates scan the full data; only bounded samples reach the UI. */
export function MappingQualityOverview({
  active,
  workspace,
  connections,
  sources,
  onInspect,
  onCanvas,
  onProgress,
  onCheckRun,
  onAllowDifference,
  allowNote,
  deltaNote,
  projection = { kind: "lab_v1" },
}: Props) {
  const [cells, setCells] = useState<QualityCell[]>([]);
  const [aggregateNote, setAggregateNote] = useState<string | null>(null);
  const [reportedTotalPositions, setReportedTotalPositions] = useState<
    number | null
  >(null);
  const [targets, setTargets] = useState<QualityTarget[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadPhase, setLoadPhase] = useState<LoadPhase>("matrix");
  const [loadAttempt, setLoadAttempt] = useState(1);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [dimension, setDimension] = useState<QualityDimension>("family");
  const [measure, setMeasure] = useState("count");
  const [selection, setSelection] = useState<{
    row: string;
    column: string;
  } | null>(null);
  const [target, setTarget] = useState<QualityTarget | null>(null);
  const [revision, setRevision] = useState(0);
  const [cacheStamp, setCacheStamp] = useState<string | null>(null);
  const request = useRef(0);
  const busyRef = useRef(false);
  busyRef.current = busy;
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  const onCheckRunRef = useRef(onCheckRun);
  onCheckRunRef.current = onCheckRun;
  const [allowText, setAllowText] = useState("");
  const reportProgress = (state: { phase: string; percent: number } | null) => {
    onProgressRef.current?.(state);
  };

  const projectionKey = useMemo(
    () =>
      qualityProjectionCacheKey(workspace, {
        hostQueryId:
          projection.kind === "attrs" ? projection.host_query_id : undefined,
        projection:
          projection.kind === "attrs"
            ? {
                kind: projection.kind,
                host_query_id: projection.host_query_id,
                left_attr: projection.left_attr,
                right_attr: projection.right_attr,
                sample_column: projection.sample_column,
              }
            : { kind: projection.kind },
      }),
    [workspace, projection],
  );
  const stamp = `${projectionKey}#${revision}`;
  const hasFreshCache = cacheStamp === stamp && cells.length > 0;

  // Abort only an in-flight overview fetch when leaving — keep finished cache.
  // Do not clear app progress here on idle leave (Inspect handoff owns the bar).
  useEffect(() => {
    if (active) return;
    if (!busyRef.current) return;
    reportProgress(null);
    void cancelRunningQuery().catch(() => {});
  }, [active]);

  useEffect(() => {
    if (!active) return;
    if (hasFreshCache) {
      // Avoid setState when already idle — parent progress callbacks re-render App.
      setBusy((b) => (b ? false : b));
      setError((e) => (e != null ? null : e));
      reportProgress(null);
      return;
    }
    const token = ++request.current;
    const started = Date.now();
    setBusy(true);
    setError(null);
    setLoadPhase("matrix");
    setLoadAttempt(1);
    setElapsedMs(0);
    reportProgress({
      phase: "Aggregating family/grade matrix (full input)…",
      percent: 12,
    });
    const tick = window.setInterval(() => {
      if (token !== request.current) return;
      setElapsedMs(Date.now() - started);
    }, 250);
    // Preview lane is single-flight: run projections sequentially and retry preempts.
    void (async () => {
      const load = async () => {
        setLoadPhase("matrix");
        reportProgress({
          phase: "Aggregating mapping check matrix (full input)…",
          percent: 18,
        });
        let summaryWs = workspace;
        if (projection.kind === "lab_v1") {
          summaryWs = { ...workspace, focus_query_id: QUALITY_SUMMARY };
        } else {
          const sql = attrsSummarySql(
            projection.host_query_id,
            projection.left_attr,
            projection.right_attr,
            projection.sample_column,
          );
          summaryWs = {
            ...workspace,
            focus_query_id: "__check_summary__",
            queries: [
              ...workspace.queries.filter((q) => q.id !== "__check_summary__"),
              {
                id: "__check_summary__",
                name: "check_summary",
                steps: [{ type: "SqlModel", payload: { raw_sql: sql } }],
              },
            ],
          };
        }
        const summary = await previewWorkspace(
          summaryWs,
          connections,
          sources,
        );
        if (token !== request.current) return null;
        let targets: QualityTarget[] = [];
        if (projection.kind === "lab_v1") {
          setLoadPhase("targets");
          reportProgress({
            phase: "Ranking concentrated targets…",
            percent: 62,
          });
          const hotspots = await previewWorkspace(
            { ...workspace, focus_query_id: QUALITY_TARGETS },
            connections,
            sources,
          );
          if (token !== request.current) return null;
          targets = parseQualityTargets(hotspots);
        } else {
          setLoadPhase("targets");
        }
        const detailed = parseQualitySummaryDetailed(summary);
        return {
          cells: detailed.cells,
          targets,
          totalPositions: detailed.totalPositions,
          incomplete: detailed.incomplete,
          groupCount: detailed.groupCount,
          coveredPositions: detailed.coveredPositions,
        };
      };
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (token !== request.current) return;
        setLoadAttempt(attempt + 1);
        if (attempt > 0) {
          setLoadPhase("retry");
          reportProgress({
            phase: `Retrying after preview preempt (${attempt + 1}/3)…`,
            percent: 8,
          });
        }
        try {
          const parsed = await load();
          if (!parsed || token !== request.current) return;
          setCells(parsed.cells);
          setTargets(parsed.targets);
          setReportedTotalPositions(parsed.totalPositions);
          setAggregateNote(
            parsed.incomplete
              ? `Showing top ${parsed.cells.length} of ${parsed.groupCount} groups ` +
                  `(${parsed.coveredPositions.toLocaleString()}/${parsed.totalPositions.toLocaleString()} positions). ` +
                  `Coarsen attributes or filter the cohort for a full matrix.`
              : null,
          );
          setCacheStamp(stamp);
          setBusy(false);
          setElapsedMs(Date.now() - started);
          reportProgress(null);
          onCheckRunRef.current?.({
            cells: parsed.cells,
            totalPositions: parsed.totalPositions,
          });
          return;
        } catch (reason) {
          lastError = reason;
          if (!isPreviewPreempted(reason)) break;
        }
      }
      if (token !== request.current) return;
      setCells([]);
      setTargets([]);
      setAggregateNote(null);
      setReportedTotalPositions(null);
      setCacheStamp(null);
      setError(String(lastError ?? "Analysis is unavailable"));
      setBusy(false);
      reportProgress(null);
    })();
    return () => {
      request.current++;
      window.clearInterval(tick);
    };
    // hasFreshCache gates the fetch; stamp captures projection+workspace (do not
    // depend on `projection` object identity — unstable fallbacks re-fire forever).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- workspace/projection via stamp
  }, [active, hasFreshCache, stamp, connections, sources]);

  const coveredTotal = cells.reduce((sum, cell) => sum + cell.positions, 0);
  const total = reportedTotalPositions ?? coveredTotal;
  const totalRevenue = cells.reduce((sum, cell) => sum + cell.revenue, 0);
  const signalCounts = useMemo(() => {
    const result = new Map<string, number>();
    for (const cell of cells)
      result.set(cell.signal, (result.get(cell.signal) ?? 0) + cell.positions);
    return result;
  }, [cells]);
  const matrix = useMemo(() => {
    const result = new Map<string, QualityCell[]>();
    const rows = new Set<string>(),
      columns = new Set<string>();
    for (const cell of cells) {
      const [row, column] = axes(cell, dimension);
      rows.add(row);
      columns.add(column);
      const key = JSON.stringify([row, column]);
      const existing = result.get(key) ?? [];
      existing.push(cell);
      result.set(key, existing);
    }
    return {
      cells: result,
      rows: [...rows].sort(),
      columns: [...columns].sort(),
    };
  }, [cells, dimension]);
  const selected = selection
    ? (matrix.cells.get(JSON.stringify([selection.row, selection.column])) ??
      [])
    : cells;
  const selectedCount =
    target?.positions ??
    selected.reduce((sum, cell) => sum + cell.positions, 0);
  const selectedRevenue = selected.reduce((sum, cell) => sum + cell.revenue, 0);
  const sampleKeys =
    target?.samples ??
    [...new Set(selected.flatMap((cell) => cell.samples))].slice(0, 24);
  const rowTotals = new Map(
    matrix.rows.map((row) => [
      row,
      cells
        .filter((cell) => axes(cell, dimension)[0] === row)
        .reduce((sum, cell) => sum + cell.positions, 0),
    ]),
  );
  const different =
    (signalCounts.get("family_difference") ?? 0) +
    (signalCounts.get("grade_difference") ?? 0);

  return (
    <section className="quality-overview">
      <header className="quality-header">
        <div>
          <span className="quality-kicker">
            Mapping observatory / prototype
          </span>
          <h1>Coverage is only the beginning.</h1>
          <p>
            See what your crosswalk preserves, collapses and leaves uncertain.
          </p>
        </div>
        <div className="quality-header-actions">
          <button onClick={onCanvas}>Pipeline canvas ↗</button>
          <button
            disabled={busy}
            onClick={() => setRevision((value) => value + 1)}
          >
            Refresh analysis
          </button>
        </div>
      </header>
      <div className="quality-context">
        Offline Help lab · 100,000 commercial positions → 2,400 catalog products
        · all-data aggregates · synthetic decision annotations
        {deltaNote ? ` · ${deltaNote}` : ""}
        {allowNote ? ` · ${allowNote}` : ""}
      </div>
      {busy ? (
        <div role="status" className="quality-loading">
          <div className="quality-orbit" />
          <h2>Reading the whole mapping</h2>
          <p>
            {loadPhase === "matrix"
              ? "Step 1 of 2 — family/grade matrix over the full 100K input."
              : loadPhase === "targets"
                ? "Step 2 of 2 — concentrated catalog targets."
                : `Waiting for a free DuckDB preview slot (retry ${loadAttempt}/3).`}
            <br />
            Aggregates only — no product cloud is sent to the screen.
          </p>
          <div className="quality-load-bar" aria-hidden="true">
            <div
              className={
                loadPhase === "retry"
                  ? "quality-load-bar-indeterminate"
                  : "quality-load-bar-fill"
              }
              style={
                loadPhase === "retry"
                  ? undefined
                  : {
                      width: loadPhase === "matrix" ? "45%" : "85%",
                    }
              }
            />
          </div>
          <p className="quality-load-meta">
            {(elapsedMs / 1000).toFixed(1)}s elapsed
            {loadAttempt > 1 ? ` · attempt ${loadAttempt}/3` : ""}
          </p>
          <button onClick={onCanvas}>Keep working in the pipeline</button>
        </div>
      ) : error ? (
        <div role="alert" className="quality-loading">
          <h2>Analysis is unavailable</h2>
          <p>{error}</p>
          <button onClick={() => setRevision((value) => value + 1)}>
            Retry
          </button>
        </div>
      ) : (
        <>
          {aggregateNote ? (
            <p className="quality-load-meta" role="status">
              {aggregateNote}
            </p>
          ) : null}
          <div className="quality-stats">
            <div>
              <small>Commercial positions</small>
              <strong>{count(total)}</strong>
              <span>
                {aggregateNote
                  ? "Full input total · matrix is top groups"
                  : "Full input, not a sample"}
              </span>
            </div>
            <div>
              <small>Catalog coverage</small>
              <strong className="quality-mint">
                {percent(total - (signalCounts.get("unmapped") ?? 0), total)}
              </strong>
              <span>Having a partner is not proof of quality</span>
            </div>
            <div>
              <small>Different family or grade</small>
              <strong className="quality-amber">{count(different)}</strong>
              <span>Observed differences to investigate</span>
            </div>
            <div>
              <small>Close alternative</small>
              <strong className="quality-lilac">
                {count(signalCounts.get("close_alternative") ?? 0)}
              </strong>
              <span>Accepted links with a small declared gap</span>
            </div>
          </div>
          <div className="quality-layout">
            <div className="quality-main">
              <div className="quality-matrix-toolbar">
                <div>
                  <span className="quality-kicker">
                    Structure of correspondence
                  </span>
                  <h2>
                    {dimension === "basis"
                      ? "What supports the decisions?"
                      : "Where do the products go?"}
                  </h2>
                </div>
                <div className="quality-controls">
                  <select
                    aria-label="Overview dimension"
                    value={dimension}
                    onChange={(event) => {
                      setDimension(event.target.value as QualityDimension);
                      setSelection(null);
                      setTarget(null);
                    }}
                  >
                    <option value="family">Product families</option>
                    <option value="grade">Family + grade</option>
                    <option value="basis">Decision basis</option>
                  </select>
                  <select
                    aria-label="Overview measure"
                    value={measure}
                    onChange={(event) => setMeasure(event.target.value)}
                  >
                    <option value="count">Position count</option>
                    <option value="share">Share of source group</option>
                    <option value="revenue">Revenue exposure</option>
                  </select>
                </div>
              </div>
              <p className="quality-axis-note">
                Rows:{" "}
                {dimension === "basis"
                  ? "declared decision method"
                  : "commercial classification"}{" "}
                · Columns:{" "}
                {dimension === "basis"
                  ? "observed signal"
                  : "production classification"}
                . Select a cell to inspect its composition.
              </p>
              <div className="quality-matrix-scroll">
                <table className="quality-matrix">
                  <thead>
                    <tr>
                      <th>FROM / TO</th>
                      {matrix.columns.map((column) => (
                        <th key={column}>{column}</th>
                      ))}
                      <th>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {matrix.rows.map((row) => (
                      <tr key={row}>
                        <th>{row}</th>
                        {matrix.columns.map((column) => {
                          const group =
                            matrix.cells.get(JSON.stringify([row, column])) ??
                            [];
                          const positions = group.reduce(
                            (sum, cell) => sum + cell.positions,
                            0,
                          );
                          const revenue = group.reduce(
                            (sum, cell) => sum + cell.revenue,
                            0,
                          );
                          const active =
                            selection?.row === row &&
                            selection.column === column;
                          const dim = selection && !active;
                          const value =
                            measure === "share"
                              ? percent(positions, rowTotals.get(row) ?? 0)
                              : measure === "revenue"
                                ? `$${(revenue / 1e6).toFixed(2)}m`
                                : count(positions);
                          return (
                            <td key={column}>
                              <button
                                disabled={!positions}
                                className={`${active ? "active" : ""} ${dim ? "dimmed" : ""}`}
                                aria-label={`${row} to ${column}: ${count(positions)} positions`}
                                aria-pressed={active}
                                onClick={() => {
                                  setSelection(active ? null : { row, column });
                                  setTarget(null);
                                }}
                                style={{
                                  background: positions
                                    ? `rgba(67, 170, 153, ${0.06 + (0.25 * positions) / (rowTotals.get(row) || 1)})`
                                    : undefined,
                                }}
                              >
                                <strong>{positions ? value : "·"}</strong>
                                <div className="quality-cell-signals">
                                  {group.map((cell, index) => (
                                    <span
                                      key={index}
                                      style={{
                                        width: `${(100 * cell.positions) / positions}%`,
                                        background: SIGNALS[cell.signal]!.color,
                                      }}
                                    />
                                  ))}
                                </div>
                              </button>
                            </td>
                          );
                        })}
                        <td className="quality-total">
                          {count(rowTotals.get(row) ?? 0)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="quality-legend">
                {Object.entries(SIGNALS).map(([key, signal]) => (
                  <span key={key} title={signal.explanation}>
                    <i style={{ background: signal.color }} />
                    {signal.label}
                  </span>
                ))}
              </div>
              <div className="quality-reading">
                <strong>Look beyond the diagonal.</strong>
                <span>
                  Different packaging can legitimately converge. Different
                  grades can disappear into the same target. Neither a dense
                  cell nor a high similarity score establishes correctness.
                </span>
              </div>
              <div className="quality-target-head">
                <div>
                  <span className="quality-kicker">Concentration lens</span>
                  <h2>What gets absorbed into one product?</h2>
                </div>
                <span>Top 12 targets across the full dataset</span>
              </div>
              <div className="quality-target-list">
                {targets.map((item) => (
                  <button
                    key={item.key}
                    className={target?.key === item.key ? "active" : ""}
                    onClick={() => {
                      setTarget(target?.key === item.key ? null : item);
                      setSelection(null);
                    }}
                  >
                    <div>
                      <strong>{item.key}</strong>
                      <small>
                        {item.family} · grade {item.grade}
                      </small>
                    </div>
                    <div className="quality-target-track">
                      <span
                        style={{
                          width: `${(100 * item.positions) / (targets[0]?.positions || 1)}%`,
                        }}
                      />
                    </div>
                    <div>
                      <b>{count(item.positions)}</b>
                      <small
                        className={item.sourceGrades > 1 ? "quality-amber" : ""}
                      >
                        {item.sourceGrades} source grades · {item.packages} pack
                        types
                      </small>
                    </div>
                  </button>
                ))}
              </div>
            </div>
            <aside className="quality-inspector">
              <span className="quality-kicker">Read the pattern</span>
              <h2>
                {target
                  ? target.key
                  : selection
                    ? `${selection.row} → ${selection.column}`
                    : "A connected mapping can still lose meaning."}
              </h2>
              <strong className="quality-selection-total">
                {count(selectedCount)}
              </strong>
              <p>
                positions{" "}
                {target
                  ? "converging on this target"
                  : selection
                    ? "in this cell"
                    : "in the current analysis"}
              </p>
              {target ? (
                <div className="quality-explanation">
                  <p>
                    <b>{target.sourceGrades} distinct source grades</b> feed one
                    target grade ({target.grade}).
                  </p>
                  <p>
                    <b>{target.packages} packaging variants</b> are combined
                    here.
                  </p>
                  <p>
                    Packaging convergence may be intended. Grade convergence
                    needs business interpretation. Concentration alone is not an
                    error.
                  </p>
                </div>
              ) : (
                <>
                  <div className="quality-breakdown">
                    {Object.entries(SIGNALS).map(([key, signal]) => {
                      const amount = selected
                        .filter((cell) => cell.signal === key)
                        .reduce((sum, cell) => sum + cell.positions, 0);
                      return amount ? (
                        <div key={key}>
                          <span>
                            <i style={{ background: signal.color }} />
                            {signal.label}
                          </span>
                          <b>{count(amount)}</b>
                          <div
                            style={{
                              width: percent(amount, selectedCount),
                              background: signal.color,
                            }}
                          />
                          <small>{signal.explanation}</small>
                        </div>
                      ) : null;
                    })}
                  </div>
                  <p className="quality-exposure">
                    Synthetic revenue exposure: <b>${count(selectedRevenue)}</b>{" "}
                    ({percent(selectedRevenue, totalRevenue)} of input). This
                    measures scale, not estimated error.
                  </p>
                </>
              )}
              <button
                className="quality-primary"
                disabled={
                  (!selection && !target) ||
                  (selection ? !selected.length : !target)
                }
                onClick={() => {
                  if (target) {
                    onInspect({
                      kind: "target",
                      targetKey: target.key,
                      samples: sampleKeys,
                    });
                    return;
                  }
                  onInspect({
                    kind: "matrix",
                    cohortCells: selected,
                    samples: sampleKeys,
                  });
                }}
              >
                Inspect cohort
                {sampleKeys.length
                  ? ` · ${sampleKeys.length} sample keys`
                  : ""}{" "}
                in Join Lens ↗
              </button>
              {onAllowDifference && (selection || target) && (
                <div className="quality-allow">
                  <label>
                    Allow observed difference (does not change KeyMap)
                    <textarea
                      value={allowText}
                      onChange={(e) => setAllowText(e.target.value)}
                      rows={2}
                      placeholder="Explain why this difference is acceptable…"
                    />
                  </label>
                  <button
                    type="button"
                    disabled={!allowText.trim()}
                    onClick={() => {
                      const groupKey = target
                        ? `target:${target.key}`
                        : JSON.stringify([
                            selection!.row,
                            selection!.column,
                          ]);
                      onAllowDifference(groupKey, allowText);
                      setAllowText("");
                    }}
                  >
                    Record allow decision
                  </button>
                </div>
              )}
              <p className="quality-sample-note">
                {!selection && !target
                  ? "Select a matrix cell or concentrated target first. Inspect opens the check cohort in Join Lens (predicate, not join ON)."
                  : "Cohort = check predicate (samples illustrate it). Ephemeral query is TEMP — not saved. Accept links only via KeyMap; Allow records a check decision."}
              </p>
              <details>
                <summary>Sample keys</summary>
                <code>{sampleKeys.join(", ")}</code>
              </details>
              <div className="quality-prototype-note">
                <strong>Prototype boundary</strong>
                <p>
                  These projections are configured for this Help lab. Methods
                  and similarity scores are fixture annotations. No LLM has run,
                  no correctness score has been invented, and no mapping is
                  changed by selecting a cell.
                </p>
              </div>
            </aside>
          </div>
        </>
      )}
    </section>
  );
}
