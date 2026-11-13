import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { cancelRunningQuery, joinDiagnostics, prepareJoinInputs, joinPrepareStatus,
  joinPrepareProgress, previewWorkspace } from "../../lib/bridge";
import { JoinDiagnosticsController, type JoinInput, type JoinPorts } from "./controller";

/** React adapter only; no duplicate Join lifecycle state or request orchestration. */
export function useJoinDiagnostics(options: JoinInput & Pick<JoinPorts,
  "isCurrent" | "preemptPreview" | "sampleWorkspace" | "showData">) {
  const current = useRef(options);
  current.current = options;
  const owner = useRef<JoinDiagnosticsController | null>(null);
  if (!owner.current) owner.current = new JoinDiagnosticsController({
    current: () => current.current,
    isCurrent: (context) => current.current.isCurrent(context),
    host: { diagnostics: joinDiagnostics, prepare: prepareJoinInputs, status: joinPrepareStatus,
      progress: joinPrepareProgress, preview: previewWorkspace, cancel: cancelRunningQuery },
    preemptPreview: () => current.current.preemptPreview(),
    sampleWorkspace: (...args) => current.current.sampleWorkspace(...args),
    showData: () => current.current.showData(),
  });
  const controller = owner.current;
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useLayoutEffect(() => {
    controller.syncContext();
    void controller.refreshStatus();
    return controller.reset;
  }, [controller, options.context, options.skipStatus]);
  const context = options.context;
  const visible = state.context === context;
  let lensLease: number | undefined;
  return { controller,
    diag: visible ? state.diag : null, error: visible ? state.error : null,
    diagnosticsLoading: visible && state.diagnosticsLoading,
    prepareLoading: visible && state.prepareLoading, lensBusy: visible && state.lensBusy,
    prepareLabel: visible ? state.prepareLabel : null,
    sample: visible ? state.sample : null, progress: visible ? state.progress : null,
    onPrepareBusy: (busy: boolean) => {
      if (busy) lensLease = controller.lensPrepareBusy(context, true);
      else controller.lensPrepareBusy(context, false, lensLease);
    },
  };
}
