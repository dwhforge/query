import { test, expect } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import { launchIsolatedSession, closeIsolatedSession } from "./helpers/launch.mjs";
import { applyDecision } from "../../src/app/matching/reviewLogic";
import { emptyMatchingSession, type MatchingPlanDraft } from "../../src/app/matching/types";

// Synthetic live evidence for persistence tests ONLY. Not production demo output,
// not a demo-policy bypass, and not evidence that live retrieval has run.
const SAVE_TEST_PLAN: MatchingPlanDraft = {
  sourceRef: "save_test_source", targetRef: "save_test_target",
  mapKeyFields: ["provider", "region"], targetIdentityFields: ["id"],
  comparisons: [{ sourceField: "provider", targetField: "name", role: "soft_signal" }],
  normalization: ["trim"], outputs: ["id"], ambiguity: "leave_for_manual",
  scope: "cohort", semanticRevision: 1, uiRevision: 0,
};

let appSession: Awaited<ReturnType<typeof launchIsolatedSession>>;
test.beforeEach(async () => { appSession = await launchIsolatedSession(); });
test.afterEach(async () => {
  // Negative tests intentionally leave a dirty draft. Explicitly discard that
  // test-only state after assertions; do not let beforeunload block app.close().
  if (appSession?.page && !appSession.page.isClosed()) {
    await appSession.page.evaluate(() => {
      const w = window as any;
      for (const session of w.__dwhE2eGetMatchingSessions()) {
        w.__dwhE2eOpenMatchingSession({ ...session, hasUnsavedDecisions: false });
      }
    });
    await expect.poll(() => appSession.page.evaluate(() =>
      (window as any).__dwhE2eGetMatchingSessions().some((s: any) => s.hasUnsavedDecisions))).toBe(false);
  }
  await closeIsolatedSession(appSession);
});

async function prepare(target: "present" | "missing" | "no_id" = "present", failSeed = false) {
  const { page, projectPath } = appSession;
  const empty = emptyMatchingSession({ id: "save-fixture", title: "Matching: Synthetic save test",
    targetMapId: target === "no_id" ? undefined : "save_test", entry: "mapping", scope: "cohort",
    instructionText: "Injected synthetic live evidence; retrieval not exercised", plan: SAVE_TEST_PLAN,
    hasUnsavedDecisions: false, chatCollapsed: true });
  const session = applyDecision({ ...empty, candidates: [{
    candidateId: "cand:2", targetId: "2", outputValues: ["2"],
    fields: { id: "2", name: "Synthetic save target" }, evidenceRevision: 1,
  }], proposals: [{
    proposalId: "prop:a1-eurpope", mapKey: ["a1", "Eurpope"],
    sourceValues: { provider: "a1", region: "Eurpope" }, affectedSourceRows: 1,
    proposedCandidateId: "cand:2", alternativeCandidateIds: [], state: "proposed",
    provenance: "manual", semanticPlanRevision: 1, evidenceRevision: 1,
    searchIncomplete: false, evidence: [{ field: "provider", note: "Synthetic E2E evidence; no live retrieval" }],
  }] }, "prop:a1-eurpope", "choose_alternative", "cand:2");
  await page.evaluate(({ session, target, failSeed, projectPath }) => {
    const w = window as any;
    w.__dwhE2ePatchProject((p: any) => ({ ...p,
      last_dbt_export_path: failSeed ? projectPath : undefined,
      workspace: { ...p.workspace, key_maps: target === "missing" ? [] : [{
        id: "save_test", name: "Save test", storage: { kind: "seed" },
        from_columns: ["provider", "region"], output_columns: ["id"], entries: [],
      }] },
    }));
    w.__dwhE2eOpenMatchingSession(session);
  }, { session, target, failSeed, projectPath });
  await expect(page.getByTestId("matching-save")).toBeEnabled();
}

const currentDraft = () => appSession.page.evaluate(() => (window as any).__dwhE2eGetMatchingSessions()[0]);

for (const target of ["missing", "no_id"] as const) {
  test(`Matching Save refuses ${target} target without settling the draft`, async () => {
    const { page } = appSession;
    await prepare(target);
    await page.getByTestId("matching-save").click();
    await expect(page.getByText(/Save refused:/)).toBeVisible();
    expect((await currentDraft()).hasUnsavedDecisions).toBe(true);
    expect((await currentDraft()).proposals.find((p: any) => p.proposalId === "prop:a1-eurpope").state).toBe("confirmed_in_draft");
    await expect(page.getByText(/Mapping save acknowledged/)).toBeHidden();
    await expect(page.getByTestId("matching-save")).toBeEnabled();
  });
}

