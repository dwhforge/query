import {
  emptyProject,
  migrateProject,
  syncSourcesFromQueries,
  type Project,
  type ProjectDefaults,
  type Workspace,
} from "../types/pipeline";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}

/** A comparison token, not another workspace store. Connections are app-global. */
export function projectFingerprint(project: Project): string {
  const { connections: _connections, root_path: _path, ...document } = project;
  return JSON.stringify(canonical(document));
}

/** Labs are independent projects (ADR-0045); no previous project fields spread. */
export function labProject(id: string, workspace: Workspace, previous: Project, defaults: ProjectDefaults): Project {
  let engine = defaults.default_execution_engine ?? defaults.default_target_dialect ?? "duckdb";
  let destination = defaults.default_destination_kind ?? engine;
  if (id === "keymap_pg" || id === "keymap_pg_dual") {
    engine = "postgres";
    destination = "postgres";
  } else if (id === "keymap_pg_seed" || id === "keymap_mixed") {
    engine = "duckdb";
    destination = "postgres";
  } else if (id === "keymap_parquet" || id === "mapping_quality" || id === "recon_ship_sales") {
    engine = "duckdb";
    destination = "duckdb";
  }
  const project = emptyProject(`demo_${id}`, {
    ...defaults, default_execution_engine: engine, default_destination_kind: destination,
  });
  return migrateProject({
    ...project,
    connections: previous.connections,
    sources: syncSourcesFromQueries([], workspace.queries),
    workspace,
    canvas: { positions: {} },
    ...(destination === "postgres" ? {
      destination: { kind: "postgres" as const, connection_id:
        previous.connections.find((c) => c.id === "conn_postgres")?.id ?? "conn_postgres" },
    } : {}),
  });
}

export type SwitchDecision = "save" | "discard" | "cancel";
export type ReplacementState = { token: string; drafts: string; busy: boolean };

/** Permission and staging are separate from commit; late edits never get discarded. */
export async function replaceProject<T>(options: {
  read: () => ReplacementState;
  dirty: () => boolean;
  choose: () => Promise<SwitchDecision>;
  save: () => Promise<boolean>;
  load: () => Promise<T>;
  commit: (loaded: T) => void;
}): Promise<boolean> {
  if (options.read().busy) throw new Error("A save is still in progress. Wait for it to finish before switching projects.");
  if (options.dirty()) {
    const decision = await options.choose();
    if (decision === "cancel") return false;
    if (decision === "save" && !(await options.save())) return false;
  }
  const approved = options.read();
  if (approved.busy) throw new Error("A save is still in progress. Wait for it to finish before switching projects.");
  const loaded = await options.load();
  const current = options.read();
  if (current.busy || current.token !== approved.token || current.drafts !== approved.drafts) {
    throw new Error("The current project changed while loading. Nothing was replaced. Try opening the project again.");
  }
  options.commit(loaded);
  return true;
}
