import type { Project } from "../types/pipeline";
import { startLabTask, type LabTaskSession } from "../help/reconLab";
import { openTab, resetProjectTabs, QUALITY_WORKSPACE_TAB, type WorkbenchTabs } from "./workbench/tabs";

/** Explicit React adapter surface: no Project data is stored in navigation. */
export interface ProjectSessionResetPorts {
  setLabTask(value: LabTaskSession | null): void;
  setKeyMapTabs(value: []): void;
  setMatchingTabs(value: []): void;
  setSelectedKeyMapId(value: null): void;
  setWorkbenchTabs(update: (tabs: WorkbenchTabs) => WorkbenchTabs): void;
  setSelectedStepIndex(value: number | null): void;
  setActiveQueryId(value: string | null): void;
  resetPreview(): void;
  setModelPreview(value: null): void;
  setModelError(value: null): void;
  setError(value: null): void;
  resetJoin(): void;
  setOpProgress(value: null): void;
  setFrozenRemap(value: null): void;
  setCheckDeltaNote(value: null): void;
  setCheckAllowNote(value: null): void;
  clearCheckFingerprint(): void;
  setSelectedExternalKey(value: null): void;
  setSelectedSourceId(value: null): void;
  setCheckSetup(value: null): void;
  setMapPickPending(value: null): void;
  setMapSwitchOffer(value: null): void;
  setLensFocusHint(value: null): void;
}

/** Only called by committed replacement. Cancellation never enters this path. */
export function resetProjectSession(ports: ProjectSessionResetPorts, project: Project, labId?: string) {
  ports.resetPreview();
  ports.setLabTask(labId ? startLabTask(labId, project.project_uid) : null);
  ports.setKeyMapTabs([]);
  ports.setMatchingTabs([]);
  ports.setSelectedKeyMapId(null);
  ports.setWorkbenchTabs((tabs) => {
    const reset = resetProjectTabs(tabs, true);
    return labId === "mapping_quality" ? openTab(reset, QUALITY_WORKSPACE_TAB) : reset;
  });
  const focused = project.workspace.queries.find((q) => q.id === project.workspace.focus_query_id);
  ports.setSelectedStepIndex(focused?.steps.length ? focused.steps.length - 1 : null);
  ports.setActiveQueryId(project.workspace.focus_query_id || null);
  ports.setModelPreview(null);
  ports.setModelError(null);
  ports.setError(null);
  ports.resetJoin();
  ports.setOpProgress(null);
  ports.setFrozenRemap(null);
  ports.setCheckDeltaNote(null);
  ports.setCheckAllowNote(null);
  ports.clearCheckFingerprint();
  ports.setSelectedExternalKey(null);
  ports.setSelectedSourceId(null);
  ports.setCheckSetup(null);
  ports.setMapPickPending(null);
  ports.setMapSwitchOffer(null);
  ports.setLensFocusHint(null);
}