test("Matching seed failure keeps a retryable draft and no success copy", async () => {
  const { page } = appSession;
  await prepare("present", true); // Existing project file cannot be an export directory.
  await page.getByTestId("matching-save").click();
  await expect(page.getByText(/Save (error|conflict):/)).toBeVisible();
  expect((await currentDraft()).hasUnsavedDecisions).toBe(true);
  await expect(page.getByText(/Mapping save acknowledged/)).toBeHidden();
  await expect(page.getByTestId("matching-save")).toBeEnabled();
  // Retrying must get past host stale-baseline validation and reach the same
  // actual failed seed write, not claim already_matches as successful Saved.
  await page.getByTestId("matching-save").click();
  await expect(page.getByText(/Save (error|conflict):/)).toBeVisible();
  expect((await currentDraft()).hasUnsavedDecisions).toBe(true);
});

test("Matching acknowledges a real local save; project save/reopen retains exactly one tuple", async () => {
  const { page, fixtureWorkDir } = appSession;
  await prepare();
  await page.getByTestId("matching-save").click();
  await expect(page.getByText(/Mapping save acknowledged/)).toBeVisible();
  expect((await currentDraft()).hasUnsavedDecisions).toBe(false);
  await expect(page.getByTestId("matching-save")).toBeDisabled();
  const savedPath = path.join(fixtureWorkDir, "matching-saved.dwhproj.json");
  await page.evaluate((savedPath) => (window as any).__dwhE2eSaveProject(savedPath), savedPath);
  const bytes = JSON.parse(fs.readFileSync(savedPath, "utf8"));
  expect(bytes.workspace.key_maps[0].entries).toHaveLength(1);
  expect(bytes.workspace.key_maps[0].entries[0].output_values).toEqual(["2"]);
  await page.evaluate((savedPath) => (window as any).__dwhE2eOpenProject(savedPath), savedPath);
  await expect.poll(() => page.evaluate(() => (window as any).__dwhE2eGetMatchingSessions().length)).toBe(0);
  const loaded = await page.evaluate(() => (window as any).__dwhE2eGetProject());
  expect(loaded.workspace.key_maps[0].entries).toHaveLength(1);
  expect(loaded.workspace.key_maps[0].entries[0].from_parts).toEqual(["a1", "Eurpope"]);
});

test("Live trial reports unavailable; explicit detached demo cannot write to the user's map", async () => {
  const { page } = appSession;
  await prepare();
  const original = await currentDraft();
  const active = () => page.locator('[aria-hidden="false"]').filter({ has: page.getByTestId("matching-data-origin") });
  await expect(active().getByTestId("matching-data-origin")).toContainText("Live matching unavailable");
  await active().getByTestId("matching-apply-plan").click();
  expect(await currentDraft()).toEqual(original); // No fixture plan/results/metrics, no lost decision.
  await expect(active().getByText(/Live matching unavailable:/)).toHaveCount(2); // Banner + attempted-run error.

  await active().getByTestId("matching-open-demo").click();
  await expect(active().getByTestId("matching-data-origin")).toContainText("sample data only");
  const sessions = await page.evaluate(() => (window as any).__dwhE2eGetMatchingSessions());
  expect(sessions).toHaveLength(2);
  expect(sessions[0]).toEqual(original);
  expect(sessions[1].executionMode).toBe("demo");
  expect(sessions[1].targetMapId).toBeUndefined();
  expect(sessions[1].lensCtx).toBeUndefined();
  expect(sessions[1].proposals).toHaveLength(0); // Entry itself never auto-runs.
  await active().getByTestId("matching-apply-plan").click();
  await expect(active().getByTestId("matching-bulk-confirm")).toBeEnabled();
  await active().getByTestId("matching-bulk-confirm").click();
  await expect(active().getByTestId("matching-save")).toBeDisabled();
  // Even a test-only attachment to a real map cannot authorize demo persistence.
  await page.evaluate(() => {
    const w = window as any;
    const demo = w.__dwhE2eGetMatchingSessions().find((s: any) => s.executionMode === "demo");
    w.__dwhE2eOpenMatchingSession({ ...demo, targetMapId: "save_test" });
  });
  await expect(active().getByTestId("matching-save")).toBeDisabled();
  await expect(active().getByTestId("matching-data-origin")).toContainText("Writing to Mapping is blocked");
  const project = await page.evaluate(() => (window as any).__dwhE2eGetProject());
  expect(project.workspace.key_maps[0].entries).toEqual([]);
  const retained = await page.evaluate(() => (window as any).__dwhE2eGetMatchingSessions());
  expect(retained[0]).toEqual(original);
  expect(retained[1].hasUnsavedDecisions).toBe(true);
});

test("Fixture provenance in a live session does not authorize Mapping Save", async () => {
  const { page } = appSession;
  await prepare();
  await page.evaluate(() => {
    const w = window as any;
    const s = w.__dwhE2eGetMatchingSessions()[0];
    w.__dwhE2eOpenMatchingSession({ ...s,
      proposals: s.proposals.map((p: any) => ({ ...p, provenance: "fixture" })) });
  });
  await expect(page.getByTestId("matching-save")).toBeDisabled();
  expect((await currentDraft()).hasUnsavedDecisions).toBe(true);
  const project = await page.evaluate(() => (window as any).__dwhE2eGetProject());
  expect(project.workspace.key_maps[0].entries).toEqual([]);
});
