import { useEffect, useMemo, useRef, useState } from "react";
import { describeWorkspace, projectRefContext } from "../lib/bridge";
import type { Project } from "../types/pipeline";
import {
  assertLiveSchemaMatchesPlan,
  buildMappingCreatePlan,
  excludedByLastFields,
  listLocalQueries,
  makeSchemaEvidence,
  restoresForPair,
  selectableOutputColumns,
  workspaceQueryDefsFingerprint,
  type MappingCreateDraft,
  type MappingCreatePlan,
  type SchemaEvidence,
} from "../app/mappingCreate";

type Step = "keys" | "fields" | "review";

type Props = {
  open: boolean;
  project: Project;
  onCancel: () => void;
  onConfirm: (plan: MappingCreatePlan) => void;
};

function emptyDraft(locals: { id: string }[]): MappingCreateDraft {
  return {
    name: "",
    sourceQueryId: locals[0]?.id ?? "",
    sourceColumns: [],
    targetQueryId: locals[1]?.id ?? locals[0]?.id ?? "",
    targetColumn: "",
    targetColumns: [],
    restoreColumnsByQuery: {},
  };
}

function draftLooksFilled(d: MappingCreateDraft): boolean {
  return Boolean(
    d.name.trim() ||
      d.sourceColumns.length ||
      d.targetColumn.trim() ||
      (d.targetColumns?.length ?? 0) > 0 ||
      Object.values(d.restoreColumnsByQuery).some((c) => c?.length),
  );
}

