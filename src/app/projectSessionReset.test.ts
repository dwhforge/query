import assert from "node:assert/strict";
import { emptyProject } from "../types/pipeline";
import { createRequestGen, nextRequestGen, isCurrentRequest } from "../lib/requestGen";
import { initialTabs, openTab, mappingTab, matchingTab, QUALITY_WORKSPACE_TAB } from "./workbench/tabs";
import { resetProjectSession, type ProjectSessionResetPorts } from "./projectSessionReset";

for (const labId of [undefined, "recon_ship_sales", "mapping_quality", "other"]) {
  const values: Record<string, unknown> = {};
  let tabs = openTab(openTab(openTab(initialTabs(), mappingTab("m")), matchingTab("s")), QUALITY_WORKSPACE_TAB);
  const generation = createRequestGen();
  const oldRequest = nextRequestGen(generation);
  const ports = Object.fromEntries([
    "setLabTask", "setKeyMapTabs", "setMatchingTabs", "setSelectedKeyMapId", "setSelectedStepIndex",
    "setActiveQueryId", "setPreview", "setPreviewSnapshot", "setPreviewPhase", "setPreviewMode",
    "setLoading", "setModelPreview", "setModelError", "setError", "setDiagView", "setJoinDiag", "setJoinDiagError",
    "setJoinDiagLoading", "setJoinPrepareLoading", "setLensPrepareBusy", "setJoinPrepareLabel", "setOpProgress",
    "setFrozenRemap", "setCheckDeltaNote", "setCheckAllowNote",
    "setSelectedExternalKey", "setSelectedSourceId", "setCheckSetup", "setMapPickPending",
    "setMapSwitchOffer", "setLensFocusHint",
  ].map((key) => [key, (value: unknown) => { values[key] = value; }])) as unknown as ProjectSessionResetPorts;
  ports.setWorkbenchTabs = (fn) => { tabs = fn(tabs); };
  ports.invalidatePreview = () => { nextRequestGen(generation); };
  ports.clearCheckFingerprint = () => { values.checkFingerprint = null; };
  const project = emptyProject("loaded");
  resetProjectSession(ports, project, labId);
  assert.equal(isCurrentRequest(generation, oldRequest), false);
  assert.equal(tabs.active.kind, labId === "mapping_quality" ? "quality" : "query");
  assert.deepEqual(tabs.tabs.map((t) => t.kind), labId === "mapping_quality" ? ["query", "help_lab", "quality"] : ["query", "help_lab"]);
  assert.deepEqual(values.setKeyMapTabs, []);
  assert.deepEqual(values.setMatchingTabs, []);
  assert.equal(values.setPreviewPhase, "idle");
  assert.equal(values.setPreviewMode, "sample");
  assert.equal(values.setLoading, false);
  assert.equal(values.setJoinDiagLoading, false);
  assert.equal(values.setJoinPrepareLoading, false);
  assert.equal(values.setLensPrepareBusy, false);
  assert.equal(values.setJoinPrepareLabel, null);
  assert.equal(values.setOpProgress, null);
  assert.equal(values.setError, null);
  assert.equal(values.setActiveQueryId, project.workspace.focus_query_id || null);
  assert.equal(values.setSelectedStepIndex, null);
  if (labId === "recon_ship_sales") assert.equal((values.setLabTask as { projectUid: string }).projectUid, project.project_uid);
  else assert.equal(values.setLabTask, null);
  for (const key of ["setPreview", "setPreviewSnapshot", "setModelPreview", "setModelError", "setDiagView", "setJoinDiag", "setJoinDiagError", "setFrozenRemap", "setCheckDeltaNote", "setCheckAllowNote", "checkFingerprint", "setSelectedExternalKey", "setSelectedSourceId", "setCheckSetup", "setMapPickPending", "setMapSwitchOffer", "setLensFocusHint"]) {
    assert.equal(values[key], null, key);
  }
}
console.log("projectSessionReset tests passed");
