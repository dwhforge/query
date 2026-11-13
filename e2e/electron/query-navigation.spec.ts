import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import { launchIsolatedSession, closeIsolatedSession } from "./helpers/launch.mjs";

let session: Awaited<ReturnType<typeof launchIsolatedSession>>;
test.beforeEach(async () => { session = await launchIsolatedSession(); });
test.afterEach(async () => {
  // Explicit test-only discard AFTER assertions: dirty Matching blocks beforeunload.
  if (session?.page && !session.page.isClosed()) {
    await session.page.evaluate(() => {
      const w = window as any;
      for (const s of w.__dwhE2eGetMatchingSessions()) w.__dwhE2eOpenMatchingSession({ ...s, hasUnsavedDecisions: false });
    });
    await expect.poll(() => session.page.evaluate(() =>
      (window as any).__dwhE2eGetMatchingSessions().some((s: any) => s.hasUnsavedDecisions))).toBe(false);
  }
  await closeIsolatedSession(session);
});

async function openLab(page: Page) {
  await page.getByRole("tab", { name: "Help Lab", exact: true }).click();
  const title = JSON.parse(fs.readFileSync("fixtures/labs/catalog.json", "utf8"))
    .find((c: any) => c.id === "recon_ship_sales").title;
  await page.locator("article").filter({ has: page.getByRole("heading", { name: title, exact: true }) })
    .getByRole("button", { name: "Open lab", exact: true }).click();
  await page.getByRole("button", { name: "Show me where to start", exact: true }).click();
  await expect(page.getByTestId("lens-open-matching")).toBeVisible();
}
const activeMatching = (page: Page) => page.locator('[aria-hidden="false"]')
  .filter({ has: page.getByTestId("matching-data-origin") });

async function openMatching(page: Page) {
  await page.getByTestId("lens-open-matching").click();
  await expect(activeMatching(page).getByTestId("matching-open-lens")).toBeEnabled();
  return page.evaluate(() => (window as any).__dwhE2eGetMatchingSessions()[0]);
}

