import { migrateProject, type Project, type ProjectDefaults, type Workspace } from "../types/pipeline";
import { isQualityInspectionQuery, stripQualityInspectionQueries } from "../lib/mappingQuality";
import { ensureLabCheck } from "../lib/mappingCheck";
import { dirtyDeltaHasChanges, type KeyMapTabSession } from "./keyMap";
import type { MatchingTabSession } from "./matching/types";
import { labProject, projectFingerprint, replaceProject, type SwitchDecision, type ReplacementState } from "./projectLifecycle";

/** Persistence excludes temporary quality inspection queries, never owner drafts. */
export function projectDocument(project: Project): Project {
  const positions = { ...(project.canvas?.positions ?? {}) };
  for (const id of Object.keys(positions)) if (isQualityInspectionQuery(id)) delete positions[id];
  return {
    ...project, workspace: stripQualityInspectionQueries(project.workspace),
    canvas: { ...project.canvas, positions },
    outputs: (project.outputs ?? []).filter((id) => !isQualityInspectionQuery(id)),
  };
}

export function documentFingerprint(project: Project): string {
  return projectFingerprint(projectDocument(project));
}

export interface ProjectControllerPorts {
  project(): Project;
  update(updater: (project: Project) => Project): void;
  drafts(): { mappings: KeyMapTabSession[]; matching: MatchingTabSession[]; mutationBusy: boolean };
  choose(): Promise<SwitchDecision>;
  pickSave(defaultPath: string): Promise<string | null>;
  save(path: string, project: Project): Promise<Project>;
  load(path: string): Promise<Project>;
  loadLab(id: string): Promise<Workspace>;
  defaults(): ProjectDefaults;
  newUid(): string;
  remember(path: string): Promise<void>;
  pruneRecent(path: string): Promise<void>;
  reset(project: Project, labId?: string): void;
  refreshExport(path?: string): Promise<void>;
  syncMaps(workspace: Workspace, path: string): Promise<{ workspace: Workspace }>;
  error(message: string | null): void;
  message(message: string | null): void;
}

/** Scenario-local coordination, not a Project or Workbench store (ADR-0032). */
export class ProjectController {
  private baseline: string | null;
  private saving = false;
  private switching = false;
  private generation = 0;

  constructor(private ports: ProjectControllerPorts) {
    this.baseline = documentFingerprint(ports.project());
  }

  /** Refresh effect adapters on render; operation state stays in this controller. */
  setPorts(ports: ProjectControllerPorts) { this.ports = ports; }

  markClean(project: Project) { this.baseline = documentFingerprint(project); }

  hasUnsavedEditorDrafts() {
    const { mappings, matching } = this.ports.drafts();
    return matching.some((t) => t.hasUnsavedDecisions) ||
      mappings.some((t) => t.localDraft || dirtyDeltaHasChanges(t.dirtyDelta ?? null));
  }

  isDirty() { return this.hasUnsavedEditorDrafts() || this.baseline !== documentFingerprint(this.ports.project()); }

  snapshot() {
    const project = this.ports.project();
    const { mappings, matching, mutationBusy } = this.ports.drafts();
    return {
      token: `${this.generation}:${project.root_path ?? ""}:${documentFingerprint(project)}`,
      drafts: JSON.stringify([mappings.map((t) => [t.map, t.localDraft, t.dirtyDelta]), matching]),
      busy: this.saving || mutationBusy || mappings.some((t) => t.saveInFlight || t.saveApi?.isSaving()),
    };
  }

  /** Startup restoration is not permission to discard work begun during startup. */
  unchangedSince(approved: ReplacementState): boolean {
    const current = this.snapshot();
    return !current.busy && current.token === approved.token && current.drafts === approved.drafts;
  }

  private report(error: unknown) { this.ports.error(String(error)); }

  async requestReplacement(load: () => Promise<Project>, commit: (project: Project) => void): Promise<boolean> {
    if (this.switching) return false;
    this.switching = true;
    try {
      return await replaceProject({
        read: () => this.snapshot(), dirty: () => this.isDirty(), choose: () => this.ports.choose(),
        save: async () => {
          if (this.hasUnsavedEditorDrafts()) {
            this.ports.error("Save Mapping and Matching drafts in their editors first, then retry opening the project. The current project is still open.");
            return false;
          }
          return this.save();
        }, load, commit,
      });
    } catch (error) { this.report(error); return false; }
    finally { this.switching = false; }
  }

