import type { Project, Workspace, PreviewResult } from "../../types/pipeline";
import type { previewWorkspace } from "../../lib/bridge";
import { projectRefContext } from "../../lib/bridge";
import { isHostCancelled } from "../../lib/hostRpc";
import { createRequestGen, nextRequestGen, isCurrentRequest } from "../../lib/requestGen";
import {
  HeavyPreviewCache, heavyPreviewCacheKey, isHeavyPreviewFocus,
  workspaceForPreviewTransport, PREVIEW_SAMPLE_LIMIT, type HeavyPreviewMode,
} from "../../lib/previewTransport";
import type { PreviewPhase } from "../../help/previewState";

/** Ephemeral execution input. App still owns selection and Join scope construction. */
export type QueryPreviewInput = {
  project: Project;
  workspace: Workspace | null;
  enabled: boolean;
  surface: string;
};
export type QueryPreviewState = {
  input: QueryPreviewInput | null;
  result: PreviewResult | null;
  phase: PreviewPhase;
  mode: HeavyPreviewMode;
  loading: boolean;
};
export interface QueryPreviewPorts {
  current(): QueryPreviewInput;
  preview: typeof previewWorkspace;
  cancel(): Promise<unknown>;
  clientError(message: string | null): void;
}
export interface PreviewClock {
  set(callback: () => void, delay: number): unknown;
  clear(timer: unknown): void;
}
const clock: PreviewClock = {
  set: (callback, delay) => setTimeout(callback, delay),
  clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};
const idle = (): QueryPreviewState => ({ input: null, result: null, phase: "idle", mode: "sample", loading: false });

/** Query Data only, not a scheduler for diagnostics/Matching or a second host lane. */
export class QueryPreviewController {
  private generation = createRequestGen();
  private cache = new HeavyPreviewCache();
  private cacheOwner: Project | null = null;
  private timer: unknown = null;
  private state = idle();
  private listeners = new Set<() => void>();

  constructor(private ports: QueryPreviewPorts, private timers: PreviewClock = clock) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(state: QueryPreviewState) {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
  private clearTimer() {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }
  /** Also used for effect cleanup/unmount. Does not interrupt another host owner. */
  invalidate = () => {
    this.clearTimer();
    nextRequestGen(this.generation);
  };
  private isCurrent(input: QueryPreviewInput, request: number) {
    return isCurrentRequest(this.generation, request) && this.ports.current() === input;
  }
  private validateCache(project: Project) {
    const old = this.cacheOwner;
    if (!old || old.workspace !== project.workspace || old.connections !== project.connections ||
      old.sources !== project.sources || old.root_path !== project.root_path || old.project_uid !== project.project_uid ||
      old.references !== project.references || old.connection_bindings !== project.connection_bindings ||
      old.execution_engine !== project.execution_engine || old.target_dialect !== project.target_dialect) this.cache.clear();
    this.cacheOwner = project;
  }
  /** Actual input/availability changes schedule; QueryContext revisions do not. */
  autoPreview = () => {
    this.invalidate();
    const input = this.ports.current();
    this.validateCache(input.project);
    this.publish({ ...idle(), input, phase: input.workspace ? "queued" : "idle" });
    if (!input.enabled || !input.workspace) return;
    this.timer = this.timers.set(() => {
      this.timer = null;
      if (this.ports.current() === input) void this.run("sample");
    }, 150);
  };
  run = async (mode: HeavyPreviewMode = "sample") => {
    this.invalidate();
    const input = this.ports.current();
    const ws = input.workspace;
    if (!ws) return;
    this.validateCache(input.project);
    const request = nextRequestGen(this.generation);
    const base = { input, result: null, phase: "running" as const, mode, loading: true };
    this.publish(base);
    const focus = ws.focus_query_id;
    const key = focus && isHeavyPreviewFocus(ws, focus) ? heavyPreviewCacheKey(ws, focus, mode) : null;
    const cached = key ? this.cache.get(key) : null;
    if (cached) {
      this.publish({ ...base, result: cached, phase: "ready", loading: false });
      this.ports.clientError(null);
      return;
    }
    try {
      const result = await this.ports.preview(workspaceForPreviewTransport(ws),
        input.project.connections ?? [], input.project.sources ?? [], projectRefContext(input.project),
        mode === "full" ? { fullPreview: true } : { rowLimit: PREVIEW_SAMPLE_LIMIT });
      if (!this.isCurrent(input, request)) return;
      if (key) this.cache.set(key, result);
      this.publish({ ...base, result, phase: "ready", loading: false });
      this.ports.clientError(null);
    } catch (error) {
      if (!this.isCurrent(input, request)) return;
      if (isHostCancelled(error)) {
        this.publish({ ...base, phase: "cancelled", loading: false });
        return;
      }
      this.publish({ ...base, phase: "error", loading: false });
      this.ports.clientError(typeof error === "string" ? error : String(error));
    }
  };
  refresh = () => {
    this.cache.clear();
    return this.run(this.state.mode);
  };
  /** Analysis takes the lane; its owner separately invokes existing host cancel. */
  preempt = () => {
    this.invalidate();
    this.publish({ ...this.state, loading: false,
      phase: this.state.loading || this.state.phase === "queued" ? "cancelled" : this.state.phase });
  };
  cancel = () => {
    this.invalidate();
    if (this.state.loading || this.state.phase === "queued") {
      this.publish({ ...this.state, result: null, phase: "cancelled", loading: false });
    }
    void this.ports.cancel().catch(() => {});
  };
  /** One replacement-only reset; no document, Mapping or Matching mutation. */
  reset = () => {
    this.invalidate();
    this.cache.clear();
    this.cacheOwner = null;
    this.publish(idle());
  };
}
