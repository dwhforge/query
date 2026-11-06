import { useEffect, useMemo, useState } from "react";
import {
  commitPgImport,
  diagnosePostgresMapping,
  listPostgresObjects,
  pgImportFingerprint,
  scanPostgresImport,
  type PostgresObject,
} from "../lib/bridge";
import {
  literalPrefixMatch,
  relKey,
  writeBackBlock,
  type ConfirmedBinding,
  type ImportColumn,
  type MappingDecision,
  type PgImportOutcome,
  type PgScanHit,
  type PlannedRelation,
  type PlannedWorkingQuery,
} from "../lib/pgImport";
import type { Project } from "../types/pipeline";

type Step = "objects" | "bindings" | "analysis" | "review";

interface Draft {
  decision: MappingDecision;
  confirmed: ConfirmedBinding | null;
  resolved: boolean;
}

interface Props {
  open: boolean;
  project: Project;
  connectionId: string | null;
  dirtyMapIds: string[];
  saveInFlightMapIds: string[];
  onClose: () => void;
  onRequestNewConnection: () => void;
  onCommitted: (outcome: PgImportOutcome<Project>) => void;
}

function splitList(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function emptyBinding(): ConfirmedBinding {
  return {
    from_columns: [],
    output_columns: [],
    editable_columns: [],
    time_mode: "static",
    valid_from_column: null,
    valid_to_column: null,
    write_back: false,
  };
}

export function PgImportWizard({
  open,
  project,
  connectionId,
  dirtyMapIds,
  saveInFlightMapIds,
  onClose,
  onRequestNewConnection,
  onCommitted,
}: Props) {
  const pgConns = project.connections.filter((c) => c.kind === "postgres");
  const [connId, setConnId] = useState(connectionId ?? "");
  const [step, setStep] = useState<Step>("objects");
  const [objects, setObjects] = useState<PostgresObject[]>([]);
  const [hits, setHits] = useState<Record<string, PgScanHit>>({});
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [prefixesText, setPrefixesText] = useState("map_, _map_");
  const [ruleSchemas, setRuleSchemas] = useState<string[]>([]);
  const [schemaFilter, setSchemaFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [commitToken] = useState(() => crypto.randomUUID());
  const [workingToken] = useState(() => crypto.randomUUID());
  const [makeWorking, setMakeWorking] = useState(false);
  const [workLeft, setWorkLeft] = useState("");
  const [workMap, setWorkMap] = useState("");
  const [workRight, setWorkRight] = useState("");
  const [workInputs, setWorkInputs] = useState("");
  const [workOutputs, setWorkOutputs] = useState("");
  const [workLeftOn, setWorkLeftOn] = useState("");
  const [workRightOn, setWorkRightOn] = useState("");
  const [workJoin, setWorkJoin] = useState("left");
  const [workExtra, setWorkExtra] = useState("");

  const conn = pgConns.find((c) => c.id === connId);
  const registry = project.pg_import;

  useEffect(() => {
    if (!open) return;
    const fallback = project.connections.find((c) => c.kind === "postgres")?.id ?? "";
    setConnId(connectionId || fallback);
    setStep("objects");
    setError(null);
  }, [open, connectionId, project.connections]);

  const prefixes = useMemo(() => splitList(prefixesText), [prefixesText]);

  const savedByKey = useMemo(() => {
    const map = new Map<string, NonNullable<typeof registry>["relations"][number]>();
    for (const rel of registry?.relations ?? []) {
      if (rel.connection_id === connId) map.set(relKey(rel.schema, rel.name), rel);
    }
    return map;
  }, [registry, connId]);

  async function browse() {
    const dsn = conn?.postgres?.connection_string?.trim();
    if (!dsn) {
      setError("Выберите PostgreSQL connection");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const list = await listPostgresObjects(dsn);
      setObjects(list);
      const schemas = [...new Set(list.map((o) => o.schema))].sort();
      setRuleSchemas(schemas);
      if (schemas.includes("public")) setSchemaFilter("public");
      else setSchemaFilter(schemas[0] ?? "");
      setStatus(list.length === 0 ? "Нет таблиц и представлений" : `${list.length} объектов`);
    } catch (e) {
      setObjects([]);
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setBusy(false);
    }
  }

  function stateOf(obj: PostgresObject): string {
    const saved = savedByKey.get(relKey(obj.schema, obj.name));
    if (!saved) return "новый";
    const hit = hits[relKey(obj.schema, obj.name)];
    if (hit && (hit.schema_fingerprint !== saved.schema_fingerprint || hit.kind !== saved.kind)) {
      return "изменён";
    }
    return "уже импортирован";
  }

  const visible = objects.filter((o) => !schemaFilter || o.schema === schemaFilter);
  const missing = [...savedByKey.values()].filter(
    (rel) => !objects.some((o) => o.schema === rel.schema && o.name === rel.name),
  );

  function toggle(key: string) {
    setSelected((cur) => ({ ...cur, [key]: !cur[key] }));
  }

  function seedDraft(key: string, hit: PgScanHit | undefined, rule: boolean): Draft {
    const saved = savedByKey.get(key);
    const map = saved?.keymap_id
      ? (project.workspace.key_maps ?? []).find((m) => m.id === saved.keymap_id)
      : undefined;
    if (saved?.mapping_decision === "exclude") {
      return { decision: "exclude", confirmed: null, resolved: true };
    }
    if (map) {
      const from = map.from_columns?.length ? map.from_columns : map.from_column ? [map.from_column] : [];
      const outputs = map.output_columns?.length
        ? map.output_columns
        : map.to_column
          ? [map.to_column]
          : [];
      return {
        decision: "force",
        resolved: true,
        confirmed: {
          from_columns: from,
          output_columns: outputs,
          editable_columns: map.editable_columns ?? [],
          time_mode: map.time_mode === "range_scd" ? "range_scd" : "static",
          valid_from_column: map.valid_from_column ?? null,
          valid_to_column: map.valid_to_column ?? null,
          write_back: Boolean(saved?.write_back),
        },
      };
    }
    if (saved?.mapping_decision === "force" || rule || hit?.rule_match) {
      return { decision: "force", confirmed: null, resolved: false };
    }
    return { decision: "follow_rule", confirmed: null, resolved: true };
  }

  async function inspect() {
    const dsn = conn?.postgres?.connection_string?.trim();
    if (!dsn) return;
    const chosen = objects.filter((o) => selected[relKey(o.schema, o.name)]);
    if (chosen.length === 0 && missing.every((m) => !selected[relKey(m.schema, m.name)])) {
      setError("Выберите хотя бы один объект");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const scanned = chosen.length
        ? await scanPostgresImport({
            connectionString: dsn,
            relations: chosen.map((o) => ({ schema: o.schema, name: o.name })),
            prefixes,
            ruleSchemas,
          })
        : [];
      const nextHits: Record<string, PgScanHit> = {};
      const nextDrafts: Record<string, Draft> = {};
      for (const hit of scanned) {
        const key = relKey(hit.schema, hit.name);
        nextHits[key] = hit;
        const rule =
          hit.rule_match ||
          (ruleSchemas.includes(hit.schema) && literalPrefixMatch(hit.name, prefixes));
        nextDrafts[key] = seedDraft(key, hit, rule);
      }
      for (const rel of missing) {
        if (!selected[relKey(rel.schema, rel.name)]) continue;
        nextDrafts[relKey(rel.schema, rel.name)] = {
          decision: rel.mapping_decision,
          confirmed: null,
          resolved: true,
        };
      }
      setHits(nextHits);
      setDrafts(nextDrafts);
      const firstMap = Object.entries(nextDrafts).find(([, d]) => d.decision === "force");
      if (firstMap) setWorkMap(firstMap[0]);
      setStep("bindings");
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setBusy(false);
    }
  }

  function patchDraft(key: string, patch: Partial<Draft>) {
    setDrafts((cur) => ({ ...cur, [key]: { ...cur[key], ...patch } }));
  }

  function assign(key: string, column: string, role: "from" | "output" | "attr" | "clear") {
    const draft = drafts[key];
    if (!draft) return;
    const binding = { ...(draft.confirmed ?? emptyBinding()) };
    const drop = (list: string[]) => list.filter((c) => c !== column);
    binding.from_columns = drop(binding.from_columns);
    binding.output_columns = drop(binding.output_columns);
    binding.editable_columns = drop(binding.editable_columns);
    if (role === "from") binding.from_columns = [...binding.from_columns, column];
    if (role === "output") binding.output_columns = [...binding.output_columns, column];
    if (role === "attr") binding.editable_columns = [...binding.editable_columns, column];
    patchDraft(key, { confirmed: binding, resolved: false, decision: "force" });
  }

  function confirmDraft(key: string) {
    const hit = hits[key];
    const draft = drafts[key];
    if (!hit || !draft?.confirmed) {
      setError("Сначала назначьте From и outputs");
      return;
    }
    const b = draft.confirmed;
    if (b.from_columns.length === 0 || b.output_columns.length === 0) {
      setError("From и outputs обязательны");
      return;
    }
    const names = new Set(hit.columns.map((c) => c.name.toLowerCase()));
    const roles = [...b.from_columns, ...b.output_columns, ...b.editable_columns];
    if (b.time_mode === "range_scd") {
      if (!b.valid_from_column || !b.valid_to_column) {
        setError("Для range SCD нужны valid_from и valid_to");
        return;
      }
      roles.push(b.valid_from_column, b.valid_to_column);
    }
    if (roles.some((c) => !names.has(c.toLowerCase()))) {
      setError("В binding есть колонка, которой нет в relation");
      return;
    }
    const folded = roles.map((c) => c.toLowerCase());
    if (new Set(folded).size !== folded.length) {
      setError("From, outputs, attrs и temporal колонки не должны пересекаться");
      return;
    }
    const block = writeBackBlock(
      hit.kind,
      hit.insert_ok,
      hit.update_ok,
      hit.delete_ok,
      hit.unique_sets ?? [],
      b,
    );
    patchDraft(key, {
      decision: "force",
      resolved: true,
      confirmed: { ...b, write_back: b.write_back && !block },
    });
    setError(block && b.write_back ? block : null);
  }

  const bindingKeys = Object.keys(drafts);
  const unresolved = bindingKeys.filter((key) => {
    const draft = drafts[key];
    const hit = hits[key];
    if (!hit) return false;
    const candidate = draft.decision === "force" || hit.rule_match;
    return candidate && !draft.resolved;
  });

  function plannedRelations(): PlannedRelation[] {
    const rows: PlannedRelation[] = [];
    for (const [key, draft] of Object.entries(drafts)) {
      const hit = hits[key];
      if (!hit) {
        const [schema, name] = key.split(".");
        const saved = savedByKey.get(key);
        rows.push({
          schema,
          name,
          present: false,
          kind: saved?.kind ?? "table",
          columns: [],
          unique_sets: [],
          select_ok: false,
          insert_ok: false,
          update_ok: false,
          delete_ok: false,
          schema_fingerprint: "",
          mapping_decision: draft.decision,
          confirmed: null,
          quality_notes: [],
          catalog_oid: saved?.catalog_oid ?? null,
        });
        continue;
      }
      rows.push({
        schema: hit.schema,
        name: hit.name,
        present: true,
        kind: hit.kind,
        catalog_oid: hit.catalog_oid ?? null,
        columns: hit.columns,
        unique_sets: hit.unique_sets ?? [],
        select_ok: hit.select_ok,
        insert_ok: hit.insert_ok,
        update_ok: hit.update_ok,
        delete_ok: hit.delete_ok,
        view_definition: hit.view_definition ?? null,
        view_definition_available: hit.view_definition_available ?? null,
        schema_fingerprint: hit.schema_fingerprint,
        mapping_decision: draft.decision,
        confirmed: draft.resolved ? draft.confirmed : null,
        quality_notes: [],
      });
    }
    return rows;
  }

  async function goReview() {
    if (unresolved.length > 0) {
      setError("Подтвердите binding или оставьте relation обычным query");
      return;
    }
    const dsn = conn?.postgres?.connection_string?.trim();
    setBusy(true);
    setError(null);
    try {
      if (dsn) {
        const notes: Record<string, string[]> = {};
        for (const [key, draft] of Object.entries(drafts)) {
          if (!draft.resolved || !draft.confirmed || draft.decision === "exclude") continue;
          const hit = hits[key];
          if (!hit) continue;
          try {
            const diag = await diagnosePostgresMapping({
              connectionString: dsn,
              schema: hit.schema,
              table: hit.name,
              fromColumns: draft.confirmed.from_columns,
              outputColumns: draft.confirmed.output_columns,
              validFrom: draft.confirmed.valid_from_column ?? undefined,
              validTo: draft.confirmed.valid_to_column ?? undefined,
            });
            notes[key] = diag.notes ?? [];
          } catch (e) {
            notes[key] = [
              `проверка качества недоступна: ${typeof e === "string" ? e : String(e)}`,
            ];
          }
        }
        setQuality(notes);
      }
      setStep("review");
    } finally {
      setBusy(false);
    }
  }

  const [quality, setQuality] = useState<Record<string, string[]>>({});

  function workingQuery(): PlannedWorkingQuery | null {
    if (!makeWorking || !workMap) return null;
    const [schema, name] = splitKey(workMap);
    const draft = drafts[workMap];
    const outputs = splitList(workOutputs);
    const mapCols = draft?.confirmed?.output_columns ?? [];
    return {
      token: workingToken,
      name: "Анализ связей",
      left_relation: workLeft ? splitKey(workLeft) : null,
      map_relation: [schema, name],
      input_columns: splitList(workInputs),
      output_bindings: mapCols.map((col, i) => ({
        map_column: col,
        destination_column: outputs[i] || col,
      })),
      right_relation: workRight ? splitKey(workRight) : null,
      join_type: workJoin,
      left_on: splitList(workLeftOn),
      right_on: splitList(workRightOn),
      extra_equalities: splitList(workExtra).map((pair) => {
        const [left, right] = pair.split("=").map((s) => s.trim());
        return { left: left ?? "", right: right ?? "" };
      }),
    };
  }

  async function commit() {
    if (!connId || !conn?.postgres?.connection_string) return;
    if (saveInFlightMapIds.length > 0) {
      setError("Дождитесь окончания Save, затем повторите импорт");
      return;
    }
    const relations = plannedRelations().map((rel) => ({
      ...rel,
      quality_notes: quality[relKey(rel.schema, rel.name)] ?? [],
    }));
    const touchesDirty = relations.some((rel) => {
      const saved = savedByKey.get(relKey(rel.schema, rel.name));
      return saved?.keymap_id && dirtyMapIds.includes(saved.keymap_id);
    });
    let discard = false;
    if (touchesDirty) {
      discard = window.confirm(
        "Есть несохранённые правки карты. Продолжение сбросит их. Продолжить?",
      );
      if (!discard) return;
    }
    setBusy(true);
    setError(null);
    try {
      const { fingerprint } = await pgImportFingerprint(project);
      const outcome = await commitPgImport({
        project,
        connectionString: conn.postgres.connection_string,
        plan: {
          commit_token: commitToken,
          expected_fingerprint: fingerprint,
          connection_id: connId,
          prefixes,
          rule_schemas: ruleSchemas,
          relations,
          working_query: workingQuery(),
          save_in_flight_map_ids: saveInFlightMapIds,
          dirty_map_ids: dirtyMapIds,
          discard_confirmed: discard,
        },
      });
      onCommitted(outcome);
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      data-testid="pg-import-wizard"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[min(820px,92vh)] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-[var(--line)] bg-[#0a121c] shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-[var(--line)] px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-teal-300">
              Импортировать объекты в проект…
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Определения и bindings останутся в проекте. Строки остаются в PostgreSQL.
            </p>
          </div>
          <button
            type="button"
            data-testid="pg-import-cancel"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-xs text-slate-400 hover:bg-slate-800"
          >
            Отмена
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-auto px-5 py-4">
          {pgConns.length === 0 ? (
            <button
              type="button"
              onClick={onRequestNewConnection}
              className="rounded-lg bg-teal-500 px-3 py-2 text-sm font-semibold text-slate-950"
            >
              Создать PostgreSQL connection
            </button>
          ) : (
            <select
              data-testid="pg-import-connection"
              value={connId}
              onChange={(e) => {
                setConnId(e.target.value);
                setObjects([]);
                setHits({});
              }}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm"
            >
              {pgConns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}

          {step === "objects" && (
            <>
              <label className="block text-[11px] text-slate-400">
                Префиксы Mapping (буквальные, через запятую)
                <input
                  data-testid="pg-import-prefixes"
                  value={prefixesText}
                  onChange={(e) => setPrefixesText(e.target.value)}
                  className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-sm"
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  data-testid="pg-import-browse"
                  disabled={busy}
                  onClick={() => void browse()}
                  className="rounded-md bg-teal-500 px-3 py-1.5 text-xs font-semibold text-slate-950 disabled:opacity-50"
                >
                  Обновить список
                </button>
                <select
                  data-testid="pg-import-schema"
                  value={schemaFilter}
                  onChange={(e) => setSchemaFilter(e.target.value)}
                  className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs"
                >
                  <option value="">все схемы</option>
                  {[...new Set(objects.map((o) => o.schema))].sort().map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                {status && <span className="text-xs text-slate-500">{status}</span>}
              </div>
              <ul className="space-y-1">
                {missing.map((rel) => {
                  const key = relKey(rel.schema, rel.name);
                  return (
                    <li key={key} className="flex items-center gap-2 text-xs text-amber-200">
                      <input
                        type="checkbox"
                        data-testid={`pg-object-${key}`}
                        checked={Boolean(selected[key])}
                        onChange={() => toggle(key)}
                      />
                      <span className="font-mono">
                        {key} · недоступен
                      </span>
                    </li>
                  );
                })}
                {visible.map((obj) => {
                  const key = relKey(obj.schema, obj.name);
                  const candidate =
                    ruleSchemas.includes(obj.schema) &&
                    literalPrefixMatch(obj.name, prefixes) &&
                    savedByKey.get(key)?.mapping_decision !== "exclude";
                  return (
                    <li key={key} className="flex items-center gap-2 text-xs text-slate-200">
                      <input
                        type="checkbox"
                        data-testid={`pg-object-${key}`}
                        checked={Boolean(selected[key])}
                        onChange={() => toggle(key)}
                      />
                      <span className="font-mono">{key}</span>
                      <span className="text-slate-500">{obj.kind}</span>
                      <span className="text-slate-500">{stateOf(obj)}</span>
                      {candidate && <span className="text-teal-400">кандидат</span>}
                    </li>
                  );
                })}
              </ul>
            </>
          )}

          {step === "bindings" &&
            bindingKeys.map((key) => {
              const hit = hits[key];
              const draft = drafts[key];
              if (!hit || !draft) {
                return (
                  <p key={key} className="text-xs text-amber-200">
                    {key}: недоступен, binding не переназначается
                  </p>
                );
              }
              const candidate = draft.decision === "force" || hit.rule_match;
              const binding = draft.confirmed ?? emptyBinding();
              const block = writeBackBlock(
                hit.kind,
                hit.insert_ok,
                hit.update_ok,
                hit.delete_ok,
                hit.unique_sets ?? [],
                binding,
              );
              return (
                <section key={key} className="rounded-lg border border-slate-800 p-3" data-testid={`pg-binding-${key}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="font-mono text-xs text-teal-200">{key}</h3>
                    <span className="text-[11px] text-slate-500">
                      {hit.kind}
                      {hit.select_ok ? " · чтение" : " · чтение недоступно"}
                      {draft.resolved ? " · подтверждено" : candidate ? " · нужно подтверждение" : ""}
                    </span>
                  </div>
                  {hit.view_definition_available === false && (
                    <p className="mt-1 text-[11px] text-amber-200">SQL definition недоступен</p>
                  )}
                  {hit.view_definition_available === true && hit.view_definition && (
                    <pre className="mt-1 max-h-24 overflow-auto text-[10px] text-slate-500">
                      {hit.view_definition}
                    </pre>
                  )}
                  <ul className="mt-2 space-y-1">
                    {hit.columns.map((col) => (
                      <ColumnRow
                        key={col.name}
                        rel={key}
                        col={col}
                        binding={binding}
                        onAssign={(role) => assign(key, col.name, role)}
                      />
                    ))}
                  </ul>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
                    <label>
                      Режим
                      <select
                        data-testid={`pg-mode-${key}`}
                        value={binding.time_mode}
                        onChange={(e) =>
                          patchDraft(key, {
                            resolved: false,
                            decision: "force",
                            confirmed: {
                              ...binding,
                              time_mode: e.target.value === "range_scd" ? "range_scd" : "static",
                            },
                          })
                        }
                        className="ml-1 rounded border border-slate-700 bg-slate-950 px-1"
                      >
                        <option value="static">static</option>
                        <option value="range_scd">range SCD</option>
                      </select>
                    </label>
                    {binding.time_mode === "range_scd" && (
                      <>
                        <input
                          placeholder="valid_from"
                          value={binding.valid_from_column ?? ""}
                          onChange={(e) =>
                            patchDraft(key, {
                              resolved: false,
                              confirmed: { ...binding, valid_from_column: e.target.value },
                            })
                          }
                          className="w-28 rounded border border-slate-700 bg-slate-950 px-1"
                        />
                        <input
                          placeholder="valid_to"
                          value={binding.valid_to_column ?? ""}
                          onChange={(e) =>
                            patchDraft(key, {
                              resolved: false,
                              confirmed: { ...binding, valid_to_column: e.target.value },
                            })
                          }
                          className="w-28 rounded border border-slate-700 bg-slate-950 px-1"
                        />
                      </>
                    )}
                    <label title={block ?? "Разрешить запись после проверки"}>
                      <input
                        type="checkbox"
                        data-testid={`pg-write-${key}`}
                        disabled={Boolean(block)}
                        checked={binding.write_back && !block}
                        onChange={(e) =>
                          patchDraft(key, {
                            resolved: false,
                            confirmed: { ...binding, write_back: e.target.checked },
                          })
                        }
                      />{" "}
                      разрешить запись
                    </label>
                    {block && <span className="text-amber-200/80">{block}</span>}
                  </div>
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      data-testid={`pg-confirm-${key}`}
                      onClick={() => confirmDraft(key)}
                      className="rounded bg-teal-500 px-2 py-1 text-[11px] font-semibold text-slate-950"
                    >
                      Подтвердить binding
                    </button>
                    <button
                      type="button"
                      data-testid={`pg-ordinary-${key}`}
                      onClick={() =>
                        patchDraft(key, {
                          decision: "follow_rule",
                          confirmed: null,
                          resolved: true,
                        })
                      }
                      className="rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300"
                    >
                      Оставить обычным query
                    </button>
                    <button
                      type="button"
                      data-testid={`pg-exclude-${key}`}
                      onClick={() =>
                        patchDraft(key, { decision: "exclude", confirmed: null, resolved: true })
                      }
                      className="rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300"
                    >
                      Не считать Mapping
                    </button>
                    {draft.decision !== "force" && (
                      <button
                        type="button"
                        data-testid={`pg-force-${key}`}
                        onClick={() =>
                          patchDraft(key, {
                            decision: "force",
                            resolved: false,
                            confirmed: draft.confirmed ?? emptyBinding(),
                          })
                        }
                        className="rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300"
                      >
                        Использовать как Mapping
                      </button>
                    )}
                  </div>
                </section>
              );
            })}

          {step === "analysis" && (
            <div className="space-y-2 text-xs">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  data-testid="pg-working-enable"
                  checked={makeWorking}
                  onChange={(e) => setMakeWorking(e.target.checked)}
                />
                Создать рабочий query для анализа связей
              </label>
              {makeWorking && (
                <>
                  <QueryPick label="Левый query" testId="pg-working-left" value={workLeft} keys={bindingKeys} onChange={setWorkLeft} />
                  <QueryPick label="Карта" testId="pg-working-map" value={workMap} keys={bindingKeys.filter((k) => drafts[k]?.resolved && drafts[k]?.confirmed)} onChange={(v) => {
                    setWorkMap(v);
                    const b = drafts[v]?.confirmed;
                    if (!b) return;
                    setWorkInputs(b.from_columns.join(", "));
                    setWorkOutputs(b.output_columns.join(", "));
                    setWorkLeftOn(b.output_columns.join(", "));
                    setWorkRightOn(b.output_columns.join(", "));
                  }} />
                  <QueryPick label="Правый query" testId="pg-working-right" value={workRight} keys={bindingKeys} onChange={setWorkRight} />
                  <Field testId="pg-working-inputs" label="Input bindings" value={workInputs} onChange={setWorkInputs} />
                  <Field testId="pg-working-outputs" label="Destination columns" value={workOutputs} onChange={setWorkOutputs} />
                  <label>
                    Join
                    <select data-testid="pg-working-join" value={workJoin} onChange={(e) => setWorkJoin(e.target.value)} className="ml-2 rounded border border-slate-700 bg-slate-950 px-1">
                      <option value="left">left</option>
                      <option value="inner">inner</option>
                      <option value="right">right</option>
                      <option value="full">full</option>
                    </select>
                  </label>
                  <Field testId="pg-working-left-on" label="Left on" value={workLeftOn} onChange={setWorkLeftOn} />
                  <Field testId="pg-working-right-on" label="Right on" value={workRightOn} onChange={setWorkRightOn} />
                  <Field testId="pg-working-extra" label="Дополнительные равенства left=right" value={workExtra} onChange={setWorkExtra} />
                </>
              )}
            </div>
          )}

          {step === "review" && (
            <div className="space-y-2 text-xs text-slate-300" data-testid="pg-import-review">
              <p>База данных не изменится. Проект получит definitions и bindings.</p>
              {plannedRelations().map((rel) => {
                const key = relKey(rel.schema, rel.name);
                const saved = savedByKey.get(key);
                return (
                  <div key={key} className="rounded border border-slate-800 px-2 py-1">
                    <div className="font-mono text-teal-200">
                      {saved ? "переиспользовать" : "создать"} {key}
                    </div>
                    <div>
                      {rel.confirmed
                        ? `Mapping · ${rel.confirmed.write_back ? "write-back" : "только чтение"} · ${rel.confirmed.from_columns.join("+")} → ${rel.confirmed.output_columns.join(", ")}`
                        : "обычный query"}
                    </div>
                    {(quality[key] ?? []).map((note) => (
                      <div key={note} className="text-amber-200">
                        качество: {note}
                      </div>
                    ))}
                  </div>
                );
              })}
              {makeWorking && <p>Будет создан рабочий query и открыт Join Lens.</p>}
            </div>
          )}

          {error && (
            <p className="rounded border border-rose-900/50 bg-rose-950/40 px-2 py-1 text-xs text-rose-200" data-testid="pg-import-error">
              {error}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-[var(--line)] px-5 py-3">
          {step !== "objects" && (
            <button
              type="button"
              onClick={() =>
                setStep(step === "review" ? "analysis" : step === "analysis" ? "bindings" : "objects")
              }
              className="rounded-md px-3 py-1.5 text-xs text-slate-300"
            >
              Назад
            </button>
          )}
          {step === "objects" && (
            <button type="button" data-testid="pg-import-next" disabled={busy} onClick={() => void inspect()} className="rounded-md bg-teal-500 px-3 py-1.5 text-xs font-semibold text-slate-950 disabled:opacity-50">
              Далее
            </button>
          )}
          {step === "bindings" && (
            <button
              type="button"
              data-testid="pg-import-next"
              disabled={busy}
              onClick={() => {
                if (unresolved.length > 0) {
                  setError("Подтвердите binding или оставьте relation обычным query");
                  return;
                }
                setError(null);
                setStep("analysis");
              }}
              className="rounded-md bg-teal-500 px-3 py-1.5 text-xs font-semibold text-slate-950 disabled:opacity-50"
            >
              Далее
            </button>
          )}
          {step === "analysis" && (
            <button type="button" data-testid="pg-import-next" disabled={busy} onClick={() => void goReview()} className="rounded-md bg-teal-500 px-3 py-1.5 text-xs font-semibold text-slate-950 disabled:opacity-50">
              К проверке
            </button>
          )}
          {step === "review" && (
            <button type="button" data-testid="pg-import-commit" disabled={busy} onClick={() => void commit()} className="rounded-md bg-teal-500 px-3 py-1.5 text-xs font-semibold text-slate-950 disabled:opacity-50">
              Импортировать
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function splitKey(key: string): [string, string] {
  const i = key.indexOf(".");
  return [key.slice(0, i), key.slice(i + 1)];
}

function ColumnRow({
  rel,
  col,
  binding,
  onAssign,
}: {
  rel: string;
  col: ImportColumn;
  binding: ConfirmedBinding;
  onAssign: (role: "from" | "output" | "attr" | "clear") => void;
}) {
  const role = binding.from_columns.includes(col.name)
    ? "From"
    : binding.output_columns.includes(col.name)
      ? "Output"
      : binding.editable_columns.includes(col.name)
        ? "Attr"
        : "";
  const service = col.name.toLowerCase() === "id" && (col.is_primary_key || col.is_autogenerated);
  return (
    <li className="flex flex-wrap items-center gap-1 text-[11px]">
      <span className="w-36 font-mono text-slate-200">{col.name}</span>
      <span className="text-slate-500">{col.data_type}</span>
      {service && <span className="text-amber-200/80">служебный PK</span>}
      {role && <span className="text-teal-300">{role}</span>}
      <button type="button" data-testid={`pg-role-${rel}-${col.name}-from`} onClick={() => onAssign("from")} className="rounded border border-slate-700 px-1">From</button>
      <button type="button" data-testid={`pg-role-${rel}-${col.name}-output`} onClick={() => onAssign("output")} className="rounded border border-slate-700 px-1">Output</button>
      <button type="button" data-testid={`pg-role-${rel}-${col.name}-attr`} onClick={() => onAssign("attr")} className="rounded border border-slate-700 px-1">Attr</button>
    </li>
  );
}

function QueryPick({
  label,
  testId,
  value,
  keys,
  onChange,
}: {
  label: string;
  testId: string;
  value: string;
  keys: string[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      {label}
      <select data-testid={testId} value={value} onChange={(e) => onChange(e.target.value)} className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-1 py-1">
        <option value="">—</option>
        {keys.map((k) => (
          <option key={k} value={k}>
            {k}
          </option>
        ))}
      </select>
    </label>
  );
}

function Field({
  label,
  testId,
  value,
  onChange,
}: {
  label: string;
  testId: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      {label}
      <input data-testid={testId} value={value} onChange={(e) => onChange(e.target.value)} className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-1 py-1 font-mono" />
    </label>
  );
}
