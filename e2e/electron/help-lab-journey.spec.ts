import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import { launchIsolatedSession, closeIsolatedSession } from "./helpers/launch.mjs";

async function openLab(page: Page, id = "recon_ship_sales", discard = false) {
  await page.getByRole("tab", { name: "Help Lab", exact: true }).click();
  const catalog = JSON.parse(fs.readFileSync("fixtures/labs/catalog.json", "utf8"));
  const title = catalog.find((c: { id: string }) => c.id === id).title;
  await page.locator("article").filter({ has: page.getByRole("heading", { name: title, exact: true }) })
    .getByRole("button", { name: "Open lab", exact: true }).click();
  if (discard) {
    await page.getByRole("dialog", { name: "Save changes before switching projects?" })
      .getByRole("button", { name: "Discard", exact: true }).click();
  }
  await expect(page.getByRole("tab", { name: "Pipeline canvas", exact: true })).toHaveAttribute("aria-selected", "true");
}

async function inspectMappedRows(page: Page) {
  await page.getByRole("button", { name: "Inspect mapped example", exact: true }).click();
  await expect(page.getByRole("heading", { name: "sales_mapped", exact: true })).toBeVisible();
  await expect(page.getByTestId("preview-context")).toContainText("sales_mapped");
  // Navigation starts preview and Lens independently. Do not toggle the old
  // Lens while the destination preview is still queued/running. This scenario
  // checks Mapping recomputation; busy-navigation races have separate tests.
  await expect(page.getByTestId("preview-state")).toHaveCount(0);
  const lens = page.getByRole("button", { name: "Join Lens", exact: true });
  await expect(lens).toHaveAttribute("aria-pressed", "true");
  await lens.click();
  await expect(lens).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("preview-scope")).toHaveText("Sample · LIMIT 50");
}