  async open(path: string, pruneFailedRecent = false): Promise<boolean> {
    return this.requestReplacement(async () => {
      try { return await this.ports.load(path); }
      catch (error) {
        if (pruneFailedRecent) await this.ports.pruneRecent(path).catch(() => {});
        throw error;
      }
    }, (loaded) => {
      this.applyLoaded(loaded, path);
      this.ports.message(`Opened ${path}`);
      void this.ports.remember(path).catch((error) => this.report(error));
    });
  }

  async loadLab(id: string): Promise<boolean> {
    return this.requestReplacement(async () => {
      const workspace = await this.ports.loadLab(id);
      const next = labProject(id, workspace, this.ports.project(), this.ports.defaults());
      if (id === "mapping_quality") next.mapping_checks = ensureLabCheck([]);
      return next;
    }, (loaded) => {
      this.applyLoaded(loaded, undefined, id);
      this.ports.message(null);
    });
  }

  async save(as = false): Promise<boolean> {
    if (this.saving) return false;
    this.saving = true;
    try {
      const initial = this.ports.project();
      let path = initial.root_path;
      if (as || !path) {
        const picked = await this.ports.pickSave(as && path ? path.split(/[/\\]/).pop()! :
          `${initial.name.replace(/\s+/g, "_") || "project"}.dwhproj.json`);
        if (picked === null) return false;
        path = picked;
      }
      // Read after the picker: edits made while it was open belong to this save.
      const current = this.ports.project();
      const normalize = (value: string) => {
        const slashes = value.replace(/\\/g, "/");
        return /^[A-Za-z]:\//.test(slashes) ? slashes.toLowerCase() : slashes;
      };
      const sameFile = current.root_path && normalize(current.root_path) === normalize(path);
      const snapshot = as && !sameFile ? { ...current, project_uid: this.ports.newUid() } : current;
      return await this.write(path, snapshot, current);
    } catch (error) { this.report(error); return false; }
    finally { this.saving = false; }
  }

  private async write(path: string, snapshot: Project, comparison: Project): Promise<boolean> {
    const generation = this.generation;
    const base = path.split(/[/\\]/).pop()?.replace(/\.dwhproj\.json$/i, "").replace(/\.json$/i, "") ?? snapshot.name;
    const persisted = projectDocument(snapshot);
    const saved = await this.ports.save(path, { ...persisted, root_path: path, name: base });
    if (generation !== this.generation) return false;
    const savedState: Project = {
      ...snapshot, connections: this.ports.project().connections, root_path: path, name: base,
      format_version: saved.format_version ?? snapshot.format_version,
      project_uid: saved.project_uid ?? snapshot.project_uid,
      sources: saved.sources ?? snapshot.sources,
      workspace: { ...snapshot.workspace, queries: [
        ...(saved.workspace?.queries ?? persisted.workspace.queries),
        ...snapshot.workspace.queries.filter((q) => isQualityInspectionQuery(q.id)),
      ] },
    };
    const unchanged = documentFingerprint(this.ports.project()) === documentFingerprint(comparison);
    this.markClean(savedState);
    // Revalidate inside the reducer too: React may have queued newer edits.
    if (unchanged) this.ports.update((p) => documentFingerprint(p) === documentFingerprint(comparison)
      ? { ...savedState, connections: p.connections } : p);
    this.ports.message(`Project saved → ${path}`);
    this.ports.error(unchanged ? null : "Project saved, but newer edits remain unsaved. The current project is still open.");
    await this.ports.remember(path).catch((error) => this.report(error));
    // An edit during MRU persistence must also stop Save-before-replace.
    return unchanged && !this.isDirty();
  }

  applyLoaded(loaded: Project, pathHint?: string, labId?: string) {
    this.generation++;
    const currentConnections = this.ports.project().connections;
    const next = migrateProject({ ...loaded,
      connections: currentConnections.length ? currentConnections : loaded.connections ?? [],
      sources: loaded.sources ?? [], root_path: loaded.root_path ?? pathHint,
    });
    this.baseline = labId ? null : documentFingerprint(next);
    this.ports.update(() => next);
    this.ports.reset(next, labId);
    void this.ports.refreshExport(next.last_dbt_export_path);
    this.ports.error(null);
    const exportPath = next.last_dbt_export_path;
    if (!exportPath) return;
    const generation = this.generation;
    const fingerprint = documentFingerprint(next);
    void this.ports.syncMaps(next.workspace, exportPath).then((synced) => {
      this.ports.update((p) => generation === this.generation && documentFingerprint(p) === fingerprint
        ? { ...p, workspace: synced.workspace } : p);
    }).catch(() => { /* Missing export tree: keep project maps. */ });
  }
}
