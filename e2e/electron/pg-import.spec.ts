/**
 * Electron smoke: import Postgres tables, confirm a Mapping, open Join Lens,
 * edit a live row, Save, reload (ADR-0040).
 *
 * Requires DWH_PG_DSN and psql. Skips when the database is not configured.
 */
import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeIsolatedSession, launchIsolatedSession } from "./helpers/launch.mjs";

const dsn = process.env.DWH_PG_DSN?.trim() ?? "";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function setupDatabase() {
  const sql = fs.readFileSync(
    path.join(root, "e2e/electron/fixtures/pg-import/setup.sql"),
    "utf8",
  );
  const run = spawnSync("psql", [dsn, "-v", "ON_ERROR_STOP=1"], {
    input: sql,
    encoding: "utf8",
  });
  if (run.status !== 0) {
    throw new Error(run.stderr || run.stdout || "psql setup failed");
  }
}

test.describe("postgres schema import", () => {
  test.skip(!dsn, "DWH_PG_DSN is not set");

  test("import mapping, open lens, save row, reload", async () => {
    setupDatabase();
    const session = await launchIsolatedSession();
    const { page } = session;
    try {
      await page.evaluate((connectionString) => {
        window.__dwhE2ePatchProject?.((p) => ({
          ...p,
          connections: [
            ...(p.connections ?? []),
            {
              id: "conn_pg_import",
              name: "Import PG",
              kind: "postgres",
              postgres: { connection_string: connectionString },
            },
          ],
        }));
      }, dsn);

      await page.getByTestId("pg-import-open-conn_pg_import").click();
      const wizard = page.getByTestId("pg-import-wizard");
      await expect(wizard).toBeVisible();
      await wizard.getByTestId("pg-import-browse").click();
      await expect(
        wizard.getByTestId("pg-import-schema").locator("option", { hasText: "dwh_import_e2e" }),
      ).toBeAttached({ timeout: 60_000 });
      await wizard.getByTestId("pg-import-schema").selectOption("dwh_import_e2e");
      for (const name of ["supplier_products", "products", "_map_supplier_products"]) {
        await wizard.getByTestId(`pg-object-dwh_import_e2e.${name}`).check();
      }
      await wizard.getByTestId("pg-import-next").click();

      const map = "dwh_import_e2e._map_supplier_products";
      const binding = wizard.getByTestId(`pg-binding-${map}`);
      await expect(binding).toBeVisible({ timeout: 60_000 });
      await binding.getByTestId(`pg-role-${map}-supplier_id-from`).click();
      await binding.getByTestId(`pg-role-${map}-external_sku-from`).click();
      await binding.getByTestId(`pg-role-${map}-product_id-output`).click();
      await binding.getByTestId(`pg-role-${map}-variant_code-output`).click();
      await binding.getByTestId(`pg-role-${map}-note-attr`).click();
      await binding.getByTestId(`pg-write-${map}`).check();
      await binding.getByTestId(`pg-confirm-${map}`).click();
      for (const name of ["supplier_products", "products"]) {
        const ordinary = wizard.getByTestId(`pg-ordinary-dwh_import_e2e.${name}`);
        if (await ordinary.isVisible()) await ordinary.click();
      }
      await wizard.getByTestId("pg-import-next").click();

      await wizard.getByTestId("pg-working-enable").check();
      await wizard.getByTestId("pg-working-left").selectOption("dwh_import_e2e.supplier_products");
      await wizard.getByTestId("pg-working-map").selectOption(map);
      await wizard.getByTestId("pg-working-right").selectOption("dwh_import_e2e.products");
      await wizard.getByTestId("pg-import-next").click();
      await expect(wizard.getByText("База данных не изменится")).toBeVisible();
      await wizard.getByTestId("pg-import-commit").click();
      await expect(wizard).toBeHidden({ timeout: 60_000 });
      await expect(page.locator("span", { hasText: /^Join Lens$/ })).toBeVisible({
        timeout: 30_000,
      });

      await page.getByTestId(`pg-keymap-${map}`).click();
      const toCell = page.locator('input[data-col="to"]').first();
      await expect(toCell).toHaveValue("p1", { timeout: 60_000 });
      await toCell.fill("p9");
      await page.getByRole("button", { name: "Save to warehouse" }).click();
      await expect(page.getByRole("button", { name: "Saving…" })).toBeHidden({
        timeout: 60_000,
      });
      await expect(page.getByRole("button", { name: "Save to warehouse" })).toBeVisible();

      await page.evaluate((projectPath) => window.__dwhE2eSaveProject?.(projectPath), session.projectPath);
      await page.evaluate((projectPath) => window.__dwhE2eOpenProject?.(projectPath), session.projectPath);
      await page.getByText(/Opened /, { timeout: 60_000 }).waitFor();

      const saved = fs.readFileSync(session.projectPath, "utf8");
      expect(saved).not.toContain(dsn);
      expect(saved).not.toContain("sku-1");
      const doc = JSON.parse(saved) as {
        workspace: { key_maps: Array<{ from_columns?: string[]; output_columns?: string[]; entries?: unknown[] }> };
      };
      const imported = doc.workspace.key_maps.find((m) =>
        (m.from_columns ?? []).includes("supplier_id"),
      );
      expect(imported?.from_columns).toEqual(["supplier_id", "external_sku"]);
      expect(imported?.output_columns).toEqual(["product_id", "variant_code"]);
      expect(imported?.entries ?? []).toEqual([]);

      await page.getByTestId(`pg-keymap-${map}`).click();
      await expect(page.locator('input[data-col="to"]').first()).toHaveValue("p9", {
        timeout: 60_000,
      });
    } finally {
      await closeIsolatedSession(session);
    }
  });

  test("two imports in one session use different commit tokens", async () => {
    setupDatabase();
    const session = await launchIsolatedSession();
    const { page } = session;
    try {
      await page.evaluate((connectionString) => {
        window.__dwhE2ePatchProject?.((p) => ({
          ...p,
          connections: [
            ...(p.connections ?? []),
            {
              id: "conn_pg_import",
              name: "Import PG",
              kind: "postgres",
              postgres: { connection_string: connectionString },
            },
          ],
        }));
      }, dsn);

      const importOrdinary = async (name: string) => {
        await page.getByTestId("pg-import-open-conn_pg_import").click();
        const wizard = page.getByTestId("pg-import-wizard");
        await expect(wizard).toBeVisible();
        await wizard.getByTestId("pg-import-browse").click();
        await expect(
          wizard.getByTestId("pg-import-schema").locator("option", { hasText: "dwh_import_e2e" }),
        ).toBeAttached({ timeout: 60_000 });
        await wizard.getByTestId("pg-import-schema").selectOption("dwh_import_e2e");
        await wizard.getByTestId(`pg-object-dwh_import_e2e.${name}`).check();
        await wizard.getByTestId("pg-import-next").click();
        await expect(wizard.getByTestId(`pg-binding-dwh_import_e2e.${name}`)).toBeVisible({
          timeout: 60_000,
        });
        await wizard.getByTestId("pg-import-next").click();
        await wizard.getByTestId("pg-import-next").click();
        await wizard.getByTestId("pg-import-commit").click();
        await expect(wizard).toBeHidden({ timeout: 60_000 });
      };

      await importOrdinary("notes");
      await importOrdinary("products");
      const names = await page.evaluate(() => {
        const project = window.__dwhE2eGetProject?.();
        return (project?.workspace.queries ?? []).map((q) => q.name);
      });
      expect(names).toContain("dwh_import_e2e.notes");
      expect(names).toContain("dwh_import_e2e.products");
    } finally {
      await closeIsolatedSession(session);
    }
  });
});