test("Matching returns to its original JOIN after selecting another Query, retaining its draft", async () => {
  const { page } = session;
  await openLab(page);
  const before = await page.evaluate(() => (window as any).__dwhE2eGetProject());
  const matching = await openMatching(page);
  expect(matching.lensCtx.hostQueryId).toBe("dirty_recon");
  expect(matching.lensCtx.navigationTarget).toBeTruthy();
  await page.evaluate((s: any) => (window as any).__dwhE2eOpenMatchingSession({ ...s,
    instructionText: "Retained original Join draft", hasUnsavedDecisions: true }), matching);
  await page.getByRole("tab", { name: "Pipeline canvas", exact: true }).click();
  await page.getByRole("button", { name: "Inspect mapped example", exact: true }).click();
  await expect(page.getByRole("heading", { name: "sales_mapped", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: matching.title, exact: true }).click();
  await activeMatching(page).getByTestId("matching-open-lens").click();
  await expect(page.getByTestId("join-lens-no-match")).toBeVisible();
  await expect(page.getByTestId("preview-context")).toHaveText("dirty_recon · through s1 Join");
  const after = await page.evaluate(() => (window as any).__dwhE2eGetProject());
  expect(after).toEqual(before);
  const retained = await page.evaluate(() => (window as any).__dwhE2eGetMatchingSessions()[0]);
  expect(retained.instructionText).toBe("Retained original Join draft");
  expect(retained.hasUnsavedDecisions).toBe(true);
});

for (const change of ["missing", "replaced"] as const) {
  test(`Matching refuses an original JOIN that is ${change}, not a random current JOIN`, async () => {
    const { page } = session;
    await openLab(page);
    const matching = await openMatching(page);
    await page.getByRole("tab", { name: "Pipeline canvas", exact: true }).click();
    await page.getByRole("button", { name: "Inspect mapped example", exact: true }).click();
    await page.evaluate((change: string) => (window as any).__dwhE2ePatchProject((p: any) => ({ ...p,
      workspace: { ...p.workspace, queries: change === "missing"
        ? p.workspace.queries.filter((q: any) => q.id !== "dirty_recon")
        : p.workspace.queries.map((q: any) => q.id !== "dirty_recon" ? q : { ...q,
          steps: q.steps.map((s: any) => s.type !== "Join" ? s : { ...s, payload: { ...s.payload, join_type: "inner" } }) }) },
    })), change);
    await page.getByRole("tab", { name: matching.title, exact: true }).click();
    await expect(activeMatching(page).getByTestId("matching-open-lens")).toBeDisabled();
    await expect(activeMatching(page).getByTestId("matching-lens-unavailable")).toContainText("removed or changed");
    await page.getByRole("tab", { name: "Pipeline canvas", exact: true }).click();
    await expect(page.getByRole("heading", { name: "sales_mapped", exact: true })).toBeVisible();
  });
}

test("Help Lab Show me shares ordinary selection hydration, preserves keyboard focus and sample preview", async () => {
  const { page } = session;
  await openLab(page);
  const before = await page.evaluate(() => (window as any).__dwhE2eGetProject());
  await page.getByRole("button", { name: "Inspect monthly reconciliation", exact: true }).click();
  await expect(page.getByText("qty_gap_t", { exact: true }).first()).toBeAttached();
  const show = page.getByRole("button", { name: "Show me where to start", exact: true });
  await show.focus();
  await page.keyboard.press("Enter");
  await expect(show).toBeFocused();
  await expect(page.getByRole("heading", { name: "dirty_recon", exact: true })).toBeVisible();
  const join = before.workspace.queries.find((q: any) => q.id === "dirty_recon").steps.find((s: any) => s.type === "Join");
  await expect(page.locator('select[title="This query (before Join)"]').first()).toHaveValue(join.payload.left_on[0]);
  await expect(page.locator('select[title="Right query"]').first()).toHaveValue(join.payload.right_on[0]);
  await expect(page.getByTestId("join-lens-no-match")).toBeVisible();
  await expect(page.getByTestId("preview-scope")).toHaveText("Sample · LIMIT 50");
  await expect(page.getByTestId("preview-context")).toHaveText("dirty_recon · through s1 Join");
  expect(await page.evaluate(() => (window as any).__dwhE2eGetProject())).toEqual(before);
});

test("late diagnostic sample cannot reopen stale panels after rapid query switching", async () => {
  const { page } = session;
  await openLab(page);
  await page.getByRole("button", { name: "Find gaps", exact: true }).click();
  const left = page.getByRole("button", { name: /^Left input rows/ });
  await expect(left).toBeVisible();
  await page.evaluate(() => (window as any).__dwhE2eArmPreviewHold());
  try {
    await left.click();
    await page.evaluate(() => (window as any).__dwhE2eWaitPreviewStarted());
    await page.getByRole("button", { name: "Inspect mapped example", exact: true }).click();
    await page.getByRole("button", { name: "Inspect monthly reconciliation", exact: true }).click();
    await page.getByRole("button", { name: "Show me where to start", exact: true }).click();
  } finally {
    await page.evaluate(() => (window as any).__dwhE2eReleasePreviewHold());
  }
  await page.evaluate(() => (window as any).__dwhE2eWaitPreviewSettled());
  await expect(page.getByText("Left input (before Join)", { exact: true })).toHaveCount(0);
  await expect(left).toHaveCount(0);
  await expect(page.getByTestId("preview-context")).toHaveText("dirty_recon · through s1 Join");
  await expect(page.getByTestId("join-lens-no-match")).toBeVisible();
});

test("same-query workspace switch clears diagnostics and refuses a held sample on return", async () => {
  const { page } = session;
  await openLab(page);
  await page.getByRole("button", { name: "Find gaps", exact: true }).click();
  const left = page.getByRole("button", { name: /^Left input rows/ });
  await expect(left).toBeVisible();
  await page.evaluate(() => (window as any).__dwhE2eArmPreviewHold());
  try {
    await left.click();
    await page.evaluate(() => (window as any).__dwhE2eWaitPreviewStarted());
    await page.getByRole("tab", { name: "Help Lab", exact: true }).click();
    await page.getByRole("tab", { name: "Pipeline canvas", exact: true }).click();
  } finally {
    await page.evaluate(() => (window as any).__dwhE2eReleasePreviewHold());
  }
  await page.evaluate(() => (window as any).__dwhE2eWaitPreviewSettled());
  await expect(page.getByText("Left input (before Join)", { exact: true })).toHaveCount(0);
  await expect(left).toHaveCount(0);
  await expect(page.getByTestId("preview-context")).toHaveText("dirty_recon · through s1 Join");
  await expect(page.getByRole("button", { name: "Find gaps", exact: true })).toBeEnabled();
});

test("Show me from the same Join dismisses a diagnostic sample and restores its ordinary preview", async () => {
  const { page } = session;
  await openLab(page);
  await page.getByRole("button", { name: "Find gaps", exact: true }).click();
  await page.getByRole("button", { name: /^Left input rows/ }).click();
  await expect(page.getByText("Left input (before Join)", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Show me where to start", exact: true }).click();
  await expect(page.getByText("Left input (before Join)", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("join-lens-no-match")).toBeVisible();
  await expect(page.getByTestId("preview-context")).toHaveText("dirty_recon · through s1 Join");
});
