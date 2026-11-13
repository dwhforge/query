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
    await page.evaluate((p) => (window as any).__dwhE2eOpenProject(p), projectPath);
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
});