export function MappingCreateWizard({
  open,
  project,
  onCancel,
  onConfirm,
}: Props) {
  const locals = useMemo(
    () => listLocalQueries(project.workspace),
    [project.workspace],
  );
  const wsFp = useMemo(
    () => workspaceQueryDefsFingerprint(project.workspace),
    [project.workspace],
  );

  const [step, setStep] = useState<Step>("keys");
  const [draft, setDraft] = useState<MappingCreateDraft>(() =>
    emptyDraft(locals),
  );
  const [schemas, setSchemas] = useState<SchemaEvidence[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [plan, setPlan] = useState<MappingCreatePlan | null>(null);
  /** In-app discard confirm — avoids blocking `window.confirm` (Playwright hangs ~30s). */
  const [discardOpen, setDiscardOpen] = useState(false);

  /** Bumped to drop in-flight describe results. */
  const describeGen = useRef(0);
  const sessionWsFp = useRef<string | null>(null);
  const wasOpen = useRef(false);

  // New session only when the dialog opens (not on every workspace change).
  useEffect(() => {
    if (open && !wasOpen.current) {
      describeGen.current += 1;
      setStep("keys");
      setError(null);
      setNotice(null);
      setPlan(null);
      setSchemas([]);
      setBusy(false);
      setDiscardOpen(false);
      setDraft(emptyDraft(listLocalQueries(project.workspace)));
      sessionWsFp.current = workspaceQueryDefsFingerprint(project.workspace);
    }
    if (!open && wasOpen.current) {
      describeGen.current += 1;
      setBusy(false);
      setDiscardOpen(false);
    }
    wasOpen.current = open;
  }, [open, project.workspace]);

  // Workspace defs changed while open: keep draft, invalidate evidence/plan.
  useEffect(() => {
    if (!open) return;
    if (sessionWsFp.current == null) {
      sessionWsFp.current = wsFp;
      return;
    }
    if (sessionWsFp.current === wsFp) return;
    sessionWsFp.current = wsFp;
    describeGen.current += 1;
    setSchemas([]);
    setPlan(null);
    setBusy(false);
    setNotice(
      "Workspace queries changed — draft kept; re-describe schemas before continuing.",
    );
    setError(null);
    setStep("keys");
  }, [open, wsFp]);

  if (!open) return null;

  function invalidateDescribe() {
    describeGen.current += 1;
    setSchemas([]);
    setPlan(null);
  }

  function forceClose() {
    describeGen.current += 1;
    setBusy(false);
    setDiscardOpen(false);
    onCancel();
  }

  function requestClose() {
    if (draftLooksFilled(draft)) {
      setDiscardOpen(true);
      return;
    }
    forceClose();
  }

  async function describePair(
    sourceId: string,
    targetId: string,
    gen: number,
  ): Promise<SchemaEvidence[] | null> {
    const pref = projectRefContext(project);
    const ids = [...new Set([sourceId, targetId].filter(Boolean))];
    const out: SchemaEvidence[] = [];
    for (const id of ids) {
      if (describeGen.current !== gen) return null;
      const q = project.workspace.queries.find((x) => x.id === id);
      if (!q) throw new Error(`Query “${id}” missing.`);
      const ws = {
        ...project.workspace,
        focus_query_id: id,
      };
      const full = await describeWorkspace(
        ws,
        project.connections,
        project.sources,
        pref,
      );
      if (describeGen.current !== gen) return null;
      const outputColumns = full.columns.map((c) => c.name);
      let upstreamColumns: string[] | null = null;
      const last = q.steps[q.steps.length - 1];
      if (last?.type === "SelectColumns" && q.steps.length >= 2) {
        const truncated = {
          ...q,
          steps: q.steps.slice(0, -1),
        };
        const upWs = {
          ...project.workspace,
          focus_query_id: id,
          queries: project.workspace.queries.map((x) =>
            x.id === id ? truncated : x,
          ),
        };
        const up = await describeWorkspace(
          upWs,
          project.connections,
          project.sources,
          pref,
        );
        if (describeGen.current !== gen) return null;
        upstreamColumns = up.columns.map((c) => c.name);
      }
      out.push(
        makeSchemaEvidence({
          workspace: project.workspace,
          queryId: id,
          outputColumns,
          upstreamColumns,
        }),
      );
    }
    if (describeGen.current !== gen) return null;
    return out;
  }

  async function goFields() {
    setError(null);
    setNotice(null);
    if (!draft.name.trim()) {
      setError("Name the mapping.");
      return;
    }
    if (!draft.sourceQueryId || !draft.targetQueryId) {
      setError("Pick source and target queries.");
      return;
    }
    const gen = ++describeGen.current;
    const sourceId = draft.sourceQueryId;
    const targetId = draft.targetQueryId;
    setBusy(true);
    try {
      const ev = await describePair(sourceId, targetId, gen);
      if (ev == null || describeGen.current !== gen) return;
      if (
        draft.sourceQueryId !== sourceId ||
        draft.targetQueryId !== targetId
      ) {
        return;
      }
      setSchemas(ev);
      setStep("fields");
    } catch (e) {
      if (describeGen.current !== gen) return;
      setError(typeof e === "string" ? e : String(e));
    } finally {
      if (describeGen.current === gen) setBusy(false);
    }
  }

  function goReview() {
    setError(null);
    const targets =
      draft.targetColumns?.length
        ? draft.targetColumns
        : draft.targetColumn.trim()
          ? [draft.targetColumn]
          : [];
    if (!draft.sourceColumns.length || !targets.length) {
      setError("Pick source key(s) and at least one target column.");
      return;
    }
    const built = buildMappingCreatePlan({
      project,
      draft: {
        ...draft,
        targetColumns: targets,
        targetColumn: targets[0] ?? "",
      },
      schemas,
    });
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setPlan(built.plan);
    setStep("review");
  }

  async function confirmCreate(current: MappingCreatePlan) {
    setError(null);
    setNotice(null);
    const gen = ++describeGen.current;
    const sourceId = current.authoringContext.source_query_id;
    const targetId = current.authoringContext.target_query_id;
    setBusy(true);
    try {
      const live = await describePair(sourceId, targetId, gen);
      if (live == null || describeGen.current !== gen) return;
      const match = assertLiveSchemaMatchesPlan(current, live);
      if (!match.ok) {
        setError(match.error);
        setPlan(null);
        setSchemas([]);
        setStep("keys");
        setNotice("Schema could not be re-confirmed — draft kept.");
        return;
      }
      // Definitions must still match what the live describe just bound.
      for (const ev of live) {
        for (const [id, fp] of Object.entries(ev.basisQueryDefs)) {
          if (current.expectedQueryDefs[id] !== fp) {
            setError(
              `Query definitions changed during schema check — refresh and confirm again.`,
            );
            setPlan(null);
            setStep("keys");
            return;
          }
        }
      }
      onConfirm(current);
    } catch (e) {
      if (describeGen.current !== gen) return;
      setError(typeof e === "string" ? e : String(e));
    } finally {
      if (describeGen.current === gen) setBusy(false);
    }
  }

  const sourceEv = schemas.find((s) => s.queryId === draft.sourceQueryId);
  const targetEv = schemas.find((s) => s.queryId === draft.targetQueryId);
  const sourceQ = project.workspace.queries.find(
    (q) => q.id === draft.sourceQueryId,
  );
  const targetQ = project.workspace.queries.find(
    (q) => q.id === draft.targetQueryId,
  );
  const excludedSource =
    sourceQ && sourceEv?.upstreamColumns
      ? excludedByLastFields(sourceQ, sourceEv.upstreamColumns)
      : [];
  const excludedTarget =
    targetQ &&
    targetEv?.upstreamColumns &&
    draft.targetQueryId !== draft.sourceQueryId
      ? excludedByLastFields(targetQ, targetEv.upstreamColumns)
      : targetQ &&
          targetEv?.upstreamColumns &&
          draft.targetQueryId === draft.sourceQueryId
        ? excludedSource
        : [];

  function toggleRestore(queryId: string, col: string) {
    setDraft((d) => {
      const cur = d.restoreColumnsByQuery[queryId] ?? [];
      const has = cur.some((c) => c.toLowerCase() === col.toLowerCase());
      const next = has
        ? cur.filter((c) => c.toLowerCase() !== col.toLowerCase())
        : [...cur, col];
      return {
        ...d,
        restoreColumnsByQuery: {
          ...d.restoreColumnsByQuery,
          [queryId]: next,
        },
      };
    });
  }

  function toggleSourceCol(col: string) {
    setDraft((d) => {
      const has = d.sourceColumns.some(
        (c) => c.toLowerCase() === col.toLowerCase(),
      );
      return {
        ...d,
        sourceColumns: has
          ? d.sourceColumns.filter(
              (c) => c.toLowerCase() !== col.toLowerCase(),
            )
          : [...d.sourceColumns, col],
      };
    });
  }

  function renderExcluded(
    title: string,
    queryId: string,
    cols: string[],
  ) {
    if (!cols.length) return null;
    return (
      <div>
        <p className="mb-1 text-[11px] uppercase text-slate-500">{title}</p>
        <ul className="space-y-1">
          {cols.map((c) => {
            const on = (
              draft.restoreColumnsByQuery[queryId] ?? []
            ).some((x) => x.toLowerCase() === c.toLowerCase());
            return (
              <li
                key={`${queryId}:${c}`}
                className="flex items-center justify-between gap-2"
              >
                <span className="font-mono text-slate-300">{c}</span>
                <button
                  type="button"
                  className="rounded border border-amber-800/60 px-2 py-0.5 text-[11px] text-amber-100 hover:bg-amber-950/40"
                  onClick={() => toggleRestore(queryId, c)}
                >
                  {on ? "Remove" : "Include"}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      {discardOpen && (
        <div
          className="absolute inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
          data-testid="mapping-create-discard"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="mapping-create-discard-title"
        >
          <div className="w-full max-w-sm rounded-lg border border-slate-600 bg-slate-900 px-4 py-3 shadow-2xl">
            <p
              id="mapping-create-discard-title"
              className="text-sm text-slate-100"
            >
              Discard this mapping draft?
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                className="rounded border border-slate-600 px-3 py-1.5 text-sm text-slate-200 hover:border-slate-400"
                onClick={() => setDiscardOpen(false)}
              >
                Keep editing
              </button>
              <button
                type="button"
                className="rounded bg-teal-600 px-3 py-1.5 text-sm font-medium text-slate-950 hover:bg-teal-500"
                onClick={forceClose}
              >
                Discard
              </button>
            </div>
          </div>
        </div>
      )}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="mapping-create-title"
        data-testid="mapping-create-wizard"
        className="flex max-h-[90vh] w-full max-w-xl flex-col rounded-lg border border-slate-700 bg-slate-950 shadow-xl"
      >
        <header className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
          <h2
            id="mapping-create-title"
            className="text-sm font-semibold text-slate-100"
          >
            Create from data
          </h2>
          <button
            type="button"
            className="text-slate-500 hover:text-slate-300"
            data-testid="mapping-create-close"
            aria-label="Close"
            onClick={requestClose}
          >
            ✕
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-[13px] text-slate-300">
          {notice && (
            <p className="mb-3 rounded border border-amber-900/50 bg-amber-950/30 px-2 py-1.5 text-amber-100">
              {notice}
            </p>
          )}
          {error && (
            <p className="mb-3 rounded border border-rose-900/50 bg-rose-950/40 px-2 py-1.5 text-rose-200">
              {error}
            </p>
          )}
          {step === "keys" && (
            <div className="space-y-3">
              <label className="block space-y-1">
                <span className="text-[11px] uppercase text-slate-500">
                  Name
                </span>
                <input
                  className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-slate-100 disabled:opacity-50"
                  value={draft.name}
                  disabled={busy}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, name: e.target.value }))
                  }
                  placeholder="Supplier products → catalog"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-[11px] uppercase text-slate-500">
                  Source data
                </span>
                <select
                  className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 disabled:opacity-50"
                  value={draft.sourceQueryId}
                  disabled={busy}
                  onChange={(e) => {
                    invalidateDescribe();
                    const nextSource = e.target.value;
                    setDraft((d) => ({
                      ...d,
                      sourceQueryId: nextSource,
                      sourceColumns: [],
                      restoreColumnsByQuery: restoresForPair(
                        d.restoreColumnsByQuery,
                        nextSource,
                        d.targetQueryId,
                      ),
                      targetColumn:
                        d.targetQueryId === nextSource ? "" : d.targetColumn,
                      targetColumns:
                        d.targetQueryId === nextSource
                          ? []
                          : d.targetColumns,
                    }));
                  }}
                >
                  {locals.map((q) => (
                    <option key={q.id} value={q.id}>
                      {q.name}
                    </option>
                  ))}
                </select>
              </label>
              <p className="text-[11px] text-slate-500">
                Pick the queries here. Source keys and the target column are
                chosen on the next step after schemas are described.
              </p>
              <label className="block space-y-1">
                <span className="text-[11px] uppercase text-slate-500">
                  Target data
                </span>
                <select
                  className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 disabled:opacity-50"
                  value={draft.targetQueryId}
                  disabled={busy}
                  onChange={(e) => {
                    invalidateDescribe();
                    const nextTarget = e.target.value;
                    setDraft((d) => ({
                      ...d,
                      targetQueryId: nextTarget,
                      targetColumn: "",
                      targetColumns: [],
                      restoreColumnsByQuery: restoresForPair(
                        d.restoreColumnsByQuery,
                        d.sourceQueryId,
                        nextTarget,
                      ),
                    }));
                  }}
                >
                  {locals.map((q) => (
                    <option key={q.id} value={q.id}>
                      {q.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {step === "fields" && sourceEv && targetEv && (
            <div className="space-y-4">
              <div>
                <p className="mb-1 text-[11px] uppercase text-slate-500">
                  Source key (order = From)
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {selectableOutputColumns(
                    sourceEv,
                    draft.restoreColumnsByQuery[draft.sourceQueryId],
                  ).map((c) => {
                    const on = draft.sourceColumns.some(
                      (x) => x.toLowerCase() === c.toLowerCase(),
                    );
                    return (
                      <button
                        key={`src:${c}`}
                        type="button"
                        onClick={() => toggleSourceCol(c)}
                        className={
                          on
                            ? "rounded border border-teal-600 bg-teal-900/40 px-2 py-0.5 text-teal-100"
                            : "rounded border border-slate-700 px-2 py-0.5 text-slate-400"
                        }
                      >
                        {c}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div>
                <p className="mb-1 text-[11px] uppercase text-slate-500">
                  Target value(s)
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {selectableOutputColumns(
                    targetEv,
                    draft.restoreColumnsByQuery[draft.targetQueryId],
                  ).map((c) => {
                    const selected =
                      draft.targetColumns?.some(
                        (x) => x.toLowerCase() === c.toLowerCase(),
                      ) ||
                      (!draft.targetColumns?.length &&
                        draft.targetColumn.toLowerCase() === c.toLowerCase());
                    return (
                      <button
                        key={`tgt:${c}`}
                        type="button"
                        onClick={() =>
                          setDraft((d) => {
                            const cur =
                              d.targetColumns?.length
                                ? [...d.targetColumns]
                                : d.targetColumn.trim()
                                  ? [d.targetColumn]
                                  : [];
                            const i = cur.findIndex(
                              (x) => x.toLowerCase() === c.toLowerCase(),
                            );
                            const next =
                              i >= 0
                                ? cur.filter((_, j) => j !== i)
                                : [...cur, c];
                            return {
                              ...d,
                              targetColumns: next,
                              targetColumn: next[0] ?? "",
                            };
                          })
                        }
                        className={
                          selected
                            ? "rounded border border-teal-600 bg-teal-900/40 px-2 py-0.5 text-teal-100"
                            : "rounded border border-slate-700 px-2 py-0.5 text-slate-400"
                        }
                      >
                        {c}
                      </button>
                    );
                  })}
                </div>
              </div>
              {renderExcluded(
                draft.sourceQueryId === draft.targetQueryId
                  ? "Excluded by last Fields"
                  : "Source — excluded by last Fields",
                draft.sourceQueryId,
                excludedSource,
              )}
              {draft.sourceQueryId !== draft.targetQueryId &&
                renderExcluded(
                  "Target — excluded by last Fields",
                  draft.targetQueryId,
                  excludedTarget,
                )}
            </div>
          )}
          {step === "review" && plan && (
            <div className="space-y-3">
              <p>
                Map{" "}
                <span className="font-medium text-slate-100">
                  {plan.map.name}
                </span>{" "}
                · seed · relation From{" "}
                <span className="font-mono text-teal-200/90">
                  {(plan.map.from_columns ?? [plan.map.from_column ?? "from"]).join(
                    " · ",
                  )}
                </span>{" "}
                → outputs{" "}
                <span className="font-mono text-teal-200/90">
                  {(
                    plan.map.output_columns ?? [plan.map.to_column ?? "to"]
                  ).join(" · ")}
                </span>
              </p>
              <p className="text-[12px] text-slate-500">
                Authoring: source{" "}
                <span className="font-mono">
                  {plan.authoringContext.source_columns.join(" · ")}
                </span>{" "}
                → target{" "}
                <span className="font-mono">
                  {(
                    plan.authoringContext.target_columns?.length
                      ? plan.authoringContext.target_columns
                      : [plan.authoringContext.target_column]
                  ).join(" · ")}
                </span>
              </p>
              {plan.patches.length === 0 ? (
                <p className="text-slate-500">Queries will not change.</p>
              ) : (
                plan.patches.map((p) => (
                  <div
                    key={p.queryId}
                    className="rounded border border-slate-800 bg-slate-900/50 px-2 py-2 font-mono text-[11px]"
                  >
                    <div className="text-slate-400">
                      {p.queryId} / Fields
                    </div>
                    <div className="text-slate-500">
                      {p.before.join(", ") || "∅"}
                    </div>
                    <div className="text-teal-200">
                      → {p.after.join(", ")}
                    </div>
                  </div>
                ))
              )}
              <ul className="list-disc space-y-1 pl-4 text-[12px] text-slate-400">
                {plan.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <footer className="flex justify-end gap-2 border-t border-slate-800 px-4 py-3">
          <button
            type="button"
            className="rounded border border-slate-700 px-3 py-1.5 text-slate-300 hover:border-slate-500 disabled:opacity-40"
            onClick={requestClose}
          >
            Cancel
          </button>
          {step === "keys" && (
            <button
              type="button"
              disabled={busy || locals.length === 0}
              className="rounded bg-teal-600 px-3 py-1.5 font-medium text-slate-950 disabled:opacity-40"
              onClick={() => void goFields()}
            >
              {busy ? "Loading schema…" : "Next"}
            </button>
          )}
          {step === "fields" && (
            <>
              <button
                type="button"
                className="rounded border border-slate-700 px-3 py-1.5 text-slate-300"
                disabled={busy}
                onClick={() => setStep("keys")}
              >
                Back
              </button>
              <button
                type="button"
                className="rounded bg-teal-600 px-3 py-1.5 font-medium text-slate-950 disabled:opacity-40"
                disabled={busy}
                onClick={goReview}
              >
                Next
              </button>
            </>
          )}
          {step === "review" && plan && (
            <>
              <button
                type="button"
                className="rounded border border-slate-700 px-3 py-1.5 text-slate-300"
                disabled={busy}
                onClick={() => setStep("fields")}
              >
                Back
              </button>
              <button
                type="button"
                className="rounded bg-teal-600 px-3 py-1.5 font-medium text-slate-950 disabled:opacity-40"
                disabled={busy}
                onClick={() => void confirmCreate(plan)}
              >
                {busy
                  ? "Confirming schema…"
                  : plan.patches.length
                    ? "Update Fields and create map"
                    : "Create and open"}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
