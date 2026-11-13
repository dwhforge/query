import {
  formatJoinPrepareHint, formatJoinPrepareStatusHint,
  type joinDiagnostics, type prepareJoinInputs, type joinPrepareStatus,
  type joinPrepareProgress, type previewWorkspace,
  type JoinDiagnostics, type JoinDiagSample, projectRefContext,
} from "../../lib/bridge";
import { isHostCancelled } from "../../lib/hostRpc";
import { createRequestGen, nextRequestGen, isCurrentRequest } from "../../lib/requestGen";
import type { ColumnMetadata } from "../../types/pipeline";
import type { Project, Workspace } from "../../types/pipeline";
import type { QueryContext } from "../queryNavigation";
import type { JoinDiagKind } from "../../components/JoinDiagnosticsPanel";
import type { OpProgressState } from "../../components/OpProgress";

export type JoinInput = { project: Project; context: QueryContext; skipStatus: boolean };
export type DiagnosticView = {
  label: string; columns: ColumnMetadata[]; rows: unknown[][];
  totalCount: number; sampleLimit: number; highlightKeys: string[];
  mapSide?: "left" | "right";
};
export type JoinState = {
  context: QueryContext | null;
  diag: JoinDiagnostics | null; error: string | null;
  diagnosticsLoading: boolean; prepareLoading: boolean; lensBusy: boolean;
  prepareLabel: string | null; sample: DiagnosticView | null;
  progress: OpProgressState | null;
};
export interface JoinPorts {
  current(): JoinInput;
  isCurrent(context: QueryContext): boolean;
  host: {
    diagnostics: typeof joinDiagnostics; prepare: typeof prepareJoinInputs;
    status: typeof joinPrepareStatus; progress: typeof joinPrepareProgress;
    preview: typeof previewWorkspace; cancel(): Promise<unknown>;
  };
  preemptPreview(): void;
  sampleWorkspace(input: JoinInput, diag: JoinDiagnostics, kind: JoinDiagKind): Workspace;
  showData(): void;
  interval?(callback: () => void): () => void;
}
const empty = (context: QueryContext | null): JoinState => ({ context, diag: null,
  error: null, diagnosticsLoading: false, prepareLoading: false, lensBusy: false,
  prepareLabel: null, sample: null, progress: null });

