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
    "setActiveQueryId", "setModelPreview", "setModelError", "setError",
    "setOpProgress",
    "setFrozenRemap", "setCheckDeltaNote", "setCheckAllowNote",
    "setSelectedExternalKey", "setSelectedSourceId", "setCheckSetup", "setMapPickPending",
    "setMapSwitchOffer", "setLensFocusHint",
  ].map((key) => [key, (value: unknown) => { values[key] = value; }])) as unknown as ProjectSessionResetPorts;
  ports.setWorkbenchTabs = (fn) => { tabs = fn(tabs); };
  let resets = 0;
  ports.resetPreview = () => { resets++; nextRequestGen(generation); };
  let joinResets = 0;
  ports.resetJoin = () => { joinResets++; };
  ports.clearCheckFingerprint = () => { values.checkFingerprint = null; };
  const project = emptyProject("loaded");
  resetProjectSession(ports, project, labId);
  assert.equal(isCurrentRequest(generation, oldRequest), false);
  assert.equal(tabs.active.kind, labId === "mapping_quality" ? "quality" : "query");
  assert.deepEqual(tabs.tabs.map((t) => t.kind), labId === "mapping_quality" ? ["query", "help_lab", "quality"] : ["query", "help_lab"]);
  assert.deepEqual(values.setKeyMapTabs, []);
  assert.deepEqual(values.setMatchingTabs, []);
  assert.equal(resets, 1);
  assert.equal(joinResets, 1);
  assert.equal(values.setOpProgress, null);
  assert.equal(values.setError, null);
  assert.equal(values.setActiveQueryId, project.workspace.focus_query_id || null);
  assert.equal(values.setSelectedStepIndex, null);
  if (labId === "recon_ship_sales") assert.equal((values.setLabTask as { projectUid: string }).projectUid, project.project_uid);
  else assert.equal(values.setLabTask, null);
  for (const key of ["setModelPreview", "setModelError", "setFrozenRemap", "setCheckDeltaNote", "setCheckAllowNote", "checkFingerprint", "setSelectedExternalKey", "setSelectedSourceId", "setCheckSetup", "setMapPickPending", "setMapSwitchOffer", "setLensFocusHint"]) {
    assert.equal(values[key], null, key);
  }
}
console.log("projectSessionReset tests passed");
