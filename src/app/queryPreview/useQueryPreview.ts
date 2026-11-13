import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { cancelRunningQuery, previewWorkspace } from "../../lib/bridge";
import type { Project, Workspace } from "../../types/pipeline";
import { QueryPreviewController, type QueryPreviewInput } from "./controller";

/** React wiring only: the controller owns the entire Data preview lifecycle. */
export function useQueryPreview(options: {
  project: Project;
  workspace: Workspace | null;
  enabled: boolean;
  surface: string;
  clientError(message: string | null): void;
}) {
  const { project, workspace, enabled, surface } = options;
  const input = useMemo<QueryPreviewInput>(() => ({ project, workspace, enabled, surface }),
    [project, workspace, enabled, surface]);
  const current = useRef(input);
  current.current = input;
  const errorPort = useRef(options.clientError);
  errorPort.current = options.clientError;
  const owner = useRef<QueryPreviewController | null>(null);
  if (!owner.current) owner.current = new QueryPreviewController({
    current: () => current.current,
    preview: previewWorkspace,
    cancel: cancelRunningQuery,
    clientError: (message) => errorPort.current(message),
  });
  const controller = owner.current;
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [selectionRequest, requestSelection] = useState(0);
  useEffect(() => {
    controller.autoPreview();
    return controller.invalidate;
  }, [controller, input, selectionRequest]);
  useEffect(() => {
    if (surface === "quality") controller.cancel();
  }, [controller, surface]);
  const navigationChanged = () => {
    // Explicit same-target navigation is a new preview request, not identity reuse.
    controller.preempt();
    requestSelection((n) => n + 1);
  };
  return {
    controller, navigationChanged,
    preview: state.input === input ? state.result : null,
    phase: state.input === input ? state.phase : workspace ? "queued" as const : "idle" as const,
    mode: state.input === input ? state.mode : "sample" as const,
    loading: state.input === input && state.loading,
  };
}
