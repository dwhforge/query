import { test, expect } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import { launchIsolatedSession, closeIsolatedSession } from "./helpers/launch.mjs";
import { FIXTURE_PLAN, FIXTURE_CANDIDATES, fixtureProposals } from "../../src/app/matching/fixtures";
import { applyDecision } from "../../src/app/matching/reviewLogic";
import { emptyMatchingSession } from "../../src/app/matching/types";

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
  const empty = emptyMatchingSession({ id: "save-fixture", title: "Matching: Save test fixture",
    targetMapId: target === "no_id" ? undefined : "save_test", entry: "mapping", scope: "cohort",
    instructionText: "Explicit test fixture; no live retrieval", plan: FIXTURE_PLAN,
    hasUnsavedDecisions: false, chatCollapsed: true });
  const session = applyDecision({ ...empty, candidates: FIXTURE_CANDIDATES,
    proposals: fixtureProposals(1) }, "prop:a1-eurpope", "choose_alternative", "cand:2");
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
