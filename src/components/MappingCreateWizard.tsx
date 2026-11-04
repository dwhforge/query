import { useEffect, useMemo, useState } from "react";
import { describeWorkspace, projectRefContext } from "../lib/bridge";
import type { Project } from "../types/pipeline";
import {
  buildMappingCreatePlan,
  excludedByLastFields,
  listLocalQueries,
  makeSchemaEvidence,
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
  const [step, setStep] = useState<Step>("keys");
  const [draft, setDraft] = useState<MappingCreateDraft>({
    name: "",
    sourceQueryId: locals[0]?.id ?? "",
    sourceColumns: [],
    targetQueryId: locals[1]?.id ?? locals[0]?.id ?? "",
    targetColumn: "",
    restoreColumnsByQuery: {},
  });
  const [schemas, setSchemas] = useState<SchemaEvidence[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<MappingCreatePlan | null>(null);

  useEffect(() => {
    if (!open) return;
    setStep("keys");
    setError(null);
    setPlan(null);
    setDraft({
      name: "",
      sourceQueryId: locals[0]?.id ?? "",
      sourceColumns: [],
      targetQueryId: locals[1]?.id ?? locals[0]?.id ?? "",
      targetColumn: "",
      restoreColumnsByQuery: {},
    });
    setSchemas([]);
  }, [open, locals]);

  if (!open) return null;

  async function describePair(
    sourceId: string,
    targetId: string,
  ): Promise<SchemaEvidence[]> {
    const pref = projectRefContext(project);
    const ids = [...new Set([sourceId, targetId].filter(Boolean))];
    const out: SchemaEvidence[] = [];
    for (const id of ids) {
      const q = project.workspace.queries.find((x) => x.id === id);
      if (!q) throw new Error(`Query “${id}” missing.`);
      const ws = {
        ...project.workspace,
        focus_query_id: id,
        queries: project.workspace.queries.map((x) =>
          x.id === id ? x : x,
        ),
      };
      const full = await describeWorkspace(
        ws,
        project.connections,
        project.sources,
        pref,
      );
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
        upstreamColumns = up.columns.map((c) => c.name);
      }
      out.push(
        makeSchemaEvidence({ queryId: id, outputColumns, upstreamColumns }),
      );
    }
    return out;
  }

  async function goFields() {
    setError(null);
    setBusy(true);
    try {
      if (!draft.name.trim()) throw new Error("Name the mapping.");
      if (!draft.sourceQueryId || !draft.targetQueryId) {
        throw new Error("Pick source and target queries.");
      }
      const ev = await describePair(draft.sourceQueryId, draft.targetQueryId);
      setSchemas(ev);
      setStep("fields");
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setBusy(false);
    }
  }

  function goReview() {
    setError(null);
    if (!draft.sourceColumns.length || !draft.targetColumn.trim()) {
      setError("Pick source key(s) and target column.");
      return;
    }
    // Keys restored via last-Fields are not yet on live output — treat planned
    // output as current+restore for validation (patch still uses upstream).
    const schemasForPlan = schemas.map((s) => {
      const restore = draft.restoreColumnsByQuery[s.queryId] ?? [];
      if (!restore.length) return s;
      return makeSchemaEvidence({
        queryId: s.queryId,
        outputColumns: [...new Set([...s.outputColumns, ...restore])],
        upstreamColumns: s.upstreamColumns,
      });
    });
    const built = buildMappingCreatePlan({
      project,
      draft,
      schemas: schemasForPlan,
    });
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setPlan(built.plan);
    setStep("review");
  }

  const sourceEv = schemas.find((s) => s.queryId === draft.sourceQueryId);
  const targetEv = schemas.find((s) => s.queryId === draft.targetQueryId);
  const sourceQ = project.workspace.queries.find(
    (q) => q.id === draft.sourceQueryId,
  );
  const excludedSource =
    sourceQ && sourceEv?.upstreamColumns
      ? excludedByLastFields(sourceQ, sourceEv.upstreamColumns)
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="mapping-create-title"
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
            onClick={onCancel}
          >
            ✕
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-[13px] text-slate-300">
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
                  className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-slate-100"
                  value={draft.name}
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
                  className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5"
                  value={draft.sourceQueryId}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      sourceQueryId: e.target.value,
                      sourceColumns: [],
                      restoreColumnsByQuery: {},
                    }))
                  }
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
                  className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5"
                  value={draft.targetQueryId}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      targetQueryId: e.target.value,
                      targetColumn: "",
                    }))
                  }
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
                  {(sourceEv.upstreamColumns &&
                  draft.restoreColumnsByQuery[draft.sourceQueryId]?.length
                    ? [
                        ...new Set([
                          ...sourceEv.outputColumns,
                          ...(draft.restoreColumnsByQuery[
                            draft.sourceQueryId
                          ] ?? []),
                        ]),
                      ]
                    : sourceEv.outputColumns
                  ).map((c) => {
                    const on = draft.sourceColumns.some(
                      (x) => x.toLowerCase() === c.toLowerCase(),
                    );
                    return (
                      <button
                        key={c}
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
                  Target value
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {targetEv.outputColumns.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() =>
                        setDraft((d) => ({ ...d, targetColumn: c }))
                      }
                      className={
                        draft.targetColumn === c
                          ? "rounded border border-teal-600 bg-teal-900/40 px-2 py-0.5 text-teal-100"
                          : "rounded border border-slate-700 px-2 py-0.5 text-slate-400"
                      }
                    >
                      {c}
                    </button>
                  ))}
                </div>
              </div>
              {excludedSource.length > 0 && (
                <div>
                  <p className="mb-1 text-[11px] uppercase text-slate-500">
                    Excluded by last Fields
                  </p>
                  <ul className="space-y-1">
                    {excludedSource.map((c) => {
                      const on = (
                        draft.restoreColumnsByQuery[draft.sourceQueryId] ??
                        []
                      ).some((x) => x.toLowerCase() === c.toLowerCase());
                      return (
                        <li
                          key={c}
                          className="flex items-center justify-between gap-2"
                        >
                          <span className="font-mono text-slate-300">{c}</span>
                          <button
                            type="button"
                            className="rounded border border-amber-800/60 px-2 py-0.5 text-[11px] text-amber-100 hover:bg-amber-950/40"
                            onClick={() =>
                              toggleRestore(draft.sourceQueryId, c)
                            }
                          >
                            {on ? "Remove" : "Include"}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
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
                · seed · From{" "}
                <span className="font-mono text-teal-200/90">
                  {plan.authoringContext.source_columns.join(" · ")}
                </span>{" "}
                → To column{" "}
                <span className="font-mono text-teal-200/90">to</span> (from{" "}
                {plan.authoringContext.target_column})
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
            className="rounded border border-slate-700 px-3 py-1.5 text-slate-300 hover:border-slate-500"
            onClick={onCancel}
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
                onClick={() => setStep("keys")}
              >
                Back
              </button>
              <button
                type="button"
                className="rounded bg-teal-600 px-3 py-1.5 font-medium text-slate-950"
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
                onClick={() => setStep("fields")}
              >
                Back
              </button>
              <button
                type="button"
                className="rounded bg-teal-600 px-3 py-1.5 font-medium text-slate-950"
                onClick={() => onConfirm(plan)}
              >
                {plan.patches.length
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
