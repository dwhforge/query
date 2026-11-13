import { test, expect } from "@playwright/test";
import { launchIsolatedSession, closeIsolatedSession } from "./helpers/launch.mjs";

test.describe("execution confidence", () => {
  let session: Awaited<ReturnType<typeof launchIsolatedSession>>;
  test.beforeEach(async () => { session = await launchIsolatedSession(); });
  test.afterEach(async () => { await closeIsolatedSession(session); });

  test("changing query never presents old rows while its new preview is pending", async ({}, info) => {
    const { page } = session;
    await expect.poll(() => page.getByRole("row").count()).toBeGreaterThan(0);
    await page.evaluate(() => (window as any).__dwhE2eArmPreviewHold());
    try {
      await page.getByText("catalog_wide", { exact: true }).first().click();
      await page.evaluate(() => (window as any).__dwhE2eWaitPreviewStarted());
      await expect(page.getByRole("heading", { name: "catalog_wide", exact: true })).toBeVisible();
      await page.screenshot({ path: info.outputPath("pending-query.png") });
      if (process.env.DWH_CAPTURE_EVIDENCE === "1") await page.screenshot({ path: "docs/stabilization/execution-pending-after.png" });
      await expect(page.getByRole("row")).toHaveCount(0, { timeout: 3000 });
      await expect(page.getByText("Computing preview…", { exact: true })).toBeVisible();
    } finally {
      await page.evaluate(() => (window as any).__dwhE2eReleasePreviewHold());
    }
    await page.evaluate(() => (window as any).__dwhE2eWaitPreviewSettled());
    await expect.poll(() => page.getByRole("row").count()).toBeGreaterThan(0);
  });

  test("Cancel drops a pending preview and late completion cannot restore it", async () => {
    const { page } = session;
    await expect.poll(() => page.getByRole("row").count()).toBeGreaterThan(0);
    await page.evaluate(() => (window as any).__dwhE2eArmPreviewHold());
    try {
      await page.getByText("catalog_wide", { exact: true }).first().click();
      await page.evaluate(() => (window as any).__dwhE2eWaitPreviewStarted());
      await page.getByRole("button", { name: "Cancel", exact: true }).last().click();
      await expect(page.getByText("Preview cancelled. Recompute when ready.", { exact: true })).toBeVisible({ timeout: 3000 });
    } finally {
      await page.evaluate(() => (window as any).__dwhE2eReleasePreviewHold());
    }
    await page.evaluate(() => (window as any).__dwhE2eWaitPreviewSettled());
    await expect(page.getByText("Preview cancelled. Recompute when ready.", { exact: true })).toBeVisible();
    await expect(page.getByRole("row")).toHaveCount(0);
    await page.getByTestId("preview-recompute").click();
    await expect.poll(() => page.getByRole("row").count()).toBeGreaterThan(0);
  });

  test("failed preview reports error instead of an unexplained waiting state", async ({}, info) => {
    const { page } = session;
    await expect.poll(() => page.getByRole("row").count()).toBeGreaterThan(0);
    const original = await page.evaluate(() => (window as any).__dwhE2eGetProject());
    await page.evaluate(() => (window as any).__dwhE2ePatchProject((p: any) => ({ ...p,
      workspace: { ...p.workspace, queries: p.workspace.queries.map((q: any) => q.id === "supplier_products"
        ? { ...q, steps: [{ type: "LoadCsv", payload: { path: "/missing-pr04-data.csv", path_kind: "absolute" } }] } : q) },
    })));
    await expect(page.getByText(/missing-pr04-data/).first()).toBeVisible();
    await page.screenshot({ path: info.outputPath("failed-preview.png") });
    if (process.env.DWH_CAPTURE_EVIDENCE === "1") await page.screenshot({ path: "docs/stabilization/execution-error-after.png" });
    await expect(page.getByText("Preview failed. See the error above, then recompute.", { exact: true })).toBeVisible({ timeout: 3000 });
    await page.evaluate((original: any) => (window as any).__dwhE2ePatchProject(() => original), original);
    await page.getByTestId("preview-recompute").click();
    await expect.poll(() => page.getByRole("row").count()).toBeGreaterThan(0);
  });

  test("empty-result is distinguished from loading and failure", async () => {
    const { page } = session;
    await page.evaluate(() => (window as any).__dwhE2ePatchProject((p: any) => ({ ...p,
      workspace: { ...p.workspace, queries: p.workspace.queries.map((q: any) => q.id === "supplier_products"
        ? { ...q, steps: [...q.steps, { type: "Filter", payload: { condition: "false" } }] } : q) },
    })));
    await expect(page.getByText("No rows returned for this preview.", { exact: true })).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId("preview-scope")).toHaveText("Sample · LIMIT 50");
  });

  test("heavy-sample offers full output even when the selected query has no Join", async () => {
    const { page } = session;
    await page.evaluate(() => (window as any).__dwhE2ePatchProject((p: any) => ({ ...p,
      workspace: { ...p.workspace,
        key_maps: [{ id: "large_map", name: "Large seed", storage: { kind: "seed" }, entries:
          Array.from({ length: 5000 }, (_, i) => ({ from: `unused_${i}`, to: `same_${i}` })) }],
        queries: p.workspace.queries.map((q: any) => q.id === "supplier_products" ? { ...q,
          steps: [...q.steps, { type: "ApplyKeyMap", payload: { column: "product_name", map_id: "large_map", entries: [] } }] } : q),
      },
    })));
    await expect.poll(() => page.getByRole("row").count()).toBeGreaterThan(0);
    await expect(page.getByTestId("preview-scope")).toHaveText("Sample · LIMIT 50");
    await page.getByTestId("preview-load-full").click({ timeout: 5000 });
    await expect(page.getByTestId("preview-scope")).toHaveText("Full preview");
    await page.getByTestId("preview-load-sample").click();
    await expect(page.getByTestId("preview-scope")).toHaveText("Sample · LIMIT 50");
    await page.getByText("catalog_wide", { exact: true }).first().click();
    await expect(page.getByTestId("preview-scope")).toHaveText("Sample · LIMIT 50");
  });

  test("an older held reply cannot overwrite a newer query result", async () => {
    const { page } = session;
    await expect(page.getByRole("row")).toHaveCount(2);
    await page.evaluate(() => (window as any).__dwhE2eArmPreviewHold());
    try {
      await page.getByText("catalog_wide", { exact: true }).first().click();
      await page.evaluate(() => (window as any).__dwhE2eWaitPreviewStarted());
      await page.getByText("supplier_products", { exact: true }).first().click();
      await expect(page.getByRole("row")).toHaveCount(2);
    } finally {
      await page.evaluate(() => (window as any).__dwhE2eReleasePreviewHold());
    }
    await page.evaluate(() => (window as any).__dwhE2eWaitPreviewSettled());
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByRole("row")).toHaveCount(2);
    await expect(page.getByTestId("preview-context")).toHaveText("supplier_products · final output");
  });
});