test.describe("flagship Help Lab journey", () => {
  let session: Awaited<ReturnType<typeof launchIsolatedSession>>;
  test.beforeEach(async () => { session = await launchIsolatedSession(); });
  test.afterEach(async () => { await closeIsolatedSession(session); });

  test("task explains the problem, starts at the Join, dismisses and restores", async ({}, info) => {
    const { page } = session;
    await openLab(page);
    const card = page.getByTestId("lab-task-card");
    await expect(card.getByRole("heading", { name: "Why don't these SKUs match?" })).toBeVisible();
    await expect(card).toContainText("partially prepared mapped example");
    await page.screenshot({ path: info.outputPath("task-card.png") });
    await page.getByText("sales_mapped", { exact: true }).first().click();
    await page.getByRole("tab", { name: "Model", exact: true }).click();
    await card.getByRole("button", { name: "Show me where to start", exact: true }).click();
    await expect(page.getByRole("heading", { name: "dirty_recon", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Data", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("button", { name: "Join Lens", exact: true })).toBeVisible();
    await card.getByRole("button", { name: "Dismiss", exact: true }).click();
    await page.getByRole("tab", { name: "Model", exact: true }).click();
    await page.getByRole("tab", { name: "Data", exact: true }).click();
    await expect(card).toBeHidden();
    await page.getByTestId("lab-task-reopen").click();
    await expect(card).toBeVisible();
  });

  test("another lab and an ordinary project never retain the flagship card", async () => {
    const { page, projectPath } = session;
    await expect(page.getByTestId("lab-task-card")).toBeHidden();
    await openLab(page);
    await expect(page.getByTestId("lab-task-card")).toBeVisible();
    await openLab(page, "name_id_match", true);
    await expect(page.getByTestId("lab-task-card")).toBeHidden();
    await expect(page.getByTestId("lab-task-reopen")).toBeHidden();
    await page.evaluate((p: string) => (window as any).__dwhE2eOpenProject(p), projectPath);
    await expect(page.getByRole("heading", { name: "supplier_products", exact: true })).toBeVisible();
    await expect(page.getByTestId("lab-task-card")).toBeHidden();
  });

  test("edited lab without original Join gets an honest unavailable start", async () => {
    const { page } = session;
    await openLab(page);
    await page.evaluate(() => (window as any).__dwhE2ePatchProject((p: any) => ({ ...p,
      workspace: { ...p.workspace, queries: p.workspace.queries.map((q: any) =>
        q.id === "dirty_recon" ? { ...q, steps: q.steps.filter((s: any) => s.type !== "Join") } : q) },
    })));
    await expect(page.getByTestId("lab-task-card").getByRole("button", { name: "Show me where to start" })).toBeDisabled();
    await expect(page.getByText("The original Join is no longer available in this edited lab.")).toBeVisible();
  });

  test("opt-in hint follows actual Join and No match state, then stays completed", async ({}, info) => {
    const { page } = session;
    await openLab(page);
    await expect(page.getByTestId("lab-hint")).toHaveCount(0);
    await page.getByRole("button", { name: "Show me where to start", exact: true }).click();
    await expect(page.getByTestId("lab-hint")).toHaveCount(1);
    await expect(page.getByTestId("join-lens-no-match")).toBeVisible();
    await expect(page.getByTestId("lab-hint")).toContainText("Open No match");
    await page.screenshot({ path: info.outputPath("no-match-hint.png") });
    // A different step does not require a prescribed click: observed state drives the goal.
    await page.locator('[data-step-type="FromQuery"] > [role="button"]').click();
    await expect(page.getByTestId("lab-hint")).toContainText("Inspect this Join");
    await page.locator('[data-step-type="Join"] > [role="button"]').click();
    await expect(page.getByTestId("lab-hint")).toContainText("Open No match");
    await page.getByTestId("join-lens-no-match").click();
    await expect(page.getByTestId("lab-hint")).toHaveCount(0);
    await expect(page.getByTestId("join-lens-no-match")).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "All rows", exact: true }).click();
    await expect(page.getByTestId("lab-hint")).toHaveCount(0);
    await page.getByRole("tab", { name: "Help Lab", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tab", { name: "Pipeline canvas", exact: true })).toHaveAttribute("aria-selected", "true");
  });

  test("No match keeps left result context and suggests from the right pane", async ({}, info) => {
    const { page } = session;
    await page.setViewportSize({ width: 1600, height: 1100 });
    await openLab(page);
    await page.getByRole("button", { name: "Inspect original join", exact: true }).click();
    await page.getByTestId("lab-task-card").getByRole("button", { name: "Dismiss", exact: true }).click();
    await page.getByRole("separator", { name: "Resize data panel", exact: true }).dblclick();
    await expect(page.getByTestId("preview-state")).toHaveCount(0);
    await page.getByTestId("join-lens-no-match").click();
    const left = page.getByTestId("join-lens-left-pane");
    const right = page.getByTestId("join-lens-right-pane");
    const context = left.locator('button[data-result-context="true"]');
    const ureaRows = page.getByRole("row").filter({ hasText: "COM-UREA" });
    await ureaRows.last().click();
    await expect(context).toHaveCount(2);
    await expect(context.first()).toContainText("COM-UREA");
    await expect(context.first()).toHaveAttribute("aria-pressed", "false");
    await expect(context.first()).toHaveClass(/border-sky-400/);
    await expect(right).toContainText("COM-UREA");
    await expect(page.getByRole("button", { name: "Suggest…", exact: true })).toHaveCount(1);
    // It must persist after the former 1.6-second flash timeout and pointer travel.
    await right.getByRole("button", { name: "Suggest…", exact: true }).hover();
    await page.waitForTimeout(1800);
    await expect(context.first()).toHaveClass(/border-sky-400/);
    await expect(ureaRows).toHaveCount(2);
    await page.getByRole("row").filter({ hasText: "COM-AMM" }).first().click();
    await expect(context.first()).toContainText("COM-AMM");
    await expect(right).toContainText("COM-AMM");
    // Right-side filtering must not hide the key action with the candidate list.
    await right.getByRole("searchbox").fill("no-such-right-key");
    await right.getByRole("button", { name: "Suggest…", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Suggest Right", exact: true });
    await expect(dialog).toContainText("COM-AMM");
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await page.screenshot({ path: info.outputPath("no-match-result-context.png") });
    await page.getByRole("button", { name: "All rows", exact: true }).click();
    await expect(context).toHaveCount(0);
    await expect(right.getByRole("button", { name: "Suggest…", exact: true })).toHaveCount(0);
  });

  test("No match hides joined rows and suggests with no unmatched right keys", async ({}, info) => {
    const { page } = session;
    await page.setViewportSize({ width: 1600, height: 1200 });
    await openLab(page, "name_region_match");
    await page.getByText("dirty_exact_pair", { exact: true }).first().click();
    await page.getByRole("separator", { name: "Resize data panel", exact: true }).dblclick();
    await expect(page.getByTestId("preview-state")).toHaveCount(0);
    await expect(page.getByRole("row").filter({ hasText: "ComputerParts LLC" }).first()).toBeVisible();
    await page.getByTestId("join-lens-no-match").click();
    const left = page.getByTestId("join-lens-left-pane");
    const right = page.getByTestId("join-lens-right-pane");
    await expect(right).toContainText("Use Suggest… to look for a right-side partner for the selected left key.");
    await expect(page.getByRole("row").filter({ hasText: "ComputerParts LLC" })).toHaveCount(0);
    await page.getByRole("row").filter({ hasText: "CPC LLC" }).click();
    const context = left.locator('button[data-result-context="true"]');
    await expect(context).toHaveCount(1);
    await expect(context).toContainText("Germany");
    await expect(context).toHaveAttribute("aria-pressed", "false");
    await expect(right).toContainText("CPC LLC");
    await expect(right).toContainText("Germany");
    await right.getByRole("button", { name: "Suggest…", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Suggest Right", exact: true });
    await expect(dialog).toContainText("CPC LLC");
    await expect(dialog).toContainText("Germany");
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await page.screenshot({ path: info.outputPath("no-match-composite-empty-right.png") });
    await page.getByRole("button", { name: /^(Save mapping…|Change…)$/ }).click();
    const mapDialog = page.getByRole("dialog", { name: "Add unmatched key to a KeyMap", exact: true });
    await expect(mapDialog).toBeVisible();
    await page.setViewportSize({ width: 738, height: 526 });
    const geometry = await mapDialog.locator("fieldset").evaluate((fieldset: HTMLElement) => {
      const card = fieldset.parentElement!;
      const bounds = card.getBoundingClientRect();
      return {
        fits: card.scrollWidth <= card.clientWidth + 1,
        inViewport: bounds.left >= 0 && bounds.right <= window.innerWidth && bounds.top >= 0 && bounds.bottom <= window.innerHeight,
        labelsFit: Array.from(fieldset.querySelectorAll("label")).every(label => {
          const r = label.getBoundingClientRect();
          return r.left >= bounds.left && r.right <= bounds.right;
        }),
      };
    });
    expect(geometry).toEqual({ fits: true, inViewport: true, labelsFit: true });
    await page.screenshot({ path: info.outputPath("mapping-picker-narrow.png") });
    await mapDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.setViewportSize({ width: 1600, height: 1200 });
    await page.getByRole("button", { name: "All rows", exact: true }).click();
    await expect(page.getByRole("row").filter({ hasText: "ComputerParts LLC" }).first()).toBeVisible();
  });

  test("alternative path, Got it, Escape and another lab do not revive hints", async () => {
    const { page } = session;
    await openLab(page);
    await page.getByTestId("join-lens-no-match").click();
    await page.getByRole("button", { name: "Show me where to start", exact: true }).click();
    await expect(page.getByTestId("lab-hint")).toHaveCount(0);
    await page.getByRole("button", { name: "All rows", exact: true }).click();
    await page.getByRole("button", { name: "Show me where to start", exact: true }).click();
    await page.getByTestId("lab-hint").getByRole("button", { name: "Got it", exact: true }).click();
    await page.getByRole("tab", { name: "Model", exact: true }).click();
    await page.getByRole("tab", { name: "Data", exact: true }).click();
    await expect(page.getByTestId("lab-hint")).toHaveCount(0);
    await page.getByRole("button", { name: "Show me where to start", exact: true }).click();
    await expect(page.getByTestId("lab-hint")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("lab-hint")).toHaveCount(0);
    await openLab(page, "name_id_match", true);
    await expect(page.getByTestId("lab-hint")).toHaveCount(0);
  });

  test("narrow layout and Model view use inline fallback without stealing focus", async ({}, info) => {
    const { page } = session;
    await openLab(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 820, height: 700 });
    await page.getByRole("button", { name: "Show me where to start", exact: true }).click();
    await page.getByRole("tab", { name: "Model", exact: true }).click();
    await expect(page.getByTestId("lab-hint")).toHaveCount(1);
    await expect(page.getByTestId("lab-hint")).toContainText("Open Join Lens in Data");
    await page.screenshot({ path: info.outputPath("narrow-hint-fallback.png") });
    await page.getByTestId("lab-hint").getByRole("button", { name: "Got it", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("lab-hint")).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Model", exact: true })).toHaveAttribute("aria-selected", "true");
  });

  test("comparison links show the actual original, prepared example and monthly previews", async ({}, info) => {
    const { page } = session;
    await openLab(page);
    const nav = page.getByRole("navigation", { name: "Lab comparison views" });
    await nav.getByRole("button", { name: "Inspect original join", exact: true }).click();
    await expect(page.getByRole("heading", { name: "dirty_recon", exact: true })).toBeVisible();
    await expect(page.getByTestId("join-lens-no-match")).toBeVisible();
    await nav.getByRole("button", { name: "Inspect mapped example", exact: true }).click();
    await expect(page.getByRole("heading", { name: "sales_mapped", exact: true })).toBeVisible();
    await expect(page.getByTestId("lab-task-card")).toContainText("partially prepared mapped example");
    // Existing Lens may render side tables too: a nonempty center preview is checked after turning it off.
    await page.getByRole("button", { name: "Join Lens", exact: true }).click();
    await expect.poll(() => page.getByRole("row").count()).toBeGreaterThan(0);
    await nav.getByRole("button", { name: "Inspect monthly reconciliation", exact: true }).click();
    await expect(page.getByRole("heading", { name: "recon_by_month", exact: true })).toBeVisible();
    await expect(page.getByText("qty_gap_t", { exact: true }).first()).toBeAttached();
    await expect.poll(() => page.getByRole("row").count()).toBeGreaterThan(0);
    await expect(page.getByTestId("lab-task-card")).toContainText("not full-input proof");
    await page.screenshot({ path: info.outputPath("monthly-comparison.png") });
    await expect(page.getByTestId("lab-hint")).toHaveCount(0);
  });

  test("comparison actions disable deleted targets instead of inventing results", async () => {
    const { page } = session;
    await openLab(page);
    await page.evaluate(() => (window as any).__dwhE2ePatchProject((p: any) => ({ ...p,
      workspace: { ...p.workspace, queries: p.workspace.queries.filter((q: any) => q.id !== "sales_mapped") },
    })));
    await expect(page.getByRole("button", { name: "Inspect mapped example", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Inspect original join", exact: true })).toBeEnabled();
  });

  test("mapped-row inspection waits for the destination preview before leaving Lens", async () => {
    const { page } = session;
    await openLab(page);
    await expect(page.getByTestId("preview-state")).toHaveCount(0);
    await page.evaluate(() => (window as any).__dwhE2eArmPreviewHold());
    const inspection = inspectMappedRows(page);
    // Attach immediately so a test failure cannot leave an unhandled rejection.
    const settled = inspection.then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
    try {
      await page.evaluate(() => (window as any).__dwhE2eWaitPreviewStarted());
      await expect(page.getByRole("heading", { name: "sales_mapped", exact: true })).toBeVisible();
      await expect(page.getByTestId("preview-state")).toBeVisible();
      await expect(page.getByRole("button", { name: "Join Lens", exact: true })).toHaveAttribute("aria-pressed", "true");
    } finally {
      await page.evaluate(() => (window as any).__dwhE2eReleasePreviewHold());
    }
    const result = await settled;
    if (!result.ok) throw result.error;
    await expect(page.getByRole("row").filter({ hasText: "COM-AMM" })).toHaveCount(2);
  });

  test("editing the existing partial map changes the recomputed example, without claiming full repair", async ({}, info) => {
    const { page } = session;
    try {
      await openLab(page);
      await inspectMappedRows(page);
      await expect(page.getByRole("row").filter({ hasText: "COM-AMM" })).toHaveCount(2);
      const project = await page.evaluate(() => (window as any).__dwhE2eGetProject());
      const map = project.workspace.key_maps.find((m: any) => m.id === "map_sku");
      await page.getByTestId(`pg-keymap-${map.name}`).click();
      await page.getByRole("button", { name: "Add row", exact: true }).click();
      await page.locator('input[data-col="from"]').last().fill("COM-AMM");
      await page.locator('input[data-col="to"]').last().fill("AMM-A");
      await page.getByRole("button", { name: "Save map", exact: true }).click();
      await page.getByRole("tab", { name: "Pipeline canvas", exact: true }).click();
      await inspectMappedRows(page);
      await page.getByTestId("preview-recompute").click();
      await expect(page.getByRole("row").filter({ hasText: "AMM-A" })).toHaveCount(2);
      await expect(page.getByRole("row").filter({ hasText: "COM-AMM" })).toHaveCount(0);
      await expect(page.getByTestId("lab-task-card")).toContainText("not a verified fix");
      await page.getByRole("button", { name: "Inspect monthly reconciliation", exact: true }).click();
      await expect(page.getByText("qty_gap_t", { exact: true }).first()).toBeAttached();
    } catch (error) {
      await page.screenshot({ path: info.outputPath("mapping-recompute-failure.png") }).catch(() => {});
      throw error;
    }
  });

  test("offline flagship No match is real inspectable evidence", async ({}, info) => {
    const { page } = session;
    await page.setViewportSize({ width: 1600, height: 1000 });
    await openLab(page);
    await page.getByRole("button", { name: "Show me where to start", exact: true }).click();
    await page.getByTestId("join-lens-no-match").click();
    await expect(page.getByTestId("lab-hint")).toHaveCount(0);
    const explanation = page.getByRole("button", { name: "Got it", exact: true });
    if (await explanation.isVisible()) await explanation.click();
    await expect(page.getByText("COM-AMM", { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId("preview-scope")).toHaveText("Sample · LIMIT 50");
    await page.screenshot({ path: info.outputPath("flagship-join-lens.png") });
    if (process.env.DWH_CAPTURE_EVIDENCE === "1") await page.screenshot({ path: "docs/stabilization/flagship-join-lens.png" });
  });
});