/** Join scenario only. Host lanes and QueryContext remain existing mechanisms. */
export class JoinDiagnosticsController {
  private state = empty(null);
  private listeners = new Set<() => void>();
  private generation = createRequestGen();
  private statusGeneration = 0;
  private sampleGeneration = 0;
  private stopPoll: (() => void) | null = null;
  constructor(private ports: JoinPorts) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<JoinState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  private stopPolling() { this.stopPoll?.(); this.stopPoll = null; }
  private invalidate() {
    nextRequestGen(this.generation); this.statusGeneration++; this.sampleGeneration++;
    this.stopPolling();
  }
  reset = () => { this.invalidate(); this.publish(empty(null)); };
  syncContext = () => {
    const { context } = this.ports.current();
    if (this.state.context === context) return;
    this.invalidate(); this.publish(empty(context));
  };
  private capture() {
    this.syncContext();
    const input = this.ports.current();
    const { queryId, stepIndex } = input.context;
    const step = stepIndex == null ? null : input.project.workspace.queries.find((q) => q.id === queryId)?.steps[stepIndex];
    return queryId && stepIndex != null && step?.type === "Join"
      ? { ...input, queryId, stepIndex, step } : null;
  }
  private current(context: QueryContext, generation: number) {
    return isCurrentRequest(this.generation, generation) && this.ports.isCurrent(context);
  }
  private poll(context: QueryContext, generation: number, fallback: string) {
    this.stopPolling();
    let alive = true;
    let latest = 0;
    const tick = () => {
      const request = ++latest;
      void this.ports.host.progress().then((p) => {
        if (!alive || request !== latest || !this.current(context, generation) || !Number.isFinite(p.fraction)) return;
        if (!p.active && p.fraction <= 0) return;
        this.publish({ progress: { kind: "prepare", phase: p.message || p.stage || fallback,
          percent: Math.round(Math.min(1, Math.max(0, p.fraction)) * 100) } });
      }).catch(() => {});
    };
    const stop = this.ports.interval ? this.ports.interval(tick) : (() => {
      const timer = setInterval(tick, 250); return () => clearInterval(timer);
    })();
    this.stopPoll = () => { alive = false; stop(); };
  }
  refreshStatus = async () => {
    const input = this.capture();
    const status = ++this.statusGeneration;
    if (!input || input.skipStatus) { this.publish({ prepareLabel: null }); return; }
    const generation = this.generation.gen;
    const valid = () => status === this.statusGeneration && this.current(input.context, generation);
    try {
      const result = await this.ports.host.status(input.project.workspace, input.queryId, input.stepIndex,
        input.project.sources ?? [], input.project.connections ?? [], projectRefContext(input.project));
      if (!valid()) return;
      this.publish({ prepareLabel: result.prepared ? formatJoinPrepareStatusHint(result) : result.stale
        ? "Loaded sides are outdated — Reload sides after graph/source changes" : null });
    } catch { if (valid()) this.publish({ prepareLabel: null }); }
  };
  run = async (kind: "prepare" | "diagnostics") => {
    const input = this.capture();
    if (!input) return;
    const { left_on, right_on } = input.step.payload;
    if (!left_on.length || left_on.length !== right_on.length) {
      this.publish({ error: `Set join keys and Apply before ${kind === "prepare" ? "preparing inputs" : "running diagnostics"}.` });
      return;
    }
    const force = !!this.state.prepareLabel;
    this.invalidate();
    const generation = this.generation.gen;
    this.ports.preemptPreview();
    void this.ports.host.cancel().catch(() => {});
    this.publish({ error: null, sample: null, lensBusy: false,
      prepareLoading: kind === "prepare", diagnosticsLoading: kind === "diagnostics",
      progress: { kind: "prepare", phase: kind === "prepare" ? "Queued…" : "Diagnostics — materializing sides…", percent: kind === "prepare" ? 1 : 5 } });
    this.poll(input.context, generation, kind === "prepare" ? "Preparing…" : "Diagnostics…");
    try {
      const args = [input.project.workspace, input.queryId, input.stepIndex,
        input.project.connections ?? [], input.project.sources ?? []] as const;
      if (kind === "prepare") {
        const result = await this.ports.host.prepare(...args, force, projectRefContext(input.project));
        if (!this.current(input.context, generation)) return;
        this.publish({ prepareLabel: formatJoinPrepareHint(result) });
      } else {
        const diag = await this.ports.host.diagnostics(...args, projectRefContext(input.project));
        if (!this.current(input.context, generation)) return;
        this.publish({ diag });
      }
    } catch (error) {
      if (!this.current(input.context, generation)) return;
      this.publish({ ...(kind === "diagnostics" ? { diag: null } : {}),
        error: isHostCancelled(error) ? null : error instanceof Error ? error.message : String(error) });
    } finally {
      if (this.current(input.context, generation)) {
        this.stopPolling();
        this.publish({ prepareLoading: false, diagnosticsLoading: false, progress: null });
        if (kind === "diagnostics") void this.refreshStatus();
      }
    }
  };
  /** Callback is bound to the Lens render that started preparation. */
  lensPrepareBusy(context: QueryContext, busy: boolean, lease?: number) {
    if (!this.ports.isCurrent(context)) return;
    this.syncContext();
    if (!busy) {
      if (!this.state.lensBusy || lease !== this.generation.gen) return;
      this.stopPolling(); nextRequestGen(this.generation);
      this.publish({ lensBusy: false, progress: null });
      void this.refreshStatus();
      return;
    }
    this.invalidate();
    this.ports.preemptPreview();
    this.publish({ lensBusy: true, prepareLoading: false, diagnosticsLoading: false,
      progress: { kind: "prepare", phase: "Loading join sides for sample…", percent: 8 } });
    this.poll(context, this.generation.gen, "Loading join sides…");
    return this.generation.gen;
  }
  cancel = (interruptHost = true) => {
    this.invalidate();
    this.publish({ prepareLoading: false, diagnosticsLoading: false, lensBusy: false, progress: null });
    if (interruptHost) void this.ports.host.cancel().catch(() => {});
  };
  clearSample = () => { this.sampleGeneration++; this.publish({ sample: null }); };
  openSample = async (kind: JoinDiagKind, sample: JoinDiagSample | null, label: string) => {
    const input = this.capture();
    const diag = this.state.diag;
    if (!input || !diag) return;
    const request = ++this.sampleGeneration;
    const generation = this.generation.gen;
    const valid = () => request === this.sampleGeneration && this.current(input.context, generation) && this.state.diag === diag;
    const highlightKeys = kind === "right" || kind === "unmatched_right" || kind === "right_dups" ? diag.right_on
      : kind === "fanout" ? [...diag.left_on, ...diag.right_on] : diag.left_on;
    try {
      if (!sample) this.ports.preemptPreview();
      const result = sample ?? await this.ports.host.preview(this.ports.sampleWorkspace(input, diag, kind),
        input.project.connections ?? [], input.project.sources ?? [], projectRefContext(input.project));
      if (!valid()) return;
      this.publish({ sample: { label, columns: result.columns, rows: result.rows,
        totalCount: sample ? sample.total_count : kind === "left" ? diag.left_count : kind === "right" ? diag.right_count : diag.output_count,
        sampleLimit: diag.sample_limit, highlightKeys,
        mapSide: kind === "unmatched_left" ? "left" : kind === "unmatched_right" ? "right" : undefined } });
      this.ports.showData();
    } catch (error) {
      if (valid() && !isHostCancelled(error)) this.publish({ error: String(error) });
    }
  };
}
