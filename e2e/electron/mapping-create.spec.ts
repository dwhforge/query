/**
 * Electron UI smoke for query-based mapping create (v0.3.1 / ADR-0034).
 * Real desktop stack: Electron + dwh-host + DuckDB describe — not a mocked bridge.
 */
import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import {
  launchApp,
  openCreateWizard,
  openFixtureProject,
  wizard,
} from "./helpers/launch.mjs";

test.describe.configure({ mode: "serial" });

test.describe("mapping create Electron smoke", () => {
  let app: Awaited<ReturnType<typeof launchApp>>["app"];
  let page: Awaited<ReturnType<typeof launchApp>>["page"];
  let home: string;
  let userData: string;
  let fixtureWorkDir: string;

  test.beforeAll(async () => {
    ({ app, page, home, userData } = await launchApp());
    const opened = await openFixtureProject(page);
    fixtureWorkDir = opened.dir;
  });

  test.afterAll(async () => {
    await app?.close().catch(() => {});
    for (const p of [home, userData, fixtureWorkDir]) {
      try {
        if (p) fs.rmSync(p, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  test("1) create without Fields patches → editor once", async () => {
    await openCreateWizard(page);
    const dlg = wizard(page);
    await dlg.getByPlaceholder("Supplier products → catalog").fill("Wide map");
    await dlg.locator("select").nth(0).selectOption("catalog_wide");
    await dlg.locator("select").nth(1).selectOption("catalog_wide");
    await dlg.getByRole("button", { name: "Next" }).click();
    await expect(dlg.getByText("Source key", { exact: false })).toBeVisible({
      timeout: 60_000,
    });
    await dlg.getByRole("button", { name: "product_id" }).first().click();
    await dlg.getByRole("button", { name: "product_id" }).nth(1).click();
    await dlg.getByRole("button", { name: "Next" }).click();
    await expect(dlg.getByText("Queries will not change.")).toBeVisible();
    await dlg.getByRole("button", { name: "Create and open" }).click();
    await expect(dlg).toBeHidden({ timeout: 60_000 });
    await expect(page.getByRole("tab", { name: "Wide map" })).toBeVisible({
      timeout: 30_000,
    });
  });

  test("2) source + target restore → patches applied", async () => {
    await openCreateWizard(page);
    const dlg = wizard(page);
    await dlg.getByPlaceholder("Supplier products → catalog").fill("Restored");
    await dlg.locator("select").nth(0).selectOption("supplier_products");
    await dlg.locator("select").nth(1).selectOption("catalog_products");
    await dlg.getByRole("button", { name: "Next" }).click();
    await expect(
      dlg.getByText("Source — excluded by last Fields", { exact: true }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(
      dlg.getByText("Target — excluded by last Fields", { exact: true }),
    ).toBeVisible();
    async function includeCol(name: string) {
      const rows = dlg.locator("li").filter({ hasText: name });
      const n = await rows.count();
      for (let i = 0; i < n; i++) {
        const row = rows.nth(i);
        const mono = (await row.locator(".font-mono").innerText()).trim();
        if (mono === name) {
          await row.getByRole("button", { name: "Include" }).click();
          return;
        }
      }
      throw new Error(`Include control for ${name} not found`);
    }
    await includeCol("supplier_id");
    await includeCol("product_id");
    await dlg.getByRole("button", { name: "supplier_id" }).click();
    await dlg.getByRole("button", { name: "product_id" }).click();
    await dlg.getByRole("button", { name: "Next" }).click();
    await expect(dlg.getByText(/supplier_products \/ Fields/)).toBeVisible();
    await expect(dlg.getByText(/catalog_products \/ Fields/)).toBeVisible();
    await dlg.getByRole("button", { name: "Update Fields and create map" }).click();
    await expect(dlg).toBeHidden({ timeout: 60_000 });
    await expect(page.getByRole("tab", { name: "Restored" })).toBeVisible({
      timeout: 30_000,
    });
  });

  test("3) back → change target after restore → review without old restores", async () => {
    await openCreateWizard(page);
    const dlg = wizard(page);
    await dlg.getByPlaceholder("Supplier products → catalog").fill("Retarget");
    await dlg.locator("select").nth(0).selectOption("supplier_products");
    await dlg.locator("select").nth(1).selectOption("catalog_products");
    await dlg.getByRole("button", { name: "Next" }).click();
    await expect(dlg.getByText("Include").first()).toBeVisible({
      timeout: 60_000,
    });
    // Include a catalog-only restore (product_id).
    const includeBtns = dlg.getByRole("button", { name: "Include" });
    const n = await includeBtns.count();
    for (let i = 0; i < n; i++) {
      const btn = includeBtns.nth(i);
      const row = btn.locator("xpath=ancestor::li[1]");
      const label = (await row.locator(".font-mono").innerText()).trim();
      if (label === "product_id") await btn.click();
    }
    await dlg.getByRole("button", { name: "Back" }).click();
    await dlg.locator("select").nth(1).selectOption("catalog_wide");
    await dlg.getByRole("button", { name: "Next" }).click();
    await expect(dlg.getByText("Source key", { exact: false })).toBeVisible({
      timeout: 60_000,
    });
    // product_id restore on old target must not block; pick keys from source output / restores.
    // Source still supplier — pick product_name (always on output) and target product_id from wide.
    await dlg.getByRole("button", { name: "product_name" }).click();
    await dlg.getByRole("button", { name: "product_id" }).click();
    await dlg.getByRole("button", { name: "Next" }).click();
    await expect(dlg.getByText("Cannot restore Fields on missing query")).toHaveCount(0);
    await expect(dlg.getByText("Retarget")).toBeVisible();
    await dlg.getByRole("button", { name: /Create and open|Update Fields/ }).click();
    await expect(dlg).toBeHidden({ timeout: 60_000 });
  });

  test("4) cancel during describe → reopen ignores stale reply", async () => {
    await openCreateWizard(page);
    const dlg = wizard(page);
    await dlg.getByPlaceholder("Supplier products → catalog").fill("CancelRace");
    await dlg.locator("select").nth(0).selectOption("catalog_wide");
    await dlg.locator("select").nth(1).selectOption("catalog_wide");

    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dwh = (window as any).dwh;
      const orig = dwh.invoke.bind(dwh);
      dwh.invoke = async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "describe_workspace") {
          await new Promise((r) => setTimeout(r, 2500));
        }
        return orig(cmd, args);
      };
    });

    await dlg.getByRole("button", { name: "Next" }).click();
    await expect(dlg.getByRole("button", { name: "Loading schema…" })).toBeVisible();
    // Confirm discard.
    page.once("dialog", (d) => d.accept());
    await dlg.getByRole("button", { name: "Cancel" }).click();
    await expect(dlg).toBeHidden();

    // Reopen fresh session — should be on keys, not fields from late describe.
    await openCreateWizard(page);
    const dlg2 = wizard(page);
    await expect(dlg2.getByText("Name", { exact: true })).toBeVisible();
    const fieldsHeading = dlg2.getByText("Source key (order = From)", {
      exact: true,
    });
    await expect(fieldsHeading).toHaveCount(0);
    // Wait out the delayed invoke so it cannot flip the new session.
    await page.waitForTimeout(3000);
    await expect(fieldsHeading).toHaveCount(0);
    page.once("dialog", (d) => d.accept());
    await dlg2.getByRole("button", { name: "Cancel" }).click();
  });

  test("5) upstream def change after review → refuse, draft kept", async () => {
    await openCreateWizard(page);
    const dlg = wizard(page);
    await dlg.getByPlaceholder("Supplier products → catalog").fill("StaleSchema");
    await dlg.locator("select").nth(0).selectOption("catalog_wide");
    await dlg.locator("select").nth(1).selectOption("catalog_wide");
    await dlg.getByRole("button", { name: "Next" }).click();
    await expect(
      dlg.getByText("Source key (order = From)", { exact: true }),
    ).toBeVisible({ timeout: 60_000 });
    await dlg.getByRole("button", { name: "product_id" }).first().click();
    await dlg.getByRole("button", { name: "name" }).nth(1).click();
    await dlg.getByRole("button", { name: "Next" }).click();
    await expect(dlg.getByText("Queries will not change.")).toBeVisible();

    // Mutate query steps after review (basis fingerprint drift). Wizard keeps draft.
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any;
      w.__dwhE2ePatchProject((p: {
        workspace: { queries: Array<{ id: string; steps: unknown[] }> };
      }) => ({
        ...p,
        workspace: {
          ...p.workspace,
          queries: p.workspace.queries.map((q) =>
            q.id === "catalog_wide"
              ? {
                  ...q,
                  steps: [...q.steps, { type: "Limit", payload: { n: 1 } }],
                }
              : q,
          ),
        },
      }));
    });
    await expect(
      dlg.getByText(/Workspace queries changed/i),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      dlg.getByText("Source key (order = From)", { exact: true }),
    ).toHaveCount(0);
    await expect(dlg.getByPlaceholder("Supplier products → catalog")).toHaveValue(
      "StaleSchema",
    );
    await expect(page.getByRole("tab", { name: "StaleSchema" })).toHaveCount(0);
    // Clear name so Cancel skips the discard confirm.
    await dlg.getByPlaceholder("Supplier products → catalog").fill("");
    await dlg.getByRole("button", { name: "Cancel" }).click();
    await expect(dlg).toBeHidden();
  });

  test("6) source key to → review shows to_2 → create → save keeps context", async () => {
    await openCreateWizard(page);
    const dlg = wizard(page);
    await dlg.getByPlaceholder("Supplier products → catalog").fill("ToKeyMap");
    await dlg.locator("select").nth(0).selectOption("supplier_products");
    await dlg.locator("select").nth(1).selectOption("catalog_wide");
    await dlg.getByRole("button", { name: "Next" }).click();
    await expect(dlg.getByText("Include").first()).toBeVisible({
      timeout: 60_000,
    });
    const includeBtns = dlg.getByRole("button", { name: "Include" });
    const n = await includeBtns.count();
    for (let i = 0; i < n; i++) {
      const btn = includeBtns.nth(i);
      const row = btn.locator("xpath=ancestor::li[1]");
      const label = (await row.locator(".font-mono").innerText()).trim();
      if (label === "to") await btn.click();
    }
    await dlg.getByRole("button", { name: /^to$/ }).click();
    await dlg.getByRole("button", { name: "product_id" }).click();
    await dlg.getByRole("button", { name: "Next" }).click();
    await expect(dlg.getByText("to_2")).toBeVisible();
    await expect(dlg.getByText(/Authoring:/)).toBeVisible();
    await dlg.getByRole("button", { name: /Update Fields and create map/ }).click();
    await expect(dlg).toBeHidden({ timeout: 60_000 });
    await expect(page.getByRole("tab", { name: "ToKeyMap" })).toBeVisible({
      timeout: 30_000,
    });

    const outPath = path.join(
      fixtureWorkDir,
      `_e2e_saved_${Date.now()}.dwhproj.json`,
    );
    await page.evaluate(async (p) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any;
      if (typeof w.__dwhE2eSaveProject !== "function") {
        throw new Error("__dwhE2eSaveProject missing");
      }
      await w.__dwhE2eSaveProject(p);
    }, outPath);
    await expect
      .poll(() => fs.existsSync(outPath), { timeout: 30_000 })
      .toBe(true);
    const raw = fs.readFileSync(outPath, "utf8");
    expect(raw).toContain("authoring_context");
    expect(raw).toMatch(/"to_column"\s*:\s*"to_2"/);
    fs.unlinkSync(outPath);
  });
});
