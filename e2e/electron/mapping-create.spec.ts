/**
 * Electron UI smoke for query-based mapping create (v0.3.1 / ADR-0034).
 * Real desktop stack: Electron + dwh-host + DuckDB describe — not a mocked bridge.
 *
 * Each test launches a fresh app + materialized project (no shared mutable state).
 * Run one scenario alone: `npm run test:e2e:electron -- --grep "4)"`
 */
import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import {
  closeIsolatedSession,
  includeExcludedColumn,
  launchIsolatedSession,
  openCreateWizard,
  wizard,
} from "./helpers/launch.mjs";

type Session = Awaited<ReturnType<typeof launchIsolatedSession>>;

test.describe("mapping create Electron smoke", () => {
  let session: Session;

  test.beforeEach(async () => {
    session = await launchIsolatedSession();
  });

  test.afterEach(async () => {
    await closeIsolatedSession(session);
  });

  test("1) create without Fields patches → editor once", async () => {
    const { page } = session;
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

    const wideTabs = page.getByRole("tab", { name: "Wide map" });
    await expect(wideTabs).toHaveCount(1, { timeout: 30_000 });
    await expect(wideTabs).toBeVisible();

    const maps = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (window as any).__dwhE2eGetProject();
      return (p.workspace.key_maps ?? []).filter(
        (m: { name?: string }) => m.name === "Wide map",
      );
    });
    expect(maps).toHaveLength(1);
    expect(maps[0].authoring_context).toBeTruthy();
  });

  test("2) source + target restore → patches applied", async () => {
    const { page } = session;
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

    await includeExcludedColumn(dlg, "supplier_id");
    await includeExcludedColumn(dlg, "product_id");

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

    const fields = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (window as any).__dwhE2eGetProject();
      const qs = p.workspace.queries as Array<{
        id: string;
        steps: Array<{ type: string; payload?: { columns?: string[] } }>;
      }>;
      const lastCols = (id: string) => {
        const q = qs.find((x) => x.id === id);
        const last = q?.steps[q.steps.length - 1];
        return last?.type === "SelectColumns" ? last.payload?.columns ?? [] : [];
      };
      return {
        supplier: lastCols("supplier_products"),
        catalog: lastCols("catalog_products"),
      };
    });
    expect(fields.supplier).toEqual(
      expect.arrayContaining(["product_name", "category", "supplier_id"]),
    );
    expect(fields.catalog).toEqual(
      expect.arrayContaining(["name", "product_id"]),
    );
  });

  test("3) back → change target after restore → review without old restores", async () => {
    const { page } = session;
    await openCreateWizard(page);
    const dlg = wizard(page);
    await dlg.getByPlaceholder("Supplier products → catalog").fill("Retarget");
    await dlg.locator("select").nth(0).selectOption("supplier_products");
    await dlg.locator("select").nth(1).selectOption("catalog_products");
    await dlg.getByRole("button", { name: "Next" }).click();
    await expect(
      dlg.getByText("Target — excluded by last Fields", { exact: true }),
    ).toBeVisible({ timeout: 60_000 });

    // Fresh fixture: product_id is still excluded on catalog_products.
    // includeExcludedColumn asserts Include exists and flips to Remove.
    await includeExcludedColumn(dlg, "product_id");

    await dlg.getByRole("button", { name: "Back" }).click();
    await dlg.locator("select").nth(1).selectOption("catalog_wide");
    await dlg.getByRole("button", { name: "Next" }).click();
    await expect(dlg.getByText("Source key", { exact: false })).toBeVisible({
      timeout: 60_000,
    });
    // Old catalog_products restore must not block review after retarget.
    await dlg.getByRole("button", { name: "product_name" }).click();
    await dlg.getByRole("button", { name: "product_id" }).click();
    await dlg.getByRole("button", { name: "Next" }).click();
    await expect(dlg.getByText("Cannot restore Fields on missing query")).toHaveCount(
      0,
    );
    await expect(dlg.getByText(/catalog_products \/ Fields/)).toHaveCount(0);
    await expect(dlg.getByText("Retarget")).toBeVisible();
    await dlg.getByRole("button", { name: /Create and open|Update Fields/ }).click();
    await expect(dlg).toBeHidden({ timeout: 60_000 });
  });

  test("4) cancel during describe → reopen ignores stale reply", async () => {
    const { page } = session;
    await openCreateWizard(page);
    const dlg = wizard(page);
    await dlg.getByPlaceholder("Supplier products → catalog").fill("CancelRace");
    await dlg.locator("select").nth(0).selectOption("catalog_wide");
    await dlg.locator("select").nth(1).selectOption("catalog_wide");

    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__dwhE2eArmDescribeHold();
    });

    await dlg.getByRole("button", { name: "Next" }).click();
    await expect(dlg.getByRole("button", { name: "Loading schema…" })).toBeVisible();
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (window as any).__dwhE2eWaitDescribeStarted();
    });

    // Close while describe is held (✕ stays actionable; Cancel also enabled).
    await dlg.getByTestId("mapping-create-close").click();
    await page.getByTestId("mapping-create-discard").getByRole("button", {
      name: "Discard",
    }).click();
    await expect(dlg).toBeHidden();

    // Reopen fresh session before releasing the held reply.
    await openCreateWizard(page);
    const dlg2 = wizard(page);
    await expect(dlg2.getByText("Name", { exact: true })).toBeVisible();
    const fieldsHeading = dlg2.getByText("Source key (order = From)", {
      exact: true,
    });
    await expect(fieldsHeading).toHaveCount(0);

    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__dwhE2eReleaseDescribeHold();
    });
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (window as any).__dwhE2eWaitDescribeSettled();
    });
    // Stale describe must not flip the new empty session onto Fields.
    await expect(fieldsHeading).toHaveCount(0);
    await expect(dlg2.getByText("Name", { exact: true })).toBeVisible();

    // Empty draft — Cancel must not need discard confirm (no leaked listener).
    await dlg2.getByRole("button", { name: "Cancel" }).click();
    await expect(dlg2).toBeHidden();
  });

  test("5) upstream def change after review → refuse, draft kept", async () => {
    const { page } = session;
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

    // Hold confirm re-describe, mutate defs mid-flight, then release → refuse commit.
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__dwhE2eArmDescribeHold();
    });
    await dlg.getByRole("button", { name: "Create and open" }).click();
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (window as any).__dwhE2eWaitDescribeStarted();
    });
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any;
      w.__dwhE2ePatchProject(
        (p: {
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
        }),
      );
    });
    await expect(
      dlg.getByText(/Workspace queries changed/i),
    ).toBeVisible({ timeout: 15_000 });
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__dwhE2eReleaseDescribeHold();
    });
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (window as any).__dwhE2eWaitDescribeSettled();
    });

    await expect(
      dlg.getByText("Source key (order = From)", { exact: true }),
    ).toHaveCount(0);
    await expect(dlg.getByPlaceholder("Supplier products → catalog")).toHaveValue(
      "StaleSchema",
    );
    await expect(page.getByRole("tab", { name: "StaleSchema" })).toHaveCount(0);
    const mapCount = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (window as any).__dwhE2eGetProject();
      return (p.workspace.key_maps ?? []).filter(
        (m: { name?: string }) => m.name === "StaleSchema",
      ).length;
    });
    expect(mapCount).toBe(0);

    // Explicit discard confirm for this test only (draft still filled).
    await dlg.getByRole("button", { name: "Cancel" }).click();
    await page.getByTestId("mapping-create-discard").getByRole("button", {
      name: "Discard",
    }).click();
    await expect(dlg).toBeHidden();
  });

  for (const targetColumn of ["product_id", "to"]) {
    test(`6) source key to → target ${targetColumn} → create/save/reopen keeps canonical context`, async () => {
      const { page, fixtureWorkDir } = session;
      const outputColumn = targetColumn === "to" ? "to_2" : "product_id";
      if (targetColumn === "to") {
        // Make an actual From/output collision in this test's isolated data.
        // ADR-0037 prefers target field names, not a universal physical "to".
        const catalog = path.join(fixtureWorkDir, "data/catalog.csv");
        fs.writeFileSync(catalog, fs.readFileSync(catalog, "utf8").replace("product_id,", "to,"));
      }
      await openCreateWizard(page);
      const dlg = wizard(page);
      await dlg.getByPlaceholder("Supplier products → catalog").fill("ToKeyMap");
      await dlg.locator("select").nth(0).selectOption("supplier_products");
      await dlg.locator("select").nth(1).selectOption("catalog_wide");
      await dlg.getByRole("button", { name: "Next" }).click();
      await expect(dlg.getByText("Include").first()).toBeVisible({
        timeout: 60_000,
      });
      await includeExcludedColumn(dlg, "to");
      await dlg.getByRole("button", { name: /^to$/ }).first().click();
      await dlg.getByRole("button", { name: targetColumn, exact: true }).last().click();
      await dlg.getByRole("button", { name: "Next" }).click();
      await expect(dlg.getByText(outputColumn, { exact: true }).first()).toBeVisible();
      await expect(dlg.getByText(/Authoring:/)).toBeVisible();
      await dlg.getByRole("button", { name: /Update Fields and create map/ }).click();
      await expect(dlg).toBeHidden({ timeout: 60_000 });
      await expect(page.getByRole("tab", { name: "ToKeyMap" })).toBeVisible({
        timeout: 30_000,
      });

      const outPath = path.join(fixtureWorkDir, `_e2e_saved_${Date.now()}.dwhproj.json`);
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

      const saved = JSON.parse(fs.readFileSync(outPath, "utf8")) as {
        workspace: {
          key_maps: Array<{
            name?: string;
            to_column?: string;
            output_columns: string[];
            authoring_context?: {
              source_query_id: string;
              target_query_id: string;
              source_columns: string[];
              target_column?: string;
              target_columns: string[];
            };
          }>;
        };
      };
      const map = saved.workspace.key_maps.find((m) => m.name === "ToKeyMap");
      expect(map).toBeTruthy();
      expect(map!.output_columns).toEqual([outputColumn]);
      // Existing writers can retain compatibility mirrors. They must agree
      // with the canonical lists; this regression does not change saved IR.
      if (map!.to_column !== undefined) expect(map!.to_column).toBe(outputColumn);
      expect(map!.authoring_context).toMatchObject({
        source_query_id: "supplier_products",
        target_query_id: "catalog_wide",
        source_columns: ["to"],
        target_columns: [targetColumn],
      });
      if (map!.authoring_context?.target_column !== undefined) {
        expect(map!.authoring_context.target_column).toBe(targetColumn);
      }

      // Round-trip: reopen saved project and assert the same map.
      await page.evaluate((p) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).__dwhE2eOpenProject(p);
      }, outPath);
      await page.getByText(/Opened /, { timeout: 60_000 }).waitFor({
        state: "visible",
      });
      const reopened = await page.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = (window as any).__dwhE2eGetProject();
        return (p.workspace.key_maps ?? []).find(
          (m: { name?: string }) => m.name === "ToKeyMap",
        );
      });
      expect(reopened?.output_columns).toEqual([outputColumn]);
      if (reopened?.to_column !== undefined) expect(reopened.to_column).toBe(outputColumn);
      expect(reopened?.authoring_context).toMatchObject({
        source_query_id: "supplier_products",
        target_query_id: "catalog_wide",
        source_columns: ["to"],
        target_columns: [targetColumn],
      });
      if (reopened?.authoring_context?.target_column !== undefined) {
        expect(reopened.authoring_context.target_column).toBe(targetColumn);
      }
      // Project replacement resets tool tabs; reopen the persisted Mapping.
      await page.getByTestId("pg-keymap-ToKeyMap").click();
      await expect(page.getByRole("tab", { name: "ToKeyMap" })).toBeVisible();

      fs.unlinkSync(outPath);
    });
  }
});
